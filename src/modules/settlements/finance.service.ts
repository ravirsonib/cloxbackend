import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PLATFORM_TIMEZONE } from '../../shared/timezone';
import {
  AdminRole,
  CompanyType,
  PaymentEventStatus,
  PaymentEventType,
  SettlementLineStatus,
  SettlementRecipientType,
  SurchargeKind,
  SurchargeStatus,
  TripStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RevenueSplitService } from './revenue-split.service';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AppRole, type FinanceQuery } from '../../shared/types';

function parseDateRange(query: FinanceQuery): { startDate?: Date; endDate: Date } {
  const now = new Date();
  const endDate = query.to ? new Date(query.to) : now;
  if (query.from) {
    return { startDate: new Date(query.from), endDate };
  }
  switch (query.period) {
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { startDate: start, endDate };
    }
    case 'week': {
      const start = new Date(now.getTime() - 7 * 86400000);
      return { startDate: start, endDate };
    }
    case 'month':
    case '30d': {
      const start = new Date(now.getTime() - 30 * 86400000);
      return { startDate: start, endDate };
    }
    case 'quarter': {
      const start = new Date(now.getTime() - 90 * 86400000);
      return { startDate: start, endDate };
    }
    case 'year': {
      const start = new Date(now.getTime() - 365 * 86400000);
      return { startDate: start, endDate };
    }
    case 'all':
      return { endDate };
    default: {
      const start = new Date(now.getTime() - 30 * 86400000);
      return { startDate: start, endDate };
    }
  }
}

