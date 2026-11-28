import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  AssignmentStatus,
  DriverAvailabilityType,
  DriverScheduleStatus,
  JobStatus,
  ProposalStatus,
  TripStatus,
  type PrismaClient,
} from '@prisma/client';

export const DEFAULT_JOB_DURATION_MINUTES = 120;
export const DEFAULT_TURNAROUND_BUFFER_MINUTES = 60;
export const LONG_HAUL_THRESHOLD_MINUTES = 420; // > 7 hours driving triggers NHVR stationary rest
export const LONG_HAUL_REST_BUFFER_MINUTES = 420; // 7 hours NHVR mandatory stationary rest
export const FATIGUE_THRESHOLD_MINUTES = 315; // 5.25 hours per NHVR standard
export const FATIGUE_BREAK_MINUTES = 15;

export interface JobWindowInput {
  pickupAt?: Date | null;
  routeDurationMinutes?: number | null;
  routeFatigueBreakMinutes?: number | null;
}

export interface JobExecutionWindow {
  windowStart: Date;
  windowEnd: Date;
  durationMinutes: number;
  fatigueBreakMinutes: number;
  bufferMinutes: number;
}

/**
 * Calculates the full expected operational execution window for a job,
 * including planned transit time, mandatory NHVR fatigue breaks, and turn-around buffer.
 */
export function calculateJobExecutionWindow(
  job: JobWindowInput,
  options?: {
    defaultBufferMinutes?: number;
    nowOverride?: Date;
  },
): JobExecutionWindow {
  const windowStart = job.pickupAt ? new Date(job.pickupAt) : options?.nowOverride ?? new Date();

  const durationMinutes =
    typeof job.routeDurationMinutes === 'number' && job.routeDurationMinutes > 0
      ? job.routeDurationMinutes
      : DEFAULT_JOB_DURATION_MINUTES;

  const fatigueBreakMinutes =
    typeof job.routeFatigueBreakMinutes === 'number' && job.routeFatigueBreakMinutes >= 0
      ? job.routeFatigueBreakMinutes
      : durationMinutes > FATIGUE_THRESHOLD_MINUTES
        ? FATIGUE_BREAK_MINUTES
        : 0;

  const bufferMinutes =
    options?.defaultBufferMinutes ??
    (durationMinutes > LONG_HAUL_THRESHOLD_MINUTES
      ? LONG_HAUL_REST_BUFFER_MINUTES
      : DEFAULT_TURNAROUND_BUFFER_MINUTES);

  const totalMinutes = durationMinutes + fatigueBreakMinutes + bufferMinutes;
  const windowEnd = new Date(windowStart.getTime() + totalMinutes * 60 * 1000);

  return {
    windowStart,
    windowEnd,
    durationMinutes,
    fatigueBreakMinutes,
    bufferMinutes,
  };
}

/**
 * Checks if two time intervals [startA, endA] and [startB, endB] intersect.
 * Overlap condition: max(startA, startB) < min(endA, endB)
 */
export function intervalsOverlap(startA: Date, endA: Date, startB: Date, endB: Date): boolean {
  return Math.max(startA.getTime(), startB.getTime()) < Math.min(endA.getTime(), endB.getTime());
}

export interface DriverPendingLeaveWarning {
  scheduleEntryId: string;
  type: string;
  startAt: Date;
  endAt: Date;
  message: string;
}

export interface DriverAvailabilityCheckResult {
  isAvailable: boolean;
  code?: 'DRIVER_UNAVAILABLE_SCHEDULED' | 'DRIVER_BUSY_ASSIGNMENT_COLLISION' | 'DRIVER_BID_COMMITTED';
  message?: string;
  conflictingScheduleEntryId?: string;
  conflictingJobId?: string;
  conflictingWindow?: {
    startAt: Date;
    endAt: Date;
  };
  pendingLeaveWarning?: DriverPendingLeaveWarning | null;
}

/**
 * Evaluates whether a driver is free from scheduled leaves/time-off and overlapping assignments
 * during a specified execution window.
 */
