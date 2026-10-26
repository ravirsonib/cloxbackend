import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AssignmentStatus,
  DriverStatus,
  JobStatus,
  ProposalStatus,
  TripExceptionKind,
  TripExceptionPhase,
  TripExceptionStatus,
  TripStatus,
  UserStatus,
  VehicleStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import type { AppEnv } from '../../config/env.validation';
import {
  AdminRole,
  AuditAction,
  type TripExceptionContinueInput,
  type TripExceptionEscalateInput,
  type TripExceptionOpenInput,
  type TripExceptionReassignInput,
  type TripExceptionReleaseInput,
} from '../../shared/types';
import {
  evaluateDriverLicenceFields,
  hasUsableDriverLicenceDocument,
  hasUsableVehicleRwcDocument,
} from '../jobs/assignment-gates';
import {
  isVehicleClassAdequate,
  vehicleClassRank,
} from '../jobs/job-pricing.util';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CarrierService } from '../carrier/carrier.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  buildBrandedPdf,
  loadCloxLogoBuffer,
} from '../trips/branded-pdf.util';
import { writeTripArtifact } from '../trips/pod-artifacts.util';

export type RescueCandidate = {
  vehicleId: string;
  driverId: string;
  score: number;
  classScore: number;
  proximityScore: number;
  vehicle: {
    id: string;
    registration: string | null;
    vehicleClass: string | null;
  };
  driver: {
    id: string;
    name: string | null;
    email: string | null;
    licenceClass: string | null;
  };
  reasons: string[];
};

const OPEN_STATUSES: TripExceptionStatus[] = [
  TripExceptionStatus.OPEN,
  TripExceptionStatus.AWAITING_CARRIER,
  TripExceptionStatus.REASSIGN_IN_PROGRESS,
  TripExceptionStatus.ESCALATED,
];

const PRE_TRIP_STATUSES: TripStatus[] = [TripStatus.PENDING_GATES];

