import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AssignmentStatus,
  CompanyType,
  ComplianceDocStatus,
  ComplianceDocType,
  DriverStatus,
  JobStatus,
  NotificationType,
  PlatformRole,
  ProposalStatus,
  TripStatus,
  VehicleStatus,
} from '@prisma/client';
import {
  assertUnitsComplete,
  defaultCombinationConfigForClass,
  RWC_BID_READY_STATUSES,
  type CombinationConfigCode,
  type VehicleUnitRoleCode,
} from '../carrier/vehicle-units.util';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AuditAction, type ProposalSubmitInput } from '../../shared/types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CarrierService } from '../carrier/carrier.service';
import { JobsService } from '../jobs/jobs.service';
import { RateFloorService } from '../rate-floor/rate-floor.service';
import { InAppNotificationsService } from '../notifications/in-app-notifications.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  assertAssignmentCompliance,
  evaluateDriverLicenceFields,
} from '../jobs/assignment-gates';
import { buildStopLoadProfile } from '../jobs/job-stop-load.util';
import {
  assertCrewNotBusyElsewhere,
  assertDriverAvailabilityForWindow,
  calculateJobExecutionWindow,
  checkDriverAvailabilityForWindow,
} from './driver-schedule.util';
import {
  DEFAULT_VEHICLE_CLASSES,
  gstSplitFromIncCents,
  isVehicleAdequateForJob,
  isVehicleClassAdequate,
  loadVehicleClassMaps,
  type VehicleClassSpec,
} from '../jobs/job-pricing.util';
import {
  expectedCarrierNetFromProposalBase,
  minCarrierNetClearingProposalBase,
  proposalBaseFromTargetCarrierNet,
  type SenderPlatformFeeMode,
} from '../settlements/revenue-split.types';
import { carrierMatchesJob } from './matching.eligibility';
import { resolveProposalMinBaseCents } from './proposal-min-base.util';

