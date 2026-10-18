import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  AssignmentStatus,
  JobStatus,
  PaymentEventStatus,
  PaymentEventType,
  ProposalStatus,
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

describe('PaymentsService acceptProposal + webhook paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createPaymentIntent: jest.fn(),
    cancelPaymentIntent: jest.fn(),
    publishableKey: jest.fn().mockReturnValue('pk_test'),
    retrievePaymentIntentStatus: jest.fn(),
    retrievePaymentIntentClientSecret: jest.fn(),
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

  describe('acceptProposal gates', () => {
    it('rejects non-sender', async () => {
      const service = makeService({ isConnected: () => true });
      await expect(
        service.acceptProposal(
          { ...senderPrincipal, role: 'DRIVER' },
          'job-1',
          'prop-1',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects when payment not ready', async () => {
      const prisma = {
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-sender',
            companyId: 'co-s',
            company: {
              id: 'co-s',
              paymentReady: false,
              stripeCustomerId: null,
            },
          }),
        },
      };
      const service = makeService(prisma);
      try {
        await service.acceptProposal(senderPrincipal, 'job-1', 'prop-1');
        fail('expected');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: 'SENDER_NOT_PAYMENT_READY',
        });
      }
    });

    it('idempotent replay returns clientSecret when SCA pending', async () => {
      stripe.retrievePaymentIntentClientSecret.mockResolvedValue('cs_live');
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
          findUnique: jest.fn().mockResolvedValue({
            id: 'pe-1',
            jobId: 'job-1',
            status: PaymentEventStatus.REQUIRES_ACTION,
            amountIncGstCents: 11000,
            stripePaymentIntentId: 'pi_1',
            createdAt: new Date(),
            job: {
              assignment: {
                id: 'asg-1',
                status: AssignmentStatus.PENDING,
                lockedAt: null,
              },
            },
          }),
        },
      };
      const service = makeService(prisma);
      const result = await service.acceptProposal(senderPrincipal, 'job-1', 'prop-1');
      expect(result).toMatchObject({
        paymentEventId: 'pe-1',
        idempotentReplay: true,
        clientSecret: 'cs_live',
        publishableKey: 'pk_test',
      });
      expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    });

    it('rejects JOB_ALREADY_ASSIGNED', async () => {
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
        paymentEvent: { findUnique: jest.fn().mockResolvedValue(null) },
        job: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'job-1',
            status: JobStatus.BIDDING,
            assignment: { id: 'asg-old' },
            proposals: [],
          }),
        },
      };
      const service = makeService(prisma);
      try {
        await service.acceptProposal(senderPrincipal, 'job-1', 'prop-1');
        fail('expected');
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        expect((err as ConflictException).getResponse()).toMatchObject({
          code: 'JOB_ALREADY_ASSIGNED',
        });
      }
    });

    it('happy path: creates PI succeeded and locks via markPaidAndLock', async () => {
      const assignment = {
        id: 'asg-1',
        status: AssignmentStatus.PENDING,
        lockedAt: null as Date | null,
      };
      const pePending = {
        id: 'pe-1',
        jobId: 'job-1',
        status: PaymentEventStatus.PENDING,
        amountIncGstCents: 11000,
        amountExGstCents: 10000,
        amountGstCents: 1000,
        stripePaymentIntentId: null as string | null,
        metadata: {
          proposalId: 'prop-1',
          assignmentId: 'asg-1',
          conflictIds: [] as string[],
        },
      };
      const peAfterPi = {
        ...pePending,
        stripePaymentIntentId: 'pi_ok',
        status: PaymentEventStatus.SUCCEEDED,
      };
      const peForLock = {
        ...peAfterPi,
        metadata: pePending.metadata,
      };
      const lockedAssignment = {
        id: 'asg-1',
        status: AssignmentStatus.LOCKED,
        lockedAt: new Date('2026-01-01T12:00:00Z'),
      };

      stripe.createPaymentIntent.mockResolvedValue({
        id: 'pi_ok',
        status: 'succeeded',
        clientSecret: 'cs_ok',
        mock: true,
      });

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
          findUnique: jest
            .fn()
            // accept: no existing
            .mockResolvedValueOnce(null)
            // markPaidAndLock lookup
            .mockResolvedValueOnce(peForLock),
          update: jest.fn().mockResolvedValue(peAfterPi),
        },
        job: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'job-1',
            status: JobStatus.BIDDING,
            assignment: null,
            proposals: [
              {
                id: 'prop-1',
                status: ProposalStatus.SUBMITTED,
                carrierCompanyId: 'co-c',
                vehicleId: 'veh-1',
                driverId: 'drv-1',
                amountIncGstCents: 11000,
                amountExGstCents: 10000,
                amountGstCents: 1000,
              },
            ],
          }),
          update: jest.fn(),
        },
        assignment: {
          findUnique: jest.fn().mockResolvedValue(lockedAssignment),
        },
        $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
          if (typeof fn !== 'function') {
            // markPaidAndLock may pass array — not used here
            return fn;
          }
          const tx = {
            assignment: {
              create: jest.fn().mockResolvedValue(assignment),
              update: jest.fn(),
              updateMany: jest.fn(),
            },
            proposal: {
              update: jest.fn(),
              findMany: jest.fn().mockResolvedValue([]),
              updateMany: jest.fn(),
            },
            job: { update: jest.fn() },
            paymentEvent: {
              create: jest.fn().mockResolvedValue(pePending),
              update: jest.fn(),
            },
            settlementLine: {
              count: jest.fn().mockResolvedValue(0),
              createMany: jest.fn(),
            },
          };
          return fn(tx);
        }),
      };

      const service = makeService(prisma);
      const result = await service.acceptProposal(senderPrincipal, 'job-1', 'prop-1');

      expect(stripe.createPaymentIntent).toHaveBeenCalled();
      expect(trips.ensureTripForAssignment).toHaveBeenCalledWith('asg-1');
      expect(result).toMatchObject({
        paymentEventId: 'pe-1',
        paidAndConfirmed: true,
        assignmentStatus: AssignmentStatus.LOCKED,
        stripeStatus: 'succeeded',
        mock: true,
        clientSecret: 'cs_ok',
      });
    });
  });

  describe('handleStripeWebhook mock mode', () => {
    it('returns duplicate when event already recorded', async () => {
      const prisma = {
        isConnected: () => true,
        stripeWebhookEvent: {
          findUnique: jest.fn().mockResolvedValue({ id: 'row-1' }),
          create: jest.fn(),
        },
      };
      const service = makeService(prisma);
      const body = Buffer.from(
        JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' }),
      );
      await expect(service.handleStripeWebhook(body, undefined)).resolves.toEqual({
        received: true,
        duplicate: true,
      });
      expect(prisma.stripeWebhookEvent.create).not.toHaveBeenCalled();
    });

    it('rejects invalid JSON in mock mode', async () => {
      const service = makeService({ isConnected: () => true });
      await expect(
        service.handleStripeWebhook(Buffer.from('not-json'), undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('resolves succeeded via metadata paymentEventId then records', async () => {
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
            status: AssignmentStatus.PENDING,
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
      const service = makeService(prisma);
      const body = Buffer.from(
        JSON.stringify({
          id: 'evt_new',
          type: 'payment_intent.succeeded',
          data: {
            object: {
              id: 'pi_1',
              metadata: { paymentEventId: 'pe-1' },
            },
          },
        }),
      );
      await expect(service.handleStripeWebhook(body, undefined)).resolves.toEqual({
        received: true,
        mock: true,
      });
      expect(prisma.stripeWebhookEvent.create).toHaveBeenCalled();
      expect(trips.ensureTripForAssignment).toHaveBeenCalled();
    });
  });

  describe('refundStub', () => {
    it('rejects non-sender non-admin principals', async () => {
      const service = makeService({ isConnected: () => true });
      await expect(
        service.refundStub(
          { ...senderPrincipal, role: 'DRIVER' },
          'job-1',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
