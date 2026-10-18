import {
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  JobStatus,
  PaymentEventStatus,
  PaymentEventType,
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

const admin: AuthenticatedPrincipal = {
  id: 'admin-1',
  email: 'admin@yopmail.com',
  role: 'SUPER_ADMIN',
  kind: 'admin',
  regionCodes: [],
  territoryCodes: [],
};

describe('PaymentsService gate leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createPaymentIntent: jest.fn(),
    cancelPaymentIntent: jest.fn().mockRejectedValue(new Error('cancel fail')),
    createRefundStub: jest.fn().mockRejectedValue(new Error('refund fail')),
    publishableKey: jest.fn().mockReturnValue('pk_test'),
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

  beforeEach(() => jest.clearAllMocks());

  it('ensureDatabase throws when offline', async () => {
    const service = makeService({ isConnected: () => false });
    await expect(service.listSenderSurcharges(sender)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('acceptProposal rejects non-open job and missing proposal', async () => {
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
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'job-1',
            status: JobStatus.DRAFT,
            assignment: null,
            proposals: [],
          })
          .mockResolvedValueOnce({
            id: 'job-1',
            status: JobStatus.BIDDING,
            assignment: null,
            proposals: [{ id: 'p1', status: ProposalStatus.EXPIRED }],
          }),
      },
    };
    const service = makeService(prisma);
    await expect(service.acceptProposal(sender, 'job-1', 'p1')).rejects.toThrow(
      'Job is not open for accept',
    );
    await expect(service.acceptProposal(sender, 'job-1', 'p1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('acceptProposal 404 when sender company missing', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          companyId: null,
          company: null,
        }),
      },
    };
    const service = makeService(prisma);
    await expect(service.acceptProposal(sender, 'job-1', 'p1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('markSurchargePaid waived path swallows cancel + refund failures', async () => {
    const prisma = {
      isConnected: () => true,
      paymentEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pe-1',
          type: PaymentEventType.SURCHARGE,
          status: PaymentEventStatus.PENDING,
          stripePaymentIntentId: 'pi_1',
          surcharge: {
            id: 'sc-1',
            status: SurchargeStatus.WAIVED,
            kind: SurchargeKind.WAITING,
          },
        }),
      },
    };
    const service = makeService(prisma);
    const result = await service.markSurchargePaid({
      paymentEventId: 'pe-1',
      paymentIntentId: 'pi_1',
      source: 'webhook',
    });
    expect(result).toMatchObject({ skipped: true, waived: true });
    expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_1');
    expect(stripe.createRefundStub).toHaveBeenCalled();
  });

  it('waiveSurcharge race returns latest when updateMany count is 0', async () => {
    const latest = {
      id: 'sc-1',
      jobId: 'job-1',
      tripId: 'trip-1',
      kind: SurchargeKind.WAITING,
      status: SurchargeStatus.PENDING_PAYMENT,
      amountExGstCents: 100,
      amountGstCents: 10,
      amountIncGstCents: 110,
      paymentEventId: null,
      stopProgressId: null,
      idempotencyKey: 'k',
      paidAt: null,
      waivedAt: null,
      metadata: null,
      paymentEvent: null,
    };
    const prisma = {
      isConnected: () => true,
      surcharge: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            ...latest,
            status: SurchargeStatus.PENDING_PAYMENT,
            paymentEvent: null,
          })
          .mockResolvedValueOnce(latest),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const service = makeService(prisma);
    const mapped = await service.waiveSurcharge(admin, 'sc-1');
    expect(mapped.id).toBe('sc-1');
  });

  it('handleStripeWebhook live resolves PI by stripe id when metadata missing', async () => {
    stripe.isMockMode.mockReturnValue(false);
    stripe.constructWebhookEvent.mockReturnValue({
      id: 'evt_meta_miss',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_live', metadata: {} } },
    });
    const prisma = {
      isConnected: () => true,
      stripeWebhookEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      paymentEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const service = makeService(prisma);
    await expect(
      service.handleStripeWebhook(Buffer.from('raw'), 'sig'),
    ).resolves.toEqual({ received: true });
    expect(prisma.paymentEvent.findFirst).toHaveBeenCalledWith({
      where: { stripePaymentIntentId: 'pi_live' },
    });
  });
});
