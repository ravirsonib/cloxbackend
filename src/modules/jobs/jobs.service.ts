import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AssignmentStatus,
  CompanyStatus,
  CompanyType,
  JobPricingModel,
  JobStatus,
  NotificationType,
  PaymentEventType,
  PlatformRole,
  ProposalStatus,
  TripExceptionStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import {
  AuditAction,
  type JobCreateInput,
  type JobReceiverUpdateInput,
  type JobRouteEstimateInput,
} from '../../shared/types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { carrierMatchesJob } from '../matching/matching.eligibility';
import { InAppNotificationsService } from '../notifications/in-app-notifications.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { SenderService } from '../sender/sender.service';
import { resolveJobEditMode } from './job-edit-mode';
import {
  isAssignmentPaidAndConfirmed,
  pickPrimaryFarePaymentEvent,
} from './assignment-status.util';
import {
  estimateRangeIncGstCents,
  quoteForModel,
  resolveClassRates,
  type LegacyPlatformRateFallback,
} from './class-pricing.util';
import {
  DEFAULT_VEHICLE_CLASSES,
  VehicleClassSpec,
  vehicleClassConfigWriteData,
  carrierNetPayoutCents,
  chargeableWeightKg,
  gstSplitFromIncCents,
  isVehicleClassAdequate,
  recommendVehicleClass,
} from './job-pricing.util';
import { estimateRoute, orderStopsTspObjects, routeFromDistanceKm } from './routing.mock';
import {
  buildStopLoadProfile,
  classWeightKgFromProfile,
} from './job-stop-load.util';
import { RateFloorService } from '../rate-floor/rate-floor.service';

/** Soft cap so one unverified sender cannot flood DRAFT rows. */
const MAX_OPEN_DRAFT_JOBS_PER_SENDER = 10;

/** Soft cap so one publish cannot fan out unbounded SMTP work. */
const MAX_JOB_PUBLISH_CARRIER_EMAILS = 200;

const DEFAULT_MIN_BASE_CENTS = {
  PER_KM: 5_000,
  HOURLY: 20_000,
} as const;

