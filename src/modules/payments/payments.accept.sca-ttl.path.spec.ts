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

/** ACCEPT_SCA_TTL_MS = 45 minutes */
const STALE_CREATED_AT = new Date(Date.now() - 46 * 60 * 1000);

describe('PaymentsService acceptProposal SCA TTL leftover', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createPaymentIntent: jest.fn(),
    cancelPaymentIntent: jest.fn().mockResolvedValue(undefined),
    publishableKey: jest.fn().mockReturnValue('pk_test'),
    retrievePaymentIntentStatus: jest.fn(),
    retrievePaymentIntentClientSecret: jest.fn().mockResolvedValue('cs_live'),
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
      stripePaymentIntentId: 'pi_stale',
      createdAt: STALE_CREATED_AT,
      idempotencyKey: 'accept:job-1:prop-1',
      metadata: {
        proposalId: 'prop-1',
        assignmentId: 'asg-1',
        conflictIds: [] as string[],
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

  function unwindTx() {
    return jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
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
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('unwinds when SCA TTL expired and PI is not mid-SCA', async () => {
    stripe.retrievePaymentIntentStatus.mockResolvedValue('requires_payment_method');
    const pe = existingPe();
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue(senderUser()) },
      paymentEvent: {
        findUnique: jest.fn().mockResolvedValueOnce(pe).mockResolvedValue(null),
        delete: jest.fn(),
      },
      job: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: unwindTx(),
    };

    await expect(
      makeService(prisma).acceptProposal(sender, 'job-1', 'prop-1'),
    ).rejects.toThrow(/Job not found/);
    expect(stripe.retrievePaymentIntentStatus).toHaveBeenCalledWith('pi_stale');
    expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_stale');
  });

  it('keeps waiting when SCA TTL expired but PI still requires_action', async () => {
    stripe.retrievePaymentIntentStatus.mockResolvedValue('requires_action');
    const pe = existingPe();
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue(senderUser()) },
      paymentEvent: { findUnique: jest.fn().mockResolvedValue(pe) },
      $transaction: jest.fn(),
    };

    const result = await makeService(prisma).acceptProposal(sender, 'job-1', 'prop-1');
    expect(result).toMatchObject({
      paymentEventId: 'pe-1',
      clientSecret: 'cs_live',
      publishableKey: 'pk_test',
      idempotentReplay: true,
    });
    expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('keeps waiting when SCA TTL expired but PI is processing', async () => {
    stripe.retrievePaymentIntentStatus.mockResolvedValue('processing');
    const pe = existingPe({ status: PaymentEventStatus.PENDING });
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue(senderUser()) },
      paymentEvent: { findUnique: jest.fn().mockResolvedValue(pe) },
    };

    const result = await makeService(prisma).acceptProposal(sender, 'job-1', 'prop-1');
    expect(result).toMatchObject({
      paymentEventId: 'pe-1',
      clientSecret: 'cs_live',
      idempotentReplay: true,
    });
    expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
  });
});
