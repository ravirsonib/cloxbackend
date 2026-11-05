import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  AssignmentStatus,
  DriverScheduleStatus,
  TripStatus,
  type PrismaClient,
} from '@prisma/client';

export const DEFAULT_JOB_DURATION_MINUTES = 120;
export const DEFAULT_TURNAROUND_BUFFER_MINUTES = 60;
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

  const bufferMinutes = options?.defaultBufferMinutes ?? DEFAULT_TURNAROUND_BUFFER_MINUTES;

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

export interface DriverAvailabilityCheckResult {
  isAvailable: boolean;
  code?: 'DRIVER_UNAVAILABLE_SCHEDULED' | 'DRIVER_BUSY_ASSIGNMENT_COLLISION';
  message?: string;
  conflictingScheduleEntryId?: string;
  conflictingJobId?: string;
  conflictingWindow?: {
    startAt: Date;
    endAt: Date;
  };
}

/**
 * Evaluates whether a driver is free from scheduled leaves/time-off and overlapping assignments
 * during a specified execution window.
 */
export async function checkDriverAvailabilityForWindow(
  prisma: Partial<Pick<PrismaClient, 'driverScheduleEntry' | 'assignment'>>,
  params: {
    driverId: string;
    windowStart: Date;
    windowEnd: Date;
    excludeJobId?: string;
  },
): Promise<DriverAvailabilityCheckResult> {
  const { driverId, windowStart, windowEnd, excludeJobId } = params;

  // 1. Check approved schedule entries (e.g. Annual Leave, Medical, Rostered Off)
  const conflictingSchedule = prisma.driverScheduleEntry?.findFirst
    ? await prisma.driverScheduleEntry.findFirst({
        where: {
          driverId,
          status: DriverScheduleStatus.APPROVED,
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

  // 2. Check overlapping committed assignments (LOCKED on unfinished trips)
  const conflictingAssignment = prisma.assignment?.findFirst
    ? await prisma.assignment.findFirst({
        where: {
          driverId,
          status: AssignmentStatus.LOCKED,
          jobId: excludeJobId ? { not: excludeJobId } : undefined,
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
              pickupAt: true,
              routeDurationMinutes: true,
              routeFatigueBreakMinutes: true,
            },
          },
        },
      })
    : null;

  if (conflictingAssignment?.job?.pickupAt) {
    const otherWindow = calculateJobExecutionWindow(conflictingAssignment.job);
    if (intervalsOverlap(windowStart, windowEnd, otherWindow.windowStart, otherWindow.windowEnd)) {
      return {
        isAvailable: false,
        code: 'DRIVER_BUSY_ASSIGNMENT_COLLISION',
        message: `Driver is already committed to Job #${conflictingAssignment.jobId.slice(0, 8)} during this time window`,
        conflictingJobId: conflictingAssignment.jobId,
        conflictingWindow: {
          startAt: otherWindow.windowStart,
          endAt: otherWindow.windowEnd,
        },
      };
    }
  }

  return { isAvailable: true };
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