export async function checkDriverAvailabilityForWindow(
  prisma: Partial<Pick<PrismaClient, 'driverScheduleEntry' | 'assignment' | 'proposal'>>,
  params: {
    driverId: string;
    windowStart: Date;
    windowEnd: Date;
    excludeJobId?: string;
    checkOpenBids?: boolean;
  },
): Promise<DriverAvailabilityCheckResult> {
  const { driverId, windowStart, windowEnd, excludeJobId, checkOpenBids = false } = params;

  // 1. Check approved leave/unavailable schedule entries.
  // OVERTIME_AVAILABLE = extra capacity — must NOT block bidding.
  const conflictingSchedule = prisma.driverScheduleEntry?.findFirst
    ? await prisma.driverScheduleEntry.findFirst({
        where: {
          driverId,
          status: DriverScheduleStatus.APPROVED,
          type: { not: DriverAvailabilityType.OVERTIME_AVAILABLE },
          startAt: { lt: windowEnd },
          endAt: { gt: windowStart },
        },
        select: {
          id: true,
          type: true,
          startAt: true,
          endAt: true,
          reason: true,
        },
      })
    : null;

  if (conflictingSchedule) {
    const typeLabel = conflictingSchedule.type.replace(/_/g, ' ').toLowerCase();
    return {
      isAvailable: false,
      code: 'DRIVER_UNAVAILABLE_SCHEDULED',
      message: `Driver has scheduled ${typeLabel} between ${conflictingSchedule.startAt.toISOString()} and ${conflictingSchedule.endAt.toISOString()}`,
      conflictingScheduleEntryId: conflictingSchedule.id,
      conflictingWindow: {
        startAt: conflictingSchedule.startAt,
        endAt: conflictingSchedule.endAt,
      },
    };
  }

  // 2. Check ALL overlapping committed assignments (PENDING or LOCKED on unfinished trips).
  // Uses findMany (with findFirst fallback for legacy unit test mocks) so multiple future jobs are never missed.
  const assignmentWhere = {
    driverId,
    jobId: excludeJobId ? { not: excludeJobId } : undefined,
    OR: [
      { status: AssignmentStatus.PENDING },
      {
        status: AssignmentStatus.LOCKED,
        trip: {
          status: { notIn: [TripStatus.COMPLETED, TripStatus.CANCELLED] },
        },
      },
    ],
  };
  const assignmentSelect = {
    id: true,
    jobId: true,
    job: {
      select: {
        id: true,
        pickupAt: true,
        routeDurationMinutes: true,
        routeFatigueBreakMinutes: true,
      },
    },
  };
  const activeAssignments = prisma.assignment?.findMany
    ? await prisma.assignment.findMany({ where: assignmentWhere, select: assignmentSelect })
    : prisma.assignment?.findFirst
      ? [await prisma.assignment.findFirst({ where: assignmentWhere, select: assignmentSelect })].filter(
          (x): x is NonNullable<typeof x> => Boolean(x),
        )
      : [];

  for (const item of activeAssignments) {
    if (!item.job?.pickupAt) continue;
    const otherWindow = calculateJobExecutionWindow(item.job);
    if (intervalsOverlap(windowStart, windowEnd, otherWindow.windowStart, otherWindow.windowEnd)) {
      return {
        isAvailable: false,
        code: 'DRIVER_BUSY_ASSIGNMENT_COLLISION',
        message: `Driver is already committed to Job #${item.jobId.slice(0, 8)} during this time window`,
        conflictingJobId: item.jobId,
        conflictingWindow: {
          startAt: otherWindow.windowStart,
          endAt: otherWindow.windowEnd,
        },
      };
    }
  }

  // 3. Optionally check overlapping open SUBMITTED bids (for Market Board pre-flight).
  if (checkOpenBids && prisma.proposal?.findMany) {
    const openBids = await prisma.proposal.findMany({
      where: {
        driverId,
        status: ProposalStatus.SUBMITTED,
        ...(excludeJobId ? { jobId: { not: excludeJobId } } : {}),
        job: { status: { in: [JobStatus.PUBLISHED, JobStatus.BIDDING] } },
      },
      select: {
        id: true,
        jobId: true,
        job: {
          select: {
            id: true,
            pickupAt: true,
            routeDurationMinutes: true,
            routeFatigueBreakMinutes: true,
          },
        },
      },
    });
    for (const bid of openBids) {
      if (!bid.job?.pickupAt) {
        return {
          isAvailable: false,
          code: 'DRIVER_BID_COMMITTED',
          message: `Driver already has an open bid on Job #${bid.jobId.slice(0, 8)}`,
          conflictingJobId: bid.jobId,
        };
      }
      const otherWindow = calculateJobExecutionWindow(bid.job);
      if (intervalsOverlap(windowStart, windowEnd, otherWindow.windowStart, otherWindow.windowEnd)) {
        return {
          isAvailable: false,
          code: 'DRIVER_BID_COMMITTED',
          message: `Driver already has an open bid on Job #${bid.jobId.slice(0, 8)} during this time window`,
          conflictingJobId: bid.jobId,
          conflictingWindow: {
            startAt: otherWindow.windowStart,
            endAt: otherWindow.windowEnd,
          },
        };
      }
    }
  }

  // 4. Soft warning (non-blocking) if driver has a PENDING leave request overlapping this window.
  const pendingLeave = prisma.driverScheduleEntry?.findFirst
    ? await prisma.driverScheduleEntry.findFirst({
        where: {
          driverId,
          status: DriverScheduleStatus.PENDING,
          type: { not: DriverAvailabilityType.OVERTIME_AVAILABLE },
          startAt: { lt: windowEnd },
          endAt: { gt: windowStart },
        },
        select: {
          id: true,
          type: true,
          startAt: true,
          endAt: true,
        },
      })
    : null;

  const pendingLeaveWarning: DriverPendingLeaveWarning | null = pendingLeave
    ? {
        scheduleEntryId: pendingLeave.id,
        type: pendingLeave.type,
        startAt: pendingLeave.startAt,
        endAt: pendingLeave.endAt,
        message: `Driver has a pending ${pendingLeave.type.replace(/_/g, ' ').toLowerCase()} request overlapping this job window`,
      }
    : null;

  return { isAvailable: true, pendingLeaveWarning };
}

