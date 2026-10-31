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
import { NotificationType } from '@prisma/client';
import { resolveJobEditMode } from './job-edit-mode';
import {
  carrierNetPayoutCents,
  chargeableWeightKg,
  gstSplitFromIncCents,
  isVehicleClassAdequate,
  recommendVehicleClass,
} from './job-pricing.util';
import { estimateRoute, orderStopsTspObjects, routeFromDistanceKm } from './routing.mock';

/** Soft cap so one publish cannot fan out unbounded SMTP work. */
const MAX_JOB_PUBLISH_CARRIER_EMAILS = 200;

const DEFAULT_MIN_BASE_CENTS = {
  PER_KM: 5_000,
  HOURLY: 20_000,
} as const;

/** Map AU state abbreviations on stops → Region.code */
const AU_STATE_CODES = new Set(['VIC', 'NSW', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']);

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
      carrierCompany?: {
        id: string;
        legalName: string;
        tradingName?: string | null;
        email?: string | null;
        phone?: string | null;
        abn?: string | null;
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
      openProposalCount,
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
          netToCarrierCents: carrierNetPayoutCents(p.amountIncGstCents),
          createdAt: p.createdAt,
        };
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
        proposals: {
          where: { status: { in: [ProposalStatus.SUBMITTED, ProposalStatus.ACCEPTED, ProposalStatus.EXPIRED] } },
          include: {
            vehicle: true,
            carrierCompany: {
              select: {
                id: true,
                legalName: true,
                tradingName: true,
                email: true,
                phone: true,
                abn: true,
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
        paymentEvents: { orderBy: { createdAt: 'desc' }, take: 3 },
      },
    });
    if (!job) throw new NotFoundException('Job not found');
    const editability = resolveJobEditMode(job);
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
            paidAndConfirmed: job.assignment.status === AssignmentStatus.LOCKED,
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
        message:
          'Sender cannot create jobs until Ops approve + invoice + payment ready. Open /sender/onboarding to add a live card if payment is missing.',
        code: 'SENDER_NOT_BOOKING_READY',
        goNoGo: eligibility.goNoGo,
        href: '/sender/onboarding',
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
    if (!eligibility.canBook) {
      throw new ForbiddenException({
        message:
          'Sender cannot update jobs until Ops approve + invoice + payment ready. Open /sender/onboarding to add a live card if payment is missing.',
        code: 'SENDER_NOT_BOOKING_READY',
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
      metadata: {
        pricingModel: input.pricingModel,
        minClass,
        chargeable,
        editMode: 'FULL',
      },
    });

    return { ...this.mapJob(job), editability: resolveJobEditMode(existing) };
  }

  async updateJobReceiver(
    principal: AuthenticatedPrincipal,
    jobId: string,
    input: JobReceiverUpdateInput,
  ) {
    this.ensureDatabase();
    const eligibility = await this.senderService.getBookingEligibility(principal);
    if (!eligibility.canBook) {
      throw new ForbiddenException({
        message:
          'Sender cannot update jobs until Ops approve + invoice + payment ready. Open /sender/onboarding to add a live card if payment is missing.',
        code: 'SENDER_NOT_BOOKING_READY',
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
        },
        include: { stops: { orderBy: { sequence: 'asc' } } },
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

  async publishJob(principal: AuthenticatedPrincipal, jobId: string) {
    this.ensureDatabase();
    const eligibility = await this.senderService.getBookingEligibility(principal);
    if (!eligibility.canBook) {
      throw new ForbiddenException({
        message:
          'Sender cannot publish jobs until payment is ready. Open /sender/onboarding to add a live card if needed.',
        code: 'SENDER_NOT_BOOKING_READY',
        goNoGo: eligibility.goNoGo,
        href: '/sender/onboarding',
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
        vehicles: true,
        users: {
          where: { role: PlatformRole.TRANSPORT_COMPANY },
          select: { id: true, email: true },
        },
      },
    });

    const emails: string[] = [];
    const userIds: string[] = [];
    for (const company of carriers) {
      if (!carrierMatchesJob(company, job)) continue;
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
