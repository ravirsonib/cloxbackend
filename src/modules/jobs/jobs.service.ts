import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CompanyType,
  JobPricingModel,
  JobStatus,
  ProposalStatus,
  TripExceptionStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import {
  AuditAction,
  type JobCreateInput,
  type JobRouteEstimateInput,
} from '../../shared/types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PaymentsService } from '../payments/payments.service';
import { SenderService } from '../sender/sender.service';
import {
  carrierNetPayoutCents,
  chargeableWeightKg,
  gstSplitFromIncCents,
  isVehicleClassAdequate,
  recommendVehicleClass,
} from './job-pricing.util';
import { estimateRoute, orderStopsTspObjects, routeFromDistanceKm } from './routing.mock';

const DEFAULT_MIN_BASE_CENTS = {
  PER_KM: 5_000,
  HOURLY: 20_000,
} as const;

/** Map AU state abbreviations on stops → Region.code */
const AU_STATE_CODES = new Set(['VIC', 'NSW', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']);

@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly senderService: SenderService,
    private readonly payments: PaymentsService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  /**
   * Matching + commission origin from primary pickup stop state when known;
   * falls back to sender company home region. Territory = enabled territory
   * in that region (MEL preferred for VIC when present).
   */
  private async resolveJobOrigin(
    stops: Array<{ stopType: string; state: string | null }>,
    fallbackRegionId: string | null,
  ): Promise<{ originRegionId: string | null; originTerritoryId: string | null }> {
    const pickup =
      stops.find((s) => s.stopType === 'PICKUP') ?? stops[0] ?? null;
    const stateCode = pickup?.state?.trim().toUpperCase() ?? null;

    let originRegionId = fallbackRegionId;
    if (stateCode && AU_STATE_CODES.has(stateCode)) {
      const region = await this.prisma.region.findUnique({ where: { code: stateCode } });
      if (region) originRegionId = region.id;
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
    const preferred =
      territories.find((t) => t.code === 'MEL') ?? territories[0];
    return { originRegionId, originTerritoryId: preferred.id };
  }

  async getMinBaseCents(pricingModel: 'PER_KM' | 'HOURLY'): Promise<number> {
    const policy = await this.prisma.policyVersion.findFirst({
      where: { key: 'MIN_BASE_FARE', publishedAt: { not: null } },
      orderBy: { version: 'desc' },
    });
    const payload = (policy?.payload ?? {}) as Record<string, number>;
    if (pricingModel === 'HOURLY') {
      return payload.hourlyMinCents ?? DEFAULT_MIN_BASE_CENTS.HOURLY;
    }
    return payload.perKmMinCents ?? DEFAULT_MIN_BASE_CENTS.PER_KM;
  }

  private mapJob(job: {
    id: string;
    status: JobStatus;
    pricingModel: JobPricingModel;
    title: string | null;
    receiverName: string | null;
    receiverEmail: string | null;
    receiverPhone: string | null;
    pickupAt: Date | null;
    deadWeightKg: number | null;
    lengthCm: number | null;
    widthCm: number | null;
    heightCm: number | null;
    chargeableWeightKg: number | null;
    loadTypes: string[];
    requiresDg: boolean;
    requiresReefer: boolean;
    requiresOversize: boolean;
    minVehicleClass: string | null;
    recommendedVehicleClass: string | null;
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
      createdAt: Date;
    }>;
  }) {
    return {
      id: job.id,
      status: job.status,
      pricingModel: job.pricingModel,
      title: job.title,
      receiverName: job.receiverName,
      receiverEmail: job.receiverEmail,
      receiverPhone: job.receiverPhone,
      pickupAt: job.pickupAt,
      deadWeightKg: job.deadWeightKg,
      lengthCm: job.lengthCm,
      widthCm: job.widthCm,
      heightCm: job.heightCm,
      chargeableWeightKg: job.chargeableWeightKg,
      loadTypes: job.loadTypes,
      requiresDg: job.requiresDg,
      requiresReefer: job.requiresReefer,
      requiresOversize: job.requiresOversize,
      minVehicleClass: job.minVehicleClass,
      recommendedVehicleClass: job.recommendedVehicleClass,
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
      publishedAt: job.publishedAt,
      createdAt: job.createdAt,
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
      })),
      proposals: (job.proposals ?? []).map((p, idx) => ({
        id: p.id,
        status: p.status,
        amountIncGstCents: p.amountIncGstCents,
        amountExGstCents: p.amountExGstCents,
        amountGstCents: p.amountGstCents,
        etaMinutes: p.etaMinutes,
        vehicleClass: p.vehicle?.vehicleClass ?? null,
        vehicleLabel: p.vehicle?.label ?? p.vehicle?.registration ?? null,
        /** Mask carrier company name for sender (policy stub) */
        carrierLabel: `Carrier ${String.fromCharCode(65 + (idx % 26))}`,
        carrierCompanyIdMasked: true,
        netToCarrierCents: carrierNetPayoutCents(p.amountIncGstCents),
        createdAt: p.createdAt,
      })),
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
      include: { stops: { orderBy: { sequence: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return jobs.map((j) => this.mapJob(j));
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
        proposals: {
          where: { status: { in: [ProposalStatus.SUBMITTED, ProposalStatus.ACCEPTED, ProposalStatus.EXPIRED] } },
          include: { vehicle: true },
          orderBy: { createdAt: 'asc' },
        },
        assignment: true,
        paymentEvents: { orderBy: { createdAt: 'desc' }, take: 3 },
      },
    });
    if (!job) throw new NotFoundException('Job not found');
    const openException = await this.prisma.tripException.findFirst({
      where: {
        jobId: job.id,
        status: {
          in: [
            TripExceptionStatus.OPEN,
            TripExceptionStatus.AWAITING_CARRIER,
            TripExceptionStatus.REASSIGN_IN_PROGRESS,
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
      },
    });
    const mapped = this.mapJob(job);
    return {
      ...mapped,
      assignment: job.assignment
        ? {
            id: job.assignment.id,
            status: job.assignment.status,
            lockedAt: job.assignment.lockedAt,
            paidAndConfirmed: job.assignment.status === 'LOCKED',
          }
        : null,
      payment: job.paymentEvents[0]
        ? {
            id: job.paymentEvents[0].id,
            status: job.paymentEvents[0].status,
            amountIncGstCents: job.paymentEvents[0].amountIncGstCents,
            stripePaymentIntentId: job.paymentEvents[0].stripePaymentIntentId,
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
          }
        : null,
    };
  }

  /**
   * Suggest distance/duration from pickup + drop (mock Valhalla until real client is wired).
   * Does not persist; sender may edit the suggested km on create/update.
   */
  previewRoute(input: JobRouteEstimateInput) {
    const sortedStops = input.stops.slice().sort((a, b) => a.sequence - b.sequence);
    const orderedStops =
      input.pricingModel === 'HOURLY' && sortedStops.length > 2
        ? orderStopsTspObjects(sortedStops)
        : sortedStops;
    const route = estimateRoute({
      stops: orderedStops.map((s) => ({ lat: s.lat, lng: s.lng })),
      pricingModel: input.pricingModel,
    });
    return {
      distanceKm: route.distanceKm,
      durationMinutes: route.totalDurationMinutes,
      drivingMinutes: route.drivingMinutes,
      fatigueBreakMinutes: route.fatigueBreakMinutes,
      billableHours: route.billableHours,
      mock: route.mock,
    };
  }

  async createJob(principal: AuthenticatedPrincipal, input: JobCreateInput) {
    this.ensureDatabase();
    const eligibility = await this.senderService.getBookingEligibility(principal);
    if (!eligibility.canBook) {
      throw new ForbiddenException({
        message: 'Sender cannot create jobs until Ops approve + invoice + payment ready',
        code: 'SENDER_NOT_BOOKING_READY',
        goNoGo: eligibility.goNoGo,
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      include: { company: { include: { homeRegion: true } } },
    });
    if (!user?.company) throw new NotFoundException('Sender company not found');

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

    const chargeable = chargeableWeightKg({
      deadWeightKg: input.deadWeightKg,
      lengthCm: input.lengthCm,
      widthCm: input.widthCm,
      heightCm: input.heightCm,
    });
    const recommended = recommendVehicleClass(chargeable);
    const minClass = input.minVehicleClass ?? recommended;
    if (!isVehicleClassAdequate(minClass, recommended)) {
      throw new BadRequestException({
        message: `Vehicle class ${minClass} is undersized for chargeable ${chargeable.toFixed(1)} kg (min ${recommended})`,
        code: 'VEHICLE_CLASS_UNDERSIZE',
        recommended,
        chargeableWeightKg: chargeable,
      });
    }

    const requiresDg = input.loadTypes.includes('DG');
    const requiresReefer = input.loadTypes.includes('REEFER');
    const requiresOversize = input.loadTypes.includes('OVERSIZE');

    const sortedStops = input.stops.slice().sort((a, b) => a.sequence - b.sequence);
    const persistedStops =
      input.pricingModel === 'HOURLY' && sortedStops.length > 2
        ? orderStopsTspObjects(sortedStops)
        : sortedStops;
    // Sender-entered km is source of truth; suggestion is UI-only via previewRoute.
    const route = routeFromDistanceKm(input.distanceKm, input.pricingModel);

    const minBase = await this.getMinBaseCents(input.pricingModel);
    let estimateInc = minBase;
    if (input.pricingModel === 'PER_KM') {
      estimateInc = Math.max(minBase, Math.round(route.distanceKm * 250));
    } else {
      estimateInc = Math.max(minBase, Math.round((route.billableHours ?? 4) * 8_000));
    }
    const estimate = gstSplitFromIncCents(estimateInc);

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
        pickupAt: new Date(input.pickupAt),
        deadWeightKg: input.deadWeightKg,
        lengthCm: input.lengthCm,
        widthCm: input.widthCm,
        heightCm: input.heightCm,
        chargeableWeightKg: Math.round(chargeable * 10) / 10,
        loadTypes: input.loadTypes,
        requiresDg,
        requiresReefer,
        requiresOversize,
        minVehicleClass: minClass,
        recommendedVehicleClass: recommended,
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
          })),
        },
      },
      include: { stops: { orderBy: { sequence: 'asc' } } },
    });

    await this.audit.recordPlatform({
      action: AuditAction.JOB_CREATED,
      actorUserId: user.id,
      entityType: 'Job',
      entityId: job.id,
      metadata: { pricingModel: input.pricingModel, minClass, chargeable },
    });

    return this.mapJob(job);
  }

  async updateJob(principal: AuthenticatedPrincipal, jobId: string, input: JobCreateInput) {
    this.ensureDatabase();
    const eligibility = await this.senderService.getBookingEligibility(principal);
    if (!eligibility.canBook) {
      throw new ForbiddenException({
        message: 'Sender cannot update jobs until Ops approve + invoice + payment ready',
        code: 'SENDER_NOT_BOOKING_READY',
        goNoGo: eligibility.goNoGo,
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      include: { company: { include: { homeRegion: true } } },
    });
    if (!user?.company) throw new NotFoundException('Sender company not found');

    const existing = await this.prisma.job.findFirst({
      where: { id: jobId, senderCompanyId: user.company.id },
    });
    if (!existing) throw new NotFoundException('Job not found');
    if (existing.status !== JobStatus.DRAFT) {
      throw new BadRequestException('Only DRAFT jobs can be edited');
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

    const chargeable = chargeableWeightKg({
      deadWeightKg: input.deadWeightKg,
      lengthCm: input.lengthCm,
      widthCm: input.widthCm,
      heightCm: input.heightCm,
    });
    const recommended = recommendVehicleClass(chargeable);
    const minClass = input.minVehicleClass ?? recommended;
    if (!isVehicleClassAdequate(minClass, recommended)) {
      throw new BadRequestException({
        message: `Vehicle class ${minClass} is undersized for chargeable ${chargeable.toFixed(1)} kg (min ${recommended})`,
        code: 'VEHICLE_CLASS_UNDERSIZE',
        recommended,
        chargeableWeightKg: chargeable,
      });
    }

    const requiresDg = input.loadTypes.includes('DG');
    const requiresReefer = input.loadTypes.includes('REEFER');
    const requiresOversize = input.loadTypes.includes('OVERSIZE');

    const sortedStops = input.stops.slice().sort((a, b) => a.sequence - b.sequence);
    const persistedStops =
      input.pricingModel === 'HOURLY' && sortedStops.length > 2
        ? orderStopsTspObjects(sortedStops)
        : sortedStops;
    const route = routeFromDistanceKm(input.distanceKm, input.pricingModel);

    const minBase = await this.getMinBaseCents(input.pricingModel);
    let estimateInc = minBase;
    if (input.pricingModel === 'PER_KM') {
      estimateInc = Math.max(minBase, Math.round(route.distanceKm * 250));
    } else {
      estimateInc = Math.max(minBase, Math.round((route.billableHours ?? 4) * 8_000));
    }
    const estimate = gstSplitFromIncCents(estimateInc);
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
        pickupAt: new Date(input.pickupAt),
        deadWeightKg: input.deadWeightKg,
        lengthCm: input.lengthCm,
        widthCm: input.widthCm,
        heightCm: input.heightCm,
        chargeableWeightKg: Math.round(chargeable * 10) / 10,
        loadTypes: input.loadTypes,
        requiresDg,
        requiresReefer,
        requiresOversize,
        minVehicleClass: minClass,
        recommendedVehicleClass: recommended,
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
          })),
        },
      },
      include: { stops: { orderBy: { sequence: 'asc' } } },
    });

    await this.audit.recordPlatform({
      action: AuditAction.JOB_UPDATED,
      actorUserId: user.id,
      entityType: 'Job',
      entityId: job.id,
      metadata: { pricingModel: input.pricingModel, minClass, chargeable },
    });

    return this.mapJob(job);
  }

  async publishJob(principal: AuthenticatedPrincipal, jobId: string) {
    this.ensureDatabase();
    const eligibility = await this.senderService.getBookingEligibility(principal);
    if (!eligibility.canBook) {
      throw new ForbiddenException({
        message: 'Sender cannot publish jobs',
        code: 'SENDER_NOT_BOOKING_READY',
        goNoGo: eligibility.goNoGo,
      });
    }
    const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
    if (!user?.companyId) throw new NotFoundException('Sender company not found');

    const job = await this.prisma.job.findFirst({
      where: { id: jobId, senderCompanyId: user.companyId },
      include: { stops: true },
    });
    if (!job) throw new NotFoundException('Job not found');
    if (job.status !== JobStatus.DRAFT) {
      throw new BadRequestException('Only DRAFT jobs can be published');
    }
    if (!job.receiverEmail || !job.receiverName) {
      throw new BadRequestException('Receiver name + email required to publish');
    }
    if (!job.siteDisclaimerAcceptedAt) {
      throw new BadRequestException('Site disclaimer required');
    }

    await this.prisma.job.update({
      where: { id: job.id },
      data: {
        status: JobStatus.PUBLISHED,
        publishedAt: new Date(),
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
      metadata: { transition: 'DRAFT→PUBLISHED→BIDDING' },
    });

    return this.mapJob(bidding);
  }

  async acceptProposal(principal: AuthenticatedPrincipal, jobId: string, proposalId: string) {
    return this.payments.acceptProposal(principal, jobId, proposalId);
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
