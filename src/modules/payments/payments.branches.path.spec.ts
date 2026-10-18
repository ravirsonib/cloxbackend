import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  AssignmentStatus,
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

const carrier: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('PaymentsService branch leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createPaymentIntent: jest.fn(),
    cancelPaymentIntent: jest.fn().mockResolvedValue(undefined),
    createRefundStub: jest.fn().mockResolvedValue({ id: 're_1', mock: true }),
    publishableKey: jest.fn().mockReturnValue('pk_test'),
    isMockMode: jest.fn().mockReturnValue(true),
    retrievePaymentIntentClientSecret: jest.fn().mockResolvedValue('cs_1'),
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

  beforeEach(() => jest.clearAllMocks());

  it('listSenderSurcharges / paySurcharge / listCarrierExceptions null company', async () => {
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'u', companyId: null }) },
      surcharge: { findMany: jest.fn(), findFirst: jest.fn() },
    };
    const svc = makeService(prisma);
    await expect(svc.listSenderSurcharges(sender)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.paySurcharge(carrier, 's1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.paySurcharge(sender, 's1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.listCarrierExceptions(carrier)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('paySurcharge 404 when surcharge missing for sender company', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          companyId: 'co-s',
          company: { stripeCustomerId: 'cus_1', stripeDefaultPaymentMethodId: 'pm_1' },
        }),
      },
      surcharge: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(makeService(prisma).paySurcharge(sender, 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('chargeSurcharge returns mapped row when already PAID', async () => {
    const prisma = {
      isConnected: () => true,
      surcharge: {
        findUnique: jest.fn().mockResolvedValue({
          id: 's-1',
          jobId: 'job-1',
          tripId: 'trip-1',
          kind: SurchargeKind.WAITING,
          status: SurchargeStatus.PAID,
          amountExGstCents: 100,
          amountGstCents: 10,
          amountIncGstCents: 110,
          paymentEventId: 'pe-1',
          stopProgressId: null,
          idempotencyKey: 'k',
          paidAt: new Date(),
          waivedAt: null,
          metadata: null,
          paymentEvent: { id: 'pe-1', status: PaymentEventStatus.SUCCEEDED },
          job: { senderCompany: { stripeCustomerId: 'cus_1' } },
        }),
      },
    };
    const result = await makeService(prisma).chargeSurcharge('s-1');
    expect(result).toMatchObject({ id: 's-1', status: SurchargeStatus.PAID });
  });

  it('chargeSurcharge PI create non-Error failure + processing status path', async () => {
    stripe.createPaymentIntent.mockRejectedValueOnce('stripe down');
    const pe = {
      id: 'pe-1',
      status: PaymentEventStatus.PENDING,
      metadata: null,
      stripePaymentIntentId: null,
    };
    const surcharge = {
      id: 's-1',
      jobId: 'job-1',
      tripId: 'trip-1',
      kind: SurchargeKind.MASS,
      status: SurchargeStatus.PENDING_PAYMENT,
      amountExGstCents: 1000,
      amountGstCents: 100,
      amountIncGstCents: 1100,
      paymentEventId: 'pe-1',
      stopProgressId: null,
      idempotencyKey: 'mass:1',
      paidAt: null,
      waivedAt: null,
      metadata: null,
      paymentEvent: pe,
      job: {
        senderCompany: {
          stripeCustomerId: 'cus_1',
          stripeDefaultPaymentMethodId: 'pm_1',
        },
      },
    };
    const prisma = {
      isConnected: () => true,
      surcharge: { findUnique: jest.fn().mockResolvedValue(surcharge) },
      paymentEvent: { update: jest.fn().mockResolvedValue(pe) },
    };
    await expect(makeService(prisma).chargeSurcharge('s-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.paymentEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ error: 'stripe down' }),
        }),
      }),
    );

    stripe.createPaymentIntent.mockResolvedValueOnce({
      id: 'pi_pending',
      status: 'processing',
      clientSecret: 'cs_p',
      mock: false,
    });
    prisma.surcharge.findUnique = jest
      .fn()
      .mockResolvedValueOnce(surcharge)
      .mockResolvedValueOnce({
        ...surcharge,
        paymentEvent: { ...pe, status: PaymentEventStatus.PENDING },
      });
    prisma.paymentEvent.update = jest.fn().mockResolvedValue(pe);
    const pending = await makeService(prisma).chargeSurcharge('s-1');
    expect(pending).toMatchObject({ stripeStatus: 'processing', mock: false });
  });

  it('markPaymentFailed no-op when PE missing; lookup by intent id', async () => {
    const prisma = {
      isConnected: () => true,
      paymentEvent: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    };
    await expect(
      makeService(prisma).markPaymentFailed({ paymentIntentId: 'pi_x' }),
    ).resolves.toBeUndefined();
    expect(prisma.paymentEvent.findFirst).toHaveBeenCalled();
    expect(prisma.paymentEvent.update).not.toHaveBeenCalled();
  });

  it('mock webhook defaults id/type when omitted', async () => {
    const prisma = {
      isConnected: () => true,
      stripeWebhookEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      paymentEvent: { findFirst: jest.fn() },
    };
    stripe.isMockMode.mockReturnValue(true);
    const result = await makeService(prisma).handleStripeWebhook(
      Buffer.from(JSON.stringify({ data: { object: { id: 'pi_1' } } })),
      undefined,
    );
    expect(result).toMatchObject({ received: true, mock: true });
    expect(prisma.stripeWebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'payment_intent.succeeded',
          stripeEventId: expect.stringMatching(/^evt_mock_/),
        }),
      }),
    );
  });

  it('live webhook non-Error construct failure', async () => {
    stripe.isMockMode.mockReturnValue(false);
    stripe.constructWebhookEvent.mockImplementation(() => {
      throw 'bad-sig';
    });
    const prisma = { isConnected: () => true, stripeWebhookEvent: { findUnique: jest.fn() } };
    await expect(
      makeService(prisma).handleStripeWebhook(Buffer.from('{}'), 'sig'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refundStub sender without companyId', async () => {
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'u', companyId: null }) },
    };
    await expect(makeService(prisma).refundStub(sender, 'job-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('idempotent accept with null assignment maps null ids', async () => {
    const existing = {
      id: 'pe-1',
      status: PaymentEventStatus.SUCCEEDED,
      amountIncGstCents: 1100,
      stripePaymentIntentId: 'pi_1',
      jobId: 'job-1',
      metadata: {},
      job: { assignment: null },
    };
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue(senderUser) },
      paymentEvent: { findUnique: jest.fn().mockResolvedValue(existing) },
    };
    const result = await makeService(prisma).acceptProposal(sender, 'job-1', 'prop-1');
    expect(result).toMatchObject({
      assignmentId: null,
      assignmentStatus: null,
      paidAndConfirmed: false,
      idempotentReplay: true,
    });
  });

  it('acceptProposal PI fail non-Error + null metadata; processing message without vehicle/driver', async () => {
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
      metadata: null as Record<string, unknown> | null,
    };

    function buildPrisma() {
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
        assignment: {
          findUnique: jest.fn().mockResolvedValue(assignment),
        },
        $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
          const tx = {
            assignment: {
              create: jest.fn().mockResolvedValue(assignment),
              findUnique: jest.fn().mockResolvedValue(assignment),
              delete: jest.fn(),
            },
            proposal: {
              update: jest.fn(),
              findMany: jest.fn().mockResolvedValue([]),
              updateMany: jest.fn(),
              findUnique: jest.fn(),
            },
            job: {
              update: jest.fn(),
              findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: JobStatus.BIDDING }),
            },
            paymentEvent: {
              create: jest.fn().mockResolvedValue(pePending),
              delete: jest.fn().mockResolvedValue({}),
              update: jest.fn(),
            },
          };
          return fn(tx);
        }),
      };
    }

    stripe.createPaymentIntent.mockRejectedValueOnce({ code: 'card_error' });
    try {
      await makeService(buildPrisma()).acceptProposal(sender, 'job-1', 'prop-1');
      fail('expected PAYMENT_INTENT_FAILED');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'PAYMENT_INTENT_FAILED',
        detail: '[object Object]',
      });
    }

    stripe.createPaymentIntent.mockResolvedValueOnce({
      id: 'pi_pend',
      status: 'processing',
      clientSecret: 'cs',
      mock: false,
    });
    const ok = await makeService(buildPrisma()).acceptProposal(sender, 'job-1', 'prop-1');
    expect(ok).toMatchObject({
      stripeStatus: 'processing',
      mock: false,
      message: 'Payment pending — wait for webhook',
      assignmentId: 'asg-1',
    });
  });

  it('markPaymentFailed unwinds CHARGE with null metadata via jobId assignment lookup', async () => {
    const pe = {
      id: 'pe-1',
      jobId: 'job-1',
      type: PaymentEventType.CHARGE,
      status: PaymentEventStatus.PENDING,
      stripePaymentIntentId: null,
      metadata: null,
    };
    const prisma = {
      isConnected: () => true,
      paymentEvent: {
        findUnique: jest.fn().mockResolvedValue(pe),
        update: jest.fn().mockResolvedValue({ ...pe, status: PaymentEventStatus.FAILED }),
        delete: jest.fn().mockResolvedValue({}),
      },
      assignment: {
        findUnique: jest.fn().mockResolvedValue({ id: 'asg-1', status: AssignmentStatus.PENDING }),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          assignment: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'asg-1',
              status: AssignmentStatus.PENDING,
            }),
            delete: jest.fn().mockResolvedValue({}),
          },
          job: {
            findUnique: jest
              .fn()
              .mockResolvedValueOnce({ id: 'job-1', status: JobStatus.ASSIGNED })
              .mockResolvedValueOnce({ id: 'job-1', status: JobStatus.ASSIGNED }),
            update: jest.fn(),
          },
          proposal: {
            findUnique: jest.fn().mockResolvedValue(null),
            update: jest.fn(),
            updateMany: jest.fn(),
          },
          paymentEvent: { delete: jest.fn().mockResolvedValue({}) },
        };
        return fn(tx);
      }),
    };
    await makeService(prisma).markPaymentFailed({
      paymentEventId: 'pe-1',
      paymentIntentId: 'pi_1',
    });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(audit.recordPlatform).toHaveBeenCalled();
  });
});
