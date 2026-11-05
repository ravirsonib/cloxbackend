import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AssignmentStatus,
  DriverAvailabilityType,
  DriverScheduleStatus,
  TripStatus,
  UserStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import {
  AuditAction,
  type CarrierScheduleCreateInput,
  type DriverScheduleRequestInput,
  type DriverScheduleReviewInput,
} from '../../shared/types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  calculateJobExecutionWindow,
  intervalsOverlap,
} from '../matching/driver-schedule.util';

@Injectable()
export class DriverScheduleService {
  private readonly logger = new Logger(DriverScheduleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  private async requireDriver(principal: AuthenticatedPrincipal) {
    if (principal.kind !== 'user' || principal.role !== 'DRIVER') {
      throw new ForbiddenException('Driver account required');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      include: { driver: true },
    });
    if (!user || user.status !== UserStatus.ACTIVE || !user.driver) {
      throw new ForbiddenException('Active driver profile required');
    }
    return user;
  }

  private async requireCarrierCompany(principal: AuthenticatedPrincipal) {
    if (principal.kind !== 'user' || principal.role !== 'TRANSPORT_COMPANY') {
      throw new ForbiddenException('Transport company account required');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      include: { company: true },
    });
    if (!user?.companyId || !user.company) {
      throw new ForbiddenException('Transport company profile required');
    }
    return user;
  }

  // ---------------------------------------------------------------------------
  // Driver Self-Service APIs
  // ---------------------------------------------------------------------------

  async getMySchedule(
    principal: AuthenticatedPrincipal,
    query?: { from?: string; to?: string },
  ) {
    this.ensureDatabase();
    const user = await this.requireDriver(principal);
    const driverId = user.driver!.id;

    const fromDate = query?.from ? new Date(query.from) : new Date(Date.now() - 30 * 86400000);
    const toDate = query?.to ? new Date(query.to) : new Date(Date.now() + 90 * 86400000);

    const entries = await this.prisma.driverScheduleEntry.findMany({
      where: {
        driverId,
        startAt: { lt: toDate },
        endAt: { gt: fromDate },
      },
      orderBy: { startAt: 'asc' },
    });

    return entries;
  }

  async requestTimeOff(
    principal: AuthenticatedPrincipal,
    input: DriverScheduleRequestInput,
  ) {
    this.ensureDatabase();
    const user = await this.requireDriver(principal);
    const driver = user.driver!;

    const startAt = new Date(input.startAt);
    const endAt = new Date(input.endAt);

    if (isNaN(startAt.getTime()) || isNaN(endAt.getTime()) || startAt >= endAt) {
      throw new BadRequestException('startAt must be earlier than endAt');
    }

    if (!driver.companyId) {
      throw new BadRequestException('Driver must be linked to a transport company');
    }

    // Check if driver has an existing locked assignment that overlaps this requested window
    const lockedAssignments = await this.prisma.assignment.findMany({
      where: {
        driverId: driver.id,
        status: AssignmentStatus.LOCKED,
        trip: {
          status: { notIn: [TripStatus.COMPLETED, TripStatus.CANCELLED] },
        },
        job: {
          pickupAt: { not: null },
        },
      },
      select: {
        id: true,
        jobId: true,
        job: {
          select: {
            id: true,
            title: true,
            pickupAt: true,
            routeDurationMinutes: true,
            routeFatigueBreakMinutes: true,
          },
        },
      },
    });

    for (const asg of lockedAssignments) {
      if (asg.job.pickupAt) {
        const jobWindow = calculateJobExecutionWindow(asg.job);
        if (intervalsOverlap(startAt, endAt, jobWindow.windowStart, jobWindow.windowEnd)) {
          throw new ConflictException({
            message: `Cannot request time-off overlapping an already confirmed trip assignment on "${asg.job.title ?? asg.job.id}". Please contact your carrier dispatcher to reassign the trip first.`,
            code: 'ACTIVE_ASSIGNMENT_COLLISION',
            conflictingJobId: asg.jobId,
            conflictingWindow: {
              startAt: jobWindow.windowStart,
              endAt: jobWindow.windowEnd,
            },
          });
        }
      }
    }

    const created = await this.prisma.driverScheduleEntry.create({
      data: {
        driverId: driver.id,
        companyId: driver.companyId,
        type: input.type as DriverAvailabilityType,
        status: DriverScheduleStatus.PENDING,
        startAt,
        endAt,
        isAllDay: input.isAllDay ?? false,
        reason: input.reason?.trim() || null,
        notes: input.notes?.trim() || null,
        createdById: user.id,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.DRIVER_SCHEDULE_CREATED,
      actorUserId: user.id,
      entityType: 'DriverScheduleEntry',
      entityId: created.id,
      metadata: {
        driverId: driver.id,
        type: created.type,
        status: created.status,
        startAt: created.startAt.toISOString(),
        endAt: created.endAt.toISOString(),
      },
    });

    return created;
  }

  async cancelTimeOff(principal: AuthenticatedPrincipal, id: string) {
    this.ensureDatabase();
    const user = await this.requireDriver(principal);
    const driverId = user.driver!.id;

    const entry = await this.prisma.driverScheduleEntry.findFirst({
      where: { id, driverId },
    });
    if (!entry) throw new NotFoundException('Schedule entry not found');

    if (entry.status === DriverScheduleStatus.CANCELLED) {
      return entry;
    }

    const updated = await this.prisma.driverScheduleEntry.update({
      where: { id },
      data: { status: DriverScheduleStatus.CANCELLED },
    });

    await this.audit.recordPlatform({
      action: AuditAction.DRIVER_SCHEDULE_CANCELLED,
      actorUserId: user.id,
      entityType: 'DriverScheduleEntry',
      entityId: entry.id,
      metadata: {
        driverId,
        previousStatus: entry.status,
      },
    });

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Carrier Fleet Management APIs
  // ---------------------------------------------------------------------------

  async getCarrierFleetSchedule(
    principal: AuthenticatedPrincipal,
    query?: { from?: string; to?: string; driverId?: string },
  ) {
    this.ensureDatabase();
    const user = await this.requireCarrierCompany(principal);
    const companyId = user.companyId!;

    const fromDate = query?.from ? new Date(query.from) : new Date(Date.now() - 30 * 86400000);
    const toDate = query?.to ? new Date(query.to) : new Date(Date.now() + 90 * 86400000);

    const entries = await this.prisma.driverScheduleEntry.findMany({
      where: {
        companyId,
        driverId: query?.driverId ? query.driverId : undefined,
        startAt: { lt: toDate },
        endAt: { gt: fromDate },
      },
      include: {
        driver: {
          select: {
            id: true,
            licenceClass: true,
            user: { select: { name: true, email: true } },
          },
        },
      },
      orderBy: { startAt: 'asc' },
    });

    return entries;
  }

  async createDriverScheduleByCarrier(
    principal: AuthenticatedPrincipal,
    input: CarrierScheduleCreateInput,
  ) {
    this.ensureDatabase();
    const user = await this.requireCarrierCompany(principal);
    const companyId = user.companyId!;

    const driver = await this.prisma.driver.findFirst({
      where: { id: input.driverId, companyId },
    });
    if (!driver) throw new NotFoundException('Driver not found in your fleet');

    const startAt = new Date(input.startAt);
    const endAt = new Date(input.endAt);

    if (isNaN(startAt.getTime()) || isNaN(endAt.getTime()) || startAt >= endAt) {
      throw new BadRequestException('startAt must be earlier than endAt');
    }

    const created = await this.prisma.driverScheduleEntry.create({
      data: {
        driverId: driver.id,
        companyId,
        type: input.type as DriverAvailabilityType,
        status: DriverScheduleStatus.APPROVED, // Direct carrier entries are auto-approved
        startAt,
        endAt,
        isAllDay: input.isAllDay ?? false,
        reason: input.reason?.trim() || null,
        notes: input.notes?.trim() || null,
        createdById: user.id,
        reviewedById: user.id,
        reviewedAt: new Date(),
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.DRIVER_SCHEDULE_CREATED,
      actorUserId: user.id,
      entityType: 'DriverScheduleEntry',
      entityId: created.id,
      metadata: {
        carrierCompanyId: companyId,
        driverId: driver.id,
        type: created.type,
        status: created.status,
      },
    });

    return created;
  }

  async reviewDriverSchedule(
    principal: AuthenticatedPrincipal,
    id: string,
    input: DriverScheduleReviewInput,
  ) {
    this.ensureDatabase();
    const user = await this.requireCarrierCompany(principal);
    const companyId = user.companyId!;

    const entry = await this.prisma.driverScheduleEntry.findFirst({
      where: { id, companyId },
    });
    if (!entry) throw new NotFoundException('Schedule entry not found in your company');

    if (input.status === DriverScheduleStatus.REJECTED && !input.rejectionReason?.trim()) {
      throw new BadRequestException('rejectionReason is required when rejecting time-off');
    }

    const updated = await this.prisma.driverScheduleEntry.update({
      where: { id },
      data: {
        status: input.status,
        reviewedById: user.id,
        reviewedAt: new Date(),
        rejectionReason: input.rejectionReason?.trim() || null,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.DRIVER_SCHEDULE_REVIEWED,
      actorUserId: user.id,
      entityType: 'DriverScheduleEntry',
      entityId: entry.id,
      metadata: {
        previousStatus: entry.status,
        newStatus: updated.status,
        rejectionReason: updated.rejectionReason,
      },
    });

    return updated;
  }
}
