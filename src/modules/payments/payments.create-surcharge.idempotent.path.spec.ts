import {
  PaymentEventStatus,
  SurchargeKind,
  SurchargeStatus,
} from '@prisma/client';
import { PaymentsService } from './payments.service';

describe('PaymentsService createSurcharge idempotent leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createPaymentIntent: jest.fn(),
    cancelPaymentIntent: jest.fn(),
    isMockMode: jest.fn().mockReturnValue(true),
  };
  const trips = { ensureTripForAssignment: jest.fn() };

  function makeService(prisma: Record<string, unknown>) {
    return new PaymentsService(
      prisma as never,
      audit as never,
      stripe as never,
      trips as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns existing when amount did not grow', async () => {
    const existing = {
      id: 's-1',
      jobId: 'job-1',
      tripId: 'trip-1',
      kind: SurchargeKind.WAITING,
      status: SurchargeStatus.PENDING_PAYMENT,
      amountExGstCents: 455,
      amountGstCents: 45,
      amountIncGstCents: 500,
      paymentEventId: 'pe-1',
      stopProgressId: 'prog-1',
      idempotencyKey: 'waiting:trip-1:stop-1',
      paidAt: null,
      waivedAt: null,
      metadata: null,
      paymentEvent: {
        id: 'pe-1',
        status: PaymentEventStatus.PENDING,
        stripePaymentIntentId: null,
        metadata: {},
      },
    };
    const prisma = {
      isConnected: () => true,
      surcharge: { findUnique: jest.fn().mockResolvedValue(existing) },
      $transaction: jest.fn(),
    };

    const result = await makeService(prisma).createSurcharge({
      jobId: 'job-1',
      tripId: 'trip-1',
      kind: SurchargeKind.WAITING,
      amountIncGstCents: 500,
      idempotencyKey: 'waiting:trip-1:stop-1',
      chargeNow: false,
    });
    expect(result).toMatchObject({ id: 's-1', amountIncGstCents: 500 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('listSenderSurcharges maps sender company rows', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          companyId: 'co-s',
        }),
      },
      surcharge: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 's-1',
            jobId: 'job-1',
            tripId: 'trip-1',
            kind: SurchargeKind.MASS,
            status: SurchargeStatus.PENDING_PAYMENT,
            amountExGstCents: 1000,
            amountGstCents: 100,
            amountIncGstCents: 1100,
            paymentEventId: 'pe-1',
            stopProgressId: null,
            idempotencyKey: 'mass:trip-1',
            paidAt: null,
            waivedAt: null,
            metadata: null,
            paymentEvent: { id: 'pe-1', status: PaymentEventStatus.PENDING },
            job: { id: 'job-1', title: 'Freight', status: 'ASSIGNED' },
          },
        ]),
      },
    };

    const rows = await makeService(prisma).listSenderSurcharges({
      id: 'user-sender',
      email: 'sender@yopmail.com',
      role: 'SENDER',
      kind: 'user',
      regionCodes: [],
      territoryCodes: [],
    });
    expect(rows).toEqual([
      expect.objectContaining({
        id: 's-1',
        kind: SurchargeKind.MASS,
        job: expect.objectContaining({ title: 'Freight' }),
      }),
    ]);
    expect(rows[0]).not.toHaveProperty('canWaive');
  });
});
