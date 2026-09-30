import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AuditAction,
  LeadStatus,
  LeadType,
  type CreateLeadResponse,
  type EoiLeadInput,
  type InvestorLeadInput,
  type RegistryLeadInput,
} from '../../shared/types';
import {
  LeadStatus as PrismaLeadStatus,
  LeadType as PrismaLeadType,
  type Lead,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { hashIp } from '../../common/utils/crypto';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

type LeadCreateMeta = {
  ip?: string;
  idempotencyKey?: string;
};

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

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

  private toCreateResponse(lead: Lead): CreateLeadResponse {
    return {
      id: lead.id,
      type: lead.type as CreateLeadResponse['type'],
      status: lead.status as CreateLeadResponse['status'],
      createdAt: lead.createdAt.toISOString(),
    };
  }

  private isIdempotencyConflict(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      return false;
    }
    const target = error.meta?.target;
    const fields = Array.isArray(target)
      ? target.map(String)
      : typeof target === 'string'
        ? [target]
        : [];
    return fields.some((field) => field.includes('idempotencyKey'));
  }

  private async findByIdempotencyKey(key?: string): Promise<Lead | null> {
    if (!key) return null;
    return this.prisma.lead.findUnique({ where: { idempotencyKey: key } });
  }

  /**
   * Fire-and-forget confirmation email. Marks confirmationEmailedAt only after
   * a successful send so timeout retries can redeliver if the first send never finished.
   */
  private queueConfirmationEmail(lead: Lead): void {
    if (lead.confirmationEmailedAt) return;

    void this.notifications
      .notifyLeadSubmitted({
        type: lead.type,
        leadId: lead.id,
        email: lead.email,
        companyName: lead.companyName,
      })
      .then(async (result) => {
        if (result.skipped) {
          this.logger.warn(
            `Confirmation email skipped (SMTP not configured) for lead ${lead.id}`,
          );
          return;
        }
        await this.prisma.lead.update({
          where: { id: lead.id },
          data: { confirmationEmailedAt: new Date() },
        });
      })
      .catch((error: unknown) => {
        this.logger.error(
          `Failed to send confirmation email for lead ${lead.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      });
  }

  private async createLeadIdempotent(params: {
    idempotencyKey?: string;
    duplicateIds: string[];
    channel: string;
    data: Prisma.LeadUncheckedCreateInput;
  }): Promise<{ lead: Lead; created: boolean }> {
    const existing = await this.findByIdempotencyKey(params.idempotencyKey);
    if (existing) {
      return { lead: existing, created: false };
    }

    try {
      const lead = await this.prisma.lead.create({
        data: {
          ...params.data,
          idempotencyKey: params.idempotencyKey,
          priority: params.duplicateIds.length > 0,
        },
      });
      return { lead, created: true };
    } catch (error) {
      if (this.isIdempotencyConflict(error) && params.idempotencyKey) {
        const raced = await this.findByIdempotencyKey(params.idempotencyKey);
        if (raced) return { lead: raced, created: false };
      }
      throw error;
    }
  }

  private async afterLeadPersisted(params: {
    lead: Lead;
    created: boolean;
    channel: string;
    duplicateIds: string[];
  }): Promise<CreateLeadResponse> {
    if (params.created) {
      await this.audit.record({
        action: AuditAction.LEAD_CREATED,
        leadId: params.lead.id,
        metadata: {
          type: params.lead.type,
          email: params.lead.email,
          channel: params.channel,
          possibleDuplicateAbn: params.duplicateIds.length > 0,
          duplicateLeadIds: params.duplicateIds,
          idempotencyKey: params.lead.idempotencyKey ?? undefined,
        },
      });
    }

    // New create, or replay when email never completed — ensure delivery.
    this.queueConfirmationEmail(params.lead);

    return this.withDuplicateWarning(
      this.toCreateResponse(params.lead),
      params.created ? params.duplicateIds : [],
    );
  }

  async createRegistryLead(
    input: RegistryLeadInput,
    meta: LeadCreateMeta,
  ): Promise<CreateLeadResponse> {
    if (this.isHoneypotTriggered(input.honeypot)) {
      this.logger.warn('Honeypot triggered on registry submission');
      return this.fakeLeadResponse();
    }

    this.ensureDatabase();

    const abn = this.normalizeAbn(input.abn)!;
    const duplicateIds = await this.findDuplicateAbns(abn);
    const idempotencyKey = meta.idempotencyKey ?? input.idempotencyKey;

    const type =
      input.userType === 'sender'
        ? PrismaLeadType.REGISTRY_SENDER
        : PrismaLeadType.REGISTRY_CARRIER;

    const companyName =
      input.userType === 'sender' ? input.companyLegalName : input.fleetEntityName;
    const state = input.userType === 'carrier' ? input.depotState : undefined;

    const { honeypot: _honeypot, idempotencyKey: _key, ...payload } = input;

    const { lead, created } = await this.createLeadIdempotent({
      idempotencyKey,
      duplicateIds,
      channel: 'registry',
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
      },
    });

    return this.afterLeadPersisted({
      lead,
      created,
      channel: 'registry',
      duplicateIds,
    });
  }

  async createEoiLead(
    input: EoiLeadInput,
    meta: LeadCreateMeta,
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
    const duplicateIds = await this.findDuplicateAbns(abn);
    const idempotencyKey = meta.idempotencyKey ?? input.idempotencyKey;

    const type =
      input.role === 'state_master'
        ? PrismaLeadType.EOI_STATE_MASTER
        : PrismaLeadType.EOI_LOCAL_BDE;

    const { honeypot: _honeypot, idempotencyKey: _key, ...payload } = input;

    const { lead, created } = await this.createLeadIdempotent({
      idempotencyKey,
      duplicateIds,
      channel: 'eoi',
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
      },
    });

    return this.afterLeadPersisted({
      lead,
      created,
      channel: 'eoi',
      duplicateIds,
    });
  }

  async createInvestorLead(
    input: InvestorLeadInput,
    meta: LeadCreateMeta,
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
    const duplicateIds = abn ? await this.findDuplicateAbns(abn) : [];
    const idempotencyKey = meta.idempotencyKey ?? input.idempotencyKey;

    const { honeypot: _honeypot, idempotencyKey: _key, ...payload } = input;

    const { lead, created } = await this.createLeadIdempotent({
      idempotencyKey,
      duplicateIds,
      channel: 'investor',
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
      },
    });

    return this.afterLeadPersisted({
      lead,
      created,
      channel: 'investor',
      duplicateIds,
    });
  }
}
