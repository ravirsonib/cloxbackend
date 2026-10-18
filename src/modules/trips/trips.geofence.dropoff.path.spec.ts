import { TripStatus } from '@prisma/client';
import { DEFAULT_GEOFENCE_POLICY } from './geofence.util';
import { TripsService } from './trips.service';

describe('TripsService geofence DROPOFF / remaining-stop leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const payments = {
    createSurcharge: jest.fn(),
    chargePendingSurchargesForTrip: jest.fn(),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new TripsService(
      prisma as never,
      audit as never,
      { get: () => undefined } as never,
      payments as never,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('selects dwelling stop (entered, not exited) as active even after arrivalRecorded', async () => {
    const dwelling = {
      id: 'prog-2',
      jobStopId: 'stop-2',
      insideCount: 2,
      currentlyInside: true,
      enteredAt: new Date('2026-01-01T12:00:00Z'),
      exitedAt: null as Date | null,
      freeWaitEndsAt: new Date('2026-01-01T12:30:00Z'),
      waitOverageMinutes: 0,
      arrivalRecorded: true,
    };
    const prisma = {
      policyVersion: {
        findFirst: jest.fn().mockResolvedValue({
          payload: { ...DEFAULT_GEOFENCE_POLICY, antiBounceSamples: 2 },
        }),
      },
      trip: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'trip-1',
          jobId: 'job-1',
          startedAt: new Date('2026-01-01T10:00:00Z'),
          status: TripStatus.IN_TRANSIT,
          job: {
            stops: [
              {
                id: 'stop-1',
                lat: -37.8,
                lng: 144.9,
                stopType: 'PICKUP',
                sequence: 0,
              },
              {
                id: 'stop-2',
                lat: -37.8136,
                lng: 144.9631,
                stopType: 'DROPOFF',
                sequence: 1,
              },
            ],
          },
          stopProgress: [
            {
              id: 'prog-1',
              jobStopId: 'stop-1',
              insideCount: 2,
              currentlyInside: false,
              enteredAt: new Date('2026-01-01T11:00:00Z'),
              exitedAt: new Date('2026-01-01T11:30:00Z'),
              freeWaitEndsAt: null,
              waitOverageMinutes: 0,
              arrivalRecorded: true,
            },
            dwelling,
          ],
        }),
      },
      tripStopProgress: {
        update: jest.fn().mockResolvedValue({
          ...dwelling,
          insideCount: 3,
          currentlyInside: true,
        }),
      },
    };
    const service = makeService(prisma);
    const result = await service.evaluateGeofence(
      'trip-1',
      { lat: -37.8136, lng: 144.9631 },
      'user-driver',
    );
    expect(result).toMatchObject({
      activeStopId: 'stop-2',
      inside: true,
      stopType: 'DROPOFF',
    });
  });

  it('on DROPOFF enter with started trip sets AT_DROPOFF', async () => {
    const progress = {
      id: 'prog-1',
      jobStopId: 'stop-d',
      insideCount: 1,
      currentlyInside: true,
      enteredAt: null as Date | null,
      exitedAt: null,
      freeWaitEndsAt: null as Date | null,
      waitOverageMinutes: 0,
      arrivalRecorded: false,
    };
    const updated = {
      ...progress,
      insideCount: 2,
      enteredAt: new Date('2026-01-01T12:00:00Z'),
      waitStartedAt: new Date('2026-01-01T12:00:00Z'),
      freeWaitEndsAt: new Date('2026-01-01T12:30:00Z'),
      arrivalRecorded: true,
    };
    const prisma = {
      policyVersion: {
        findFirst: jest.fn().mockResolvedValue({
          payload: { ...DEFAULT_GEOFENCE_POLICY, antiBounceSamples: 2 },
        }),
      },
      trip: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'trip-1',
          jobId: 'job-1',
          startedAt: new Date('2026-01-01T10:00:00Z'),
          status: TripStatus.IN_TRANSIT,
          job: {
            stops: [
              {
                id: 'stop-d',
                lat: -37.8136,
                lng: 144.9631,
                stopType: 'DROPOFF',
                sequence: 0,
              },
            ],
          },
          stopProgress: [progress],
        }),
        update: jest.fn(),
      },
      tripStopProgress: {
        update: jest.fn().mockResolvedValue(updated),
      },
    };
    const service = makeService(prisma);
    const result = await service.evaluateGeofence(
      'trip-1',
      { lat: -37.8136, lng: 144.9631 },
      'user-driver',
    );
    expect(result).toMatchObject({
      activeStopId: 'stop-d',
      entered: true,
      stopType: 'DROPOFF',
    });
    expect(prisma.trip.update).toHaveBeenCalledWith({
      where: { id: 'trip-1' },
      data: { status: TripStatus.AT_DROPOFF },
    });
  });

  it('on exit with remaining unfinished stop does not complete trip', async () => {
    const progress = {
      id: 'prog-1',
      jobStopId: 'stop-1',
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
      currentlyInside: false,
      exitedAt: new Date('2026-01-01T13:00:00Z'),
    };
    const prisma = {
      policyVersion: {
        findFirst: jest.fn().mockResolvedValue({
          payload: { ...DEFAULT_GEOFENCE_POLICY, antiBounceSamples: 1 },
        }),
      },
      trip: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'trip-1',
          jobId: 'job-1',
          startedAt: new Date('2026-01-01T10:00:00Z'),
          status: TripStatus.IN_TRANSIT,
          job: {
            stops: [
              {
                id: 'stop-1',
                lat: -37.8136,
                lng: 144.9631,
                stopType: 'PICKUP',
                sequence: 0,
              },
              {
                id: 'stop-2',
                lat: -37.9,
                lng: 145.0,
                stopType: 'DROPOFF',
                sequence: 1,
              },
            ],
          },
          stopProgress: [progress],
        }),
      },
      tripStopProgress: {
        update: jest.fn().mockResolvedValue(afterExit),
      },
      $transaction: jest.fn(),
    };
    const service = makeService(prisma);
    const result = await service.evaluateGeofence(
      'trip-1',
      { lat: -33.8688, lng: 151.2093 },
      'user-driver',
    );
    expect(result).toMatchObject({
      activeStopId: 'stop-1',
      inside: false,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'trip.geofence_exit' }),
    );
  });
});
