import {
  AssignmentStatus,
  JobStatus,
  PaymentEventStatus,
  ProposalStatus,
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

describe('PaymentsService acceptProposal conflict-peer expire leftover', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createPaymentIntent: jest.fn().mockResolvedValue({
      id: 'pi_ok',
      status: 'succeeded',
      clientSecret: 'cs_ok',
      mock: true,
    }),
    cancelPaymentIntent: jest.fn(),
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

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('expires conflicting same-job / vehicle / driver proposals', async () => {
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
        conflictIds: ['prop-peer', 'prop-veh', 'prop-drv'],
      },
    };
    const lockedAssignment = {
      id: 'asg-1',
      status: AssignmentStatus.LOCKED,
      lockedAt: new Date(),
    };
    let proposalUpdateMany: jest.Mock;

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
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            ...pePending,
            stripePaymentIntentId: 'pi_ok',
            status: PaymentEventStatus.SUCCEEDED,
            metadata: pePending.metadata,
          }),
        update: jest.fn().mockResolvedValue({
          ...pePending,
          stripePaymentIntentId: 'pi_ok',
          status: PaymentEventStatus.SUCCEEDED,
        }),
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
      },
      assignment: {
        findUnique: jest.fn().mockResolvedValue(lockedAssignment),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        proposalUpdateMany = jest.fn();
        const tx = {
          assignment: {
            create: jest.fn().mockResolvedValue(assignment),
            update: jest.fn(),
            updateMany: jest.fn(),
          },
          proposal: {
            update: jest.fn(),
            findMany: jest.fn().mockResolvedValue([
              { id: 'prop-peer' },
              { id: 'prop-veh' },
              { id: 'prop-drv' },
            ]),
            updateMany: proposalUpdateMany,
          },
          job: { update: jest.fn() },
          paymentEvent: {
            create: jest.fn().mockResolvedValue(pePending),
            update: jest.fn(),
          },
          settlementLine: {
            count: jest.fn().mockResolvedValue(1),
            createMany: jest.fn(),
          },
        };
        return fn(tx);
      }),
    };

    const result = await makeService(prisma).acceptProposal(sender, 'job-1', 'prop-1');
    expect(proposalUpdateMany!).toHaveBeenCalledWith({
      where: { id: { in: ['prop-peer', 'prop-veh', 'prop-drv'] } },
      data: { status: ProposalStatus.EXPIRED },
    });
    expect(result).toMatchObject({
      paymentEventId: 'pe-1',
      paidAndConfirmed: true,
    });
  });
});
