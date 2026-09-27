import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AuditAction,
  LeadType,
  type AdminAuditQuery,
  type AdminLeadExportQuery,
  type AdminLeadListQuery,
  type CreateLeadNoteInput,
  type UpdateLeadInput,
} from '../../shared/types';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

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
