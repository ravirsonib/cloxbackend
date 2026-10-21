import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AuditAction,
  LeadType,
  type AdminAuditQuery,
  type AdminCompanyListQuery,
  type AdminLeadExportQuery,
  type AdminLeadListQuery,
  type CreateLeadNoteInput,
  type DisableCompanyInput,
  type UpdateLeadInput,
} from '../../shared/types';
import {
  AdminUserStatus,
  CompanyStatus,
  CompanyType,
  ComplianceCaseStatus,
  DriverStatus,
  Prisma,
  UserStatus,
  VehicleStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

const leadListSelect = {
  id: true,
  type: true,
  status: true,
  email: true,
  phone: true,
  companyName: true,
  abn: true,
  state: true,
  territory: true,
  priority: true,
  assigneeId: true,
  locale: true,
  source: true,
  createdAt: true,
  updatedAt: true,
  assignee: {
    select: { id: true, email: true, name: true },
  },
} satisfies Prisma.LeadSelect;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  private buildLeadWhere(query: {
    type?: AdminLeadListQuery['type'];
    status?: AdminLeadListQuery['status'];
    q?: string;
    priority?: boolean;
    from?: string;
    to?: string;
  }): Prisma.LeadWhereInput {
    const where: Prisma.LeadWhereInput = {};

    if (query.type) where.type = query.type;
    if (query.status) where.status = query.status;
    if (query.priority !== undefined) where.priority = query.priority;

    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    if (query.q) {
      where.OR = [
        { email: { contains: query.q, mode: 'insensitive' } },
        { companyName: { contains: query.q, mode: 'insensitive' } },
        { phone: { contains: query.q, mode: 'insensitive' } },
        { abn: { contains: query.q.replace(/\s+/g, ''), mode: 'insensitive' } },
        { state: { contains: query.q, mode: 'insensitive' } },
        { territory: { contains: query.q, mode: 'insensitive' } },
      ];
    }

    return where;
  }

  async getDashboardStats() {
    this.ensureDatabase();

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfWeek.getDate() - 6);

    const [
      total,
      today,
      week,
      byType,
      byStatus,
      recentLeads,
      recentEvents,
    ] = await Promise.all([
      this.prisma.lead.count(),
      this.prisma.lead.count({ where: { createdAt: { gte: startOfToday } } }),
      this.prisma.lead.count({ where: { createdAt: { gte: startOfWeek } } }),
      this.prisma.lead.groupBy({ by: ['type'], _count: { _all: true } }),
      this.prisma.lead.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.lead.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: leadListSelect,
      }),
      this.prisma.leadEvent.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
          actor: { select: { id: true, email: true, name: true } },
          lead: { select: { id: true, type: true, email: true, companyName: true } },
        },
      }),
    ]);

    const typeCounts = Object.fromEntries(
      byType.map((row) => [row.type, row._count._all]),
    ) as Partial<Record<LeadType, number>>;

    return {
      totals: {
        all: total,
        today,
        week,
        registrySenders: typeCounts.REGISTRY_SENDER ?? 0,
        registryCarriers: typeCounts.REGISTRY_CARRIER ?? 0,
        eoiStateMasters: typeCounts.EOI_STATE_MASTER ?? 0,
        eoiLocalBdes: typeCounts.EOI_LOCAL_BDE ?? 0,
        investors: typeCounts.INVESTOR ?? 0,
      },
      byStatus: Object.fromEntries(
        byStatus.map((row) => [row.status, row._count._all]),
      ),
      recentLeads,
      recentActivity: recentEvents,
    };
  }

  async listLeads(query: AdminLeadListQuery) {
    this.ensureDatabase();

    const where = this.buildLeadWhere(query);
    const skip = (query.page - 1) * query.pageSize;

    const [items, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: query.pageSize,
        select: leadListSelect,
      }),
      this.prisma.lead.count({ where }),
    ]);

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  async listCompanies(query: AdminCompanyListQuery) {
    this.ensureDatabase();

    const where: Prisma.CompanyWhereInput = {};
    // Marketplace companies only — admin partners live under Ops → Admin partners.
    where.type = query.type
      ? query.type
      : { in: [CompanyType.SENDER, CompanyType.CARRIER] };
    if (query.status) where.status = query.status;
    if (query.regionCode) {
      where.homeRegion = { code: query.regionCode.toUpperCase() };
    }
    if (query.q) {
      const q = query.q;
      const abnQ = q.replace(/\s+/g, '');
      where.OR = [
        { legalName: { contains: q, mode: 'insensitive' } },
        { tradingName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
        ...(abnQ ? [{ abn: { contains: abnQ, mode: 'insensitive' as const } }] : []),
      ];
    }

    const skip = (query.page - 1) * query.pageSize;
    const openCaseStatuses: ComplianceCaseStatus[] = [
      ComplianceCaseStatus.OPEN,
      ComplianceCaseStatus.INFO_REQUESTED,
      ComplianceCaseStatus.ESCALATED,
    ];

    const [rows, total] = await Promise.all([
      this.prisma.company.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.pageSize,
        select: {
          id: true,
          type: true,
          status: true,
          legalName: true,
          tradingName: true,
          abn: true,
          email: true,
          phone: true,
          suspendedAt: true,
          suspendedReason: true,
          suspendedNote: true,
          statusBeforeSuspend: true,
          createdAt: true,
          updatedAt: true,
          homeRegion: { select: { code: true, name: true } },
          complianceCases: {
            where: { status: { in: openCaseStatuses } },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true, status: true, caseType: true },
          },
          _count: {
            select: {
              users: true,
              vehicles: true,
              drivers: true,
            },
          },
        },
      }),
      this.prisma.company.count({ where }),
    ]);

    const items = rows.map((row) => {
      const { complianceCases, _count, ...company } = row;
      return {
        ...company,
        openCase: complianceCases[0] ?? null,
        counts: {
          users: _count.users,
          vehicles: _count.vehicles,
          drivers: _count.drivers,
        },
      };
    });

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  /**
   * Soft-disable company (SUSPENDED) with required reason.
   * Cascades users → SUSPENDED, drivers → SUSPENDED, active vehicles → SUSPENDED,
   * revokes sessions, and emails account holders.
   */
  async disableCompany(id: string, input: DisableCompanyInput, actorId: string) {
    this.ensureDatabase();

    const company = await this.prisma.company.findUnique({
      where: { id },
      include: {
        users: { select: { id: true, email: true, status: true } },
        adminUsers: { select: { id: true, email: true } },
      },
    });
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    if (company.status === CompanyStatus.SUSPENDED) {
      throw new BadRequestException('Company is already suspended');
    }
    if (company.status === CompanyStatus.DRAFT) {
      throw new BadRequestException(
        'Draft companies cannot be suspended — use permanent delete instead',
      );
    }

    const reason = input.reason.trim();
    const note = input.note?.trim() || null;
    const now = new Date();
    const partnerAdminIds = company.adminUsers.map((a) => a.id);

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.company.update({
        where: { id },
        data: {
          statusBeforeSuspend: company.status,
          status: CompanyStatus.SUSPENDED,
          suspendedAt: now,
          suspendedReason: reason,
          suspendedNote: note,
        },
      });

      const userIds = company.users.map((u) => u.id);

      const usersSuspended = await tx.user.updateMany({
        where: {
          companyId: id,
          status: { in: [UserStatus.ACTIVE, UserStatus.PENDING] },
        },
        data: { status: UserStatus.SUSPENDED },
      });

      const driversSuspended = await tx.driver.updateMany({
        where: {
          OR: [{ companyId: id }, ...(userIds.length ? [{ userId: { in: userIds } }] : [])],
          status: { in: [DriverStatus.ACTIVE, DriverStatus.PENDING_REVIEW] },
        },
        data: { status: DriverStatus.SUSPENDED },
      });

      const vehiclesSuspended = await tx.vehicle.updateMany({
        where: { companyId: id, status: VehicleStatus.ACTIVE },
        data: { status: VehicleStatus.SUSPENDED },
      });

      if (partnerAdminIds.length) {
        await tx.adminUser.updateMany({
          where: { id: { in: partnerAdminIds } },
          data: { status: AdminUserStatus.SUSPENDED, active: false },
        });
      }

      let sessionsRevoked = 0;
      if (userIds.length) {
        const revoked = await tx.authSession.updateMany({
          where: { userId: { in: userIds }, revokedAt: null },
          data: { revokedAt: now },
        });
        sessionsRevoked += revoked.count;
      }
      if (partnerAdminIds.length) {
        const revoked = await tx.authSession.updateMany({
          where: { adminUserId: { in: partnerAdminIds }, revokedAt: null },
          data: { revokedAt: now },
        });
        sessionsRevoked += revoked.count;
      }

      return {
        company: updated,
        usersSuspended: usersSuspended.count,
        driversSuspended: driversSuspended.count,
        vehiclesSuspended: vehiclesSuspended.count,
        sessionsRevoked,
      };
    });

    await this.audit.recordPlatform({
      action: AuditAction.COMPANY_SUSPENDED,
      actorAdminId: actorId,
      entityType: 'Company',
      entityId: id,
      metadata: {
        reason,
        note,
        previousStatus: company.status,
        companyType: company.type,
        usersSuspended: result.usersSuspended,
        driversSuspended: result.driversSuspended,
        vehiclesSuspended: result.vehiclesSuspended,
        sessionsRevoked: result.sessionsRevoked,
        partnerAdminsSuspended: partnerAdminIds.length,
      },
    });

    const notifyEmails = new Set<string>();
    if (company.email?.trim()) notifyEmails.add(company.email.trim().toLowerCase());
    for (const user of company.users) {
      if (user.email?.trim()) notifyEmails.add(user.email.trim().toLowerCase());
    }
    for (const partner of company.adminUsers) {
      if (partner.email?.trim()) notifyEmails.add(partner.email.trim().toLowerCase());
    }

    const notifyType =
      company.type === CompanyType.CARRIER
        ? ('CARRIER' as const)
        : company.type === CompanyType.ADMIN_PARTNER
          ? ('ADMIN_PARTNER' as const)
          : ('SENDER' as const);

    await Promise.all(
      [...notifyEmails].map((to) =>
        this.notifications.sendAccountSuspendedEmail({
          to,
          companyName: company.tradingName || company.legalName,
          companyType: notifyType,
          reason,
          note,
        }),
      ),
    );

    return {
      id: result.company.id,
      status: result.company.status,
      statusBeforeSuspend: result.company.statusBeforeSuspend,
      suspendedAt: result.company.suspendedAt,
      suspendedReason: result.company.suspendedReason,
      suspendedNote: result.company.suspendedNote,
      cascade: {
        usersSuspended: result.usersSuspended,
        driversSuspended: result.driversSuspended,
        vehiclesSuspended: result.vehiclesSuspended,
        sessionsRevoked: result.sessionsRevoked,
      },
    };
  }

  async reactivateCompany(id: string, actorId: string) {
    this.ensureDatabase();

    const company = await this.prisma.company.findUnique({
      where: { id },
      include: {
        users: { select: { id: true } },
        adminUsers: { select: { id: true } },
      },
    });
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    if (company.status !== CompanyStatus.SUSPENDED) {
      throw new BadRequestException('Company is not suspended');
    }

    const restoreStatus = company.statusBeforeSuspend ?? CompanyStatus.PENDING_REVIEW;
    const userIds = company.users.map((u) => u.id);
    const partnerAdminIds = company.adminUsers.map((a) => a.id);

    const partnerRestore =
      restoreStatus === CompanyStatus.ACTIVE
        ? { status: AdminUserStatus.ACTIVE, active: true }
        : restoreStatus === CompanyStatus.PENDING_REVIEW
          ? { status: AdminUserStatus.PENDING_REVIEW, active: false }
          : { status: AdminUserStatus.PENDING_DOCS, active: false };

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.company.update({
        where: { id },
        data: {
          status: restoreStatus,
          statusBeforeSuspend: null,
          suspendedAt: null,
          suspendedReason: null,
          suspendedNote: null,
        },
      });

      await tx.user.updateMany({
        where: { companyId: id, status: UserStatus.SUSPENDED },
        data: { status: UserStatus.ACTIVE },
      });

      await tx.driver.updateMany({
        where: {
          OR: [{ companyId: id }, ...(userIds.length ? [{ userId: { in: userIds } }] : [])],
          status: DriverStatus.SUSPENDED,
        },
        data: { status: DriverStatus.ACTIVE },
      });

      await tx.vehicle.updateMany({
        where: { companyId: id, status: VehicleStatus.SUSPENDED },
        data: { status: VehicleStatus.ACTIVE },
      });

      if (partnerAdminIds.length) {
        await tx.adminUser.updateMany({
          where: { id: { in: partnerAdminIds }, status: AdminUserStatus.SUSPENDED },
          data: partnerRestore,
        });
      }

      return next;
    });

    await this.audit.recordPlatform({
      action: AuditAction.COMPANY_REACTIVATED,
      actorAdminId: actorId,
      entityType: 'Company',
      entityId: id,
      metadata: { restoredStatus: restoreStatus },
    });

    return {
      id: updated.id,
      status: updated.status,
      statusBeforeSuspend: updated.statusBeforeSuspend,
      suspendedAt: updated.suspendedAt,
      suspendedReason: updated.suspendedReason,
      suspendedNote: updated.suspendedNote,
    };
  }

  /** Permanent delete — DRAFT companies only. */
  async deleteCompany(id: string, actorId: string) {
    this.ensureDatabase();

    const company = await this.prisma.company.findUnique({
      where: { id },
      include: {
        users: { select: { id: true, email: true } },
        adminUsers: { select: { id: true, email: true } },
        _count: {
          select: {
            jobsAsSender: true,
            proposals: true,
            assignments: true,
          },
        },
      },
    });
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    if (company.status !== CompanyStatus.DRAFT) {
      throw new BadRequestException(
        'Only draft companies can be permanently deleted. Suspend non-draft companies instead.',
      );
    }
    if (
      company._count.jobsAsSender > 0 ||
      company._count.proposals > 0 ||
      company._count.assignments > 0
    ) {
      throw new BadRequestException(
        'Company has marketplace records and cannot be permanently deleted',
      );
    }

    const userIds = company.users.map((u) => u.id);
    const partnerAdminIds = company.adminUsers.map((a) => a.id);

    await this.prisma.$transaction(async (tx) => {
      await tx.driver.deleteMany({
        where: {
          OR: [{ companyId: id }, ...(userIds.length ? [{ userId: { in: userIds } }] : [])],
        },
      });
      if (userIds.length) {
        await tx.user.deleteMany({ where: { id: { in: userIds } } });
      }
      if (partnerAdminIds.length) {
        await tx.authSession.deleteMany({ where: { adminUserId: { in: partnerAdminIds } } });
        await tx.otpChallenge.deleteMany({ where: { adminUserId: { in: partnerAdminIds } } });
        await tx.adminScope.deleteMany({ where: { adminUserId: { in: partnerAdminIds } } });
        await tx.adminUser.deleteMany({ where: { id: { in: partnerAdminIds } } });
      }
      await tx.complianceDocument.deleteMany({ where: { companyId: id } });
      await tx.complianceCase.deleteMany({ where: { companyId: id } });
      await tx.company.delete({ where: { id } });
    });

    await this.audit.recordPlatform({
      action: AuditAction.COMPANY_DELETED,
      actorAdminId: actorId,
      entityType: 'Company',
      entityId: id,
      metadata: {
        type: company.type,
        legalName: company.legalName,
        email: company.email,
        userEmails: company.users.map((u) => u.email),
      },
    });

    return { ok: true as const, id };
  }

  async getLead(id: string) {
    this.ensureDatabase();

    const lead = await this.prisma.lead.findUnique({
      where: { id },
      include: {
        assignee: { select: { id: true, email: true, name: true } },
        notes: {
          orderBy: { createdAt: 'desc' },
          include: {
            author: { select: { id: true, email: true, name: true } },
          },
        },
        events: {
          orderBy: { createdAt: 'desc' },
          include: {
            actor: { select: { id: true, email: true, name: true } },
          },
        },
      },
    });

    if (!lead) {
      throw new NotFoundException('Lead not found');
    }

    return lead;
  }

  async updateLead(id: string, input: UpdateLeadInput, actorId: string) {
    this.ensureDatabase();

    const existing = await this.prisma.lead.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Lead not found');
    }

    if (input.assigneeId) {
      const assignee = await this.prisma.adminUser.findUnique({
        where: { id: input.assigneeId },
      });
      if (!assignee || !assignee.active) {
        throw new NotFoundException('Assignee not found');
      }
    }

    const lead = await this.prisma.lead.update({
      where: { id },
      data: {
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
      },
      select: leadListSelect,
    });

    if (input.status !== undefined && input.status !== existing.status) {
      await this.audit.record({
        action: AuditAction.LEAD_STATUS_CHANGED,
        leadId: id,
        actorId,
        metadata: {
          from: existing.status,
          to: input.status,
          priority: input.priority ?? existing.priority,
          assigneeId: input.assigneeId ?? existing.assigneeId,
        },
      });
    } else {
      await this.audit.record({
        action: AuditAction.LEAD_UPDATED,
        leadId: id,
        actorId,
        metadata: {
          ...input,
        },
      });
    }

    return lead;
  }

  async deleteLead(id: string, actorId: string) {
    this.ensureDatabase();

    const existing = await this.prisma.lead.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Lead not found');
    }

    await this.audit.record({
      action: AuditAction.LEAD_DELETED,
      leadId: id,
      actorId,
      metadata: {
        type: existing.type,
        status: existing.status,
        email: existing.email,
        companyName: existing.companyName,
      },
    });

    await this.prisma.lead.delete({ where: { id } });

    return { ok: true as const, id };
  }

  async addNote(id: string, input: CreateLeadNoteInput, actorId: string) {
    this.ensureDatabase();

    const existing = await this.prisma.lead.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Lead not found');
    }

    const note = await this.prisma.leadNote.create({
      data: {
        leadId: id,
        authorId: actorId,
        body: input.body,
      },
      include: {
        author: { select: { id: true, email: true, name: true } },
      },
    });

    await this.audit.record({
      action: AuditAction.LEAD_NOTE_ADDED,
      leadId: id,
      actorId,
      metadata: { noteId: note.id },
    });

    return note;
  }

  async exportLeadsCsv(query: AdminLeadExportQuery): Promise<string> {
    this.ensureDatabase();

    const where = this.buildLeadWhere(query);
    const leads = await this.prisma.lead.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        type: true,
        status: true,
        email: true,
        phone: true,
        companyName: true,
        abn: true,
        acn: true,
        state: true,
        territory: true,
        priority: true,
        locale: true,
        source: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const headers = [
      'id',
      'type',
      'status',
      'email',
      'phone',
      'companyName',
      'abn',
      'acn',
      'state',
      'territory',
      'priority',
      'locale',
      'source',
      'createdAt',
      'updatedAt',
    ];

    const lines = [headers.join(',')];
    for (const lead of leads) {
      lines.push(
        [
          lead.id,
          lead.type,
          lead.status,
          lead.email,
          lead.phone ?? '',
          lead.companyName ?? '',
          lead.abn ?? '',
          lead.acn ?? '',
          lead.state ?? '',
          lead.territory ?? '',
          String(lead.priority),
          lead.locale ?? '',
          lead.source ?? '',
          lead.createdAt.toISOString(),
          lead.updatedAt.toISOString(),
        ]
          .map(csvEscape)
          .join(','),
      );
    }

    return `${lines.join('\n')}\n`;
  }

  async listAudit(query: AdminAuditQuery) {
    this.ensureDatabase();

    const where: Prisma.LeadEventWhereInput = {};
    if (query.action) where.action = query.action;
    if (query.leadId) where.leadId = query.leadId;

    const skip = (query.page - 1) * query.pageSize;
    const [items, total] = await Promise.all([
      this.prisma.leadEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.pageSize,
        include: {
          actor: { select: { id: true, email: true, name: true } },
          lead: {
            select: {
              id: true,
              type: true,
              email: true,
              companyName: true,
              status: true,
            },
          },
        },
      }),
      this.prisma.leadEvent.count({ where }),
    ]);

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
