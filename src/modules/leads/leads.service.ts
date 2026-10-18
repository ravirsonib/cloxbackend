import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  AuditAction,
  LeadStatus,
  LeadType,
  type CreateLeadResponse,
  type EoiLeadInput,
  type InvestorLeadInput,
  type RegistryLeadInput,
} from '../../shared/types';
import { LeadStatus as PrismaLeadStatus, LeadType as PrismaLeadType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { hashIp } from '../../common/utils/crypto';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

type IdempotentLeadMatch = {
  id: string;
  type: PrismaLeadType;
  status: PrismaLeadStatus;
  createdAt: Date;
};

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  /** Retry window for timeout-after-commit: same email+type(+ABN) returns existing lead. */
  private static readonly IDEMPOTENT_WINDOW_MS = 24 * 60 * 60 * 1000;

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

  private isHoneypotTriggered(honeypot?: string): boolean {
    return Boolean(honeypot && honeypot.trim().length > 0);
  }

  private normalizeAbn(abn?: string | null): string | undefined {
    if (!abn) return undefined;
    const normalized = abn.replace(/\s+/g, '');
    return normalized.length > 0 ? normalized : undefined;
  }

  private fakeLeadResponse(): CreateLeadResponse {
    return {
      id: '00000000-0000-4000-8000-000000000000',
      type: LeadType.REGISTRY_SENDER,
      status: LeadStatus.NEW,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Idempotent retry guard — if the client timed out after a successful create,
   * return the recent lead instead of inserting another row. Does not re-send mail.
   */
  private async findRecentIdempotentLead(params: {
    email: string;
    type: PrismaLeadType;
    abn?: string;
  }): Promise<IdempotentLeadMatch | null> {
    const since = new Date(Date.now() - LeadsService.IDEMPOTENT_WINDOW_MS);

    return this.prisma.lead.findFirst({
      where: {
        email: params.email.trim().toLowerCase(),
        type: params.type,
        createdAt: { gte: since },
        ...(params.abn ? { abn: params.abn } : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, type: true, status: true, createdAt: true },
    });
  }

  private toIdempotentResponse(lead: IdempotentLeadMatch): CreateLeadResponse {
    return {
      id: lead.id,
      type: lead.type as CreateLeadResponse['type'],
      status: lead.status as CreateLeadResponse['status'],
      createdAt: lead.createdAt.toISOString(),
      warnings: ['Already received — returning your previous submission'],
    };
  }

  /** Soft warning only — does not block create. */
  private async findDuplicateAbns(abn?: string): Promise<string[]> {
    const normalized = this.normalizeAbn(abn);
    if (!normalized) return [];

    const matches = await this.prisma.lead.findMany({
      where: { abn: normalized },
      select: { id: true },
      take: 5,
      orderBy: { createdAt: 'desc' },
    });

    return matches.map((row) => row.id);
  }

  private withDuplicateWarning(
    response: CreateLeadResponse,
    duplicateIds: string[],
  ): CreateLeadResponse {
    if (duplicateIds.length === 0) return response;
    return {
      ...response,
      possibleDuplicate: true,
      warnings: [
        `Possible duplicate ABN — ${duplicateIds.length} existing lead(s) share this ABN`,
      ],
    };
  }

  async createRegistryLead(
    input: RegistryLeadInput,
    meta: { ip?: string },
  ): Promise<CreateLeadResponse> {
    if (this.isHoneypotTriggered(input.honeypot)) {
      this.logger.warn('Honeypot triggered on registry submission');
      return this.fakeLeadResponse();
    }

    this.ensureDatabase();

    const abn = this.normalizeAbn(input.abn)!;
    const type =
      input.userType === 'sender'
        ? PrismaLeadType.REGISTRY_SENDER
        : PrismaLeadType.REGISTRY_CARRIER;

    const existing = await this.findRecentIdempotentLead({
      email: input.email,
      type,
      abn,
    });
    if (existing) {
      this.logger.log(
        `Idempotent registry retry — returning existing lead ${existing.id}`,
      );
      return this.toIdempotentResponse(existing);
    }

    const duplicateIds = await this.findDuplicateAbns(abn);

    const companyName =
      input.userType === 'sender' ? input.companyLegalName : input.fleetEntityName;
    const state = input.userType === 'carrier' ? input.depotState : undefined;

    const { honeypot: _honeypot, ...payload } = input;

    const lead = await this.prisma.lead.create({
      data: {
        type,
        status: PrismaLeadStatus.NEW,
        email: input.email,
        phone: input.phone,
        companyName,
        abn,
        state,
        payload,
        locale: input.locale,
        source: input.source,
        ipHash: hashIp(meta.ip),
        priority: duplicateIds.length > 0,
      },
    });

    await this.audit.record({
      action: AuditAction.LEAD_CREATED,
      leadId: lead.id,
      metadata: {
        type: lead.type,
        email: lead.email,
        channel: 'registry',
        possibleDuplicateAbn: duplicateIds.length > 0,
        duplicateLeadIds: duplicateIds,
      },
    });

    void this.notifications
      .notifyLeadSubmitted({
        type: lead.type,
        leadId: lead.id,
        email: lead.email,
        companyName: lead.companyName,
      })
      .catch((error: unknown) => {
        this.logger.error(
          `Failed to send confirmation email for registry lead ${lead.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      });

    return this.withDuplicateWarning(
      {
        id: lead.id,
        type: lead.type as CreateLeadResponse['type'],
        status: lead.status as CreateLeadResponse['status'],
        createdAt: lead.createdAt.toISOString(),
      },
      duplicateIds,
    );
  }

  async createEoiLead(
    input: EoiLeadInput,
    meta: { ip?: string },
  ): Promise<CreateLeadResponse> {
    if (this.isHoneypotTriggered(input.honeypot)) {
      this.logger.warn('Honeypot triggered on EOI submission');
      return {
        ...this.fakeLeadResponse(),
        type: LeadType.EOI_STATE_MASTER,
        status: LeadStatus.UNDER_REVIEW,
      };
    }

    this.ensureDatabase();

    const abn = this.normalizeAbn(input.abn)!;
    const type =
      input.role === 'state_master'
        ? PrismaLeadType.EOI_STATE_MASTER
        : PrismaLeadType.EOI_LOCAL_BDE;

    const existing = await this.findRecentIdempotentLead({
      email: input.email,
      type,
      abn,
    });
    if (existing) {
      this.logger.log(`Idempotent EOI retry — returning existing lead ${existing.id}`);
      return this.toIdempotentResponse(existing);
    }

    const duplicateIds = await this.findDuplicateAbns(abn);

    const { honeypot: _honeypot, ...payload } = input;

    const lead = await this.prisma.lead.create({
      data: {
        type,
        status: PrismaLeadStatus.UNDER_REVIEW,
        email: input.email,
        phone: input.phone,
        companyName: input.companyName,
        abn,
        acn: input.acn,
        state: input.targetState,
        territory: input.targetTerritory,
        payload,
        locale: input.locale,
        source: input.source,
        ipHash: hashIp(meta.ip),
        priority: duplicateIds.length > 0,
      },
    });

    await this.audit.record({
      action: AuditAction.LEAD_CREATED,
      leadId: lead.id,
      metadata: {
        type: lead.type,
        email: lead.email,
        channel: 'eoi',
        possibleDuplicateAbn: duplicateIds.length > 0,
        duplicateLeadIds: duplicateIds,
      },
    });

    void this.notifications
      .notifyLeadSubmitted({
        type: lead.type,
        leadId: lead.id,
        email: lead.email,
        companyName: lead.companyName,
      })
      .catch((error: unknown) => {
        this.logger.error(
          `Failed to send confirmation email for EOI lead ${lead.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      });

    return this.withDuplicateWarning(
      {
        id: lead.id,
        type: lead.type as CreateLeadResponse['type'],
        status: lead.status as CreateLeadResponse['status'],
        createdAt: lead.createdAt.toISOString(),
      },
      duplicateIds,
    );
  }

  async createInvestorLead(
    input: InvestorLeadInput,
    meta: { ip?: string },
  ): Promise<CreateLeadResponse> {
    if (this.isHoneypotTriggered(input.honeypot)) {
      this.logger.warn('Honeypot triggered on investor submission');
      return {
        ...this.fakeLeadResponse(),
        type: LeadType.INVESTOR,
        status: LeadStatus.UNDER_REVIEW,
      };
    }

    this.ensureDatabase();

    const abn = this.normalizeAbn(input.abn);

    const existing = await this.findRecentIdempotentLead({
      email: input.email,
      type: PrismaLeadType.INVESTOR,
      abn,
    });
    if (existing) {
      this.logger.log(
        `Idempotent investor retry — returning existing lead ${existing.id}`,
      );
      return this.toIdempotentResponse(existing);
    }

    const duplicateIds = abn ? await this.findDuplicateAbns(abn) : [];

    const { honeypot: _honeypot, ...payload } = input;

    const lead = await this.prisma.lead.create({
      data: {
        type: PrismaLeadType.INVESTOR,
        status: PrismaLeadStatus.UNDER_REVIEW,
        email: input.email,
        phone: input.phone,
        companyName: input.fullNameOrEntity,
        abn,
        acn: input.acn,
        state: input.residence,
        payload,
        locale: input.locale,
        source: input.source,
        ipHash: hashIp(meta.ip),
        priority: duplicateIds.length > 0,
      },
    });

    await this.audit.record({
      action: AuditAction.LEAD_CREATED,
      leadId: lead.id,
      metadata: {
        type: lead.type,
        email: lead.email,
        channel: 'investor',
        possibleDuplicateAbn: duplicateIds.length > 0,
        duplicateLeadIds: duplicateIds,
      },
    });

    void this.notifications
      .notifyLeadSubmitted({
        type: lead.type,
        leadId: lead.id,
        email: lead.email,
        companyName: lead.companyName,
      })
      .catch((error: unknown) => {
        this.logger.error(
          `Failed to send confirmation email for investor lead ${lead.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      });

    return this.withDuplicateWarning(
      {
        id: lead.id,
        type: lead.type as CreateLeadResponse['type'],
        status: lead.status as CreateLeadResponse['status'],
        createdAt: lead.createdAt.toISOString(),
      },
      duplicateIds,
    );
  }
}
