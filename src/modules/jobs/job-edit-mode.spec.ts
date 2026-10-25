import { AssignmentStatus, JobStatus, TripStatus } from '@prisma/client';
import { resolveJobEditMode } from './job-edit-mode';

describe('resolveJobEditMode', () => {
  it('allows FULL for DRAFT BIDDING and ASSIGNED+PENDING', () => {
    expect(resolveJobEditMode({ status: JobStatus.DRAFT }).mode).toBe('FULL');
    expect(resolveJobEditMode({ status: JobStatus.BIDDING }).mode).toBe('FULL');
    expect(
      resolveJobEditMode({
        status: JobStatus.ASSIGNED,
        assignment: { status: AssignmentStatus.PENDING },
      }).mode,
    ).toBe('FULL');
  });

  it('allows RECEIVER after LOCKED before AT_DROPOFF', () => {
    expect(
      resolveJobEditMode({
        status: JobStatus.ASSIGNED,
        assignment: { status: AssignmentStatus.LOCKED },
        trip: { status: TripStatus.IN_TRANSIT },
      }).mode,
    ).toBe('RECEIVER');
    expect(
      resolveJobEditMode({
        status: JobStatus.ASSIGNED,
        assignment: { status: AssignmentStatus.LOCKED },
        trip: null,
      }).mode,
    ).toBe('RECEIVER');
  });

  it('blocks edit at AT_DROPOFF and terminal jobs', () => {
    expect(
      resolveJobEditMode({
        status: JobStatus.ASSIGNED,
        assignment: { status: AssignmentStatus.LOCKED },
        trip: { status: TripStatus.AT_DROPOFF },
      }).mode,
    ).toBe('NONE');
    expect(resolveJobEditMode({ status: JobStatus.CANCELLED }).mode).toBe('NONE');
  });
});