/** Map AU state abbreviations on stops → Region.code */
const AU_STATE_CODES = new Set(['VIC', 'NSW', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']);

/** Default capital metro territory code per AU state. */
const STATE_PRIMARY_TERRITORY_CODE: Record<string, string> = {
  VIC: 'MEL',
  NSW: 'SYD',
  QLD: 'BNE',
  SA: 'ADL',
  WA: 'PER',
  TAS: 'HBA',
  NT: 'DRW',
  ACT: 'CBR',
};

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly senderService: SenderService,
    private readonly payments: PaymentsService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly inbox?: InAppNotificationsService,
    @Optional() private readonly revenueSplit?: import('../settlements/revenue-split.service').RevenueSplitService,
    @Optional() private readonly rateFloor?: RateFloorService,
  ) {}

  /**
   * Sender-facing hard floor (Wave 1). Market quote is raised to floor when needed.
   * Returns null when RateFloorService is unavailable (unit tests without module).
   */
  async resolveHardFloor(params: {
    vehicleClassCode: string;
    pricingModel: 'PER_KM' | 'HOURLY';
    distanceKm?: number | null;
    billableHours?: number | null;
    at?: Date | null;
    pickupState?: string | null;
    bodyCode?: string | null;
    requiresReefer?: boolean | null;
    requiresDg?: boolean | null;
    backhaul?: boolean | null;
  }) {
    if (!this.rateFloor) return null;
    return this.rateFloor.calculate({
      vehicleClassCode: params.vehicleClassCode,
      pricingModel: params.pricingModel,
      distanceKm: params.distanceKm,
      billableHours: params.billableHours,
      at: params.at,
      pickupState: params.pickupState,
      bodyCode: params.bodyCode,
      requiresReefer: params.requiresReefer,
      requiresDg: params.requiresDg,
      backhaul: params.backhaul,
    });
  }

  /** Apply hard floor under market estimate; returns GST split + snapshot fields. */
  private async withHardFloorEstimate(params: {
    marketEstimateIncGstCents: number;
    gstPercent: number;
    vehicleClassCode: string;
    pricingModel: 'PER_KM' | 'HOURLY';
    distanceKm?: number | null;
    billableHours?: number | null;
    at?: Date | null;
    pickupState?: string | null;
    bodyCode?: string | null;
    requiresReefer?: boolean | null;
    requiresDg?: boolean | null;
    backhaul?: boolean | null;
  }) {
    const floor = await this.resolveHardFloor({
      vehicleClassCode: params.vehicleClassCode,
      pricingModel: params.pricingModel,
      distanceKm: params.distanceKm,
      billableHours: params.billableHours,
      at: params.at,
      pickupState: params.pickupState,
      bodyCode: params.bodyCode,
      requiresReefer: params.requiresReefer,
      requiresDg: params.requiresDg,
      backhaul: params.backhaul,
    });
    const estimateInc = floor
      ? Math.max(params.marketEstimateIncGstCents, floor.floorIncGstCents)
      : params.marketEstimateIncGstCents;
    const estimate = gstSplitFromIncCents(estimateInc, params.gstPercent);
    return {
      estimate,
      rateFloorVersionId: floor?.versionId ?? null,
      rateFloorExGstCents: floor?.floorExGstCents ?? null,
      rateFloorIncGstCents: floor?.floorIncGstCents ?? null,
      rateFloorBreakdown: floor?.breakdown ?? null,
      hardFloor: floor,
    };
  }

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  /**
   * Matching + commission origin from primary pickup stop state when known;
   * falls back to sender company home region. Territory = enabled territory
   * in that region (primary metro territory preferred for the state when present).
   */
  private async resolveJobOrigin(
    stops: Array<{ stopType: string; state: string | null }>,
    fallbackRegionId: string | null,
  ): Promise<{ originRegionId: string | null; originTerritoryId: string | null }> {
    const pickup =
      stops.find((s) => s.stopType === 'PICKUP') ?? stops[0] ?? null;
    const stateCode = pickup?.state?.trim().toUpperCase() ?? null;

    let originRegionId = fallbackRegionId;
    let resolvedStateCode: string | null = null;
    if (stateCode && AU_STATE_CODES.has(stateCode)) {
      const region = await this.prisma.region.findUnique({ where: { code: stateCode } });
      if (region) {
        if ((region as { enabled?: boolean }).enabled === false) {
          throw new BadRequestException({
            message: `Service region ${stateCode} is not currently enabled on the platform`,
            code: 'REGION_NOT_ENABLED',
            state: stateCode,
          });
        }
        originRegionId = region.id;
        resolvedStateCode = region.code ?? stateCode;
      }
    }

    if (!originRegionId) {
      return { originRegionId: null, originTerritoryId: null };
    }

    const territories = await this.prisma.localTerritory.findMany({
      where: { regionId: originRegionId, enabled: true },
      orderBy: { code: 'asc' },
    });
    if (territories.length === 0) {
      return { originRegionId, originTerritoryId: null };
    }
    const primaryCode = resolvedStateCode
      ? STATE_PRIMARY_TERRITORY_CODE[resolvedStateCode]
      : undefined;
    const preferred =
      (primaryCode ? territories.find((t) => t.code === primaryCode) : undefined) ??
      territories.find((t) => Object.values(STATE_PRIMARY_TERRITORY_CODE).includes(t.code)) ??
      territories[0];
    return { originRegionId, originTerritoryId: preferred.id };
  }

  async getPricingConfig() {
    try {
      const s = await this.prisma.platformSettings.findUnique({
        where: { id: 'default' },
        select: {
          perKmRateCents: true,
          perKmMinBaseCents: true,
          hourlyRateCents: true,
          hourlyMinFloorHours: true,
          hourlyMinBaseCents: true,
          gstPercent: true,
        },
      });
      return {
        perKmRateCents: s?.perKmRateCents ?? 250,
        perKmMinBaseCents: s?.perKmMinBaseCents ?? DEFAULT_MIN_BASE_CENTS.PER_KM,
        hourlyRateCents: s?.hourlyRateCents ?? 8_000,
        hourlyMinFloorHours: s?.hourlyMinFloorHours ?? 4.0,
        hourlyMinBaseCents: s?.hourlyMinBaseCents ?? DEFAULT_MIN_BASE_CENTS.HOURLY,
        gstPercent: s?.gstPercent ?? 10.0,
      };
    } catch {
      return {
        perKmRateCents: 250,
        perKmMinBaseCents: DEFAULT_MIN_BASE_CENTS.PER_KM,
        hourlyRateCents: 8_000,
        hourlyMinFloorHours: 4.0,
        hourlyMinBaseCents: DEFAULT_MIN_BASE_CENTS.HOURLY,
        gstPercent: 10.0,
      };
    }
  }

  /** Global hard floor from PlatformSettings (policy). */
  async getMinBaseCents(pricingModel: 'PER_KM' | 'HOURLY'): Promise<number> {
    const config = await this.getPricingConfig();
    return pricingModel === 'HOURLY' ? config.hourlyMinBaseCents : config.perKmMinBaseCents;
  }

  private toLegacyFallback(config: Awaited<ReturnType<JobsService['getPricingConfig']>>): LegacyPlatformRateFallback {
    return {
      perKmRateCents: config.perKmRateCents,
      hourlyRateCents: config.hourlyRateCents,
      perKmMinBaseCents: config.perKmMinBaseCents,
      hourlyMinBaseCents: config.hourlyMinBaseCents,
      hourlyMinFloorHours: config.hourlyMinFloorHours,
      gstPercent: config.gstPercent,
    };
  }

  private mapVehicleClassRow(c: {
    code: string;
    name: string;
    rank: number;
    maxChargeableWeightKg: number;
    maxLengthCm: number;
    maxWidthCm: number;
    maxHeightCm: number;
    minLicenceClass: string;
    suggestedGvmKg: number;
    suggestedTareKg: number;
    isActive: boolean;
    perKmRateCents?: number | null;
    hourlyRateCents?: number | null;
    perKmMinBaseCents?: number | null;
    hourlyMinBaseCents?: number | null;
    perKmGuidanceMinCents?: number | null;
    perKmGuidanceMaxCents?: number | null;
    hourlyGuidanceMinCents?: number | null;
    hourlyGuidanceMaxCents?: number | null;
  }): VehicleClassSpec {
    return {
      code: c.code,
      name: c.name,
      rank: c.rank,
      maxChargeableWeightKg: c.maxChargeableWeightKg,
      maxLengthCm: c.maxLengthCm,
      maxWidthCm: c.maxWidthCm,
      maxHeightCm: c.maxHeightCm,
      minLicenceClass: c.minLicenceClass,
      suggestedGvmKg: c.suggestedGvmKg,
      suggestedTareKg: c.suggestedTareKg,
      isActive: c.isActive,
      perKmRateCents: c.perKmRateCents ?? null,
      hourlyRateCents: c.hourlyRateCents ?? null,
      perKmMinBaseCents: c.perKmMinBaseCents ?? null,
      hourlyMinBaseCents: c.hourlyMinBaseCents ?? null,
      perKmGuidanceMinCents: c.perKmGuidanceMinCents ?? null,
      perKmGuidanceMaxCents: c.perKmGuidanceMaxCents ?? null,
      hourlyGuidanceMinCents: c.hourlyGuidanceMinCents ?? null,
      hourlyGuidanceMaxCents: c.hourlyGuidanceMaxCents ?? null,
    };
  }

  /** Class-aware quote for job estimate or bid floor. */
  async quoteForVehicleClass(params: {
    pricingModel: 'PER_KM' | 'HOURLY';
    vehicleClass: string;
    distanceKm: number;
    billableHours?: number | null;
  }): Promise<{ estimateIncGstCents: number; ratesClassCode: string; usedLegacyFallback: boolean }> {
    const config = await this.getPricingConfig();
    const legacy = this.toLegacyFallback(config);
    const classes = await this.getActiveVehicleClasses();
    const row = classes.find((c) => c.code === params.vehicleClass);
    const rates = resolveClassRates(params.vehicleClass, row, legacy);
    const globalFloor =
      params.pricingModel === 'HOURLY' ? legacy.hourlyMinBaseCents : legacy.perKmMinBaseCents;
    const estimateIncGstCents = quoteForModel({
      pricingModel: params.pricingModel,
      rates,
      distanceKm: params.distanceKm,
      billableHours: params.billableHours,
      hourlyMinFloorHours: legacy.hourlyMinFloorHours,
      globalHardFloorCents: globalFloor,
    });
    return {
      estimateIncGstCents,
      ratesClassCode: rates.classCode,
      usedLegacyFallback: rates.usedLegacyFallback,
    };
  }

  async getPlatformGstPercent(): Promise<number> {
    try {
      const settings = await this.prisma.platformSettings.findUnique({
        where: { id: 'default' },
        select: { gstPercent: true },
      });
      return settings?.gstPercent ?? 10.0;
    } catch {
      return 10.0;
    }
  }

  async getActiveVehicleClasses(): Promise<VehicleClassSpec[]> {
    try {
      await this.seedDefaultVehicleClasses();
      const list = await this.prisma.vehicleClassConfig.findMany({
        where: { isActive: true },
        orderBy: { rank: 'asc' },
      });
      if (list.length > 0) {
        return list.map((c) => this.mapVehicleClassRow(c));
      }
      return DEFAULT_VEHICLE_CLASSES.filter((c) => c.isActive !== false);
    } catch {
      return DEFAULT_VEHICLE_CLASSES.filter((c) => c.isActive !== false);
    }
  }

  async seedDefaultVehicleClasses(): Promise<void> {
    try {
      const existing = await this.prisma.vehicleClassConfig.findMany({
        select: { code: true },
      });
      const have = new Set(existing.map((r) => r.code));
      for (const c of DEFAULT_VEHICLE_CLASSES) {
        if (have.has(c.code)) continue;
        // Create missing catalog rows only; do not clobber Ops edits on existing rows.
        await this.prisma.vehicleClassConfig.create({
          data: vehicleClassConfigWriteData(c),
        });
      }
    } catch {
      // Non-fatal if table not yet migrated during isolated unit tests
    }
  }

  async getVehicleClassesMeta() {
    const classes = await this.getActiveVehicleClasses();
    const rankMap: Record<string, number> = {};
    const minLicenceMap: Record<string, string> = {};
    const maxChargeableMap: Record<string, number> = {};
    const maxDimsMap: Record<string, { lengthCm: number; widthCm: number; heightCm: number }> = {};
    const suggestedGvmMap: Record<string, number> = {};
    const suggestedTareMap: Record<string, number> = {};

    for (const c of classes) {
      rankMap[c.code] = c.rank;
      minLicenceMap[c.code] = c.minLicenceClass;
      maxChargeableMap[c.code] = c.maxChargeableWeightKg;
      maxDimsMap[c.code] = {
        lengthCm: c.maxLengthCm,
        widthCm: c.maxWidthCm,
        heightCm: c.maxHeightCm,
      };
      if (c.suggestedGvmKg) suggestedGvmMap[c.code] = c.suggestedGvmKg;
      if (c.suggestedTareKg) suggestedTareMap[c.code] = c.suggestedTareKg;
    }

    return {
      classes,
      classCodes: classes.map((c) => c.code),
      ranks: rankMap,
      minLicences: minLicenceMap,
      maxChargeableKg: maxChargeableMap,
      maxDimsCm: maxDimsMap,
      suggestedGvmKg: suggestedGvmMap,
      suggestedTareKg: suggestedTareMap,
      chargeableFormula: 'max(deadKg, L×W×Hcm/4000)',
    };
  }

  async getRegionsMeta() {
    try {
      const regions = await this.prisma.region.findMany({
        orderBy: { code: 'asc' },
        include: {
          territories: {
            where: { enabled: true },
            orderBy: { code: 'asc' },
            select: {
              id: true,
              code: true,
              name: true,
              enabled: true,
            },
          },
        },
      });
      return {
        regions: regions.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          enabled: r.enabled,
          territories: r.territories ?? [],
        })),
        enabledCodes: regions.filter((r) => r.enabled).map((r) => r.code),
      };
    } catch {
      return {
        regions: [],
        enabledCodes: Array.from(AU_STATE_CODES),
      };
    }
  }

  private mapJob(job: {
    id: string;
    status: JobStatus;
    pricingModel: JobPricingModel;
    title: string | null;
    receiverName: string | null;
    receiverEmail: string | null;
    receiverPhone: string | null;
    receiverAltEmail?: string | null;
    receiverAltPhone?: string | null;
    pickupAt: Date | null;
    deadWeightKg: number | null;
    lengthCm: number | null;
    widthCm: number | null;
    heightCm: number | null;
    chargeableWeightKg: number | null;
    loadTypes: string[];
    loadTypeSubtypes?: string[];
    requiresDg: boolean;
    dgDocumentId?: string | null;
    dgDocument?: { id: string; originalFilename: string | null } | null;
    requiresReefer: boolean;
    requiresOversize: boolean;
    minVehicleClass: string | null;
    recommendedVehicleClass: string | null;
    pricingVehicleClass?: string | null;
    rateFloorVersionId?: string | null;
    rateFloorExGstCents?: number | null;
    rateFloorIncGstCents?: number | null;
    rateFloorBreakdown?: unknown;
    isBackhaul?: boolean;
    siteManeuverability: string | null;
    siteFacility: string | null;
    siteDisclaimerAcceptedAt: Date | null;
    hourlyPattern: string | null;
    routeDistanceKm: number | null;
    routeDurationMinutes: number | null;
    routeFatigueBreakMinutes: number;
    billableHours: number | null;
    estimateExGstCents: number | null;
    estimateGstCents: number | null;
    estimateIncGstCents: number | null;
    publishedAt: Date | null;
    publishRequestedAt?: Date | null;
    createdAt: Date;
    stops?: Array<{
      id: string;
      sequence: number;
      stopType: string;
      label: string | null;
      addressLine: string | null;
      suburb: string | null;
      state: string | null;
      postcode: string | null;
      lat: { toNumber(): number } | number | null;
      lng: { toNumber(): number } | number | null;
      receiverName: string | null;
      receiverEmail: string | null;
      weightKg?: number | null;
    }>;
    proposals?: Array<{
      id: string;
      status: ProposalStatus;
      amountIncGstCents: number;
      amountExGstCents: number;
      amountGstCents: number;
      etaMinutes: number | null;
      carrierCompanyId: string;
      vehicleId: string | null;
      driverId: string | null;
      vehicle?: { vehicleClass: string | null; registration: string | null; label: string | null } | null;
      carrierCompany?: {
        id: string;
        legalName: string;
        tradingName?: string | null;
        email?: string | null;
        phone?: string | null;
        abn?: string | null;
        reliabilityScore?: number | null;
      } | null;
      driver?: {
        id: string;
        licenceClass?: string | null;
        user?: {
          name?: string | null;
          email?: string | null;
          phone?: string | null;
        } | null;
      } | null;
      dgDocumentId?: string | null;
      dgDocument?: { id: string; originalFilename: string | null } | null;
      createdAt: Date;
    }>;
    _count?: { proposals?: number };
  }) {
    const openProposalCount =
      job._count?.proposals ??
      (job.proposals ?? []).filter((p) => p.status === ProposalStatus.SUBMITTED).length;
    return {
      id: job.id,
      status: job.status,
      pricingModel: job.pricingModel,
      title: job.title,
      receiverName: job.receiverName,
      receiverEmail: job.receiverEmail,
      receiverPhone: job.receiverPhone,
      receiverAltEmail: job.receiverAltEmail ?? null,
      receiverAltPhone: job.receiverAltPhone ?? null,
      pickupAt: job.pickupAt,
      deadWeightKg: job.deadWeightKg,
      lengthCm: job.lengthCm,
      widthCm: job.widthCm,
      heightCm: job.heightCm,
      chargeableWeightKg: job.chargeableWeightKg,
      loadTypes: job.loadTypes,
      loadTypeSubtypes: job.loadTypeSubtypes ?? [],
      requiresDg: job.requiresDg,
      dgDocumentId: job.dgDocumentId ?? null,
      dgDocumentFilename: job.dgDocument?.originalFilename ?? null,
      requiresReefer: job.requiresReefer,
      requiresOversize: job.requiresOversize,
      isBackhaul: job.isBackhaul ?? false,
      minVehicleClass: job.minVehicleClass,
      recommendedVehicleClass: job.recommendedVehicleClass,
      pricingVehicleClass: job.pricingVehicleClass ?? job.minVehicleClass ?? job.recommendedVehicleClass,
      siteManeuverability: job.siteManeuverability,
      siteFacility: job.siteFacility,
      siteDisclaimerAcceptedAt: job.siteDisclaimerAcceptedAt,
      hourlyPattern: job.hourlyPattern,
      route: {
        distanceKm: job.routeDistanceKm,
        durationMinutes: job.routeDurationMinutes,
        fatigueBreakMinutes: job.routeFatigueBreakMinutes,
        billableHours: job.billableHours,
        mock: true as const,
      },
      estimate: {
        exGstCents: job.estimateExGstCents,
        gstCents: job.estimateGstCents,
        incGstCents: job.estimateIncGstCents,
      },
      rateFloor: {
        versionId: job.rateFloorVersionId ?? null,
        exGstCents: job.rateFloorExGstCents ?? null,
        incGstCents: job.rateFloorIncGstCents ?? null,
        breakdown: job.rateFloorBreakdown ?? null,
      },
      publishedAt: job.publishedAt,
      publishRequestedAt: job.publishRequestedAt ?? null,
      createdAt: job.createdAt,
      openProposalCount,
      loadProfile: (() => {
        const profile = buildStopLoadProfile(
          (job.stops ?? []).map((s) => ({
            sequence: s.sequence,
            stopType: s.stopType,
            weightKg: s.weightKg ?? null,
          })),
        );
        if (!profile.hasStopWeights) return null;
        return {
          peakOnboardKg: profile.peakOnboardKg,
          totalPickupKg: profile.totalPickupKg,
          segments: profile.segments.map((seg) => ({
            sequence: seg.sequence,
            stopType: seg.stopType,
            weightKg: seg.weightKg,
            onboardKgAfter: seg.onboardKgAfter,
          })),
        };
      })(),
      stops: (job.stops ?? []).map((s) => ({
        id: s.id,
        sequence: s.sequence,
        stopType: s.stopType,
        label: s.label,
        addressLine: s.addressLine,
        suburb: s.suburb,
        state: s.state,
        postcode: s.postcode,
        lat: s.lat == null ? null : typeof s.lat === 'number' ? s.lat : s.lat.toNumber(),
        lng: s.lng == null ? null : typeof s.lng === 'number' ? s.lng : s.lng.toNumber(),
        receiverName: s.receiverName,
        receiverEmail: s.receiverEmail,
        weightKg: s.weightKg ?? null,
      })),
      proposals: (job.proposals ?? []).map((p, idx) => {
        const carrierName =
          p.carrierCompany?.tradingName?.trim() ||
          p.carrierCompany?.legalName?.trim() ||
          `Carrier ${String.fromCharCode(65 + (idx % 26))}`;
        return {
          id: p.id,
          status: p.status,
          amountIncGstCents: p.amountIncGstCents,
          amountExGstCents: p.amountExGstCents,
          amountGstCents: p.amountGstCents,
          etaMinutes: p.etaMinutes,
          vehicleClass: p.vehicle?.vehicleClass ?? null,
          vehicleLabel: p.vehicle?.label ?? p.vehicle?.registration ?? null,
          vehicleRegistration: p.vehicle?.registration ?? null,
          carrierCompanyId: p.carrierCompanyId,
          carrierLabel: carrierName,
          carrierCompanyIdMasked: !p.carrierCompany,
          carrierCompany: p.carrierCompany
            ? {
                id: p.carrierCompany.id,
                legalName: p.carrierCompany.legalName,
                tradingName: p.carrierCompany.tradingName ?? null,
                email: p.carrierCompany.email ?? null,
                phone: p.carrierCompany.phone ?? null,
                abn: p.carrierCompany.abn ?? null,
                reliabilityScore: p.carrierCompany.reliabilityScore ?? 100,
              }
            : null,
          driver: p.driver
            ? {
                id: p.driver.id,
                name: p.driver.user?.name ?? null,
                email: p.driver.user?.email ?? null,
                phone: p.driver.user?.phone ?? null,
                licenceClass: p.driver.licenceClass ?? null,
              }
            : null,
          dgDocumentId: p.dgDocumentId ?? p.dgDocument?.id ?? null,
          dgDocumentFilename: p.dgDocument?.originalFilename ?? null,
          // Enriched with uplift-aware net in getJob when RevenueSplitService is available.
          netToCarrierCents: carrierNetPayoutCents(p.amountIncGstCents),
          createdAt: p.createdAt,
        };
      })
        .sort((a, b) => {
          // Actionable/submitted proposals first
          if (a.status === ProposalStatus.SUBMITTED && b.status !== ProposalStatus.SUBMITTED) return -1;
          if (a.status !== ProposalStatus.SUBMITTED && b.status === ProposalStatus.SUBMITTED) return 1;

          // Performance Score weighting: prioritize carriers with higher reliability score (>= 10pt gap)
          const aRel = a.carrierCompany?.reliabilityScore ?? 100;
          const bRel = b.carrierCompany?.reliabilityScore ?? 100;
          if (Math.abs(aRel - bRel) >= 10) {
            return bRel - aRel;
          }

          // Competitive pricing next
          if (a.amountIncGstCents !== b.amountIncGstCents) {
            return a.amountIncGstCents - b.amountIncGstCents;
          }

          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        }),
    };
  }

  async listSenderJobs(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    if (principal.kind !== 'user' || principal.role !== 'SENDER') {
      throw new ForbiddenException('Sender required');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      include: { company: true },
    });
    if (!user?.company || user.company.type !== CompanyType.SENDER) {
      throw new NotFoundException('Sender company not found');
    }
    const jobs = await this.prisma.job.findMany({
      where: { senderCompanyId: user.company.id },
      include: {
        stops: { orderBy: { sequence: 'asc' } },
        trip: { select: { id: true, status: true, completedAt: true } },
        assignment: {
          select: { id: true, status: true, lockedAt: true },
        },
        _count: {
          select: {
            proposals: { where: { status: ProposalStatus.SUBMITTED } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return jobs.map((j) => ({
      ...this.mapJob(j),
      trip: j.trip
        ? {
            id: j.trip.id,
            status: j.trip.status,
            completedAt: j.trip.completedAt?.toISOString() ?? null,
          }
        : null,
      completedAt: j.trip?.completedAt?.toISOString() ?? null,
      // Lightweight assignment so sender list can show Pending payment vs Paid & locked.
      assignment: j.assignment
        ? {
            id: j.assignment.id,
            status: j.assignment.status,
            lockedAt: j.assignment.lockedAt,
            paidAndConfirmed: isAssignmentPaidAndConfirmed(j.assignment.status),
          }
        : null,
    }));
  }

  async getJobForSender(principal: AuthenticatedPrincipal, jobId: string) {
    this.ensureDatabase();
    if (principal.kind !== 'user' || principal.role !== 'SENDER') {
      throw new ForbiddenException('Sender required');
    }
    const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
    if (!user?.companyId) throw new NotFoundException('Sender company not found');
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, senderCompanyId: user.companyId },
      include: {
        stops: { orderBy: { sequence: 'asc' } },
        dgDocument: { select: { id: true, originalFilename: true } },
        proposals: {
          where: { status: { in: [ProposalStatus.SUBMITTED, ProposalStatus.ACCEPTED, ProposalStatus.EXPIRED] } },
          include: {
            vehicle: true,
            dgDocument: { select: { id: true, originalFilename: true } },
            carrierCompany: {
              select: {
                id: true,
                legalName: true,
                tradingName: true,
                email: true,
                phone: true,
                abn: true,
                reliabilityScore: true,
              },
            },
            driver: {
              select: {
                id: true,
                licenceClass: true,
                user: {
                  select: {
                    name: true,
                    email: true,
                    phone: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        assignment: true,
        trip: { select: { id: true, status: true, completedAt: true } },
        paymentEvents: {
          where: { type: PaymentEventType.CHARGE },
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
    });
    if (!job) throw new NotFoundException('Job not found');
    const editability = resolveJobEditMode(job);
    const primaryPayment = pickPrimaryFarePaymentEvent(job.paymentEvents);
    const openException = await this.prisma.tripException.findFirst({
      where: {
        jobId: job.id,
        status: {
          in: [
            TripExceptionStatus.OPEN,
            TripExceptionStatus.AWAITING_CARRIER,
            TripExceptionStatus.REASSIGN_IN_PROGRESS,
            TripExceptionStatus.AWAITING_SENDER_APPROVAL,
            TripExceptionStatus.ESCALATED,
          ],
        },
      },
      orderBy: { openedAt: 'desc' },
      select: {
        id: true,
        kind: true,
        phase: true,
        status: true,
        note: true,
        openedAt: true,
        escalatedAt: true,
        proposedVehicleId: true,
        proposedDriverId: true,
        proposedAt: true,
        proposedVehicle: {
          select: {
            id: true,
            registration: true,
            label: true,
            vehicleClass: true,
          },
        },
        proposedDriver: {
          select: {
            id: true,
            user: { select: { email: true, name: true } },
          },
        },
      },
    });
    const mapped = this.mapJob(job);
    if (this.revenueSplit && mapped.proposals?.length) {
      mapped.proposals = await Promise.all(
        mapped.proposals.map(async (p) => ({
          ...p,
          netToCarrierCents: await this.revenueSplit!.carrierNetPayoutCents(
            p.amountIncGstCents,
            new Date(),
            p.carrierCompanyId,
          ),
        })),
      );
    }
    return {
      ...mapped,
      editability,
      trip: job.trip
        ? {
            id: job.trip.id,
            status: job.trip.status,
            completedAt: job.trip.completedAt?.toISOString() ?? null,
          }
        : null,
      completedAt: job.trip?.completedAt?.toISOString() ?? null,
      assignment: job.assignment
        ? {
            id: job.assignment.id,
            status: job.assignment.status,
            lockedAt: job.assignment.lockedAt,
            paidAndConfirmed: isAssignmentPaidAndConfirmed(job.assignment.status),
          }
        : null,
      payment: primaryPayment
        ? {
            id: primaryPayment.id,
            status: primaryPayment.status,
            amountIncGstCents: primaryPayment.amountIncGstCents,
            stripePaymentIntentId: primaryPayment.stripePaymentIntentId,
            type: primaryPayment.type,
          }
        : null,
      openException: openException
        ? {
            id: openException.id,
            kind: openException.kind,
            phase: openException.phase,
            status: openException.status,
            note: openException.note,
            openedAt: openException.openedAt,
            escalatedAt: openException.escalatedAt,
            proposedVehicleId: openException.proposedVehicleId,
            proposedDriverId: openException.proposedDriverId,
            proposedAt: openException.proposedAt,
            proposedVehicle: openException.proposedVehicle,
            proposedDriver: openException.proposedDriver
              ? {
                  id: openException.proposedDriver.id,
                  email: openException.proposedDriver.user?.email ?? null,
                  name: openException.proposedDriver.user?.name ?? null,
                }
              : null,
          }
        : null,
    };
  }

  /**
   * Suggest distance/duration from pickup + drop (mock Valhalla until real client is wired).
   * Does not persist; sender may edit the suggested km on create/update.
   */
  async previewRoute(input: JobRouteEstimateInput) {
    const config = await this.getPricingConfig();
    const legacy = this.toLegacyFallback(config);
    const classes = await this.getActiveVehicleClasses();
    const sortedStops = input.stops.slice().sort((a, b) => a.sequence - b.sequence);
    const orderedStops =
      input.pricingModel === 'HOURLY' && sortedStops.length > 2
        ? orderStopsTspObjects(sortedStops)
        : sortedStops;
    const route = estimateRoute({
      stops: orderedStops.map((s) => ({ lat: s.lat, lng: s.lng })),
      pricingModel: input.pricingModel,
      hourlyFloorHours: config.hourlyMinFloorHours,
    });

    const pricingClass =
      input.vehicleClass?.trim() ||
      [...classes].sort((a, b) => a.rank - b.rank)[0]?.code ||
      'UTE';
    const classRow = classes.find((c) => c.code === pricingClass);
    const rates = resolveClassRates(pricingClass, classRow, legacy);
    const globalFloor =
      input.pricingModel === 'HOURLY' ? legacy.hourlyMinBaseCents : legacy.perKmMinBaseCents;
    const marketEstimateIncGstCents = quoteForModel({
      pricingModel: input.pricingModel,
      rates,
      distanceKm: route.distanceKm,
      billableHours: route.billableHours,
      hourlyMinFloorHours: config.hourlyMinFloorHours,
      globalHardFloorCents: globalFloor,
    });
    const pickupStop =
      orderedStops.find((s) => s.stopType === 'PICKUP') ?? orderedStops[0] ?? null;
    const floored = await this.withHardFloorEstimate({
      marketEstimateIncGstCents,
      gstPercent: config.gstPercent,
      vehicleClassCode: pricingClass,
      pricingModel: input.pricingModel,
      distanceKm: route.distanceKm,
      billableHours: route.billableHours,
      pickupState: pickupStop?.state ?? null,
    });
    const estimateIncGstCents = floored.estimate.amountIncGstCents;
    const range = estimateRangeIncGstCents({
      pricingModel: input.pricingModel,
      pricingClass,
      classes,
      legacy,
      distanceKm: route.distanceKm,
      billableHours: route.billableHours,
    });
    const minBillableHours =
      input.pricingModel === 'HOURLY' ? config.hourlyMinFloorHours : null;
    const legacyMinCharge =
      input.pricingModel === 'HOURLY'
        ? Math.max(
            globalFloor,
            rates.hourlyMinBaseCents,
            Math.round(config.hourlyMinFloorHours * rates.hourlyRateCents),
          )
        : Math.max(globalFloor, rates.perKmMinBaseCents);
    const hardFloorInc = floored.rateFloorIncGstCents ?? 0;
    const minChargeIncGstCents = Math.max(legacyMinCharge, hardFloorInc);

    return {
      distanceKm: route.distanceKm,
      durationMinutes: route.totalDurationMinutes,
      drivingMinutes: route.drivingMinutes,
      fatigueBreakMinutes: route.fatigueBreakMinutes,
      billableHours: route.billableHours,
      minBillableHours,
      hourlyRateCents: input.pricingModel === 'HOURLY' ? rates.hourlyRateCents : null,
      perKmRateCents: input.pricingModel === 'PER_KM' ? rates.perKmRateCents : null,
      minBaseCents: Math.max(
        globalFloor,
        input.pricingModel === 'HOURLY' ? rates.hourlyMinBaseCents : rates.perKmMinBaseCents,
        hardFloorInc,
      ),
      minChargeIncGstCents,
      estimateIncGstCents,
      pricingVehicleClass: pricingClass,
      estimateRange: {
        minIncGstCents: Math.max(range.minIncGstCents, hardFloorInc),
        maxIncGstCents: Math.max(range.maxIncGstCents, hardFloorInc),
        maxClassCode: range.maxClassCode,
      },
      rateFloorExGstCents: floored.rateFloorExGstCents,
      rateFloorIncGstCents: floored.rateFloorIncGstCents,
      rateFloorVersionId: floored.rateFloorVersionId,
      mock: route.mock,
    };
  }

  async createJob(principal: AuthenticatedPrincipal, input: JobCreateInput) {
    this.ensureDatabase();
    const eligibility = await this.senderService.getBookingEligibility(principal);
    if (!eligibility.canDraft) {
      throw new ForbiddenException({
        message:
          'Sender cannot create draft jobs while the company is rejected or suspended. Open /sender/onboarding for status.',
        code: 'SENDER_NOT_DRAFT_READY',
        goNoGo: eligibility.goNoGo,
        href: '/sender/onboarding',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      include: { company: { include: { homeRegion: true } } },
    });
    if (!user?.company) throw new NotFoundException('Sender company not found');

    const openDrafts = await this.prisma.job.count({
      where: { senderCompanyId: user.company.id, status: JobStatus.DRAFT },
    });
    if (openDrafts >= MAX_OPEN_DRAFT_JOBS_PER_SENDER) {
      throw new BadRequestException({
        message: `You already have ${MAX_OPEN_DRAFT_JOBS_PER_SENDER} draft jobs. Publish or cancel one before creating another.`,
        code: 'SENDER_DRAFT_LIMIT',
        limit: MAX_OPEN_DRAFT_JOBS_PER_SENDER,
      });
    }

    if (!input.siteDisclaimerAccepted) {
      throw new BadRequestException('Site access disclaimer must be accepted');
    }
    if (!input.receiverEmail || !input.receiverName) {
      throw new BadRequestException('Receiver name + email required');
    }

    for (const stop of input.stops) {
      if (stop.stopType === 'DROPOFF' && input.stops.filter((s) => s.stopType === 'DROPOFF').length > 1) {
        if (!stop.receiverEmail || !stop.receiverName) {
          throw new BadRequestException('Each drop requires receiver name + email for multi-drop');
        }
      }
    }

    const loadProfile = buildStopLoadProfile(input.stops);
    if (loadProfile.hasStopWeights && !loadProfile.ok) {
      throw new BadRequestException({
        message: loadProfile.errors[0] ?? 'Invalid stop load weights',
        code: 'STOP_LOAD_INVALID',
        errors: loadProfile.errors,
      });
    }
    const deadWeightKg = loadProfile.hasStopWeights
      ? loadProfile.totalPickupKg
      : input.deadWeightKg;
    const volumetricKg =
      (input.lengthCm * input.widthCm * input.heightCm) / 4000;
    const chargeable = chargeableWeightKg({
      deadWeightKg,
      lengthCm: input.lengthCm,
      widthCm: input.widthCm,
      heightCm: input.heightCm,
    });
    const classWeightKg = classWeightKgFromProfile(
      loadProfile,
      volumetricKg,
      deadWeightKg,
    );
    const vehicleClasses = await this.getActiveVehicleClasses();
    const rankMap = Object.fromEntries(vehicleClasses.map((c) => [c.code, c.rank]));
    const recommended = recommendVehicleClass(
      classWeightKg,
      {
        lengthCm: input.lengthCm,
        widthCm: input.widthCm,
        heightCm: input.heightCm,
      },
      vehicleClasses,
    );
    const minClass = input.minVehicleClass ?? recommended;
    if (!isVehicleClassAdequate(minClass, recommended, rankMap)) {
      throw new BadRequestException({
        message: `Vehicle class ${minClass} is undersized for peak/chargeable ${classWeightKg.toFixed(1)} kg (min ${recommended})`,
        code: 'VEHICLE_CLASS_UNDERSIZE',
        recommended,
        chargeableWeightKg: chargeable,
        peakOnboardKg: loadProfile.hasStopWeights ? loadProfile.peakOnboardKg : null,
      });
    }

    const requiresDg = input.loadTypes.includes('DG');
    const requiresReefer = input.loadTypes.includes('REEFER');
    const requiresOversize = input.loadTypes.includes('OVERSIZE');

    let dgDocumentId: string | null = null;
    if (requiresDg && input.dgDocumentId) {
      const dgDoc = await this.prisma.complianceDocument.findFirst({
        where: { id: input.dgDocumentId, companyId: user.company.id },
        select: { id: true },
      });
      if (!dgDoc) {
        throw new BadRequestException('DG document not found for this sender company');
      }
      dgDocumentId = dgDoc.id;
    }

    const sortedStops = input.stops.slice().sort((a, b) => a.sequence - b.sequence);
    const persistedStops =
      input.pricingModel === 'HOURLY' && sortedStops.length > 2
        ? orderStopsTspObjects(sortedStops)
        : sortedStops;
    const config = await this.getPricingConfig();
    const legacy = this.toLegacyFallback(config);
    // Sender-entered km is source of truth when provided; for HOURLY without manual km, derive from stops.
    const route =
      input.distanceKm != null && Number.isFinite(input.distanceKm) && input.distanceKm > 0
        ? routeFromDistanceKm(input.distanceKm, input.pricingModel, config.hourlyMinFloorHours)
        : estimateRoute({
            stops: persistedStops.map((s) => ({ lat: s.lat, lng: s.lng })),
            pricingModel: input.pricingModel,
            hourlyFloorHours: config.hourlyMinFloorHours,
          });

    const pricingVehicleClass = minClass;
    const pricingRow = vehicleClasses.find((c) => c.code === pricingVehicleClass);
    const rates = resolveClassRates(pricingVehicleClass, pricingRow, legacy);
    const globalFloor =
      input.pricingModel === 'HOURLY' ? legacy.hourlyMinBaseCents : legacy.perKmMinBaseCents;
    const marketEstimateInc = quoteForModel({
      pricingModel: input.pricingModel,
      rates,
      distanceKm: route.distanceKm,
      billableHours: route.billableHours,
      hourlyMinFloorHours: config.hourlyMinFloorHours,
      globalHardFloorCents: globalFloor,
    });
    const gstRatePercent = config.gstPercent;
    const pickupStopForFloor =
      persistedStops.find((s) => s.stopType === 'PICKUP') ?? persistedStops[0] ?? null;
    const floored = await this.withHardFloorEstimate({
      marketEstimateIncGstCents: marketEstimateInc,
      gstPercent: gstRatePercent,
      vehicleClassCode: pricingVehicleClass,
      pricingModel: input.pricingModel,
      distanceKm: route.distanceKm,
      billableHours: route.billableHours,
      at: new Date(input.pickupAt),
      pickupState: pickupStopForFloor?.state ?? null,
      bodyCode: input.bodyCode,
      requiresReefer,
      requiresDg,
      backhaul: input.isBackhaul ?? false,
    });
    const estimate = floored.estimate;

    const origin = await this.resolveJobOrigin(persistedStops, user.company.homeRegionId);

    const job = await this.prisma.job.create({
      data: {
        senderCompanyId: user.company.id,
        status: JobStatus.DRAFT,
        pricingModel:
          input.pricingModel === 'HOURLY' ? JobPricingModel.HOURLY : JobPricingModel.PER_KM,
        title: input.title ?? `${input.pricingModel} job`,
        originRegionId: origin.originRegionId,
        originTerritoryId: origin.originTerritoryId,
        receiverName: input.receiverName,
        receiverEmail: input.receiverEmail,
        receiverPhone: input.receiverPhone,
        receiverAltEmail: input.receiverAltEmail ?? null,
        receiverAltPhone: input.receiverAltPhone ?? null,
        pickupAt: new Date(input.pickupAt),
        deadWeightKg,
        lengthCm: input.lengthCm,
        widthCm: input.widthCm,
        heightCm: input.heightCm,
        chargeableWeightKg: Math.round(chargeable * 10) / 10,
        loadTypes: input.loadTypes,
        loadTypeSubtypes: input.loadTypeSubtypes ?? [],
        requiresDg,
        dgDocumentId,
        requiresReefer,
        requiresOversize,
        minVehicleClass: minClass,
        recommendedVehicleClass: recommended,
        pricingVehicleClass,
        siteManeuverability: input.siteManeuverability,
        siteFacility: input.siteFacility,
        siteDisclaimerAcceptedAt: new Date(),
        hourlyPattern: input.hourlyPattern ?? null,
        routeDistanceKm: route.distanceKm,
        routeDurationMinutes: route.totalDurationMinutes,
        routeFatigueBreakMinutes: route.fatigueBreakMinutes,
        billableHours: route.billableHours,
        estimateExGstCents: estimate.amountExGstCents,
        estimateGstCents: estimate.amountGstCents,
        estimateIncGstCents: estimate.amountIncGstCents,
        rateFloorVersionId: floored.rateFloorVersionId,
        rateFloorExGstCents: floored.rateFloorExGstCents,
        rateFloorIncGstCents: floored.rateFloorIncGstCents,
        rateFloorBreakdown:
          floored.rateFloorBreakdown != null
            ? (floored.rateFloorBreakdown as object)
            : undefined,
        isBackhaul: input.isBackhaul ?? false,
        stops: {
          create: persistedStops.map((s, index) => ({
            sequence: index,
            stopType: s.stopType,
            label: s.label,
            addressLine: s.addressLine,
            suburb: s.suburb,
            state: s.state,
            postcode: s.postcode,
            lat: s.lat,
            lng: s.lng,
            receiverName: s.receiverName,
            receiverEmail: s.receiverEmail,
            weightKg: s.weightKg ?? null,
          })),
        },
      },
      include: {
        stops: { orderBy: { sequence: 'asc' } },
        dgDocument: { select: { id: true, originalFilename: true } },
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.JOB_CREATED,
      actorUserId: user.id,
      entityType: 'Job',
      entityId: job.id,
      metadata: { pricingModel: input.pricingModel, minClass, chargeable },
    });

    if (this.rateFloor && floored.hardFloor && floored.rateFloorVersionId) {
      const fuelIndexId =
        typeof floored.hardFloor.breakdown?.fuelIndexId === 'string'
          ? floored.hardFloor.breakdown.fuelIndexId
          : null;
      await this.rateFloor.recordCheck({
        jobId: job.id,
        actorUserId: user.id,
        versionId: floored.rateFloorVersionId,
        fuelIndexId,
        inputs: {
          vehicleClassCode: pricingVehicleClass,
          pricingModel: input.pricingModel,
          distanceKm: route.distanceKm,
          billableHours: route.billableHours,
          source: 'JOB_CREATE',
        },
        breakdown: floored.hardFloor.breakdown,
        floorExGstCents: floored.hardFloor.floorExGstCents,
        floorIncGstCents: floored.hardFloor.floorIncGstCents,
        offeredIncGstCents: estimate.amountIncGstCents,
        result: 'PASS',
      });
    }

    return this.mapJob(job);
  }

  async loadJobForEdit(jobId: string, senderCompanyId: string) {
    const existing = await this.prisma.job.findFirst({
      where: { id: jobId, senderCompanyId },
      include: {
        assignment: { select: { status: true } },
        trip: { select: { status: true } },
        stops: { select: { id: true, stopType: true } },
      },
    });
    if (!existing) throw new NotFoundException('Job not found');
    return existing;
  }

  async updateJob(principal: AuthenticatedPrincipal, jobId: string, input: JobCreateInput) {
    this.ensureDatabase();
    const eligibility = await this.senderService.getBookingEligibility(principal);
    if (!eligibility.canDraft) {
      throw new ForbiddenException({
        message:
          'Sender cannot update jobs while the company is rejected or suspended. Open /sender/onboarding for status.',
        code: 'SENDER_NOT_DRAFT_READY',
        goNoGo: eligibility.goNoGo,
        href: '/sender/onboarding',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      include: { company: { include: { homeRegion: true } } },
    });
    if (!user?.company) throw new NotFoundException('Sender company not found');

    const existing = await this.loadJobForEdit(jobId, user.company.id);
    const editability = resolveJobEditMode(existing);
    if (editability.mode === 'NONE') {
      throw new BadRequestException({
        message: editability.reason,
        code: 'JOB_NOT_EDITABLE',
        editability,
      });
    }
    if (editability.mode === 'RECEIVER') {
      throw new BadRequestException({
        message:
          'Only receiver details can be edited now — use the receiver update payload',
        code: 'JOB_RECEIVER_EDIT_ONLY',
        editability,
      });
    }

    if (!input.siteDisclaimerAccepted) {
      throw new BadRequestException('Site access disclaimer must be accepted');
    }
    if (!input.receiverEmail || !input.receiverName) {
      throw new BadRequestException('Receiver name + email required');
    }

    for (const stop of input.stops) {
      if (stop.stopType === 'DROPOFF' && input.stops.filter((s) => s.stopType === 'DROPOFF').length > 1) {
        if (!stop.receiverEmail || !stop.receiverName) {
          throw new BadRequestException('Each drop requires receiver name + email for multi-drop');
        }
      }
    }

    const loadProfile = buildStopLoadProfile(input.stops);
    if (loadProfile.hasStopWeights && !loadProfile.ok) {
      throw new BadRequestException({
        message: loadProfile.errors[0] ?? 'Invalid stop load weights',
        code: 'STOP_LOAD_INVALID',
        errors: loadProfile.errors,
      });
    }
    const deadWeightKg = loadProfile.hasStopWeights
      ? loadProfile.totalPickupKg
      : input.deadWeightKg;
    const volumetricKg =
      (input.lengthCm * input.widthCm * input.heightCm) / 4000;
    const chargeable = chargeableWeightKg({
      deadWeightKg,
      lengthCm: input.lengthCm,
      widthCm: input.widthCm,
      heightCm: input.heightCm,
    });
    const classWeightKg = classWeightKgFromProfile(
      loadProfile,
      volumetricKg,
      deadWeightKg,
    );
    const vehicleClasses = await this.getActiveVehicleClasses();
    const rankMap = Object.fromEntries(vehicleClasses.map((c) => [c.code, c.rank]));
    const recommended = recommendVehicleClass(
      classWeightKg,
      {
        lengthCm: input.lengthCm,
        widthCm: input.widthCm,
        heightCm: input.heightCm,
      },
      vehicleClasses,
    );
    const minClass = input.minVehicleClass ?? recommended;
    if (!isVehicleClassAdequate(minClass, recommended, rankMap)) {
      throw new BadRequestException({
        message: `Vehicle class ${minClass} is undersized for peak/chargeable ${classWeightKg.toFixed(1)} kg (min ${recommended})`,
        code: 'VEHICLE_CLASS_UNDERSIZE',
        recommended,
        chargeableWeightKg: chargeable,
        peakOnboardKg: loadProfile.hasStopWeights ? loadProfile.peakOnboardKg : null,
      });
    }

    const requiresDg = input.loadTypes.includes('DG');
    const requiresReefer = input.loadTypes.includes('REEFER');
    const requiresOversize = input.loadTypes.includes('OVERSIZE');

    let dgDocumentId: string | null | undefined = requiresDg ? undefined : null;
    if (requiresDg && input.dgDocumentId) {
      const dgDoc = await this.prisma.complianceDocument.findFirst({
        where: { id: input.dgDocumentId, companyId: user.company.id },
        select: { id: true },
      });
      if (!dgDoc) {
        throw new BadRequestException('DG document not found for this sender company');
      }
      dgDocumentId = dgDoc.id;
    }

    const sortedStops = input.stops.slice().sort((a, b) => a.sequence - b.sequence);
    const persistedStops =
      input.pricingModel === 'HOURLY' && sortedStops.length > 2
        ? orderStopsTspObjects(sortedStops)
        : sortedStops;
    const config = await this.getPricingConfig();
    const legacy = this.toLegacyFallback(config);
    const route =
      input.distanceKm != null && Number.isFinite(input.distanceKm) && input.distanceKm > 0
        ? routeFromDistanceKm(input.distanceKm, input.pricingModel, config.hourlyMinFloorHours)
        : estimateRoute({
            stops: persistedStops.map((s) => ({ lat: s.lat, lng: s.lng })),
            pricingModel: input.pricingModel,
            hourlyFloorHours: config.hourlyMinFloorHours,
          });

    const pricingVehicleClass = minClass;
    const pricingRow = vehicleClasses.find((c) => c.code === pricingVehicleClass);
    const rates = resolveClassRates(pricingVehicleClass, pricingRow, legacy);
    const globalFloor =
      input.pricingModel === 'HOURLY' ? legacy.hourlyMinBaseCents : legacy.perKmMinBaseCents;
    const marketEstimateInc = quoteForModel({
      pricingModel: input.pricingModel,
      rates,
      distanceKm: route.distanceKm,
      billableHours: route.billableHours,
      hourlyMinFloorHours: config.hourlyMinFloorHours,
      globalHardFloorCents: globalFloor,
    });
    const gstRatePercent = config.gstPercent;
    const pickupStopForFloor =
      persistedStops.find((s) => s.stopType === 'PICKUP') ?? persistedStops[0] ?? null;
    const floored = await this.withHardFloorEstimate({
      marketEstimateIncGstCents: marketEstimateInc,
      gstPercent: gstRatePercent,
      vehicleClassCode: pricingVehicleClass,
      pricingModel: input.pricingModel,
      distanceKm: route.distanceKm,
      billableHours: route.billableHours,
      at: new Date(input.pickupAt),
      pickupState: pickupStopForFloor?.state ?? null,
      bodyCode: input.bodyCode,
      requiresReefer,
      requiresDg,
      backhaul: input.isBackhaul ?? false,
    });
    const estimate = floored.estimate;
    const origin = await this.resolveJobOrigin(persistedStops, user.company.homeRegionId);

    const job = await this.prisma.job.update({
      where: { id: existing.id },
      data: {
        pricingModel:
          input.pricingModel === 'HOURLY' ? JobPricingModel.HOURLY : JobPricingModel.PER_KM,
        title: input.title ?? existing.title ?? `${input.pricingModel} job`,
        originRegionId: origin.originRegionId,
        originTerritoryId: origin.originTerritoryId,
        receiverName: input.receiverName,
        receiverEmail: input.receiverEmail,
        receiverPhone: input.receiverPhone,
        receiverAltEmail: input.receiverAltEmail ?? null,
        receiverAltPhone: input.receiverAltPhone ?? null,
        pickupAt: new Date(input.pickupAt),
        deadWeightKg,
        lengthCm: input.lengthCm,
        widthCm: input.widthCm,
        heightCm: input.heightCm,
        chargeableWeightKg: Math.round(chargeable * 10) / 10,
        loadTypes: input.loadTypes,
        loadTypeSubtypes: input.loadTypeSubtypes ?? [],
        requiresDg,
        ...(dgDocumentId !== undefined ? { dgDocumentId } : {}),
        requiresReefer,
        requiresOversize,
        minVehicleClass: minClass,
        recommendedVehicleClass: recommended,
        pricingVehicleClass,
        siteManeuverability: input.siteManeuverability,
        siteFacility: input.siteFacility,
        siteDisclaimerAcceptedAt: new Date(),
        hourlyPattern: input.hourlyPattern ?? null,
        routeDistanceKm: route.distanceKm,
        routeDurationMinutes: route.totalDurationMinutes,
        routeFatigueBreakMinutes: route.fatigueBreakMinutes,
        billableHours: route.billableHours,
        estimateExGstCents: estimate.amountExGstCents,
        estimateGstCents: estimate.amountGstCents,
        estimateIncGstCents: estimate.amountIncGstCents,
        rateFloorVersionId: floored.rateFloorVersionId,
        rateFloorExGstCents: floored.rateFloorExGstCents,
        rateFloorIncGstCents: floored.rateFloorIncGstCents,
        rateFloorBreakdown:
          floored.rateFloorBreakdown != null
            ? (floored.rateFloorBreakdown as object)
            : undefined,
        isBackhaul: input.isBackhaul ?? false,
        stops: {
          deleteMany: {},
          create: persistedStops.map((s, index) => ({
            sequence: index,
            stopType: s.stopType,
            label: s.label,
            addressLine: s.addressLine,
            suburb: s.suburb,
            state: s.state,
            postcode: s.postcode,
            lat: s.lat,
            lng: s.lng,
            receiverName: s.receiverName,
            receiverEmail: s.receiverEmail,
            weightKg: s.weightKg ?? null,
          })),
        },
      },
      include: {
        stops: { orderBy: { sequence: 'asc' } },
        dgDocument: { select: { id: true, originalFilename: true } },
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.JOB_UPDATED,
      actorUserId: user.id,
      entityType: 'Job',
      entityId: job.id,
      metadata: {
        pricingModel: input.pricingModel,
        minClass,
        chargeable,
        editMode: 'FULL',
      },
    });

    if (this.rateFloor && floored.hardFloor && floored.rateFloorVersionId) {
      const fuelIndexId =
        typeof floored.hardFloor.breakdown?.fuelIndexId === 'string'
          ? floored.hardFloor.breakdown.fuelIndexId
          : null;
      await this.rateFloor.recordCheck({
        jobId: job.id,
        actorUserId: user.id,
        versionId: floored.rateFloorVersionId,
        fuelIndexId,
        inputs: {
          vehicleClassCode: pricingVehicleClass,
          pricingModel: input.pricingModel,
          distanceKm: route.distanceKm,
          billableHours: route.billableHours,
          source: 'JOB_UPDATE',
        },
        breakdown: floored.hardFloor.breakdown,
        floorExGstCents: floored.hardFloor.floorExGstCents,
        floorIncGstCents: floored.hardFloor.floorIncGstCents,
        offeredIncGstCents: estimate.amountIncGstCents,
        result: 'PASS',
      });
    }

    return { ...this.mapJob(job), editability: resolveJobEditMode(existing) };
  }

  async updateJobReceiver(
    principal: AuthenticatedPrincipal,
    jobId: string,
    input: JobReceiverUpdateInput,
  ) {
    this.ensureDatabase();
    const eligibility = await this.senderService.getBookingEligibility(principal);
    if (!eligibility.canDraft) {
      throw new ForbiddenException({
        message:
          'Sender cannot update jobs while the company is rejected or suspended. Open /sender/onboarding for status.',
        code: 'SENDER_NOT_DRAFT_READY',
        goNoGo: eligibility.goNoGo,
        href: '/sender/onboarding',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      include: { company: true },
    });
    if (!user?.company) throw new NotFoundException('Sender company not found');

    const existing = await this.loadJobForEdit(jobId, user.company.id);
    const editability = resolveJobEditMode(existing);
    if (editability.mode !== 'RECEIVER') {
      throw new BadRequestException({
        message: editability.reason,
        code: editability.mode === 'FULL' ? 'JOB_FULL_EDIT_AVAILABLE' : 'JOB_NOT_EDITABLE',
        editability,
      });
    }

    if (input.stops?.length) {
      const known = new Set(existing.stops.map((s) => s.id));
      for (const stop of input.stops) {
        if (!known.has(stop.id)) {
          throw new BadRequestException({
            message: `Stop ${stop.id} does not belong to this job`,
            code: 'JOB_STOP_NOT_FOUND',
          });
        }
      }
    }

    const job = await this.prisma.$transaction(async (tx) => {
      if (input.stops?.length) {
        for (const stop of input.stops) {
          await tx.jobStop.update({
            where: { id: stop.id },
            data: {
              ...(stop.receiverName !== undefined ? { receiverName: stop.receiverName } : {}),
              ...(stop.receiverEmail !== undefined ? { receiverEmail: stop.receiverEmail } : {}),
            },
          });
        }
      }
      return tx.job.update({
        where: { id: existing.id },
        data: {
          receiverName: input.receiverName,
          receiverEmail: input.receiverEmail,
          receiverPhone:
            input.receiverPhone === undefined ? undefined : input.receiverPhone,
          receiverAltEmail:
            input.receiverAltEmail === undefined ? undefined : input.receiverAltEmail,
          receiverAltPhone:
            input.receiverAltPhone === undefined ? undefined : input.receiverAltPhone,
        },
        include: {
          stops: { orderBy: { sequence: 'asc' } },
          dgDocument: { select: { id: true, originalFilename: true } },
        },
      });
    });

    await this.audit.recordPlatform({
      action: AuditAction.JOB_UPDATED,
      actorUserId: user.id,
      entityType: 'Job',
      entityId: job.id,
      metadata: { editMode: 'RECEIVER' },
    });

    return {
      ...this.mapJob(job),
      editability: resolveJobEditMode({
        ...existing,
        // receivers changed; mode unchanged
      }),
    };
  }

  async requestPublishJob(principal: AuthenticatedPrincipal, jobId: string) {
    this.ensureDatabase();
    const eligibility = await this.senderService.getBookingEligibility(principal);
    if (!eligibility.canDraft) {
      throw new ForbiddenException({
        message:
          'Sender cannot request publish while the company is rejected or suspended.',
        code: 'SENDER_NOT_DRAFT_READY',
        goNoGo: eligibility.goNoGo,
        href: '/sender/onboarding',
      });
    }
    if (eligibility.canPublishLive) {
      return {
        status: 'READY' as const,
        next: 'publish' as const,
        href: null as string | null,
        goNoGo: eligibility.goNoGo,
        job: await this.publishJob(principal, jobId),
      };
    }

    const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
    if (!user?.companyId) throw new NotFoundException('Sender company not found');

    const job = await this.prisma.job.findFirst({
      where: { id: jobId, senderCompanyId: user.companyId },
    });
    if (!job) throw new NotFoundException('Job not found');
    if (job.status !== JobStatus.DRAFT) {
      throw new BadRequestException('Only DRAFT jobs can request publish');
    }

    const updated = await this.prisma.job.update({
      where: { id: job.id },
      data: { publishRequestedAt: job.publishRequestedAt ?? new Date() },
      include: { stops: { orderBy: { sequence: 'asc' } } },
    });

    const waitingOps =
      eligibility.companyStatus === CompanyStatus.PENDING_REVIEW ||
      eligibility.companyStatus === CompanyStatus.PENDING_VERIFICATION;

    return {
      status: 'BLOCKED' as const,
      next: waitingOps ? ('waiting_ops' as const) : ('onboarding' as const),
      href: `/sender/onboarding?returnTo=${encodeURIComponent(`/jobs/${job.id}`)}`,
      goNoGo: eligibility.goNoGo,
      blockers: eligibility.blockers,
      job: this.mapJob(updated),
    };
  }

  async publishJob(principal: AuthenticatedPrincipal, jobId: string) {
    this.ensureDatabase();
    const eligibility = await this.senderService.getBookingEligibility(principal);
    if (!eligibility.canPublishLive) {
      throw new ForbiddenException({
        message:
          'Sender cannot publish live until Ops approve verification and invoice details are complete. Open /sender/onboarding to finish.',
        code: 'SENDER_NOT_BOOKING_READY',
        goNoGo: eligibility.goNoGo,
        blockers: eligibility.blockers,
        href: `/sender/onboarding?returnTo=${encodeURIComponent(`/jobs/${jobId}`)}`,
      });
    }
    const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
    if (!user?.companyId) throw new NotFoundException('Sender company not found');

    const job = await this.prisma.job.findFirst({
      where: { id: jobId, senderCompanyId: user.companyId },
      include: { stops: true, originRegion: true },
    });
    if (!job) throw new NotFoundException('Job not found');
    if (job.status !== JobStatus.DRAFT) {
      throw new BadRequestException('Only DRAFT jobs can be published');
    }
    if ((job as { originRegion?: { code?: string; enabled?: boolean } | null }).originRegion?.enabled === false) {
      const disabledCode =
        (job as { originRegion?: { code?: string } | null }).originRegion?.code ?? 'selected state';
      throw new BadRequestException({
        message: `Service region ${disabledCode} is not currently enabled on the platform`,
        code: 'REGION_NOT_ENABLED',
        state: disabledCode,
      });
    }
    if (!job.receiverEmail || !job.receiverName) {
      throw new BadRequestException('Receiver name + email required to publish');
    }
    if (!job.siteDisclaimerAcceptedAt) {
      throw new BadRequestException('Site disclaimer required');
    }
    if (!job.siteManeuverability || !job.siteFacility) {
      throw new BadRequestException('Site access assessment required');
    }

    // W3.2 — re-check hard floor at publish (fuel/version may have moved since draft).
    const config = await this.getPricingConfig();
    const pickupState =
      job.stops.find((s) => s.stopType === 'PICKUP')?.state ??
      job.stops[0]?.state ??
      null;
    const vehicleClassCode =
      job.pricingVehicleClass ?? job.minVehicleClass ?? job.recommendedVehicleClass;
    const offeredIncGstCents = job.estimateIncGstCents ?? 0;
    const floorUpdate: {
      rateFloorVersionId?: string | null;
      rateFloorExGstCents?: number | null;
      rateFloorIncGstCents?: number | null;
      rateFloorBreakdown?: object;
      estimateExGstCents?: number;
      estimateGstCents?: number;
      estimateIncGstCents?: number;
    } = {};

    if (vehicleClassCode && (job.pricingModel === 'PER_KM' || job.pricingModel === 'HOURLY')) {
      const floored = await this.withHardFloorEstimate({
        marketEstimateIncGstCents: offeredIncGstCents,
        gstPercent: config.gstPercent,
        vehicleClassCode,
        pricingModel: job.pricingModel,
        distanceKm: job.routeDistanceKm,
        billableHours: job.billableHours,
        at: job.pickupAt,
        pickupState,
        requiresReefer: job.requiresReefer,
        requiresDg: job.requiresDg,
        backhaul: job.isBackhaul ?? false,
      });
      floorUpdate.rateFloorVersionId = floored.rateFloorVersionId;
      floorUpdate.rateFloorExGstCents = floored.rateFloorExGstCents;
      floorUpdate.rateFloorIncGstCents = floored.rateFloorIncGstCents;
      if (floored.rateFloorBreakdown != null) {
        floorUpdate.rateFloorBreakdown = floored.rateFloorBreakdown as object;
      }
      floorUpdate.estimateExGstCents = floored.estimate.amountExGstCents;
      floorUpdate.estimateGstCents = floored.estimate.amountGstCents;
      floorUpdate.estimateIncGstCents = floored.estimate.amountIncGstCents;

      if (this.rateFloor && floored.hardFloor && floored.rateFloorVersionId) {
        const fuelIndexId =
          typeof floored.hardFloor.breakdown?.fuelIndexId === 'string'
            ? floored.hardFloor.breakdown.fuelIndexId
            : null;
        const belowFloor = offeredIncGstCents < floored.hardFloor.floorIncGstCents;
        await this.rateFloor.recordCheck({
          jobId: job.id,
          actorUserId: user.id,
          versionId: floored.rateFloorVersionId,
          fuelIndexId,
          inputs: {
            vehicleClassCode,
            pricingModel: job.pricingModel,
            distanceKm: job.routeDistanceKm,
            billableHours: job.billableHours,
            source: 'JOB_PUBLISH',
            offeredIncGstCents,
          },
          breakdown: floored.hardFloor.breakdown,
          floorExGstCents: floored.hardFloor.floorExGstCents,
          floorIncGstCents: floored.hardFloor.floorIncGstCents,
          offeredIncGstCents,
          result: belowFloor ? 'REJECT' : 'PASS',
        });
        if (belowFloor) {
          const minAud = (floored.hardFloor.floorIncGstCents / 100).toFixed(2);
          throw new BadRequestException({
            message: `Cannot publish below hard floor (A$${minAud} inc GST)`,
            code: 'PRICE_BELOW_FLOOR',
            floorExGstCents: floored.hardFloor.floorExGstCents,
            floorIncGstCents: floored.hardFloor.floorIncGstCents,
            versionId: floored.rateFloorVersionId,
          });
        }
      }
    }

    await this.prisma.job.update({
      where: { id: job.id },
      data: {
        status: JobStatus.PUBLISHED,
        publishedAt: new Date(),
        publishRequestedAt: null,
        ...floorUpdate,
      },
    });

    // Immediately open for bids (PUBLISHED is the publish event; BIDDING is market-open).
    const bidding = await this.prisma.job.update({
      where: { id: job.id },
      data: { status: JobStatus.BIDDING },
      include: { stops: { orderBy: { sequence: 'asc' } } },
    });

    await this.audit.recordPlatform({
      action: AuditAction.JOB_PUBLISHED,
      actorUserId: user.id,
      entityType: 'Job',
      entityId: job.id,
      metadata: {
        transition: 'DRAFT→PUBLISHED→BIDDING',
        rateFloorVersionId: floorUpdate.rateFloorVersionId ?? null,
        rateFloorIncGstCents: floorUpdate.rateFloorIncGstCents ?? null,
      },
    });

    void this.notifyEligibleCarriersOfPublish(job.id).catch((error: unknown) => {
      this.logger.warn(
        `Job publish carrier notify failed for ${job.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    return this.mapJob(bidding);
  }

  /**
   * Phase 1 marketplace broadcast: email BID_ELIGIBLE carriers that would
   * see this job on the market board (same carrierMatchesJob rules).
   */
  private async notifyEligibleCarriersOfPublish(jobId: string) {
    if (!this.notifications && !this.inbox) return;

    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      include: { originRegion: true },
    });
    if (!job || (job.status !== JobStatus.BIDDING && job.status !== JobStatus.PUBLISHED)) {
      return;
    }

    const carriers = await this.prisma.company.findMany({
      where: {
        type: CompanyType.CARRIER,
        status: CompanyStatus.BID_ELIGIBLE,
      },
      include: {
        homeRegion: true,
        referredByAdminUser: {
          select: {
            scopes: {
              select: {
                region: { select: { code: true } },
                localTerritory: {
                  select: { region: { select: { code: true } } },
                },
              },
            },
          },
        },
        vehicles: true,
        users: {
          where: { role: PlatformRole.TRANSPORT_COMPANY },
          select: { id: true, email: true },
        },
      },
    });

    const vehicleClasses = await this.getActiveVehicleClasses();
    const emails: string[] = [];
    const userIds: string[] = [];
    for (const company of carriers) {
      if (!carrierMatchesJob(company, job, vehicleClasses)) continue;
      for (const u of company.users) {
        if (u.id) userIds.push(u.id);
        const email = u.email?.trim();
        if (email) emails.push(email);
        if (emails.length >= MAX_JOB_PUBLISH_CARRIER_EMAILS) break;
      }
      if (emails.length >= MAX_JOB_PUBLISH_CARRIER_EMAILS) break;
    }

    const jobLabel = job.title || job.id.slice(0, 8);
    if (this.inbox && userIds.length > 0) {
      const inboxCount = await this.inbox.notifyUsers({
        userIds,
        type: NotificationType.JOB_PUBLISHED,
        title: `New job on the market: ${jobLabel}`,
        body: 'A matching load is open for bids. Open the market board to review.',
        href: '/market',
        entityType: 'Job',
        entityId: job.id,
      });
      this.logger.log(`Job ${job.id} publish in-app notified ${inboxCount} carrier user(s)`);
    }

    if (!this.notifications || emails.length === 0) return;

    const result = await this.notifications.notifyJobPublishedToCarriers({
      carrierEmails: emails,
      jobId: job.id,
      jobTitle: job.title ?? '',
      minVehicleClass: job.minVehicleClass,
      originRegionCode: job.originRegion?.code ?? null,
      pickupAt: job.pickupAt,
      estimateIncGstCents: job.estimateIncGstCents,
      requiresDg: job.requiresDg,
    });
    this.logger.log(
      `Job ${job.id} publish emailed ${result.notified} eligible carrier mailbox(es)`,
    );
  }

  async acceptProposal(principal: AuthenticatedPrincipal, jobId: string, proposalId: string) {
    return this.payments.acceptProposal(principal, jobId, proposalId);
  }

  async previewProposalCharge(
    principal: AuthenticatedPrincipal,
    jobId: string,
    proposalId: string,
  ) {
    return this.payments.previewProposalCharge(principal, jobId, proposalId);
  }

  async cancelJob(principal: AuthenticatedPrincipal, jobId: string) {
    this.ensureDatabase();
    const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
    if (!user?.companyId) throw new NotFoundException('Sender company not found');

    const job = await this.prisma.job.findFirst({
      where: { id: jobId, senderCompanyId: user.companyId },
      include: {
        assignment: true,
        proposals: {
          where: { status: ProposalStatus.SUBMITTED },
          include: {
            carrierCompany: {
              include: {
                users: {
                  where: { role: PlatformRole.TRANSPORT_COMPANY },
                  select: { id: true, email: true },
                },
              },
            },
          },
        },
      },
    });
    if (!job) throw new NotFoundException('Job not found');

    if (job.status === JobStatus.CANCELLED) {
      throw new BadRequestException('Job is already cancelled');
    }
    if (job.status === JobStatus.COMPLETED) {
      throw new BadRequestException('Cannot cancel a completed job');
    }
    if (job.assignment && job.assignment.status === AssignmentStatus.LOCKED) {
      throw new BadRequestException(
        'Cannot cancel job after assignment is confirmed and locked. Please contact support.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.job.update({
        where: { id: job.id },
        data: { status: JobStatus.CANCELLED },
      });

      if (job.assignment) {
        await tx.assignment.update({
          where: { id: job.assignment.id },
          data: { status: AssignmentStatus.CANCELLED },
        });
      }

      if (job.proposals.length > 0) {
        await tx.proposal.updateMany({
          where: {
            jobId: job.id,
            status: ProposalStatus.SUBMITTED,
          },
          data: { status: ProposalStatus.EXPIRED },
        });
      }
    });

    await this.audit.recordPlatform({
      action: AuditAction.JOB_CANCELLED,
      actorUserId: user.id,
      entityType: 'Job',
      entityId: job.id,
      metadata: {
        previousStatus: job.status,
        expiredProposalsCount: job.proposals.length,
      },
    });

    try {
      if (this.inbox && job.proposals.length > 0) {
        const title = job.title ?? 'Job';
        const carrierUserIds = job.proposals.flatMap((p) => p.carrierCompany.users.map((u) => u.id));
        if (carrierUserIds.length > 0) {
          void this.inbox.notifyUsers({
            userIds: carrierUserIds,
            type: NotificationType.JOB_PUBLISHED,
            title: `Job cancelled: ${title}`,
            body: 'The sender has cancelled this job. Your submitted bid has been closed and your vehicle/driver released.',
            href: '/carrier/market',
            entityType: 'Job',
            entityId: job.id,
          });
        }
      }
    } catch (err) {
      this.logger.warn(`Failed to notify carriers of cancelled job ${job.id}: ${err}`);
    }

    return { id: job.id, status: JobStatus.CANCELLED };
  }

  /** Used by matching board eligibility */
  async assertJobOpenForBidding(jobId: string) {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      include: {
        stops: true,
        originRegion: true,
        senderCompany: { include: { homeRegion: true } },
      },
    });
    if (!job) throw new NotFoundException('Job not found');
    if (job.status !== JobStatus.BIDDING && job.status !== JobStatus.PUBLISHED) {
      throw new BadRequestException('Job is not open for bidding');
    }
    return job;
  }
}
