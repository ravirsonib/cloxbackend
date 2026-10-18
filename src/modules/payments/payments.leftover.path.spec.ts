import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentEventStatus,
  PaymentEventType,
  SurchargeKind,
  SurchargeStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { PaymentsService } from './payments.service';

const senderPrincipal: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

const adminPrincipal: AuthenticatedPrincipal = {
  id: 'admin-1',
  email: 'admin@yopmail.com',
  role: 'SUPER_ADMIN',
  kind: 'admin',
  regionCodes: [],
  territoryCodes: [],
};

const carrierPrincipal: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('PaymentsService leftover list/pay/refund/fail paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createPaymentIntent: jest.fn(),
    cancelPaymentIntent: jest.fn().mockResolvedValue(undefined),
    createRefundStub: jest.fn().mockResolvedValue({ id: 're_1', mock: true }),
    publishableKey: jest.fn().mockReturnValue('pk_test'),
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

  describe('listSenderSurcharges', () => {
    it('admin SUPER_ADMIN lists with canWaive', async () => {
      const prisma = {
        isConnected: () => true,
        surcharge: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 's-1',
              jobId: 'job-1',
              tripId: 'trip-1',
              kind: SurchargeKind.WAITING,
              status: SurchargeStatus.PENDING_PAYMENT,
              amountExGstCents: 100,
              amountGstCents: 10,
              amountIncGstCents: 110,
              paymentEventId: 'pe-1',
              stopProgressId: null,
              idempotencyKey: 'w:1',
              paidAt: null,
              waivedAt: null,
              metadata: null,
              paymentEvent: { id: 'pe-1', status: PaymentEventStatus.PENDING },
              job: { id: 'job-1', title: 'J', status: 'ASSIGNED' },
            },
          ]),
        },
      };
      const service = makeService(prisma);
      const rows = await service.listSenderSurcharges(adminPrincipal);
      expect(rows[0]).toMatchObject({ id: 's-1', canWaive: true });
    });

    it('sender scoped list without canWaive', async () => {
      const prisma = {
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-s' }),
        },
        surcharge: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };
      const service = makeService(prisma);
      await expect(service.listSenderSurcharges(senderPrincipal)).resolves.toEqual([]);
      expect(prisma.surcharge.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { job: { senderCompanyId: 'co-s' } },
        }),
      );
    });
  });

  describe('paySurcharge', () => {
    it('rejects non-pending surcharge', async () => {
      const prisma = {
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-sender',
            companyId: 'co-s',
            company: {
              stripeCustomerId: 'cus_1',
              stripeDefaultPaymentMethodId: 'pm_1',
            },
          }),
        },
        surcharge: {
          findFirst: jest.fn().mockResolvedValue({
            id: 's-1',
            status: SurchargeStatus.PAID,
          }),
        },
      };
      const service = makeService(prisma);
      await expect(
        service.paySurcharge(senderPrincipal, 's-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('delegates to chargeSurcharge with sender customer', async () => {
      stripe.createPaymentIntent.mockResolvedValue({
        id: 'pi_s',
        status: 'succeeded',
        clientSecret: 'cs',
        mock: true,
      });
      const surcharge = {
        id: 's-1',
        jobId: 'job-1',
        tripId: 'trip-1',
        kind: SurchargeKind.WAITING,
        status: SurchargeStatus.PENDING_PAYMENT,
        amountExGstCents: 100,
        amountGstCents: 10,
        amountIncGstCents: 110,
        paymentEventId: 'pe-1',
        stopProgressId: null,
        idempotencyKey: 'waiting:t:s',
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
        ...surcharge,
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
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-sender',
            companyId: 'co-s',
            company: {
              stripeCustomerId: 'cus_1',
              stripeDefaultPaymentMethodId: 'pm_1',
            },
          }),
        },
        surcharge: {
          findFirst: jest.fn().mockResolvedValue({
            id: 's-1',
            status: SurchargeStatus.PENDING_PAYMENT,
          }),
          findUnique: jest
            .fn()
            .mockResolvedValueOnce(surcharge)
            .mockResolvedValueOnce(paid),
        },
        paymentEvent: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'pe-1',
            stripePaymentIntentId: 'pi_s',
            surcharge: {
              id: 's-1',
              status: SurchargeStatus.PENDING_PAYMENT,
              kind: SurchargeKind.WAITING,
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
      const result = await service.paySurcharge(senderPrincipal, 's-1');
      expect(result.status).toBe(SurchargeStatus.PAID);
      expect(stripe.createPaymentIntent).toHaveBeenCalled();
    });
  });

  describe('listCarrierExceptions', () => {
    it('rejects non-carrier', async () => {
      const service = makeService({ isConnected: () => true });
      await expect(
        service.listCarrierExceptions(senderPrincipal),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('maps pending/paid surcharges readOnly', async () => {
      const prisma = {
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-carrier',
            companyId: 'co-c',
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
              amountIncGstCents: 5000,
              job: { id: 'job-1', title: 'J', status: 'ASSIGNED' },
            },
          ]),
        },
      };
      const service = makeService(prisma);
      const rows = await service.listCarrierExceptions(carrierPrincipal);
      expect(rows[0]).toMatchObject({
        id: 's-1',
        readOnly: true,
        kind: SurchargeKind.MASS,
      });
    });
  });

  describe('markPaymentFailed unwind', () => {
    it('marks FAILED and unwinds PENDING assignment for CHARGE', async () => {
      const pe = {
        id: 'pe-1',
        jobId: 'job-1',
        type: PaymentEventType.CHARGE,
        status: PaymentEventStatus.PENDING,
        stripePaymentIntentId: 'pi_1',
        metadata: {
          proposalId: 'prop-1',
          assignmentId: 'asg-1',
          conflictIds: [],
        },
      };
      const prisma = {
        paymentEvent: {
          findUnique: jest.fn().mockResolvedValue(pe),
          update: jest.fn(),
          delete: jest.fn(),
        },
        assignment: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'asg-1',
            status: 'PENDING',
          }),
        },
        $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
          const tx = {
            assignment: {
              findUnique: jest.fn().mockResolvedValue({
                id: 'asg-1',
                status: 'PENDING',
              }),
              delete: jest.fn(),
            },
            job: {
              findUnique: jest.fn().mockResolvedValue({
                id: 'job-1',
                status: 'ASSIGNED',
              }),
              update: jest.fn(),
            },
            proposal: {
              findUnique: jest.fn().mockResolvedValue({
                id: 'prop-1',
                status: 'ACCEPTED',
              }),
              update: jest.fn(),
              updateMany: jest.fn(),
            },
            paymentEvent: { delete: jest.fn() },
          };
          return fn(tx);
        }),
      };
      const service = makeService(prisma);
      await service.markPaymentFailed({
        paymentEventId: 'pe-1',
        paymentIntentId: 'pi_1',
      });
      expect(prisma.paymentEvent.update).toHaveBeenCalledWith({
        where: { id: 'pe-1' },
        data: { status: PaymentEventStatus.FAILED },
      });
      expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_1');
      expect(audit.recordPlatform).toHaveBeenCalled();
    });
  });

  describe('refundStub', () => {
    it('records refund stub for succeeded charge', async () => {
      const prisma = {
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-sender',
            companyId: 'co-s',
          }),
        },
        job: {
          findFirst: jest.fn().mockResolvedValue({ id: 'job-1' }),
        },
        paymentEvent: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'pe-1',
            stripePaymentIntentId: 'pi_1',
            type: PaymentEventType.CHARGE,
            status: PaymentEventStatus.SUCCEEDED,
          }),
        },
      };
      const service = makeService(prisma);
      const result = await service.refundStub(senderPrincipal, 'job-1');
      expect(result).toMatchObject({
        success: true,
        refundId: 're_1',
        mock: true,
      });
      expect(stripe.createRefundStub).toHaveBeenCalled();
    });

    it('throws when no succeeded charge', async () => {
      const prisma = {
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-sender',
            companyId: 'co-s',
          }),
        },
        job: { findFirst: jest.fn().mockResolvedValue({ id: 'job-1' }) },
        paymentEvent: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const service = makeService(prisma);
      await expect(
        service.refundStub(senderPrincipal, 'job-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('acceptProposal PI create failure', () => {
    it('unwinds and throws PAYMENT_INTENT_FAILED', async () => {
      stripe.createPaymentIntent.mockRejectedValue(new Error('stripe down'));
      const assignment = { id: 'asg-1', status: 'PENDING', lockedAt: null };
      const pePending = {
        id: 'pe-1',
        jobId: 'job-1',
        status: PaymentEventStatus.PENDING,
        amountIncGstCents: 11000,
        metadata: {
          proposalId: 'prop-1',
          assignmentId: 'asg-1',
          conflictIds: [] as string[],
        },
      };
      const prisma = {
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-sender',
            companyId: 'co-s',
            company: {
              id: 'co-s',
              paymentReady: true,
              stripeCustomerId: 'cus_1',
              stripeDefaultPaymentMethodId: 'pm_1',
            },
          }),
        },
        paymentEvent: {
          findUnique: jest.fn().mockResolvedValue(null),
          update: jest.fn(),
          delete: jest.fn(),
        },
        job: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'job-1',
            status: 'BIDDING',
            assignment: null,
            proposals: [
              {
                id: 'prop-1',
                status: 'SUBMITTED',
                carrierCompanyId: 'co-c',
                vehicleId: 'veh-1',
                driverId: 'drv-1',
                amountIncGstCents: 11000,
                amountExGstCents: 10000,
                amountGstCents: 1000,
              },
            ],
          }),
        },
        $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
          const tx = {
            assignment: {
              create: jest.fn().mockResolvedValue(assignment),
              findUnique: jest.fn().mockResolvedValue(assignment),
              delete: jest.fn(),
            },
            proposal: {
              update: jest.fn(),
              findMany: jest.fn().mockResolvedValue([]),
              findUnique: jest.fn().mockResolvedValue({
                id: 'prop-1',
                status: 'ACCEPTED',
              }),
              updateMany: jest.fn(),
            },
            job: {
              update: jest.fn(),
              findUnique: jest.fn().mockResolvedValue({
                id: 'job-1',
                status: 'ASSIGNED',
              }),
            },
            paymentEvent: {
              create: jest.fn().mockResolvedValue(pePending),
              delete: jest.fn(),
            },
          };
          return fn(tx);
        }),
      };
      const service = makeService(prisma);
      try {
        await service.acceptProposal(senderPrincipal, 'job-1', 'prop-1');
        fail('expected PAYMENT_INTENT_FAILED');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: 'PAYMENT_INTENT_FAILED',
        });
      }
      expect(prisma.paymentEvent.update).toHaveBeenCalled();
    });
  });
});
