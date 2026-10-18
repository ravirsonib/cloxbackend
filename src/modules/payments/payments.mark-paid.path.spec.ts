import {
  AssignmentStatus,
  JobStatus,
  PaymentEventStatus,
  PaymentEventType,
  SettlementLineStatus,
  SettlementRecipientType,
} from '@prisma/client';
import { PaymentsService } from './payments.service';

describe('PaymentsService markPaidAndLock leftover paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    isMockMode: jest.fn().mockReturnValue(true),
    cancelPaymentIntent: jest.fn(),
    createPaymentIntent: jest.fn(),
    createRefundStub: jest.fn(),
  };
  const trips = {
    ensureTripForAssignment: jest.fn().mockResolvedValue({ id: 'trip-1' }),
  };

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

  it('skips when payment event missing job', async () => {
    const prisma = {
      isConnected: () => true,
      paymentEvent: {
        findUnique: jest.fn().mockResolvedValue({ id: 'pe-1', jobId: null }),
      },
    };
    await expect(
      makeService(prisma).markPaidAndLock({
        paymentEventId: 'pe-1',
        paymentIntentId: 'pi_1',
        source: 'test',
      }),
    ).resolves.toEqual({ skipped: true });
  });

  it('already SUCCEEDED + LOCKED ensures trip and skips', async () => {
    const prisma = {
      isConnected: () => true,
      paymentEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pe-1',
          jobId: 'job-1',
          status: PaymentEventStatus.SUCCEEDED,
          amountIncGstCents: 11000,
          metadata: {},
        }),
      },
      assignment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'asg-1',
          status: AssignmentStatus.LOCKED,
        }),
      },
    };
    await expect(
      makeService(prisma).markPaidAndLock({
        paymentEventId: 'pe-1',
        paymentIntentId: 'pi_1',
        source: 'webhook',
      }),
    ).resolves.toEqual({ skipped: true, alreadyPaid: true });
    expect(trips.ensureTripForAssignment).toHaveBeenCalledWith('asg-1');
  });

  it('locks assignment, accrues settlement lines, ensures trip', async () => {
    const tx = {
      paymentEvent: { update: jest.fn().mockResolvedValue({}) },
      assignment: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      job: { update: jest.fn().mockResolvedValue({}) },
      settlementLine: {
        count: jest.fn().mockResolvedValue(0),
        createMany: jest.fn().mockResolvedValue({ count: 4 }),
      },
    };
    const prisma = {
      isConnected: () => true,
      paymentEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pe-1',
          jobId: 'job-1',
          status: PaymentEventStatus.PENDING,
          amountIncGstCents: 10000,
          type: PaymentEventType.CHARGE,
          metadata: { assignmentId: 'asg-1' },
        }),
      },
      assignment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'asg-1',
          status: AssignmentStatus.LOCKED,
        }),
      },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
    };

    await expect(
      makeService(prisma).markPaidAndLock({
        paymentEventId: 'pe-1',
        paymentIntentId: 'pi_live',
        source: 'accept',
      }),
    ).resolves.toEqual({ skipped: false });

    expect(tx.assignment.update).toHaveBeenCalledWith({
      where: { id: 'asg-1' },
      data: expect.objectContaining({ status: AssignmentStatus.LOCKED }),
    });
    expect(tx.job.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { status: JobStatus.ASSIGNED },
    });
    expect(tx.settlementLine.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          recipientType: SettlementRecipientType.CARRIER,
          sharePercent: 70,
          status: SettlementLineStatus.ACCRUED,
        }),
      ]),
    });
    expect(trips.ensureTripForAssignment).toHaveBeenCalledWith('asg-1');
    expect(audit.recordPlatform).toHaveBeenCalled();
  });

  it('uses updateMany when metadata lacks assignmentId', async () => {
    const tx = {
      paymentEvent: { update: jest.fn().mockResolvedValue({}) },
      assignment: {
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      job: { update: jest.fn().mockResolvedValue({}) },
      settlementLine: {
        count: jest.fn().mockResolvedValue(2),
        createMany: jest.fn(),
      },
    };
    const prisma = {
      isConnected: () => true,
      paymentEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pe-1',
          jobId: 'job-1',
          status: PaymentEventStatus.PENDING,
          amountIncGstCents: 10000,
          metadata: {},
        }),
      },
      assignment: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
    };

    await expect(
      makeService(prisma).markPaidAndLock({
        paymentEventId: 'pe-1',
        paymentIntentId: 'pi_2',
        source: 'webhook',
      }),
    ).resolves.toEqual({ skipped: false });
    expect(tx.assignment.updateMany).toHaveBeenCalled();
    expect(tx.settlementLine.createMany).not.toHaveBeenCalled();
    expect(trips.ensureTripForAssignment).not.toHaveBeenCalled();
  });
});
