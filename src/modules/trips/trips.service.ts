import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AssignmentStatus,
  JobPricingModel,
  JobStatus,
  Prisma,
  SurchargeKind,
  SurchargeStatus,
  TripStatus,
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
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import {
  DEFAULT_GEOFENCE_POLICY,
  freeWaitMs,
  haversineMeters,
  isInsideRadius,
  massSurchargeIncGstCents,
  parseGeofencePolicy,
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
import { createReadStream, type ReadStream } from 'fs';
import { access, readFile } from 'fs/promises';
import { extname, join } from 'path';

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<AppEnv, true>,
    @Inject(forwardRef(() => PaymentsService))
    private readonly payments: PaymentsService,
    private readonly notifications: NotificationsService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
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
    if (assignment.trip) return assignment.trip;

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
      paid: trip.assignment?.status === AssignmentStatus.LOCKED,
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
    return { ...mapped, openException };
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
          select: { status: true },
        });
        // Only suspend ACTIVE fleet — never overwrite an existing compliance suspension.
        if (vehicle?.status === VehicleStatus.ACTIVE) {
          await this.prisma.vehicle.update({
            where: { id: trip.assignment.vehicleId },
            data: { status: VehicleStatus.SUSPENDED },
          });
          safetySuspendedVehicle = true;
        }
      }
      const noteBase = input.notes ?? 'Pre-trip failed';
      const updated = await this.prisma.trip.update({
        where: { id: trip.id },
        data: {
          safetyFailedAt: new Date(),
          safetyPassedAt: null,
          safetyNotes: safetySuspendedVehicle
            ? `${noteBase}\n[SAFETY_SUSPEND]`
            : noteBase,
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
          vehicleLocked: safetySuspendedVehicle,
        },
      });
      return this.mapTrip(updated);
    }

    const updated = await this.prisma.trip.update({
      where: { id: trip.id },
      data: {
        safetyPassedAt: new Date(),
        safetyFailedAt: null,
        safetyNotes: input.notes ?? null,
        status: TripStatus.EN_ROUTE_PICKUP,
      },
      include: this.tripInclude(),
    });
    // Only reverse a suspend this trip caused (marker) — never force ACTIVE over compliance.
    const wasSafetySuspended = Boolean(
      trip.safetyFailedAt && trip.safetyNotes?.includes('[SAFETY_SUSPEND]'),
    );
    let vehicleUnsuspended = false;
    if (wasSafetySuspended && trip.assignment.vehicleId) {
      await this.prisma.vehicle.update({
        where: { id: trip.assignment.vehicleId },
        data: { status: VehicleStatus.ACTIVE },
      });
      vehicleUnsuspended = true;
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
    const declared =
      trip.declaredMassKg ?? trip.job.chargeableWeightKg ?? trip.job.deadWeightKg ?? 0;
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
      metadata: { onBreak: input.onBreak },
    });
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
    const surchargeInc = trip.surcharges
      .filter((s) => s.status === SurchargeStatus.PAID)
      .reduce((sum, s) => sum + s.amountIncGstCents, 0);
    const surchargeEx = trip.surcharges
      .filter((s) => s.status === SurchargeStatus.PAID)
      .reduce((sum, s) => sum + s.amountExGstCents, 0);
    const surchargeGst = trip.surcharges
      .filter((s) => s.status === SurchargeStatus.PAID)
      .reduce((sum, s) => sum + s.amountGstCents, 0);
    const baseEx = proposal?.amountExGstCents ?? trip.job.estimateExGstCents ?? 0;
    const baseGst = proposal?.amountGstCents ?? trip.job.estimateGstCents ?? 0;
    const baseInc = proposal?.amountIncGstCents ?? trip.job.estimateIncGstCents ?? 0;
    const totalEx = baseEx + surchargeEx;
    const totalGst = baseGst + surchargeGst;
    const totalInc = baseInc + surchargeInc;

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
    const invoicePdf = await buildBrandedPdf({
      documentTitle: 'Tax Invoice',
      subtitle: `${invoiceRef} | ${completedDate}`,
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
          ],
        },
        {
          title: 'Bill to',
          rows: [
            { label: 'Name', value: billTo },
            { label: 'Address', value: billAddress || '-' },
            { label: 'Sender ABN', value: sender?.abn || '-' },
          ],
        },
        {
          title: 'Supplier',
          rows: [
            {
              label: 'Carrier',
              value: carrier?.legalName || carrier?.tradingName || 'Carrier',
            },
            { label: 'Carrier ABN', value: carrier?.abn || '-' },
            { label: 'Driver', value: driverName },
            {
              label: 'Vehicle',
              value: trip.assignment?.vehicle?.registration || '-',
            },
          ],
        },
        {
          title: 'Amounts (AUD)',
          rows: [
            { label: 'Freight (ex GST)', value: formatAudCents(baseEx) },
            { label: 'Freight GST', value: formatAudCents(baseGst) },
            { label: 'Freight (inc GST)', value: formatAudCents(baseInc) },
            {
              label: 'Paid surcharges (ex GST)',
              value: formatAudCents(surchargeEx),
            },
            {
              label: 'Paid surcharges GST',
              value: formatAudCents(surchargeGst),
            },
            { label: 'Total ex GST', value: formatAudCents(totalEx) },
            { label: 'Total GST', value: formatAudCents(totalGst) },
            { label: 'Total inc GST', value: formatAudCents(totalInc) },
          ],
        },
        {
          title: 'Notes',
          paragraphs: [
            'This is a system-generated tax invoice summary from CLOX. Retain for your records.',
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
      const byStop = new Map(trip.stopProgress.map((p) => [p.jobStopId, p]));
      const tableRows = trip.job.stops.map((stop, index) => {
        const p = byStop.get(stop.id);
        const arrive = p?.enteredAt
          ? p.enteredAt.toISOString().replace('T', ' ').slice(0, 16)
          : '-';
        const depart = p?.exitedAt
          ? p.exitedAt.toISOString().replace('T', ' ').slice(0, 16)
          : '-';
        const dwell =
          p?.waitOverageMinutes != null ? `${p.waitOverageMinutes}m` : '-';
        const addr = [stop.suburb, stop.state].filter(Boolean).join(', ') || '-';
        return [
          String(index + 1),
          stop.stopType,
          addr,
          arrive,
          depart,
          dwell,
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
          ? `Total time: ${actualHours.toFixed(2)}h | Billed: 4.0 hours (minimum engagement).`
          : `Billed hours: ${billedHours.toFixed(1)} (4.0 hour floor applies).`;

      const signer =
        trip.stopProgress.find((p) => p.signerName)?.signerName ?? '-';
      const jobShortInv = trip.jobId.slice(0, 8);
      runSheetPdf = await buildBrandedPdf({
        documentTitle: 'Hourly Run Sheet',
        subtitle: `Job ${jobShortInv} | ${completedDate}`,
        headerRef: `CLOX-runsheet-${jobShortInv} | Job ${jobShortInv}`,
        logo: loadCloxLogoBuffer(),
        footerNote: 'CLOX | Confidential | System-generated hourly run sheet',
        sections: [
          {
            title: 'Trip header',
            rows: [
              { label: 'Job ID', value: trip.jobId },
              { label: 'Date', value: completedDate },
              { label: 'Driver', value: driverName },
              {
                label: 'Transport company',
                value: carrier?.legalName || '-',
              },
              { label: 'ABN', value: carrier?.abn || '-' },
              {
                label: 'Vehicle rego',
                value: trip.assignment?.vehicle?.registration || '-',
              },
              { label: 'Pattern', value: trip.job.hourlyPattern || '-' },
              {
                label: 'Route distance (planned)',
                value: `${trip.job.routeDistanceKm ?? '-'} km`,
              },
              {
                label: 'Site access',
                value: `${trip.job.siteManeuverability || '-'} / ${trip.job.siteFacility || '-'}`,
              },
            ],
          },
          {
            title: 'Stops',
            table: {
              headers: ['#', 'Type', 'Suburb', 'Arrival', 'Departure', 'Wait'],
              rows: tableRows,
            },
            paragraphs: [
              (() => {
                const odo = this.asTripOdometer(trip);
                const start = odo.odometerStartKm;
                const end = odo.odometerEndKm;
                const gps = odo.odometerGpsDistanceKm;
                const delta =
                  start != null && end != null ? (end - start).toFixed(1) : null;
                const parts = [
                  `Start odometer: ${start != null ? `${start} km` : 'not captured'}`,
                  `End odometer: ${end != null ? `${end} km` : 'not captured'}`,
                  delta != null ? `Odo distance: ${delta} km` : null,
                  gps != null ? `GPS path: ${gps.toFixed(1)} km` : null,
                  odo.odometerDiscrepancyFlag
                    ? 'FLAG: odometer vs GPS discrepancy > 10% — Super Admin review'
                    : null,
                ].filter(Boolean);
                return parts.join(' | ');
              })(),
            ],
          },
          {
            title: 'Fatigue / break log',
            rows: [
              {
                label: 'Break at completion',
                value: trip.onBreak ? 'yes' : 'no',
              },
              {
                label: 'Break started',
                value: trip.breakStartedAt?.toISOString() ?? '-',
              },
              { label: 'Billing note', value: floorNote },
              { label: 'Final receiver (SOG)', value: signer },
            ],
          },
        ],
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

    const attachments: Array<{
      filename: string;
      content: Buffer;
      contentType: string;
    }> = [
      {
        filename: `CLOX-tax-invoice-${invoiceRef}.pdf`,
        content: invoicePdf,
        contentType: 'application/pdf',
      },
    ];
    if (runSheetPdf) {
      attachments.push({
        filename: `CLOX-run-sheet-${trip.jobId.slice(0, 8)}.pdf`,
        content: runSheetPdf,
        contentType: 'application/pdf',
      });
    }
    if (trip.podStorageKey) {
      try {
        const podBuf = await readFile(join(this.storageRoot(), trip.podStorageKey));
        attachments.push({
          filename: `CLOX-POD-${trip.jobId.slice(0, 8)}.pdf`,
          content: podBuf,
          contentType: 'application/pdf',
        });
      } catch {
        // POD already emailed at finalize; skip if file missing.
      }
    }

    await this.notifications.notifyTripCompletionDocuments({
      senderEmails,
      carrierEmails,
      receiverEmail,
      jobId: trip.jobId,
      jobTitle: trip.job.title,
      hasRunSheet: Boolean(runSheetKey),
      totalIncGstCents: totalInc,
      attachments,
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
      latest: samples[0]
        ? {
            lat: Number(samples[0].lat),
            lng: Number(samples[0].lng),
            recordedAt: samples[0].recordedAt,
          }
        : null,
      stopsProgress: this.mapStopProgress(trip.stopProgress),
      surcharges: this.mapSurcharges(trip.surcharges),
      taxInvoiceStorageKey: trip.taxInvoiceStorageKey,
      runSheetStorageKey: trip.runSheetStorageKey,
      podStorageKey: trip.podStorageKey,
    };
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
  }

  /**
   * M10 Phase E — if haversine ETA to next unfinished dropoff is in the
   * configured window and driver has not already notified, send ETA_AUTO email.
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

    const meters = haversineMeters(point.lat, point.lng, stopLat, stopLng);
    const etaMinutes = ((meters / 1000) / speedKmh) * 60;
    if (etaMinutes < minEta || etaMinutes > maxEta) return;

    await this.recordApproachingNotify({
      tripId: trip.id,
      jobStopId: targetStop.id,
      source: 'ETA_AUTO',
      actorUserId,
      etaLabel: `~${Math.round(etaMinutes)} min`,
    });
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
      const mail = await this.notifications.notifyTripApproaching({
        senderEmails: parties.senderEmails,
        receiverEmail: parties.receiverEmail,
        jobId: parties.jobId,
        jobTitle: parties.jobTitle,
        dropSuburb: parties.dropSuburb,
        dropAddress: parties.dropAddress,
        etaLabel: params.etaLabel,
        source: params.source,
      });
      sentTo = mail.sentTo;
    } catch {
      // Best-effort email after state is recorded.
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
