import {
  PaymentEventStatus,
  PaymentEventType,
  SettlementLineStatus,
  SettlementRecipientType,
  SurchargeKind,
  SurchargeStatus,
} from '@prisma/client';
import { PaymentsService } from './payments.service';

describe('PaymentsService surcharge settlement accrual + carrier transfer', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    cancelPaymentIntent: jest.fn().mockResolvedValue(undefined),
    createRefundStub: jest.fn().mockResolvedValue({ id: 're_1', mock: true }),
    createPaymentIntent: jest.fn(),
    createTransfer: jest.fn().mockResolvedValue({ id: 'tr_1', mock: true }),
    isMockMode: jest.fn().mockReturnValue(true),
  };
  const trips = { ensureTripForAssignment: jest.fn() };

  function makeService(
    prisma: Record<string, unknown>,
    revenueSplit?: { resolveForJob: jest.Mock },
  ) {
    return new PaymentsService(
      prisma as never,
      audit as never,
      stripe as never,
      trips as never,
      undefined,
      undefined,
      revenueSplit as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('markSurchargePaid settlement accrual', () => {
    it('accrues 100% carrier SettlementLine for WAITING surcharge (no CLOX split)', async () => {
      const tx = {
        paymentEvent: { update: jest.fn() },
        surcharge: { update: jest.fn() },
        trip: { update: jest.fn() },
        settlementLine: { createMany: jest.fn() },
      };
      const prisma = {
        paymentEvent: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'pe-w',
            stripePaymentIntentId: 'pi_w',
            status: PaymentEventStatus.PENDING,
            surcharge: {
              id: 's-w',
              status: SurchargeStatus.PENDING_PAYMENT,
              kind: SurchargeKind.WAITING,
              tripId: 'trip-1',
              jobId: 'job-1',
              amountIncGstCents: 10_000,
              metadata: { waitOverageMinutes: 10 },
            },
          }),
        },
        $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
      };

      const result = await makeService(prisma).markSurchargePaid({
        paymentEventId: 'pe-w',
        paymentIntentId: 'pi_w',
        source: 'webhook',
      });

      expect(result).toEqual({ skipped: false });
      expect(tx.settlementLine.createMany).toHaveBeenCalledWith({
        data: [
          {
            jobId: 'job-1',
            recipientType: SettlementRecipientType.CARRIER,
            sharePercent: 100,
            amountCents: 10_000,
            status: SettlementLineStatus.ACCRUED,
          },
        ],
      });
      expect(tx.surcharge.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 's-w' },
          data: expect.objectContaining({
            metadata: expect.objectContaining({
              settlementAccrued: true,
              surchargeSettlement: 'CARRIER_100',
            }),
          }),
        }),
      );
    });

    it('does not call RevenueSplitService for surcharge accrual (carrier 100%)', async () => {
      const tx = {
        paymentEvent: { update: jest.fn() },
        surcharge: { update: jest.fn() },
        trip: { update: jest.fn() },
        settlementLine: { createMany: jest.fn() },
      };
      const prisma = {
        paymentEvent: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'pe-r',
            stripePaymentIntentId: 'pi_r',
            status: PaymentEventStatus.PENDING,
            surcharge: {
              id: 's-r',
              status: SurchargeStatus.PENDING_PAYMENT,
              kind: SurchargeKind.MASS,
              tripId: 'trip-1',
              jobId: 'job-1',
              amountIncGstCents: 5000,
              metadata: null,
            },
          }),
        },
        $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
      };
      const revenueSplit = {
        resolveForJob: jest.fn(),
      };

      await makeService(prisma, revenueSplit).markSurchargePaid({
        paymentEventId: 'pe-r',
        paymentIntentId: 'pi_r',
        source: 'webhook',
      });

      expect(revenueSplit.resolveForJob).not.toHaveBeenCalled();
      expect(tx.settlementLine.createMany).toHaveBeenCalledWith({
        data: [
          {
            jobId: 'job-1',
            recipientType: SettlementRecipientType.CARRIER,
            sharePercent: 100,
            amountCents: 5000,
            status: SettlementLineStatus.ACCRUED,
          },
        ],
      });
    });

    it('does not double-accrue when alreadyPaid and settlementAccrued', async () => {
      const prisma = {
        paymentEvent: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'pe-1',
            surcharge: {
              id: 's-1',
              status: SurchargeStatus.PAID,
              kind: SurchargeKind.WAITING,
              tripId: 'trip-1',
              jobId: 'job-1',
              amountIncGstCents: 1000,
              metadata: { settlementAccrued: true },
            },
          }),
        },
        $transaction: jest.fn(),
      };

      const result = await makeService(prisma).markSurchargePaid({
        paymentEventId: 'pe-1',
        paymentIntentId: 'pi_1',
        source: 'retry',
      });
      expect(result).toEqual({ skipped: true, alreadyPaid: true });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('backfills accrual on alreadyPaid when settlementAccrued missing', async () => {
      const tx = {
        surcharge: {
          findUnique: jest.fn().mockResolvedValue({
            id: 's-old',
            jobId: 'job-1',
            amountIncGstCents: 2000,
            metadata: {},
          }),
          update: jest.fn(),
        },
        job: {
          findUnique: jest.fn().mockResolvedValue({
            originRegionId: null,
            originTerritoryId: null,
            senderCompanyId: null,
          }),
        },
        settlementLine: { createMany: jest.fn() },
      };
      const prisma = {
        paymentEvent: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'pe-old',
            surcharge: {
              id: 's-old',
              status: SurchargeStatus.PAID,
              kind: SurchargeKind.WAITING,
              tripId: 'trip-1',
              jobId: 'job-1',
              amountIncGstCents: 2000,
              metadata: {},
            },
          }),
        },
        $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
      };

      const result = await makeService(prisma).markSurchargePaid({
        paymentEventId: 'pe-old',
        paymentIntentId: 'pi_old',
        source: 'retry',
      });
      expect(result).toEqual({ skipped: true, alreadyPaid: true });
      expect(tx.settlementLine.createMany).toHaveBeenCalledWith({
        data: [
          {
            jobId: 'job-1',
            recipientType: SettlementRecipientType.CARRIER,
            sharePercent: 100,
            amountCents: 2000,
            status: SettlementLineStatus.ACCRUED,
          },
        ],
      });
    });
  });

  describe('tryDisburseCarrierTransfer sums unpaid carrier lines', () => {
    function basePrisma(overrides: Record<string, unknown> = {}) {
      return {
        isConnected: () => true,
        platformSettings: {
          findUnique: jest.fn().mockResolvedValue({ carrierClearingDays: 0 }),
        },
        trip: {
          findFirst: jest.fn().mockResolvedValue({
            completedAt: new Date(Date.now() - 60_000),
          }),
        },
        settlementLine: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'sl-fare',
              amountCents: 7000,
              currency: 'AUD',
              status: SettlementLineStatus.ACCRUED,
            },
            {
              id: 'sl-surch',
              amountCents: 3500,
              currency: 'AUD',
              status: SettlementLineStatus.ACCRUED,
            },
          ]),
          findFirst: jest.fn(),
          updateMany: jest.fn(),
        },
        paymentEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        assignment: {
          findUnique: jest.fn().mockResolvedValue({
            carrierCompany: {
              id: 'carrier-1',
              stripeConnectAccountId: 'acct_1',
              stripeConnectPayoutsEnabled: true,
            },
          }),
        },
        $transaction: jest.fn(async (fn: (t: unknown) => Promise<void>) => {
          const tx = {
            paymentEvent: { create: jest.fn() },
            settlementLine: { updateMany: jest.fn() },
          };
          await fn(tx);
          return tx;
        }),
        ...overrides,
      };
    }

    it('transfers fare + surcharge carrier shares in one Transfer', async () => {
      const prisma = basePrisma();
      const result = await makeService(prisma).tryDisburseCarrierTransfer('job-1');

      expect(result).toEqual({
        transferred: true,
        transferId: 'tr_1',
        mock: true,
      });
      expect(stripe.createTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 10_500,
          destinationAccountId: 'acct_1',
          idempotencyKey: 'carrier-transfer:job-1:sl-fare,sl-surch',
          metadata: expect.objectContaining({
            settlementLineIds: 'sl-fare,sl-surch',
          }),
        }),
      );
    });

    it('allows top-up Transfer for late unpaid surcharge lines', async () => {
      const prisma = basePrisma({
        settlementLine: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'sl-late',
              amountCents: 1400,
              currency: 'AUD',
              status: SettlementLineStatus.ACCRUED,
            },
          ]),
          findFirst: jest.fn(),
          updateMany: jest.fn(),
        },
        paymentEvent: {
          // Prior fare transfer exists under a different idempotency key — ignore.
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
      });

      const result = await makeService(prisma).tryDisburseCarrierTransfer('job-1');
      expect(result.transferred).toBe(true);
      expect(stripe.createTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 1400,
          idempotencyKey: 'carrier-transfer:job-1:sl-late',
        }),
      );
    });

    it('is idempotent when Transfer PE already exists for the same line set', async () => {
      const updateMany = jest.fn();
      const prisma = basePrisma({
        settlementLine: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'sl-fare',
              amountCents: 7000,
              currency: 'AUD',
              status: SettlementLineStatus.ACCRUED,
            },
          ]),
          findFirst: jest.fn(),
          updateMany,
        },
        paymentEvent: {
          findFirst: jest.fn().mockResolvedValue({
            stripeTransferId: 'tr_existing',
            status: PaymentEventStatus.SUCCEEDED,
            type: PaymentEventType.TRANSFER,
          }),
        },
      });

      const result = await makeService(prisma).tryDisburseCarrierTransfer('job-1');
      expect(result).toEqual({
        transferred: false,
        reason: 'already_transferred',
        transferId: 'tr_existing',
      });
      expect(stripe.createTransfer).not.toHaveBeenCalled();
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['sl-fare'] }, status: { not: SettlementLineStatus.PAID } },
        }),
      );
    });
  });
});
