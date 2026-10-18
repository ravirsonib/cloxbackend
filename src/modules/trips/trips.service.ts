import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AssignmentStatus,
  JobStatus,
  SurchargeKind,
  SurchargeStatus,
  TripStatus,
  VehicleStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import type { AppEnv } from '../../config/env.validation';
import {
  AuditAction,
  type TripBreakInput,
  type TripLocationInput,
  type TripMassCheckInput,
  type TripSafetyCheckInput,
  type TripStartInput,
} from '../../shared/types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PaymentsService } from '../payments/payments.service';
import {
  DEFAULT_GEOFENCE_POLICY,
  freeWaitMs,
  isInsideRadius,
  massSurchargeIncGstCents,
  parseGeofencePolicy,
  waitOverageMinutes,
  waitingSurchargeIncGstCents,
  type GeofencePolicy,
} from './geofence.util';

@Injectable()
export class TripsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<AppEnv, true>,
    @Inject(forwardRef(() => PaymentsService))
    private readonly payments: PaymentsService,
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
    job?: {
      title: string | null;
      status: JobStatus;
      siteManeuverability: string | null;
      siteFacility: string | null;
      deadWeightKg: number | null;
      chargeableWeightKg: number | null;
      stops?: Array<{
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
  }) {
    const pendingMass = this.hasPendingMass(trip.surcharges);
    const massOk = trip.massCheckOk && !pendingMass;
    const gates = {
      paid: trip.assignment?.status === AssignmentStatus.LOCKED,
      safetyOk: Boolean(trip.safetyPassedAt) && !trip.safetyFailedAt,
      massOk,
      canStart:
        trip.assignment?.status === AssignmentStatus.LOCKED &&
        Boolean(trip.safetyPassedAt) &&
        !trip.safetyFailedAt &&
        massOk &&
        !pendingMass &&
        !trip.startedAt,
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
      startedAt: trip.startedAt,
      completedAt: trip.completedAt,
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
    const trips = await this.prisma.trip.findMany({
      where: { assignment: { driverId: user.driver!.id } },
      include: this.tripInclude(),
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    return trips.map((t) => this.mapTrip(t));
  }

  async getDriverTrip(principal: AuthenticatedPrincipal, tripId: string) {
    this.ensureDatabase();
    const user = await this.requireDriver(principal);
    const trip = await this.loadTripForDriver(user.driver!.id, tripId);
    return this.mapTrip(trip);
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
        select: { status: true },
      });
      if (!vehicle || vehicle.status !== VehicleStatus.ACTIVE) {
        throw new ForbiddenException({
          message: 'Vehicle is not ACTIVE — cannot start trip',
          code: 'VEHICLE_NOT_ACTIVE',
        });
      }
    }
    if (trip.startedAt) {
      return this.mapTrip(trip);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const t = await tx.trip.update({
        where: { id: trip.id },
        data: {
          status: TripStatus.IN_TRANSIT,
          startedAt: new Date(),
          onBreak: false,
        },
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
    });
    await this.audit.recordPlatform({
      action: AuditAction.PUSH_STUB,
      actorUserId: user.id,
      entityType: 'Job',
      entityId: trip.jobId,
      metadata: { event: 'trip_started', channel: 'FCM/APNs stub' },
    });

    return this.mapTrip(updated);
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

  /** Mark trip/job/assignment COMPLETED when every stop has arrived and exited. */
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
    const allDone = trip.job.stops.every((s) => {
      const p = byStop.get(s.id);
      return Boolean(p?.arrivalRecorded && p.exitedAt);
    });
    if (!allDone) return;

    // Attempt to settle deferred WAITING before completion (chargeNow was false during dwell).
    const pendingWaiting = trip.surcharges.filter(
      (s) =>
        s.kind === SurchargeKind.WAITING &&
        s.status === SurchargeStatus.PENDING_PAYMENT,
    );
    for (const s of pendingWaiting) {
      try {
        await this.payments.chargeSurcharge(s.id);
      } catch {
        // Gate below blocks COMPLETED until paid or waived.
      }
    }

    const stillPending = await this.prisma.surcharge.count({
      where: {
        tripId: trip.id,
        status: SurchargeStatus.PENDING_PAYMENT,
      },
    });
    if (stillPending > 0) {
      return;
    }

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
        tripStatus: trip.status,
        stopsProgress: this.mapStopProgress(trip.stopProgress),
        surcharges: this.mapSurcharges(trip.surcharges),
      };
    }

    const samples = trip.onBreak ? [] : trip.locations;
    return {
      visible: true,
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
    };
  }
}
