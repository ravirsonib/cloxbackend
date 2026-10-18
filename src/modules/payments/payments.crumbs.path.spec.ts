import { NotFoundException } from '@nestjs/common';
import {
  AssignmentStatus,
  JobStatus,
  PaymentEventStatus,
  ProposalStatus,
  SurchargeKind,
  SurchargeStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { PaymentsService } from './payments.service';

const sender: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('PaymentsService crumb branch leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createPaymentIntent: jest.fn(),
    cancelPaymentIntent: jest.fn().mockResolvedValue(undefined),
    createRefundStub: jest.fn(),
    publishableKey: jest.fn().mockReturnValue('pk_test'),
    isMockMode: jest.fn().mockReturnValue(true),
    retrievePaymentIntentClientSecret: jest.fn(),
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

  const senderUser = {
    id: 'user-sender',
    companyId: 'co-s',
    company: {
      id: 'co-s',
      paymentReady: true,
      stripeCustomerId: 'cus_1',
      stripeDefaultPaymentMethodId: 'pm_1',
    },
  };

  function acceptPrisma() {
    const assignment = {
      id: 'asg-1',
      status: AssignmentStatus.PENDING,
      lockedAt: null as Date | null,
    };
    const pePending = {
      id: 'pe-1',
      jobId: 'job-1',
      status: PaymentEventStatus.PENDING,
      amountIncGstCents: 1100,
      amountExGstCents: 1000,
      amountGstCents: 100,
      stripePaymentIntentId: null as string | null,
      metadata: { proposalId: 'prop-1', assignmentId: 'asg-1', conflictIds: [] as string[] },
    };
    return {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue(senderUser) },
      paymentEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
          ...pePending,
          ...data,
        })),
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
              vehicleId: null,
              driverId: null,
              amountIncGstCents: 1100,
              amountExGstCents: 1000,
              amountGstCents: 100,
            },
          ],
        }),
      },
      assignment: { findUnique: jest.fn().mockResolvedValue(assignment) },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          assignment: {
            create: jest.fn().mockResolvedValue(assignment),
            update: jest.fn(),
            updateMany: jest.fn(),
            findUnique: jest.fn().mockResolvedValue(assignment),
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
  }

  beforeEach(() => jest.clearAllMocks());

  it('acceptProposal requires_action message + live succeeded pi_immediate', async () => {
    stripe.createPaymentIntent.mockResolvedValueOnce({
      id: 'pi_sca',
      status: 'requires_action',
      clientSecret: 'cs_sca',
      mock: true,
    });
    const sca = await makeService(acceptPrisma()).acceptProposal(sender, 'job-1', 'prop-1');
    expect(sca).toMatchObject({
      stripeStatus: 'requires_action',
      message: 'Complete SCA with clientSecret',
    });

    stripe.createPaymentIntent.mockResolvedValueOnce({
      id: 'pi_live',
      status: 'succeeded',
      clientSecret: 'cs_ok',
      mock: false,
    });
    const prisma = acceptPrisma();
    prisma.paymentEvent.findUnique = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'pe-1',
        jobId: 'job-1',
        status: PaymentEventStatus.PENDING,
        metadata: null,
        stripePaymentIntentId: null,
      });
    prisma.assignment.findUnique = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'asg-1',
        status: AssignmentStatus.LOCKED,
        lockedAt: new Date(),
      })
      .mockResolvedValue({
        id: 'asg-1',
        status: AssignmentStatus.LOCKED,
        lockedAt: new Date(),
      });
    const live = await makeService(prisma).acceptProposal(sender, 'job-1', 'prop-1');
    expect(live).toMatchObject({
      stripeStatus: 'succeeded',
      mock: false,
      message: 'Payment succeeded — assignment locked',
    });
    expect(trips.ensureTripForAssignment).toHaveBeenCalled();
  });

  it('createSurcharge accrues WAITING with null metadata then post-PI sibling on PAID', async () => {
    const existingNoPi = {
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
      idempotencyKey: 'waiting:trip-1',
      paidAt: null,
      waivedAt: null,
      metadata: null,
      paymentEvent: {
        id: 'pe-1',
        stripePaymentIntentId: null,
        metadata: null,
      },
    };
    const prismaAccrue = {
      isConnected: () => true,
      surcharge: {
        findUnique: jest.fn().mockResolvedValue(existingNoPi),
        update: jest.fn(),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          paymentEvent: { update: jest.fn() },
          surcharge: {
            update: jest.fn().mockResolvedValue({
              ...existingNoPi,
              amountIncGstCents: 220,
              amountExGstCents: 200,
              amountGstCents: 20,
              paymentEvent: existingNoPi.paymentEvent,
            }),
          },
        };
        return fn(tx);
      }),
    };
    const accrued = await makeService(prismaAccrue).createSurcharge({
      jobId: 'job-1',
      tripId: 'trip-1',
      kind: SurchargeKind.WAITING,
      amountIncGstCents: 220,
      idempotencyKey: 'waiting:trip-1',
      chargeNow: false,
    });
    expect(accrued.amountIncGstCents).toBe(220);

    const existingPaid = {
      ...existingNoPi,
      status: SurchargeStatus.PAID,
      amountIncGstCents: 110,
      paymentEvent: {
        id: 'pe-1',
        stripePaymentIntentId: 'pi_wait',
        metadata: { a: 1 },
      },
    };
    const createdSibling = {
      id: 's-2',
      jobId: 'job-1',
      tripId: 'trip-1',
      kind: SurchargeKind.WAITING,
      status: SurchargeStatus.PENDING_PAYMENT,
      amountExGstCents: 100,
      amountGstCents: 10,
      amountIncGstCents: 110,
      paymentEventId: 'pe-2',
      stopProgressId: null,
      idempotencyKey: 'waiting:trip-1:postpi:220',
      paidAt: null,
      waivedAt: null,
      metadata: { postPi: true },
      paymentEvent: { id: 'pe-2', stripePaymentIntentId: null },
    };
    const prismaSibling = {
      isConnected: () => true,
      surcharge: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(existingPaid)
          .mockResolvedValueOnce(null),
        create: jest.fn(),
      },
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          senderCompany: {
            id: 'co-s',
            stripeCustomerId: 'cus_1',
            stripeDefaultPaymentMethodId: 'pm_1',
          },
        }),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          paymentEvent: {
            create: jest.fn().mockResolvedValue({ id: 'pe-2' }),
          },
          surcharge: {
            create: jest.fn().mockResolvedValue(createdSibling),
          },
        };
        return { surcharge: createdSibling, paymentEvent: { id: 'pe-2' } };
      }),
    };
    const sibling = await makeService(prismaSibling).createSurcharge({
      jobId: 'job-1',
      tripId: 'trip-1',
      kind: SurchargeKind.WAITING,
      amountIncGstCents: 220,
      idempotencyKey: 'waiting:trip-1',
      chargeNow: false,
      metadata: { dwell: true },
    });
    expect(sibling).toMatchObject({ id: 's-2', amountIncGstCents: 110 });
  });

  it('chargeSurcharge 404 when surcharge row missing', async () => {
    await expect(
      makeService({
        isConnected: () => true,
        surcharge: { findUnique: jest.fn().mockResolvedValue(null) },
      }).chargeSurcharge('missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('chargeSurcharge WAIVED short-circuit + succeeded live source', async () => {
    const waived = {
      id: 's-1',
      jobId: 'job-1',
      tripId: 'trip-1',
      kind: SurchargeKind.WAITING,
      status: SurchargeStatus.WAIVED,
      amountExGstCents: 100,
      amountGstCents: 10,
      amountIncGstCents: 110,
      paymentEventId: 'pe-1',
      stopProgressId: null,
      idempotencyKey: 'k',
      paidAt: null,
      waivedAt: new Date(),
      metadata: null,
      paymentEvent: { id: 'pe-1', status: PaymentEventStatus.CANCELLED },
      job: { senderCompany: { stripeCustomerId: 'cus_1' } },
    };
    await expect(
      makeService({
        isConnected: () => true,
        surcharge: { findUnique: jest.fn().mockResolvedValue(waived) },
      }).chargeSurcharge('s-1'),
    ).resolves.toMatchObject({ status: SurchargeStatus.WAIVED });

    stripe.createPaymentIntent.mockResolvedValue({
      id: 'pi_ok',
      status: 'succeeded',
      clientSecret: 'cs',
      mock: false,
    });
    const pending = {
      ...waived,
      status: SurchargeStatus.PENDING_PAYMENT,
      waivedAt: null,
      paymentEvent: {
        id: 'pe-1',
        status: PaymentEventStatus.PENDING,
        metadata: {},
        stripePaymentIntentId: null,
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
          .mockResolvedValueOnce(pending)
          .mockResolvedValueOnce({ ...pending, status: SurchargeStatus.PAID }),
        update: jest.fn().mockResolvedValue({}),
      },
      paymentEvent: {
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({
          id: 'pe-1',
          type: 'SURCHARGE',
          status: PaymentEventStatus.PENDING,
          stripePaymentIntentId: 'pi_ok',
          surcharge: {
            id: 's-1',
            status: SurchargeStatus.PENDING_PAYMENT,
            kind: SurchargeKind.WAITING,
            tripId: 'trip-1',
          },
        }),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          paymentEvent: { update: jest.fn().mockResolvedValue({}) },
          surcharge: { update: jest.fn().mockResolvedValue({}) },
          trip: { update: jest.fn().mockResolvedValue({}) },
        };
        return fn(tx);
      }),
    };
    const result = await makeService(prisma).chargeSurcharge('s-1');
    expect(result).toMatchObject({ mock: false, stripeStatus: 'succeeded' });
  });
});
