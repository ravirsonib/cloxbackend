import { SurchargeKind, TripStatus } from '@prisma/client';
import { DEFAULT_GEOFENCE_POLICY } from './geofence.util';
import { TripsService } from './trips.service';

describe('TripsService geofence waiting dwell leftover', () => {
  const audit = { recordPlatform: jest.fn() };
  const payments = {
    createSurcharge: jest.fn().mockResolvedValue({
      id: 's-wait',
      kind: SurchargeKind.WAITING,
      amountIncGstCents: 550,
    }),
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

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates WAITING surcharge when inside past freeWaitEndsAt', async () => {
    const freeWaitEndsAt = new Date(Date.now() - 10 * 60_000);
    const progress = {
      id: 'prog-1',
      jobStopId: 'stop-1',
      insideCount: 3,
      currentlyInside: true,
      enteredAt: new Date(Date.now() - 40 * 60_000),
      exitedAt: null as Date | null,
      freeWaitEndsAt,
      waitOverageMinutes: 0,
      arrivalRecorded: true,
    };
    const afterInside = {
      ...progress,
      insideCount: 4,
      waitOverageMinutes: 10,
    };
    const prisma = {
      policyVersion: {
        findFirst: jest.fn().mockResolvedValue({
          payload: {
            ...DEFAULT_GEOFENCE_POLICY,
            radiusMeters: 50_000,
            antiBounceSamples: 3,
          },
        }),
      },
      trip: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'trip-1',
          jobId: 'job-1',
          startedAt: new Date(),
          status: TripStatus.AT_PICKUP,
          job: {
            stops: [
              {
                id: 'stop-1',
                lat: -37.8136,
                lng: 144.9631,
                stopType: 'PICKUP',
                sequence: 0,
              },
            ],
          },
          stopProgress: [progress],
        }),
      },
      tripStopProgress: {
        update: jest
          .fn()
          .mockResolvedValueOnce(afterInside)
          .mockResolvedValueOnce({ ...afterInside, waitOverageMinutes: 10 }),
      },
    };

    const result = await makeService(prisma).evaluateGeofence(
      'trip-1',
      { lat: -37.8136, lng: 144.9631 },
      'user-driver',
    );

    expect(result).toMatchObject({
      activeStopId: 'stop-1',
      inside: true,
      stopType: 'PICKUP',
    });
    expect(result?.waitOverageMinutes).toBeGreaterThan(0);
    expect(payments.createSurcharge).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        tripId: 'trip-1',
        kind: SurchargeKind.WAITING,
        chargeNow: false,
        idempotencyKey: 'waiting:trip-1:stop-1',
        stopProgressId: 'prog-1',
      }),
    );
    expect(result?.surcharge).toMatchObject({ id: 's-wait' });
  });
});
