import { TripStatus } from '@prisma/client';
import { DEFAULT_GEOFENCE_POLICY } from './geofence.util';
import { TripsService } from './trips.service';

describe('TripsService geofence fully-done peer leftover', () => {
  it('exit completes when peer stop already arrived+exited (hits return false)', async () => {
    const audit = { recordPlatform: jest.fn() };
    const progress = {
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
    const afterExit = {
      ...progress,
      currentlyInside: false,
      exitedAt: new Date('2026-01-01T13:00:00Z'),
    };
    const tripForComplete = {
      id: 'trip-1',
      jobId: 'job-1',
      assignmentId: 'asg-1',
      startedAt: new Date('2026-01-01T10:00:00Z'),
      status: TripStatus.IN_TRANSIT,
      job: {
        stops: [
          { id: 'stop-1', lat: -37.8, lng: 144.9, stopType: 'PICKUP', sequence: 0 },
          { id: 'stop-2', lat: -37.8136, lng: 144.9631, stopType: 'DROPOFF', sequence: 1 },
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
        afterExit,
      ],
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
          .mockResolvedValueOnce({
            id: 'trip-1',
            jobId: 'job-1',
            startedAt: new Date('2026-01-01T10:00:00Z'),
            status: TripStatus.IN_TRANSIT,
            job: {
              stops: [
                { id: 'stop-1', lat: -37.8, lng: 144.9, stopType: 'PICKUP', sequence: 0 },
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
              progress,
            ],
          })
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
    const service = new TripsService(
      prisma as never,
      audit as never,
      { get: () => undefined } as never,
      { createSurcharge: jest.fn(), chargePendingSurchargesForTrip: jest.fn() } as never,
    );
    await service.evaluateGeofence(
      'trip-1',
      { lat: -33.8688, lng: 151.2093 },
      'user-driver',
    );
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
