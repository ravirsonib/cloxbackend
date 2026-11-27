import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AssignmentStatus,
  JobPricingModel,
  JobStatus,
  NotificationType,
  PaymentEventStatus,
  PaymentEventType,
  PlatformRole,
  Prisma,
  SurchargeKind,
  SurchargeStatus,
  TripStatus,
  VehicleMaintenanceCause,
  VehicleStatus,
} from '@prisma/client';

/** Scalar odometer fields on Trip (avoid stale IDE Prisma payload gaps mid-migrate). */
type TripOdometerFields = {
  odometerStartKm: number | null;
  odometerEndKm: number | null;
  odometerGpsDistanceKm: number | null;
  odometerDiscrepancyFlag: boolean;
};
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import type { AppEnv } from '../../config/env.validation';
import {
  AuditAction,
  formatTripSafetyNotes,
  hasAllTripSafetyCheckItems,
  type TripBreakInput,
  type TripLocationInput,
  type TripMassCheckInput,
  type TripNotifyApproachingInput,
  type TripPodFinalizeInput,
  type TripPodPhotoInput,
  type TripPodSignatureInput,
  type TripSafetyCheckInput,
  type TripStartInput,
} from '../../shared/types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { InAppNotificationsService } from '../notifications/in-app-notifications.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NhvrService } from '../nhvr/nhvr.service';
import { RealtimeGateway } from '../geolocation/realtime.gateway';
import { ValhallaClientService } from '../geolocation/valhalla-client.service';
import { PaymentsService } from '../payments/payments.service';
import {
  DEFAULT_GEOFENCE_POLICY,
  freeWaitMs,
  haversineMeters,
  isInsideRadius,
  massSurchargeIncGstCents,
  parseGeofencePolicy,
  splitIncGst,
  waitOverageMinutes,
  waitingSurchargeIncGstCents,
  type GeofencePolicy,
} from './geofence.util';
import {
  buildBrandedPdf,
  loadCloxLogoBuffer,
  type BrandedPdfImage,
} from './branded-pdf.util';
import {
  formatAudCents,
  parseDataUrl,
  writeTripArtifact,
} from './pod-artifacts.util';
import {
  buildPodJourney,
  formatJourneyForTable,
  formatPodDateTime,
} from './pod-journey.util';
import {
  assertAssignmentCompliance,
  evaluateAssignmentCompliance,
  type DriverAssignmentFields,
} from '../jobs/assignment-gates';
import { isAssignmentPaidAndConfirmed } from '../jobs/assignment-status.util';
import { createReadStream, type ReadStream } from 'fs';
import { access, readFile } from 'fs/promises';
import { extname, join } from 'path';

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);
  private readonly valhallaRouteCache = new Map<
    string,
    { expiresAt: number; value: { encodedPolyline: string; distanceKm: number; durationMin: number } }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<AppEnv, true>,
    @Inject(forwardRef(() => PaymentsService))
    private readonly payments: PaymentsService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly inbox?: InAppNotificationsService,
    /** EWD diary sync on break (NhvrModule). Optional so legacy path specs keep working. */
    @Optional() private readonly nhvr?: NhvrService,
    @Optional() private readonly realtimeGateway?: RealtimeGateway,
    @Optional() private readonly valhalla?: ValhallaClientService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  /**
   * Best-effort in-app inbox for trip stakeholders (sender + carrier [+ driver]).
   * Never throws — trip transitions must not depend on inbox writes.
   */
  private async emitTripInbox(params: {
    tripId: string;
    type: NotificationType;
    title: string;
    body?: string;
    includeDriver?: boolean;
  }) {
    if (!this.inbox) return;
    try {
      const trip = await this.prisma.trip.findUnique({
        where: { id: params.tripId },
        select: {
          id: true,
          jobId: true,
          job: { select: { senderCompanyId: true, title: true } },
          assignment: {
            select: { carrierCompanyId: true, driverId: true },
          },
        },
      });
      if (!trip) return;

      const companyIds = [
        trip.job.senderCompanyId,
        trip.assignment.carrierCompanyId,
      ].filter(Boolean);
      const partyIds = await this.inbox.userIdsForCompanies({
        companyIds,
        roles: [PlatformRole.SENDER, PlatformRole.TRANSPORT_COMPANY],
      });
      const userIds = [...partyIds];
      if (params.includeDriver) {
        const driverUserId = await this.inbox.userIdForDriver(
          trip.assignment.driverId,
        );
        if (driverUserId) userIds.push(driverUserId);
      }

      await this.inbox.notifyUsers({
        userIds,
        type: params.type,
        title: params.title,
        body: params.body ?? null,
        href: `/jobs/${trip.jobId}`,
        entityType: 'Trip',
        entityId: trip.id,
      });
    } catch (error: unknown) {
      this.logger.warn(
        `Trip inbox emit failed (${params.type}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async loadGeofencePolicy(): Promise<GeofencePolicy> {
    const row = await this.prisma.policyVersion.findFirst({
      where: { key: 'geofence.v1', publishedAt: { not: null } },
      orderBy: { version: 'desc' },
    });
    const policy = parseGeofencePolicy(row?.payload ?? DEFAULT_GEOFENCE_POLICY);
    const envRadius = this.config.get('GEOFENCE_RADIUS_METERS', { infer: true });
    if (envRadius && envRadius > 0) {
      policy.radiusMeters = envRadius;
    }
    return policy;
  }

  private tripInclude() {
    return {
      job: { include: { stops: { orderBy: { sequence: 'asc' as const } } } },
      assignment: { include: { vehicle: true } },
      locations: { orderBy: { recordedAt: 'desc' as const }, take: 1 },
      stopProgress: { include: { jobStop: true } },
      surcharges: { orderBy: { createdAt: 'desc' as const }, take: 10 },
    };
  }

  private mapStopProgress(
    rows?: Array<{
      id: string;
      jobStopId: string;
      insideCount: number;
      currentlyInside: boolean;
      enteredAt: Date | null;
      exitedAt: Date | null;
      waitStartedAt: Date | null;
      freeWaitEndsAt: Date | null;
      waitOverageMinutes: number;
      arrivalRecorded: boolean;
      approachingNotifiedAt?: Date | null;
      approachingSource?: string | null;
      atDropoffNotifiedAt?: Date | null;
      podStatus?: string;
      signedAt?: Date | null;
      signerName?: string | null;
      signatureStorageKey?: string | null;
      receiverPresentAttested?: boolean;
      goodsPhotoRefs?: unknown;
      podFinalizedAt?: Date | null;
      podPackageStorageKey?: string | null;
      jobStop?: {
        sequence: number;
        stopType: string;
        suburb: string | null;
        lat: { toNumber(): number } | number | null;
        lng: { toNumber(): number } | number | null;
      };
    }>,
  ) {
    return (rows ?? []).map((p) => ({
      id: p.id,
      jobStopId: p.jobStopId,
      insideCount: p.insideCount,
      currentlyInside: p.currentlyInside,
      enteredAt: p.enteredAt,
      exitedAt: p.exitedAt,
      waitStartedAt: p.waitStartedAt,
      freeWaitEndsAt: p.freeWaitEndsAt,
      waitOverageMinutes: p.waitOverageMinutes,
      arrivalRecorded: p.arrivalRecorded,
      approachingNotifiedAt: p.approachingNotifiedAt ?? null,
      approachingSource: p.approachingSource ?? null,
      atDropoffNotifiedAt: p.atDropoffNotifiedAt ?? null,
      podStatus: p.podStatus ?? 'PENDING',
      signedAt: p.signedAt ?? null,
      signerName: p.signerName ?? null,
      hasSignature: Boolean(p.signatureStorageKey),
      receiverPresentAttested: Boolean(p.receiverPresentAttested),
      goodsPhotoCount: Array.isArray(p.goodsPhotoRefs) ? p.goodsPhotoRefs.length : 0,
      podFinalizedAt: p.podFinalizedAt ?? null,
      podPackageStorageKey: p.podPackageStorageKey ?? null,
      stop: p.jobStop
        ? {
            sequence: p.jobStop.sequence,
            stopType: p.jobStop.stopType,
            suburb: p.jobStop.suburb,
            lat:
              p.jobStop.lat == null
                ? null
                : typeof p.jobStop.lat === 'number'
                  ? p.jobStop.lat
                  : p.jobStop.lat.toNumber(),
            lng:
              p.jobStop.lng == null
                ? null
                : typeof p.jobStop.lng === 'number'
                  ? p.jobStop.lng
                  : p.jobStop.lng.toNumber(),
          }
        : null,
    }));
  }

  private mapSurcharges(
    rows?: Array<{
      id: string;
      kind: SurchargeKind;
      status: SurchargeStatus;
      amountExGstCents: number;
      amountGstCents: number;
      amountIncGstCents: number;
      stopProgressId: string | null;
      idempotencyKey: string;
      paidAt: Date | null;
      waivedAt: Date | null;
      createdAt: Date;
    }>,
  ) {
    return (rows ?? []).map((s) => ({
      id: s.id,
      kind: s.kind,
      status: s.status,
      amountExGstCents: s.amountExGstCents,
      amountGstCents: s.amountGstCents,
      amountIncGstCents: s.amountIncGstCents,
      stopProgressId: s.stopProgressId,
      idempotencyKey: s.idempotencyKey,
      paidAt: s.paidAt,
      waivedAt: s.waivedAt,
      createdAt: s.createdAt,
    }));
  }

  private hasPendingMass(
    surcharges?: Array<{ kind: SurchargeKind; status: SurchargeStatus }>,
  ): boolean {
    return (surcharges ?? []).some(
      (s) => s.kind === SurchargeKind.MASS && s.status === SurchargeStatus.PENDING_PAYMENT,
    );
  }

  private hasPendingPaymentSurcharge(
    surcharges?: Array<{ status: SurchargeStatus }>,
  ): boolean {
    return (surcharges ?? []).some((s) => s.status === SurchargeStatus.PENDING_PAYMENT);
  }

  /** Best-effort charge deferred WAITING rows (created with chargeNow=false during dwell). */
  private async settlePendingWaitingSurcharges(tripId: string) {
    const pendingWaiting = await this.prisma.surcharge.findMany({
      where: {
        tripId,
        kind: SurchargeKind.WAITING,
        status: SurchargeStatus.PENDING_PAYMENT,
      },
      select: { id: true },
    });
    for (const s of pendingWaiting) {
      try {
        await this.payments.chargeSurcharge(s.id);
      } catch {
        // Caller decides whether remaining PENDING_PAYMENT blocks POD.
      }
    }
  }

  private asTripOdometer(trip: object): TripOdometerFields {
    const row = trip as Partial<TripOdometerFields>;
    return {
      odometerStartKm: row.odometerStartKm ?? null,
      odometerEndKm: row.odometerEndKm ?? null,
      odometerGpsDistanceKm: row.odometerGpsDistanceKm ?? null,
      odometerDiscrepancyFlag: Boolean(row.odometerDiscrepancyFlag),
    };
  }

  /** Sum consecutive haversine segments (km) from location pings, oldest → newest. */
  private async gpsPathDistanceKm(tripId: string): Promise<number> {
    const samples = await this.prisma.tripLocationSample.findMany({
      where: { tripId },
      orderBy: { recordedAt: 'asc' },
      select: { lat: true, lng: true },
      take: 5_000,
    });
    if (samples.length < 2) return 0;
    let meters = 0;
    for (let i = 1; i < samples.length; i++) {
      const aLat = Number(samples[i - 1].lat);
      const aLng = Number(samples[i - 1].lng);
      const bLat = Number(samples[i].lat);
      const bLng = Number(samples[i].lng);
      meters += haversineMeters(aLat, aLng, bLat, bLng);
    }
    return meters / 1000;
  }

  /**
   * Persist end odometer on last dropoff finalize; flag Super Admin when
   * |odoDelta − gpsKm| / gpsKm > 10% (clox-run-sheet.md).
   */
  private async captureEndOdometer(params: {
    tripId: string;
    actorUserId: string;
    odometerStartKm: number | null | undefined;
    odometerEndKm: number;
  }) {
    const startKm = params.odometerStartKm;
    if (startKm != null && params.odometerEndKm < startKm) {
      throw new BadRequestException(
        'End odometer must be greater than or equal to start odometer',
      );
    }
    const gpsKm = await this.gpsPathDistanceKm(params.tripId);
    const odoDelta =
      startKm != null ? params.odometerEndKm - startKm : null;
    let discrepancy = false;
    if (odoDelta != null && gpsKm >= 1) {
      discrepancy = Math.abs(odoDelta - gpsKm) / gpsKm > 0.1;
    }
    await this.prisma.trip.update({
      where: { id: params.tripId },
      data: {
        odometerEndKm: params.odometerEndKm,
        odometerGpsDistanceKm: gpsKm > 0 ? gpsKm : null,
        odometerDiscrepancyFlag: discrepancy,
      } as Prisma.TripUncheckedUpdateInput,
    });
    if (discrepancy) {
      await this.audit.recordPlatform({
        action: AuditAction.TRIP_ODOMETER_DISCREPANCY,
        actorUserId: params.actorUserId,
        entityType: 'Trip',
        entityId: params.tripId,
        metadata: {
          odometerStartKm: startKm,
          odometerEndKm: params.odometerEndKm,
          odoDeltaKm: odoDelta,
          gpsKm,
          threshold: '10%',
        },
      });
    }
  }

  /**
   * POD is only allowed after pending surcharges are cleared.
   * Tries to settle deferred WAITING first; any remaining PENDING_PAYMENT blocks POD.
   */
  private async assertReadyForPod(tripId: string) {
    await this.settlePendingWaitingSurcharges(tripId);
    const pending = await this.prisma.surcharge.count({
      where: {
        tripId,
        status: SurchargeStatus.PENDING_PAYMENT,
      },
    });
    if (pending > 0) {
      throw new BadRequestException({
        message: 'Pending surcharges must be paid or waived before proof of delivery',
        code: 'POD_BLOCKED_PENDING_SURCHARGE',
      });
    }
  }

  /** Create PENDING_GATES trip when assignment is paid/locked (idempotent). */
  async ensureTripForAssignment(assignmentId: string) {
    this.ensureDatabase();
    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { job: true, trip: true },
    });
    if (!assignment || assignment.status !== AssignmentStatus.LOCKED) {
      return null;
    }
    if (assignment.trip) {
      if (assignment.trip.status === TripStatus.CANCELLED) {
        return this.prisma.trip.update({
          where: { id: assignment.trip.id },
          data: {
            status: TripStatus.PENDING_GATES,
            safetyPassedAt: null,
            safetyFailedAt: null,
            safetyNotes: null,
            startedAt: null,
            completedAt: null,
            onBreak: false,
            breakStartedAt: null,
          },
        });
      }
      return assignment.trip;
    }

    const declared =
      assignment.job.deadWeightKg ?? assignment.job.chargeableWeightKg ?? null;

    const trip = await this.prisma.trip.create({
      data: {
        jobId: assignment.jobId,
        assignmentId: assignment.id,
        status: TripStatus.PENDING_GATES,
        declaredMassKg: declared,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.TRIP_CREATED,
      entityType: 'Trip',
      entityId: trip.id,
      metadata: { jobId: assignment.jobId, declaredMassKg: declared },
    });

    return trip;
  }

  private async requireDriver(principal: AuthenticatedPrincipal) {
    if (principal.kind !== 'user' || principal.role !== 'DRIVER') {
      throw new ForbiddenException('Driver required');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      include: { driver: true },
    });
    if (!user?.driver) throw new NotFoundException('Driver profile not found');
    return user;
  }

  private mapTrip(trip: {
    id: string;
    jobId: string;
    status: TripStatus;
    safetyPassedAt: Date | null;
    safetyFailedAt: Date | null;
    safetyNotes: string | null;
    declaredMassKg: number | null;
    actualMassKg: number | null;
    massCheckOk: boolean;
    massCheckedAt: Date | null;
    massOverDeclared: boolean;
    onBreak: boolean;
    breakStartedAt: Date | null;
    startedAt: Date | null;
    completedAt: Date | null;
    odometerStartKm?: number | null;
    odometerEndKm?: number | null;
    odometerGpsDistanceKm?: number | null;
    odometerDiscrepancyFlag?: boolean;
    podStorageKey?: string | null;
    taxInvoiceStorageKey?: string | null;
    runSheetStorageKey?: string | null;
    job?: {
      title: string | null;
      status: JobStatus;
      pricingModel?: JobPricingModel | string;
      hourlyPattern?: string | null;
      siteManeuverability: string | null;
      siteFacility: string | null;
      deadWeightKg: number | null;
      chargeableWeightKg: number | null;
      routeFatigueBreakMinutes?: number | null;
      stops?: Array<{
        id?: string;
        sequence: number;
        stopType: string;
        suburb: string | null;
        state: string | null;
        lat: { toNumber(): number } | number | null;
        lng: { toNumber(): number } | number | null;
      }>;
    };
    assignment?: {
      status: AssignmentStatus;
      vehicleId: string | null;
      driverId: string | null;
      vehicle?: {
        label: string | null;
        registration: string | null;
        vehicleClass: string | null;
      } | null;
    };
    locations?: Array<{
      lat: { toNumber(): number } | number;
      lng: { toNumber(): number } | number;
      recordedAt: Date;
    }>;
    stopProgress?: Array<{
      id: string;
      jobStopId: string;
      insideCount: number;
      currentlyInside: boolean;
      enteredAt: Date | null;
      exitedAt: Date | null;
      waitStartedAt: Date | null;
      freeWaitEndsAt: Date | null;
      waitOverageMinutes: number;
      arrivalRecorded: boolean;
      jobStop?: {
        sequence: number;
        stopType: string;
        suburb: string | null;
        lat: { toNumber(): number } | number | null;
        lng: { toNumber(): number } | number | null;
      };
    }>;
    surcharges?: Array<{
      id: string;
      kind: SurchargeKind;
      status: SurchargeStatus;
      amountExGstCents: number;
      amountGstCents: number;
      amountIncGstCents: number;
      stopProgressId: string | null;
      idempotencyKey: string;
      paidAt: Date | null;
      waivedAt: Date | null;
      createdAt: Date;
    }>;
  }, opts?: { complianceOk?: boolean }) {
    const pendingMass = this.hasPendingMass(trip.surcharges);
    const pendingSurcharges = this.hasPendingPaymentSurcharge(trip.surcharges);
    const massOk = trip.massCheckOk && !pendingMass;
    const complianceOk = opts?.complianceOk ?? true;
    const gates = {
      paid: isAssignmentPaidAndConfirmed(trip.assignment?.status),
      safetyOk: Boolean(trip.safetyPassedAt) && !trip.safetyFailedAt,
      massOk,
      complianceOk,
      canStart:
        trip.assignment?.status === AssignmentStatus.LOCKED &&
        Boolean(trip.safetyPassedAt) &&
        !trip.safetyFailedAt &&
        massOk &&
        !pendingMass &&
        complianceOk &&
        !trip.startedAt,
      /** POD capture/finalize only when no PENDING_PAYMENT surcharges remain. */
      canFinalizePod: !pendingSurcharges,
      pendingSurcharges,
    };
    return {
      id: trip.id,
      jobId: trip.jobId,
      status: trip.status,
      safetyPassedAt: trip.safetyPassedAt,
      safetyFailedAt: trip.safetyFailedAt,
      safetyNotes: trip.safetyNotes,
      declaredMassKg: trip.declaredMassKg,
      actualMassKg: trip.actualMassKg,
      massCheckOk: trip.massCheckOk,
      massCheckedAt: trip.massCheckedAt,
      massOverDeclared: trip.massOverDeclared,
      onBreak: trip.onBreak,
      breakStartedAt: trip.breakStartedAt,
      suggestedBreakMinutes:
        trip.job?.routeFatigueBreakMinutes != null && trip.job.routeFatigueBreakMinutes > 0
          ? trip.job.routeFatigueBreakMinutes
          : 15,
      startedAt: trip.startedAt,
      completedAt: trip.completedAt,
      odometerStartKm: trip.odometerStartKm ?? null,
      odometerEndKm: trip.odometerEndKm ?? null,
      odometerGpsDistanceKm: trip.odometerGpsDistanceKm ?? null,
      odometerDiscrepancyFlag: Boolean(trip.odometerDiscrepancyFlag),
      podStorageKey: trip.podStorageKey ?? null,
      taxInvoiceStorageKey: trip.taxInvoiceStorageKey ?? null,
      runSheetStorageKey: trip.runSheetStorageKey ?? null,
      gates,
      siteAccess: trip.job
        ? {
            maneuverability: trip.job.siteManeuverability,
            facility: trip.job.siteFacility,
          }
        : null,
      job: trip.job
        ? {
            title: trip.job.title,
            status: trip.job.status,
            pricingModel: trip.job.pricingModel,
            hourlyPattern: trip.job.hourlyPattern,
            deadWeightKg: trip.job.deadWeightKg,
            chargeableWeightKg: trip.job.chargeableWeightKg,
            stops: (trip.job.stops ?? []).map((s) => ({
              id: s.id,
              sequence: s.sequence,
              stopType: s.stopType,
              suburb: s.suburb,
              state: s.state,
              lat: s.lat == null ? null : typeof s.lat === 'number' ? s.lat : s.lat.toNumber(),
              lng: s.lng == null ? null : typeof s.lng === 'number' ? s.lng : s.lng.toNumber(),
            })),
          }
        : null,
      vehicle: trip.assignment?.vehicle
        ? {
            label: trip.assignment.vehicle.label,
            registration: trip.assignment.vehicle.registration,
            vehicleClass: trip.assignment.vehicle.vehicleClass,
          }
        : null,
      latestLocation:
        trip.locations && trip.locations.length > 0
          ? {
              lat:
                typeof trip.locations[0].lat === 'number'
                  ? trip.locations[0].lat
                  : trip.locations[0].lat.toNumber(),
              lng:
                typeof trip.locations[0].lng === 'number'
                  ? trip.locations[0].lng
                  : trip.locations[0].lng.toNumber(),
              recordedAt: trip.locations[0].recordedAt,
            }
          : null,
      stopsProgress: this.mapStopProgress(trip.stopProgress),
      surcharges: this.mapSurcharges(trip.surcharges),
    };
  }

  private async loadTripForDriver(driverId: string, tripId: string) {
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, assignment: { driverId } },
      include: this.tripInclude(),
    });
    if (!trip) throw new NotFoundException('Trip not found');
    return trip;
  }

  async listDriverTrips(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const user = await this.requireDriver(principal);
    const driver = user.driver!;
    const trips = await this.prisma.trip.findMany({
      where: { assignment: { driverId: driver.id } },
      include: this.tripInclude(),
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    return Promise.all(
      trips.map(async (t) => {
        const complianceOk = await this.tripComplianceOk(driver, t);
        return this.mapTrip(t, { complianceOk });
      }),
    );
  }

  private async tripComplianceOk(
    driver: DriverAssignmentFields,
    trip: {
      assignment?: {
        vehicleId?: string | null;
        vehicle?: { vehicleClass?: string | null } | null;
      } | null;
    },
  ): Promise<boolean> {
    const result = await evaluateAssignmentCompliance(this.prisma, {
      driver,
      vehicleId: trip.assignment?.vehicleId,
      vehicleClass: trip.assignment?.vehicle?.vehicleClass,
    });
    return result.ok;
  }

  /** M10 — scoped POD package status for driver / sender / carrier. */
  /**
   * ACL for trip POD / completion documents (M10 §11):
   * assigned driver · sender company · assigned carrier · admin.
   */
  private async loadTripForDocumentAccess(
    principal: AuthenticatedPrincipal,
    tripId: string,
  ) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        job: {
          include: {
            stops: { orderBy: { sequence: 'asc' } },
            senderCompany: { select: { id: true } },
          },
        },
        stopProgress: true,
        assignment: {
          select: {
            carrierCompanyId: true,
            driverId: true,
            driver: { select: { userId: true } },
          },
        },
      },
    });
    if (!trip) throw new NotFoundException('Trip not found');

    if (principal.kind === 'user' && principal.role === 'DRIVER') {
      const user = await this.requireDriver(principal);
      if (trip.assignment?.driverId !== user.driver!.id) {
        throw new ForbiddenException();
      }
    } else if (principal.kind === 'user' && principal.role === 'SENDER') {
      const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
      if (!user?.companyId || user.companyId !== trip.job.senderCompanyId) {
        throw new ForbiddenException();
      }
    } else if (principal.kind === 'user' && principal.role === 'TRANSPORT_COMPANY') {
      const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
      if (!user?.companyId || user.companyId !== trip.assignment?.carrierCompanyId) {
        throw new ForbiddenException();
      }
    } else if (principal.kind !== 'admin') {
      throw new ForbiddenException();
    }

    return trip;
  }

  async getTripPod(principal: AuthenticatedPrincipal, tripId: string) {
    this.ensureDatabase();
    const trip = await this.loadTripForDocumentAccess(principal, tripId);

    const byStop = new Map(trip.stopProgress.map((p) => [p.jobStopId, p]));
    const dropoffs = trip.job.stops
      .filter((s) => s.stopType === 'DROPOFF')
      .map((s) => {
        const p = byStop.get(s.id);
        return {
          jobStopId: s.id,
          sequence: s.sequence,
          suburb: s.suburb,
          podStatus: p?.podStatus ?? 'PENDING',
          signedAt: p?.signedAt ?? null,
          signerName: p?.signerName ?? null,
          podFinalizedAt: p?.podFinalizedAt ?? null,
          podPackageStorageKey: p?.podPackageStorageKey ?? null,
          signaturePdfStorageKey: p?.signaturePdfStorageKey ?? null,
          goodsPhotoCount: Array.isArray(p?.goodsPhotoRefs)
            ? (p!.goodsPhotoRefs as string[]).length
            : 0,
        };
      });

    return {
      tripId: trip.id,
      jobId: trip.jobId,
      tripStatus: trip.status,
      podStorageKey: trip.podStorageKey,
      taxInvoiceStorageKey: trip.taxInvoiceStorageKey,
      runSheetStorageKey: trip.runSheetStorageKey,
      /** Relative download paths for authenticated GET (M10 PDF ACL). */
      downloads: {
        pod: trip.podStorageKey ? `trips/${trip.id}/documents/pod` : null,
        taxInvoice: trip.taxInvoiceStorageKey
          ? `trips/${trip.id}/documents/tax-invoice`
          : null,
        runSheet: trip.runSheetStorageKey
          ? `trips/${trip.id}/documents/run-sheet`
          : null,
      },
      dropoffs: dropoffs.map((d) => ({
        ...d,
        downloads: {
          podPackage: d.podPackageStorageKey
            ? `trips/${trip.id}/documents/stops/${d.jobStopId}/pod-package`
            : null,
          signaturePdf: d.signaturePdfStorageKey
            ? `trips/${trip.id}/documents/stops/${d.jobStopId}/signature-pdf`
            : null,
        },
      })),
    };
  }

  /**
   * Stream a completion / POD PDF blob with party ACL (sender / carrier / driver / admin).
   */
  async getTripDocument(
    principal: AuthenticatedPrincipal,
    tripId: string,
    kind: 'pod' | 'tax-invoice' | 'run-sheet' | 'pod-package' | 'signature-pdf',
    jobStopId?: string,
  ): Promise<{ stream: ReadStream; mimeType: string; filename: string }> {
    this.ensureDatabase();
    const trip = await this.loadTripForDocumentAccess(principal, tripId);

    let storageKey: string | null = null;
    let filename = 'document.pdf';

    if (kind === 'pod') {
      storageKey = trip.podStorageKey;
      filename = `CLOX-pod-${trip.jobId.slice(0, 8)}.pdf`;
    } else if (kind === 'tax-invoice') {
      storageKey = trip.taxInvoiceStorageKey;
      filename = `CLOX-tax-invoice-${trip.jobId.slice(0, 8)}.pdf`;
    } else if (kind === 'run-sheet') {
      storageKey = trip.runSheetStorageKey;
      filename = `CLOX-run-sheet-${trip.jobId.slice(0, 8)}.pdf`;
    } else {
      if (!jobStopId) {
        throw new BadRequestException('jobStopId required for stop document');
      }
      const stop = trip.job.stops.find((s) => s.id === jobStopId);
      if (!stop || stop.stopType !== 'DROPOFF') {
        throw new NotFoundException('POD stop not found');
      }
      const progress = trip.stopProgress.find((p) => p.jobStopId === jobStopId);
      if (!progress) throw new NotFoundException('POD progress not found');
      if (kind === 'pod-package') {
        storageKey = progress.podPackageStorageKey;
        filename = `CLOX-pod-package-${jobStopId.slice(0, 8)}.pdf`;
      } else {
        storageKey = progress.signaturePdfStorageKey;
        filename = `CLOX-signature-${jobStopId.slice(0, 8)}.pdf`;
      }
    }

    if (
      !storageKey ||
      storageKey.includes('..') ||
      !storageKey.startsWith(`trips/${trip.id}/`)
    ) {
      throw new NotFoundException('Document not found');
    }

    const fullPath = join(this.storageRoot(), storageKey);
    try {
      await access(fullPath);
    } catch {
      throw new NotFoundException('Document file missing from storage');
    }

    return {
      stream: createReadStream(fullPath),
      mimeType: 'application/pdf',
      filename,
    };
  }

  async getDriverTrip(principal: AuthenticatedPrincipal, tripId: string) {
    this.ensureDatabase();
    const user = await this.requireDriver(principal);
    const trip = await this.loadTripForDriver(user.driver!.id, tripId);
    const complianceOk = await this.tripComplianceOk(user.driver!, trip);
    const mapped = this.mapTrip(trip, { complianceOk });
    const openException = await this.prisma.tripException.findFirst({
      where: {
        tripId: trip.id,
        status: {
          in: ['OPEN', 'AWAITING_CARRIER', 'REASSIGN_IN_PROGRESS', 'ESCALATED'],
        },
      },
      orderBy: { openedAt: 'desc' },
      select: {
        id: true,
        kind: true,
        phase: true,
        status: true,
        reasonCode: true,
        note: true,
        openedAt: true,
        resolvedAt: true,
      },
    });
    const routeSnapshot = await this.buildTripRouteSnapshot({
      stops: trip.job?.stops ?? [],
      stopProgress: trip.stopProgress ?? [],
      latest: mapped.latestLocation,
    });
    return { ...mapped, openException, ...routeSnapshot };
  }

  async safetyCheck(
    principal: AuthenticatedPrincipal,
    tripId: string,
    input: TripSafetyCheckInput,
  ) {
    this.ensureDatabase();
    if (!input.online) {
      throw new BadRequestException({ message: 'Online required', code: 'OFFLINE_REJECTED' });
    }
    const user = await this.requireDriver(principal);
    const trip = await this.loadTripForDriver(user.driver!.id, tripId);
    if (trip.startedAt) {
      throw new BadRequestException('Trip already started');
    }
    if (trip.assignment.status !== AssignmentStatus.LOCKED) {
      throw new ForbiddenException({ message: 'Not paid', code: 'TRIP_NOT_PAID' });
    }

    if (!input.passed) {
      let safetySuspendedVehicle = false;
      if (trip.assignment.vehicleId) {
        const vehicle = await this.prisma.vehicle.findUnique({
          where: { id: trip.assignment.vehicleId },
          select: { status: true, companyId: true },
        });
        // ACTIVE → MAINTENANCE + durable work order (legal suite §4.1 / BR-18).
        // Never overwrite an existing compliance suspension/retirement.
        if (vehicle?.status === VehicleStatus.ACTIVE) {
          await this.prisma.vehicle.update({
            where: { id: trip.assignment.vehicleId },
            data: {
              status: VehicleStatus.MAINTENANCE,
              maintenanceCause: VehicleMaintenanceCause.SAFETY_FAIL,
              maintenanceStartedAt: new Date(),
            },
          });
          await this.prisma.vehicleMaintenanceWorkOrder.create({
            data: {
              vehicleId: trip.assignment.vehicleId,
              companyId: vehicle.companyId,
              cause: VehicleMaintenanceCause.SAFETY_FAIL,
              tripId: trip.id,
              notes: input.notes ?? 'Pre-trip safety checklist failed',
            },
          });
          safetySuspendedVehicle = true;
        }
      }
      const updated = await this.prisma.trip.update({
        where: { id: trip.id },
        data: {
          safetyFailedAt: new Date(),
          safetyPassedAt: null,
          safetyNotes: formatTripSafetyNotes({
            checkedItemIds: input.checkedItemIds,
            notes: input.notes ?? 'Pre-trip failed',
            safetySuspend: safetySuspendedVehicle,
          }),
          status: TripStatus.PENDING_GATES,
        },
        include: this.tripInclude(),
      });
      await this.audit.recordPlatform({
        action: AuditAction.TRIP_SAFETY_FAILED,
        actorUserId: user.id,
        entityType: 'Trip',
        entityId: trip.id,
        metadata: {
          notes: input.notes,
          checkedItemIds: input.checkedItemIds ?? [],
          vehicleLocked: safetySuspendedVehicle,
          maintenance: true,
        },
      });
      return this.mapTrip(updated);
    }

    if (!hasAllTripSafetyCheckItems(input.checkedItemIds)) {
      throw new BadRequestException({
        message:
          'All pre-trip safety checklist items must be confirmed before passing Gate A',
        code: 'SAFETY_CHECKLIST_INCOMPLETE',
      });
    }

    const updated = await this.prisma.trip.update({
      where: { id: trip.id },
      data: {
        safetyPassedAt: new Date(),
        safetyFailedAt: null,
        safetyNotes: formatTripSafetyNotes({
          checkedItemIds: input.checkedItemIds,
          notes: input.notes,
        }),
        status: TripStatus.EN_ROUTE_PICKUP,
      },
      include: this.tripInclude(),
    });
    // Only reverse a MAINTENANCE this trip caused (marker) — never force ACTIVE over compliance.
    const wasSafetySuspended = Boolean(
      trip.safetyFailedAt && trip.safetyNotes?.includes('[SAFETY_SUSPEND]'),
    );
    let vehicleUnsuspended = false;
    if (wasSafetySuspended && trip.assignment.vehicleId) {
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: trip.assignment.vehicleId },
        select: { status: true, maintenanceCause: true },
      });
      if (
        vehicle?.status === VehicleStatus.MAINTENANCE &&
        vehicle.maintenanceCause === VehicleMaintenanceCause.SAFETY_FAIL
      ) {
        await this.prisma.vehicle.update({
          where: { id: trip.assignment.vehicleId },
          data: {
            status: VehicleStatus.ACTIVE,
            maintenanceCause: null,
            maintenanceStartedAt: null,
          },
        });
        await this.prisma.vehicleMaintenanceWorkOrder.updateMany({
          where: {
            vehicleId: trip.assignment.vehicleId,
            tripId: trip.id,
            clearedAt: null,
            cause: VehicleMaintenanceCause.SAFETY_FAIL,
          },
          data: { clearedAt: new Date(), clearedNote: 'Safety checklist re-passed' },
        });
        vehicleUnsuspended = true;
      }
    }
    await this.audit.recordPlatform({
      action: AuditAction.TRIP_SAFETY_PASSED,
      actorUserId: user.id,
      entityType: 'Trip',
      entityId: trip.id,
      metadata: { vehicleUnsuspended },
    });
    return this.mapTrip(updated);
  }

  async massCheck(
    principal: AuthenticatedPrincipal,
    tripId: string,
    input: TripMassCheckInput,
  ) {
    this.ensureDatabase();
    if (!input.online) {
      throw new BadRequestException({ message: 'Online required', code: 'OFFLINE_REJECTED' });
    }
    const user = await this.requireDriver(principal);
    const trip = await this.loadTripForDriver(user.driver!.id, tripId);
    if (!trip.safetyPassedAt || trip.safetyFailedAt) {
      throw new BadRequestException({
        message: 'Safety check required first',
        code: 'SAFETY_REQUIRED',
      });
    }
    if (trip.startedAt) {
      throw new BadRequestException('Trip already started');
    }

    const policy = await this.loadGeofencePolicy();
    const paidMasses = (trip.surcharges ?? [])
      .filter(
        (s) =>
          s.kind === SurchargeKind.MASS &&
          (s.status === SurchargeStatus.PAID || s.status === SurchargeStatus.WAIVED),
      )
      .map((s) => {
        const meta = s.metadata as Record<string, unknown> | null;
        return typeof meta?.actualMassKg === 'number' ? meta.actualMassKg : 0;
      });

    const declared = Math.max(
      trip.declaredMassKg ?? trip.job.chargeableWeightKg ?? trip.job.deadWeightKg ?? 0,
      ...paidMasses,
      trip.massCheckOk && !this.hasPendingMass(trip.surcharges) ? (trip.actualMassKg ?? 0) : 0,
    );
    const tolerance = 1 + policy.massTolerancePct / 100;
    const over = input.actualMassKg > declared * tolerance;

    if (over) {
      await this.prisma.trip.update({
        where: { id: trip.id },
        data: {
          actualMassKg: input.actualMassKg,
          declaredMassKg: declared,
          massCheckOk: false,
          massOverDeclared: true,
          massCheckedAt: new Date(),
          status: TripStatus.AT_PICKUP,
        },
      });

      const amountIncGstCents = massSurchargeIncGstCents(
        declared,
        input.actualMassKg,
        policy,
      );
      const surcharge = await this.payments.createSurcharge({
        jobId: trip.jobId,
        tripId: trip.id,
        kind: SurchargeKind.MASS,
        amountIncGstCents,
        idempotencyKey: `mass:${trip.id}`,
        chargeNow: false,
        metadata: {
          declaredMassKg: declared,
          actualMassKg: input.actualMassKg,
          overKg: Math.max(0, input.actualMassKg - declared),
        },
      });

    await this.audit.recordPlatform({
      action: AuditAction.TRIP_MASS_CHECKED,
      actorUserId: user.id,
      entityType: 'Trip',
      entityId: trip.id,
      metadata: {
        over: true,
        actual: input.actualMassKg,
        declared,
        code: 'MASS_DISCREPANCY',
        surchargeId: surcharge.id,
      },
    });
      void this.emitTripInbox({
        tripId: trip.id,
        type: NotificationType.TRIP_AT_PICKUP,
        title: 'Driver at pickup',
        body: 'Mass check recorded (over declared). Start is blocked until surcharge is cleared.',
      });

      const refreshed = await this.loadTripForDriver(user.driver!.id, tripId);
      throw new ForbiddenException({
        message: 'Actual mass exceeds declared — Start Trip blocked until surcharge paid/waived',
        code: 'MASS_DISCREPANCY',
        declaredMassKg: declared,
        actualMassKg: input.actualMassKg,
        surcharge,
        trip: this.mapTrip(refreshed),
      });
    }

    const updated = await this.prisma.trip.update({
      where: { id: trip.id },
      data: {
        actualMassKg: input.actualMassKg,
        declaredMassKg: declared,
        massCheckOk: true,
        massOverDeclared: false,
        massCheckedAt: new Date(),
        status: TripStatus.AT_PICKUP,
      },
      include: this.tripInclude(),
    });
    void this.emitTripInbox({
      tripId: trip.id,
      type: NotificationType.TRIP_AT_PICKUP,
      title: 'Driver at pickup',
      body: 'Mass check passed. Trip is ready to start.',
    });
    await this.audit.recordPlatform({
      action: AuditAction.TRIP_MASS_CHECKED,
      actorUserId: user.id,
      entityType: 'Trip',
      entityId: trip.id,
      metadata: { over: false, actual: input.actualMassKg, declared },
    });
    return this.mapTrip(updated);
  }

  async startTrip(
    principal: AuthenticatedPrincipal,
    tripId: string,
    input: TripStartInput,
  ) {
    this.ensureDatabase();
    if (!input.online) {
      throw new BadRequestException({
        message: 'Offline start trip rejected — online-only',
        code: 'OFFLINE_REJECTED',
      });
    }
    const user = await this.requireDriver(principal);
    const trip = await this.loadTripForDriver(user.driver!.id, tripId);

    if (trip.assignment.status !== AssignmentStatus.LOCKED) {
      throw new ForbiddenException({ message: 'Payment required', code: 'TRIP_NOT_PAID' });
    }
    if (!trip.safetyPassedAt || trip.safetyFailedAt) {
      throw new ForbiddenException({ message: 'Safety gate not passed', code: 'SAFETY_REQUIRED' });
    }
    if (this.hasPendingMass(trip.surcharges)) {
      throw new ForbiddenException({
        message: 'Pending MASS surcharge — pay or waive before start',
        code: 'MASS_SURCHARGE_PENDING',
      });
    }
    if (!trip.massCheckOk || trip.massOverDeclared) {
      throw new ForbiddenException({ message: 'Mass gate not passed', code: 'MASS_REQUIRED' });
    }
    if (trip.assignment.vehicleId) {
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: trip.assignment.vehicleId },
        select: { status: true, vehicleClass: true },
      });
      if (!vehicle || vehicle.status !== VehicleStatus.ACTIVE) {
        throw new ForbiddenException({
          message: 'Vehicle is not ACTIVE — cannot start trip',
          code: 'VEHICLE_NOT_ACTIVE',
        });
      }
      await assertAssignmentCompliance(
        this.prisma,
        {
          driver: user.driver!,
          vehicleId: trip.assignment.vehicleId,
          vehicleClass: vehicle.vehicleClass,
        },
        'forbidden',
      );
    } else {
      await assertAssignmentCompliance(
        this.prisma,
        {
          driver: user.driver!,
          vehicleId: null,
          vehicleClass: trip.assignment.vehicle?.vehicleClass ?? null,
        },
        'forbidden',
      );
    }
    if (trip.startedAt) {
      return this.mapTrip(trip, { complianceOk: true });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const t = await tx.trip.update({
        where: { id: trip.id },
        data: {
          status: TripStatus.IN_TRANSIT,
          startedAt: new Date(),
          onBreak: false,
          odometerStartKm: input.odometerStartKm,
        } as Prisma.TripUncheckedUpdateInput,
        include: this.tripInclude(),
      });
      await tx.job.update({
        where: { id: trip.jobId },
        data: { status: JobStatus.IN_TRANSIT },
      });
      return t;
    });

    await this.audit.recordPlatform({
      action: AuditAction.TRIP_STARTED,
      actorUserId: user.id,
      entityType: 'Trip',
      entityId: trip.id,
      metadata: { odometerStartKm: input.odometerStartKm },
    });
    await this.audit.recordPlatform({
      action: AuditAction.PUSH_STUB,
      actorUserId: user.id,
      entityType: 'Job',
      entityId: trip.jobId,
      metadata: { event: 'trip_started', channel: 'FCM/APNs stub' },
    });
    void this.emitTripInbox({
      tripId: trip.id,
      type: NotificationType.TRIP_STARTED,
      title: 'Trip started',
      body: 'The driver has started the trip and is in transit.',
    });

    return this.mapTrip(updated, { complianceOk: true });
  }

  /** Carrier/driver legacy path by jobId */
  async startByJobId(
    principal: AuthenticatedPrincipal,
    jobId: string,
    input: TripStartInput,
  ) {
    this.ensureDatabase();
    if (principal.role === 'DRIVER') {
      const user = await this.requireDriver(principal);
      const trip = await this.prisma.trip.findFirst({
        where: { jobId, assignment: { driverId: user.driver!.id } },
      });
      if (!trip) throw new NotFoundException('Trip not found for job');
      return this.startTrip(principal, trip.id, input);
    }
    if (principal.role === 'TRANSPORT_COMPANY') {
      throw new ForbiddenException('Carrier cannot start trip — driver must start');
    }
    throw new ForbiddenException('Driver required');
  }

  async toggleBreak(
    principal: AuthenticatedPrincipal,
    tripId: string,
    input: TripBreakInput,
  ) {
    this.ensureDatabase();
    const user = await this.requireDriver(principal);
    const trip = await this.loadTripForDriver(user.driver!.id, tripId);
    if (!trip.startedAt) {
      throw new BadRequestException('Trip not started');
    }
    // D3: same choke-point as diary — trip break also logs REST/WORK in EWD.
    if (this.nhvr) {
      const rego = trip.assignment?.vehicle?.registration ?? undefined;
      const odo =
        trip.odometerStartKm != null ? Math.round(Number(trip.odometerStartKm)) : undefined;
      await this.nhvr.syncFromTripBreak(principal.id, input.onBreak, {
        vehicleRego: rego,
        odometer: odo,
      });
    }
    const updated = await this.prisma.trip.update({
      where: { id: trip.id },
      data: {
        onBreak: input.onBreak,
        breakStartedAt: input.onBreak ? new Date() : null,
      },
      include: this.tripInclude(),
    });
    await this.audit.recordPlatform({
      action: AuditAction.TRIP_BREAK_TOGGLED,
      actorUserId: user.id,
      entityType: 'Trip',
      entityId: trip.id,
      metadata: { onBreak: input.onBreak, ewdSynced: Boolean(this.nhvr) },
    });
    this.realtimeGateway?.emitTripBreak(
      {
        tripId: trip.id,
        jobId: trip.jobId,
        onBreak: input.onBreak,
        timestamp: new Date().toISOString(),
      },
      trip.assignment?.carrierCompanyId ?? undefined,
    );
    if (input.onBreak) {
      void this.emitTripInbox({
        tripId: trip.id,
        type: NotificationType.TRIP_BREAK,
        title: 'Driver on break',
        body: 'Live tracking is paused while the driver is on break. Work diary logged REST.',
      });
    }
    return this.mapTrip(updated);
  }

  /**
   * Evaluate active stop geofence after a location sample.
   * Active stop = first PICKUP without arrivalRecorded, else first unfinished DROPOFF.
   */
  async evaluateGeofence(
    tripId: string,
    point: { lat: number; lng: number },
    actorUserId?: string,
  ) {
    const policy = await this.loadGeofencePolicy();
    const freeWaitEnvSeconds = this.config.get('GEOFENCE_FREE_WAIT_SECONDS', { infer: true });

    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        job: { include: { stops: { orderBy: { sequence: 'asc' } } } },
        stopProgress: true,
      },
    });
    if (!trip) return null;

    const progressByStop = new Map(trip.stopProgress.map((p) => [p.jobStopId, p]));
    const stops = trip.job.stops;
    // Sequence order: unfinished stop, or stop still being dwelled (arrived, not exited).
    const activeStop = stops.find((s) => {
      const p = progressByStop.get(s.id);
      if (!p?.arrivalRecorded) return true;
      if (p.enteredAt && !p.exitedAt) return true;
      return false;
    });
    if (!activeStop || activeStop.lat == null || activeStop.lng == null) {
      await this.completeTripIfReady(trip.id, actorUserId);
      return {
        activeStopId: null as string | null,
        inside: false,
        entered: false,
        waitOverageMinutes: 0,
        surcharge: null as unknown,
        tripCompleted: true,
      };
    }

    const center = {
      lat: typeof activeStop.lat === 'number' ? activeStop.lat : Number(activeStop.lat),
      lng: typeof activeStop.lng === 'number' ? activeStop.lng : Number(activeStop.lng),
    };
    const inside = isInsideRadius(point, center, policy.radiusMeters);
    let progress = progressByStop.get(activeStop.id);
    if (!progress) {
      progress = await this.prisma.tripStopProgress.create({
        data: {
          tripId: trip.id,
          jobStopId: activeStop.id,
          insideCount: 0,
          currentlyInside: false,
        },
      });
    }

    let entered = Boolean(progress.enteredAt);
    let waitOverage = progress.waitOverageMinutes;
    let surcharge: unknown = null;

    if (inside) {
      // Reset outside streak when coming back inside after a bounce.
      const nextCount = progress.currentlyInside ? progress.insideCount + 1 : 1;
      const shouldEnter =
        !progress.enteredAt && nextCount >= policy.antiBounceSamples;
      const now = new Date();
      const freeMs = freeWaitMs(activeStop.stopType, policy, freeWaitEnvSeconds);
      const freeWaitEndsAt =
        shouldEnter || progress.freeWaitEndsAt
          ? shouldEnter
            ? new Date(now.getTime() + freeMs)
            : progress.freeWaitEndsAt!
          : null;

      if (shouldEnter) {
        progress = await this.prisma.tripStopProgress.update({
          where: { id: progress.id },
          data: {
            insideCount: nextCount,
            currentlyInside: true,
            enteredAt: now,
            waitStartedAt: now,
            freeWaitEndsAt,
            exitedAt: null,
            arrivalRecorded: true,
          },
        });
        entered = true;
        if (activeStop.stopType === 'DROPOFF' && trip.startedAt) {
          await this.prisma.trip.update({
            where: { id: trip.id },
            data: { status: TripStatus.AT_DROPOFF },
          });
          // Fire-and-forget: SMTP hangs must not delay location response / POD UI.
          void this.notifyAtDropoffIfNeeded(trip.id, activeStop.id, actorUserId).catch(
            () => undefined,
          );
        }
        await this.audit.recordPlatform({
          action: AuditAction.TRIP_GEOFENCE_ENTER,
          actorUserId,
          entityType: 'Trip',
          entityId: trip.id,
          metadata: {
            jobStopId: activeStop.id,
            stopType: activeStop.stopType,
            freeWaitEndsAt: freeWaitEndsAt?.toISOString(),
            radiusMeters: policy.radiusMeters,
          },
        });
      } else {
        progress = await this.prisma.tripStopProgress.update({
          where: { id: progress.id },
          data: {
            insideCount: nextCount,
            currentlyInside: true,
            // Clear bounce-exit so dwell/waiting continues on this stop.
            exitedAt: progress.enteredAt ? null : progress.exitedAt,
          },
        });
        entered = Boolean(progress.enteredAt);
      }

      if (progress.enteredAt && progress.freeWaitEndsAt) {
        waitOverage = waitOverageMinutes(progress.freeWaitEndsAt, now);
        if (waitOverage !== progress.waitOverageMinutes) {
          progress = await this.prisma.tripStopProgress.update({
            where: { id: progress.id },
            data: { waitOverageMinutes: waitOverage },
          });
        }
        if (waitOverage > 0) {
          const amountIncGstCents = waitingSurchargeIncGstCents(waitOverage, policy);
          surcharge = await this.payments.createSurcharge({
            jobId: trip.jobId,
            tripId: trip.id,
            kind: SurchargeKind.WAITING,
            amountIncGstCents,
            idempotencyKey: `waiting:${trip.id}:${activeStop.id}`,
            stopProgressId: progress.id,
            chargeNow: false,
            metadata: {
              jobStopId: activeStop.id,
              stopType: activeStop.stopType,
              waitOverageMinutes: waitOverage,
            },
          });
        }
      }
    } else {
      // Anti-bounce exit: require N consecutive outside samples before completing the stop.
      const outsideStreak = progress.currentlyInside ? 1 : progress.insideCount + 1;
      const shouldExit =
        Boolean(progress.enteredAt) &&
        !progress.exitedAt &&
        outsideStreak >= policy.antiBounceSamples;
      progress = await this.prisma.tripStopProgress.update({
        where: { id: progress.id },
        data: {
          insideCount: outsideStreak,
          currentlyInside: false,
          exitedAt: shouldExit ? new Date() : progress.exitedAt,
        },
      });
      entered = Boolean(progress.enteredAt);
      waitOverage = progress.waitOverageMinutes;
      if (shouldExit) {
        await this.audit.recordPlatform({
          action: AuditAction.TRIP_GEOFENCE_EXIT,
          actorUserId,
          entityType: 'Trip',
          entityId: trip.id,
          metadata: {
            jobStopId: activeStop.id,
            stopType: activeStop.stopType,
          },
        });
        // Refresh progress map mentally: this stop now has exitedAt
        const remaining = stops.some((s) => {
          if (s.id === activeStop.id) return false;
          const p = progressByStop.get(s.id);
          if (!p?.arrivalRecorded) return true;
          if (p.enteredAt && !p.exitedAt) return true;
          return false;
        });
        if (!remaining) {
          await this.completeTripIfReady(trip.id, actorUserId);
        }
      }
    }

    return {
      activeStopId: activeStop.id,
      stopType: activeStop.stopType,
      inside,
      entered,
      insideCount: progress.insideCount,
      freeWaitEndsAt: progress.freeWaitEndsAt,
      waitOverageMinutes: waitOverage,
      surcharge,
    };
  }

  /**
   * Mark trip/job/assignment COMPLETED when P8 gates clear:
   * every stop geofence-done (arrivalRecorded + exitedAt) AND every DROPOFF POD FINALIZED.
   * Pending surcharges are gated at POD capture — by the time POD is FINALIZED
   * they should already be paid/waived.
   */
  private async completeTripIfReady(tripId: string, actorUserId?: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        job: { include: { stops: true } },
        stopProgress: true,
        assignment: true,
        surcharges: true,
      },
    });
    if (!trip?.startedAt || trip.status === TripStatus.COMPLETED) return;
    if (trip.job.stops.length < 1) return;

    const byStop = new Map(trip.stopProgress.map((p) => [p.jobStopId, p]));
    const geofenceDone = trip.job.stops.every((s) => {
      const p = byStop.get(s.id);
      return Boolean(p?.arrivalRecorded && p.exitedAt);
    });
    if (!geofenceDone) return;

    const dropoffs = trip.job.stops.filter((s) => s.stopType === 'DROPOFF');
    if (dropoffs.length < 1) return;
    const dropoffsReady = dropoffs.every(
      (s) => byStop.get(s.id)?.podStatus === 'FINALIZED',
    );
    if (!dropoffsReady) return;

    await this.prisma.$transaction(async (tx) => {
      await tx.trip.update({
        where: { id: trip.id },
        data: {
          status: TripStatus.COMPLETED,
          completedAt: new Date(),
          onBreak: false,
        },
      });
      await tx.job.update({
        where: { id: trip.jobId },
        data: { status: JobStatus.COMPLETED },
      });
      if (trip.assignmentId) {
        await tx.assignment.update({
          where: { id: trip.assignmentId },
          data: { status: AssignmentStatus.COMPLETED },
        });
      }
    });

    await this.audit.recordPlatform({
      action: AuditAction.TRIP_COMPLETED,
      actorUserId,
      entityType: 'Trip',
      entityId: trip.id,
      metadata: { jobId: trip.jobId },
    });
    void this.emitTripInbox({
      tripId: trip.id,
      type: NotificationType.TRIP_COMPLETED,
      title: 'Trip completed',
      body: 'All stops and POD are complete. The job is finished.',
      includeDriver: true,
    });

    // Reliability score recovery (+1 point toward 100 on clean delivery)
    try {
      const carrierCompanyId = trip.assignment?.carrierCompanyId;
      const driverId = trip.assignment?.driverId;
      if (carrierCompanyId) {
        const company = await this.prisma.company.findUnique({
          where: { id: carrierCompanyId },
          select: { reliabilityScore: true },
        });
        if (company && company.reliabilityScore < 100) {
          const nextScore = Math.min(100, company.reliabilityScore + 1);
          await this.prisma.company.update({
            where: { id: carrierCompanyId },
            data: { reliabilityScore: nextScore },
          });
          await this.audit.recordPlatform({
            action: AuditAction.CARRIER_RELIABILITY_RECOVERED,
            actorUserId,
            entityType: 'Company',
            entityId: carrierCompanyId,
            metadata: { tripId: trip.id, delta: 1, nextScore },
          });
        }
      }
      if (driverId) {
        const driver = await this.prisma.driver.findUnique({
          where: { id: driverId },
          select: { reliabilityScore: true },
        });
        if (driver && driver.reliabilityScore < 100) {
          const nextDriverScore = Math.min(100, driver.reliabilityScore + 1);
          await this.prisma.driver.update({
            where: { id: driverId },
            data: { reliabilityScore: nextDriverScore },
          });
        }
      }
    } catch (err) {
      this.logger.warn(`Failed to recover reliability score for trip ${trip.id}: ${err}`);
    }

    try {
      await this.generateCompletionDocuments(trip.id, actorUserId);
    } catch {
      // Completion must not roll back if PDF/email fails.
    }

    // M12 — carrier Transfer after clearing (0 days = immediate in local/test).
    try {
      const result = await this.payments.tryDisburseCarrierTransfer(trip.jobId);
      if (result.transferred) {
        this.logger.log(
          `Carrier transfer job=${trip.jobId} transfer=${result.transferId} mock=${result.mock}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Carrier transfer skipped job=${trip.jobId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Hourly run sheet PDF — layout aligned to
   * `templates/hourly-run-sheet.preview.html` / `docs/operations/clox-run-sheet.md`.
   */
  private async buildHourlyRunSheetPdf(params: {
    trip: {
      id: string;
      jobId: string;
      startedAt: Date | null;
      completedAt: Date | null;
      onBreak: boolean;
      breakStartedAt: Date | null;
      job: {
        title: string | null;
        billableHours: number | null;
        hourlyPattern: string | null;
        routeDistanceKm: number | null;
        siteManeuverability: string | null;
        siteFacility: string | null;
        stops: Array<{
          id: string;
          stopType: string;
          addressLine: string | null;
          suburb: string | null;
          state: string | null;
          postcode: string | null;
        }>;
      };
      stopProgress: Array<{
        jobStopId: string;
        enteredAt: Date | null;
        exitedAt: Date | null;
        waitOverageMinutes: number;
        signerName: string | null;
        signatureStorageKey: string | null;
        signedAt: Date | null;
      }>;
      assignment: {
        driver: { id: string } | null;
        vehicle: { registration: string | null; label: string | null } | null;
      } | null;
    } & TripOdometerFields;
    driverName: string;
    carrier: { legalName: string | null; tradingName: string | null; abn: string | null } | null;
    completedDate: string;
  }): Promise<Buffer> {
    const { trip, driverName, carrier, completedDate } = params;
    const byStop = new Map(trip.stopProgress.map((p) => [p.jobStopId, p]));
    const odo = this.asTripOdometer(trip);
    const stopCount = trip.job.stops.length;
    const dangerRowIndexes: number[] = [];

    const tableRows = trip.job.stops.map((stop, index) => {
      const p = byStop.get(stop.id);
      const arrive = p?.enteredAt ? formatPodDateTime(p.enteredAt) : '-';
      const depart = p?.exitedAt ? formatPodDateTime(p.exitedAt) : '-';
      let dwellMins: number | null = null;
      if (p?.enteredAt && p?.exitedAt) {
        dwellMins = Math.max(
          0,
          Math.round((p.exitedAt.getTime() - p.enteredAt.getTime()) / 60_000),
        );
      }
      const dwell =
        dwellMins != null
          ? `${dwellMins} mins`
          : p?.waitOverageMinutes
            ? `${p.waitOverageMinutes}m overage`
            : '-';
      if (dwellMins != null && dwellMins > 60) {
        dangerRowIndexes.push(index);
      }
      const addr =
        [
          stop.addressLine,
          [stop.suburb, stop.state, stop.postcode].filter(Boolean).join(' '),
        ]
          .filter(Boolean)
          .join(', ') || '-';
      let odoCell = 'N/A (GPS sync)';
      if (index === 0) {
        odoCell =
          odo.odometerStartKm != null
            ? `${odo.odometerStartKm} km (manual)`
            : 'not captured (manual)';
      } else if (index === stopCount - 1) {
        odoCell =
          odo.odometerEndKm != null
            ? `${odo.odometerEndKm} km (final manual)`
            : 'not captured (final manual)';
      }
      return [
        String(index + 1),
        stop.stopType,
        addr,
        arrive,
        depart,
        dwell,
        odoCell,
      ];
    });

    const firstArrive = trip.job.stops
      .map((s) => byStop.get(s.id)?.enteredAt)
      .find((d): d is Date => Boolean(d));
    const lastArrive = [...trip.job.stops]
      .reverse()
      .map((s) => byStop.get(s.id)?.enteredAt)
      .find((d): d is Date => Boolean(d));
    let actualHours: number | null = null;
    if (firstArrive && lastArrive) {
      actualHours = Math.max(
        0,
        (lastArrive.getTime() - firstArrive.getTime()) / (1000 * 60 * 60),
      );
    }
    const billedHours = Math.max(4, trip.job.billableHours ?? actualHours ?? 4);
    const floorNote =
      actualHours != null && actualHours < 4
        ? `4-hour floor: Total time: ${actualHours.toFixed(2)} h · Billed time: 4.0 hours (Minimum Engagement).`
        : `Billed hours: ${billedHours.toFixed(1)} (4.0 hour floor applies).`;

    const odoDelta =
      odo.odometerStartKm != null && odo.odometerEndKm != null
        ? odo.odometerEndKm - odo.odometerStartKm
        : null;
    const gpsKm = odo.odometerGpsDistanceKm;
    const distanceLabel =
      gpsKm != null
        ? `${gpsKm.toFixed(1)} km (GPS)`
        : odoDelta != null
          ? `${odoDelta.toFixed(1)} km (odometer)`
          : trip.job.routeDistanceKm != null
            ? `${trip.job.routeDistanceKm} km (planned)`
            : '-';

    const callouts: Array<{ tone: 'billing' | 'flag'; text: string }> = [
      { tone: 'billing', text: floorNote },
    ];
    if (odo.odometerDiscrepancyFlag) {
      const odoPart =
        odoDelta != null ? `${odoDelta.toFixed(1)} km odo` : 'odo n/a';
      const gpsPart = gpsKm != null ? `${gpsKm.toFixed(1)} km GPS` : 'GPS n/a';
      callouts.push({
        tone: 'flag',
        text: `FLAG: Odometer vs GPS discrepancy > 10% (${odoPart} / ${gpsPart}) — Super Admin review`,
      });
    }

    const driverId = trip.assignment?.driver?.id;
    const windowStart = trip.startedAt ?? firstArrive;
    const windowEnd = trip.completedAt ?? lastArrive ?? new Date();
    const breakTableRows: string[][] = [];
    let totalWorkLabel = '-';
    let totalRestLabel = '-';

    if (driverId && windowStart) {
      try {
        const records = await this.prisma.ewdWorkRestRecord.findMany({
          where: {
            driverId,
            startTime: { gte: windowStart, lte: windowEnd },
          },
          orderBy: { startTime: 'asc' },
        });
        let workMins = 0;
        let restMins = 0;
        let breakIndex = 0;
        for (const rec of records) {
          const mins =
            rec.durationMinutes ??
            (rec.endTime
              ? Math.max(
                  0,
                  Math.round(
                    (rec.endTime.getTime() - rec.startTime.getTime()) / 60_000,
                  ),
                )
              : null);
          if (rec.activity === 'WORK') {
            workMins += mins ?? 0;
          } else if (rec.activity === 'REST') {
            restMins += mins ?? 0;
            breakIndex += 1;
            breakTableRows.push([
              `Break ${breakIndex}`,
              formatPodDateTime(rec.startTime),
              rec.endTime ? formatPodDateTime(rec.endTime) : 'open',
              mins != null ? `${mins} mins` : '-',
              rec.locationStart || rec.locationEnd || '-',
            ]);
          }
        }
        if (workMins > 0 || restMins > 0) {
          totalWorkLabel = formatHhMm(workMins);
          totalRestLabel = formatHhMm(restMins);
        }
      } catch (err) {
        this.logger.warn(
          `Run sheet EWD break lookup failed trip=${trip.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (breakTableRows.length === 0) {
      if (trip.onBreak && trip.breakStartedAt) {
        breakTableRows.push([
          'Break 1',
          formatPodDateTime(trip.breakStartedAt),
          'open',
          '-',
          '-',
        ]);
      } else {
        breakTableRows.push(['—', 'No breaks recorded', '-', '-', '-']);
      }
    }

    const signedStops = [...trip.stopProgress]
      .filter((p) => p.signerName)
      .sort((a, b) => {
        const at = a.signedAt?.getTime() ?? 0;
        const bt = b.signedAt?.getTime() ?? 0;
        return bt - at;
      });
    const finalSigned = signedStops[0];
    const signer = finalSigned?.signerName ?? '-';
    const signatureImages: BrandedPdfImage[] = [];
    if (finalSigned?.signatureStorageKey) {
      const sigFile = await this.readStoredArtifact(finalSigned.signatureStorageKey);
      if (sigFile) {
        signatureImages.push({
          caption: `Final receiver SOG | ${signer}`,
          buffer: sigFile.buffer,
          fitWidth: 220,
          fitHeight: 90,
        });
      }
    }

    const jobShort = trip.jobId.slice(0, 8);
    return buildBrandedPdf({
      documentTitle: 'Hourly Run Sheet',
      subtitle: `Job ${jobShort} | ${completedDate}`,
      headerRef: `CLOX-runsheet-${jobShort} | Job ${jobShort}`,
      logo: loadCloxLogoBuffer(),
      footerNote: 'CLOX | Confidential | System-generated hourly run sheet',
      sections: [
        {
          title: 'Trip header',
          rows: [
            { label: 'Driver', value: driverName },
            { label: 'Date', value: completedDate },
            {
              label: 'Transport company',
              value: carrier?.legalName || carrier?.tradingName || '-',
            },
            { label: 'ABN', value: carrier?.abn || '-' },
            {
              label: 'Vehicle rego',
              value: trip.assignment?.vehicle?.registration || '-',
            },
            { label: 'Job ID', value: trip.jobId },
            { label: 'Pattern', value: trip.job.hourlyPattern || '-' },
            {
              label: 'Site access',
              value: `${trip.job.siteManeuverability || '-'} / ${trip.job.siteFacility || '-'}`,
            },
          ],
        },
        {
          title: 'Trip summary',
          rows: [
            {
              label: 'Total duration',
              value:
                actualHours != null
                  ? `${actualHours.toFixed(2)} h actual · billed ${billedHours.toFixed(1)} h`
                  : `Billed ${billedHours.toFixed(1)} h`,
            },
            { label: 'Total distance', value: distanceLabel },
            {
              label: 'Odometer',
              value: [
                odo.odometerStartKm != null
                  ? `start ${odo.odometerStartKm} km`
                  : 'start n/a',
                odo.odometerEndKm != null
                  ? `end ${odo.odometerEndKm} km`
                  : 'end n/a',
                odoDelta != null ? `delta ${odoDelta.toFixed(1)} km` : null,
              ]
                .filter(Boolean)
                .join(' · '),
            },
          ],
          callouts,
        },
        {
          title: 'Stops',
          table: {
            headers: [
              '#',
              'Type',
              'Address',
              'Arrival',
              'Departure',
              'Dwell / wait',
              'Odometer',
            ],
            rows: tableRows,
            dangerRowIndexes,
          },
          paragraphs:
            dangerRowIndexes.length > 0
              ? [
                  'Dwell > 60 minutes flagged in red for potential detention billing.',
                ]
              : undefined,
        },
        {
          title: 'Fatigue & break log',
          table: {
            headers: ['Break', 'Start', 'End', 'Duration', 'Location'],
            rows: breakTableRows,
          },
          rows: [
            { label: 'Total work time', value: totalWorkLabel },
            { label: 'Total rest time', value: totalRestLabel },
          ],
        },
        {
          title: 'Signatures',
          rows: [
            {
              label: 'Driver signature',
              value: `${driverName} (digital capture on device — see diary/SOG if stored)`,
            },
            {
              label: 'Final receiver (SOG)',
              value: signer,
            },
          ],
          images: signatureImages,
        },
      ],
    });
  }

  /** M10 Phase D — tax invoice + hourly run sheet after COMPLETED. */
  private async generateCompletionDocuments(tripId: string, actorUserId?: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        job: {
          include: {
            stops: { orderBy: { sequence: 'asc' } },
            senderCompany: {
              select: {
                legalName: true,
                tradingName: true,
                abn: true,
                email: true,
                invoiceLegalName: true,
                invoiceAddressLine1: true,
                invoiceSuburb: true,
                invoiceState: true,
                invoicePostcode: true,
                users: {
                  where: { role: 'SENDER', status: 'ACTIVE' },
                  select: { email: true },
                  take: 10,
                },
              },
            },
          },
        },
        stopProgress: true,
        surcharges: true,
        assignment: {
          include: {
            proposal: true,
            vehicle: { select: { registration: true, label: true } },
            driver: { include: { user: { select: { name: true, email: true } } } },
            carrierCompany: {
              select: {
                legalName: true,
                tradingName: true,
                abn: true,
                email: true,
                users: {
                  where: { role: 'TRANSPORT_COMPANY', status: 'ACTIVE' },
                  select: { email: true },
                  take: 10,
                },
              },
            },
          },
        },
      },
    });
    if (!trip || trip.status !== TripStatus.COMPLETED) return;
    if (trip.taxInvoiceStorageKey) return;

    const proposal = trip.assignment?.proposal;
    const paidSurcharges = trip.surcharges.filter(
      (s) => s.status === SurchargeStatus.PAID,
    );

    /** Prefer snapshotted PaymentEvent amounts (per-sender fee already applied at charge). */
    const chargeEvent = await this.prisma.paymentEvent.findFirst({
      where: {
        jobId: trip.jobId,
        type: PaymentEventType.CHARGE,
        status: PaymentEventStatus.SUCCEEDED,
      },
      orderBy: { createdAt: 'desc' },
    });
    const fareSnap = parseSenderFeeSnapshot(
      chargeEvent?.metadata,
      chargeEvent?.amountIncGstCents ??
        proposal?.amountIncGstCents ??
        trip.job.estimateIncGstCents ??
        0,
    );
    const freightBaseInc =
      fareSnap.baseIncGstCents > 0
        ? fareSnap.baseIncGstCents
        : (proposal?.amountIncGstCents ?? trip.job.estimateIncGstCents ?? 0);
    const freightBase = splitIncGst(freightBaseInc);
    const freightFeeInc =
      fareSnap.mode === 'EXCLUSIVE' ? fareSnap.feeIncGstCents : 0;
    const freightFee = splitIncGst(freightFeeInc);

    /** Surcharges are carrier-bound on the invoice (no CLOX fee line). */
    const surchargeEx = paidSurcharges.reduce(
      (sum, s) => sum + s.amountExGstCents,
      0,
    );
    const surchargeGst = paidSurcharges.reduce(
      (sum, s) => sum + s.amountGstCents,
      0,
    );
    const surchargeInc = paidSurcharges.reduce(
      (sum, s) => sum + s.amountIncGstCents,
      0,
    );

    const totalInc =
      (chargeEvent?.amountIncGstCents ??
        freightBase.amountIncGstCents + freightFee.amountIncGstCents) +
      surchargeInc;
    const total = splitIncGst(totalInc);

    const feePercent = fareSnap.feePercent;
    const feeMode = fareSnap.mode;
    const feeDisclosure =
      feePercent > 0
        ? feeMode === 'EXCLUSIVE'
          ? `CLOX platform fee ${feePercent}% exclusive applied on freight at payment.`
          : `CLOX platform fee ${feePercent}% inclusive — listed freight is all-in; fee is disclosure only.`
        : 'No CLOX platform fee on this freight charge.';

    const sender = trip.job.senderCompany;
    const carrier = trip.assignment?.carrierCompany;
    const driverName =
      trip.assignment?.driver?.user?.name ||
      trip.assignment?.driver?.user?.email ||
      '—';
    const billTo =
      sender?.invoiceLegalName ||
      sender?.tradingName ||
      sender?.legalName ||
      'Sender';
    const billAddress = [
      sender?.invoiceAddressLine1,
      [sender?.invoiceSuburb, sender?.invoiceState, sender?.invoicePostcode]
        .filter(Boolean)
        .join(' '),
    ]
      .filter(Boolean)
      .join(', ');

    const invoiceRef = `INV-${trip.jobId.slice(0, 8).toUpperCase()}`;
    const completedDate = (trip.completedAt ?? new Date()).toISOString().slice(0, 10);
    /** Matches approved `templates/tax-invoice.preview.html` amounts table. */
    const amountTableRows: string[][] = [
      [
        'Freight base (accepted bid)',
        formatAudCents(freightBase.amountExGstCents),
        formatAudCents(freightBase.amountGstCents),
        formatAudCents(freightBase.amountIncGstCents),
      ],
    ];
    const accentRowIndexes: number[] = [];
    if (feeMode === 'EXCLUSIVE' && freightFee.amountIncGstCents > 0) {
      accentRowIndexes.push(amountTableRows.length);
      amountTableRows.push([
        `CLOX platform fee ${feePercent}% exclusive`,
        formatAudCents(freightFee.amountExGstCents),
        formatAudCents(freightFee.amountGstCents),
        formatAudCents(freightFee.amountIncGstCents),
      ]);
    }
    if (surchargeInc > 0) {
      amountTableRows.push([
        'Paid surcharges (carrier)',
        formatAudCents(surchargeEx),
        formatAudCents(surchargeGst),
        formatAudCents(surchargeInc),
      ]);
    }
    amountTableRows.push([
      'Total charged',
      formatAudCents(total.amountExGstCents),
      formatAudCents(total.amountGstCents),
      formatAudCents(total.amountIncGstCents),
    ]);

    const carrierName =
      carrier?.legalName || carrier?.tradingName || 'Carrier';
    const vehicleRego = trip.assignment?.vehicle?.registration || '-';

    const invoicePdf = await buildBrandedPdf({
      documentTitle: 'Tax Invoice',
      subtitle: `${invoiceRef} | ${completedDate} | AUD | What the sender paid`,
      headerRef: `${invoiceRef} | Job ${trip.jobId.slice(0, 8)}`,
      logo: loadCloxLogoBuffer(),
      footerNote: 'CLOX | Confidential | System-generated tax invoice',
      sections: [
        {
          title: 'Invoice summary',
          rows: [
            { label: 'Invoice ref', value: invoiceRef },
            { label: 'Job', value: trip.job.title || trip.jobId },
            { label: 'Date', value: completedDate },
            { label: 'Pricing model', value: trip.job.pricingModel },
            {
              label: 'CLOX platform fee',
              value:
                feePercent > 0
                  ? `${feePercent}% ${feeMode.toLowerCase()} (freight only)`
                  : 'none',
            },
          ],
        },
        {
          title: 'Parties',
          rows: [
            { label: 'Bill to (sender)', value: billTo },
            { label: 'Address', value: billAddress || '-' },
            { label: 'Sender ABN', value: sender?.abn || '-' },
            { label: 'Supplier (carrier)', value: carrierName },
            { label: 'Carrier ABN', value: carrier?.abn || '-' },
            {
              label: 'Driver / vehicle',
              value: `${driverName} · ${vehicleRego}`,
            },
          ],
        },
        {
          title: 'Amounts (AUD) — what sender paid',
          table: {
            headers: ['Description', 'Ex GST', 'GST', 'Inc GST'],
            rows: amountTableRows,
            accentRowIndexes,
          },
        },
        {
          title: 'Notes',
          paragraphs: [
            ...(feeMode === 'INCLUSIVE' && feePercent > 0
              ? [
                  `Inclusive disclosure: listed freight includes ~${formatAudCents(fareSnap.feeIncGstCents)} CLOX platform fee (${feePercent}%).`,
                ]
              : []),
            feeDisclosure,
            'Paid surcharges are carrier amounts (no CLOX platform fee line).',
          ],
        },
      ],
    });
    const invoiceArtifact = await writeTripArtifact({
      rootDir: this.storageRoot(),
      tripId: trip.id,
      stopId: '_trip',
      kind: 'invoice-pdf',
      ext: 'pdf',
      buffer: invoicePdf,
    });

    let runSheetKey: string | null = null;
    let runSheetPdf: Buffer | null = null;
    if (trip.job.pricingModel === JobPricingModel.HOURLY) {
      runSheetPdf = await this.buildHourlyRunSheetPdf({
        trip,
        driverName,
        carrier,
        completedDate,
      });
      const runSheetArtifact = await writeTripArtifact({
        rootDir: this.storageRoot(),
        tripId: trip.id,
        stopId: '_trip',
        kind: 'run-sheet-pdf',
        ext: 'pdf',
        buffer: runSheetPdf,
      });
      runSheetKey = runSheetArtifact.storageKey;
    }

    await this.prisma.trip.update({
      where: { id: trip.id },
      data: {
        taxInvoiceStorageKey: invoiceArtifact.storageKey,
        ...(runSheetKey ? { runSheetStorageKey: runSheetKey } : {}),
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.TAX_INVOICE_GENERATED,
      actorUserId,
      entityType: 'Trip',
      entityId: trip.id,
      metadata: { taxInvoiceStorageKey: invoiceArtifact.storageKey },
    });
    if (runSheetKey) {
      await this.audit.recordPlatform({
        action: AuditAction.RUN_SHEET_GENERATED,
        actorUserId,
        entityType: 'Trip',
        entityId: trip.id,
        metadata: { runSheetStorageKey: runSheetKey },
      });
    }

    const senderEmails = [
      ...(sender?.users.map((u) => u.email) ?? []),
      ...(sender?.email ? [sender.email] : []),
    ];
    const carrierEmails = [
      ...(carrier?.users.map((u) => u.email) ?? []),
      ...(carrier?.email ? [carrier.email] : []),
    ];
    const receiverEmail = trip.job.receiverEmail ?? null;

    let podAttachment: {
      filename: string;
      content: Buffer;
      contentType: string;
    } | null = null;
    if (trip.podStorageKey) {
      try {
        const podBuf = await readFile(join(this.storageRoot(), trip.podStorageKey));
        podAttachment = {
          filename: `CLOX-POD-${trip.jobId.slice(0, 8)}.pdf`,
          content: podBuf,
          contentType: 'application/pdf',
        };
      } catch {
        // POD already emailed at finalize; skip if file missing.
      }
    }

    // PRD / run-sheet spec: invoice → sender; run sheet → sender + carrier; POD → receiver (+ sender).
    await this.notifications.notifyTripCompletionDocuments({
      senderEmails,
      carrierEmails,
      receiverEmail,
      jobId: trip.jobId,
      jobTitle: trip.job.title,
      totalIncGstCents: totalInc,
      taxInvoice: {
        filename: `CLOX-tax-invoice-${invoiceRef}.pdf`,
        content: invoicePdf,
        contentType: 'application/pdf',
      },
      runSheet: runSheetPdf
        ? {
            filename: `CLOX-run-sheet-${trip.jobId.slice(0, 8)}.pdf`,
            content: runSheetPdf,
            contentType: 'application/pdf',
          }
        : null,
      pod: podAttachment,
    });
  }

  async postLocation(
    principal: AuthenticatedPrincipal,
    tripId: string,
    input: TripLocationInput,
  ) {
    this.ensureDatabase();
    const user = await this.requireDriver(principal);
    const trip = await this.loadTripForDriver(user.driver!.id, tripId);
    if (!trip.startedAt) {
      throw new ForbiddenException({
        message: 'Location ingest only after trip start',
        code: 'TRIP_NOT_STARTED',
      });
    }
    if (trip.onBreak) {
      // Still store sample but mark paused for sender visibility
    }
    const sample = await this.prisma.tripLocationSample.create({
      data: {
        tripId: trip.id,
        lat: input.lat,
        lng: input.lng,
        recordedAt: input.recordedAt ? new Date(input.recordedAt) : new Date(),
      },
    });
    await this.audit.recordPlatform({
      action: AuditAction.TRIP_LOCATION,
      actorUserId: user.id,
      entityType: 'Trip',
      entityId: trip.id,
      metadata: { lat: input.lat, lng: input.lng, onBreak: trip.onBreak },
    });

    const geofence = await this.evaluateGeofence(
      trip.id,
      { lat: input.lat, lng: input.lng },
      user.id,
    );

    // Never await mail here — SMTP latency must not delay mock/real location → POD.
    void this.maybeAutoNotifyApproaching(
      trip.id,
      { lat: input.lat, lng: input.lng },
      user.id,
    ).catch(() => undefined);

    // Broadcast real-time location via Socket.io non-blocking (suppressed while driver is on break)
    if (this.realtimeGateway && !trip.onBreak) {
      void this.broadcastLocationUpdate(trip, user.driver!.id, input, sample.recordedAt).catch(
        (err) => this.logger.warn({ err }, 'Failed to emit realtime vehicle location'),
      );
    }

    return {
      id: sample.id,
      recordedAt: sample.recordedAt,
      onBreak: trip.onBreak,
      visibleToSender: !trip.onBreak,
      geofence,
    };
  }

  async getSenderTracking(principal: AuthenticatedPrincipal, jobId: string) {
    this.ensureDatabase();
    if (principal.role !== 'SENDER') {
      throw new ForbiddenException('Sender required');
    }
    const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
    if (!user?.companyId) throw new NotFoundException();

    const trip = await this.prisma.trip.findFirst({
      where: { jobId, job: { senderCompanyId: user.companyId } },
      include: {
        job: { include: { stops: { orderBy: { sequence: 'asc' } } } },
        locations: { orderBy: { recordedAt: 'desc' }, take: 20 },
        assignment: { include: { vehicle: true } },
        stopProgress: { include: { jobStop: true } },
        surcharges: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
    });
    if (!trip) throw new NotFoundException('Trip not found');

    if (!trip.startedAt) {
      return {
        visible: false,
        message: 'Tracking visible only after Trip_Started',
        code: 'TRACKING_NOT_LIVE',
        jobId,
        tripId: trip.id,
        tripStatus: trip.status,
        stopsProgress: this.mapStopProgress(trip.stopProgress),
        surcharges: this.mapSurcharges(trip.surcharges),
        taxInvoiceStorageKey: trip.taxInvoiceStorageKey,
        runSheetStorageKey: trip.runSheetStorageKey,
        podStorageKey: trip.podStorageKey,
      };
    }

    const samples = trip.onBreak ? [] : trip.locations;
    const latest = samples[0]
      ? {
          lat: Number(samples[0].lat),
          lng: Number(samples[0].lng),
          recordedAt: samples[0].recordedAt,
        }
      : null;

    const routeSnapshot = trip.onBreak
      ? {
          route: null,
          etaMinutes: null,
          distanceKmRemaining: null,
          nextStopId: null,
        }
      : await this.buildTripRouteSnapshot({
          stops: trip.job.stops,
          stopProgress: trip.stopProgress,
          latest,
        });

    return {
      visible: true,
      tripId: trip.id,
      onBreak: trip.onBreak,
      etaPaused: trip.onBreak,
      tripStatus: trip.status,
      startedAt: trip.startedAt,
      job: {
        id: trip.jobId,
        title: trip.job.title,
        stops: trip.job.stops.map((s) => ({
          id: s.id,
          sequence: s.sequence,
          stopType: s.stopType,
          suburb: s.suburb,
          lat: s.lat == null ? null : Number(s.lat),
          lng: s.lng == null ? null : Number(s.lng),
        })),
      },
      locations: samples.map((l) => ({
        lat: Number(l.lat),
        lng: Number(l.lng),
        recordedAt: l.recordedAt,
      })),
      latest,
      route: routeSnapshot.route,
      etaMinutes: routeSnapshot.etaMinutes,
      distanceKmRemaining: routeSnapshot.distanceKmRemaining,
      nextStopId: routeSnapshot.nextStopId,
      stopsProgress: this.mapStopProgress(trip.stopProgress),
      surcharges: this.mapSurcharges(trip.surcharges),
      taxInvoiceStorageKey: trip.taxInvoiceStorageKey,
      runSheetStorageKey: trip.runSheetStorageKey,
      podStorageKey: trip.podStorageKey,
    };
  }

  private async buildTripRouteSnapshot(params: {
    stops: Array<{
      id: string;
      sequence: number;
      stopType: string;
      lat: unknown;
      lng: unknown;
    }>;
    stopProgress: Array<{
      jobStopId: string;
      exitedAt: Date | null;
      podStatus?: string | null;
    }>;
    latest: { lat: number; lng: number } | null;
  }): Promise<{
    route: {
      encodedPolyline: string;
      distanceKm: number;
      durationMinutes: number;
      source: 'valhalla';
    } | null;
    etaMinutes: number | null;
    distanceKmRemaining: number | null;
    nextStopId: string | null;
  }> {
    const remainingStops = this.getRemainingTripStops(params.stops, params.stopProgress);
    const nextStopId = remainingStops[0]?.id ?? null;

    const plannedStops = params.stops
      .filter((s) => s.lat != null && s.lng != null)
      .map((s) => ({ lat: Number(s.lat), lng: Number(s.lng) }));

    const waypoints = params.latest
      ? [
          { lat: params.latest.lat, lng: params.latest.lng },
          ...remainingStops.map((s) => ({ lat: s.lat, lng: s.lng })),
        ]
      : plannedStops;

    if (waypoints.length >= 2) {
      const valRoute = await this.getCachedValhallaRoute(waypoints);
      if (valRoute && valRoute.encodedPolyline) {
        const roundedKm = Math.round(valRoute.distanceKm * 10) / 10;
        return {
          route: {
            encodedPolyline: valRoute.encodedPolyline,
            distanceKm: roundedKm,
            durationMinutes: valRoute.durationMin,
            source: 'valhalla',
          },
          etaMinutes: valRoute.durationMin,
          distanceKmRemaining: roundedKm,
          nextStopId,
        };
      }
      let totalMeters = 0;
      for (let i = 0; i < waypoints.length - 1; i += 1) {
        totalMeters += haversineMeters(
          waypoints[i].lat,
          waypoints[i].lng,
          waypoints[i + 1].lat,
          waypoints[i + 1].lng,
        );
      }
      const distKm = Math.round((totalMeters / 1000) * 10) / 10;
      return {
        route: null,
        etaMinutes: distKm > 0 ? Math.max(1, Math.ceil((distKm / 40) * 60)) : 0,
        distanceKmRemaining: distKm,
        nextStopId,
      };
    }

    if (remainingStops.length === 0) {
      return {
        route: null,
        etaMinutes: 0,
        distanceKmRemaining: 0,
        nextStopId: null,
      };
    }

    return {
      route: null,
      etaMinutes: null,
      distanceKmRemaining: null,
      nextStopId,
    };
  }

  /**
   * Phase C — Carrier fleet live overview: active trips for this carrier company
   * with latest GPS sample, vehicle/driver info, and remaining stops.
   */
  async getCarrierFleetLive(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    if (principal.role !== 'TRANSPORT_COMPANY') {
      throw new ForbiddenException('Carrier company required');
    }
    const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
    if (!user?.companyId) {
      throw new NotFoundException('Carrier company not found');
    }

    const activeStatuses: TripStatus[] = [
      TripStatus.EN_ROUTE_PICKUP,
      TripStatus.AT_PICKUP,
      TripStatus.IN_TRANSIT,
      TripStatus.AT_DROPOFF,
      TripStatus.BREAKDOWN,
    ];

    const trips = await this.prisma.trip.findMany({
      where: {
        status: { in: activeStatuses },
        assignment: { carrierCompanyId: user.companyId },
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      include: {
        job: { include: { stops: { orderBy: { sequence: 'asc' } } } },
        assignment: {
          include: {
            vehicle: true,
            driver: { include: { user: { select: { name: true, email: true } } } },
          },
        },
        locations: { orderBy: { recordedAt: 'desc' }, take: 1 },
        stopProgress: true,
      },
    });

    return {
      companyId: user.companyId,
      trips: trips.map((trip) => {
        const latestRow = trip.locations[0] ?? null;
        const remainingStops = this.getRemainingTripStops(trip.job.stops, trip.stopProgress);
        const nextStop = remainingStops[0] ?? null;
        const nextStopRecord = nextStop
          ? trip.job.stops.find((s) => s.id === nextStop.id) ?? null
          : null;

        return {
          tripId: trip.id,
          jobId: trip.jobId,
          jobTitle: trip.job.title,
          tripStatus: trip.status,
          onBreak: trip.onBreak,
          startedAt: trip.startedAt,
          vehicle: trip.assignment?.vehicle
            ? {
                id: trip.assignment.vehicle.id,
                label: trip.assignment.vehicle.label,
                registration: trip.assignment.vehicle.registration,
                vehicleClass: trip.assignment.vehicle.vehicleClass,
              }
            : null,
          driver: trip.assignment?.driver
            ? {
                id: trip.assignment.driver.id,
                name: trip.assignment.driver.user?.name ?? null,
                email: trip.assignment.driver.user?.email ?? null,
              }
            : null,
          latest: latestRow
            ? {
                lat: Number(latestRow.lat),
                lng: Number(latestRow.lng),
                recordedAt: latestRow.recordedAt,
              }
            : null,
          nextStop: nextStop
            ? {
                id: nextStop.id,
                sequence: nextStop.sequence,
                stopType: nextStop.stopType,
                suburb: nextStopRecord?.suburb ?? null,
                lat: nextStop.lat,
                lng: nextStop.lng,
              }
            : null,
          stops: trip.job.stops.map((s) => ({
            id: s.id,
            sequence: s.sequence,
            stopType: s.stopType,
            suburb: s.suburb,
            lat: s.lat == null ? null : Number(s.lat),
            lng: s.lng == null ? null : Number(s.lng),
          })),
        };
      }),
    };
  }

  private async getCachedValhallaRoute(
    waypoints: Array<{ lat: number; lng: number }>,
  ): Promise<{ encodedPolyline: string; distanceKm: number; durationMin: number } | null> {
    if (!this.valhalla?.isEnabled || waypoints.length < 2) return null;
    const key = waypoints
      .map((w) => `${Math.round(w.lat * 1000)},${Math.round(w.lng * 1000)}`)
      .join(';');
    const now = Date.now();
    const cached = this.valhallaRouteCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const fresh = await this.valhalla.getRoute(waypoints);
    if (fresh && fresh.encodedPolyline) {
      if (this.valhallaRouteCache.size >= 200) {
        const oldestKey = this.valhallaRouteCache.keys().next().value;
        if (oldestKey) this.valhallaRouteCache.delete(oldestKey);
      }
      this.valhallaRouteCache.set(key, {
        expiresAt: now + 20_000,
        value: fresh,
      });
    }
    return fresh;
  }

  private async broadcastLocationUpdate(
    trip: {
      id: string;
      jobId: string;
      assignment?: { vehicleId?: string | null; carrierCompanyId?: string | null } | null;
      job?: {
        stops?: Array<{
          id: string;
          sequence: number;
          stopType: string;
          lat: unknown;
          lng: unknown;
        }>;
      } | null;
      stopProgress?: Array<{
        jobStopId: string;
        exitedAt: Date | null;
        podStatus?: string | null;
      }>;
    },
    driverId: string,
    input: { lat: number; lng: number },
    recordedAt: Date,
  ): Promise<void> {
    if (!this.realtimeGateway) return;
    const vehicleId = trip.assignment?.vehicleId ?? undefined;
    const carrierCompanyId = trip.assignment?.carrierCompanyId ?? undefined;
    const snapped = this.valhalla?.isEnabled
      ? await this.valhalla.snapToRoad(input.lat, input.lng)
      : null;
    this.realtimeGateway.emitVehicleLocation(
      {
        tripId: trip.id,
        driverId,
        vehicleId,
        lat: input.lat,
        lng: input.lng,
        ...(snapped ? { snappedLat: snapped.lat, snappedLng: snapped.lng } : {}),
        timestamp: recordedAt.toISOString(),
      },
      carrierCompanyId,
    );
    await this.emitLiveEtaUpdate(
      trip,
      { lat: snapped?.lat ?? input.lat, lng: snapped?.lng ?? input.lng },
      recordedAt,
    );
  }

  private getRemainingTripStops(
    stops: Array<{
      id: string;
      sequence: number;
      stopType: string;
      lat: unknown;
      lng: unknown;
    }>,
    stopProgress: Array<{
      jobStopId: string;
      exitedAt: Date | null;
      podStatus?: string | null;
    }>,
  ): Array<{ id: string; sequence: number; stopType: string; lat: number; lng: number }> {
    const progressByStop = new Map(stopProgress.map((p) => [p.jobStopId, p]));
    return stops
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .filter((s) => {
        if (s.lat == null || s.lng == null) return false;
        const prog = progressByStop.get(s.id);
        if (!prog) return true;
        if (s.stopType === 'DROPOFF') {
          return prog.podStatus !== 'FINALIZED' && prog.exitedAt == null;
        }
        return prog.exitedAt == null;
      })
      .map((s) => ({
        id: s.id,
        sequence: s.sequence,
        stopType: s.stopType,
        lat: Number(s.lat),
        lng: Number(s.lng),
      }));
  }

  private async emitLiveEtaUpdate(
    trip: {
      id: string;
      jobId: string;
      job?: {
        stops?: Array<{
          id: string;
          sequence: number;
          stopType: string;
          lat: unknown;
          lng: unknown;
        }>;
      } | null;
      stopProgress?: Array<{
        jobStopId: string;
        exitedAt: Date | null;
        podStatus?: string | null;
      }>;
    },
    origin: { lat: number; lng: number },
    recordedAt: Date,
  ): Promise<void> {
    if (!this.realtimeGateway) return;
    const stops = trip.job?.stops ?? [];
    const remaining = this.getRemainingTripStops(stops, trip.stopProgress ?? []);
    const nextStop = remaining[0];
    if (!nextStop) return;

    const etaMinutes = this.valhalla?.isEnabled
      ? await this.valhalla.etaMinutes(origin, { lat: nextStop.lat, lng: nextStop.lng })
      : Math.max(
          1,
          Math.ceil(
            (haversineMeters(origin.lat, origin.lng, nextStop.lat, nextStop.lng) / 1000 / 40) * 60,
          ),
        );

    this.realtimeGateway.emitEtaUpdate(
      {
        jobId: trip.jobId,
        nextStopId: nextStop.id,
        etaMinutes,
        timestamp: recordedAt.toISOString(),
      },
      trip.id,
    );
  }

  private storageRoot(): string {
    return this.config.get('STORAGE_LOCAL_DIR', { infer: true }) || '.data/uploads';
  }

  private async resolveNotifyParties(tripId: string, jobStopId: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        job: {
          include: {
            stops: true,
            senderCompany: {
              include: {
                users: {
                  where: { role: 'SENDER', status: 'ACTIVE' },
                  select: { email: true },
                  take: 10,
                },
              },
            },
          },
        },
        assignment: {
          include: {
            carrierCompany: {
              include: {
                users: {
                  where: { role: 'TRANSPORT_COMPANY', status: 'ACTIVE' },
                  select: { email: true },
                  take: 10,
                },
              },
            },
            driver: {
              include: {
                user: { select: { name: true, email: true } },
              },
            },
            vehicle: { select: { registration: true, label: true } },
          },
        },
      },
    });
    if (!trip) throw new NotFoundException('Trip not found');
    const stop = trip.job.stops.find((s) => s.id === jobStopId);
    if (!stop) throw new NotFoundException('Stop not found');

    const senderEmails = [
      ...(trip.job.senderCompany.email ? [trip.job.senderCompany.email] : []),
      ...trip.job.senderCompany.users.map((u) => u.email),
    ];
    const carrierEmails = [
      ...(trip.assignment.carrierCompany.email
        ? [trip.assignment.carrierCompany.email]
        : []),
      ...trip.assignment.carrierCompany.users.map((u) => u.email),
    ];
    const receiverEmail = stop.receiverEmail || trip.job.receiverEmail || null;
    const dropAddress = [stop.addressLine, stop.suburb, stop.state, stop.postcode]
      .filter(Boolean)
      .join(', ');
    const carrier = trip.assignment.carrierCompany;
    const carrierName =
      carrier.tradingName || carrier.legalName || '—';
    const driverUser = trip.assignment.driver?.user;
    const driverName = driverUser?.name || driverUser?.email || '—';
    const vehicleRego =
      trip.assignment.vehicle?.registration ||
      trip.assignment.vehicle?.label ||
      null;
    const driverId = trip.assignment.driver?.id;
    const facePhoto = driverId
      ? await this.prisma.complianceDocument.findFirst({
          where: {
            driverId,
            docType: 'SELFIE',
            status: { in: ['UPLOADED', 'UNDER_REVIEW', 'APPROVED'] },
            storageKey: { not: null },
          },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            storageKey: true,
            mimeType: true,
            originalFilename: true,
          },
        })
      : null;

    return {
      trip,
      stop,
      senderEmails,
      carrierEmails,
      receiverEmail,
      dropSuburb: stop.suburb,
      dropAddress: dropAddress || null,
      jobTitle: trip.job.title,
      jobId: trip.jobId,
      carrierName,
      driverName,
      vehicleRego,
      facePhoto,
    };
  }

  private async ensureStopProgress(tripId: string, jobStopId: string) {
    const existing = await this.prisma.tripStopProgress.findUnique({
      where: { tripId_jobStopId: { tripId, jobStopId } },
    });
    if (existing) return existing;
    return this.prisma.tripStopProgress.create({
      data: { tripId, jobStopId, podStatus: 'PENDING' },
    });
  }

  private async notifyAtDropoffIfNeeded(
    tripId: string,
    jobStopId: string,
    actorUserId?: string,
  ) {
    const progress = await this.ensureStopProgress(tripId, jobStopId);
    if (progress.atDropoffNotifiedAt) return;

    // Mark POD-ready before SMTP so a slow mail host cannot stall arrival state.
    await this.prisma.tripStopProgress.update({
      where: { id: progress.id },
      data: {
        atDropoffNotifiedAt: new Date(),
        podStatus:
          progress.podStatus === 'PENDING' ? 'AWAITING_SIGNATURE' : progress.podStatus,
      },
    });

    const parties = await this.resolveNotifyParties(tripId, jobStopId);
    try {
      await this.notifications.notifyTripAtDropoff({
        senderEmails: parties.senderEmails,
        carrierEmails: parties.carrierEmails,
        receiverEmail: parties.receiverEmail,
        jobId: parties.jobId,
        jobTitle: parties.jobTitle,
        dropSuburb: parties.dropSuburb,
        dropAddress: parties.dropAddress,
      });
    } catch {
      // Email is best-effort after arrival is recorded.
    }

    await this.audit.recordPlatform({
      action: AuditAction.TRIP_AT_DROPOFF_NOTIFIED,
      actorUserId,
      entityType: 'Trip',
      entityId: tripId,
      metadata: { jobStopId },
    });
    void this.emitTripInbox({
      tripId,
      type: NotificationType.TRIP_AT_DROPOFF,
      title: 'Driver at drop-off',
      body: 'The driver has arrived at drop-off. POD can proceed.',
    });
  }

  /**
   * M10 Phase E / Phase C — if Valhalla road ETA (with haversine fallback) to next
   * unfinished dropoff is in the configured window and driver has not already notified,
   * send ETA_AUTO email and emit WS approaching event.
   */
  private async maybeAutoNotifyApproaching(
    tripId: string,
    point: { lat: number; lng: number },
    actorUserId?: string,
  ) {
    const maxEta = this.config.get('APPROACHING_ETA_MAX_MINUTES', { infer: true });
    if (!maxEta || maxEta <= 0) return;
    const minEta = this.config.get('APPROACHING_ETA_MIN_MINUTES', { infer: true }) ?? 15;
    const speedKmh = this.config.get('APPROACHING_ETA_SPEED_KMH', { infer: true }) ?? 40;

    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        job: { include: { stops: { orderBy: { sequence: 'asc' } } } },
        stopProgress: true,
      },
    });
    if (!trip?.startedAt || trip.onBreak) return;
    if (
      trip.status !== TripStatus.IN_TRANSIT &&
      trip.status !== TripStatus.EN_ROUTE_PICKUP
    ) {
      return;
    }

    const progressByStop = new Map(trip.stopProgress.map((p) => [p.jobStopId, p]));
    const targetStop = trip.job.stops.find((s) => {
      if (s.stopType !== 'DROPOFF') return false;
      const p = progressByStop.get(s.id);
      if (p?.approachingNotifiedAt) return false;
      if (p?.enteredAt || p?.exitedAt) return false;
      if (s.lat == null || s.lng == null) return false;
      return true;
    });
    if (!targetStop) return;

    const stopLat =
      typeof targetStop.lat === 'number' ? targetStop.lat : Number(targetStop.lat);
    const stopLng =
      typeof targetStop.lng === 'number' ? targetStop.lng : Number(targetStop.lng);
    if (!Number.isFinite(stopLat) || !Number.isFinite(stopLng)) return;

    let etaMinutes: number;
    if (this.valhalla?.isEnabled) {
      etaMinutes = await this.valhalla.etaMinutes(
        point,
        { lat: stopLat, lng: stopLng },
        speedKmh,
      );
    } else {
      const meters = haversineMeters(point.lat, point.lng, stopLat, stopLng);
      etaMinutes = ((meters / 1000) / speedKmh) * 60;
    }
    if (etaMinutes < minEta || etaMinutes > maxEta) return;

    const roundedMin = Math.round(etaMinutes);
    await this.recordApproachingNotify({
      tripId: trip.id,
      jobStopId: targetStop.id,
      source: 'ETA_AUTO',
      actorUserId,
      etaLabel: `~${roundedMin} min`,
    });

    this.realtimeGateway?.emitApproaching(
      {
        jobId: trip.jobId,
        minutesAway: roundedMin,
        timestamp: new Date().toISOString(),
      },
      trip.id,
    );
  }

  private async recordApproachingNotify(params: {
    tripId: string;
    jobStopId: string;
    source: 'DRIVER' | 'ETA_AUTO';
    actorUserId?: string;
    etaLabel: string | null;
  }) {
    const progress = await this.ensureStopProgress(params.tripId, params.jobStopId);
    if (progress.approachingNotifiedAt) {
      return { alreadySent: true as const };
    }
    if (progress.enteredAt) {
      return { alreadyArrived: true as const };
    }

    // Persist notify flag before SMTP so driver UI can advance without waiting on mail.
    await this.prisma.tripStopProgress.update({
      where: { id: progress.id },
      data: {
        approachingNotifiedAt: new Date(),
        approachingSource: params.source,
      },
    });

    const parties = await this.resolveNotifyParties(params.tripId, params.jobStopId);
    let sentTo: string[] = [];
    try {
      let facePhotoAttachment:
        | { filename: string; content: Buffer; contentType: string }
        | null = null;
      const face = parties.facePhoto;
      if (face?.storageKey) {
        try {
          const buf = await readFile(join(this.storageRoot(), face.storageKey));
          const mime = face.mimeType || 'image/jpeg';
          const ext =
            mime.includes('png')
              ? '.png'
              : mime.includes('webp')
                ? '.webp'
                : '.jpg';
          facePhotoAttachment = {
            filename:
              face.originalFilename ||
              `CLOX-driver-photo-${parties.jobId.slice(0, 8)}${ext}`,
            content: buf,
            contentType: mime,
          };
        } catch {
          // Photo missing on disk — still send text identity.
        }
      }
      const mail = await this.notifications.notifyTripApproaching({
        senderEmails: parties.senderEmails,
        receiverEmail: parties.receiverEmail,
        jobId: parties.jobId,
        jobTitle: parties.jobTitle,
        dropSuburb: parties.dropSuburb,
        dropAddress: parties.dropAddress,
        etaLabel: params.etaLabel,
        source: params.source,
        driverName: parties.driverName,
        vehicleRego: parties.vehicleRego,
        facePhoto: facePhotoAttachment,
      });
      sentTo = mail.sentTo;
    } catch {
      // Best-effort email after state is recorded.
    }

    if (this.inbox && parties.jobId) {
      try {
        const tripRow = await this.prisma.trip.findUnique({
          where: { id: params.tripId },
          select: { job: { select: { senderCompanyId: true } } },
        });
        const senderCompanyId = tripRow?.job?.senderCompanyId;
        if (senderCompanyId) {
          const senderUserIds = await this.inbox.userIdsForCompanies({
            companyIds: [senderCompanyId],
            roles: [PlatformRole.SENDER],
          });
          if (senderUserIds.length > 0) {
            const jobLabel = parties.jobTitle || parties.jobId.slice(0, 8);
            const location = parties.dropSuburb || 'your drop-off location';
            const etaSuffix = params.etaLabel ? ` (ETA ${params.etaLabel})` : '';
            void this.inbox.notifyUsersLocalized({
              userIds: senderUserIds,
              type: NotificationType.TRIP_APPROACHING,
              titleKey: 'trip.approaching.title',
              bodyKey: 'trip.approaching.body',
              vars: {
                jobTitle: jobLabel,
                location,
                etaSuffix,
              },
              href: `/jobs/${parties.jobId}`,
              entityType: 'Trip',
              entityId: params.tripId,
            });
          }
        }
      } catch {
        // Best-effort approaching inbox/push notification.
      }
    }

    await this.audit.recordPlatform({
      action: AuditAction.TRIP_APPROACHING_NOTIFIED,
      actorUserId: params.actorUserId,
      entityType: 'Trip',
      entityId: params.tripId,
      metadata: {
        jobStopId: params.jobStopId,
        source: params.source,
        etaLabel: params.etaLabel,
        sentTo,
      },
    });

    return { alreadySent: false as const, sentTo };
  }

  async notifyApproaching(
    principal: AuthenticatedPrincipal,
    tripId: string,
    input: TripNotifyApproachingInput,
  ) {
    this.ensureDatabase();
    const user = await this.requireDriver(principal);
    const trip = await this.loadTripForDriver(user.driver!.id, tripId);
    if (!trip.startedAt) {
      throw new BadRequestException('Trip must be started before notifying');
    }
    if (trip.status === TripStatus.COMPLETED || trip.status === TripStatus.CANCELLED) {
      throw new BadRequestException('Trip is not active');
    }

    const stops = trip.job.stops ?? [];
    let targetStop = input.jobStopId
      ? stops.find((s) => s.id === input.jobStopId)
      : undefined;
    if (!targetStop) {
      const progressByStop = new Map(trip.stopProgress.map((p) => [p.jobStopId, p]));
      targetStop = stops.find((s) => {
        if (s.stopType !== 'DROPOFF') return false;
        const p = progressByStop.get(s.id);
        if (p?.approachingNotifiedAt) return false;
        if (p?.enteredAt && !p.exitedAt) return false;
        if (p?.exitedAt) return false;
        return true;
      });
    }
    if (!targetStop || targetStop.stopType !== 'DROPOFF') {
      throw new BadRequestException('No eligible dropoff stop to notify');
    }

    const progress = await this.ensureStopProgress(trip.id, targetStop.id);
    if (progress.approachingNotifiedAt) {
      throw new BadRequestException({
        message: 'Approaching already notified for this stop',
        code: 'APPROACHING_ALREADY_SENT',
      });
    }
    if (progress.enteredAt) {
      throw new BadRequestException('Already at or past this dropoff');
    }

    await this.recordApproachingNotify({
      tripId: trip.id,
      jobStopId: targetStop.id,
      source: 'DRIVER',
      actorUserId: user.id,
      etaLabel: null,
    });

    return this.getDriverTrip(principal, tripId);
  }

  async getPodArtifact(
    principal: AuthenticatedPrincipal,
    tripId: string,
    jobStopId: string,
    kind: 'signature' | 'photo',
    index = 0,
  ): Promise<{ stream: ReadStream; mimeType: string; filename: string }> {
    this.ensureDatabase();
    const user = await this.requireDriver(principal);
    const trip = await this.loadTripForDriver(user.driver!.id, tripId);
    const stop = (trip.job.stops ?? []).find((s) => s.id === jobStopId);
    if (!stop || stop.stopType !== 'DROPOFF') {
      throw new NotFoundException('POD stop not found');
    }

    const progress = await this.prisma.tripStopProgress.findUnique({
      where: { tripId_jobStopId: { tripId: trip.id, jobStopId: stop.id } },
    });
    if (!progress) {
      throw new NotFoundException('POD progress not found');
    }

    let storageKey: string | null = null;
    if (kind === 'signature') {
      storageKey = progress.signatureStorageKey;
    } else {
      const refs = Array.isArray(progress.goodsPhotoRefs)
        ? (progress.goodsPhotoRefs as string[])
        : [];
      if (!Number.isInteger(index) || index < 0 || index >= refs.length) {
        throw new NotFoundException('Photo not found');
      }
      storageKey = refs[index] ?? null;
    }

    if (!storageKey || storageKey.includes('..') || !storageKey.startsWith(`trips/${trip.id}/`)) {
      throw new NotFoundException('Artifact not found');
    }

    const fullPath = join(this.storageRoot(), storageKey);
    try {
      await access(fullPath);
    } catch {
      throw new NotFoundException('Artifact file missing from storage');
    }

    const ext = storageKey.split('.').pop()?.toLowerCase() ?? 'bin';
    const mimeType =
      ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'png'
          ? 'image/png'
          : ext === 'webp'
            ? 'image/webp'
            : 'application/octet-stream';
    const filename =
      kind === 'signature' ? `signature.${ext}` : `goods-photo-${index}.${ext}`;

    return {
      stream: createReadStream(fullPath),
      mimeType,
      filename,
    };
  }

  async submitPodSignature(
    principal: AuthenticatedPrincipal,
    tripId: string,
    input: TripPodSignatureInput,
  ) {
    this.ensureDatabase();
    if (!input.receiverPresentAttested) {
      throw new BadRequestException('Receiver present attestation is required');
    }
    const user = await this.requireDriver(principal);
    const trip = await this.loadTripForDriver(user.driver!.id, tripId);
    if (!trip.startedAt) throw new BadRequestException('Trip not started');
    await this.assertReadyForPod(trip.id);

    const stop = (trip.job.stops ?? []).find((s) => s.id === input.jobStopId);
    if (!stop || stop.stopType !== 'DROPOFF') {
      throw new BadRequestException('Signature only applies to dropoff stops');
    }

    const progress = await this.ensureStopProgress(trip.id, stop.id);
    if (progress.podStatus === 'FINALIZED') {
      throw new BadRequestException('POD already finalized');
    }

    const { mime, buffer } = parseDataUrl(input.signatureDataUrl);
    if (!mime.startsWith('image/')) {
      throw new BadRequestException('Signature must be an image');
    }
    const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png';
    const artifact = await writeTripArtifact({
      rootDir: this.storageRoot(),
      tripId: trip.id,
      stopId: stop.id,
      kind: 'signature',
      ext,
      buffer,
    });

    const updated = await this.prisma.tripStopProgress.update({
      where: { id: progress.id },
      data: {
        signedAt: new Date(),
        signerName: input.signerName.trim(),
        signatureStorageKey: artifact.storageKey,
        signatureContentHash: artifact.contentHash,
        receiverPresentAttested: true,
        podStatus: 'SIGNED',
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.POD_SIGNED_ON_SOG,
      actorUserId: user.id,
      entityType: 'Trip',
      entityId: trip.id,
      metadata: {
        jobStopId: stop.id,
        signerName: updated.signerName,
        signatureStorageKey: artifact.storageKey,
      },
    });

    return this.getDriverTrip(principal, tripId);
  }

  async addPodPhoto(
    principal: AuthenticatedPrincipal,
    tripId: string,
    input: TripPodPhotoInput,
  ) {
    this.ensureDatabase();
    const user = await this.requireDriver(principal);
    const trip = await this.loadTripForDriver(user.driver!.id, tripId);
    await this.assertReadyForPod(trip.id);
    const stop = (trip.job.stops ?? []).find((s) => s.id === input.jobStopId);
    if (!stop || stop.stopType !== 'DROPOFF') {
      throw new BadRequestException('Photos only apply to dropoff stops');
    }
    const progress = await this.ensureStopProgress(trip.id, stop.id);
    if (progress.podStatus === 'FINALIZED') {
      throw new BadRequestException('POD already finalized');
    }

    const { mime, buffer } = parseDataUrl(input.photoDataUrl);
    if (!mime.startsWith('image/')) {
      throw new BadRequestException('Photo must be an image');
    }
    const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png';
    const artifact = await writeTripArtifact({
      rootDir: this.storageRoot(),
      tripId: trip.id,
      stopId: stop.id,
      kind: 'photo',
      ext,
      buffer,
    });

    const prev = Array.isArray(progress.goodsPhotoRefs)
      ? (progress.goodsPhotoRefs as string[])
      : [];
    await this.prisma.tripStopProgress.update({
      where: { id: progress.id },
      data: { goodsPhotoRefs: [...prev, artifact.storageKey] },
    });

    return this.getDriverTrip(principal, tripId);
  }

  async finalizePod(
    principal: AuthenticatedPrincipal,
    tripId: string,
    input: TripPodFinalizeInput,
  ) {
    this.ensureDatabase();
    const user = await this.requireDriver(principal);
    const trip = await this.loadTripForDriver(user.driver!.id, tripId);
    const stop = (trip.job.stops ?? []).find((s) => s.id === input.jobStopId);
    if (!stop || stop.stopType !== 'DROPOFF') {
      throw new BadRequestException('Finalize only applies to dropoff stops');
    }
    const progress = await this.ensureStopProgress(trip.id, stop.id);
    if (progress.podStatus === 'FINALIZED') {
      // Recover stuck trips where POD was saved but completion was gated.
      await this.completeTripIfReady(trip.id, user.id);
      return this.getDriverTrip(principal, tripId);
    }
    await this.assertReadyForPod(trip.id);
    if (!progress.signedAt || !progress.signerName || !progress.signatureStorageKey) {
      throw new BadRequestException('Receiver signature required on driver SOG');
    }
    if (!progress.receiverPresentAttested) {
      throw new BadRequestException('Receiver present attestation required');
    }
    const photos = Array.isArray(progress.goodsPhotoRefs)
      ? (progress.goodsPhotoRefs as string[])
      : [];
    if (photos.length < 1) {
      throw new BadRequestException('At least one goods photo is required');
    }

    const dropoffs = (trip.job.stops ?? []).filter((s) => s.stopType === 'DROPOFF');
    const alreadyFinalized = new Set(
      (trip.stopProgress ?? [])
        .filter((p) => p.podStatus === 'FINALIZED')
        .map((p) => p.jobStopId),
    );
    const remainingOther = dropoffs.filter(
      (s) => s.id !== stop.id && !alreadyFinalized.has(s.id),
    );
    const isLastDropoff = remainingOther.length === 0;
    if (isLastDropoff) {
      if (input.odometerEndKm == null) {
        throw new BadRequestException(
          'Final odometer reading (km) is required on the last dropoff',
        );
      }
      await this.captureEndOdometer({
        tripId: trip.id,
        actorUserId: user.id,
        odometerStartKm: this.asTripOdometer(trip).odometerStartKm,
        odometerEndKm: input.odometerEndKm,
      });
    }

    const parties = await this.resolveNotifyParties(trip.id, stop.id);
    const finalizedAt = new Date();
    const signedAtLabel = `${formatPodDateTime(progress.signedAt)} AEST`;
    const finalizedAtLabel = `${formatPodDateTime(finalizedAt)} AEST`;
    const jobRef = parties.jobTitle || parties.jobId;
    const jobShort = parties.jobId.slice(0, 8);
    const jobDisplay = parties.jobTitle
      ? `${parties.jobTitle} (${jobShort}...)`
      : parties.jobId;
    const sigImageName = `CLOX-signature-image-${jobShort}`;
    const logo = loadCloxLogoBuffer();

    const signatureFile = progress.signatureStorageKey
      ? await this.readStoredArtifact(progress.signatureStorageKey)
      : null;
    const photoFiles: Array<{
      key: string;
      buffer: Buffer;
      filename: string;
      contentType: string;
    }> = [];
    for (let i = 0; i < photos.length; i++) {
      const key = photos[i]!;
      const file = await this.readStoredArtifact(key);
      if (file) {
        photoFiles.push({
          key,
          buffer: file.buffer,
          filename: `CLOX-goods-${jobShort}-${i + 1}${file.ext}`,
          contentType: file.contentType,
        });
      }
    }

    const signatureImages: BrandedPdfImage[] = signatureFile
      ? [
          {
            caption: `Signature | attached: ${sigImageName}${signatureFile.ext}`,
            buffer: signatureFile.buffer,
            fitWidth: 280,
            fitHeight: 120,
          },
        ]
      : [];

    const goodsImages: BrandedPdfImage[] = photoFiles.map((p, i) => ({
      caption: `Photo ${i + 1} | attached: ${p.filename}`,
      buffer: p.buffer,
      fitWidth: 240,
      fitHeight: 140,
    }));

    const [exceptions, auditEvents] = await Promise.all([
      this.prisma.tripException.findMany({
        where: { tripId: trip.id },
        orderBy: { openedAt: 'asc' },
        select: {
          kind: true,
          status: true,
          openedAt: true,
          resolvedAt: true,
          note: true,
          reasonCode: true,
        },
      }),
      this.prisma.auditEvent.findMany({
        where: {
          entityType: 'Trip',
          entityId: trip.id,
          action: {
            in: [
              AuditAction.TRIP_BREAK_TOGGLED,
              AuditAction.TRIP_STARTED,
              AuditAction.TRIP_GEOFENCE_ENTER,
              AuditAction.TRIP_GEOFENCE_EXIT,
              AuditAction.TRIP_APPROACHING_NOTIFIED,
              AuditAction.TRIP_AT_DROPOFF_NOTIFIED,
            ],
          },
        },
        orderBy: { createdAt: 'asc' },
        take: 100,
        select: { action: true, createdAt: true, metadata: true },
      }),
    ]);

    const journey = buildPodJourney({
      trip: {
        startedAt: trip.startedAt,
        safetyPassedAt: trip.safetyPassedAt,
        massCheckedAt: trip.massCheckedAt,
        breakStartedAt: trip.breakStartedAt,
        onBreak: trip.onBreak,
        completedAt: trip.completedAt,
      },
      stopProgress: trip.stopProgress.map((p) => ({
        stopType: p.jobStop?.stopType ?? null,
        stopLabel: p.jobStop?.label ?? null,
        suburb: p.jobStop?.suburb ?? null,
        enteredAt: p.enteredAt,
        exitedAt: p.exitedAt,
        approachingNotifiedAt: p.approachingNotifiedAt,
        approachingSource: p.approachingSource,
        atDropoffNotifiedAt: p.atDropoffNotifiedAt,
        signedAt: p.signedAt,
        signerName: p.signerName,
        podFinalizedAt: p.id === progress.id ? finalizedAt : p.podFinalizedAt,
      })),
      exceptions,
      auditEvents: auditEvents.map((a) => ({
        action: a.action,
        createdAt: a.createdAt,
        metadata:
          a.metadata && typeof a.metadata === 'object' && !Array.isArray(a.metadata)
            ? (a.metadata as Record<string, unknown>)
            : null,
      })),
      finalizeAt: finalizedAt,
    });
    const journeyTable = formatJourneyForTable(journey);

    const signaturePdf = await buildBrandedPdf({
      documentTitle: 'Signature receipt',
      subtitle: `Job ${jobRef} | Delivery sign-on-glass`,
      headerRef: `CLOX-signature-${jobShort} | Job ${jobShort}`,
      logo,
      footerNote: 'CLOX | Confidential | System-generated signature receipt',
      sections: [
        {
          title: 'Delivery sign-on-glass',
          rows: [
            { label: 'Job', value: jobDisplay },
            { label: 'Drop suburb', value: parties.dropSuburb || '-' },
            { label: 'Drop address', value: parties.dropAddress || '-' },
            { label: 'Signer', value: progress.signerName },
            { label: 'Signed at', value: signedAtLabel },
            {
              label: 'Capture method',
              value: 'Driver SOG (receiver signed on driver device)',
            },
            {
              label: 'Signature hash',
              value: progress.signatureContentHash
                ? `sha256:${progress.signatureContentHash.slice(0, 8)}...`
                : '-',
            },
            {
              label: 'Attachment',
              value: signatureFile
                ? `${sigImageName}${signatureFile.ext}`
                : '-',
            },
          ],
        },
        {
          title: 'Signature image',
          images: signatureImages.length
            ? [
                {
                  ...signatureImages[0]!,
                  caption: 'Embedded signature | also attached to email',
                },
              ]
            : undefined,
          paragraphs: [
            "Receiver signature was captured on the driver's authenticated SOG session. No public magic-link was used.",
          ],
        },
      ],
    });
    const signaturePdfArtifact = await writeTripArtifact({
      rootDir: this.storageRoot(),
      tripId: trip.id,
      stopId: stop.id,
      kind: 'signature-pdf',
      ext: 'pdf',
      buffer: signaturePdf,
    });

    const podPdf = await buildBrandedPdf({
      documentTitle: 'Proof of Delivery',
      subtitle: `Job ${jobRef} | ${parties.dropSuburb || 'drop'} | Finalized ${finalizedAtLabel}`,
      headerRef: `CLOX-POD-${jobShort} | Job ${jobShort}`,
      logo,
      footerNote: 'CLOX | Confidential | System-generated proof of delivery',
      sections: [
        {
          title: 'Delivery details',
          rows: [
            { label: 'Job', value: jobDisplay },
            {
              label: 'Drop address',
              value: parties.dropAddress || parties.dropSuburb || '-',
            },
            { label: 'Carrier', value: parties.carrierName },
            { label: 'Driver', value: parties.driverName },
            {
              label: 'Goods photos',
              value: `${photos.length} (embedded below | also attached to email)`,
            },
          ],
        },
        {
          title: 'Signer',
          rows: [
            { label: 'Signed by', value: progress.signerName },
            { label: 'Signed at', value: signedAtLabel },
            {
              label: 'Capture',
              value: 'Driver SOG (receiver signed on driver device)',
            },
            {
              label: 'Signature file',
              value: signatureFile
                ? `Attached: ${sigImageName}${signatureFile.ext}`
                : '-',
            },
          ],
        },
        {
          title: 'Evidence',
          paragraphs: [
            'Images are embedded in this PDF and attached as separate files on the POD finalize email. Storage keys are not shown as links (auth-gated APIs are not usable from email).',
          ],
          images: [...signatureImages, ...goodsImages],
        },
        {
          title: 'Driver journey',
          paragraphs:
            journeyTable.rows.length === 0
              ? ['No milestone events recorded for this trip.']
              : [
                  'Milestone history only (start, break, geofence, approaching, dropoff, exceptions, POD). Raw GPS samples are omitted for readability.',
                ],
          table:
            journeyTable.rows.length > 0
              ? { headers: journeyTable.headers, rows: journeyTable.rows }
              : undefined,
        },
      ],
    });
    const podPdfArtifact = await writeTripArtifact({
      rootDir: this.storageRoot(),
      tripId: trip.id,
      stopId: stop.id,
      kind: 'pod-pdf',
      ext: 'pdf',
      buffer: podPdf,
    });

    await this.prisma.tripStopProgress.update({
      where: { id: progress.id },
      data: {
        podStatus: 'FINALIZED',
        podFinalizedAt: finalizedAt,
        podPackageStorageKey: podPdfArtifact.storageKey,
        signaturePdfStorageKey: signaturePdfArtifact.storageKey,
      },
    });

    await this.prisma.trip.update({
      where: { id: trip.id },
      data: {
        podStorageKey: podPdfArtifact.storageKey,
        podCapturedAt: finalizedAt,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.POD_FINALIZED,
      actorUserId: user.id,
      entityType: 'Trip',
      entityId: trip.id,
      metadata: {
        jobStopId: stop.id,
        podPackageStorageKey: podPdfArtifact.storageKey,
        signaturePdfStorageKey: signaturePdfArtifact.storageKey,
      },
    });
    await this.audit.recordPlatform({
      action: AuditAction.POD_PDF_GENERATED,
      actorUserId: user.id,
      entityType: 'Trip',
      entityId: trip.id,
      metadata: {
        jobStopId: stop.id,
        podPackageStorageKey: podPdfArtifact.storageKey,
        journeyEventCount: journey.length,
      },
    });
    void this.emitTripInbox({
      tripId: trip.id,
      type: NotificationType.POD_FINALIZED,
      title: 'POD finalized & emails sent',
      body: `Proof of delivery captured; confirmation and PDF documents sent successfully for ${parties.dropSuburb || 'drop-off'}.`,
      includeDriver: true,
    });

    // Complete + release driver first (POD is trip end). Emails must not block release.
    await this.completeTripIfReady(trip.id, user.id);

    try {
      const emailAttachments: Array<{
        filename: string;
        content: Buffer;
        contentType?: string;
      }> = [
        {
          filename: `CLOX-POD-${jobShort}.pdf`,
          content: podPdf,
          contentType: 'application/pdf',
        },
        {
          filename: `CLOX-signature-${jobShort}.pdf`,
          content: signaturePdf,
          contentType: 'application/pdf',
        },
      ];
      if (signatureFile) {
        emailAttachments.push({
          filename: `${sigImageName}${signatureFile.ext}`,
          content: signatureFile.buffer,
          contentType: signatureFile.contentType,
        });
      }
      for (const photo of photoFiles) {
        emailAttachments.push({
          filename: photo.filename,
          content: photo.buffer,
          contentType: photo.contentType,
        });
      }

      await this.notifications.notifyPodFinalized({
        senderEmails: parties.senderEmails,
        receiverEmail: parties.receiverEmail,
        carrierEmails: parties.carrierEmails,
        jobId: parties.jobId,
        jobTitle: parties.jobTitle,
        dropSuburb: parties.dropSuburb,
        signerName: progress.signerName,
        attachments: emailAttachments,
      });
    } catch {
      // POD + trip completion already persisted; email can be retried operationally.
    }

    return this.getDriverTrip(principal, tripId);
  }

  /** Load a trip storage artifact for PDF embed / email attach. */
  private async readStoredArtifact(
    storageKey: string,
  ): Promise<{ buffer: Buffer; ext: string; contentType: string } | null> {
    try {
      const fullPath = join(this.storageRoot(), storageKey);
      await access(fullPath);
      const buffer = await readFile(fullPath);
      const ext = (extname(storageKey) || '.bin').toLowerCase();
      const contentType =
        ext === '.png'
          ? 'image/png'
          : ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : ext === '.webp'
              ? 'image/webp'
              : ext === '.pdf'
                ? 'application/pdf'
                : 'application/octet-stream';
      return { buffer, ext, contentType };
    } catch {
      return null;
    }
  }
}

/** Format minutes as HH:MM for run-sheet work/rest totals. */
function formatHhMm(totalMinutes: number): string {
  const mins = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Read sender platform-fee fields snapshotted onto PaymentEvent / Surcharge metadata
 * at charge time (national % or CompanySenderFeeOverride — never re-resolve at invoice).
 */
function parseSenderFeeSnapshot(
  metadata: unknown,
  fallbackChargeIncGstCents: number,
): {
  baseIncGstCents: number;
  feeIncGstCents: number;
  feePercent: number;
  mode: 'EXCLUSIVE' | 'INCLUSIVE';
  overrideId: string | null;
  chargeIncGstCents: number;
} {
  const meta =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const baseIncGstCents =
    num(meta.baseIncGstCents) ?? fallbackChargeIncGstCents;
  const feeIncGstCents = num(meta.senderFeeIncGstCents) ?? 0;
  const feePercent = Math.max(0, Math.trunc(num(meta.senderFeePercent) ?? 0));
  const mode =
    meta.senderFeeMode === 'INCLUSIVE' || meta.senderFeeMode === 'EXCLUSIVE'
      ? meta.senderFeeMode
      : 'EXCLUSIVE';
  const overrideId =
    typeof meta.senderFeeOverrideId === 'string' && meta.senderFeeOverrideId
      ? meta.senderFeeOverrideId
      : null;
  const chargeIncGstCents =
    num(meta.settlementGrossIncGstCents) ??
    (mode === 'EXCLUSIVE'
      ? baseIncGstCents + feeIncGstCents
      : baseIncGstCents);
  return {
    baseIncGstCents,
    feeIncGstCents,
    feePercent,
    mode,
    overrideId,
    chargeIncGstCents,
  };
}
