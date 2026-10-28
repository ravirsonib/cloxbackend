import {
  PaymentEventStatus,
  PaymentEventType,
  SettlementLineStatus,
} from '@prisma/client';
import { PaymentsService } from './payments.service';

describe('PaymentsService.adjustForMarketplaceRelease', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createTransferReversal: jest.fn().mockResolvedValue({
      id: 'trr_1',
      status: 'succeeded',
      mock: true,
    }),
    createRefundStub: jest.fn(),
    isMockMode: jest.fn().mockReturnValue(true),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new PaymentsService(
      prisma as never,
      audit as never,
      stripe as never,
      {} as never,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('returns NO_CHARGE when no succeeded fare', async () => {
    const prisma = {
      isConnected: () => true,
      paymentEvent: { findFirst: jest.fn().mockResolvedValue(null) },
      settlementLine: { updateMany: jest.fn() },
    };
    const result = await makeService(prisma).adjustForMarketplaceRelease('job-1');
    expect(result.status).toBe('NO_CHARGE');
    expect(prisma.settlementLine.updateMany).not.toHaveBeenCalled();
  });

  it('holds fare and voids settlements when no carrier transfer yet', async () => {
    const charge = {
      id: 'pe-charge',
      type: PaymentEventType.CHARGE,
      status: PaymentEventStatus.SUCCEEDED,
      amountIncGstCents: 11000,
    };
    const prisma = {
      isConnected: () => true,
      paymentEvent: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(charge) // charge
          .mockResolvedValueOnce(null) // prior reversal
          .mockResolvedValueOnce(null), // transfer
      },
      settlementLine: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    };
    const result = await makeService(prisma).adjustForMarketplaceRelease('job-1');
    expect(result).toMatchObject({
      status: 'HELD',
      amountCents: 11000,
      transferId: null,
      reversalId: null,
    });
    expect(stripe.createTransferReversal).not.toHaveBeenCalled();
    expect(prisma.settlementLine.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          jobId: 'job-1',
          status: {
            in: [
              SettlementLineStatus.ACCRUED,
              SettlementLineStatus.PAYABLE,
              SettlementLineStatus.PAID,
            ],
          },
        },
        data: { status: SettlementLineStatus.VOID },
      }),
    );
  });

  it('reverses carrier transfer and records TRANSFER_REVERSAL', async () => {
    const charge = {
      id: 'pe-charge',
      type: PaymentEventType.CHARGE,
      status: PaymentEventStatus.SUCCEEDED,
      amountIncGstCents: 11000,
    };
    const transfer = {
      id: 'pe-tr',
      type: PaymentEventType.TRANSFER,
      status: PaymentEventStatus.SUCCEEDED,
      stripeTransferId: 'tr_1',
      amountExGstCents: 10000,
      amountGstCents: 1000,
      amountIncGstCents: 11000,
      currency: 'aud',
    };
    const prisma = {
      isConnected: () => true,
      paymentEvent: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(charge)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(transfer),
        create: jest.fn().mockResolvedValue({ id: 'pe-rev' }),
      },
      settlementLine: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const result = await makeService(prisma).adjustForMarketplaceRelease('job-1');
    expect(result).toMatchObject({
      status: 'REVERSED',
      transferId: 'tr_1',
      reversalId: 'trr_1',
      amountCents: 11000,
      mock: true,
    });
    expect(stripe.createTransferReversal).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: 'tr_1',
        amountCents: 11000,
        idempotencyKey: 'transfer-reversal:job-1:tr_1',
      }),
    );
    expect(prisma.paymentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: PaymentEventType.TRANSFER_REVERSAL,
          stripeRefundId: 'trr_1',
          stripeTransferId: 'tr_1',
        }),
      }),
    );
    expect(audit.recordPlatform).toHaveBeenCalled();
  });

  it('returns ALREADY_ADJUSTED when prior reversal exists', async () => {
    const charge = {
      id: 'pe-charge',
      type: PaymentEventType.CHARGE,
      status: PaymentEventStatus.SUCCEEDED,
      amountIncGstCents: 11000,
    };
    const prior = {
      id: 'pe-rev',
      type: PaymentEventType.TRANSFER_REVERSAL,
      status: PaymentEventStatus.SUCCEEDED,
      stripeRefundId: 'trr_prior',
    };
    const transfer = {
      id: 'pe-tr',
      stripeTransferId: 'tr_1',
      amountIncGstCents: 11000,
    };
    const prisma = {
      isConnected: () => true,
      paymentEvent: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(charge)
          .mockResolvedValueOnce(prior)
          .mockResolvedValueOnce(transfer),
        create: jest.fn(),
      },
      settlementLine: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const result = await makeService(prisma).adjustForMarketplaceRelease('job-1');
    expect(result.status).toBe('ALREADY_ADJUSTED');
    expect(result.reversalId).toBe('trr_prior');
    expect(stripe.createTransferReversal).not.toHaveBeenCalled();
    expect(prisma.paymentEvent.create).not.toHaveBeenCalled();
  });

  it('throws TRANSFER_REVERSAL_FAILED when Stripe reversal errors', async () => {
    stripe.createTransferReversal.mockRejectedValueOnce(new Error('stripe down'));
    const charge = {
      id: 'pe-charge',
      type: PaymentEventType.CHARGE,
      status: PaymentEventStatus.SUCCEEDED,
      amountIncGstCents: 11000,
    };
    const transfer = {
      id: 'pe-tr',
      stripeTransferId: 'tr_1',
      amountExGstCents: 10000,
      amountGstCents: 1000,
      amountIncGstCents: 11000,
      currency: 'aud',
    };
    const prisma = {
      isConnected: () => true,
      paymentEvent: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(charge)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(transfer),
      },
      settlementLine: { updateMany: jest.fn() },
    };
    await expect(
      makeService(prisma).adjustForMarketplaceRelease('job-1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TRANSFER_REVERSAL_FAILED' }),
    });
    expect(prisma.settlementLine.updateMany).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.refundStub with marketplace release', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createTransferReversal: jest.fn().mockResolvedValue({
      id: 'trr_1',
      status: 'succeeded',
      mock: true,
    }),
    createRefundStub: jest.fn().mockResolvedValue({ id: 're_1', mock: true }),
    isMockMode: jest.fn().mockReturnValue(true),
  };
  const sender = {
    id: 'user-sender',
    email: 's@yopmail.com',
    role: 'SENDER' as const,
    kind: 'user' as const,
    regionCodes: [] as string[],
    territoryCodes: [] as string[],
  };

  function makeService(prisma: Record<string, unknown>) {
    return new PaymentsService(
      prisma as never,
      audit as never,
      stripe as never,
      {} as never,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  function refundPrisma(transfer: {
    id: string;
    stripeTransferId: string;
    amountExGstCents: number;
    amountGstCents: number;
    amountIncGstCents: number;
    currency: string;
  } | null) {
    const charge = {
      id: 'pe-1',
      stripePaymentIntentId: 'pi_1',
      type: PaymentEventType.CHARGE,
      status: PaymentEventStatus.SUCCEEDED,
      amountExGstCents: 10000,
      amountGstCents: 1000,
      amountIncGstCents: 11000,
      currency: 'aud',
    };
    return {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-s' }),
      },
      job: { findFirst: jest.fn().mockResolvedValue({ id: 'job-1' }) },
      paymentEvent: {
        findFirst: jest.fn().mockImplementation((args: { where?: { type?: string } }) => {
          const type = args?.where?.type;
          if (type === PaymentEventType.CHARGE) return Promise.resolve(charge);
          if (type === PaymentEventType.TRANSFER_REVERSAL) return Promise.resolve(null);
          if (type === PaymentEventType.TRANSFER) return Promise.resolve(transfer);
          if (type === PaymentEventType.REFUND) return Promise.resolve(null);
          return Promise.resolve(null);
        }),
        create: jest.fn().mockResolvedValue({ id: 'pe-new' }),
      },
      settlementLine: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
  }

  it('reverses transfer then refunds sender', async () => {
    const prisma = refundPrisma({
      id: 'pe-tr',
      stripeTransferId: 'tr_1',
      amountExGstCents: 10000,
      amountGstCents: 1000,
      amountIncGstCents: 11000,
      currency: 'aud',
    });

    const result = await makeService(prisma).refundStub(sender, 'job-1');
    expect(result).toMatchObject({ success: true, refundId: 're_1', mock: true });
    expect(stripe.createTransferReversal).toHaveBeenCalled();
    expect(stripe.createRefundStub).toHaveBeenCalled();
  });

  it('ignores adjust failure and still attempts refund', async () => {
    stripe.createTransferReversal.mockRejectedValueOnce(new Error('stripe down'));
    const prisma = refundPrisma({
      id: 'pe-tr',
      stripeTransferId: 'tr_1',
      amountExGstCents: 10000,
      amountGstCents: 1000,
      amountIncGstCents: 11000,
      currency: 'aud',
    });

    const result = await makeService(prisma).refundStub(sender, 'job-1');
    expect(result.refundId).toBe('re_1');
    expect(stripe.createRefundStub).toHaveBeenCalled();
  });
});