/**
 * Asserts that a driver is available for the given execution window; throws appropriate HTTP exception if not.
 */
export async function assertDriverAvailabilityForWindow(
  prisma: Partial<Pick<PrismaClient, 'driverScheduleEntry' | 'assignment'>>,
  params: {
    driverId: string;
    windowStart: Date;
    windowEnd: Date;
    excludeJobId?: string;
  },
): Promise<void> {
  const check = await checkDriverAvailabilityForWindow(prisma, params);
  if (!check.isAvailable) {
    if (check.code === 'DRIVER_BUSY_ASSIGNMENT_COLLISION') {
      throw new ConflictException({
        message: check.message,
        code: check.code,
        jobId: check.conflictingJobId,
        conflictingWindow: check.conflictingWindow,
      });
    }
    throw new BadRequestException({
      message: check.message,
      code: check.code,
      scheduleEntryId: check.conflictingScheduleEntryId,
      conflictingWindow: check.conflictingWindow,
    });
  }
}

const busyAssignmentWhere = (excludeAssignmentId?: string) => ({
  ...(excludeAssignmentId ? { id: { not: excludeAssignmentId } } : {}),
  OR: [
    { status: AssignmentStatus.PENDING },
    {
      status: AssignmentStatus.LOCKED,
      trip: {
        status: { notIn: [TripStatus.COMPLETED, TripStatus.CANCELLED] },
      },
    },
  ],
});

function overlapsCandidateJob(
  windowStart: Date | undefined,
  windowEnd: Date | undefined,
  job: JobWindowInput | null | undefined,
): boolean {
  if (!windowStart || !windowEnd) return true;
  if (!job?.pickupAt) return true;
  const other = calculateJobExecutionWindow(job);
  return intervalsOverlap(windowStart, windowEnd, other.windowStart, other.windowEnd);
}

/**
 * Shared choke-point: vehicle/driver must not be PENDING/LOCKED-busy (or open-bid committed)
 * on another job whose execution window overlaps [windowStart, windowEnd].
 * When windowStart/windowEnd are omitted, falls back to global busy check.
 */