@Injectable()
export class ExceptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly carrier: CarrierService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  private mapException(row: {
    id: string;
    jobId: string;
    assignmentId: string;
    tripId: string | null;
    companyId: string;
    reportedByUserId: string;
    kind: TripExceptionKind;
    phase: TripExceptionPhase;
    status: TripExceptionStatus;
    reasonCode: string | null;
    note: string | null;
    gpsLat: number | null;
    gpsLng: number | null;
    photoDocumentId: string | null;
    breakdownPdfStorageKey?: string | null;
    openedAt: Date;
    escalatedAt: Date | null;
    resolvedAt: Date | null;
    resolutionNote: string | null;
    job?: {
      id: string;
      title: string | null;
      rescueDiscountPercent?: number | null;
      marketplacePriority?: boolean;
    } | null;
    assignment?: {
      vehicle?: { id: string; registration: string | null; vehicleClass: string | null } | null;
      driver?: {
        id: string;
        user?: { email: string; name: string | null } | null;
      } | null;
    } | null;
  }) {
    return {
      id: row.id,
      jobId: row.jobId,
      assignmentId: row.assignmentId,
      tripId: row.tripId,
      companyId: row.companyId,
      reportedByUserId: row.reportedByUserId,
      kind: row.kind,
      phase: row.phase,
      status: row.status,
      reasonCode: row.reasonCode,
      note: row.note,
      gpsLat: row.gpsLat,
      gpsLng: row.gpsLng,
      photoDocumentId: row.photoDocumentId,
      breakdownPdfStorageKey: row.breakdownPdfStorageKey ?? null,
      openedAt: row.openedAt,
      escalatedAt: row.escalatedAt,
      resolvedAt: row.resolvedAt,
      resolutionNote: row.resolutionNote,
      job: row.job
        ? {
            id: row.job.id,
            title: row.job.title,
            rescueDiscountPercent: row.job.rescueDiscountPercent ?? null,
            marketplacePriority: row.job.marketplacePriority ?? false,
          }
        : null,
      vehicle: row.assignment?.vehicle ?? null,
      driver: row.assignment?.driver
        ? {
            id: row.assignment.driver.id,
            email: row.assignment.driver.user?.email ?? null,
            name: row.assignment.driver.user?.name ?? null,
          }
        : null,
    };
  }

  private detailInclude() {
    return {
      job: {
        select: {
          id: true,
          title: true,
          rescueDiscountPercent: true,
          marketplacePriority: true,
        },
      },
      assignment: {
        select: {
          vehicle: {
            select: { id: true, registration: true, vehicleClass: true },
          },
          driver: {
            select: {
              id: true,
              user: { select: { email: true, name: true } },
            },
          },
        },
      },
    };
  }

  async open(principal: AuthenticatedPrincipal, input: TripExceptionOpenInput) {
    this.ensureDatabase();
    if (principal.kind !== 'user' || principal.role !== 'DRIVER') {
      throw new ForbiddenException('Driver required');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      include: { driver: true },
    });
    if (!user?.driver) throw new ForbiddenException('Driver profile required');

    const trip = await this.prisma.trip.findFirst({
      where: { id: input.tripId, assignment: { driverId: user.driver.id } },
      include: {
        assignment: {
          include: {
            vehicle: { select: { registration: true, label: true } },
            carrierCompany: {
              select: {
                id: true,
                email: true,
                legalName: true,
                users: {
                  where: {
                    role: 'TRANSPORT_COMPANY',
                    status: { in: [UserStatus.ACTIVE, UserStatus.PENDING] },
                  },
                  select: { email: true },
                  take: 10,
                },
              },
            },
          },
        },
        job: {
          select: {
            id: true,
            title: true,
            receiverEmail: true,
            senderCompany: {
              select: {
                email: true,
                users: {
                  where: { role: 'SENDER', status: UserStatus.ACTIVE },
                  select: { email: true },
                  take: 5,
                },
              },
            },
          },
        },
      },
    });
    if (!trip) throw new NotFoundException('Trip not found');
    if (
      trip.status === TripStatus.COMPLETED ||
      trip.status === TripStatus.CANCELLED
    ) {
      throw new BadRequestException('Cannot open an exception on a finished trip');
    }
    if (trip.assignment.status !== AssignmentStatus.LOCKED) {
      throw new BadRequestException('Assignment must be locked (paid) to open an exception');
    }

    const existing = await this.prisma.tripException.findFirst({
      where: {
        assignmentId: trip.assignmentId,
        status: { in: OPEN_STATUSES },
      },
    });
    if (existing) {
      throw new BadRequestException({
        message: 'An open exception already exists for this assignment',
        code: 'EXCEPTION_ALREADY_OPEN',
        exceptionId: existing.id,
      });
    }

    const phase = PRE_TRIP_STATUSES.includes(trip.status)
      ? TripExceptionPhase.PRE_TRIP
      : TripExceptionPhase.MID_TRIP;
    const forceOffline = input.kind === TripExceptionKind.DRIVER_UNAVAILABLE;
    const setBreakdown = phase === TripExceptionPhase.MID_TRIP;

    if (input.photoDocumentId) {
      const doc = await this.prisma.complianceDocument.findFirst({
        where: {
          id: input.photoDocumentId,
          driverId: user.driver.id,
        },
        select: { id: true, status: true },
      });
      if (!doc) {
        throw new BadRequestException({
          message: 'photoDocumentId not found for this driver',
          code: 'PHOTO_NOT_FOUND',
        });
      }
    } else if (input.kind === TripExceptionKind.VEHICLE_BREAKDOWN) {
      throw new BadRequestException({
        message: 'Photo evidence is required for vehicle breakdown',
        code: 'PHOTO_REQUIRED',
      });
    }

    const created = await this.prisma.$transaction(async (tx) => {
      if (setBreakdown) {
        await tx.trip.update({
          where: { id: trip.id },
          data: { status: TripStatus.BREAKDOWN },
        });
      }
      if (forceOffline) {
        // Force offline for matching (not assignable). Keep session so driver can see confirmation in-app.
        await tx.driver.update({
          where: { id: user.driver!.id },
          data: {
            status: DriverStatus.SUSPENDED,
            disabledAt: new Date(),
            disabledReason: `UNAVAILABLE_${input.reasonCode ?? input.kind}`,
            disabledNote: input.note,
          },
        });
      }

      return tx.tripException.create({
        data: {
          jobId: trip.jobId,
          assignmentId: trip.assignmentId,
          tripId: trip.id,
          companyId: trip.assignment.carrierCompanyId,
          reportedByUserId: user.id,
          kind: input.kind as TripExceptionKind,
          phase,
          status: TripExceptionStatus.AWAITING_CARRIER,
          reasonCode: input.reasonCode?.trim() || null,
          note: input.note.trim(),
          gpsLat: input.gpsLat ?? null,
          gpsLng: input.gpsLng ?? null,
          photoDocumentId: input.photoDocumentId ?? null,
        },
        include: this.detailInclude(),
      });
    });

    await this.audit.recordPlatform({
      action: AuditAction.EXCEPTION_OPENED,
      actorUserId: user.id,
      entityType: 'TripException',
      entityId: created.id,
      metadata: {
        kind: created.kind,
        phase: created.phase,
        tripId: trip.id,
        forceOffline,
        setBreakdown,
      },
    });

    if (forceOffline && user.driver?.id) {
      await this.applyDriverReliabilityDelta(user.driver.id, created.id, user.id);
    }

    const carrierEmails = [
      ...trip.assignment.carrierCompany.users.map((u) => u.email),
      ...(trip.assignment.carrierCompany.email
        ? [trip.assignment.carrierCompany.email]
        : []),
    ];
    const senderEmail =
      trip.job.receiverEmail ??
      trip.job.senderCompany.users[0]?.email ??
      trip.job.senderCompany.email ??
      null;

    const notifyResult = await this.notifications.notifyTripExceptionOpened({
      driverEmail: user.email,
      carrierEmails,
      senderEmail,
      jobTitle: trip.job.title ?? '',
      jobId: trip.job.id,
      kind: created.kind,
      phase: created.phase,
      reasonCode: created.reasonCode,
      note: created.note ?? input.note,
      exceptionId: created.id,
    });

    await this.audit.recordPlatform({
      action: AuditAction.EXCEPTION_NOTIFIED,
      actorUserId: user.id,
      entityType: 'TripException',
      entityId: created.id,
      metadata: {
        carrierCount: carrierEmails.length,
        senderNotified: Boolean(senderEmail),
        notify: notifyResult,
      },
    });

    let exceptionForMap: Parameters<ExceptionsService['mapException']>[0] = created;
    try {
      exceptionForMap = await this.generateBreakdownPdf({
        exception: created,
        actorUserId: user.id,
        driverEmail: user.email,
        driverName: user.name ?? user.email,
        carrierLegalName: trip.assignment.carrierCompany.legalName,
        vehicleRegistration: trip.assignment.vehicle?.registration ?? null,
        jobTitle: trip.job.title,
        carrierEmails,
        senderEmail,
      });
    } catch {
      // Opening the exception must not fail if PDF generation fails.
    }

    let autoReassigned = false;
    let exceptionRow = this.mapException(exceptionForMap);
    if (phase === TripExceptionPhase.PRE_TRIP) {
      try {
        const rescue = await this.buildRescueCandidates({
          companyId: created.companyId,
          assignmentId: created.assignmentId,
          jobId: created.jobId,
          kind: created.kind,
          gpsLat: created.gpsLat,
          gpsLng: created.gpsLng,
        });
        if (rescue.unambiguous && rescue.recommended) {
          const carrierUser = await this.prisma.user.findFirst({
            where: {
              companyId: created.companyId,
              role: 'TRANSPORT_COMPANY',
              status: { in: [UserStatus.ACTIVE, UserStatus.PENDING] },
            },
            select: { id: true, email: true },
          });
          if (carrierUser) {
            const auto = await this.reassign(
              {
                id: carrierUser.id,
                email: carrierUser.email,
                role: 'TRANSPORT_COMPANY',
                kind: 'user',
                regionCodes: [],
                territoryCodes: [],
              },
              created.id,
              {
                vehicleId: rescue.recommended.vehicleId,
                driverId: rescue.recommended.driverId,
                note: 'Auto-reassigned: single eligible crew',
              },
            );
            exceptionRow = auto.exception;
            autoReassigned = true;
          }
        }
      } catch {
        // Leave open for carrier confirm — never fail the driver report.
      }
    }

    return {
      ...exceptionRow,
      forceOffline,
      tripStatus: setBreakdown ? TripStatus.BREAKDOWN : trip.status,
      autoReassigned,
      notified: {
        carrier: carrierEmails.length > 0,
        sender: Boolean(senderEmail),
        driver: true,
      },
    };
  }

  async listForCarrier(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    if (principal.kind !== 'user' || principal.role !== 'TRANSPORT_COMPANY') {
      throw new ForbiddenException('Carrier required');
    }
    const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
    if (!user?.companyId) throw new NotFoundException('Carrier company not found');

    const rows = await this.prisma.tripException.findMany({
      where: { companyId: user.companyId },
      include: this.detailInclude(),
      orderBy: { openedAt: 'desc' },
      take: 50,
    });
    const settings = await this.prisma.platformSettings.upsert({
      where: { id: 'default' },
      create: { id: 'default' },
      update: {},
    });
    return {
      items: rows.map((r) => this.mapException(r)),
      marketplaceRelistSlaMs: settings.marketplaceRelistSlaMs,
    };
  }

  async getForPrincipal(principal: AuthenticatedPrincipal, id: string) {
    this.ensureDatabase();
    const row = await this.prisma.tripException.findUnique({
      where: { id },
      include: this.detailInclude(),
    });
    if (!row) throw new NotFoundException('Exception not found');

    if (principal.kind === 'user' && principal.role === 'TRANSPORT_COMPANY') {
      const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
      if (!user?.companyId || user.companyId !== row.companyId) {
        throw new ForbiddenException();
      }
    } else if (principal.kind === 'user' && principal.role === 'DRIVER') {
      if (row.reportedByUserId !== principal.id) {
        const driver = await this.prisma.driver.findUnique({
          where: { userId: principal.id },
        });
        const assignment = await this.prisma.assignment.findUnique({
          where: { id: row.assignmentId },
          select: { driverId: true },
        });
        if (!driver || assignment?.driverId !== driver.id) {
          throw new ForbiddenException();
        }
      }
    } else if (principal.kind !== 'admin') {
      throw new ForbiddenException();
    }

    const settings = await this.prisma.platformSettings.upsert({
      where: { id: 'default' },
      create: { id: 'default' },
      update: {},
    });
    return {
      ...this.mapException(row),
      marketplaceRelistSlaMs: settings.marketplaceRelistSlaMs,
    };
  }

  async reassign(
    principal: AuthenticatedPrincipal,
    id: string,
    input: TripExceptionReassignInput,
  ) {
    this.ensureDatabase();
    if (principal.kind !== 'user' || principal.role !== 'TRANSPORT_COMPANY') {
      throw new ForbiddenException('Carrier required');
    }

    const row = await this.prisma.tripException.findUnique({
      where: { id },
      include: {
        job: {
          select: {
            id: true,
            title: true,
            receiverEmail: true,
            senderCompany: {
              select: {
                email: true,
                users: {
                  where: { role: 'SENDER', status: UserStatus.ACTIVE },
                  select: { email: true },
                  take: 5,
                },
              },
            },
          },
        },
        assignment: {
          include: {
            driver: { include: { user: { select: { email: true, name: true } } } },
            vehicle: { select: { registration: true, label: true } },
            carrierCompany: {
              select: {
                email: true,
                users: {
                  where: {
                    role: 'TRANSPORT_COMPANY',
                    status: { in: [UserStatus.ACTIVE, UserStatus.PENDING] },
                  },
                  select: { email: true },
                  take: 10,
                },
              },
            },
          },
        },
      },
    });
    if (!row) throw new NotFoundException('Exception not found');

    const user = await this.prisma.user.findUnique({ where: { id: principal.id } });
    if (!user?.companyId || user.companyId !== row.companyId) {
      throw new ForbiddenException();
    }
    if (!OPEN_STATUSES.includes(row.status)) {
      throw new BadRequestException('Exception is already resolved');
    }

    await this.prisma.tripException.update({
      where: { id },
      data: { status: TripExceptionStatus.REASSIGN_IN_PROGRESS },
    });

    const previousDriverEmail = row.assignment.driver?.user.email ?? null;

    const reassigned = await this.carrier.reassignAssignment(principal, row.assignmentId, {
      vehicleId: input.vehicleId,
      driverId: input.driverId,
      reason: `Exception ${row.kind}`,
      note: input.note,
    });

    const resolved = await this.prisma.tripException.update({
      where: { id },
      data: {
        status: TripExceptionStatus.RESOLVED_REASSIGNED,
        resolvedAt: new Date(),
        resolvedByUserId: principal.id,
        resolutionNote: input.note?.trim() || 'Intra-fleet reassign',
      },
      include: this.detailInclude(),
    });

    // Mid-trip breakdown → after reassign, leave trip for new driver gates if safety reset
    if (row.phase === TripExceptionPhase.MID_TRIP && row.tripId && reassigned.safetyReset) {
      await this.prisma.trip.update({
        where: { id: row.tripId },
        data: { status: TripStatus.PENDING_GATES },
      });
    } else if (
      row.phase === TripExceptionPhase.MID_TRIP &&
      row.tripId &&
      !reassigned.safetyReset
    ) {
      await this.prisma.trip.update({
        where: { id: row.tripId },
        data: { status: TripStatus.EN_ROUTE_PICKUP },
      });
    }

    await this.audit.recordPlatform({
      action: AuditAction.EXCEPTION_REASSIGNED,
      actorUserId: principal.id,
      entityType: 'TripException',
      entityId: id,
      metadata: {
        vehicleId: input.vehicleId,
        driverId: input.driverId,
        safetyReset: reassigned.safetyReset,
      },
    });
    await this.audit.recordPlatform({
      action: AuditAction.EXCEPTION_RESOLVED,
      actorUserId: principal.id,
      entityType: 'TripException',
      entityId: id,
      metadata: { outcome: 'RESOLVED_REASSIGNED' },
    });
    await this.recordPerformanceStub(principal.id, id, 'RESOLVED_REASSIGNED');

    const newDriver = await this.prisma.driver.findUnique({
      where: { id: input.driverId },
      include: { user: { select: { email: true, name: true } } },
    });
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: input.vehicleId },
      select: { registration: true, label: true },
    });
    const carrierEmails = [
      ...row.assignment.carrierCompany.users.map((u) => u.email),
      ...(row.assignment.carrierCompany.email
        ? [row.assignment.carrierCompany.email]
        : []),
    ];
    const senderEmail =
      row.job.receiverEmail ??
      row.job.senderCompany.users[0]?.email ??
      row.job.senderCompany.email ??
      null;

    await this.notifications.notifyTripExceptionReassigned({
      driverEmail: newDriver?.user.email ?? null,
      previousDriverEmail,
      carrierEmails,
      senderEmail,
      jobTitle: row.job.title ?? '',
      jobId: row.job.id,
      vehicleLabel: vehicle?.registration ?? vehicle?.label ?? input.vehicleId.slice(0, 8),
      driverName: newDriver?.user.name ?? newDriver?.user.email ?? input.driverId.slice(0, 8),
      exceptionId: id,
    });

    return {
      exception: this.mapException(resolved),
      reassignment: reassigned,
    };
  }

  async listRescueCandidates(principal: AuthenticatedPrincipal, id: string) {
    this.ensureDatabase();
    if (principal.kind !== 'user' || principal.role !== 'TRANSPORT_COMPANY') {
      throw new ForbiddenException('Carrier required');
    }
    const row = await this.loadOpenExceptionForCarrier(principal.id, id);
    return this.buildRescueCandidates({
      companyId: row.companyId,
      assignmentId: row.assignmentId,
      jobId: row.jobId,
      kind: row.kind,
      gpsLat: row.gpsLat,
      gpsLng: row.gpsLng,
    });
  }

  async continueTrip(
    principal: AuthenticatedPrincipal,
    id: string,
    input: TripExceptionContinueInput,
  ) {
    this.ensureDatabase();
    if (principal.kind !== 'user' || principal.role !== 'TRANSPORT_COMPANY') {
      throw new ForbiddenException('Carrier required');
    }

    const row = await this.loadOpenExceptionForCarrier(principal.id, id);
    const note = input.note.trim();
    const etaNote = input.etaNote?.trim() || null;

    const nextTripStatus =
      row.phase === TripExceptionPhase.PRE_TRIP
        ? TripStatus.PENDING_GATES
        : TripStatus.EN_ROUTE_PICKUP;

    const resolved = await this.prisma.$transaction(async (tx) => {
      if (row.tripId) {
        await tx.trip.update({
          where: { id: row.tripId },
          data: {
            status: nextTripStatus,
            safetyNotes: etaNote
              ? `[CONTINUE] ${note} | ETA: ${etaNote}`
              : `[CONTINUE] ${note}`,
          },
        });
      }
      return tx.tripException.update({
        where: { id },
        data: {
          status: TripExceptionStatus.RESOLVED_CONTINUED,
          resolvedAt: new Date(),
          resolvedByUserId: principal.id,
          resolutionNote: etaNote ? `${note} | ETA: ${etaNote}` : note,
        },
        include: this.detailInclude(),
      });
    });

    await this.audit.recordPlatform({
      action: AuditAction.EXCEPTION_RESOLVED,
      actorUserId: principal.id,
      entityType: 'TripException',
      entityId: id,
      metadata: { outcome: 'RESOLVED_CONTINUED', etaNote },
    });
    await this.recordPerformanceStub(principal.id, id, 'RESOLVED_CONTINUED');

    const notify = await this.loadNotifyTargets(row);
    await this.notifications.notifyTripExceptionContinued({
      driverEmail: notify.driverEmail,
      carrierEmails: notify.carrierEmails,
      senderEmail: notify.senderEmail,
      jobTitle: notify.jobTitle,
      jobId: notify.jobId,
      note,
      etaNote,
      exceptionId: id,
    });

    return { exception: this.mapException(resolved) };
  }

  /**
   * Explicit marketplace re-list — cancels current assignment/trip, reopens job for bidding
   * with priority + Super-configured carrier discount. Sender estimate unchanged.
   */
  async releaseToMarketplace(
    principal: AuthenticatedPrincipal,
    id: string,
    input: TripExceptionReleaseInput,
    options?: { automatic?: boolean },
  ) {
    this.ensureDatabase();
    const automatic = options?.automatic === true;
    const isSuper =
      principal.kind === 'admin' && principal.role === AdminRole.SUPER_ADMIN;
    const isCarrier =
      principal.kind === 'user' && principal.role === 'TRANSPORT_COMPANY';

    let row: Awaited<ReturnType<ExceptionsService['loadExceptionRow']>>;
    let actorUserId: string | undefined;
    let actorAdminId: string | undefined;

    if (automatic) {
      row = await this.loadExceptionRow(id);
      if (row.status === TripExceptionStatus.RESOLVED_RELISTED) {
        return {
          exception: this.mapException(row),
          marketplaceRelease: {
            status: 'ALREADY_RELISTED',
            reListJob: true,
            marketplacePriority: true,
            discountPercent: row.job?.rescueDiscountPercent ?? null,
          },
        };
      }
      if (
        row.status !== TripExceptionStatus.AWAITING_CARRIER ||
        row.phase !== TripExceptionPhase.PRE_TRIP
      ) {
        throw new BadRequestException('Exception cannot be auto-relisted');
      }
    } else if (isSuper) {
      actorAdminId = principal.id;
      row = await this.loadExceptionRow(id);
      if (!OPEN_STATUSES.includes(row.status)) {
        throw new BadRequestException('Exception is already resolved');
      }
    } else if (isCarrier) {
      actorUserId = principal.id;
      row = await this.loadOpenExceptionForCarrier(principal.id, id);
    } else {
      throw new ForbiddenException('Carrier or Super Admin required');
    }

    const note =
      input.note?.trim() ||
      (automatic
        ? 'Auto re-listed to marketplace: no carrier rescue within SLA'
        : 'Released to marketplace');

    const settings = await this.prisma.platformSettings.upsert({
      where: { id: 'default' },
      create: { id: 'default' },
      update: {},
    });
    const discountPercent = Math.min(50, Math.max(0, settings.rescueDiscountPercent));

    const resolved = await this.prisma.$transaction(async (tx) => {
      if (row.tripId) {
        await tx.trip.update({
          where: { id: row.tripId },
          data: { status: TripStatus.CANCELLED, onBreak: false, breakStartedAt: null },
        });
      }
      await tx.assignment.update({
        where: { id: row.assignmentId },
        data: { status: AssignmentStatus.CANCELLED },
      });
      await tx.proposal.updateMany({
        where: {
          jobId: row.jobId,
          status: ProposalStatus.SUBMITTED,
        },
        data: { status: ProposalStatus.EXPIRED },
      });
      await tx.job.update({
        where: { id: row.jobId },
        data: {
          status: JobStatus.BIDDING,
          publishedAt: new Date(),
          marketplacePriority: true,
          rescueDiscountPercent: discountPercent,
          rescuedFromExceptionId: id,
        },
      });
      return tx.tripException.update({
        where: { id },
        data: {
          status: TripExceptionStatus.RESOLVED_RELISTED,
          resolvedAt: new Date(),
          resolvedByUserId: actorUserId ?? null,
          resolutionNote: note,
        },
        include: this.detailInclude(),
      });
    });

    await this.audit.recordPlatform({
      action: AuditAction.EXCEPTION_RELEASED,
      actorUserId,
      actorAdminId,
      entityType: 'TripException',
      entityId: id,
      metadata: {
        outcome: 'RESOLVED_RELISTED',
        marketplaceRelease: automatic ? 'AUTOMATIC_SLA' : 'EXPLICIT',
        discountPercent,
        marketplacePriority: true,
      },
    });
    await this.audit.recordPlatform({
      action: AuditAction.EXCEPTION_RELISTED,
      actorUserId,
      actorAdminId,
      entityType: 'Job',
      entityId: row.jobId,
      metadata: {
        exceptionId: id,
        discountPercent,
        automatic,
      },
    });
    await this.audit.recordPlatform({
      action: AuditAction.EXCEPTION_RESOLVED,
      actorUserId,
      actorAdminId,
      entityType: 'TripException',
      entityId: id,
      metadata: { outcome: 'RESOLVED_RELISTED' },
    });

    await this.applyCarrierReliabilityDelta(
      row.companyId,
      id,
      settings.carrierMarketplaceReleaseScoreDelta,
      actorUserId,
      actorAdminId,
    );

    const notify = await this.loadNotifyTargets(row);
    await this.notifications.notifyTripExceptionReleased({
      driverEmail: notify.driverEmail,
      carrierEmails: notify.carrierEmails,
      senderEmail: notify.senderEmail,
      opsEmail: this.config.get('NOTIFY_EMAIL', { infer: true }) ?? null,
      jobTitle: notify.jobTitle,
      jobId: notify.jobId,
      note: `${note} (priority marketplace · ${discountPercent}% carrier discount; customer price unchanged)`,
      exceptionId: id,
      phase: row.phase,
    });

    return {
      exception: this.mapException(resolved),
      marketplaceRelease: {
        status: 'RELISTED',
        reListJob: true,
        marketplacePriority: true,
        discountPercent,
        message:
          'Job re-listed on marketplace with priority. Sender estimate unchanged; carrier bid floor discounted.',
      },
      stripeAdjustment: {
        status: 'STUB_NOT_IMPLEMENTED',
        amountCents: null,
      },
    };
  }

  async escalate(
    principal: AuthenticatedPrincipal,
    id: string,
    input: TripExceptionEscalateInput,
    options?: { automatic?: boolean },
  ) {
    this.ensureDatabase();
    const automatic = options?.automatic === true;

    let actorUserId: string | undefined;
    let row: Awaited<ReturnType<ExceptionsService['loadExceptionRow']>>;

    if (automatic) {
      row = await this.loadExceptionRow(id);
      if (row.status === TripExceptionStatus.ESCALATED) {
        return { exception: this.mapException(row), alreadyEscalated: true };
      }
      if (!OPEN_STATUSES.includes(row.status)) {
        throw new BadRequestException('Exception cannot be escalated');
      }
    } else {
      if (principal.kind !== 'user' || principal.role !== 'TRANSPORT_COMPANY') {
        throw new ForbiddenException('Carrier required');
      }
      actorUserId = principal.id;
      row = await this.loadOpenExceptionForCarrier(principal.id, id);
    }

    if (row.status === TripExceptionStatus.ESCALATED) {
      return { exception: this.mapException(row), alreadyEscalated: true };
    }

    const note =
      input.note?.trim() ||
      (automatic
        ? 'Auto-escalated: no carrier action within SLA'
        : 'Carrier escalated to Ops');

    const updated = await this.prisma.tripException.update({
      where: { id },
      data: {
        status: TripExceptionStatus.ESCALATED,
        escalatedAt: new Date(),
        resolutionNote: note,
      },
      include: this.detailInclude(),
    });

    await this.audit.recordPlatform({
      action: AuditAction.EXCEPTION_ESCALATED,
      actorUserId,
      entityType: 'TripException',
      entityId: id,
      metadata: { automatic, note },
    });

    const notify = await this.loadNotifyTargets(updated);
    await this.notifications.notifyTripExceptionEscalated({
      driverEmail: notify.driverEmail,
      carrierEmails: notify.carrierEmails,
      senderEmail: notify.senderEmail,
      opsEmail: this.config.get('NOTIFY_EMAIL', { infer: true }) ?? null,
      jobTitle: notify.jobTitle,
      jobId: notify.jobId,
      kind: updated.kind,
      phase: updated.phase,
      note,
      automatic,
      exceptionId: id,
    });

    return { exception: this.mapException(updated), alreadyEscalated: false };
  }

  async listForOps(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    if (principal.kind !== 'admin') {
      throw new ForbiddenException('Ops admin required');
    }

    const rows = await this.prisma.tripException.findMany({
      where: {
        status: {
          in: [
            TripExceptionStatus.AWAITING_CARRIER,
            TripExceptionStatus.REASSIGN_IN_PROGRESS,
            TripExceptionStatus.ESCALATED,
            TripExceptionStatus.OPEN,
          ],
        },
      },
      include: {
        ...this.detailInclude(),
        company: { select: { id: true, legalName: true } },
      },
      orderBy: [{ status: 'asc' }, { openedAt: 'desc' }],
      take: 100,
    });

    return {
      items: rows.map((r) => ({
        ...this.mapException(r),
        company: r.company,
      })),
    };
  }

  /** M10 Phase D — breakdown / exception report PDF (all kinds; vehicle breakdown primary). */
  private async generateBreakdownPdf(params: {
    exception: Parameters<ExceptionsService['mapException']>[0];
    actorUserId: string;
    driverEmail: string;
    driverName: string;
    carrierLegalName: string;
    vehicleRegistration: string | null;
    jobTitle: string | null;
    carrierEmails: string[];
    senderEmail: string | null;
  }): Promise<Parameters<ExceptionsService['mapException']>[0]> {
    const { exception } = params;
    if (exception.breakdownPdfStorageKey) {
      return exception;
    }
    const tripId = exception.tripId ?? 'unlinked';
    const exShort = exception.id.slice(0, 8);
    const pdf = await buildBrandedPdf({
      documentTitle: 'Exception report',
      subtitle: `${exception.kind} | ${exShort}`,
      headerRef: `CLOX-exception-${exShort} | ${exception.kind}`,
      logo: loadCloxLogoBuffer(),
      footerNote: 'CLOX | Confidential | System-generated exception report',
      sections: [
        {
          title: 'Exception details',
          rows: [
            { label: 'Exception id', value: exception.id },
            { label: 'Job', value: params.jobTitle || exception.jobId },
            { label: 'Kind', value: exception.kind },
            { label: 'Phase', value: exception.phase },
            { label: 'Opened', value: exception.openedAt.toISOString() },
            { label: 'Driver', value: params.driverName },
            { label: 'Carrier', value: params.carrierLegalName },
            {
              label: 'Vehicle',
              value: params.vehicleRegistration || '-',
            },
            { label: 'Reason code', value: exception.reasonCode || '-' },
            {
              label: 'GPS',
              value:
                exception.gpsLat != null && exception.gpsLng != null
                  ? `${exception.gpsLat}, ${exception.gpsLng}`
                  : '-',
            },
            {
              label: 'Photo evidence',
              value: exception.photoDocumentId || 'none',
            },
          ],
        },
        {
          title: 'Driver note',
          paragraphs: [exception.note || '-'],
        },
        {
          title: 'Notes',
          paragraphs: [
            'Generated automatically when the driver opened the exception in CLOX Cab.',
          ],
        },
      ],
    });
    const artifact = await writeTripArtifact({
      rootDir: this.config.get('STORAGE_LOCAL_DIR', { infer: true }) || '.data/uploads',
      tripId,
      stopId: exception.id,
      kind: 'breakdown-pdf',
      ext: 'pdf',
      buffer: pdf,
    });

    const updated = await this.prisma.tripException.update({
      where: { id: exception.id },
      data: { breakdownPdfStorageKey: artifact.storageKey },
      include: this.detailInclude(),
    });

    await this.audit.recordPlatform({
      action: AuditAction.TRIP_BREAKDOWN_PDF_GENERATED,
      actorUserId: params.actorUserId,
      entityType: 'TripException',
      entityId: exception.id,
      metadata: { breakdownPdfStorageKey: artifact.storageKey, kind: exception.kind },
    });

    await this.notifications.notifyBreakdownReport({
      carrierEmails: params.carrierEmails,
      senderEmail: params.senderEmail,
      driverEmail: params.driverEmail,
      jobId: exception.jobId,
      jobTitle: params.jobTitle,
      kind: exception.kind,
      exceptionId: exception.id,
      attachments: [
        {
          filename: `CLOX-exception-${exception.id.slice(0, 8)}.pdf`,
          content: pdf,
          contentType: 'application/pdf',
        },
      ],
    });

    return updated;
  }

  private async recordPerformanceStub(
    actorUserId: string | undefined,
    exceptionId: string,
    outcome: string,
  ) {
    await this.audit.recordPlatform({
      action: AuditAction.EXCEPTION_PERFORMANCE_STUB,
      actorUserId,
      entityType: 'TripException',
      entityId: exceptionId,
      metadata: {
        outcome,
        score: null,
        note: 'Non-score outcome recorded (reassign/continue)',
      },
    });
  }

  private clampScore(value: number) {
    return Math.max(0, Math.min(100, value));
  }

  private async applyDriverReliabilityDelta(
    driverId: string,
    exceptionId: string,
    actorUserId: string,
  ) {
    const settings = await this.prisma.platformSettings.upsert({
      where: { id: 'default' },
      create: { id: 'default' },
      update: {},
    });
    const delta = settings.driverUnavailableScoreDelta;
    const driver = await this.prisma.driver.findUnique({
      where: { id: driverId },
      select: { reliabilityScore: true },
    });
    if (!driver) return;
    const nextScore = this.clampScore(driver.reliabilityScore - delta);
    await this.prisma.driver.update({
      where: { id: driverId },
      data: { reliabilityScore: nextScore },
    });
    await this.audit.recordPlatform({
      action: AuditAction.EXCEPTION_PERFORMANCE_STUB,
      actorUserId,
      entityType: 'Driver',
      entityId: driverId,
      metadata: {
        exceptionId,
        outcome: 'DRIVER_UNAVAILABLE',
        delta: -delta,
        nextScore,
      },
    });
  }

  private async applyCarrierReliabilityDelta(
    companyId: string,
    exceptionId: string,
    delta: number,
    actorUserId?: string,
    actorAdminId?: string,
  ) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { reliabilityScore: true },
    });
    if (!company) return;
    const nextScore = this.clampScore(company.reliabilityScore - delta);
    await this.prisma.company.update({
      where: { id: companyId },
      data: { reliabilityScore: nextScore },
    });
    await this.audit.recordPlatform({
      action: AuditAction.EXCEPTION_PERFORMANCE_STUB,
      actorUserId,
      actorAdminId,
      entityType: 'Company',
      entityId: companyId,
      metadata: {
        exceptionId,
        outcome: 'MARKETPLACE_RELEASE',
        delta: -delta,
        nextScore,
      },
    });
  }

  private haversineKm(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const r = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  private async buildRescueCandidates(params: {
    companyId: string;
    assignmentId: string;
    jobId: string;
    kind: TripExceptionKind;
    gpsLat: number | null;
    gpsLng: number | null;
  }) {
    const [assignment, job, vehicles, drivers] = await Promise.all([
      this.prisma.assignment.findUnique({
        where: { id: params.assignmentId },
        select: { vehicleId: true, driverId: true },
      }),
      this.prisma.job.findUnique({
        where: { id: params.jobId },
        select: {
          minVehicleClass: true,
          stops: {
            where: { stopType: 'PICKUP' },
            orderBy: { sequence: 'asc' },
            take: 1,
            select: { lat: true, lng: true },
          },
        },
      }),
      this.prisma.vehicle.findMany({
        where: { companyId: params.companyId, status: VehicleStatus.ACTIVE },
        select: {
          id: true,
          registration: true,
          vehicleClass: true,
        },
      }),
      this.prisma.driver.findMany({
        where: { companyId: params.companyId, status: DriverStatus.ACTIVE },
        select: {
          id: true,
          status: true,
          licenceClass: true,
          licenceExpiry: true,
          nhvrAcknowledgedAt: true,
          user: { select: { email: true, name: true } },
        },
      }),
    ]);

    const minClass = job?.minVehicleClass ?? null;
    const minRank = vehicleClassRank(minClass);
    const excludeVehicleId =
      params.kind === TripExceptionKind.VEHICLE_BREAKDOWN
        ? assignment?.vehicleId
        : null;
    const now = new Date();

    const originLat =
      params.gpsLat ??
      (job?.stops[0]?.lat != null ? Number(job.stops[0].lat) : null);
    const originLng =
      params.gpsLng ??
      (job?.stops[0]?.lng != null ? Number(job.stops[0].lng) : null);

    const driverIds = drivers.map((d) => d.id);
    const driversWithLicenceDoc = new Set<string>();
    for (const d of drivers) {
      if (await hasUsableDriverLicenceDocument(this.prisma, d.id, now)) {
        driversWithLicenceDoc.add(d.id);
      }
    }
    const vehiclesWithRwc = new Set<string>();
    for (const v of vehicles) {
      if (await hasUsableVehicleRwcDocument(this.prisma, v.id, now)) {
        vehiclesWithRwc.add(v.id);
      }
    }
    const latestByDriver = new Map<string, { lat: number; lng: number }>();
    if (originLat != null && originLng != null && driverIds.length > 0) {
      const recentTrips = await this.prisma.trip.findMany({
        where: {
          assignment: { driverId: { in: driverIds } },
          status: { notIn: [TripStatus.COMPLETED, TripStatus.CANCELLED] },
        },
        select: {
          assignment: { select: { driverId: true } },
          locations: {
            orderBy: { recordedAt: 'desc' },
            take: 1,
            select: { lat: true, lng: true },
          },
        },
        take: 50,
      });
      for (const trip of recentTrips) {
        const drvId = trip.assignment.driverId;
        const loc = trip.locations[0];
        if (!drvId || !loc || latestByDriver.has(drvId)) continue;
        latestByDriver.set(drvId, {
          lat: Number(loc.lat),
          lng: Number(loc.lng),
        });
      }
    }

    const candidates: RescueCandidate[] = [];
    for (const vehicle of vehicles) {
      if (excludeVehicleId && vehicle.id === excludeVehicleId) continue;
      if (!vehiclesWithRwc.has(vehicle.id)) continue;
      if (!isVehicleClassAdequate(vehicle.vehicleClass, minClass)) continue;
      const classDelta = Math.max(
        0,
        vehicleClassRank(vehicle.vehicleClass) - minRank,
      );
      const classScore = Math.max(20, 100 - classDelta * 12);

      for (const driver of drivers) {
        if (!driversWithLicenceDoc.has(driver.id)) continue;
        const licenceGate = evaluateDriverLicenceFields(driver, vehicle.vehicleClass, now);
        if (!licenceGate.ok) continue;
        if (
          assignment?.vehicleId === vehicle.id &&
          assignment?.driverId === driver.id
        ) {
          continue;
        }

        let proximityScore = 50;
        const reasons = [`class_fit:${vehicle.vehicleClass ?? 'na'}`];
        const last = latestByDriver.get(driver.id);
        if (originLat != null && originLng != null && last) {
          const km = this.haversineKm(originLat, originLng, last.lat, last.lng);
          proximityScore = Math.max(0, Math.round(100 - km * 2));
          reasons.push(`proximity_km:${km.toFixed(1)}`);
        } else {
          reasons.push('proximity:neutral');
        }
        reasons.push(`licence:${driver.licenceClass ?? 'na'}`);

        const score = Math.round(classScore * 0.55 + proximityScore * 0.45);
        candidates.push({
          vehicleId: vehicle.id,
          driverId: driver.id,
          score,
          classScore,
          proximityScore,
          vehicle: {
            id: vehicle.id,
            registration: vehicle.registration,
            vehicleClass: vehicle.vehicleClass,
          },
          driver: {
            id: driver.id,
            name: driver.user.name,
            email: driver.user.email,
            licenceClass: driver.licenceClass,
          },
          reasons,
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score || a.vehicleId.localeCompare(b.vehicleId));
    const top = candidates.slice(0, 20);
    const unambiguous = top.length === 1;
    return {
      items: top,
      recommended: top[0] ?? null,
      unambiguous,
      minVehicleClass: minClass,
    };
  }

  /**
   * Pre-trip AWAITING_CARRIER past marketplace SLA → re-list to marketplace (never silent).
   * Carrier Escalate remains an explicit Ops handoff without re-list.
   */
  async runEscalationWatchdog() {
    if (!this.prisma.isConnected()) {
      return { scanned: 0, escalated: 0, relisted: 0 };
    }
    const settings = await this.prisma.platformSettings.upsert({
      where: { id: 'default' },
      create: { id: 'default' },
      update: {},
    });
    const slaMs =
      settings.marketplaceRelistSlaMs ||
      this.config.get('EXCEPTION_ESCALATION_MS', { infer: true });
    if (!slaMs || slaMs <= 0) {
      return { scanned: 0, escalated: 0, relisted: 0, disabled: true as const };
    }
    const cutoff = new Date(Date.now() - slaMs);
    const due = await this.prisma.tripException.findMany({
      where: {
        phase: TripExceptionPhase.PRE_TRIP,
        status: TripExceptionStatus.AWAITING_CARRIER,
        openedAt: { lte: cutoff },
      },
      select: { id: true },
      take: 25,
    });

    let relisted = 0;
    for (const item of due) {
      try {
        await this.releaseToMarketplace(
          {
            id: 'system',
            email: 'system@clox.local',
            role: AdminRole.SUPER_ADMIN,
            kind: 'admin',
            regionCodes: [],
            territoryCodes: [],
          },
          item.id,
          { note: 'Auto re-listed to marketplace: no carrier rescue within SLA' },
          { automatic: true },
        );
        relisted += 1;
      } catch {
        // continue other rows
      }
    }
    return { scanned: due.length, escalated: 0, relisted };
  }

  private async loadExceptionRow(id: string) {
    const row = await this.prisma.tripException.findUnique({
      where: { id },
      include: this.detailInclude(),
    });
    if (!row) throw new NotFoundException('Exception not found');
    return row;
  }

  private async loadOpenExceptionForCarrier(actorUserId: string, id: string) {
    const user = await this.prisma.user.findUnique({ where: { id: actorUserId } });
    if (!user?.companyId) throw new NotFoundException('Carrier company not found');
    const row = await this.loadExceptionRow(id);
    if (row.companyId !== user.companyId) throw new ForbiddenException();
    if (!OPEN_STATUSES.includes(row.status)) {
      throw new BadRequestException('Exception is already resolved');
    }
    return row;
  }

  private async loadNotifyTargets(row: {
    id: string;
    jobId: string;
    companyId: string;
    reportedByUserId: string;
    job?: { id: string; title: string | null } | null;
  }) {
    const [reporter, company, job] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: row.reportedByUserId },
        select: { email: true },
      }),
      this.prisma.company.findUnique({
        where: { id: row.companyId },
        select: {
          email: true,
          users: {
            where: {
              role: 'TRANSPORT_COMPANY',
              status: { in: [UserStatus.ACTIVE, UserStatus.PENDING] },
            },
            select: { email: true },
            take: 10,
          },
        },
      }),
      this.prisma.job.findUnique({
        where: { id: row.jobId },
        select: {
          id: true,
          title: true,
          receiverEmail: true,
          senderCompany: {
            select: {
              email: true,
              users: {
                where: { role: 'SENDER', status: UserStatus.ACTIVE },
                select: { email: true },
                take: 5,
              },
            },
          },
        },
      }),
    ]);

    const carrierEmails = [
      ...(company?.users.map((u) => u.email) ?? []),
      ...(company?.email ? [company.email] : []),
    ];
    const senderEmail =
      job?.receiverEmail ??
      job?.senderCompany.users[0]?.email ??
      job?.senderCompany.email ??
      null;

    return {
      driverEmail: reporter?.email ?? null,
      carrierEmails,
      senderEmail,
      jobTitle: job?.title ?? row.job?.title ?? '',
      jobId: job?.id ?? row.jobId,
    };
  }
}
