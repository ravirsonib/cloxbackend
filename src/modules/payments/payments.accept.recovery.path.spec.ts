import { AssignmentStatus, PaymentEventStatus, PaymentEventType } from '@prisma/client';
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

describe('PaymentsService acceptProposal recovery leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createPaymentIntent: jest.fn(),
    cancelPaymentIntent: jest.fn().mockResolvedValue(undefined),
    publishableKey: jest.fn().mockReturnValue('pk_test'),
    retrievePaymentIntentStatus: jest.fn(),
    retrievePaymentIntentClientSecret: jest.fn(),
    isMockMode: jest.fn().mockReturnValue(true),
  };
  const trips = { ensureTripForAssignment: jest.fn().mockResolvedValue({ id: 'trip-1' }) };

  function makeService(prisma: Record<string, unknown>) {
    return new PaymentsService(
      prisma as never,
      audit as never,
      stripe as never,
      trips as never,
    );
  }

  function senderUser() {
    return {
      id: 'user-sender',
      companyId: 'co-s',
      company: {
        id: 'co-s',
        paymentReady: true,
        stripeCustomerId: 'cus_1',
        stripeDefaultPaymentMethodId: 'pm_1',
      },
    };
  }

  function existingPe(overrides: Record<string, unknown> = {}) {
    return {
      id: 'pe-1',
      jobId: 'job-1',
      type: PaymentEventType.CHARGE,
      status: PaymentEventStatus.REQUIRES_ACTION,
      amountIncGstCents: 11000,
      stripePaymentIntentId: 'pi_stuck',
      createdAt: new Date(),
      idempotencyKey: 'accept:job-1:prop-1',
      metadata: {
        proposalId: 'prop-1',
        assignmentId: 'asg-1',
        conflictIds: ['prop-2'],
      },
      job: {
        assignment: {
          id: 'asg-1',
          status: AssignmentStatus.PENDING,
          lockedAt: null,
        },
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('replay when live PI already succeeded → markPaidAndLock', async () => {
    stripe.retrievePaymentIntentStatus.mockResolvedValue('succeeded');
    const pePending = existingPe();
    const peLocked = existingPe({
      status: PaymentEventStatus.SUCCEEDED,
      job: {
        assignment: {
          id: 'asg-1',
          status: AssignmentStatus.LOCKED,
          lockedAt: new Date(),
        },
      },
    });
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue(senderUser()) },
      paymentEvent: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(pePending)
          .mockResolvedValueOnce(pePending)
          .mockResolvedValueOnce(peLocked),
      },
      assignment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'asg-1',
          status: AssignmentStatus.LOCKED,
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

    const result = await makeService(prisma).acceptProposal(sender, 'job-1', 'prop-1');
    expect(result).toMatchObject({
      paymentEventId: 'pe-1',
      paidAndConfirmed: true,
      idempotentReplay: true,
    });
    expect(trips.ensureTripForAssignment).toHaveBeenCalled();
  });

  it('unwinds when Stripe PI is canceled (deadPi)', async () => {
    stripe.retrievePaymentIntentStatus.mockResolvedValue('canceled');
    const pe = existingPe();
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue(senderUser()) },
      paymentEvent: {
        findUnique: jest.fn().mockResolvedValueOnce(pe).mockResolvedValue(null),
        delete: jest.fn(),
      },
      job: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          assignment: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'asg-1',
              status: AssignmentStatus.PENDING,
            }),
            delete: jest.fn(),
          },
          proposal: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'prop-1',
              status: 'ACCEPTED',
            }),
            update: jest.fn(),
            updateMany: jest.fn(),
          },
          job: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'job-1',
              status: 'ASSIGNED',
            }),
            update: jest.fn(),
          },
          paymentEvent: { delete: jest.fn() },
        };
        return fn(tx);
      }),
    };

    await expect(
      makeService(prisma).acceptProposal(sender, 'job-1', 'prop-1'),
    ).rejects.toThrow(/Job not found/);
    expect(stripe.retrievePaymentIntentStatus).toHaveBeenCalledWith('pi_stuck');
    expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_stuck');
  });
  it('unwinds FAILED PE without Stripe status check', async () => {
    const pe = existingPe({
      status: PaymentEventStatus.FAILED,
      stripePaymentIntentId: 'pi_fail',
    });
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue(senderUser()) },
      paymentEvent: {
        findUnique: jest.fn().mockResolvedValueOnce(pe).mockResolvedValue(null),
        delete: jest.fn(),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          assignment: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'asg-1',
              status: AssignmentStatus.PENDING,
            }),
            delete: jest.fn(),
          },
          proposal: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'prop-1',
              status: 'ACCEPTED',
            }),
            update: jest.fn(),
            updateMany: jest.fn(),
          },
          job: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'job-1',
              status: 'ASSIGNED',
            }),
            update: jest.fn(),
          },
          paymentEvent: { delete: jest.fn() },
        };
        return fn(tx);
      }),
    };

    await expect(
      makeService(prisma).acceptProposal(sender, 'job-1', 'prop-1'),
    ).rejects.toThrow(/Job not found/);
    expect(stripe.retrievePaymentIntentStatus).not.toHaveBeenCalled();
    expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_fail');
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ unwound: true }),
      }),
    );
  });
});
