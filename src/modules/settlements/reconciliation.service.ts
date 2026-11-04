import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AdminRole,
  PaymentEventStatus,
  PaymentEventType,
  SettlementLineStatus,
  SettlementRecipientType,
  TripStatus,
} from '@prisma/client';
import { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../shared/types';
import { StripeService } from '../payments/stripe.service';

export interface DiscrepancyItem {
  id: string;
  kind:
    | 'LEDGER_MISMATCH'
    | 'UNTRANSFERRED_CLEARING'
    | 'ORPHAN_CHARGE'
    | 'SURCHARGE_SPIKE'
    | 'UNMAPPED_DESTINATION';
  severity: 'CRITICAL' | 'WARN' | 'INFO';
  message: string;
  expectedCents?: number;
  actualCents?: number;
  entityId: string;
  entityType: 'Job' | 'PaymentEvent' | 'SettlementLine' | 'Company';
  createdAt: string;
}

export interface ReconciliationReport {
  status: 'HEALTHY' | 'MISMATCH_DETECTED' | 'WARNING';
  generatedAt: string;
  period: { from: string; to: string };
  metrics: {
    totalGmvCents: number;
    totalCollectedCents: number;
    totalDisbursedCents: number;
    totalPendingClearingCents: number;
    totalHqHoldingCents: number;
    matchedTransactionsCount: number;
    discrepancyCount: number;
  };
  discrepancies: DiscrepancyItem[];
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stripe: StripeService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  /**
   * Generates a daily / periodic reconciliation report comparing
   * Stripe payment events, settlement lines, and job ledgers (Super Admin only).
   */
  async getReconciliationReport(
    actor: AuthenticatedPrincipal,
    query?: { from?: string; to?: string },
  ): Promise<ReconciliationReport> {
    this.ensureDatabase();
    if (actor.role !== AdminRole.SUPER_ADMIN) {
      throw new ForbiddenException('Super Admin required for financial reconciliation');
    }

    const to = query?.to ? new Date(query.to) : new Date();
    const from = query?.from
      ? new Date(query.from)
      : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [paymentEvents, settlementLines, completedTrips] = await Promise.all([
      this.prisma.paymentEvent.findMany({
        where: { createdAt: { gte: from, lte: to } },
        include: {
          job: {
            select: { id: true, title: true, estimateIncGstCents: true },
          },
        },
      }),
      this.prisma.settlementLine.findMany({
        where: { createdAt: { gte: from, lte: to } },
        include: {
          job: {
            select: { id: true, title: true, estimateIncGstCents: true },
          },
        },
      }),
      this.prisma.trip.findMany({
        where: {
          status: TripStatus.COMPLETED,
          completedAt: { gte: from, lte: to },
        },
        include: {
          job: {
            select: {
              id: true,
              title: true,
              estimateIncGstCents: true,
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
        },
      }),
    ]);

    const discrepancies: DiscrepancyItem[] = [];

    let totalCollectedCents = 0;
    let totalDisbursedCents = 0;
    let totalGmvCents = 0;
    let totalPendingClearingCents = 0;
    let totalHqHoldingCents = 0;

    // 1. Audit Payment Events
    for (const ev of paymentEvents) {
      if (ev.status === PaymentEventStatus.SUCCEEDED) {
        if (ev.type === PaymentEventType.CHARGE || ev.type === PaymentEventType.SURCHARGE) {
          totalCollectedCents += ev.amountIncGstCents;
          totalGmvCents += ev.amountIncGstCents;

          const stripeRef = ev.stripePaymentIntentId ?? ev.stripeTransferId ?? ev.stripeRefundId;
          if (!stripeRef) {
            discrepancies.push({
              id: `disc-orphan-charge-${ev.id}`,
              kind: 'ORPHAN_CHARGE',
              severity: 'CRITICAL',
              message: `Payment event ${ev.id} is marked SUCCEEDED but has no Stripe reference ID`,
              actualCents: ev.amountIncGstCents,
              entityId: ev.id,
              entityType: 'PaymentEvent',
              createdAt: ev.createdAt.toISOString(),
            });
          }
        } else if (ev.type === PaymentEventType.TRANSFER) {
          totalDisbursedCents += ev.amountIncGstCents;
        }
      }
    }

    // 2. Audit Settlement Lines vs Job Fare
    const linesByJob = new Map<string, typeof settlementLines>();
    for (const line of settlementLines) {
      if (line.status !== SettlementLineStatus.VOID) {
        if (line.recipientType === SettlementRecipientType.HQ_HOLDING) {
          totalHqHoldingCents += line.amountCents;
        }
        if (line.status === SettlementLineStatus.ACCRUED) {
          totalPendingClearingCents += line.amountCents;
        }
      }

      if (line.jobId) {
        const existing = linesByJob.get(line.jobId) ?? [];
        existing.push(line);
        linesByJob.set(line.jobId, existing);
      }
    }

    // Check each job's ledger balance: sum(lines) should match gross fare
    for (const [jobId, lines] of linesByJob.entries()) {
      const activeLines = lines.filter((l) => l.status !== SettlementLineStatus.VOID);
      if (activeLines.length === 0) continue;

      const job = activeLines[0]?.job;
      const expectedGross = job?.estimateIncGstCents ?? null;

      if (expectedGross != null && expectedGross > 0) {
        const sumLines = activeLines.reduce((acc, l) => acc + l.amountCents, 0);
        // Variance tolerance: integer rounding can produce ±1 cent
        if (Math.abs(sumLines - expectedGross) > 2) {
          discrepancies.push({
            id: `disc-ledger-${jobId}`,
            kind: 'LEDGER_MISMATCH',
            severity: 'CRITICAL',
            message: `Job ${jobId} ledger variance: lines total $${(sumLines / 100).toFixed(2)} does not match gross fare $${(expectedGross / 100).toFixed(2)}`,
            expectedCents: expectedGross,
            actualCents: sumLines,
            entityId: jobId,
            entityType: 'Job',
            createdAt: activeLines[0]?.createdAt.toISOString() ?? new Date().toISOString(),
          });
        }
      }
    }

    // 3. Audit Carrier Clearing & Payout Execution
    const now = Date.now();
    for (const trip of completedTrips) {
      if (!trip.completedAt) continue;
      const clearingMs = 7 * 24 * 60 * 60 * 1000;
      const isPastClearing = now >= trip.completedAt.getTime() + clearingMs;

      if (isPastClearing) {
        const carrierLine = settlementLines.find(
          (l) =>
            l.jobId === trip.jobId &&
            l.recipientType === SettlementRecipientType.CARRIER &&
            l.status !== SettlementLineStatus.VOID,
        );

        if (carrierLine && carrierLine.status !== SettlementLineStatus.PAID) {
          discrepancies.push({
            id: `disc-clearing-${trip.id}`,
            kind: 'UNTRANSFERRED_CLEARING',
            severity: 'WARN',
            message: `Carrier payout for trip ${trip.id} (Job: "${trip.job.title ?? trip.jobId}") is past 7-day clearing but remains ${carrierLine.status}`,
            expectedCents: carrierLine.amountCents,
            actualCents: 0,
            entityId: trip.jobId,
            entityType: 'Job',
            createdAt: trip.completedAt.toISOString(),
          });
        }
      }
    }

    // 4. Surcharge Spike Detection (>20% of GMV)
    const surchargeCents = paymentEvents
      .filter((e) => e.type === PaymentEventType.SURCHARGE && e.status === PaymentEventStatus.SUCCEEDED)
      .reduce((acc, e) => acc + e.amountIncGstCents, 0);

    if (totalGmvCents > 0 && surchargeCents / totalGmvCents > 0.2) {
      discrepancies.push({
        id: `disc-surcharge-spike-${from.toISOString().slice(0, 10)}`,
        kind: 'SURCHARGE_SPIKE',
        severity: 'INFO',
        message: `High surcharge volume detected: surcharges represent ${((surchargeCents / totalGmvCents) * 100).toFixed(1)}% of GMV in this period`,
        expectedCents: Math.round(totalGmvCents * 0.1),
        actualCents: surchargeCents,
        entityId: 'global',
        entityType: 'PaymentEvent',
        createdAt: new Date().toISOString(),
      });
    }

    const hasCritical = discrepancies.some((d) => d.severity === 'CRITICAL');
    const hasWarn = discrepancies.some((d) => d.severity === 'WARN');
    const status: ReconciliationReport['status'] = hasCritical
      ? 'MISMATCH_DETECTED'
      : hasWarn
        ? 'WARNING'
        : 'HEALTHY';

    await this.audit.recordPlatform({
      action: AuditAction.RECONCILIATION_RUN,
      actorUserId: actor.id,
      entityType: 'Reconciliation',
      entityId: `${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}`,
      metadata: {
        status,
        discrepancyCount: discrepancies.length,
        totalGmvCents,
        totalCollectedCents,
        totalDisbursedCents,
      },
    });

    return {
      status,
      generatedAt: new Date().toISOString(),
      period: { from: from.toISOString(), to: to.toISOString() },
      metrics: {
        totalGmvCents,
        totalCollectedCents,
        totalDisbursedCents,
        totalPendingClearingCents,
        totalHqHoldingCents,
        matchedTransactionsCount: paymentEvents.length + settlementLines.length,
        discrepancyCount: discrepancies.length,
      },
      discrepancies,
    };
  }
}
