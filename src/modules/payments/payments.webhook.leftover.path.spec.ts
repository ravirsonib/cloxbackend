import {
  PaymentEventStatus,
  PaymentEventType,
  SurchargeKind,
  SurchargeStatus,
} from '@prisma/client';
import { PaymentsService } from './payments.service';

describe('PaymentsService webhook / resolve leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    isMockMode: jest.fn().mockReturnValue(true),
    constructWebhookEvent: jest.fn(),
    cancelPaymentIntent: jest.fn(),
    createPaymentIntent: jest.fn(),
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
    stripe.isMockMode.mockReturnValue(true);
  });

  it('resolvePaymentIntentSucceeded routes SURCHARGE to markSurchargePaid', async () => {
    const prisma = {
      isConnected: () => true,
      paymentEvent: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'pe-s',
            type: PaymentEventType.SURCHARGE,
          })
          .mockResolvedValueOnce({
            id: 'pe-s',
            stripePaymentIntentId: 'pi_s',
            surcharge: {
              id: 's-1',
              status: SurchargeStatus.PENDING_PAYMENT,
              kind: SurchargeKind.MASS,
              tripId: 'trip-1',
            },
          }),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          paymentEvent: { update: jest.fn() },
          surcharge: { update: jest.fn() },
          trip: { update: jest.fn() },
        };
        return fn(tx);
      }),
    };
    await expect(
      makeService(prisma).resolvePaymentIntentSucceeded({
        paymentEventId: 'pe-s',
        paymentIntentId: 'pi_s',
        source: 'test',
      }),
    ).resolves.toMatchObject({ skipped: false });
  });

  it('resolvePaymentIntentSucceeded skips missing PE', async () => {
    const prisma = {
      isConnected: () => true,
      paymentEvent: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).resolvePaymentIntentSucceeded({
        paymentEventId: 'missing',
        paymentIntentId: 'pi_x',
        source: 'test',
      }),
    ).resolves.toEqual({ skipped: true });
  });

  it('mock webhook succeeds via PI id lookup when metadata missing', async () => {
    const pe = {
      id: 'pe-1',
      jobId: 'job-1',
      type: PaymentEventType.CHARGE,
      status: PaymentEventStatus.PENDING,
      amountIncGstCents: 1000,
      metadata: { assignmentId: 'asg-1' },
    };
    const prisma = {
      isConnected: () => true,
      stripeWebhookEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      paymentEvent: {
        findFirst: jest.fn().mockResolvedValue(pe),
        findUnique: jest.fn().mockResolvedValue(pe),
      },
      assignment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'asg-1',
          status: 'PENDING',
        }),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          paymentEvent: { update: jest.fn() },
          assignment: { update: jest.fn(), updateMany: jest.fn() },
          job: { update: jest.fn() },
          settlementLine: { count: jest.fn().mockResolvedValue(1), createMany: jest.fn() },
        };
        return fn(tx);
      }),
    };
    trips.ensureTripForAssignment.mockResolvedValue(null);
    const body = Buffer.from(
      JSON.stringify({
        id: 'evt_pi_lookup',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_lookup' } },
      }),
    );
    await expect(makeService(prisma).handleStripeWebhook(body, undefined)).resolves.toEqual({
      received: true,
      mock: true,
    });
    expect(prisma.paymentEvent.findFirst).toHaveBeenCalledWith({
      where: { stripePaymentIntentId: 'pi_lookup' },
    });
  });

  it('mock webhook payment_failed marks PE failed', async () => {
    const prisma = {
      isConnected: () => true,
      stripeWebhookEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      paymentEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pe-fail',
          status: PaymentEventStatus.PENDING,
          type: PaymentEventType.SURCHARGE,
          jobId: 'job-1',
          stripePaymentIntentId: 'pi_fail',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const body = Buffer.from(
      JSON.stringify({
        id: 'evt_fail',
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: 'pi_fail',
            metadata: { paymentEventId: 'pe-fail' },
          },
        },
      }),
    );
    await expect(makeService(prisma).handleStripeWebhook(body, undefined)).resolves.toEqual({
      received: true,
      mock: true,
    });
    expect(prisma.paymentEvent.update).toHaveBeenCalledWith({
      where: { id: 'pe-fail' },
      data: { status: PaymentEventStatus.FAILED },
    });
  });

  it('live webhook payment_failed after constructEvent', async () => {
    stripe.isMockMode.mockReturnValue(false);
    stripe.constructWebhookEvent.mockReturnValue({
      id: 'evt_live_fail',
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: 'pi_live_fail',
          metadata: { paymentEventId: 'pe-live' },
        },
      },
    });
    const prisma = {
      isConnected: () => true,
      stripeWebhookEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      paymentEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pe-live',
          status: PaymentEventStatus.PENDING,
          type: PaymentEventType.SURCHARGE,
          jobId: 'job-1',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    await expect(
      makeService(prisma).handleStripeWebhook(Buffer.from('raw'), 'sig'),
    ).resolves.toEqual({ received: true });
    expect(prisma.stripeWebhookEvent.create).toHaveBeenCalled();
  });
});
