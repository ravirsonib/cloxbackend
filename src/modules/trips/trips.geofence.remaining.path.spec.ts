import { TripStatus } from '@prisma/client';
import { DEFAULT_GEOFENCE_POLICY } from './geofence.util';
import { TripsService } from './trips.service';

describe('TripsService geofence remaining dwelling-stop leftover', () => {
  const audit = { recordPlatform: jest.fn() };

  function makeService(prisma: Record<string, unknown>) {
    return new TripsService(
      prisma as never,
      audit as never,
      { get: () => undefined } as never,
      { createSurcharge: jest.fn() } as never,
    );
  }

  it('exit does not complete when another stop is mid-dwell (entered, not exited)', async () => {
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
          // stop-2 already dwelling — hits remaining branch enteredAt && !exitedAt
          stopProgress: [
            progress,
            {
              id: 'prog-2',
              jobStopId: 'stop-2',
              insideCount: 2,
              currentlyInside: true,
              enteredAt: new Date('2026-01-01T12:10:00Z'),
              exitedAt: null,
              freeWaitEndsAt: new Date('2026-01-01T12:40:00Z'),
              waitOverageMinutes: 0,
              arrivalRecorded: true,
            },
          ],
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
    expect(result).toMatchObject({ activeStopId: 'stop-1', inside: false });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
