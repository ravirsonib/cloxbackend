import {
  PaymentEventStatus,
  SettlementRecipientType,
  SurchargeKind,
  SurchargeStatus,
} from '@prisma/client';
import { PaymentsService } from './payments.service';

describe('PaymentsService markSurchargePaid MASS leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    cancelPaymentIntent: jest.fn().mockResolvedValue(undefined),
    createRefundStub: jest.fn().mockResolvedValue({ id: 're_1', mock: true }),
    createPaymentIntent: jest.fn(),
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

  it('skips when PE has no surcharge', async () => {
    const prisma = {
      paymentEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pe-1',
          surcharge: null,
        }),
      },
    };
    await expect(
      makeService(prisma).markSurchargePaid({
        paymentEventId: 'pe-1',
        paymentIntentId: 'pi_1',
        source: 'webhook',
      }),
    ).resolves.toEqual({ skipped: true });
  });

  it('skips when surcharge already PAID', async () => {
    const prisma = {
      paymentEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pe-1',
          stripePaymentIntentId: 'pi_1',
          surcharge: {
            id: 's-1',
            status: SurchargeStatus.PAID,
            kind: SurchargeKind.MASS,
            tripId: 'trip-1',
            jobId: 'job-1',
            amountIncGstCents: 5000,
            metadata: { settlementAccrued: true },
          },
        }),
      },
    };
    await expect(
      makeService(prisma).markSurchargePaid({
        paymentEventId: 'pe-1',
        paymentIntentId: 'pi_1',
        source: 'webhook',
      }),
    ).resolves.toEqual({ skipped: true, alreadyPaid: true });
  });

  it('marks MASS paid and clears trip mass block', async () => {
    const tx = {
      paymentEvent: { update: jest.fn() },
      surcharge: { update: jest.fn() },
      trip: { update: jest.fn() },
      job: {
        findUnique: jest.fn().mockResolvedValue({
          originRegionId: null,
          originTerritoryId: null,
          senderCompanyId: 'co-1',
        }),
      },
      settlementLine: { createMany: jest.fn() },
    };
    const prisma = {
      paymentEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pe-mass',
          stripePaymentIntentId: 'pi_mass',
          status: PaymentEventStatus.PENDING,
          surcharge: {
            id: 's-mass',
            status: SurchargeStatus.PENDING_PAYMENT,
            kind: SurchargeKind.MASS,
            tripId: 'trip-1',
            jobId: 'job-1',
            amountIncGstCents: 5000,
            metadata: { actualMassKg: 1200 },
          },
        }),
      },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
    };

    const result = await makeService(prisma).markSurchargePaid({
      paymentEventId: 'pe-mass',
      paymentIntentId: 'pi_mass',
      source: 'webhook',
    });
    expect(result).toEqual({ skipped: false });
    expect(tx.trip.update).toHaveBeenCalledWith({
      where: { id: 'trip-1' },
      data: {
        massCheckOk: true,
        massOverDeclared: false,
        declaredMassKg: 1200,
        actualMassKg: 1200,
      },
    });
    expect(tx.surcharge.update).toHaveBeenCalledWith({
      where: { id: 's-mass' },
      data: expect.objectContaining({ status: SurchargeStatus.PAID }),
    });
    expect(tx.settlementLine.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            recipientType: SettlementRecipientType.CARRIER,
            sharePercent: 70,
            amountCents: 3500,
          }),
        ]),
      }),
    );
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          kind: SurchargeKind.MASS,
          settlementAccrued: true,
        }),
      }),
    );
  });
});