export async function assertCrewNotBusyElsewhere(
  prisma: Partial<Pick<PrismaClient, 'assignment' | 'proposal'>>,
  params: {
    vehicleId: string;
    driverId: string;
    /** Current job (open bids on this job are allowed). */
    excludeJobId?: string;
    /** Current assignment being reassigned (must not count as busy). */
    excludeAssignmentId?: string;
    /** When false, skip open-bid commit checks (default true). */
    checkOpenBids?: boolean;
    /** Target job execution window; allows non-overlapping future bookings. */
    windowStart?: Date;
    windowEnd?: Date;
  },
): Promise<void> {
  const {
    vehicleId,
    driverId,
    excludeJobId,
    excludeAssignmentId,
    checkOpenBids = true,
    windowStart,
    windowEnd,
  } = params;

  const assignmentSelect = {
    id: true,
    jobId: true,
    status: true,
    job: {
      select: {
        pickupAt: true,
        routeDurationMinutes: true,
        routeFatigueBreakMinutes: true,
      },
    },
  };

  const vehicleWhere = {
    vehicleId,
    ...busyAssignmentWhere(excludeAssignmentId),
  };
  const vehicleAssignments = prisma.assignment?.findMany
    ? await prisma.assignment.findMany({ where: vehicleWhere, select: assignmentSelect })
    : prisma.assignment?.findFirst
      ? [await prisma.assignment.findFirst({ where: vehicleWhere, select: assignmentSelect })].filter(
          (x): x is NonNullable<typeof x> => Boolean(x),
        )
      : [];
  const vehicleBusy = vehicleAssignments.find((a) =>
    overlapsCandidateJob(windowStart, windowEnd, a.job),
  );
  if (vehicleBusy) {
    throw new ConflictException({
      message: 'Vehicle is already assigned or pending payment on another job in this time window',
      code: 'VEHICLE_BUSY',
      jobId: vehicleBusy.jobId,
    });
  }

  const driverWhere = {
    driverId,
    ...busyAssignmentWhere(excludeAssignmentId),
  };
  const driverAssignments = prisma.assignment?.findMany
    ? await prisma.assignment.findMany({ where: driverWhere, select: assignmentSelect })
    : prisma.assignment?.findFirst
      ? [await prisma.assignment.findFirst({ where: driverWhere, select: assignmentSelect })].filter(
          (x): x is NonNullable<typeof x> => Boolean(x),
        )
      : [];
  const driverBusy = driverAssignments.find((a) =>
    overlapsCandidateJob(windowStart, windowEnd, a.job),
  );
  if (driverBusy) {
    throw new ConflictException({
      message: 'Driver is already assigned or pending payment on another job in this time window',
      code: 'DRIVER_BUSY',
      jobId: driverBusy.jobId,
    });
  }

  if (!checkOpenBids) return;

  const proposalSelect = {
    id: true,
    jobId: true,
    job: {
      select: {
        pickupAt: true,
        routeDurationMinutes: true,
        routeFatigueBreakMinutes: true,
      },
    },
  };

  const vehicleBidWhere = {
    vehicleId,
    status: ProposalStatus.SUBMITTED,
    ...(excludeJobId ? { jobId: { not: excludeJobId } } : {}),
    job: { status: { in: [JobStatus.PUBLISHED, JobStatus.BIDDING] } },
  };
  const vehicleOpenBids = prisma.proposal?.findMany
    ? await prisma.proposal.findMany({ where: vehicleBidWhere, select: proposalSelect })
    : prisma.proposal?.findFirst
      ? [await prisma.proposal.findFirst({ where: vehicleBidWhere, select: proposalSelect })].filter(
          (x): x is NonNullable<typeof x> => Boolean(x),
        )
      : [];
  const vehicleOpenBid = vehicleOpenBids.find((b) =>
    overlapsCandidateJob(windowStart, windowEnd, b.job),
  );
  if (vehicleOpenBid) {
    throw new ConflictException({
      message:
        'Vehicle already has an open bid on another job in this time window — accept/withdraw that bid first',
      code: 'VEHICLE_BID_COMMITTED',
      jobId: vehicleOpenBid.jobId,
      proposalId: vehicleOpenBid.id,
    });
  }

  const driverBidWhere = {
    driverId,
    status: ProposalStatus.SUBMITTED,
    ...(excludeJobId ? { jobId: { not: excludeJobId } } : {}),
    job: { status: { in: [JobStatus.PUBLISHED, JobStatus.BIDDING] } },
  };
  const driverOpenBids = prisma.proposal?.findMany
    ? await prisma.proposal.findMany({ where: driverBidWhere, select: proposalSelect })
    : prisma.proposal?.findFirst
      ? [await prisma.proposal.findFirst({ where: driverBidWhere, select: proposalSelect })].filter(
          (x): x is NonNullable<typeof x> => Boolean(x),
        )
      : [];
  const driverOpenBid = driverOpenBids.find((b) =>
    overlapsCandidateJob(windowStart, windowEnd, b.job),
  );
  if (driverOpenBid) {
    throw new ConflictException({
      message:
        'Driver already has an open bid on another job in this time window — accept/withdraw that bid first',
      code: 'DRIVER_BID_COMMITTED',
      jobId: driverOpenBid.jobId,
      proposalId: driverOpenBid.id,
    });
  }
}