@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly revenueSplit?: RevenueSplitService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  private async getCarrierClearingDays(): Promise<number> {
    if (this.prisma?.isConnected()) {
      try {
        const settings = await this.prisma.platformSettings.findUnique({
          where: { id: 'default' },
          select: { carrierClearingDays: true },
        });
        if (settings?.carrierClearingDays != null) {
          return settings.carrierClearingDays;
        }
      } catch {
        // Fallback to env or default
      }
    }
    return this.config?.get<number>('STRIPE_CARRIER_CLEARING_DAYS') ?? 7;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1. SUPER-ADMIN GLOBAL FINANCIAL OVERVIEW
  // ───────────────────────────────────────────────────────────────────────────

  async getSuperFinanceOverview(actor: AuthenticatedPrincipal, query: FinanceQuery) {
    this.ensureDatabase();
    if (actor.kind !== 'admin' || actor.role !== AdminRole.SUPER_ADMIN) {
      throw new ForbiddenException('Super Admin required');
    }

    const { startDate, endDate } = parseDateRange(query);
    const dateFilter = startDate ? { gte: startDate, lte: endDate } : { lte: endDate };

    const [
      settlementLines,
      surcharges,
      paymentEvents,
      jobs,
      regions,
      companies,
    ] = await Promise.all([
      // 1. Settlement Lines
      this.prisma.settlementLine.findMany({
        where: {
          createdAt: dateFilter,
          status: { not: SettlementLineStatus.VOID },
        },
        include: {
          job: {
            select: {
              id: true,
              title: true,
              status: true,
              senderCompanyId: true,
              assignment: { select: { carrierCompanyId: true } },
            },
          },
        },
      }),

      // 2. Surcharges
      this.prisma.surcharge.findMany({
        where: {
          createdAt: dateFilter,
        },
        select: {
          id: true,
          kind: true,
          status: true,
          amountIncGstCents: true,
          amountExGstCents: true,
          paidAt: true,
          waivedAt: true,
          jobId: true,
        },
      }),

      // 3. Payment Events (Stripe cashflow)
      this.prisma.paymentEvent.findMany({
        where: {
          createdAt: dateFilter,
        },
        select: {
          id: true,
          type: true,
          status: true,
          amountIncGstCents: true,
          stripePaymentIntentId: true,
          stripeTransferId: true,
        },
      }),

      // 4. Jobs in period
      this.prisma.job.findMany({
        where: {
          createdAt: dateFilter,
        },
        select: {
          id: true,
          title: true,
          status: true,
          estimateIncGstCents: true,
          originRegionId: true,
          originTerritoryId: true,
          senderCompanyId: true,
          createdAt: true,
          assignment: { select: { carrierCompanyId: true, status: true } },
          trip: { select: { status: true, completedAt: true } },
        },
      }),

      // 5. Regions
      this.prisma.region.findMany({
        include: { territories: true },
      }),

      // 6. Companies
      this.prisma.company.findMany({
        select: {
          id: true,
          legalName: true,
          tradingName: true,
          email: true,
          type: true,
        },
      }),
    ]);

    const companyMap = new Map(
      companies.map((c) => [c.id, c.tradingName || c.legalName]),
    );

    // ─── Calculate Summary Totals ───
    let gmvCents = 0;
    for (const j of jobs) {
      if (j.estimateIncGstCents) gmvCents += j.estimateIncGstCents;
    }

    let hqShareCents = 0;
    let hqHoldingCents = 0;
    let carrierPayoutsCents = 0;
    let carrierPaidCents = 0;
    let carrierPendingCents = 0;
    let stateCommissionsCents = 0;
    let localCommissionsCents = 0;

    for (const line of settlementLines) {
      if (line.recipientType === SettlementRecipientType.SUPER_ADMIN) {
        hqShareCents += line.amountCents;
      } else if (line.recipientType === SettlementRecipientType.HQ_HOLDING) {
        hqHoldingCents += line.amountCents;
      } else if (line.recipientType === SettlementRecipientType.CARRIER) {
        carrierPayoutsCents += line.amountCents;
        if (line.status === SettlementLineStatus.PAID) {
          carrierPaidCents += line.amountCents;
        } else {
          carrierPendingCents += line.amountCents;
        }
      } else if (line.recipientType === SettlementRecipientType.STATE_MASTER) {
        stateCommissionsCents += line.amountCents;
      } else if (line.recipientType === SettlementRecipientType.LOCAL_BDE) {
        localCommissionsCents += line.amountCents;
      }
    }

    const platformRevenueCents = hqShareCents + hqHoldingCents;
    const partnerCommissionsCents = stateCommissionsCents + localCommissionsCents;
    const netMarginPercent =
      gmvCents > 0 ? Number(((platformRevenueCents / gmvCents) * 100).toFixed(1)) : 15.0;

    // ─── Cashflow Pipeline from PaymentEvents ───
    let escrowCents = 0;
    let clearingCents = 0;
    let disbursedCents = 0;
    let refundedCents = 0;

    for (const pe of paymentEvents) {
      if (pe.type === PaymentEventType.CHARGE && pe.status === PaymentEventStatus.SUCCEEDED) {
        escrowCents += pe.amountIncGstCents;
      } else if (pe.type === PaymentEventType.TRANSFER && pe.status === PaymentEventStatus.SUCCEEDED) {
        disbursedCents += pe.amountIncGstCents;
      } else if (pe.type === PaymentEventType.REFUND && pe.status === PaymentEventStatus.SUCCEEDED) {
        refundedCents += pe.amountIncGstCents;
      }
    }
    clearingCents = carrierPendingCents;

    // ─── Surcharges Intelligence ───
    let totalSurchargesCents = 0;
    let paidSurchargesCents = 0;
    let pendingSurchargesCents = 0;
    let waivedSurchargesCents = 0;
    let paidSurchargesCount = 0;
    let pendingSurchargesCount = 0;
    let waivedSurchargesCount = 0;

    const byKind = {
      mass: { count: 0, amountCents: 0, paidCents: 0 },
      waiting: { count: 0, amountCents: 0, paidCents: 0 },
    };

    for (const s of surcharges) {
      totalSurchargesCents += s.amountIncGstCents;
      const isMass = s.kind === SurchargeKind.MASS;
      const kindKey = isMass ? 'mass' : 'waiting';

      byKind[kindKey].count++;
      byKind[kindKey].amountCents += s.amountIncGstCents;

      if (s.status === SurchargeStatus.PAID) {
        paidSurchargesCents += s.amountIncGstCents;
        paidSurchargesCount++;
        byKind[kindKey].paidCents += s.amountIncGstCents;
      } else if (s.status === SurchargeStatus.PENDING_PAYMENT) {
        pendingSurchargesCents += s.amountIncGstCents;
        pendingSurchargesCount++;
      } else if (s.status === SurchargeStatus.WAIVED) {
        waivedSurchargesCents += s.amountIncGstCents;
        waivedSurchargesCount++;
      }
    }

    // ─── Company Leaderboard / Performance ───
    const senderSpendMap = new Map<string, { spendCents: number; jobsCount: number; surchargesCents: number }>();
    const carrierEarnMap = new Map<string, { earningsCents: number; paidCents: number; clearingCents: number; tripsCount: number }>();

    for (const j of jobs) {
      if (j.senderCompanyId) {
        const entry = senderSpendMap.get(j.senderCompanyId) || { spendCents: 0, jobsCount: 0, surchargesCents: 0 };
        entry.jobsCount++;
        entry.spendCents += j.estimateIncGstCents || 0;
        senderSpendMap.set(j.senderCompanyId, entry);
      }
      if (j.assignment?.carrierCompanyId && j.trip?.status === TripStatus.COMPLETED) {
        const cEntry = carrierEarnMap.get(j.assignment.carrierCompanyId) || {
          earningsCents: 0,
          paidCents: 0,
          clearingCents: 0,
          tripsCount: 0,
        };
        cEntry.tripsCount++;
        carrierEarnMap.set(j.assignment.carrierCompanyId, cEntry);
      }
    }

    for (const line of settlementLines) {
      if (line.recipientType === SettlementRecipientType.CARRIER && line.job?.assignment?.carrierCompanyId) {
        const cId = line.job.assignment.carrierCompanyId;
        const cEntry = carrierEarnMap.get(cId) || {
          earningsCents: 0,
          paidCents: 0,
          clearingCents: 0,
          tripsCount: 0,
        };
        cEntry.earningsCents += line.amountCents;
        if (line.status === SettlementLineStatus.PAID) {
          cEntry.paidCents += line.amountCents;
        } else {
          cEntry.clearingCents += line.amountCents;
        }
        carrierEarnMap.set(cId, cEntry);
      }
    }

    const topSenders = Array.from(senderSpendMap.entries())
      .map(([id, stats]) => ({
        id,
        name: companyMap.get(id) || 'Sender',
        spendCents: stats.spendCents,
        jobsCount: stats.jobsCount,
        surchargesCents: stats.surchargesCents,
      }))
      .sort((a, b) => b.spendCents - a.spendCents)
      .slice(0, 10);

    const topCarriers = Array.from(carrierEarnMap.entries())
      .map(([id, stats]) => ({
        id,
        name: companyMap.get(id) || 'Carrier',
        tripsCount: stats.tripsCount,
        earningsCents: stats.earningsCents,
        paidCents: stats.paidCents,
        clearingCents: stats.clearingCents,
      }))
      .sort((a, b) => b.earningsCents - a.earningsCents)
      .slice(0, 10);

    // ─── State / Regional Breakdown ───
    const regionStatsMap = new Map<string, { gmvCents: number; platformRevenueCents: number; stateShareCents: number; localShareCents: number; jobsCount: number }>();
    for (const r of regions) {
      regionStatsMap.set(r.id, {
        gmvCents: 0,
        platformRevenueCents: 0,
        stateShareCents: 0,
        localShareCents: 0,
        jobsCount: 0,
      });
    }

    for (const j of jobs) {
      if (j.originRegionId && regionStatsMap.has(j.originRegionId)) {
        const rStats = regionStatsMap.get(j.originRegionId)!;
        rStats.jobsCount++;
        rStats.gmvCents += j.estimateIncGstCents || 0;
      }
    }

    for (const line of settlementLines) {
      if (line.regionId && regionStatsMap.has(line.regionId)) {
        const rStats = regionStatsMap.get(line.regionId)!;
        if (line.recipientType === SettlementRecipientType.SUPER_ADMIN || line.recipientType === SettlementRecipientType.HQ_HOLDING) {
          rStats.platformRevenueCents += line.amountCents;
        } else if (line.recipientType === SettlementRecipientType.STATE_MASTER) {
          rStats.stateShareCents += line.amountCents;
        } else if (line.recipientType === SettlementRecipientType.LOCAL_BDE) {
          rStats.localShareCents += line.amountCents;
        }
      }
    }

    const regionalBreakdown = regions.map((r) => {
      const stats = regionStatsMap.get(r.id) || {
        gmvCents: 0,
        platformRevenueCents: 0,
        stateShareCents: 0,
        localShareCents: 0,
        jobsCount: 0,
      };
      return {
        regionCode: r.code,
        regionName: r.name,
        gmvCents: stats.gmvCents,
        platformRevenueCents: stats.platformRevenueCents,
        stateShareCents: stats.stateShareCents,
        localShareCents: stats.localShareCents,
        jobsCount: stats.jobsCount,
      };
    });

    // ─── Timeline Series Generation ───
    const effectiveStart = startDate ?? new Date(endDate.getTime() - 30 * 86400000);
    const totalMs = Math.max(86400000, endDate.getTime() - effectiveStart.getTime());
    const bucketCount = query.period === 'today' ? 6 : query.period === 'week' ? 7 : 8;
    const bucketDurationMs = totalMs / bucketCount;

    const timeline = Array.from({ length: bucketCount }, (_, idx) => {
      const bStart = new Date(effectiveStart.getTime() + idx * bucketDurationMs);
      const bEnd = new Date(effectiveStart.getTime() + (idx + 1) * bucketDurationMs);

      const label =
        query.period === 'today'
          ? `${bStart.getHours()}:00`
          : query.period === 'week'
          ? bStart.toLocaleDateString('en-AU', { timeZone: PLATFORM_TIMEZONE, weekday: 'short' })
          : bStart.toLocaleDateString('en-AU', { timeZone: PLATFORM_TIMEZONE, month: 'short', day: 'numeric' });

      let bGmv = 0;
      for (const j of jobs) {
        if (j.createdAt >= bStart && j.createdAt < bEnd) {
          bGmv += j.estimateIncGstCents || 0;
        }
      }

      let bPlatform = 0;
      let bCarrier = 0;
      let bPartner = 0;
      for (const l of settlementLines) {
        if (l.createdAt >= bStart && l.createdAt < bEnd) {
          if (l.recipientType === SettlementRecipientType.SUPER_ADMIN || l.recipientType === SettlementRecipientType.HQ_HOLDING) {
            bPlatform += l.amountCents;
          } else if (l.recipientType === SettlementRecipientType.CARRIER) {
            bCarrier += l.amountCents;
          } else if (l.recipientType === SettlementRecipientType.STATE_MASTER || l.recipientType === SettlementRecipientType.LOCAL_BDE) {
            bPartner += l.amountCents;
          }
        }
      }

      return {
        date: bStart.toISOString(),
        label,
        gmvCents: bGmv,
        platformRevenueCents: bPlatform,
        carrierPayoutsCents: bCarrier,
        partnerCommissionsCents: bPartner,
      };
    });

    return {
      summary: {
        gmvCents,
        platformRevenueCents,
        hqShareCents,
        hqHoldingCents,
        carrierPayoutsCents,
        carrierPaidCents,
        carrierPendingCents,
        partnerCommissionsCents,
        stateCommissionsCents,
        localCommissionsCents,
        netMarginPercent,
        activeJobsCount: jobs.filter((j) => j.status !== 'COMPLETED' && j.status !== 'CANCELLED').length,
        completedJobsCount: jobs.filter((j) => j.status === 'COMPLETED').length,
      },
      surcharges: {
        totalCount: surcharges.length,
        totalAmountCents: totalSurchargesCents,
        paidCount: paidSurchargesCount,
        paidAmountCents: paidSurchargesCents,
        pendingCount: pendingSurchargesCount,
        pendingAmountCents: pendingSurchargesCents,
        waivedCount: waivedSurchargesCount,
        waivedAmountCents: waivedSurchargesCents,
        byKind,
      },
      cashflowPipeline: {
        escrowCents,
        clearingCents,
        disbursedCents,
        refundedCents,
      },
      companies: {
        topSenders,
        topCarriers,
      },
      regionalBreakdown,
      timeline,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2. PARTNER ADMIN (STATE MASTER & LOCAL BDE) REVENUE & COMMISSION OVERVIEW
  // ───────────────────────────────────────────────────────────────────────────

  async getPartnerFinance(actor: AuthenticatedPrincipal, query: FinanceQuery) {
    this.ensureDatabase();
    if (actor.kind !== 'admin') {
      throw new ForbiddenException('Admin user required');
    }
    const isState = actor.role === AdminRole.STATE_MASTER;
    const isLocal = actor.role === AdminRole.LOCAL_BDE;
    if (!isState && !isLocal && actor.role !== AdminRole.SUPER_ADMIN) {
      throw new ForbiddenException('Partner admin role required');
    }

    const { startDate, endDate } = parseDateRange(query);
    const dateFilter = startDate ? { gte: startDate, lte: endDate } : { lte: endDate };

    // Get admin scopes
    const adminUser = await this.prisma.adminUser.findUnique({
      where: { id: actor.id },
      include: {
        scopes: { include: { region: true, localTerritory: true } },
      },
    });
    if (!adminUser) throw new NotFoundException('Admin user not found');

    const regionIds = adminUser.scopes.map((s) => s.regionId).filter((id): id is string => Boolean(id));
    const territoryIds = adminUser.scopes.map((s) => s.localTerritoryId).filter((id): id is string => Boolean(id));

    // Lines attributed to this admin user specifically or to their scoped region/territory
    const lines = await this.prisma.settlementLine.findMany({
      where: {
        createdAt: dateFilter,
        status: { not: SettlementLineStatus.VOID },
        OR: [
          { adminUserId: actor.id },
          ...(isState && regionIds.length ? [{ regionId: { in: regionIds }, recipientType: SettlementRecipientType.STATE_MASTER }] : []),
          ...(isLocal && territoryIds.length ? [{ territoryId: { in: territoryIds }, recipientType: SettlementRecipientType.LOCAL_BDE }] : []),
        ],
      },
      include: {
        job: { select: { id: true, title: true, status: true, estimateIncGstCents: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    let attributedGmvCents = 0;
    let grossCommissionCents = 0;
    let accruedCents = 0;
    let settledCents = 0;

    for (const l of lines) {
      grossCommissionCents += l.amountCents;
      if (l.job?.estimateIncGstCents) attributedGmvCents += l.job.estimateIncGstCents;
      if (l.status === SettlementLineStatus.PAID) {
        settledCents += l.amountCents;
      } else {
        accruedCents += l.amountCents;
      }
    }

    // Book of business referrals
    const referredCompanies = await this.prisma.company.findMany({
      where: { referredByAdminUserId: actor.id },
      select: { id: true, type: true },
    });

    const sendersCount = referredCompanies.filter((c) => c.type === CompanyType.SENDER).length;
    const carriersCount = referredCompanies.filter((c) => c.type === CompanyType.CARRIER).length;

    const scopeLabel = adminUser.scopes
      .map((s) => s.localTerritory?.code || s.region?.code)
      .filter(Boolean)
      .join(', ') || 'Assigned Scope';

    return {
      role: isState ? 'STATE_MASTER' : 'LOCAL_BDE',
      adminName: adminUser.name || 'Admin',
      adminEmail: adminUser.email,
      scopeLabel,
      summary: {
        attributedGmvCents,
        grossCommissionCents,
        accruedCents,
        settledCents,
        activeJobsCount: lines.filter((l) => l.job?.status !== 'COMPLETED' && l.job?.status !== 'CANCELLED').length,
        completedJobsCount: lines.filter((l) => l.job?.status === 'COMPLETED').length,
      },
      bookOfBusiness: {
        sendersCount,
        carriersCount,
        referredSpendCents: 0,
      },
      recentSettlements: lines.map((l) => ({
        id: l.id,
        jobId: l.jobId,
        jobTitle: l.job?.title || 'Shipment',
        amountCents: l.amountCents,
        sharePercent: l.sharePercent || (isState ? 10 : 5),
        status: l.status,
        createdAt: l.createdAt.toISOString(),
        paidAt: l.paidAt ? l.paidAt.toISOString() : null,
      })),
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 3. CARRIER EARNINGS & CLEARING PIPELINE
  // ───────────────────────────────────────────────────────────────────────────

  async getCarrierFinance(actor: AuthenticatedPrincipal, query: FinanceQuery) {
    this.ensureDatabase();
    const user = await this.prisma.user.findUnique({
      where: { id: actor.id },
      include: {
        company: {
          select: {
            id: true,
            legalName: true,
            tradingName: true,
            stripeConnectAccountId: true,
            stripeConnectPayoutsEnabled: true,
          },
        },
      },
    });

    const companyId = user?.companyId || query.companyId;
    if (!companyId) {
      throw new BadRequestException('Carrier company could not be resolved');
    }

    const { startDate, endDate } = parseDateRange(query);
    const dateFilter = startDate ? { gte: startDate, lte: endDate } : { lte: endDate };

    // Fetch carrier assignments and settlement lines
    const [assignments, settlementLines, transfers] = await Promise.all([
      this.prisma.assignment.findMany({
        where: {
          carrierCompanyId: companyId,
          createdAt: dateFilter,
        },
        include: {
          job: {
            select: {
              id: true,
              title: true,
              estimateIncGstCents: true,
              status: true,
            },
          },
          trip: {
            select: {
              id: true,
              status: true,
              completedAt: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),

      this.prisma.settlementLine.findMany({
        where: {
          recipientType: SettlementRecipientType.CARRIER,
          createdAt: dateFilter,
          job: {
            assignment: { carrierCompanyId: companyId },
          },
        },
        include: {
          job: { select: { id: true, title: true } },
        },
      }),

      this.prisma.paymentEvent.findMany({
        where: {
          type: PaymentEventType.TRANSFER,
          createdAt: dateFilter,
          metadata: {
            path: ['companyId'],
            equals: companyId,
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    let totalEarnedCents = 0;
    let clearingCents = 0;
    let paidOutCents = 0;

    for (const l of settlementLines) {
      totalEarnedCents += l.amountCents;
      if (l.status === SettlementLineStatus.PAID) {
        paidOutCents += l.amountCents;
      } else {
        clearingCents += l.amountCents;
      }
    }

    const completedTripsCount = assignments.filter((a) => a.trip?.status === TripStatus.COMPLETED).length;
    const activeTripsCount = assignments.filter((a) => a.trip && a.trip.status !== TripStatus.COMPLETED && a.trip.status !== TripStatus.CANCELLED).length;

    const clearingDays = await this.getCarrierClearingDays();
    const revenueSettings = this.revenueSplit ? await this.revenueSplit.getSettings() : null;
    const carrierPercent = revenueSettings?.effective.percents.carrierPercent ?? 70;

    const tripLedger = assignments.map((a) => {
      const gross = a.job.estimateIncGstCents || 0;
      const net = Math.round((gross * carrierPercent) / 100);
      const isPaid = a.trip?.status === TripStatus.COMPLETED;
      return {
        tripId: a.trip?.id || a.id,
        jobId: a.job.id,
        jobTitle: a.job.title || 'Shipment',
        completedAt: a.trip?.completedAt ? a.trip.completedAt.toISOString() : null,
        grossFareCents: gross,
        carrierNetCents: net,
        surchargesCents: 0,
        status: isPaid ? ('PAID' as const) : ('ACCRUED' as const),
      };
    });

    return {
      companyName: user?.company?.tradingName || user?.company?.legalName || 'Carrier',
      payoutsEnabled: Boolean(user?.company?.stripeConnectPayoutsEnabled),
      carrierPercent,
      clearingDays,
      summary: {
        totalEarnedCents,
        clearingCents,
        paidOutCents,
        inProgressCents: activeTripsCount * 50000,
        surchargesEarnedCents: 0,
        completedTripsCount,
        activeTripsCount,
      },
      recentTransfers: transfers.map((t) => ({
        id: t.id,
        amountCents: t.amountIncGstCents,
        status: t.status,
        stripeTransferId: t.stripeTransferId,
        createdAt: t.createdAt.toISOString(),
      })),
      tripLedger,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 4. SENDER FREIGHT SPEND & INVOICES
  // ───────────────────────────────────────────────────────────────────────────

  async getSenderFinance(actor: AuthenticatedPrincipal, query: FinanceQuery) {
    this.ensureDatabase();
    const user = await this.prisma.user.findUnique({
      where: { id: actor.id },
      include: {
        company: {
          select: {
            id: true,
            legalName: true,
            tradingName: true,
          },
        },
      },
    });

    const companyId = user?.companyId || query.companyId;
    if (!companyId) {
      throw new BadRequestException('Sender company could not be resolved');
    }

    const { startDate, endDate } = parseDateRange(query);
    const dateFilter = startDate ? { gte: startDate, lte: endDate } : { lte: endDate };

    const [jobs, surcharges] = await Promise.all([
      this.prisma.job.findMany({
        where: {
          senderCompanyId: companyId,
          createdAt: dateFilter,
        },
        include: {
          paymentEvents: {
            where: { type: PaymentEventType.CHARGE },
            select: { id: true, status: true, amountIncGstCents: true, stripePaymentIntentId: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),

      this.prisma.surcharge.findMany({
        where: {
          job: { senderCompanyId: companyId },
          createdAt: dateFilter,
        },
      }),
    ]);

    let totalSpendIncGstCents = 0;
    let surchargesSpendCents = 0;
    let inEscrowCents = 0;

    for (const j of jobs) {
      const inc = j.estimateIncGstCents || 0;
      totalSpendIncGstCents += inc;
      if (j.status !== 'COMPLETED' && j.status !== 'CANCELLED') {
        inEscrowCents += inc;
      }
    }

    let massCents = 0;
    let waitingCents = 0;
    let pendingSurchargesCents = 0;

    for (const s of surcharges) {
      if (s.status === SurchargeStatus.PAID) {
        surchargesSpendCents += s.amountIncGstCents;
        if (s.kind === SurchargeKind.MASS) massCents += s.amountIncGstCents;
        else waitingCents += s.amountIncGstCents;
      } else if (s.status === SurchargeStatus.PENDING_PAYMENT) {
        pendingSurchargesCents += s.amountIncGstCents;
      }
    }

    const totalSpendExGstCents = Math.round(totalSpendIncGstCents / 1.1);
    const totalGstCents = totalSpendIncGstCents - totalSpendExGstCents;

    const jobSpendHistory = jobs.map((j) => {
      const charge = j.paymentEvents[0];
      return {
        jobId: j.id,
        jobTitle: j.title || 'Shipment',
        createdAt: j.createdAt.toISOString(),
        status: j.status,
        baseFareIncGstCents: j.estimateIncGstCents || 0,
        surchargesIncGstCents: 0,
        totalPaidCents: charge?.amountIncGstCents || j.estimateIncGstCents || 0,
        paymentStatus: charge?.status || 'PENDING',
      };
    });

    return {
      companyName: user?.company?.tradingName || user?.company?.legalName || 'Sender',
      summary: {
        totalSpendIncGstCents,
        totalSpendExGstCents,
        totalGstCents,
        surchargesSpendCents,
        inEscrowCents,
        completedJobsCount: jobs.filter((j) => j.status === 'COMPLETED').length,
        activeJobsCount: jobs.filter((j) => j.status !== 'COMPLETED' && j.status !== 'CANCELLED').length,
      },
      surchargesBreakdown: {
        massCents,
        waitingCents,
        pendingCents: pendingSurchargesCents,
      },
      jobSpendHistory,
    };
  }
}
