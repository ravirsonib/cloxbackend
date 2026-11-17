import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AdminRole,
  AdminScopeType,
  AdminUserStatus,
  CompanyStatus,
  CompanyType,
  PaymentEventStatus,
  PaymentEventType,
  Prisma,
  RevenueSplitScopeType,
  SettlementLineStatus,
  SettlementRecipientType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../shared/types';
import {
  allocateTwoStage,
  applySenderPlatformFee,
  assertAdminPool,
  assertNationalPayload,
  CARRIER_PERCENT_FIXED,
  DEFAULT_CLOX_POOL,
  effectiveCarrierPercent,
  maxCarrierBonusPercent,
  MIN_PLATFORM_PERCENT_DEFAULT,
  normalizeAdminPoolShares,
  REVENUE_SPLIT_POLICY_KEY,
  toPolicyPayload,
  type CloxPoolPercents,
  type ResolvedRevenueSplit,
  type RevenueSplitPercents,
  type RevenueSplitPolicyPayload,
  type SenderFeeApplyResult,
  type SenderPlatformFeeMode,
} from './revenue-split.types';

const DEFAULT_PERCENTS: RevenueSplitPercents & CloxPoolPercents = assertNationalPayload({
  carrierPercent: CARRIER_PERCENT_FIXED,
  ...DEFAULT_CLOX_POOL,
});

