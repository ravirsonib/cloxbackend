import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdminRole,
  PaymentEventStatus,
  PaymentEventType,
  SettlementCycleStatus,
  SettlementLineStatus,
  SettlementRecipientType,
  UserStatus,
} from '@prisma/client';
import { AppEnv } from '../../config/env.validation';
import { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../shared/types';
import { InAppNotificationsService } from '../notifications/in-app-notifications.service';
import { StripeService } from '../payments/stripe.service';

export interface RunDisbursementInput {
  cycleId?: string;
  dryRun?: boolean;
  notes?: string;
}

export interface SettlementCycleSummary {
  id: string;
  cycleNumber: string;
  periodStart: string;
  periodEnd: string;
  scheduledDisburseAt: string;
  status: SettlementCycleStatus;
  disbursedAt: string | null;
  totalAccruedCents: number;
  totalDisbursedCents: number;
  carrierPayoutCents: number;
  adminPayoutCents: number;
  hqHoldingCents: number;
  lineCount: number;
  notes: string | null;
  createdAt: string;
}

@Injectable()
export class SettlementCyclesService {
  private readonly logger = new Logger(SettlementCyclesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly stripe: StripeService,
    @Optional() private readonly inbox?: InAppNotificationsService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  /**
   * Generates or finds the active rolling fortnightly cycle.
   * Window closes on the scheduled disbursement date.
   */
  async getOrCreateActiveCycle(): Promise<SettlementCycleSummary> {
    this.ensureDatabase();

    const existingOpen = await this.prisma.settlementCycle.findFirst({
      where: { status: SettlementCycleStatus.OPEN },
      orderBy: { periodStart: 'desc' },
    });
    if (existingOpen) {
      return this.mapCycle(existingOpen);
    }

    // Configurable rolling window from PlatformSettings (default 14 days, 4:00 AM cutoff)
    const settings = await this.prisma.platformSettings
      .findUnique({
        where: { id: 'default' },
        select: { settlementCycleCadenceDays: true, settlementCutoffHour: true },
      })
      .catch(() => null);

    const cadenceDays = (settings as any)?.settlementCycleCadenceDays ?? 14;
    const cutoffHour = (settings as any)?.settlementCutoffHour ?? 4;

    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setHours(23, 59, 59, 999);

    const periodStart = new Date(periodEnd);
    periodStart.setDate(periodStart.getDate() - cadenceDays);
    periodStart.setHours(0, 0, 0, 0);

    const scheduledDisburseAt = new Date(periodEnd);
    scheduledDisburseAt.setDate(scheduledDisburseAt.getDate() + 1);
    scheduledDisburseAt.setHours(cutoffHour, 0, 0, 0);

    const cycleNumber = `CYC-${periodStart.toISOString().slice(0, 10)}-${periodEnd.toISOString().slice(0, 10)}`;

    const created = await this.prisma.settlementCycle.upsert({
      where: { cycleNumber },
      create: {
        cycleNumber,
        periodStart,
        periodEnd,
        scheduledDisburseAt,
        status: SettlementCycleStatus.OPEN,
      },
      update: {},
    });

    return this.mapCycle(created);
  }

  /**
   * List settlement cycles with pagination and summaries.
   */
  async listCycles(query?: { page?: number; limit?: number }) {
    this.ensureDatabase();
    const page = Math.max(1, query?.page ?? 1);
    const limit = Math.min(50, Math.max(1, query?.limit ?? 20));
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.prisma.settlementCycle.findMany({
        orderBy: { periodStart: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.settlementCycle.count(),
    ]);

    return {
      items: items.map((c) => this.mapCycle(c)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Detailed breakdown of a settlement cycle including line items.
   */
  async getCycleDetail(id: string) {
    this.ensureDatabase();
    const cycle = await this.prisma.settlementCycle.findUnique({
      where: { id },
      include: {
        settlementLines: {
          include: {
            job: {
              select: {
                id: true,
                title: true,
                assignment: {
                  select: {
                    carrierCompany: {
                      select: { id: true, legalName: true, stripeConnectAccountId: true },
                    },
                  },
                },
              },
            },
            adminUser: {
              select: { id: true, name: true, email: true, role: true },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        },
      },
    });
    if (!cycle) throw new NotFoundException('Settlement cycle not found');

    return {
      ...this.mapCycle(cycle),
      lines: cycle.settlementLines.map((l) => ({
        id: l.id,
        recipientType: l.recipientType,
        sharePercent: l.sharePercent,
        amountCents: l.amountCents,
        status: l.status,
        jobId: l.jobId,
        jobTitle: l.job?.title ?? null,
        carrierName: l.job?.assignment?.carrierCompany?.legalName ?? null,
        adminName: l.adminUser?.name ?? l.adminUser?.email ?? null,
        paidAt: l.paidAt?.toISOString() ?? null,
        createdAt: l.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Executes the fortnightly settlement disbursement cycle (Super Admin only).
   * Aggregates accrued lines, pays out eligible recipients, updates ledger to PAID,
   * records holding for vacant scopes, and sets cycle to COMPLETED.
   */
  async runDisbursement(
    actor: AuthenticatedPrincipal,
    input?: RunDisbursementInput,
  ) {
    this.ensureDatabase();
    if (actor.role !== AdminRole.SUPER_ADMIN) {
      throw new ForbiddenException('Super Admin required for settlement cycle disbursement');
    }

    // Identify or create target cycle
    let cycle = input?.cycleId
      ? await this.prisma.settlementCycle.findUnique({ where: { id: input.cycleId } })
      : await this.prisma.settlementCycle.findFirst({
          where: { status: SettlementCycleStatus.OPEN },
          orderBy: { periodStart: 'asc' },
        });

    if (!cycle) {
      const active = await this.getOrCreateActiveCycle();
      cycle = await this.prisma.settlementCycle.findUnique({ where: { id: active.id } });
    }
    if (!cycle) throw new NotFoundException('No settlement cycle available to process');

    if (cycle.status === SettlementCycleStatus.COMPLETED) {
      throw new BadRequestException('This settlement cycle has already been completed and disbursed');
    }

    // Find all ACCRUED settlement lines within or up to this cycle's periodEnd
    const eligibleLines = await this.prisma.settlementLine.findMany({
      where: {
        status: { in: [SettlementLineStatus.ACCRUED, SettlementLineStatus.PAYABLE] },
        createdAt: { lte: cycle.periodEnd },
      },
      include: {
        job: {
          select: {
            id: true,
            title: true,
            assignment: {
              select: {
                carrierCompanyId: true,
                carrierCompany: {
                  select: { id: true, legalName: true, stripeConnectAccountId: true },
                },
              },
            },
          },
        },
        adminUser: {
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            company: { select: { stripeConnectAccountId: true } },
          },
        },
      },
    });

    let carrierPayoutCents = 0;
    let adminPayoutCents = 0;
    let hqHoldingCents = 0;
    let totalAccruedCents = 0;

    const lineIdsToMarkPaid: string[] = [];
    const transferEvents: Array<{
      jobId: string | null;
      recipientType: SettlementRecipientType;
      amountCents: number;
      destinationAccountId: string | null;
      transferId?: string;
    }> = [];

    for (const line of eligibleLines) {
      totalAccruedCents += line.amountCents;
      lineIdsToMarkPaid.push(line.id);

      switch (line.recipientType) {
        case SettlementRecipientType.CARRIER: {
          carrierPayoutCents += line.amountCents;
          const dest = line.job?.assignment?.carrierCompany?.stripeConnectAccountId;
          transferEvents.push({
            jobId: line.jobId,
            recipientType: line.recipientType,
            amountCents: line.amountCents,
            destinationAccountId: dest ?? null,
          });
          break;
        }
        case SettlementRecipientType.STATE_MASTER:
        case SettlementRecipientType.LOCAL_BDE: {
          adminPayoutCents += line.amountCents;
          const dest = line.adminUser?.company?.stripeConnectAccountId;
          transferEvents.push({
            jobId: line.jobId,
            recipientType: line.recipientType,
            amountCents: line.amountCents,
            destinationAccountId: dest ?? null,
          });
          break;
        }
        case SettlementRecipientType.SUPER_ADMIN:
        case SettlementRecipientType.HQ_HOLDING:
        default: {
          hqHoldingCents += line.amountCents;
          break;
        }
      }
    }

    const totalDisbursedCents = carrierPayoutCents + adminPayoutCents + hqHoldingCents;

    if (input?.dryRun) {
      return {
        dryRun: true,
        cycleId: cycle.id,
        cycleNumber: cycle.cycleNumber,
        lineCount: eligibleLines.length,
        totalAccruedCents,
        carrierPayoutCents,
        adminPayoutCents,
        hqHoldingCents,
        totalDisbursedCents,
        scheduledDisburseAt: cycle.scheduledDisburseAt.toISOString(),
      };
    }

    // Process actual transfers and ledger commit
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // 1. Mark settlement lines as PAID and attach cycleId
      if (lineIdsToMarkPaid.length > 0) {
        await tx.settlementLine.updateMany({
          where: { id: { in: lineIdsToMarkPaid } },
          data: {
            status: SettlementLineStatus.PAID,
            paidAt: now,
            cycleId: cycle!.id,
          },
        });
      }

      // 2. Update settlement cycle to COMPLETED
      await tx.settlementCycle.update({
        where: { id: cycle!.id },
        data: {
          status: SettlementCycleStatus.COMPLETED,
          disbursedAt: now,
          totalAccruedCents,
          totalDisbursedCents,
          carrierPayoutCents,
          adminPayoutCents,
          hqHoldingCents,
          lineCount: lineIdsToMarkPaid.length,
          notes: input?.notes ?? `Disbursed ${lineIdsToMarkPaid.length} lines on ${now.toISOString()}`,
        },
      });
    });

    // Attempt Stripe Transfers for destinations that have connected accounts
    for (const ev of transferEvents) {
      if (ev.destinationAccountId && ev.amountCents > 0) {
        try {
          const idempotencyKey = `cycle_${cycle.id}_${ev.recipientType}_${ev.jobId ?? 'global'}_${ev.amountCents}`;
          const transfer = await this.stripe.createTransfer({
            amountCents: ev.amountCents,
            destinationAccountId: ev.destinationAccountId,
            idempotencyKey,
            transferGroup: cycle.cycleNumber,
            metadata: {
              cycleId: cycle.id,
              cycleNumber: cycle.cycleNumber,
              recipientType: ev.recipientType,
            },
          });
          ev.transferId = transfer.id;

          if (ev.jobId) {
            await this.prisma.paymentEvent.create({
              data: {
                jobId: ev.jobId,
                type: PaymentEventType.TRANSFER,
                status: PaymentEventStatus.SUCCEEDED,
                amountExGstCents: ev.amountCents,
                amountGstCents: 0,
                amountIncGstCents: ev.amountCents,
                stripeTransferId: transfer.id,
                idempotencyKey,
                metadata: {
                  cycleId: cycle.id,
                  recipientType: ev.recipientType,
                  destination: ev.destinationAccountId,
                },
              },
            });
          }
        } catch (err) {
          this.logger.warn(
            `Transfer failed in cycle ${cycle.id} for destination ${ev.destinationAccountId}: ${err}`,
          );
        }
      }
    }

    // Record audit event
    await this.audit.recordPlatform({
      action: AuditAction.SETTLEMENT_CYCLE_RUN,
      actorUserId: actor.id,
      entityType: 'SettlementCycle',
      entityId: cycle.id,
      metadata: {
        cycleNumber: cycle.cycleNumber,
        totalDisbursedCents,
        lineCount: lineIdsToMarkPaid.length,
        carrierPayoutCents,
        adminPayoutCents,
        hqHoldingCents,
      },
    });

    // Notify Super & State Admins of completed cycle
    if (this.inbox) {
      void (async () => {
        try {
          const adminUserIds = await this.inbox!.adminIdsSuper();
          if (adminUserIds.length > 0) {
            await this.inbox!.notifyAdmins({
              adminUserIds,
              type: 'COMPLIANCE_APPROVED', // System notification
              title: `Settlement Cycle Completed: ${cycle.cycleNumber}`,
              body: `Disbursed $${(totalDisbursedCents / 100).toFixed(2)} AUD (${lineIdsToMarkPaid.length} lines). Carrier: $${(carrierPayoutCents / 100).toFixed(2)}, Admins: $${(adminPayoutCents / 100).toFixed(2)}, HQ Holding: $${(hqHoldingCents / 100).toFixed(2)}.`,
              href: '/finance',
              entityType: 'SettlementCycle',
              entityId: cycle.id,
            });
          }
        } catch (err) {
          this.logger.warn(`Failed in-app notification for cycle ${cycle.id}: ${err}`);
        }
      })();
    }

    this.logger.log(
      `Settlement cycle ${cycle.cycleNumber} disbursed successfully: $${(totalDisbursedCents / 100).toFixed(2)} AUD across ${lineIdsToMarkPaid.length} lines`,
    );

    return {
      success: true,
      cycleId: cycle.id,
      cycleNumber: cycle.cycleNumber,
      disbursedAt: now.toISOString(),
      lineCount: lineIdsToMarkPaid.length,
      totalAccruedCents,
      totalDisbursedCents,
      carrierPayoutCents,
      adminPayoutCents,
      hqHoldingCents,
    };
  }

  private mapCycle(c: {
    id: string;
    cycleNumber: string;
    periodStart: Date;
    periodEnd: Date;
    scheduledDisburseAt: Date;
    status: SettlementCycleStatus;
    disbursedAt: Date | null;
    totalAccruedCents: number;
    totalDisbursedCents: number;
    carrierPayoutCents: number;
    adminPayoutCents: number;
    hqHoldingCents: number;
    lineCount: number;
    notes: string | null;
    createdAt: Date;
  }): SettlementCycleSummary {
    return {
      id: c.id,
      cycleNumber: c.cycleNumber,
      periodStart: c.periodStart.toISOString(),
      periodEnd: c.periodEnd.toISOString(),
      scheduledDisburseAt: c.scheduledDisburseAt.toISOString(),
      status: c.status,
      disbursedAt: c.disbursedAt?.toISOString() ?? null,
      totalAccruedCents: c.totalAccruedCents,
      totalDisbursedCents: c.totalDisbursedCents,
      carrierPayoutCents: c.carrierPayoutCents,
      adminPayoutCents: c.adminPayoutCents,
      hqHoldingCents: c.hqHoldingCents,
      lineCount: c.lineCount,
      notes: c.notes,
      createdAt: c.createdAt.toISOString(),
    };
  }
}
