import { BadRequestException } from '@nestjs/common';
import { TripStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { TripsService } from './trips.service';

describe('TripsService POD blocked by pending surcharges', () => {
  const driver: AuthenticatedPrincipal = {
    id: 'user-driver',
    email: 'driver@test.com',
    role: 'DRIVER',
    kind: 'user',
    regionCodes: [],
    territoryCodes: [],
  };

  const audit = { recordPlatform: jest.fn() };
  const payments = {
    createSurcharge: jest.fn(),
    chargeSurcharge: jest.fn().mockRejectedValue(new Error('card declined')),
  };
  const notifications = {
    notifyTripApproaching: jest.fn(),
    notifyTripAtDropoff: jest.fn(),
    notifyPodFinalized: jest.fn(),
    notifyTripCompletionDocuments: jest.fn(),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new TripsService(
      prisma as never,
      audit as never,
      { get: () => undefined } as never,
      payments as never,
      notifications as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('finalizePod rejects when WAITING surcharge stays PENDING_PAYMENT', async () => {
    const trip = {
      id: 'trip-1',
      jobId: 'job-1',
      startedAt: new Date(),
      status: TripStatus.AT_DROPOFF,
      job: {
        title: 'Job',
        stops: [{ id: 'stop-drop', stopType: 'DROPOFF', sequence: 1 }],
      },
      assignment: { status: 'LOCKED', vehicle: null },
      locations: [],
      stopProgress: [],
      surcharges: [],
    };
    const progress = {
      id: 'prog-1',
      tripId: 'trip-1',
      jobStopId: 'stop-drop',
      podStatus: 'SIGNED',
      signedAt: new Date(),
      signerName: 'Recv',
      signatureStorageKey: 'trips/trip-1/stop-drop/signature.png',
      signatureContentHash: 'abc',
      receiverPresentAttested: true,
      goodsPhotoRefs: ['trips/trip-1/stop-drop/photo.jpg'],
    };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-driver',
          driver: { id: 'drv-1' },
        }),
      },
      trip: {
        findFirst: jest.fn().mockResolvedValue(trip),
        findUnique: jest.fn().mockResolvedValue(trip),
      },
      tripStopProgress: {
        findUnique: jest.fn().mockResolvedValue(progress),
      },
      surcharge: {
        findMany: jest.fn().mockResolvedValue([{ id: 's-wait' }]),
        count: jest.fn().mockResolvedValue(1),
      },
    };

    const service = makeService(prisma);
    try {
      await service.finalizePod(driver, 'trip-1', { jobStopId: 'stop-drop' });
      fail('expected POD_BLOCKED_PENDING_SURCHARGE');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'POD_BLOCKED_PENDING_SURCHARGE',
      });
    }
    expect(payments.chargeSurcharge).toHaveBeenCalledWith('s-wait');
    expect(prisma.surcharge.count).toHaveBeenCalled();
  });

  it('submitPodSignature rejects when pending surcharge remains', async () => {
    const trip = {
      id: 'trip-1',
      jobId: 'job-1',
      startedAt: new Date(),
      status: TripStatus.AT_DROPOFF,
      job: {
        title: 'Job',
        stops: [{ id: 'stop-drop', stopType: 'DROPOFF', sequence: 1 }],
      },
      assignment: { status: 'LOCKED', vehicle: null },
      locations: [],
      stopProgress: [],
      surcharges: [],
    };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-driver',
          driver: { id: 'drv-1' },
        }),
      },
      trip: {
        findFirst: jest.fn().mockResolvedValue(trip),
      },
      surcharge: {
        findMany: jest.fn().mockResolvedValue([{ id: 's-wait' }]),
        count: jest.fn().mockResolvedValue(1),
      },
    };

    await expect(
      makeService(prisma).submitPodSignature(driver, 'trip-1', {
        jobStopId: 'stop-drop',
        signerName: 'Recv',
        signatureDataUrl: 'data:image/png;base64,aaa',
        receiverPresentAttested: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
