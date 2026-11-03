import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SurchargeStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import {
  AdminRole,
  AppRole,
  AuditAction,
  DisputeRuling,
  DisputeStatus,
  type AssignDisputeInput,
  type CloseLocalDisputeInput,
  type CreateDisputeInput,
  type EscalateDisputeInput,
  type ListDisputesQuery,
  type ResolveDisputeInput,
  type TriageDisputeInput,
} from '../../shared/types';

@Injectable()
export class DisputesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Sender (or Carrier) creates a formal dispute on a job / trip / surcharge.
   */
  async create(principal: AuthenticatedPrincipal, input: CreateDisputeInput) {
    if (principal.kind !== 'user') {
      throw new ForbiddenException('Only registered users can open disputes');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      include: { company: true },
    });
    if (!user || !user.companyId) {
      throw new BadRequestException('User does not belong to an active company');
    }

    const job = await this.prisma.job.findUnique({
      where: { id: input.jobId },
      include: {
        assignment: true,
        originRegion: true,
        originTerritory: true,
      },
    });
    if (!job) {
      throw new NotFoundException(`Job ${input.jobId} not found`);
    }

    // Sender must own the job; Carrier must be assigned to it
    const isSender = job.senderCompanyId === user.companyId;
    const isCarrier = job.assignment?.carrierCompanyId === user.companyId;
    if (!isSender && !isCarrier) {
      throw new ForbiddenException('Not authorized to dispute this job');
    }

    let surcharge: any = null;
    if (input.surchargeId) {
      surcharge = await this.prisma.surcharge.findUnique({
        where: { id: input.surchargeId },
      });
      if (!surcharge || surcharge.jobId !== job.id) {
        throw new BadRequestException('Surcharge does not belong to this job');
      }
    }

    // Generate human-friendly dispute number: D-8801, D-8802, etc.
    const count = await this.prisma.dispute.count();
    const disputeNumber = `D-${8800 + count + 1}`;

    const disputedAmountCents =
      input.disputedAmountCents ?? surcharge?.amountIncGstCents ?? null;

    const dispute = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const created = await tx.dispute.create({
        data: {
          disputeNumber,
          type: input.type,
          status: DisputeStatus.OPEN_TRIAGE,
          jobId: job.id,
          tripId: input.tripId ?? surcharge?.tripId ?? null,
          surchargeId: input.surchargeId ?? null,
          openedByUserId: user.id,
          companyId: user.companyId!,
          regionId: job.originRegionId ?? null,
          territoryId: job.originTerritoryId ?? null,
          reason: input.reason.trim(),
          description: input.description.trim(),
          disputedAmountCents,
          evidenceUrls: input.evidenceUrls,
        },
        include: {
          job: {
            select: {
              id: true,
              title: true,
              originRegion: true,
              originTerritory: true,
            },
          },
          surcharge: true,
          company: {
            select: {
              id: true,
              legalName: true,
              type: true,
            },
          },
        },
      });

      if (input.surchargeId) {
        await tx.surcharge.update({
          where: { id: input.surchargeId },
          data: { status: SurchargeStatus.DISPUTED },
        });
      }

      return created;
    });

    await this.audit.recordPlatform({
      action: AuditAction.DISPUTE_OPENED,
      actorUserId: user.id,
      entityType: 'Dispute',
      entityId: dispute.id,
      metadata: {
        disputeNumber: dispute.disputeNumber,
        jobId: job.id,
        surchargeId: input.surchargeId ?? null,
        type: dispute.type,
        disputedAmountCents,
      },
    });

    return dispute;
  }

  /**
   * List disputes with RBAC and territory/state scoping.
   */
  async list(principal: AuthenticatedPrincipal, query: ListDisputesQuery) {
    const where = await this.buildScopedWhere(principal, query);

    const page = Math.max(1, query.page || 1);
    const pageSize = Math.min(50, Math.max(1, query.pageSize || 20));
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      this.prisma.dispute.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          job: {
            select: {
              id: true,
              title: true,
              originRegion: { select: { id: true, code: true, name: true } },
              originTerritory: { select: { id: true, code: true, name: true } },
            },
          },
          company: {
            select: {
              id: true,
              legalName: true,
              type: true,
            },
          },
          surcharge: {
            select: {
              id: true,
              kind: true,
              amountIncGstCents: true,
              status: true,
            },
          },
          assignedAdmin: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
            },
          },
        },
      }),
      this.prisma.dispute.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * Get single dispute detail with complete contextual information.
   */
  async getById(principal: AuthenticatedPrincipal, id: string) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id },
      include: {
        job: {
          include: {
            stops: { orderBy: { sequence: 'asc' } },
            senderCompany: { select: { id: true, legalName: true, phone: true, email: true } },
            originRegion: true,
            originTerritory: true,
            assignment: {
              include: {
                carrierCompany: { select: { id: true, legalName: true, phone: true, email: true } },
                driver: {
                  select: {
                    id: true,
                    licenceClass: true,
                    user: { select: { name: true, phone: true } },
                  },
                },
                vehicle: { select: { id: true, registration: true, vehicleClass: true } },
              },
            },
          },
        },
        trip: {
          select: {
            id: true,
            status: true,
            startedAt: true,
            completedAt: true,
            actualMassKg: true,
            declaredMassKg: true,
          },
        },
        surcharge: true,
        openedByUser: { select: { id: true, name: true, email: true, phone: true } },
        company: { select: { id: true, legalName: true, type: true } },
        region: true,
        territory: true,
        assignedAdmin: { select: { id: true, name: true, email: true, role: true } },
        triagedByAdmin: { select: { id: true, name: true, email: true } },
        resolvedByAdmin: { select: { id: true, name: true, email: true } },
      },
    });

    if (!dispute) {
      throw new NotFoundException(`Dispute ${id} not found`);
    }

    // Scope check
    await this.assertAccess(principal, dispute);

    return dispute;
  }

  /**
   * Local BDE First-Line Triage (WF-OPS-002, OPS-LOC-DSP-02)
   */
  async triage(principal: AuthenticatedPrincipal, id: string, input: TriageDisputeInput) {
    if (
      principal.role !== AdminRole.LOCAL_BDE &&
      principal.role !== AdminRole.SUPER_ADMIN
    ) {
      throw new ForbiddenException('Only Local BDE or Super Admin can perform first-line triage');
    }

    const dispute = await this.getById(principal, id);

    const contactedSender = input.contactedSender ?? dispute.contactedSender;
    const contactedCarrier = input.contactedCarrier ?? dispute.contactedCarrier;
    const evidenceComplete = input.evidenceComplete ?? dispute.evidenceComplete;

    // If all three checklist items completed, transition status to TRIAGED
    let newStatus = dispute.status;
    if (
      dispute.status === DisputeStatus.OPEN_TRIAGE &&
      contactedSender &&
      contactedCarrier &&
      evidenceComplete
    ) {
      newStatus = DisputeStatus.TRIAGED;
    }

    const updated = await this.prisma.dispute.update({
      where: { id },
      data: {
        contactedSender,
        contactedCarrier,
        evidenceComplete,
        triageNotes: input.triageNotes ?? dispute.triageNotes,
        triagedByAdminId: principal.id,
        triagedAt: new Date(),
        status: newStatus,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.DISPUTE_TRIAGED,
      actorAdminId: principal.id,
      entityType: 'Dispute',
      entityId: id,
      metadata: {
        disputeNumber: dispute.disputeNumber,
        contactedSender,
        contactedCarrier,
        evidenceComplete,
        status: newStatus,
      },
    });

    return updated;
  }

  /**
   * Escalate Dispute (Local -> State, or State -> Super)
   */
  async escalate(principal: AuthenticatedPrincipal, id: string, input: EscalateDisputeInput) {
    const dispute = await this.getById(principal, id);

    let nextStatus: DisputeStatus;
    if (input.target === 'STATE') {
      if (
        principal.role !== AdminRole.LOCAL_BDE &&
        principal.role !== AdminRole.SUPER_ADMIN
      ) {
        throw new ForbiddenException('Only Local BDE can escalate to State Master');
      }
      nextStatus = DisputeStatus.ESCALATED_STATE;
    } else {
      if (
        principal.role !== AdminRole.STATE_MASTER &&
        principal.role !== AdminRole.SUPER_ADMIN
      ) {
        throw new ForbiddenException('Only State Master can escalate to Super Admin');
      }
      nextStatus = DisputeStatus.ESCALATED_SUPER;
    }

    const triageNotes = input.notes
      ? dispute.triageNotes
        ? `${dispute.triageNotes}\n[Escalation Note (${principal.role})]: ${input.notes}`
        : input.notes
      : dispute.triageNotes;

    const updated = await this.prisma.dispute.update({
      where: { id },
      data: {
        status: nextStatus,
        triageNotes,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.DISPUTE_ESCALATED,
      actorAdminId: principal.id,
      entityType: 'Dispute',
      entityId: id,
      metadata: {
        disputeNumber: dispute.disputeNumber,
        fromStatus: dispute.status,
        toStatus: nextStatus,
        target: input.target,
      },
    });

    return updated;
  }

  /**
   * Assign dispute to an admin for evidence gathering
   */
  async assign(principal: AuthenticatedPrincipal, id: string, input: AssignDisputeInput) {
    if (
      principal.role !== AdminRole.STATE_MASTER &&
      principal.role !== AdminRole.SUPER_ADMIN
    ) {
      throw new ForbiddenException('Only State Master or Super Admin can assign disputes');
    }

    const dispute = await this.getById(principal, id);

    const targetAdmin = await this.prisma.adminUser.findUnique({
      where: { id: input.adminUserId },
    });
    if (!targetAdmin) {
      throw new NotFoundException('Target admin user not found');
    }

    const updated = await this.prisma.dispute.update({
      where: { id },
      data: { assignedAdminId: input.adminUserId },
    });

    await this.audit.recordPlatform({
      action: AuditAction.DISPUTE_ASSIGNED,
      actorAdminId: principal.id,
      entityType: 'Dispute',
      entityId: id,
      metadata: {
        disputeNumber: dispute.disputeNumber,
        assignedAdminId: input.adminUserId,
        assignedAdminEmail: targetAdmin.email,
      },
    });

    return updated;
  }

  /**
   * Resolve Dispute with Binding Ruling (Sender / Carrier / Split) & Financial Adjustments
   */
  async resolve(principal: AuthenticatedPrincipal, id: string, input: ResolveDisputeInput) {
    if (
      principal.role !== AdminRole.STATE_MASTER &&
      principal.role !== AdminRole.SUPER_ADMIN
    ) {
      throw new ForbiddenException('Only State Master or Super Admin can resolve disputes');
    }

    const dispute = await this.getById(principal, id);

    // State Master cannot resolve disputes escalated to Super Admin
    if (
      principal.role === AdminRole.STATE_MASTER &&
      dispute.status === DisputeStatus.ESCALATED_SUPER
    ) {
      throw new ForbiddenException(
        'This dispute has been escalated to Super Admin for national adjudication',
      );
    }

    const updated = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const res = await tx.dispute.update({
        where: { id },
        data: {
          status: DisputeStatus.RESOLVED,
          ruling: input.ruling as any,
          rulingNotes: input.rulingNotes.trim(),
          financialAdjustment: input.financialAdjustment as any,
          adjustmentAmountCents: input.adjustmentAmountCents ?? null,
          resolvedByAdminId: principal.id,
          resolvedAt: new Date(),
        },
      });

      // Execute financial adjustment hooks
      if (dispute.surchargeId) {
        if (input.financialAdjustment === 'WAIVE_SURCHARGE' || input.ruling === DisputeRuling.FAVOR_SENDER) {
          await tx.surcharge.update({
            where: { id: dispute.surchargeId },
            data: {
              status: SurchargeStatus.WAIVED,
              waivedAt: new Date(),
              waivedByAdminId: principal.id,
            },
          });
        } else if (input.ruling === DisputeRuling.FAVOR_CARRIER) {
          // If ruling in carrier's favor, revert surcharge to pending payment
          await tx.surcharge.update({
            where: { id: dispute.surchargeId },
            data: {
              status: SurchargeStatus.PENDING_PAYMENT,
            },
          });
        }
      }

      return res;
    });

    await this.audit.recordPlatform({
      action: AuditAction.DISPUTE_RESOLVED,
      actorAdminId: principal.id,
      entityType: 'Dispute',
      entityId: id,
      metadata: {
        disputeNumber: dispute.disputeNumber,
        ruling: input.ruling,
        financialAdjustment: input.financialAdjustment,
        adjustmentAmountCents: input.adjustmentAmountCents ?? null,
      },
    });

    return updated;
  }

  /**
   * Local BDE closes dispute locally after informal resolution
   */
  async closeLocal(principal: AuthenticatedPrincipal, id: string, input: CloseLocalDisputeInput) {
    if (
      principal.role !== AdminRole.LOCAL_BDE &&
      principal.role !== AdminRole.SUPER_ADMIN
    ) {
      throw new ForbiddenException('Only Local BDE or Super Admin can close disputes locally');
    }

    const dispute = await this.getById(principal, id);

    const triageNotes = input.notes
      ? dispute.triageNotes
        ? `${dispute.triageNotes}\n[Closed Locally]: ${input.notes}`
        : input.notes
      : dispute.triageNotes;

    const updated = await this.prisma.dispute.update({
      where: { id },
      data: {
        status: DisputeStatus.CLOSED,
        triageNotes,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.DISPUTE_CLOSED_LOCAL,
      actorAdminId: principal.id,
      entityType: 'Dispute',
      entityId: id,
      metadata: {
        disputeNumber: dispute.disputeNumber,
      },
    });

    return updated;
  }

  // ─── Scoping & Access Helpers ───────────────────────────────────────────────

  private async buildScopedWhere(
    principal: AuthenticatedPrincipal,
    query: ListDisputesQuery,
  ) {
    const where: any = {};

    if (query.status) {
      where.status = query.status;
    }
    if (query.type) {
      where.type = query.type;
    }
    if (query.regionId) {
      where.regionId = query.regionId;
    }
    if (query.territoryId) {
      where.territoryId = query.territoryId;
    }
    if (query.q) {
      const q = query.q.trim();
      where.OR = [
        { disputeNumber: { contains: q, mode: 'insensitive' } },
        { reason: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { job: { title: { contains: q, mode: 'insensitive' } } },
      ];
    }

    // Role-based scoping
    if (principal.role === AdminRole.SUPER_ADMIN) {
      return where;
    }

    if (principal.role === AdminRole.STATE_MASTER) {
      // Find regions assigned to this State Master
      const regions = await this.prisma.region.findMany({
        where: { code: { in: principal.regionCodes } },
        select: { id: true },
      });
      const regionIds = regions.map((r: { id: string }) => r.id);
      where.regionId = { in: regionIds };
      return where;
    }

    if (principal.role === AdminRole.LOCAL_BDE) {
      // Find territories assigned to this Local BDE
      const territories = await this.prisma.localTerritory.findMany({
        where: { code: { in: principal.territoryCodes } },
        select: { id: true },
      });
      const territoryIds = territories.map((t: { id: string }) => t.id);
      where.territoryId = { in: territoryIds };
      return where;
    }

    if (principal.role === AppRole.SENDER) {
      const user = await this.prisma.user.findUnique({
        where: { id: principal.id },
        select: { companyId: true },
      });
      where.companyId = user?.companyId ?? '__NONE__';
      return where;
    }

    if (principal.role === AppRole.TRANSPORT_COMPANY) {
      const user = await this.prisma.user.findUnique({
        where: { id: principal.id },
        select: { companyId: true },
      });
      where.job = {
        assignment: {
          carrierCompanyId: user?.companyId ?? '__NONE__',
        },
      };
      return where;
    }

    throw new ForbiddenException('Not authorized to access disputes');
  }

  private async assertAccess(
    principal: AuthenticatedPrincipal,
    dispute: any,
  ) {
    if (principal.role === AdminRole.SUPER_ADMIN) {
      return;
    }

    if (principal.role === AdminRole.STATE_MASTER) {
      const assigned = dispute.region?.code && principal.regionCodes.includes(dispute.region.code);
      if (!assigned) {
        throw new ForbiddenException('Cannot access disputes outside assigned state');
      }
      return;
    }

    if (principal.role === AdminRole.LOCAL_BDE) {
      const assigned =
        dispute.territory?.code && principal.territoryCodes.includes(dispute.territory.code);
      if (!assigned) {
        throw new ForbiddenException('Cannot access disputes outside assigned local territory');
      }
      return;
    }

    if (principal.role === AppRole.SENDER) {
      const user = await this.prisma.user.findUnique({
        where: { id: principal.id },
        select: { companyId: true },
      });
      if (dispute.companyId !== user?.companyId) {
        throw new ForbiddenException('Cannot access disputes opened by other companies');
      }
      return;
    }

    if (principal.role === AppRole.TRANSPORT_COMPANY) {
      const user = await this.prisma.user.findUnique({
        where: { id: principal.id },
        select: { companyId: true },
      });
      if (dispute.job?.assignment?.carrierCompanyId !== user?.companyId) {
        throw new ForbiddenException('Cannot access disputes for jobs not assigned to your fleet');
      }
      return;
    }

    throw new ForbiddenException('Access denied');
  }
}
