import { TripStatus } from '@prisma/client';
import { TripsService } from './trips.service';

describe('TripsService completeTripIfReady early-gate leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const payments = {
    createSurcharge: jest.fn(),
    chargeSurcharge: jest.fn(),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new TripsService(
      prisma as never,
      audit as never,
      { get: () => undefined } as never,
      payments as never,
    );
  }

  /** Trigger completeTripIfReady via no-coords active stop path. */
  function prismaForCompleteLoad(tripForComplete: Record<string, unknown>) {
    return {
      policyVersion: { findFirst: jest.fn().mockResolvedValue(null) },
      trip: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'trip-1',
            jobId: 'job-1',
            startedAt: new Date(),
            status: TripStatus.IN_TRANSIT,
            job: {
              stops: [
                {
                  id: 's1',
                  lat: null,
                  lng: null,
                  stopType: 'PICKUP',
                  sequence: 0,
                },
              ],
            },
            stopProgress: [],
          })
          .mockResolvedValueOnce(tripForComplete),
      },
      surcharge: { count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('no-ops when trip already COMPLETED', async () => {
    const prisma = prismaForCompleteLoad({
      id: 'trip-1',
      jobId: 'job-1',
      assignmentId: 'asg-1',
      startedAt: new Date(),
      status: TripStatus.COMPLETED,
      job: { stops: [{ id: 's1' }] },
      stopProgress: [
        {
          jobStopId: 's1',
          arrivalRecorded: true,
          exitedAt: new Date(),
        },
      ],
      assignment: { id: 'asg-1' },
      surcharges: [],
    });
    await makeService(prisma).evaluateGeofence('trip-1', {
      lat: -37.8,
      lng: 144.9,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.recordPlatform).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'trip.completed' }),
    );
  });

  it('no-ops when trip has no stops', async () => {
    const prisma = prismaForCompleteLoad({
      id: 'trip-1',
      jobId: 'job-1',
      assignmentId: null,
      startedAt: new Date(),
      status: TripStatus.IN_TRANSIT,
      job: { stops: [] },
      stopProgress: [],
      assignment: null,
      surcharges: [],
    });
    await makeService(prisma).evaluateGeofence('trip-1', {
      lat: -37.8,
      lng: 144.9,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('no-ops when not all stops are arrived+exited', async () => {
    const prisma = prismaForCompleteLoad({
      id: 'trip-1',
      jobId: 'job-1',
      assignmentId: 'asg-1',
      startedAt: new Date(),
      status: TripStatus.IN_TRANSIT,
      job: {
        stops: [
          { id: 's1' },
          { id: 's2' },
        ],
      },
      stopProgress: [
        {
          jobStopId: 's1',
          arrivalRecorded: true,
          exitedAt: new Date(),
        },
        {
          jobStopId: 's2',
          arrivalRecorded: true,
          exitedAt: null,
        },
      ],
      assignment: { id: 'asg-1' },
      surcharges: [],
    });
    await makeService(prisma).evaluateGeofence('trip-1', {
      lat: -37.8,
      lng: 144.9,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(payments.chargeSurcharge).not.toHaveBeenCalled();
  });
});
