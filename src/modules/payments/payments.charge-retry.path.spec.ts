import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  PaymentEventStatus,
  SurchargeKind,
  SurchargeStatus,
} from '@prisma/client';
import { PaymentsService } from './payments.service';

describe('PaymentsService charge retry + createSurcharge edge leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    isMockMode: jest.fn().mockReturnValue(true),
    createPaymentIntent: jest.fn(),
    cancelPaymentIntent: jest.fn(),
    createRefundStub: jest.fn(),
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

  it('chargeSurcharge resets FAILED PE then creates PI (requires_action)', async () => {
    stripe.createPaymentIntent.mockResolvedValue({
      id: 'pi_retry',
      status: 'requires_action',
      clientSecret: 'cs_retry',
      mock: true,
    });
    const pendingPe = {
      id: 'pe-1',
      status: PaymentEventStatus.PENDING,
      stripePaymentIntentId: null,
      metadata: { stripeAttempt: 0 },
    };
    const surchargeBase = {
      id: 's-1',
      jobId: 'job-1',
      tripId: 'trip-1',
      kind: SurchargeKind.MASS,
      status: SurchargeStatus.PENDING_PAYMENT,
      amountExGstCents: 909,
      amountGstCents: 91,
      amountIncGstCents: 1000,
      paymentEventId: 'pe-1',
      stopProgressId: null,
      idempotencyKey: 'mass:trip-1',
      paidAt: null,
      waivedAt: null,
      metadata: null,
      paymentEvent: {
        id: 'pe-1',
        status: PaymentEventStatus.FAILED,
        stripePaymentIntentId: 'pi_old',
        metadata: { stripeAttempt: 0 },
      },
      job: {
        senderCompany: {
          stripeCustomerId: 'cus_1',
          stripeDefaultPaymentMethodId: 'pm_1',
        },
      },
    };
    const prisma = {
      isConnected: () => true,
      surcharge: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(surchargeBase)
          .mockResolvedValueOnce({
            ...surchargeBase,
            paymentEvent: {
              ...pendingPe,
              stripePaymentIntentId: 'pi_retry',
              status: PaymentEventStatus.REQUIRES_ACTION,
            },
          }),
      },
      paymentEvent: {
        update: jest
          .fn()
          .mockResolvedValueOnce(pendingPe)
          .mockResolvedValueOnce({
            ...pendingPe,
            stripePaymentIntentId: 'pi_retry',
            status: PaymentEventStatus.REQUIRES_ACTION,
          }),
      },
    };
    const result = await makeService(prisma).chargeSurcharge('s-1');
    expect(prisma.paymentEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pe-1' },
        data: expect.objectContaining({
          status: PaymentEventStatus.PENDING,
          stripePaymentIntentId: null,
        }),
      }),
    );
    expect(stripe.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(':att:1'),
      }),
    );
    expect(result).toMatchObject({
      stripeStatus: 'requires_action',
      clientSecret: 'cs_retry',
    });
  });

  it('chargeSurcharge marks PE FAILED when PI create throws', async () => {
    stripe.createPaymentIntent.mockRejectedValue(new Error('stripe down'));
    const prisma = {
      isConnected: () => true,
      surcharge: {
        findUnique: jest.fn().mockResolvedValue({
          id: 's-1',
          jobId: 'job-1',
          tripId: 'trip-1',
          kind: SurchargeKind.WAITING,
          status: SurchargeStatus.PENDING_PAYMENT,
          amountIncGstCents: 500,
          idempotencyKey: 'waiting:t',
          paymentEventId: 'pe-1',
          stopProgressId: null,
          paidAt: null,
          waivedAt: null,
          metadata: null,
          amountExGstCents: 455,
          amountGstCents: 45,
          paymentEvent: {
            id: 'pe-1',
            status: PaymentEventStatus.PENDING,
            metadata: {},
          },
          job: {
            senderCompany: {
              stripeCustomerId: 'cus_1',
              stripeDefaultPaymentMethodId: 'pm_1',
            },
          },
        }),
      },
      paymentEvent: { update: jest.fn().mockResolvedValue({}) },
    };
    const service = makeService(prisma);
    await expect(service.chargeSurcharge('s-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'SURCHARGE_PI_FAILED' }),
    });
    expect(prisma.paymentEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PaymentEventStatus.FAILED }),
      }),
    );
  });

  it('createSurcharge 404 when job/sender missing', async () => {
    const prisma = {
      isConnected: () => true,
      surcharge: { findUnique: jest.fn().mockResolvedValue(null) },
      job: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).createSurcharge({
        jobId: 'missing',
        tripId: 't1',
        kind: SurchargeKind.MASS,
        amountIncGstCents: 1000,
        idempotencyKey: 'mass:t1',
        chargeNow: false,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('createSurcharge chargeNow without stripe customer throws SENDER_NOT_PAYMENT_READY', async () => {
    const created = {
      id: 's-new',
      jobId: 'job-1',
      tripId: 't1',
      kind: SurchargeKind.MASS,
      status: SurchargeStatus.PENDING_PAYMENT,
      amountExGstCents: 909,
      amountGstCents: 91,
      amountIncGstCents: 1000,
      paymentEventId: 'pe-new',
      stopProgressId: null,
      idempotencyKey: 'mass:t1',
      paidAt: null,
      waivedAt: null,
      metadata: null,
      paymentEvent: { id: 'pe-new', status: PaymentEventStatus.PENDING },
    };
    const prisma = {
      isConnected: () => true,
      surcharge: { findUnique: jest.fn().mockResolvedValue(null) },
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          senderCompany: {
            stripeCustomerId: null,
            stripeDefaultPaymentMethodId: null,
          },
        }),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          paymentEvent: {
            create: jest.fn().mockResolvedValue({ id: 'pe-new' }),
          },
          surcharge: { create: jest.fn().mockResolvedValue(created) },
        };
        return fn(tx);
      }),
    };
    try {
      await makeService(prisma).createSurcharge({
        jobId: 'job-1',
        tripId: 't1',
        kind: SurchargeKind.MASS,
        amountIncGstCents: 1000,
        idempotencyKey: 'mass:t1',
      });
      fail('expected');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'SENDER_NOT_PAYMENT_READY',
      });
    }
    expect(audit.recordPlatform).toHaveBeenCalled();
  });

  it('markPaymentFailed no-ops when already SUCCEEDED', async () => {
    const prisma = {
      isConnected: () => true,
      paymentEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pe-1',
          status: PaymentEventStatus.SUCCEEDED,
          type: 'CHARGE',
          jobId: 'job-1',
        }),
        update: jest.fn(),
      },
    };
    await expect(
      makeService(prisma).markPaymentFailed({
        paymentEventId: 'pe-1',
        paymentIntentId: 'pi_1',
      }),
    ).resolves.toBeUndefined();
    expect(prisma.paymentEvent.update).not.toHaveBeenCalled();
  });
});
