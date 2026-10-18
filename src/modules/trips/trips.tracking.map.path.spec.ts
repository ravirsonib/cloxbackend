import { SurchargeKind, SurchargeStatus, TripStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { TripsService } from './trips.service';

const sender: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('TripsService getSenderTracking mapStopProgress leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const payments = { createSurcharge: jest.fn() };

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

  it('maps Decimal stop coords and surcharges when live', async () => {
    const recordedAt = new Date('2026-01-02T10:05:00Z');
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          companyId: 'co-s',
        }),
      },
      trip: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'trip-1',
          jobId: 'job-1',
          status: TripStatus.IN_TRANSIT,
          startedAt: new Date('2026-01-02T10:00:00Z'),
          onBreak: false,
          job: {
            title: 'Freight',
            stops: [
              {
                sequence: 0,
                stopType: 'PICKUP',
                suburb: 'Melbourne',
                lat: -37.81,
                lng: 144.96,
              },
            ],
          },
          locations: [
            {
              lat: -37.8,
              lng: 144.95,
              recordedAt,
            },
          ],
          assignment: { vehicle: { label: 'Van' } },
          stopProgress: [
            {
              id: 'prog-1',
              jobStopId: 'stop-1',
              insideCount: 2,
              currentlyInside: true,
              enteredAt: new Date('2026-01-02T10:02:00Z'),
              exitedAt: null,
              waitStartedAt: null,
              freeWaitEndsAt: null,
              waitOverageMinutes: 0,
              arrivalRecorded: true,
              jobStop: {
                sequence: 0,
                stopType: 'PICKUP',
                suburb: 'Melbourne',
                // Decimal-like → mapStopProgress toNumber path
                lat: { toNumber: () => -37.81 },
                lng: { toNumber: () => 144.96 },
              },
            },
            {
              id: 'prog-2',
              jobStopId: 'stop-2',
              insideCount: 0,
              currentlyInside: false,
              enteredAt: null,
              exitedAt: null,
              waitStartedAt: null,
              freeWaitEndsAt: null,
              waitOverageMinutes: 0,
              arrivalRecorded: false,
              jobStop: {
                sequence: 1,
                stopType: 'DROPOFF',
                suburb: 'Geelong',
                lat: null,
                lng: null,
              },
            },
          ],
          surcharges: [
            {
              id: 's-1',
              kind: SurchargeKind.WAITING,
              status: SurchargeStatus.PENDING_PAYMENT,
              amountExGstCents: 1000,
              amountGstCents: 100,
              amountIncGstCents: 1100,
              stopProgressId: 'prog-1',
              idempotencyKey: 'waiting:trip-1:stop-1',
              paidAt: null,
              waivedAt: null,
              createdAt: new Date('2026-01-02T10:03:00Z'),
            },
          ],
        }),
      },
    };

    const result = await makeService(prisma).getSenderTracking(sender, 'job-1');
    expect(result).toMatchObject({
      visible: true,
      onBreak: false,
      latest: { lat: -37.8, lng: 144.95, recordedAt },
    });
    expect(result).toMatchObject({
      job: {
        stops: [
          expect.objectContaining({
            lat: -37.81,
            lng: 144.96,
            suburb: 'Melbourne',
          }),
        ],
      },
      stopsProgress: [
        expect.objectContaining({
          id: 'prog-1',
          arrivalRecorded: true,
          stop: expect.objectContaining({
            lat: -37.81,
            lng: 144.96,
            suburb: 'Melbourne',
          }),
        }),
        expect.objectContaining({
          id: 'prog-2',
          stop: expect.objectContaining({ lat: null, lng: null, suburb: 'Geelong' }),
        }),
      ],
      surcharges: [
        expect.objectContaining({
          id: 's-1',
          kind: SurchargeKind.WAITING,
          amountIncGstCents: 1100,
        }),
      ],
    });
  });

  it('404 when trip missing for sender job', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          companyId: 'co-s',
        }),
      },
      trip: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).getSenderTracking(sender, 'missing'),
    ).rejects.toMatchObject({ message: 'Trip not found' });
  });
});
