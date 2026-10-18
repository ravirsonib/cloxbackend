import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PaymentEventType } from '@prisma/client';
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

describe('PaymentsService status / list null leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createPaymentIntent: jest.fn(),
    cancelPaymentIntent: jest.fn(),
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

  it('getJobPaymentStatus with no assignment/charge → nulls + canStartTrip false', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          companyId: 'co-s',
        }),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: 'BIDDING',
          assignment: null,
          paymentEvents: [
            {
              id: 'pe-s',
              type: PaymentEventType.SURCHARGE,
              status: 'PENDING',
              amountIncGstCents: 500,
              stripePaymentIntentId: null,
            },
          ],
        }),
      },
    };
    const result = await makeService(prisma).getJobPaymentStatus(sender, 'job-1');
    expect(result).toMatchObject({
      jobId: 'job-1',
      assignment: null,
      payment: null,
      canStartTrip: false,
    });
  });

  it('getJobPaymentStatus 404 / forbidden gates', async () => {
    const service = makeService({
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'u', companyId: null }) },
    });
    await expect(service.getJobPaymentStatus(sender, 'job-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          companyId: 'co-s',
        }),
      },
      job: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).getJobPaymentStatus(sender, 'missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listCarrierAssignments 404 without company; maps PENDING tripBlocked', async () => {
    await expect(
      makeService({
        isConnected: () => true,
        user: { findUnique: jest.fn().mockResolvedValue({ id: 'c', companyId: null }) },
      }).listCarrierAssignments(carrier),
    ).rejects.toBeInstanceOf(NotFoundException);

    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          companyId: 'co-c',
        }),
      },
      assignment: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'asg-1',
            status: 'PENDING',
            lockedAt: null,
            job: {
              id: 'job-1',
              title: 'J',
              status: 'ASSIGNED',
              pricingModel: 'PER_KM',
              estimateIncGstCents: 10000,
            },
            proposal: { amountIncGstCents: 11000, etaMinutes: 40 },
            trip: null,
          },
        ]),
      },
    };
    const rows = await makeService(prisma).listCarrierAssignments(carrier);
    expect(rows[0]).toMatchObject({
      paidAndConfirmed: false,
      tripBlockedUntilPaid: true,
      exceptions: [],
    });
  });

  it('listSenderSurcharges rejects non-sender non-super', async () => {
    await expect(
      makeService({ isConnected: () => true }).listSenderSurcharges(carrier),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
