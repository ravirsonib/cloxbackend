import {
  AssignmentStatus,
  JobStatus,
  TripStatus,
} from '@prisma/client';

export type JobEditMode = 'FULL' | 'RECEIVER' | 'NONE';

export type JobEditability = {
  mode: JobEditMode;
  reason: string;
};

const FULL_JOB_STATUSES: JobStatus[] = [
  JobStatus.DRAFT,
  JobStatus.PUBLISHED,
  JobStatus.BIDDING,
];

const RECEIVER_TRIP_STATUSES: TripStatus[] = [
  TripStatus.PENDING_GATES,
  TripStatus.EN_ROUTE_PICKUP,
  TripStatus.AT_PICKUP,
  TripStatus.IN_TRANSIT,
];

const NO_EDIT_TRIP_STATUSES: TripStatus[] = [
  TripStatus.AT_DROPOFF,
  TripStatus.COMPLETED,
  TripStatus.CANCELLED,
  TripStatus.BREAKDOWN,
];

const TERMINAL_JOB_STATUSES: JobStatus[] = [
  JobStatus.COMPLETED,
  JobStatus.CANCELLED,
  JobStatus.EXPIRED,
];

/**
 * FULL until payment lock; RECEIVER after lock until AT_DROPOFF; NONE after.
 */
export function resolveJobEditMode(job: {
  status: JobStatus;
  assignment?: { status: AssignmentStatus } | null;
  trip?: { status: TripStatus } | null;
}): JobEditability {
  if (TERMINAL_JOB_STATUSES.includes(job.status)) {
    return {
      mode: 'NONE',
      reason: 'Job is closed and can no longer be edited',
    };
  }

  if (FULL_JOB_STATUSES.includes(job.status)) {
    return {
      mode: 'FULL',
      reason: 'Job can be fully edited before accept and payment',
    };
  }

  if (job.status === JobStatus.ASSIGNED) {
    const assignment = job.assignment ?? null;
    if (!assignment || assignment.status === AssignmentStatus.PENDING) {
      return {
        mode: 'FULL',
        reason: 'Job can be fully edited until payment is confirmed',
      };
    }
    if (assignment.status === AssignmentStatus.LOCKED) {
      const tripStatus = job.trip?.status ?? null;
      if (!tripStatus || RECEIVER_TRIP_STATUSES.includes(tripStatus)) {
        return {
          mode: 'RECEIVER',
          reason:
            'Only receiver details can be edited until the driver arrives at drop-off',
        };
      }
      if (NO_EDIT_TRIP_STATUSES.includes(tripStatus)) {
        return {
          mode: 'NONE',
          reason: 'Receiver details cannot be edited once the driver is at drop-off',
        };
      }
    }
  }

  if (job.status === JobStatus.IN_TRANSIT) {
    const tripStatus = job.trip?.status ?? null;
    if (!tripStatus || RECEIVER_TRIP_STATUSES.includes(tripStatus)) {
      return {
        mode: 'RECEIVER',
        reason:
          'Only receiver details can be edited until the driver arrives at drop-off',
      };
    }
    return {
      mode: 'NONE',
      reason: 'Receiver details cannot be edited once the driver is at drop-off',
    };
  }

  return {
    mode: 'NONE',
    reason: 'Job cannot be edited in its current state',
  };
}
