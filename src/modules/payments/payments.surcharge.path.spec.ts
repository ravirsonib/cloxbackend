import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  PaymentEventStatus,
  PaymentEventType,
  SurchargeKind,
  SurchargeStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { PaymentsService } from './payments.service';

const carrierPrincipal: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

const senderPrincipal: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('PaymentsService surcharge charge + status paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createPaymentIntent: jest.fn(),
    cancelPaymentIntent: jest.fn().mockResolvedValue(undefined),
    createRefundStub: jest.fn().mockResolvedValue({ id: 're_1', mock: true }),
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

  describe('chargeSurcharge', () => {
    it('returns mapped surcharge when already PAID', async () => {
      const prisma = {
        isConnected: () => true,
        surcharge: {
          findUnique: jest.fn().mockResolvedValue({
            id: 's-1',
            jobId: 'job-1',
            tripId: 'trip-1',
            kind: SurchargeKind.WAITING,
            status: SurchargeStatus.PAID,
            amountExGstCents: 1000,
            amountGstCents: 100,
            amountIncGstCents: 1100,
            paymentEventId: 'pe-1',
            stopProgressId: null,
            idempotencyKey: 'waiting:t:s',
            paidAt: new Date(),
            waivedAt: null,
            metadata: null,
            paymentEvent: { id: 'pe-1', status: PaymentEventStatus.SUCCEEDED },
            job: { senderCompany: { stripeCustomerId: 'cus_1' } },
          }),
        },
      };
      const service = makeService(prisma);
      const result = await service.chargeSurcharge('s-1');
      expect(result.status).toBe(SurchargeStatus.PAID);
      expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    });

    it('throws SENDER_NOT_PAYMENT_READY without customer', async () => {
      const prisma = {
        isConnected: () => true,
        surcharge: {
          findUnique: jest.fn().mockResolvedValue({
            id: 's-1',
            status: SurchargeStatus.PENDING_PAYMENT,
            amountIncGstCents: 1100,
            idempotencyKey: 'mass:trip-1',
            paymentEvent: {
              id: 'pe-1',
              status: PaymentEventStatus.PENDING,
              metadata: {},
            },
            job: { senderCompany: { stripeCustomerId: null } },
          }),
        },
      };
      const service = makeService(prisma);
      try {
        await service.chargeSurcharge('s-1');
        fail('expected');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: 'SENDER_NOT_PAYMENT_READY',
        });
      }
    });

    it('creates PI and marks paid on mock succeeded', async () => {
      stripe.createPaymentIntent.mockResolvedValue({
        id: 'pi_s',
        status: 'succeeded',
        clientSecret: 'cs',
        mock: true,
      });
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
          status: PaymentEventStatus.PENDING,
          stripePaymentIntentId: null,
          metadata: {},
        },
        job: {
          senderCompany: {
            stripeCustomerId: 'cus_1',
            stripeDefaultPaymentMethodId: 'pm_1',
          },
        },
      };
      const paid = {
        ...surchargeBase,
        status: SurchargeStatus.PAID,
        paidAt: new Date(),
        paymentEvent: {
          id: 'pe-1',
          status: PaymentEventStatus.SUCCEEDED,
          stripePaymentIntentId: 'pi_s',
        },
      };
      const prisma = {
        isConnected: () => true,
        surcharge: {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce(surchargeBase)
            .mockResolvedValueOnce(paid),
          update: jest.fn(),
        },
        paymentEvent: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'pe-1',
            stripePaymentIntentId: 'pi_s',
            surcharge: {
              id: 's-1',
              status: SurchargeStatus.PENDING_PAYMENT,
              kind: SurchargeKind.MASS,
              tripId: 'trip-1',
            },
          }),
          update: jest.fn(),
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
      const service = makeService(prisma);
      const result = await service.chargeSurcharge('s-1');
      expect(stripe.createPaymentIntent).toHaveBeenCalled();
      expect(result).toMatchObject({
        id: 's-1',
        status: SurchargeStatus.PAID,
        stripeStatus: 'succeeded',
        mock: true,
      });
    });
  });

  describe('markSurchargePaid waive wins', () => {
    it('skips PAID flip and refunds when already WAIVED', async () => {
      const prisma = {
        paymentEvent: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'pe-1',
            stripePaymentIntentId: 'pi_old',
            surcharge: {
              id: 's-1',
              status: SurchargeStatus.WAIVED,
              kind: SurchargeKind.WAITING,
              tripId: 'trip-1',
            },
          }),
        },
      };
      const service = makeService(prisma);
      const result = await service.markSurchargePaid({
        paymentEventId: 'pe-1',
        paymentIntentId: 'pi_late',
        source: 'webhook',
      });
      expect(result).toEqual({ skipped: true, waived: true });
      expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_late');
      expect(stripe.createRefundStub).toHaveBeenCalled();
    });

    it('skips stale PI success', async () => {
      const prisma = {
        paymentEvent: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'pe-1',
            stripePaymentIntentId: 'pi_current',
            surcharge: {
              id: 's-1',
              status: SurchargeStatus.PENDING_PAYMENT,
              kind: SurchargeKind.WAITING,
              tripId: 'trip-1',
            },
          }),
        },
      };
      const service = makeService(prisma);
      await expect(
        service.markSurchargePaid({
          paymentEventId: 'pe-1',
          paymentIntentId: 'pi_stale',
          source: 'webhook',
        }),
      ).resolves.toEqual({ skipped: true, stalePi: true });
    });
  });

  describe('handleStripeWebhook live mode', () => {
    it('rejects missing signature when not mock', async () => {
      stripe.isMockMode.mockReturnValue(false);
      const service = makeService({ isConnected: () => true });
      await expect(
        service.handleStripeWebhook(Buffer.from('{}'), undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects invalid signature from constructWebhookEvent', async () => {
      stripe.isMockMode.mockReturnValue(false);
      stripe.constructWebhookEvent.mockImplementation(() => {
        throw new Error('bad sig');
      });
      const service = makeService({ isConnected: () => true });
      await expect(
        service.handleStripeWebhook(Buffer.from('{}'), 'sig'),
      ).rejects.toMatchObject({ message: 'Invalid webhook signature' });
    });
  });

  describe('getJobPaymentStatus / listCarrierAssignments', () => {
    it('getJobPaymentStatus returns canStartTrip when LOCKED', async () => {
      const prisma = {
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-sender',
            companyId: 'co-s',
          }),
        },
        job: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'job-1',
            status: 'ASSIGNED',
            assignment: {
              id: 'asg-1',
              status: 'LOCKED',
              lockedAt: new Date(),
            },
            paymentEvents: [
              {
                id: 'pe-1',
                type: PaymentEventType.CHARGE,
                status: PaymentEventStatus.SUCCEEDED,
                amountIncGstCents: 11000,
                stripePaymentIntentId: 'pi_1',
              },
            ],
          }),
        },
      };
      const service = makeService(prisma);
      const result = await service.getJobPaymentStatus(senderPrincipal, 'job-1');
      expect(result.canStartTrip).toBe(true);
      expect(result.assignment?.paidAndConfirmed).toBe(true);
    });

    it('listCarrierAssignments rejects non-carrier', async () => {
      const service = makeService({ isConnected: () => true });
      await expect(
        service.listCarrierAssignments(senderPrincipal),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listCarrierAssignments maps exceptions from pending surcharges', async () => {
      const prisma = {
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-carrier',
            companyId: 'co-c',
          }),
        },
        assignment: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'asg-1',
              status: 'LOCKED',
              lockedAt: new Date(),
              job: {
                id: 'job-1',
                title: 'J',
                status: 'ASSIGNED',
                pricingModel: 'PER_KM',
                estimateIncGstCents: 10000,
              },
              proposal: { amountIncGstCents: 11000, etaMinutes: 60 },
              trip: {
                surcharges: [
                  {
                    id: 's-1',
                    kind: SurchargeKind.WAITING,
                    status: SurchargeStatus.PENDING_PAYMENT,
                    amountIncGstCents: 500,
                  },
                ],
              },
            },
          ]),
        },
      };
      const service = makeService(prisma);
      const rows = await service.listCarrierAssignments(carrierPrincipal);
      expect(rows[0]).toMatchObject({
        paidAndConfirmed: true,
        tripBlockedUntilPaid: false,
        exceptions: [{ id: 's-1', kind: SurchargeKind.WAITING }],
      });
    });
  });
});