@Injectable()
export class RevenueSplitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  /** Display helper — carrier net from national policy ± optional company uplift. */
  async carrierNetPayoutCents(
    grossIncGstCents: number,
    at = new Date(),
    carrierCompanyId?: string | null,
  ): Promise<number> {
    const resolved = await this.resolvePercents({
      referredByAdminUserId: null,
      carrierCompanyId: carrierCompanyId ?? null,
      at,
    });
    return allocateTwoStage(
      grossIncGstCents,
      resolved.percents.carrierPercent,
      resolved.cloxPool,
    ).carrier;
  }

  /** National carrier % only (for market board hints). */
  async nationalCarrierPercent(at = new Date()): Promise<number> {
    const national = await this.getEffectiveNational(at);
    return national.percents.carrierPercent;
  }

  async resolveForJob(params: {
    grossIncGstCents: number;
    originRegionId: string | null;
    originTerritoryId: string | null;
    /** Sender company — package % from referredByAdminUserId when present. */
    senderCompanyId?: string | null;
    /** Carrier company — optional performance uplift on national carrier %. */
    carrierCompanyId?: string | null;
    referredByAdminUserId?: string | null;
    at?: Date;
  }): Promise<ResolvedRevenueSplit> {
    this.ensureDatabase();
    const at = params.at ?? new Date();

    let referredByAdminUserId = params.referredByAdminUserId ?? null;
    if (!referredByAdminUserId && params.senderCompanyId) {
      const company = await this.prisma.company.findUnique({
        where: { id: params.senderCompanyId },
        select: { referredByAdminUserId: true },
      });
      referredByAdminUserId = company?.referredByAdminUserId ?? null;
    }

    const resolved = await this.resolvePercents({
      referredByAdminUserId,
      carrierCompanyId: params.carrierCompanyId ?? null,
      at,
    });

    const amounts = allocateTwoStage(
      params.grossIncGstCents,
      resolved.percents.carrierPercent,
      resolved.cloxPool,
    );

    const referrer =
      referredByAdminUserId != null
        ? await this.prisma.adminUser.findUnique({
            where: { id: referredByAdminUserId },
            select: { id: true, role: true, status: true, active: true },
          })
        : null;

    const settings = await this.prisma.platformSettings?.findUnique?.({
      where: { id: 'default' },
      select: { enableStateMasterTier: true },
    });
    const isStateTierEnabled = Boolean(settings?.enableStateMasterTier);

    const stateSeat =
      isStateTierEnabled && params.originRegionId
        ? await this.findActiveSeatAdmin({
            role: AdminRole.STATE_MASTER,
            scopeType: AdminScopeType.STATE,
            regionId: params.originRegionId,
          })
        : null;

    const stateRecipient = stateSeat
      ? SettlementRecipientType.STATE_MASTER
      : SettlementRecipientType.HQ_HOLDING;

    let localAdminUserId: string | null = null;
    let localRecipient: SettlementRecipientType = SettlementRecipientType.HQ_HOLDING;

    if (referrer?.role === AdminRole.LOCAL_BDE) {
      if (referrer.status === AdminUserStatus.ACTIVE && referrer.active) {
        localAdminUserId = referrer.id;
        localRecipient = SettlementRecipientType.LOCAL_BDE;
      }
    } else {
      const localSeat = params.originTerritoryId
        ? await this.findActiveSeatAdmin({
            role: AdminRole.LOCAL_BDE,
            scopeType: AdminScopeType.LOCAL,
            localTerritoryId: params.originTerritoryId,
          })
        : null;
      if (localSeat) {
        localAdminUserId = localSeat;
        localRecipient = SettlementRecipientType.LOCAL_BDE;
      }
    }

    const percents = amounts.grossPercents;

    return {
      percents,
      cloxPool: amounts.cloxPool,
      cloxPoolPercent: amounts.cloxPoolPercent,
      policyVersionId: resolved.policyVersionId,
      overrideId: null,
      adminPackageId: resolved.adminPackageId,
      carrierUpliftId: resolved.carrierUpliftId,
      carrierBonusPercent: resolved.carrierBonusPercent,
      referredByAdminUserId,
      lines: [
        {
          recipientType: SettlementRecipientType.CARRIER,
          sharePercent: percents.carrierPercent,
          amountCents: amounts.carrier,
          regionId: params.originRegionId,
          territoryId: params.originTerritoryId,
          adminUserId: null,
          bucket: 'CARRIER',
        },
        {
          recipientType: SettlementRecipientType.SUPER_ADMIN,
          sharePercent: percents.superPercent,
          amountCents: amounts.superShare,
          regionId: params.originRegionId,
          territoryId: params.originTerritoryId,
          adminUserId: null,
          bucket: 'SUPER',
        },
        {
          recipientType: stateRecipient,
          sharePercent: percents.statePercent,
          amountCents: amounts.stateShare,
          regionId: params.originRegionId,
          territoryId: params.originTerritoryId,
          adminUserId: stateSeat,
          bucket: 'STATE',
        },
        {
          recipientType: localRecipient,
          sharePercent: percents.localPercent,
          amountCents: amounts.localShare,
          regionId: params.originRegionId,
          territoryId: params.originTerritoryId,
          adminUserId: localAdminUserId,
          bucket: 'LOCAL',
        },
      ],
    };
  }

  /**
   * National carrier % (+ optional carrier uplift) and CLOX pool mix
   * (national or sender onboarder's package). Packages never change carrier %.
   */
  async resolvePercents(params: {
    referredByAdminUserId: string | null;
    carrierCompanyId?: string | null;
    at: Date;
  }): Promise<{
    percents: RevenueSplitPercents;
    cloxPool: CloxPoolPercents;
    policyVersionId: string | null;
    adminPackageId: string | null;
    carrierUpliftId: string | null;
    carrierBonusPercent: number;
  }> {
    const national = await this.getEffectiveNational(params.at);
    const settings = await this.getFeeSettings();
    const uplift = params.carrierCompanyId
      ? await this.findEffectiveCarrierUplift(params.carrierCompanyId, params.at)
      : null;
    const bonusPercent = uplift?.bonusPercent ?? 0;
    const carrierPercent = effectiveCarrierPercent({
      nationalCarrierPercent: national.percents.carrierPercent,
      bonusPercent,
      minPlatformPercent: settings.minPlatformPercent,
    });

    let cloxPool: CloxPoolPercents = {
      cloxSuperPercent: national.percents.cloxSuperPercent,
      cloxStatePercent: national.percents.cloxStatePercent,
      cloxLocalPercent: national.percents.cloxLocalPercent,
    };
    let adminPackageId: string | null = null;

    if (params.referredByAdminUserId) {
      const pkg = await this.findEffectiveAdminPackage(
        params.referredByAdminUserId,
        params.at,
      );
      if (pkg) {
        cloxPool = normalizeAdminPoolShares({
          superPercent: pkg.superPercent,
          statePercent: pkg.statePercent,
          localPercent: pkg.localPercent,
        });
        adminPackageId = pkg.id;
      }
    }

    const staged = allocateTwoStage(10000, carrierPercent, cloxPool);
    return {
      percents: staged.grossPercents,
      cloxPool,
      policyVersionId: national.policyVersionId,
      adminPackageId,
      carrierUpliftId: uplift?.id ?? null,
      carrierBonusPercent: bonusPercent,
    };
  }

  async resolveSenderFee(params: {
    baseIncGstCents: number;
    senderCompanyId?: string | null;
    at?: Date;
  }): Promise<SenderFeeApplyResult & { senderFeeOverrideId: string | null }> {
    this.ensureDatabase();
    const at = params.at ?? new Date();
    const settings = await this.getFeeSettings();
    let feePercent = settings.senderPlatformFeePercent;
    let senderFeeOverrideId: string | null = null;
    if (params.senderCompanyId) {
      const override = await this.findEffectiveSenderFeeOverride(params.senderCompanyId, at);
      if (override && !override.inheritNational) {
        feePercent = override.feePercent;
        senderFeeOverrideId = override.id;
      }
    }
    return {
      ...applySenderPlatformFee({
        baseIncGstCents: params.baseIncGstCents,
        feePercent,
        mode: settings.senderPlatformFeeMode,
      }),
      senderFeeOverrideId,
    };
  }

  private async getFeeSettings(): Promise<{
    senderPlatformFeePercent: number;
    senderPlatformFeeMode: SenderPlatformFeeMode;
    minPlatformPercent: number;
  }> {
    const row = await this.prisma.platformSettings.findUnique({
      where: { id: 'default' },
      select: {
        senderPlatformFeePercent: true,
        senderPlatformFeeMode: true,
        minPlatformPercent: true,
      },
    });
    return {
      senderPlatformFeePercent: row?.senderPlatformFeePercent ?? 0,
      senderPlatformFeeMode: (row?.senderPlatformFeeMode as SenderPlatformFeeMode) ?? 'EXCLUSIVE',
      minPlatformPercent: row?.minPlatformPercent ?? MIN_PLATFORM_PERCENT_DEFAULT,
    };
  }

  private async getEffectiveNational(at: Date): Promise<{
    percents: RevenueSplitPercents & CloxPoolPercents;
    policyVersionId: string | null;
  }> {
    const rows = await this.prisma.policyVersion.findMany({
      where: {
        key: REVENUE_SPLIT_POLICY_KEY,
        publishedAt: { not: null, lte: at },
      },
      orderBy: [{ publishedAt: 'desc' }, { version: 'desc' }],
      take: 20,
    });

    for (const row of rows) {
      const payload = row.payload as RevenueSplitPolicyPayload;
      const effectiveFrom = payload.effectiveFrom
        ? new Date(payload.effectiveFrom)
        : row.publishedAt!;
      if (effectiveFrom.getTime() > at.getTime()) continue;
      try {
        return {
          percents: assertNationalPayload(payload),
          policyVersionId: row.id,
        };
      } catch {
        continue;
      }
    }

    return { percents: DEFAULT_PERCENTS, policyVersionId: null };
  }

  private async findEffectiveAdminPackage(adminUserId: string, at: Date) {
    return this.prisma.adminRevenueSplitPackage.findFirst({
      where: {
        adminUserId,
        publishedAt: { not: null, lte: at },
        effectiveFrom: { lte: at },
      },
      orderBy: [{ effectiveFrom: 'desc' }, { publishedAt: 'desc' }],
    });
  }

  private async findEffectiveCarrierUplift(companyId: string, at: Date) {
    return this.prisma.companyRevenueUplift.findFirst({
      where: {
        companyId,
        publishedAt: { not: null, lte: at },
        effectiveFrom: { lte: at },
      },
      orderBy: [{ effectiveFrom: 'desc' }, { publishedAt: 'desc' }],
    });
  }

  private async findEffectiveSenderFeeOverride(companyId: string, at: Date) {
    return this.prisma.companySenderFeeOverride.findFirst({
      where: {
        companyId,
        publishedAt: { not: null, lte: at },
        effectiveFrom: { lte: at },
      },
      orderBy: [{ effectiveFrom: 'desc' }, { publishedAt: 'desc' }],
    });
  }

  private async findActiveSeatAdmin(params: {
    role: AdminRole;
    scopeType: AdminScopeType;
    regionId?: string;
    localTerritoryId?: string;
  }): Promise<string | null> {
    const scope = await this.prisma.adminScope.findFirst({
      where: {
        scopeType: params.scopeType,
        ...(params.regionId ? { regionId: params.regionId } : {}),
        ...(params.localTerritoryId ? { localTerritoryId: params.localTerritoryId } : {}),
        adminUser: {
          role: params.role,
          status: AdminUserStatus.ACTIVE,
          active: true,
        },
      },
      select: { adminUserId: true },
      orderBy: { createdAt: 'asc' },
    });
    return scope?.adminUserId ?? null;
  }

  // ─── Admin settings API ───────────────────────────────────────────────────

  async getSettings() {
    this.ensureDatabase();
    const now = new Date();
    const effective = await this.getEffectiveNational(now);
    const draft = await this.prisma.policyVersion.findFirst({
      where: { key: REVENUE_SPLIT_POLICY_KEY, publishedAt: null },
      orderBy: { version: 'desc' },
    });
    const latestPublished = await this.prisma.policyVersion.findFirst({
      where: { key: REVENUE_SPLIT_POLICY_KEY, publishedAt: { not: null } },
      orderBy: [{ publishedAt: 'desc' }, { version: 'desc' }],
    });
    return {
      carrierPercent: effective.percents.carrierPercent,
      carrierPercentFixed: effective.percents.carrierPercent,
      platformPercent: 100 - effective.percents.carrierPercent,
      platformPercentFixed: 100 - effective.percents.carrierPercent,
      cloxPool: {
        cloxSuperPercent: effective.percents.cloxSuperPercent,
        cloxStatePercent: effective.percents.cloxStatePercent,
        cloxLocalPercent: effective.percents.cloxLocalPercent,
      },
      effective: {
        policyVersionId: effective.policyVersionId,
        percents: effective.percents,
        cloxPool: {
          cloxSuperPercent: effective.percents.cloxSuperPercent,
          cloxStatePercent: effective.percents.cloxStatePercent,
          cloxLocalPercent: effective.percents.cloxLocalPercent,
        },
        payload: latestPublished?.payload ?? null,
        publishedAt: latestPublished?.publishedAt ?? null,
        version: latestPublished?.version ?? null,
      },
      draft: draft
        ? {
            id: draft.id,
            version: draft.version,
            payload: draft.payload,
            createdAt: draft.createdAt,
          }
        : null,
    };
  }

  async listVersions() {
    this.ensureDatabase();
    const rows = await this.prisma.policyVersion.findMany({
      where: { key: REVENUE_SPLIT_POLICY_KEY },
      orderBy: { version: 'desc' },
      take: 50,
      include: { publisher: { select: { id: true, email: true, name: true } } },
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        version: r.version,
        payload: r.payload,
        publishedAt: r.publishedAt,
        publishedBy: r.publisher,
        createdAt: r.createdAt,
      })),
    };
  }

  private requireAdminPool(input: {
    superPercent: number;
    statePercent: number;
    localPercent: number;
    carrierPercent?: number;
  }) {
    try {
      assertAdminPool(input);
    } catch (error: unknown) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  async saveDraft(
    input: {
      carrierPercent?: number;
      superPercent?: number;
      statePercent?: number;
      localPercent?: number;
      cloxSuperPercent?: number;
      cloxStatePercent?: number;
      cloxLocalPercent?: number;
      notes?: string;
    },
    actorAdminId: string,
  ) {
    this.ensureDatabase();
    let validatedPercents: RevenueSplitPercents & CloxPoolPercents;
    try {
      validatedPercents = assertNationalPayload(input);
    } catch (error: unknown) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }

    const payload: RevenueSplitPolicyPayload = toPolicyPayload(validatedPercents, {
      notes: input.notes,
    });

    const existingDraft = await this.prisma.policyVersion.findFirst({
      where: { key: REVENUE_SPLIT_POLICY_KEY, publishedAt: null },
      orderBy: { version: 'desc' },
    });

    let row;
    if (existingDraft) {
      row = await this.prisma.policyVersion.update({
        where: { id: existingDraft.id },
        data: { payload: payload as Prisma.InputJsonValue },
      });
    } else {
      const max = await this.prisma.policyVersion.aggregate({
        where: { key: REVENUE_SPLIT_POLICY_KEY },
        _max: { version: true },
      });
      row = await this.prisma.policyVersion.create({
        data: {
          key: REVENUE_SPLIT_POLICY_KEY,
          version: (max._max.version ?? 0) + 1,
          payload: payload as Prisma.InputJsonValue,
        },
      });
    }

    await this.audit.recordPlatform({
      action: AuditAction.REVENUE_SPLIT_DRAFTED,
      actorAdminId,
      entityType: 'PolicyVersion',
      entityId: row.id,
      metadata: { payload },
    });

    return { id: row.id, version: row.version, payload: row.payload };
  }

  async publishDraft(
    input: {
      draftId?: string;
      carrierPercent?: number;
      superPercent?: number;
      statePercent?: number;
      localPercent?: number;
      cloxSuperPercent?: number;
      cloxStatePercent?: number;
      cloxLocalPercent?: number;
      notes?: string;
      effectiveFrom?: string;
    },
    actorAdminId: string,
  ) {
    this.ensureDatabase();
    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();
    if (Number.isNaN(effectiveFrom.getTime())) {
      throw new BadRequestException('Invalid effectiveFrom');
    }

    let draftId = input.draftId;
    if (!draftId) {
      const hasPool =
        input.cloxSuperPercent != null &&
        input.cloxStatePercent != null &&
        input.cloxLocalPercent != null;
      const hasGross =
        input.superPercent != null && input.statePercent != null && input.localPercent != null;
      if (!hasPool && !hasGross) {
        throw new BadRequestException('Provide draftId or CLOX pool / gross admin percents');
      }
      const saved = await this.saveDraft(
        {
          carrierPercent: input.carrierPercent,
          superPercent: input.superPercent,
          statePercent: input.statePercent,
          localPercent: input.localPercent,
          cloxSuperPercent: input.cloxSuperPercent,
          cloxStatePercent: input.cloxStatePercent,
          cloxLocalPercent: input.cloxLocalPercent,
          notes: input.notes,
        },
        actorAdminId,
      );
      draftId = saved.id;
    }

    const draft = await this.prisma.policyVersion.findUnique({ where: { id: draftId } });
    if (!draft || draft.key !== REVENUE_SPLIT_POLICY_KEY) {
      throw new NotFoundException('Draft not found');
    }
    if (draft.publishedAt) {
      throw new BadRequestException('Version already published');
    }

    const base = draft.payload as RevenueSplitPolicyPayload;
    let percents: RevenueSplitPercents & CloxPoolPercents;
    try {
      percents = assertNationalPayload({
        carrierPercent: input.carrierPercent ?? base.carrierPercent,
        superPercent: input.superPercent ?? base.superPercent,
        statePercent: input.statePercent ?? base.statePercent,
        localPercent: input.localPercent ?? base.localPercent,
        cloxSuperPercent: input.cloxSuperPercent ?? base.cloxSuperPercent,
        cloxStatePercent: input.cloxStatePercent ?? base.cloxStatePercent,
        cloxLocalPercent: input.cloxLocalPercent ?? base.cloxLocalPercent,
      });
    } catch (error: unknown) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    const payload: RevenueSplitPolicyPayload = toPolicyPayload(percents, {
      effectiveFrom: effectiveFrom.toISOString(),
      notes: input.notes ?? base.notes,
    });

    const published = await this.prisma.policyVersion.update({
      where: { id: draft.id },
      data: {
        payload: payload as Prisma.InputJsonValue,
        publishedAt: new Date(),
        publishedBy: actorAdminId,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.REVENUE_SPLIT_PUBLISHED,
      actorAdminId,
      entityType: 'PolicyVersion',
      entityId: published.id,
      metadata: { payload, version: published.version },
    });

    return {
      id: published.id,
      version: published.version,
      payload: published.payload,
      publishedAt: published.publishedAt,
    };
  }

  async listOverrides() {
    this.ensureDatabase();
    const items = await this.prisma.revenueSplitOverride.findMany({
      where: { publishedAt: { not: null } },
      orderBy: [{ scopeType: 'asc' }, { effectiveFrom: 'desc' }],
      take: 100,
      include: { publisher: { select: { id: true, email: true, name: true } } },
    });
    return { items };
  }

  /**
   * Legacy seat override publish — kept for API compatibility / audit.
   * Product UI should publish AdminRevenueSplitPackage instead.
   */
  async publishOverride(
    input: {
      scopeType: 'REGION' | 'TERRITORY';
      scopeId: string;
      superPercent: number;
      statePercent: number;
      localPercent: number;
      effectiveFrom?: string;
      notes?: string;
    },
    actorAdminId: string,
  ) {
    this.ensureDatabase();
    const now = new Date();
    const national = await this.getEffectiveNational(now);
    this.requireAdminPool({
      superPercent: input.superPercent,
      statePercent: input.statePercent,
      localPercent: input.localPercent,
      carrierPercent: national.percents.carrierPercent,
    });

    if (input.scopeType === 'REGION') {
      const region = await this.prisma.region.findUnique({ where: { id: input.scopeId } });
      if (!region) throw new NotFoundException('Region not found');
    } else {
      const territory = await this.prisma.localTerritory.findUnique({
        where: { id: input.scopeId },
      });
      if (!territory) throw new NotFoundException('Territory not found');
    }

    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();
    if (Number.isNaN(effectiveFrom.getTime())) {
      throw new BadRequestException('Invalid effectiveFrom');
    }

    const row = await this.prisma.revenueSplitOverride.create({
      data: {
        scopeType: input.scopeType as RevenueSplitScopeType,
        scopeId: input.scopeId,
        superPercent: input.superPercent,
        statePercent: input.statePercent,
        localPercent: input.localPercent,
        effectiveFrom,
        publishedAt: new Date(),
        publishedBy: actorAdminId,
        notes: input.notes,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.REVENUE_SPLIT_OVERRIDE_PUBLISHED,
      actorAdminId,
      entityType: 'RevenueSplitOverride',
      entityId: row.id,
      metadata: {
        scopeType: row.scopeType,
        scopeId: row.scopeId,
        superPercent: row.superPercent,
        statePercent: row.statePercent,
        localPercent: row.localPercent,
        effectiveFrom: row.effectiveFrom.toISOString(),
      },
    });

    return row;
  }

  async listAdminPackages(query: { adminUserId?: string } = {}) {
    this.ensureDatabase();
    const items = await this.prisma.adminRevenueSplitPackage.findMany({
      where: {
        publishedAt: { not: null },
        ...(query.adminUserId ? { adminUserId: query.adminUserId } : {}),
      },
      orderBy: [{ adminUserId: 'asc' }, { effectiveFrom: 'desc' }, { publishedAt: 'desc' }],
      take: 200,
      include: {
        adminUser: { select: { id: true, email: true, name: true, role: true } },
        publisher: { select: { id: true, email: true, name: true } },
      },
    });
    return { items };
  }

  async publishAdminPackage(
    input: {
      adminUserId: string;
      superPercent: number;
      statePercent: number;
      localPercent: number;
      effectiveFrom?: string;
      notes?: string;
    },
    actorAdminId: string,
  ) {
    this.ensureDatabase();
    // Accept pool-relative (sum 100) or legacy absolute gross; always store pool-relative.
    let pool: CloxPoolPercents;
    try {
      this.requireAdminPool({
        superPercent: input.superPercent,
        statePercent: input.statePercent,
        localPercent: input.localPercent,
      });
      pool = normalizeAdminPoolShares({
        superPercent: input.superPercent,
        statePercent: input.statePercent,
        localPercent: input.localPercent,
      });
    } catch (error: unknown) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }

    const admin = await this.prisma.adminUser.findUnique({
      where: { id: input.adminUserId },
      select: { id: true, role: true, email: true },
    });
    if (!admin) throw new NotFoundException('Admin not found');
    if (admin.role !== AdminRole.STATE_MASTER && admin.role !== AdminRole.LOCAL_BDE) {
      throw new BadRequestException('Packages are only for State Master or Local BDE');
    }

    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();
    if (Number.isNaN(effectiveFrom.getTime())) {
      throw new BadRequestException('Invalid effectiveFrom');
    }

    const row = await this.prisma.adminRevenueSplitPackage.create({
      data: {
        adminUserId: input.adminUserId,
        superPercent: pool.cloxSuperPercent,
        statePercent: pool.cloxStatePercent,
        localPercent: pool.cloxLocalPercent,
        effectiveFrom,
        publishedAt: new Date(),
        publishedBy: actorAdminId,
        notes: input.notes,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.REVENUE_SPLIT_ADMIN_PACKAGE_PUBLISHED,
      actorAdminId,
      entityType: 'AdminRevenueSplitPackage',
      entityId: row.id,
      metadata: {
        adminUserId: row.adminUserId,
        email: admin.email,
        cloxSuperPercent: row.superPercent,
        cloxStatePercent: row.statePercent,
        cloxLocalPercent: row.localPercent,
        effectiveFrom: row.effectiveFrom.toISOString(),
      },
    });

    return row;
  }

  async publishCarrierUplift(
    input: {
      companyId: string;
      bonusPercent: number;
      effectiveFrom?: string;
      notes?: string;
    },
    actorAdminId: string,
  ) {
    this.ensureDatabase();
    const company = await this.prisma.company.findUnique({
      where: { id: input.companyId },
      select: { id: true, type: true, legalName: true },
    });
    if (!company) throw new NotFoundException('Company not found');
    if (company.type !== CompanyType.CARRIER) {
      throw new BadRequestException('Revenue uplift is only for carrier companies');
    }

    const national = await this.getEffectiveNational(new Date());
    const settings = await this.getFeeSettings();
    const maxBonus = maxCarrierBonusPercent({
      nationalCarrierPercent: national.percents.carrierPercent,
      minPlatformPercent: settings.minPlatformPercent,
    });
    if (
      !Number.isInteger(input.bonusPercent) ||
      input.bonusPercent < 0 ||
      input.bonusPercent > maxBonus
    ) {
      throw new BadRequestException(
        `bonusPercent must be an integer 0–${maxBonus} (national carrier ${national.percents.carrierPercent}% · min CLOX ${settings.minPlatformPercent}%)`,
      );
    }
    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();
    if (Number.isNaN(effectiveFrom.getTime())) {
      throw new BadRequestException('Invalid effectiveFrom');
    }

    const row = await this.prisma.companyRevenueUplift.create({
      data: {
        companyId: company.id,
        bonusPercent: input.bonusPercent,
        effectiveFrom,
        publishedAt: new Date(),
        publishedBy: actorAdminId,
        notes: input.notes,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.COMPANY_REVENUE_UPLIFT_PUBLISHED,
      actorAdminId,
      entityType: 'CompanyRevenueUplift',
      entityId: row.id,
      metadata: {
        companyId: company.id,
        legalName: company.legalName,
        bonusPercent: row.bonusPercent,
        effectiveFrom: row.effectiveFrom.toISOString(),
      },
    });

    return row;
  }

  async publishSenderFeeOverride(
    input: {
      companyId: string;
      feePercent?: number;
      inheritNational?: boolean;
      effectiveFrom?: string;
      notes?: string;
    },
    actorAdminId: string,
  ) {
    this.ensureDatabase();
    const company = await this.prisma.company.findUnique({
      where: { id: input.companyId },
      select: { id: true, type: true, legalName: true },
    });
    if (!company) throw new NotFoundException('Company not found');
    if (company.type !== CompanyType.SENDER) {
      throw new BadRequestException('Sender fee override is only for sender companies');
    }

    const inheritNational = Boolean(input.inheritNational);
    const settings = await this.getFeeSettings();
    let feePercent = settings.senderPlatformFeePercent;
    if (!inheritNational) {
      if (
        input.feePercent == null ||
        !Number.isInteger(input.feePercent) ||
        input.feePercent < 0 ||
        input.feePercent > 30
      ) {
        throw new BadRequestException('feePercent must be an integer 0–30');
      }
      feePercent = input.feePercent;
    }

    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();
    if (Number.isNaN(effectiveFrom.getTime())) {
      throw new BadRequestException('Invalid effectiveFrom');
    }

    const row = await this.prisma.companySenderFeeOverride.create({
      data: {
        companyId: company.id,
        feePercent,
        inheritNational,
        effectiveFrom,
        publishedAt: new Date(),
        publishedBy: actorAdminId,
        notes: input.notes,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.COMPANY_SENDER_FEE_OVERRIDE_PUBLISHED,
      actorAdminId,
      entityType: 'CompanySenderFeeOverride',
      entityId: row.id,
      metadata: {
        companyId: company.id,
        legalName: company.legalName,
        feePercent: row.feePercent,
        inheritNational: row.inheritNational,
        effectiveFrom: row.effectiveFrom.toISOString(),
      },
    });

    return row;
  }

  async listCarrierUplifts(companyId: string) {
    this.ensureDatabase();
    const items = await this.prisma.companyRevenueUplift.findMany({
      where: { companyId, publishedAt: { not: null } },
      orderBy: [{ effectiveFrom: 'desc' }, { publishedAt: 'desc' }],
      take: 50,
      include: { publisher: { select: { id: true, email: true, name: true } } },
    });
    return { items };
  }

  async listSenderFeeOverrides(companyId: string) {
    this.ensureDatabase();
    const items = await this.prisma.companySenderFeeOverride.findMany({
      where: { companyId, publishedAt: { not: null } },
      orderBy: [{ effectiveFrom: 'desc' }, { publishedAt: 'desc' }],
      take: 50,
      include: { publisher: { select: { id: true, email: true, name: true } } },
    });
    return { items };
  }

  async preview(params: {
    grossIncGstCents: number;
    regionId?: string;
    territoryId?: string;
    senderCompanyId?: string;
    carrierCompanyId?: string;
    applySenderFee?: boolean;
  }) {
    this.ensureDatabase();
    if (!Number.isInteger(params.grossIncGstCents) || params.grossIncGstCents < 0) {
      throw new BadRequestException('grossIncGstCents must be a non-negative integer');
    }

    let settlementGross = params.grossIncGstCents;
    let senderFee: (SenderFeeApplyResult & { senderFeeOverrideId: string | null }) | null = null;
    if (params.applySenderFee) {
      senderFee = await this.resolveSenderFee({
        baseIncGstCents: params.grossIncGstCents,
        senderCompanyId: params.senderCompanyId ?? null,
      });
      settlementGross = senderFee.chargeIncGstCents;
    }

    const split = await this.resolveForJob({
      grossIncGstCents: settlementGross,
      originRegionId: params.regionId ?? null,
      originTerritoryId: params.territoryId ?? null,
      senderCompanyId: params.senderCompanyId ?? null,
      carrierCompanyId: params.carrierCompanyId ?? null,
    });

    return { ...split, senderFee, settlementGrossIncGstCents: settlementGross };
  }

  async listScopes() {
    this.ensureDatabase();
    const [regions, territories] = await Promise.all([
      this.prisma.region.findMany({
        orderBy: { code: 'asc' },
        select: { id: true, code: true, name: true, enabled: true },
      }),
      this.prisma.localTerritory.findMany({
        orderBy: [{ regionId: 'asc' }, { code: 'asc' }],
        select: {
          id: true,
          code: true,
          name: true,
          enabled: true,
          regionId: true,
          region: { select: { code: true, name: true } },
        },
      }),
    ]);
    return { regions, territories };
  }

  /**
   * Super decision support: BoB (referrals) + seat/origin economics (90d).
   * Does not change settlement math — use publishAdminPackage after deciding.
   */
  async partnerPerformance(query: {
    role?: 'STATE_MASTER' | 'LOCAL_BDE';
    status?: AdminUserStatus;
    regionId?: string;
    q?: string;
    page?: number;
    pageSize?: number;
  }) {
    this.ensureDatabase();
    const now = new Date();
    const windowStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const national = await this.getEffectiveNational(now);
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 20));
    const skip = (page - 1) * pageSize;

    const q = query.q?.trim();
    const where: Prisma.AdminUserWhereInput = {
      role: query.role
        ? (query.role as AdminRole)
        : { in: [AdminRole.STATE_MASTER, AdminRole.LOCAL_BDE] },
      ...(query.status ? { status: query.status } : {}),
      ...(q
        ? {
            OR: [
              { email: { contains: q, mode: 'insensitive' } },
              { name: { contains: q, mode: 'insensitive' } },
              { company: { legalName: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
      ...(query.regionId
        ? {
            scopes: {
              some: {
                OR: [
                  { regionId: query.regionId },
                  { localTerritory: { regionId: query.regionId } },
                ],
              },
            },
          }
        : {}),
    };

    const [total, admins] = await Promise.all([
      this.prisma.adminUser.count({ where }),
      this.prisma.adminUser.findMany({
        where,
        include: {
          company: { select: { id: true, legalName: true } },
          scopes: {
            include: {
              region: { select: { id: true, code: true, name: true } },
              localTerritory: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  regionId: true,
                  region: { select: { id: true, code: true, name: true } },
                },
              },
            },
          },
        },
        orderBy: [{ role: 'asc' }, { name: 'asc' }, { email: 'asc' }],
        skip,
        take: pageSize,
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    // BoB median across full filtered set (not only current page)
    const allFilteredIds = await this.prisma.adminUser.findMany({
      where,
      select: { id: true, status: true },
      take: 2000,
    });
    const medianIdList = allFilteredIds.map((a) => a.id);
    const medianReferred = medianIdList.length
      ? await this.prisma.company.groupBy({
          by: ['referredByAdminUserId', 'status'],
          where: {
            referredByAdminUserId: { in: medianIdList },
            type: { in: [CompanyType.SENDER, CompanyType.CARRIER] },
          },
          _count: { _all: true },
        })
      : [];
    const medianActiveByAdmin = new Map<string, number>();
    for (const id of medianIdList) medianActiveByAdmin.set(id, 0);
    for (const row of medianReferred) {
      const id = row.referredByAdminUserId;
      if (!id) continue;
      if (
        row.status !== CompanyStatus.SUSPENDED &&
        row.status !== CompanyStatus.REJECTED
      ) {
        medianActiveByAdmin.set(
          id,
          (medianActiveByAdmin.get(id) ?? 0) + row._count._all,
        );
      }
    }
    const medianActives = allFilteredIds
      .filter((a) => a.status === AdminUserStatus.ACTIVE)
      .map((a) => medianActiveByAdmin.get(a.id) ?? 0)
      .sort((a, b) => a - b);
    const median =
      medianActives.length === 0
        ? 0
        : medianActives.length % 2 === 1
          ? medianActives[(medianActives.length - 1) / 2]!
          : (medianActives[medianActives.length / 2 - 1]! +
              medianActives[medianActives.length / 2]!) /
            2;

    const adminIds = admins.map((a) => a.id);
    const referred = adminIds.length
      ? await this.prisma.company.groupBy({
          by: ['referredByAdminUserId', 'type', 'status'],
          where: {
            referredByAdminUserId: { in: adminIds },
            type: { in: [CompanyType.SENDER, CompanyType.CARRIER] },
          },
          _count: { _all: true },
        })
      : [];

    const bobByAdmin = new Map<
      string,
      { sendersReferred: number; carriersReferred: number; activeCompanies: number }
    >();
    for (const id of adminIds) {
      bobByAdmin.set(id, { sendersReferred: 0, carriersReferred: 0, activeCompanies: 0 });
    }
    for (const row of referred) {
      const id = row.referredByAdminUserId;
      if (!id) continue;
      const bucket = bobByAdmin.get(id);
      if (!bucket) continue;
      if (row.type === CompanyType.SENDER) bucket.sendersReferred += row._count._all;
      if (row.type === CompanyType.CARRIER) bucket.carriersReferred += row._count._all;
      if (
        row.status !== CompanyStatus.SUSPENDED &&
        row.status !== CompanyStatus.REJECTED
      ) {
        bucket.activeCompanies += row._count._all;
      }
    }

    const territoryIds = new Set<string>();
    const regionIds = new Set<string>();
    for (const admin of admins) {
      for (const scope of admin.scopes) {
        if (scope.scopeType === AdminScopeType.LOCAL && scope.localTerritoryId) {
          territoryIds.add(scope.localTerritoryId);
        }
        if (scope.scopeType === AdminScopeType.STATE && scope.regionId) {
          regionIds.add(scope.regionId);
        }
      }
    }

    const peerCounts = new Map<string, number>();
    if (territoryIds.size > 0) {
      const peerRows = await this.prisma.adminScope.groupBy({
        by: ['localTerritoryId'],
        where: {
          scopeType: AdminScopeType.LOCAL,
          localTerritoryId: { in: [...territoryIds] },
          adminUser: {
            role: AdminRole.LOCAL_BDE,
            status: AdminUserStatus.ACTIVE,
            active: true,
          },
        },
        _count: { _all: true },
      });
      for (const p of peerRows) {
        if (p.localTerritoryId) peerCounts.set(p.localTerritoryId, p._count._all);
      }
    }

    const packages = adminIds.length
      ? await this.prisma.adminRevenueSplitPackage.findMany({
          where: {
            adminUserId: { in: adminIds },
            publishedAt: { not: null, lte: now },
            effectiveFrom: { lte: now },
          },
          orderBy: [{ effectiveFrom: 'desc' }, { publishedAt: 'desc' }],
        })
      : [];

    const latestPackageFor = (adminUserId: string) =>
      packages.find((p) => p.adminUserId === adminUserId) ?? null;

    const seatStatsCache = new Map<
      string,
      { jobs90d: number; grossIncGstCents90d: number; accruedAdminCents90d: number }
    >();

    const loadTerritoryStats = async (territoryId: string) => {
      const key = `T:${territoryId}`;
      if (seatStatsCache.has(key)) return seatStatsCache.get(key)!;
      const jobs = await this.prisma.job.findMany({
        where: {
          originTerritoryId: territoryId,
          createdAt: { gte: windowStart },
        },
        select: { id: true },
      });
      const jobIds = jobs.map((j) => j.id);
      const gross = jobIds.length
        ? await this.prisma.paymentEvent.aggregate({
            where: {
              jobId: { in: jobIds },
              type: PaymentEventType.CHARGE,
              status: PaymentEventStatus.SUCCEEDED,
            },
            _sum: { amountIncGstCents: true },
          })
        : { _sum: { amountIncGstCents: null } };
      const accrued = jobIds.length
        ? await this.prisma.settlementLine.aggregate({
            where: {
              jobId: { in: jobIds },
              status: { not: SettlementLineStatus.VOID },
              recipientType: {
                in: [SettlementRecipientType.LOCAL_BDE, SettlementRecipientType.HQ_HOLDING],
              },
              territoryId,
              createdAt: { gte: windowStart },
            },
            _sum: { amountCents: true },
          })
        : { _sum: { amountCents: null } };
      const stats = {
        jobs90d: jobs.length,
        grossIncGstCents90d: gross._sum.amountIncGstCents ?? 0,
        accruedAdminCents90d: accrued._sum.amountCents ?? 0,
      };
      seatStatsCache.set(key, stats);
      return stats;
    };

    const loadRegionStats = async (regionId: string) => {
      const key = `R:${regionId}`;
      if (seatStatsCache.has(key)) return seatStatsCache.get(key)!;
      const jobs = await this.prisma.job.findMany({
        where: {
          originRegionId: regionId,
          createdAt: { gte: windowStart },
        },
        select: { id: true },
      });
      const jobIds = jobs.map((j) => j.id);
      const gross = jobIds.length
        ? await this.prisma.paymentEvent.aggregate({
            where: {
              jobId: { in: jobIds },
              type: PaymentEventType.CHARGE,
              status: PaymentEventStatus.SUCCEEDED,
            },
            _sum: { amountIncGstCents: true },
          })
        : { _sum: { amountIncGstCents: null } };
      const accrued = jobIds.length
        ? await this.prisma.settlementLine.aggregate({
            where: {
              jobId: { in: jobIds },
              status: { not: SettlementLineStatus.VOID },
              recipientType: {
                in: [SettlementRecipientType.STATE_MASTER, SettlementRecipientType.HQ_HOLDING],
              },
              regionId,
              createdAt: { gte: windowStart },
            },
            _sum: { amountCents: true },
          })
        : { _sum: { amountCents: null } };
      const stats = {
        jobs90d: jobs.length,
        grossIncGstCents90d: gross._sum.amountIncGstCents ?? 0,
        accruedAdminCents90d: accrued._sum.amountCents ?? 0,
      };
      seatStatsCache.set(key, stats);
      return stats;
    };

    type Row = {
      id: string;
      email: string;
      name: string | null;
      /** Partner company legal name — same label source as Admin partners list. */
      companyLegalName: string | null;
      role: AdminRole;
      status: AdminUserStatus;
      scopes: Array<{
        scopeType: string;
        regionId: string | null;
        regionCode: string | null;
        territoryId: string | null;
        territoryCode: string | null;
      }>;
      primaryScope: {
        scopeType: 'REGION' | 'TERRITORY';
        scopeId: string;
        label: string;
      } | null;
      bob: { sendersReferred: number; carriersReferred: number; activeCompanies: number };
      seat: {
        jobs90d: number;
        grossIncGstCents90d: number;
        accruedAdminCents90d: number;
        peersOnSameTerritory: number;
      };
      split: {
        national: RevenueSplitPercents;
        package: {
          id: string;
          superPercent: number;
          statePercent: number;
          localPercent: number;
          effectiveFrom: string;
        } | null;
        effectiveSuperPercent: number;
        effectiveLocalPercent: number;
        effectiveStatePercent: number;
      };
      hint: 'above_median_bob' | 'below_median_bob' | 'near_default';
    };

    const rows: Row[] = [];
    for (const admin of admins) {
      const scopes = admin.scopes.map((s) => ({
        scopeType: s.scopeType,
        regionId: s.regionId,
        regionCode: s.region?.code ?? s.localTerritory?.region?.code ?? null,
        territoryId: s.localTerritoryId,
        territoryCode: s.localTerritory?.code ?? null,
      }));

      let primaryScope: Row['primaryScope'] = null;
      let seat = {
        jobs90d: 0,
        grossIncGstCents90d: 0,
        accruedAdminCents90d: 0,
        peersOnSameTerritory: 0,
      };

      if (admin.role === AdminRole.LOCAL_BDE) {
        const localScope = admin.scopes.find(
          (s) => s.scopeType === AdminScopeType.LOCAL && s.localTerritoryId,
        );
        if (localScope?.localTerritoryId && localScope.localTerritory) {
          primaryScope = {
            scopeType: 'TERRITORY',
            scopeId: localScope.localTerritoryId,
            label: `${localScope.localTerritory.region.code}/${localScope.localTerritory.code}`,
          };
          const stats = await loadTerritoryStats(localScope.localTerritoryId);
          seat = {
            ...stats,
            peersOnSameTerritory: peerCounts.get(localScope.localTerritoryId) ?? 1,
          };
        }
      } else if (admin.role === AdminRole.STATE_MASTER) {
        const stateScope = admin.scopes.find(
          (s) => s.scopeType === AdminScopeType.STATE && s.regionId,
        );
        if (stateScope?.regionId && stateScope.region) {
          primaryScope = {
            scopeType: 'REGION',
            scopeId: stateScope.regionId,
            label: stateScope.region.code,
          };
          const stats = await loadRegionStats(stateScope.regionId);
          seat = { ...stats, peersOnSameTerritory: 0 };
        }
      }

      const packageRow = latestPackageFor(admin.id);

      rows.push({
        id: admin.id,
        email: admin.email,
        name: admin.name,
        companyLegalName: admin.company?.legalName ?? null,
        role: admin.role,
        status: admin.status,
        scopes,
        primaryScope,
        bob: bobByAdmin.get(admin.id) ?? {
          sendersReferred: 0,
          carriersReferred: 0,
          activeCompanies: 0,
        },
        seat,
        split: {
          national: national.percents,
          package: packageRow
            ? {
                id: packageRow.id,
                superPercent: packageRow.superPercent,
                statePercent: packageRow.statePercent,
                localPercent: packageRow.localPercent,
                effectiveFrom: packageRow.effectiveFrom.toISOString(),
              }
            : null,
          effectiveSuperPercent:
            packageRow?.superPercent ?? national.percents.superPercent,
          effectiveLocalPercent:
            packageRow?.localPercent ?? national.percents.localPercent,
          effectiveStatePercent:
            packageRow?.statePercent ?? national.percents.statePercent,
        },
        hint: 'near_default',
      });
    }

    for (const row of rows) {
      if (
        row.bob.activeCompanies > median &&
        median >= 0 &&
        medianActives.length > 1
      ) {
        row.hint = 'above_median_bob';
      } else if (row.bob.activeCompanies < median && medianActives.length > 1) {
        row.hint = 'below_median_bob';
      } else {
        row.hint = 'near_default';
      }
    }

    return {
      windowDays: 90,
      windowStart: windowStart.toISOString(),
      national: national.percents,
      bobMedianActiveCompanies: median,
      page,
      pageSize,
      total,
      totalPages,
      items: rows,
    };
  }
}
