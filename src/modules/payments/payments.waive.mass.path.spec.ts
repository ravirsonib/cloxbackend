import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentEventStatus,
  SurchargeKind,
  SurchargeStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { PaymentsService } from './payments.service';

const superAdmin: AuthenticatedPrincipal = {
  id: 'admin-1',
  email: 'admin@yopmail.com',
  role: 'SUPER_ADMIN',
  kind: 'admin',
  regionCodes: [],
  territoryCodes: [],
};

const localBde: AuthenticatedPrincipal = {
  id: 'admin-bde',
  email: 'bde@yopmail.com',
  role: 'LOCAL_BDE',
  kind: 'admin',
  regionCodes: ['VIC'],
  territoryCodes: ['MEL'],
};

describe('PaymentsService waiveSurcharge MASS leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createPaymentIntent: jest.fn(),
    cancelPaymentIntent: jest.fn().mockResolvedValue(undefined),
    publishableKey: jest.fn(),
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

  function massPending(overrides: Record<string, unknown> = {}) {
    return {
      id: 's-mass',
      jobId: 'job-1',
      tripId: 'trip-1',
      kind: SurchargeKind.MASS,
      status: SurchargeStatus.PENDING_PAYMENT,
      amountExGstCents: 5000,
      amountGstCents: 500,
      amountIncGstCents: 5500,
      paymentEventId: 'pe-mass',
      stopProgressId: null,
      idempotencyKey: 'mass:trip-1',
      paidAt: null,
      waivedAt: null,
      metadata: null,
      paymentEvent: {
        id: 'pe-mass',
        status: PaymentEventStatus.PENDING,
        stripePaymentIntentId: 'pi_mass',
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects non Super Admin', async () => {
    const service = makeService({ isConnected: () => true });
    await expect(service.waiveSurcharge(localBde, 's-mass')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('404 when surcharge missing', async () => {
    const prisma = {
      isConnected: () => true,
      surcharge: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).waiveSurcharge(superAdmin, 'missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns existing mapping when already WAIVED', async () => {
    const waived = massPending({
      status: SurchargeStatus.WAIVED,
      waivedAt: new Date('2026-01-01'),
      paymentEvent: null,
      paymentEventId: null,
    });
    const prisma = {
      isConnected: () => true,
      surcharge: { findUnique: jest.fn().mockResolvedValue(waived) },
    };
    const result = await makeService(prisma).waiveSurcharge(superAdmin, 's-mass');
    expect(result).toMatchObject({
      id: 's-mass',
      status: SurchargeStatus.WAIVED,
    });
  });

  it('waives MASS, clears trip mass block, cancels PI', async () => {
    const pending = massPending();
    const refreshed = {
      ...pending,
      status: SurchargeStatus.WAIVED,
      waivedAt: new Date('2026-01-03T12:00:00Z'),
      paymentEvent: {
        id: 'pe-mass',
        status: PaymentEventStatus.CANCELLED,
        stripePaymentIntentId: 'pi_mass',
      },
    };
    const prisma = {
      isConnected: () => true,
      surcharge: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(pending)
          .mockResolvedValueOnce(refreshed),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      paymentEvent: { update: jest.fn() },
      trip: { update: jest.fn() },
    };

    const result = await makeService(prisma).waiveSurcharge(superAdmin, 's-mass');
    expect(prisma.trip.update).toHaveBeenCalledWith({
      where: { id: 'trip-1' },
      data: { massCheckOk: true, massOverDeclared: false },
    });
    expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_mass');
    expect(prisma.paymentEvent.update).toHaveBeenCalledWith({
      where: { id: 'pe-mass' },
      data: { status: PaymentEventStatus.CANCELLED },
    });
    expect(result.status).toBe(SurchargeStatus.WAIVED);
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { kind: SurchargeKind.MASS },
      }),
    );
  });

  it('race: updateMany 0 then PAID → Already paid', async () => {
    const pending = massPending();
    const prisma = {
      isConnected: () => true,
      surcharge: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(pending)
          .mockResolvedValueOnce({
            ...pending,
            status: SurchargeStatus.PAID,
          }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    await expect(
      makeService(prisma).waiveSurcharge(superAdmin, 's-mass'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