@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly carrierService: CarrierService,
    private readonly jobsService: JobsService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly inbox?: InAppNotificationsService,
    @Optional() private readonly revenueSplit?: import('../settlements/revenue-split.service').RevenueSplitService,
    @Optional() private readonly rateFloor?: RateFloorService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  private async getActiveVehicleClasses(): Promise<VehicleClassSpec[]> {
    if (typeof this.jobsService?.getActiveVehicleClasses === 'function') {
      return this.jobsService.getActiveVehicleClasses();
    }
    return DEFAULT_VEHICLE_CLASSES;
  }

  private async getPlatformGstPercent(): Promise<number> {
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

  /**
   * Live hard floor for the bid vehicle class, falling back to job snapshot.
   */
  private async resolveHardFloorForBid(params: {
    job: {
      id: string;
      routeDistanceKm: number | null;
      billableHours: number | null;
      pickupAt: Date | null;
      dropoffWindowStart?: string | null;
      dropoffWindowEnd?: string | null;
      requiresReefer: boolean;
      requiresDg: boolean;
      isBackhaul?: boolean | null;
      rateFloorIncGstCents?: number | null;
      rateFloorExGstCents?: number | null;
      rateFloorVersionId?: string | null;
      rateFloorBreakdown?: unknown;
      stops?: Array<{ stopType: string; state?: string | null }>;
    };
    vehicleClass: string;
    pricingModel: 'PER_KM' | 'HOURLY';
  }): Promise<{
    hardFloorInc: number | null;
    hardFloorEx: number | null;
    hardFloorVersionId: string | null;
    hardFloorBreakdown: Record<string, unknown> | null;
  }> {
    let hardFloorInc: number | null =
      params.job.rateFloorIncGstCents != null && params.job.rateFloorIncGstCents > 0
        ? params.job.rateFloorIncGstCents
        : null;
    let hardFloorEx: number | null = params.job.rateFloorExGstCents ?? null;
    let hardFloorVersionId: string | null = params.job.rateFloorVersionId ?? null;
    let hardFloorBreakdown: Record<string, unknown> | null =
      (params.job.rateFloorBreakdown as Record<string, unknown> | null) ?? null;
    if (this.rateFloor) {
      try {
        const pickupStop =
          params.job.stops?.find((s) => s.stopType === 'PICKUP') ??
          params.job.stops?.[0] ??
          null;
        const floor = await this.rateFloor.calculate({
          vehicleClassCode: params.vehicleClass,
          pricingModel: params.pricingModel,
          distanceKm: params.job.routeDistanceKm ?? 0,
          billableHours: params.job.billableHours,
          at: params.job.pickupAt,
          pickupState: pickupStop?.state ?? null,
          requiresReefer: params.job.requiresReefer,
          requiresDg: params.job.requiresDg,
          backhaul: params.job.isBackhaul,
          jobId: params.job.id,
        });
        hardFloorInc = floor.floorIncGstCents;
        hardFloorEx = floor.floorExGstCents;
        hardFloorVersionId = floor.versionId;
        hardFloorBreakdown = floor.breakdown;
      } catch {
        // Keep job snapshot when live calc fails.
      }
    }
    return { hardFloorInc, hardFloorEx, hardFloorVersionId, hardFloorBreakdown };
  }

  /**
   * Carrier-facing bid minimum for a job + vehicle (same formula as submitProposal).
   */
  async previewBidMinimum(
    principal: AuthenticatedPrincipal,
    jobId: string,
    vehicleId: string,
  ) {
    this.ensureDatabase();
    const eligibility = await this.carrierService.getBidEligibility(principal);
    if (!eligibility.canBid) {
      throw new ForbiddenException({
        message: 'Carrier cannot preview bid minimum until bid-eligible',
        code: 'CARRIER_NOT_BID_ELIGIBLE',
        goNoGo: eligibility.goNoGo,
      });
    }
    const user = await this.requireCarrierCompany(principal);
    const company = user.company!;
    const job = await this.jobsService.assertJobOpenForBidding(jobId);
    const vehicle = await this.prisma.vehicle.findFirst({
      where: {
        id: vehicleId,
        companyId: company.id,
        status: VehicleStatus.ACTIVE,
      },
      select: { id: true, vehicleClass: true },
    });
    if (!vehicle?.vehicleClass) {
      throw new BadRequestException({
        message: 'Active vehicle with class required',
        code: 'VEHICLE_NOT_ACTIVE',
      });
    }
    const vehicleClass = vehicle.vehicleClass;
    const pricingModel = job.pricingModel === 'HOURLY' ? 'HOURLY' : 'PER_KM';
    const floorResolved = await this.resolveHardFloorForBid({
      job,
      vehicleClass,
      pricingModel,
    });
    const globalFloor = await this.jobsService.getMinBaseCents(pricingModel);
    const classQuote = await this.jobsService.quoteForVehicleClass({
      pricingModel,
      vehicleClass,
      distanceKm: job.routeDistanceKm ?? 0,
      billableHours: job.billableHours,
    });
    const minBidIncGstCents = resolveProposalMinBaseCents({
      globalFloorCents: globalFloor,
      classQuoteIncGstCents: classQuote.estimateIncGstCents,
      hardFloorIncGstCents: floorResolved.hardFloorInc,
      estimateIncGstCents: job.estimateIncGstCents,
      rescueDiscountPercent: job.rescueDiscountPercent,
    });

    const carrierPercent = this.revenueSplit
      ? (
          await this.revenueSplit.resolvePercents({
            referredByAdminUserId: null,
            carrierCompanyId: company.id,
            at: new Date(),
          })
        ).percents.carrierPercent
      : 70;
    let feePercent = 0;
    let feeMode: SenderPlatformFeeMode = 'EXCLUSIVE';
    if (this.revenueSplit) {
      const fee = await this.revenueSplit.resolveSenderFee({
        baseIncGstCents: minBidIncGstCents || 10_000,
        senderCompanyId: job.senderCompanyId,
      });
      feePercent = fee.feePercent;
      feeMode = fee.mode;
    }
    const minBidNetToCarrierCents = minCarrierNetClearingProposalBase({
      minBaseIncGstCents: minBidIncGstCents,
      carrierPercent,
      feePercent,
      feeMode,
    });
    return {
      jobId: job.id,
      vehicleId: vehicle.id,
      vehicleClass,
      minBidIncGstCents,
      minBidNetToCarrierCents,
      rateFloorIncGstCents: floorResolved.hardFloorInc,
      rateFloorVersionId: floorResolved.hardFloorVersionId,
      carrierPercent,
      feePercent,
      feeMode,
    };
  }

  private async requireCarrierCompany(principal: AuthenticatedPrincipal) {
    if (principal.kind !== 'user' || principal.role !== 'TRANSPORT_COMPANY') {
      throw new ForbiddenException('Carrier required');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      include: {
        company: {
          include: {
            vehicles: true,
            drivers: true,
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
          },
        },
      },
    });
    if (!user?.company || user.company.type !== CompanyType.CARRIER) {
      throw new NotFoundException('Carrier company not found');
    }
    return user;
  }

  async listBoard(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const eligibility = await this.carrierService.getBidEligibility(principal);
    if (!eligibility.canBid) {
      throw new ForbiddenException({
        message: 'Carrier cannot view job board until bid-eligible',
        code: 'CARRIER_NOT_BID_ELIGIBLE',
        goNoGo: eligibility.goNoGo,
      });
    }
    const user = await this.requireCarrierCompany(principal);
    const company = user.company!;

    const jobs = await this.prisma.job.findMany({
      where: { status: { in: [JobStatus.BIDDING, JobStatus.PUBLISHED] } },
      include: {
        stops: { orderBy: { sequence: 'asc' }, take: 4 },
        dgDocument: { select: { id: true, originalFilename: true } },
        originRegion: true,
        rateFloorVersion: { select: { id: true, label: true } },
        proposals: {
          where: {
            carrierCompanyId: company.id,
            status: ProposalStatus.SUBMITTED,
          },
          select: { id: true, amountIncGstCents: true },
          take: 1,
        },
      },
      orderBy: [{ marketplacePriority: 'desc' }, { publishedAt: 'desc' }],
      take: 50,
    });

    const vehicleClasses = await this.getActiveVehicleClasses();
    const visible = jobs.filter((j) => carrierMatchesJob(company, j, vehicleClasses));
    const reliabilityScore = company.reliabilityScore ?? 100;
    const reliabilityTier =
      reliabilityScore >= 90
        ? 'EXCELLENT'
        : reliabilityScore >= 75
          ? 'GOOD'
          : reliabilityScore >= 60
            ? 'FAIR'
            : 'CRITICAL';

    const carrierPercent = this.revenueSplit
      ? await this.revenueSplit.nationalCarrierPercent()
      : 70;
    // Apply this carrier's uplift for board net hints when present.
    const effectiveCarrierPercent = this.revenueSplit
      ? (
          await this.revenueSplit.resolvePercents({
            referredByAdminUserId: null,
            carrierCompanyId: company.id,
            at: new Date(),
          })
        ).percents.carrierPercent
      : carrierPercent;

    // Fee settings for board net (P7: net from expected settlement gross).
    let boardFeePercent = 0;
    let boardFeeMode: SenderPlatformFeeMode = 'EXCLUSIVE';
    if (this.revenueSplit) {
      const feeProbe = await this.revenueSplit.resolveSenderFee({
        baseIncGstCents: 10_000,
        senderCompanyId: null,
      });
      boardFeePercent = feeProbe.feePercent;
      boardFeeMode = feeProbe.mode;
    }

    const quoteCache = new Map<string, number>();
    const globalFloorByModel = new Map<'PER_KM' | 'HOURLY', number>();

    const jobsOut = await Promise.all(
      visible.map(async (j) => {
        const discount = j.rescueDiscountPercent ?? 0;
        const discountedEstimate =
          j.estimateIncGstCents != null && discount > 0
            ? Math.round((j.estimateIncGstCents * (100 - discount)) / 100)
            : j.estimateIncGstCents;
        const myBidIncGstCents = j.proposals[0]?.amountIncGstCents ?? null;

        let feePercent = boardFeePercent;
        let feeMode = boardFeeMode;
        if (this.revenueSplit && j.senderCompanyId) {
          const fee = await this.revenueSplit.resolveSenderFee({
            baseIncGstCents: discountedEstimate ?? myBidIncGstCents ?? 10_000,
            senderCompanyId: j.senderCompanyId,
          });
          feePercent = fee.feePercent;
          feeMode = fee.mode;
        }

        const estimateNetToCarrierCents =
          discountedEstimate != null
            ? expectedCarrierNetFromProposalBase({
                baseIncGstCents: discountedEstimate,
                carrierPercent: effectiveCarrierPercent,
                feePercent,
                feeMode,
              })
            : null;
        const myNetToCarrierCents =
          myBidIncGstCents != null
            ? expectedCarrierNetFromProposalBase({
                baseIncGstCents: myBidIncGstCents,
                carrierPercent: effectiveCarrierPercent,
                feePercent,
                feeMode,
              })
            : null;

        const pricingModel = j.pricingModel === 'HOURLY' ? 'HOURLY' : 'PER_KM';
        if (!globalFloorByModel.has(pricingModel)) {
          globalFloorByModel.set(
            pricingModel,
            await this.jobsService.getMinBaseCents(pricingModel),
          );
        }
        const vehicleClass = j.minVehicleClass?.trim() || 'UTE';
        const quoteKey = `${pricingModel}|${vehicleClass}|${j.routeDistanceKm ?? 0}|${j.billableHours ?? ''}`;
        let classQuoteInc = quoteCache.get(quoteKey);
        if (classQuoteInc == null) {
          const classQuote = await this.jobsService.quoteForVehicleClass({
            pricingModel,
            vehicleClass,
            distanceKm: j.routeDistanceKm ?? 0,
            billableHours: j.billableHours,
          });
          classQuoteInc = classQuote.estimateIncGstCents;
          quoteCache.set(quoteKey, classQuoteInc);
        }
        const hardFloorInc =
          j.rateFloorIncGstCents != null && j.rateFloorIncGstCents > 0
            ? j.rateFloorIncGstCents
            : null;
        const minBidIncGstCents = resolveProposalMinBaseCents({
          globalFloorCents: globalFloorByModel.get(pricingModel) ?? 0,
          classQuoteIncGstCents: classQuoteInc,
          hardFloorIncGstCents: hardFloorInc,
          estimateIncGstCents: j.estimateIncGstCents,
          rescueDiscountPercent: j.rescueDiscountPercent,
        });
        const minBidNetToCarrierCents = minCarrierNetClearingProposalBase({
          minBaseIncGstCents: minBidIncGstCents,
          carrierPercent: effectiveCarrierPercent,
          feePercent,
          feeMode,
        });
        return {
          id: j.id,
          title: j.title,
          status: j.status,
          pricingModel: j.pricingModel,
          minVehicleClass: j.minVehicleClass,
          requiresDg: j.requiresDg,
          dgDocumentId: j.dgDocumentId ?? null,
          dgDocumentFilename: j.dgDocument?.originalFilename ?? null,
          requiresReefer: j.requiresReefer,
          requiresOversize: j.requiresOversize,
          deadWeightKg: j.deadWeightKg,
          lengthCm: j.lengthCm,
          widthCm: j.widthCm,
          heightCm: j.heightCm,
          chargeableWeightKg: j.chargeableWeightKg,
          routeDistanceKm: j.routeDistanceKm,
          routeDurationMinutes: j.routeDurationMinutes,
          routeFatigueBreakMinutes: j.routeFatigueBreakMinutes,
          billableHours: j.billableHours,
          estimateIncGstCents: j.estimateIncGstCents,
          /** Guide net from sender estimate (pre-bid). */
          estimateNetToCarrierCents,
          /** Carrier's submitted bid gross (inc GST), when alreadyBid. */
          myBidIncGstCents,
          /** Carrier net from their bid — use this for “your earnings” once bid exists. */
          myNetToCarrierCents,
          /** Prefer bid net when present so board matches settlement base. */
          displayNetToCarrierCents: myNetToCarrierCents ?? estimateNetToCarrierCents,
          marketplacePriority: j.marketplacePriority,
          rescueDiscountPercent: j.rescueDiscountPercent,
          /** Effective min proposal base (class quote + hard floor). */
          minBidIncGstCents,
          /** Carrier-facing minimum payout (net). */
          minBidNetToCarrierCents,
          rateFloorVersionId: j.rateFloorVersionId ?? j.rateFloorVersion?.id ?? null,
          rateFloorVersionLabel: j.rateFloorVersion?.label ?? null,
          siteManeuverability: j.siteManeuverability,
          siteFacility: j.siteFacility,
          pickupAt: j.pickupAt,
          dropoffWindowStart: j.dropoffWindowStart ?? null,
          dropoffWindowEnd: j.dropoffWindowEnd ?? null,
          publishedAt: j.publishedAt,
          alreadyBid: j.proposals.length > 0,
          loadProfile: (() => {
            const profile = buildStopLoadProfile(
              j.stops.map((s) => ({
                sequence: s.sequence,
                stopType: s.stopType,
                weightKg: (s as { weightKg?: number | null }).weightKg ?? null,
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
          stops: j.stops.map((s) => ({
            sequence: s.sequence,
            stopType: s.stopType,
            addressLine: s.addressLine,
            suburb: s.suburb,
            state: s.state,
            postcode: s.postcode,
            weightKg: (s as { weightKg?: number | null }).weightKg ?? null,
          })),
          stopsSummary: j.stops
            .map((s) =>
              s.addressLine
                ? `${s.stopType}: ${s.addressLine}, ${s.suburb ?? ''} ${s.state ?? ''} ${s.postcode ?? ''}`.trim()
                : `${s.stopType}:${s.suburb ?? ''}`,
            )
            .join(' → '),
        };
      }),
    );

    return {
      netPayoutHint: 'Amounts show your payout (inc GST).',
      carrierPercent: effectiveCarrierPercent,
      nationalCarrierPercent: carrierPercent,
      carrierReliabilityScore: reliabilityScore,
      carrierReliabilityTier: reliabilityTier,
      jobs: jobsOut,
    };
  }

  async submitProposal(principal: AuthenticatedPrincipal, input: ProposalSubmitInput) {
    this.ensureDatabase();
    const eligibility = await this.carrierService.getBidEligibility(principal);
    if (!eligibility.canBid) {
      throw new ForbiddenException({
        message: eligibility.goNoGo.connectReady
          ? 'Carrier cannot bid'
          : 'Carrier cannot bid until Stripe payouts are ready. Open Carrier onboarding → Payouts.',
        code: 'CARRIER_NOT_BID_ELIGIBLE',
        goNoGo: eligibility.goNoGo,
        href: '/carrier/onboarding',
      });
    }
    const user = await this.requireCarrierCompany(principal);
    const company = user.company!;
    const job = await this.jobsService.assertJobOpenForBidding(input.jobId);
    const vehicleClasses = await this.getActiveVehicleClasses();

    if (!carrierMatchesJob(company, job, vehicleClasses)) {
      throw new ForbiddenException({
        message: 'Job not eligible for this carrier (region / DG / REEFER / OVERSIZE / vehicle class)',
        code: 'JOB_NOT_ELIGIBLE',
      });
    }

    const vehicle = await this.prisma.vehicle.findFirst({
      where: {
        id: input.vehicleId,
        companyId: company.id,
        status: VehicleStatus.ACTIVE,
      },
      include: { units: { orderBy: { role: 'asc' } } },
    });
    if (!vehicle) {
      throw new BadRequestException({
        message: 'Active vehicle required',
        code: 'VEHICLE_NOT_ACTIVE',
      });
    }
    if (!vehicle.vehicleClass) {
      throw new BadRequestException({
        message: 'Vehicle class required for bidding',
        code: 'VEHICLE_CLASS_REQUIRED',
      });
    }
    const vehicleClass = vehicle.vehicleClass;
    if (
      !isVehicleAdequateForJob(
        vehicleClass,
        job.minVehicleClass,
        job.chargeableWeightKg,
        vehicleClasses,
      )
    ) {
      throw new BadRequestException({
        message: `Vehicle class ${vehicleClass} undersized for min ${job.minVehicleClass}`,
        code: 'VEHICLE_CLASS_UNDERSIZE',
      });
    }

    const rwcDocs = await this.prisma.complianceDocument.findMany({
      where: {
        companyId: company.id,
        vehicleId: vehicle.id,
        docType: ComplianceDocType.RWC,
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        status: true,
        expiresAt: true,
        vehicleUnitId: true,
      },
    });
    const combinationConfig = (vehicle.combinationConfig ??
      defaultCombinationConfigForClass(vehicleClass)) as CombinationConfigCode;
    const unitRows =
      vehicle.units && vehicle.units.length > 0
        ? vehicle.units
        : [
            {
              id: null as string | null,
              role: 'POWERED' as const,
              registration: vehicle.registration,
            },
          ];
    const unitInputs = unitRows.map((u) => {
      const doc =
        (u.id ? rwcDocs.find((d) => d.vehicleUnitId === u.id) : undefined) ??
        (u.role === 'POWERED'
          ? rwcDocs.find((d) => !d.vehicleUnitId) ?? null
          : null);
      return {
        role: u.role as VehicleUnitRoleCode,
        registration: u.registration,
        rwc: doc
          ? { status: String(doc.status), expiresAt: doc.expiresAt }
          : null,
      };
    });
    const unitsReady = assertUnitsComplete(
      vehicleClass,
      combinationConfig,
      unitInputs,
      new Date(),
      RWC_BID_READY_STATUSES,
    );
    if (!unitsReady.ok) {
      throw new BadRequestException({
        message:
          'This vehicle cannot bid until CLOX Ops has approved Roadworthy / COI for every required unit (prime mover and trailers)',
        code: 'VEHICLE_RWC_UNITS_NOT_APPROVED',
        missingRwc: unitsReady.missingRwc,
        missingRegistration: unitsReady.missingRegistration,
      });
    }

    const executionWindow = calculateJobExecutionWindow(job);
    const complianceCheckAt =
      executionWindow.windowEnd.getTime() > Date.now()
        ? executionWindow.windowEnd
        : new Date();

    const driver = await this.prisma.driver.findFirst({
      where: { id: input.driverId, companyId: company.id, status: DriverStatus.ACTIVE },
    });
    if (!driver) throw new BadRequestException('Active driver required');
    await assertAssignmentCompliance(
      this.prisma,
      {
        driver,
        vehicleId: vehicle.id,
        vehicleClass: vehicle.vehicleClass,
      },
      'badRequest',
      complianceCheckAt,
    );

    await assertDriverAvailabilityForWindow(this.prisma, {
      driverId: driver.id,
      windowStart: executionWindow.windowStart,
      windowEnd: executionWindow.windowEnd,
      excludeJobId: job.id,
    });
    await assertCrewNotBusyElsewhere(this.prisma, {
      vehicleId: vehicle.id,
      driverId: driver.id,
      excludeJobId: job.id,
      windowStart: executionWindow.windowStart,
      windowEnd: executionWindow.windowEnd,
    });

    // Carrier types take-home (net). Convert → proposal base so fee-then-split ledger matches.
    const carrierPercent = this.revenueSplit
      ? (
          await this.revenueSplit.resolvePercents({
            referredByAdminUserId: null,
            carrierCompanyId: company.id,
            at: new Date(),
          })
        ).percents.carrierPercent
      : 70;
    const carrierNetIncGstCents = input.amountIncGstCents;
    let feePercent = 0;
    let feeMode: SenderPlatformFeeMode = 'EXCLUSIVE';
    if (this.revenueSplit) {
      const fee = await this.revenueSplit.resolveSenderFee({
        baseIncGstCents: 10_000,
        senderCompanyId: job.senderCompanyId,
      });
      feePercent = fee.feePercent;
      feeMode = fee.mode;
    }
    const priced = proposalBaseFromTargetCarrierNet({
      targetNetIncGstCents: carrierNetIncGstCents,
      carrierPercent,
      feePercent,
      feeMode,
    });
    if (
      !Number.isFinite(priced.baseIncGstCents) ||
      priced.baseIncGstCents <= 0 ||
      !Number.isFinite(priced.netIncGstCents) ||
      priced.netIncGstCents <= 0
    ) {
      throw new BadRequestException({
        message: 'Bid amount must be a positive payout (inc GST)',
        code: 'BID_AMOUNT_INVALID',
      });
    }
    const grossIncGstCents = priced.baseIncGstCents;

    const pricingModel = job.pricingModel === 'HOURLY' ? 'HOURLY' : 'PER_KM';
    const floorResolved = await this.resolveHardFloorForBid({
      job,
      vehicleClass,
      pricingModel,
    });
    const globalFloor = await this.jobsService.getMinBaseCents(pricingModel);
    const classQuote = await this.jobsService.quoteForVehicleClass({
      pricingModel,
      vehicleClass,
      distanceKm: job.routeDistanceKm ?? 0,
      billableHours: job.billableHours,
    });
    const hardFloorInc = floorResolved.hardFloorInc;
    const hardFloorEx = floorResolved.hardFloorEx;
    const hardFloorVersionId = floorResolved.hardFloorVersionId;
    const hardFloorBreakdown = floorResolved.hardFloorBreakdown;
    const minBase = resolveProposalMinBaseCents({
      globalFloorCents: globalFloor,
      classQuoteIncGstCents: classQuote.estimateIncGstCents,
      hardFloorIncGstCents: hardFloorInc,
      estimateIncGstCents: job.estimateIncGstCents,
      rescueDiscountPercent: job.rescueDiscountPercent,
    });

    if (grossIncGstCents < minBase) {
      const minNet = minCarrierNetClearingProposalBase({
        minBaseIncGstCents: minBase,
        carrierPercent,
        feePercent,
        feeMode,
      });
      const minAud = (minNet / 100).toFixed(2);
      const belowHardFloor =
        hardFloorInc != null && grossIncGstCents < hardFloorInc;
      if (belowHardFloor && this.rateFloor && hardFloorVersionId && hardFloorEx != null) {
        const fuelIndexId =
          typeof hardFloorBreakdown?.fuelIndexId === 'string'
            ? hardFloorBreakdown.fuelIndexId
            : null;
        await this.rateFloor.recordCheck({
          jobId: job.id,
          actorUserId: user.id,
          versionId: hardFloorVersionId,
          fuelIndexId,
          inputs: {
            vehicleClassCode: vehicleClass,
            pricingModel,
            distanceKm: job.routeDistanceKm ?? 0,
            billableHours: job.billableHours,
            offeredIncGstCents: grossIncGstCents,
            offeredNetIncGstCents: carrierNetIncGstCents,
            carrierPercent,
            feePercent,
            feeMode,
          },
          breakdown: hardFloorBreakdown ?? {},
          floorExGstCents: hardFloorEx,
          floorIncGstCents: hardFloorInc!,
          offeredIncGstCents: grossIncGstCents,
          result: 'REJECT',
        });
      }
      throw new BadRequestException({
        message: belowHardFloor
          ? `Bid below hard floor (your payout min A$${minAud} inc GST)`
          : `Bid below minimum (your payout min A$${minAud})`,
        code: belowHardFloor ? 'PRICE_BELOW_FLOOR' : 'BID_BELOW_MIN_BASE',
        minBaseCents: minBase,
        minNetIncGstCents: minNet,
        floorExGstCents: hardFloorEx,
        floorIncGstCents: hardFloorInc,
        floorNetIncGstCents:
          hardFloorInc != null
            ? minCarrierNetClearingProposalBase({
                minBaseIncGstCents: hardFloorInc,
                carrierPercent,
                feePercent,
                feeMode,
              })
            : null,
        versionId: hardFloorVersionId,
      });
    }

    let resolvedDgDocumentId: string | null = null;
    if (job.requiresDg) {
      const dgDocs = await this.prisma.complianceDocument.findMany({
        where: {
          companyId: company.id,
          docType: ComplianceDocType.DG_LICENCE,
          status: {
            in: [
              ComplianceDocStatus.UPLOADED,
              ComplianceDocStatus.UNDER_REVIEW,
              ComplianceDocStatus.APPROVED,
            ],
          },
        },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, vehicleId: true },
      });
      const hasPerVehicleDg = dgDocs.some((d) => Boolean(d.vehicleId));
      const vehicleDgDoc = dgDocs.find((d) => d.vehicleId === vehicle.id) ?? null;
      const companyDgDoc = dgDocs.find((d) => !d.vehicleId) ?? null;

      if (input.dgDocumentId) {
        const explicitDoc = await this.prisma.complianceDocument.findFirst({
          where: { id: input.dgDocumentId, companyId: company.id },
          select: { id: true, vehicleId: true },
        });
        if (!explicitDoc) {
          throw new BadRequestException('Selected DG document does not belong to this carrier');
        }
        if (explicitDoc.vehicleId && explicitDoc.vehicleId !== vehicle.id) {
          throw new BadRequestException('DG document does not match the selected vehicle');
        }
        resolvedDgDocumentId = explicitDoc.id;
      } else if (hasPerVehicleDg) {
        if (!vehicleDgDoc) {
          throw new BadRequestException({
            message: 'Only a Dangerous Goods (DG) licensed vehicle can bid on a DG job',
            code: 'VEHICLE_NOT_DG_ELIGIBLE',
          });
        }
        resolvedDgDocumentId = vehicleDgDoc.id;
      } else {
        resolvedDgDocumentId = vehicleDgDoc?.id ?? companyDgDoc?.id ?? null;
      }
    }

    const gstRatePercent = await this.getPlatformGstPercent();
    const amounts = gstSplitFromIncCents(grossIncGstCents, gstRatePercent);
    // Re-check duplicate inside the same transaction to shrink double-submit race window.
    const proposal = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.proposal.findFirst({
        where: {
          jobId: job.id,
          carrierCompanyId: company.id,
          status: ProposalStatus.SUBMITTED,
        },
        select: { id: true },
      });
      if (existing) {
        throw new BadRequestException({
          message: 'Already submitted a proposal for this job',
          code: 'BID_ALREADY_SUBMITTED',
        });
      }
      const created = await tx.proposal.create({
        data: {
          jobId: job.id,
          carrierCompanyId: company.id,
          vehicleId: vehicle.id,
          driverId: driver.id,
          dgDocumentId: resolvedDgDocumentId,
          etaMinutes: input.etaMinutes,
          status: ProposalStatus.SUBMITTED,
          ...amounts,
        },
      });
      if (job.status === JobStatus.PUBLISHED) {
        await tx.job.update({
          where: { id: job.id },
          data: { status: JobStatus.BIDDING },
        });
      }
      return created;
    });

    await this.audit.recordPlatform({
      action: AuditAction.PROPOSAL_SUBMITTED,
      actorUserId: user.id,
      entityType: 'Proposal',
      entityId: proposal.id,
      metadata: {
        jobId: job.id,
        amountIncGstCents: grossIncGstCents,
        carrierNetIncGstCents,
        expectedNetIncGstCents: priced.netIncGstCents,
        settlementGrossIncGstCents: priced.settlementGrossIncGstCents,
        carrierPercent,
        feePercent,
        feeMode,
      },
    });

    try {
      const jobNotify = await this.prisma.job.findUnique({
        where: { id: job.id },
        select: {
          id: true,
          title: true,
          senderCompany: {
            select: {
              email: true,
              users: {
                where: { role: PlatformRole.SENDER },
                select: { id: true, email: true },
                take: 10,
              },
            },
          },
        },
      });
      const jobLabel = jobNotify?.title || job.id.slice(0, 8);
      const senderUserIds =
        jobNotify?.senderCompany?.users.map((u) => u.id).filter(Boolean) ?? [];
      if (this.inbox && senderUserIds.length > 0) {
        void this.inbox.notifyUsersLocalized({
          userIds: senderUserIds,
          type: NotificationType.BID_RECEIVED,
          titleKey: 'bid.received.title',
          bodyKey: 'bid.received.body',
          vars: {
            jobTitle: jobLabel,
            amount: (proposal.amountIncGstCents / 100).toFixed(2),
          },
          href: `/jobs/${job.id}`,
          entityType: 'Proposal',
          entityId: proposal.id,
        });
      }
      if (this.notifications) {
        const senderEmails = [
          ...(jobNotify?.senderCompany?.users.map((u) => u.email) ?? []),
          ...(jobNotify?.senderCompany?.email
            ? [jobNotify.senderCompany.email]
            : []),
        ];
        if (senderEmails.length > 0) {
          await this.notifications.notifyProposalSubmitted({
            senderEmails,
            jobId: job.id,
            jobTitle: jobNotify?.title ?? '',
            amountIncGstCents: proposal.amountIncGstCents,
            etaMinutes: proposal.etaMinutes,
          });
        }
      }
    } catch (err) {
      this.logger.warn(
        `Bid notify failed for proposal ${proposal.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return {
      id: proposal.id,
      jobId: job.id,
      status: proposal.status,
      /** Proposal freight base (sender sees this before exclusive fee top-up). */
      amountIncGstCents: proposal.amountIncGstCents,
      /** Carrier take-home after fee-then-split — matches typed payout. */
      netToCarrierCents: priced.netIncGstCents,
      settlementGrossIncGstCents: priced.settlementGrossIncGstCents,
      carrierPercent,
      feePercent,
      feeMode,
      etaMinutes: proposal.etaMinutes,
      vehicleId: proposal.vehicleId,
      driverId: proposal.driverId,
    };
  }

  async withdrawProposal(principal: AuthenticatedPrincipal, proposalId: string) {
    this.ensureDatabase();
    const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
    if (!user?.companyId) throw new NotFoundException('Carrier company not found');

    const proposal = await this.prisma.proposal.findFirst({
      where: {
        id: proposalId,
        carrierCompanyId: user.companyId,
      },
      include: {
        job: {
          include: {
            assignment: true,
          },
        },
      },
    });
    if (!proposal) throw new NotFoundException('Proposal not found');

    if (proposal.status !== ProposalStatus.SUBMITTED) {
      throw new BadRequestException(`Cannot withdraw proposal with status ${proposal.status}`);
    }

    if (
      proposal.job.assignment &&
      proposal.job.assignment.proposalId === proposal.id &&
      proposal.job.assignment.status === AssignmentStatus.LOCKED
    ) {
      throw new BadRequestException('Cannot withdraw proposal after it has been awarded and locked');
    }

    const updated = await this.prisma.proposal.update({
      where: { id: proposal.id },
      data: { status: ProposalStatus.WITHDRAWN },
    });

    await this.audit.recordPlatform({
      action: AuditAction.PROPOSAL_WITHDRAWN,
      actorUserId: user.id,
      entityType: 'Proposal',
      entityId: proposal.id,
      metadata: {
        jobId: proposal.jobId,
        vehicleId: proposal.vehicleId,
        driverId: proposal.driverId,
      },
    });

    return {
      id: updated.id,
      jobId: updated.jobId,
      status: updated.status,
    };
  }

  async withdrawProposalByJobId(principal: AuthenticatedPrincipal, jobId: string) {
    this.ensureDatabase();
    const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
    if (!user?.companyId) throw new NotFoundException('Carrier company not found');

    const proposal = await this.prisma.proposal.findFirst({
      where: {
        jobId,
        carrierCompanyId: user.companyId,
        status: ProposalStatus.SUBMITTED,
      },
    });
    if (!proposal) {
      throw new NotFoundException('No active submitted proposal found for this job');
    }

    return this.withdrawProposal(principal, proposal.id);
  }

  async checkFleetDriversAvailabilityForJob(
    principal: AuthenticatedPrincipal,
    jobId: string,
    vehicleId?: string | null,
  ) {
    this.ensureDatabase();
    const user = await this.requireCarrierCompany(principal);
    const company = user.company!;
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        pickupAt: true,
        routeDurationMinutes: true,
        routeFatigueBreakMinutes: true,
        minVehicleClass: true,
      },
    });
    if (!job) throw new NotFoundException('Job not found');

    const executionWindow = calculateJobExecutionWindow(job);

    let vehicleClass: string | null = job.minVehicleClass ?? null;
    if (vehicleId) {
      const vehicle = await this.prisma.vehicle.findFirst({
        where: { id: vehicleId, companyId: company.id },
        select: { vehicleClass: true },
      });
      if (!vehicle) throw new NotFoundException('Vehicle not found');
      vehicleClass = vehicle.vehicleClass;
    }

    const { minLicenceMap } = await loadVehicleClassMaps(this.prisma);

    const drivers = await this.prisma.driver.findMany({
      where: {
        companyId: company.id,
        status: DriverStatus.ACTIVE,
      },
      include: {
        user: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const complianceCheckAt =
      executionWindow.windowEnd.getTime() > Date.now()
        ? executionWindow.windowEnd
        : new Date();

    const driverChecks = await Promise.all(
      drivers.map(async (drv) => {
        const check = await checkDriverAvailabilityForWindow(this.prisma, {
          driverId: drv.id,
          windowStart: executionWindow.windowStart,
          windowEnd: executionWindow.windowEnd,
          excludeJobId: job.id,
          checkOpenBids: true,
        });

        let isEligible = check.isAvailable;
        let code: string | null = check.code ?? null;
        let reason: string | null = check.message ?? null;

        // Same licence/NHVR gates as submitProposal — validated through job execution date.
        if (isEligible) {
          const licenceGate = evaluateDriverLicenceFields(
            {
              id: drv.id,
              status: drv.status,
              licenceClass: drv.licenceClass,
              licenceExpiry: drv.licenceExpiry,
              nhvrAcknowledgedAt: drv.nhvrAcknowledgedAt,
            },
            vehicleClass,
            complianceCheckAt,
            minLicenceMap,
          );
          if (!licenceGate.ok) {
            isEligible = false;
            code = licenceGate.code;
            reason = licenceGate.message;
          }
        }

        return {
          id: drv.id,
          name: drv.user?.name ?? drv.user?.email ?? 'Unknown Driver',
          email: drv.user?.email ?? null,
          licenceClass: drv.licenceClass,
          vehicleClass,
          isEligible,
          code,
          reason,
          conflictingWindow: check.conflictingWindow ?? null,
          pendingLeaveWarning: check.pendingLeaveWarning
            ? {
                scheduleEntryId: check.pendingLeaveWarning.scheduleEntryId,
                type: check.pendingLeaveWarning.type,
                startAt: check.pendingLeaveWarning.startAt.toISOString(),
                endAt: check.pendingLeaveWarning.endAt.toISOString(),
                message: check.pendingLeaveWarning.message,
              }
            : null,
        };
      }),
    );

    return {
      jobId: job.id,
      vehicleId: vehicleId ?? null,
      vehicleClass,
      jobWindow: {
        startAt: executionWindow.windowStart,
        endAt: executionWindow.windowEnd,
        durationMinutes: executionWindow.durationMinutes,
        fatigueBreakMinutes: executionWindow.fatigueBreakMinutes,
        bufferMinutes: executionWindow.bufferMinutes,
      },
      drivers: driverChecks,
    };
  }

  /**
   * Rules-based smart allocation (Fleet+ AC / workflows PDF):
   * Closest (heuristic: lowest class rank delta to min), Least Idle, Most Profitable (cost rate).
   * Carrier still confirms — no silent auto-assign.
   */
  async suggestFleetAssetsForJob(principal: AuthenticatedPrincipal, jobId: string) {
    this.ensureDatabase();
    const user = await this.requireCarrierCompany(principal);
    const company = user.company!;
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        pickupAt: true,
        routeDurationMinutes: true,
        routeFatigueBreakMinutes: true,
        minVehicleClass: true,
      },
    });
    if (!job) throw new NotFoundException('Job not found');

    const { rankMap } = await loadVehicleClassMaps(this.prisma);
    const minRank = job.minVehicleClass ? (rankMap[job.minVehicleClass.toUpperCase()] ?? 0) : 0;

    const activeVehicles = await this.prisma.vehicle.findMany({
      where: { companyId: company.id, status: VehicleStatus.ACTIVE },
      select: {
        id: true,
        registration: true,
        label: true,
        vehicleClass: true,
        costProfileRate: true,
      },
    });

    const windowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const suggestions = await Promise.all(
      activeVehicles.map(async (v) => {
        const classRank = v.vehicleClass ? (rankMap[v.vehicleClass.toUpperCase()] ?? 999) : 999;
        const classDelta = Math.max(0, classRank - minRank);
        const undersized = classRank < minRank;

        const busyCount = await this.prisma.assignment.count({
          where: {
            vehicleId: v.id,
            status: AssignmentStatus.LOCKED,
            trip: { status: { notIn: [TripStatus.COMPLETED, TripStatus.CANCELLED] } },
          },
        });
        const completedRecent = await this.prisma.assignment.count({
          where: {
            vehicleId: v.id,
            status: AssignmentStatus.COMPLETED,
            updatedAt: { gte: windowStart },
          },
        });
        const idleScore = busyCount > 0 ? 0 : 100 - Math.min(90, completedRecent * 5);
        const costRate = v.costProfileRate != null ? Number(v.costProfileRate) : Number.POSITIVE_INFINITY;
        const profitScore = Number.isFinite(costRate) ? 1000 / (1 + costRate) : 0;

        return {
          vehicleId: v.id,
          registration: v.registration,
          label: v.label,
          vehicleClass: v.vehicleClass,
          undersized,
          classDelta,
          idleScore,
          profitScore,
          busy: busyCount > 0,
        };
      }),
    );

    const eligible = suggestions.filter((s) => !s.undersized && !s.busy);
    const closest = [...eligible].sort((a, b) => a.classDelta - b.classDelta)[0] ?? null;
    const leastIdle = [...eligible].sort((a, b) => b.idleScore - a.idleScore)[0] ?? null;
    const mostProfitable = [...eligible].sort((a, b) => b.profitScore - a.profitScore)[0] ?? null;

    return {
      jobId: job.id,
      minVehicleClass: job.minVehicleClass,
      suggestions: {
        closest: closest
          ? { ...closest, reason: 'Closest class fit to job requirement' }
          : null,
        leastIdle: leastIdle
          ? { ...leastIdle, reason: 'Least idle / most available' }
          : null,
        mostProfitable: mostProfitable
          ? { ...mostProfitable, reason: 'Most profitable (lowest cost profile rate)' }
          : null,
      },
      eligibleCount: eligible.length,
    };
  }
}
