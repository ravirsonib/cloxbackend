import {
  AssignmentStatus,
  JobStatus,
  SurchargeKind,
  SurchargeStatus,
  TripStatus,
} from '@prisma/client';
import { DEFAULT_GEOFENCE_POLICY } from './geofence.util';
import { TripsService } from './trips.service';

describe('TripsService completeTripIfReady via geofence exit', () => {
  const audit = { recordPlatform: jest.fn() };
  const payments = {
    createSurcharge: jest.fn(),
    chargeSurcharge: jest.fn().mockResolvedValue({ id: 's-1', status: 'PAID' }),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new TripsService(
      prisma as never,
      audit as never,
      { get: () => undefined } as never,
      payments as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('on last-stop exit with all progress done, completes trip/job/assignment', async () => {
    const stopId = 'stop-1';
    const progress = {
      id: 'prog-1',
      jobStopId: stopId,
      insideCount: 2,
      currentlyInside: true,
      enteredAt: new Date('2026-01-01T12:00:00Z'),
      exitedAt: null as Date | null,
      freeWaitEndsAt: new Date('2026-01-01T12:30:00Z'),
      waitOverageMinutes: 0,
      arrivalRecorded: true,
    };
    const afterExit = {
      ...progress,
      insideCount: 2,
      currentlyInside: false,
      exitedAt: new Date('2026-01-01T13:00:00Z'),
    };

    // evaluateGeofence first load
    const tripLive = {
      id: 'trip-1',
      jobId: 'job-1',
      startedAt: new Date('2026-01-01T10:00:00Z'),
      status: TripStatus.IN_TRANSIT,
      job: {
        stops: [
          {
            id: stopId,
            lat: -37.8136,
            lng: 144.9631,
            stopType: 'DROPOFF',
            sequence: 0,
          },
        ],
      },
      stopProgress: [progress],
    };

    // completeTripIfReady load — allDone after exit (progress map still has old exitedAt=null
    // from progressByStop, but code uses remaining check then reloads trip).
    // Actually remaining uses progressByStop from BEFORE exit update — so for single stop,
    // remaining = stops.some where s.id === activeStop.id return false → remaining false → complete.
    // completeTripIfReady reloads trip with stopProgress that still has exitedAt null unless we
    // return updated progress in second findUnique.
    const tripForComplete = {
      id: 'trip-1',
      jobId: 'job-1',
      assignmentId: 'asg-1',
      startedAt: new Date('2026-01-01T10:00:00Z'),
      status: TripStatus.IN_TRANSIT,
      job: {
        stops: [{ id: stopId, lat: -37.8136, lng: 144.9631, stopType: 'DROPOFF', sequence: 0 }],
      },
      stopProgress: [afterExit],
      assignment: { id: 'asg-1' },
      surcharges: [],
    };

    const prisma = {
      policyVersion: {
        findFirst: jest.fn().mockResolvedValue({
          payload: { ...DEFAULT_GEOFENCE_POLICY, antiBounceSamples: 1 },
        }),
      },
      trip: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(tripLive)
          .mockResolvedValueOnce(tripForComplete),
      },
      tripStopProgress: {
        update: jest.fn().mockResolvedValue(afterExit),
      },
      surcharge: { count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          trip: { update: jest.fn() },
          job: { update: jest.fn() },
          assignment: { update: jest.fn() },
        };
        return fn(tx);
      }),
    };

    const service = makeService(prisma);
    // Far outside → exit (antiBounceSamples=1, currentlyInside true → outsideStreak=1 >= 1)
    const result = await service.evaluateGeofence(
      'trip-1',
      { lat: -33.8688, lng: 151.2093 },
      'user-driver',
    );

    expect(result).toMatchObject({
      activeStopId: stopId,
      inside: false,
    });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'trip.completed',
        entityId: 'trip-1',
      }),
    );
  });

  it('blocks COMPLETED when pending WAITING surcharge remains after charge fail', async () => {
    payments.chargeSurcharge.mockRejectedValueOnce(new Error('card declined'));
    const stopId = 'stop-1';
    const progress = {
      id: 'prog-1',
      jobStopId: stopId,
      insideCount: 1,
      currentlyInside: true,
      enteredAt: new Date(),
      exitedAt: null as Date | null,
      freeWaitEndsAt: new Date(),
      waitOverageMinutes: 5,
      arrivalRecorded: true,
    };
    const afterExit = { ...progress, currentlyInside: false, exitedAt: new Date() };
    const tripLive = {
      id: 'trip-1',
      jobId: 'job-1',
      startedAt: new Date(),
      status: TripStatus.IN_TRANSIT,
      job: {
        stops: [
          { id: stopId, lat: -37.8136, lng: 144.9631, stopType: 'DROPOFF', sequence: 0 },
        ],
      },
      stopProgress: [progress],
    };
    const tripForComplete = {
      id: 'trip-1',
      jobId: 'job-1',
      assignmentId: 'asg-1',
      startedAt: new Date(),
      status: TripStatus.IN_TRANSIT,
      job: {
        stops: [
          { id: stopId, lat: -37.8136, lng: 144.9631, stopType: 'DROPOFF', sequence: 0 },
        ],
      },
      stopProgress: [afterExit],
      assignment: { id: 'asg-1' },
      surcharges: [
        {
          id: 's-wait',
          kind: SurchargeKind.WAITING,
          status: SurchargeStatus.PENDING_PAYMENT,
        },
      ],
    };
    const prisma = {
      policyVersion: {
        findFirst: jest.fn().mockResolvedValue({
          payload: { ...DEFAULT_GEOFENCE_POLICY, antiBounceSamples: 1 },
        }),
      },
      trip: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(tripLive)
          .mockResolvedValueOnce(tripForComplete),
      },
      tripStopProgress: { update: jest.fn().mockResolvedValue(afterExit) },
      surcharge: { count: jest.fn().mockResolvedValue(1) },
      $transaction: jest.fn(),
    };
    const service = makeService(prisma);
    await service.evaluateGeofence('trip-1', { lat: -33.86, lng: 151.2 }, 'user-driver');
    expect(payments.chargeSurcharge).toHaveBeenCalledWith('s-wait');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
