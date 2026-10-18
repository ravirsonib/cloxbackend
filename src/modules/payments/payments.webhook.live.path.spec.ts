import {
  PaymentEventStatus,
  PaymentEventType,
  SurchargeKind,
  SurchargeStatus,
} from '@prisma/client';
import { PaymentsService } from './payments.service';

describe('PaymentsService waiting accrual + live webhook success', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createPaymentIntent: jest.fn(),
    cancelPaymentIntent: jest.fn(),
    createRefundStub: jest.fn(),
    publishableKey: jest.fn().mockReturnValue('pk_test'),
    isMockMode: jest.fn().mockReturnValue(true),
    constructWebhookEvent: jest.fn(),
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

  describe('createSurcharge waiting accrual', () => {
    it('updates amounts when PENDING without PI and amount grows', async () => {
      const existing = {
        id: 's-1',
        jobId: 'job-1',
        tripId: 'trip-1',
        kind: SurchargeKind.WAITING,
        status: SurchargeStatus.PENDING_PAYMENT,
        amountExGstCents: 91,
        amountGstCents: 9,
        amountIncGstCents: 100,
        paymentEventId: 'pe-1',
        stopProgressId: 'prog-1',
        idempotencyKey: 'waiting:trip-1:stop-1',
        paidAt: null,
        waivedAt: null,
        metadata: { waitOverageMinutes: 1 },
        paymentEvent: {
          id: 'pe-1',
          status: PaymentEventStatus.PENDING,
          stripePaymentIntentId: null,
          metadata: {},
        },
      };
      const updated = {
        ...existing,
        amountIncGstCents: 500,
        amountExGstCents: 455,
        amountGstCents: 45,
        metadata: { waitOverageMinutes: 5 },
      };
      const prisma = {
        isConnected: () => true,
        surcharge: {
          findUnique: jest.fn().mockResolvedValue(existing),
        },
        $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
          const tx = {
            paymentEvent: { update: jest.fn() },
            surcharge: {
              update: jest.fn().mockResolvedValue(updated),
            },
          };
          return fn(tx);
        }),
      };
      const service = makeService(prisma);
      const result = await service.createSurcharge({
        jobId: 'job-1',
        tripId: 'trip-1',
        kind: SurchargeKind.WAITING,
        amountIncGstCents: 500,
        idempotencyKey: 'waiting:trip-1:stop-1',
        chargeNow: false,
        metadata: { waitOverageMinutes: 5 },
      });
      expect(result.amountIncGstCents).toBe(500);
      expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    });

    it('creates sibling when PI already exists and amount grows', async () => {
      const existing = {
        id: 's-1',
        jobId: 'job-1',
        tripId: 'trip-1',
        kind: SurchargeKind.WAITING,
        status: SurchargeStatus.PENDING_PAYMENT,
        amountExGstCents: 91,
        amountGstCents: 9,
        amountIncGstCents: 100,
        paymentEventId: 'pe-1',
        stopProgressId: 'prog-1',
        idempotencyKey: 'waiting:trip-1:stop-1',
        paidAt: null,
        waivedAt: null,
        metadata: {},
        paymentEvent: {
          id: 'pe-1',
          status: PaymentEventStatus.PENDING,
          stripePaymentIntentId: 'pi_existing',
          metadata: {},
        },
      };
      const sibling = {
        id: 's-2',
        jobId: 'job-1',
        tripId: 'trip-1',
        kind: SurchargeKind.WAITING,
        status: SurchargeStatus.PENDING_PAYMENT,
        amountExGstCents: 182,
        amountGstCents: 18,
        amountIncGstCents: 200,
        paymentEventId: 'pe-2',
        stopProgressId: 'prog-1',
        idempotencyKey: 'waiting:trip-1:stop-1:postpi:300',
        paidAt: null,
        waivedAt: null,
        metadata: { parentSurchargeId: 's-1' },
        paymentEvent: {
          id: 'pe-2',
          status: PaymentEventStatus.PENDING,
          stripePaymentIntentId: null,
        },
      };
      const prisma = {
        isConnected: () => true,
        surcharge: {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce(existing)
            .mockResolvedValueOnce(null),
        },
        job: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'job-1',
            senderCompany: {
              stripeCustomerId: 'cus_1',
              stripeDefaultPaymentMethodId: 'pm_1',
            },
          }),
        },
        $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
          const tx = {
            paymentEvent: {
              create: jest.fn().mockResolvedValue({
                id: 'pe-2',
                status: PaymentEventStatus.PENDING,
              }),
            },
            surcharge: {
              create: jest.fn().mockResolvedValue(sibling),
            },
          };
          return fn(tx);
        }),
      };
      const service = makeService(prisma);
      const result = await service.createSurcharge({
        jobId: 'job-1',
        tripId: 'trip-1',
        kind: SurchargeKind.WAITING,
        amountIncGstCents: 300,
        idempotencyKey: 'waiting:trip-1:stop-1',
        chargeNow: false,
      });
      expect(result.id).toBe('s-2');
      expect(result.amountIncGstCents).toBe(200);
      expect(result.idempotencyKey).toContain('postpi');
    });
  });

  describe('handleStripeWebhook live constructEvent success', () => {
    it('processes payment_intent.succeeded and records event', async () => {
      stripe.isMockMode.mockReturnValue(false);
      stripe.constructWebhookEvent.mockReturnValue({
        id: 'evt_live_1',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_live_1',
            metadata: { paymentEventId: 'pe-1' },
          },
        },
      });
      const pe = {
        id: 'pe-1',
        jobId: 'job-1',
        type: PaymentEventType.CHARGE,
        status: PaymentEventStatus.PENDING,
        amountIncGstCents: 11000,
        metadata: { assignmentId: 'asg-1' },
      };
      const prisma = {
        isConnected: () => true,
        stripeWebhookEvent: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({}),
        },
        paymentEvent: {
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
            settlementLine: {
              count: jest.fn().mockResolvedValue(1),
              createMany: jest.fn(),
            },
          };
          return fn(tx);
        }),
      };
      trips.ensureTripForAssignment.mockResolvedValue(null);
      const service = makeService(prisma);
      await expect(
        service.handleStripeWebhook(Buffer.from('raw'), 'sig_header'),
      ).resolves.toEqual({ received: true });
      expect(stripe.constructWebhookEvent).toHaveBeenCalled();
      expect(prisma.stripeWebhookEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          stripeEventId: 'evt_live_1',
          type: 'payment_intent.succeeded',
        }),
      });
      expect(trips.ensureTripForAssignment).toHaveBeenCalledWith('asg-1');
    });

    it('returns duplicate when live event already stored', async () => {
      stripe.isMockMode.mockReturnValue(false);
      stripe.constructWebhookEvent.mockReturnValue({
        id: 'evt_dup',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_1' } },
      });
      const prisma = {
        isConnected: () => true,
        stripeWebhookEvent: {
          findUnique: jest.fn().mockResolvedValue({ id: 'row' }),
          create: jest.fn(),
        },
      };
      const service = makeService(prisma);
      await expect(
        service.handleStripeWebhook(Buffer.from('raw'), 'sig'),
      ).resolves.toEqual({ received: true, duplicate: true });
      expect(prisma.stripeWebhookEvent.create).not.toHaveBeenCalled();
    });
  });
});
