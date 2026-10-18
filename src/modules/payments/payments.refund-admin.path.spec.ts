import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PaymentEventStatus, PaymentEventType } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AppRole } from '../../shared/types';
import { PaymentsService } from './payments.service';

const admin: AuthenticatedPrincipal = {
  id: 'admin-1',
  email: 'admin@yopmail.com',
  role: AppRole.SUPER_ADMIN,
  kind: 'admin',
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

describe('PaymentsService refundStub admin leftover', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createRefundStub: jest.fn().mockResolvedValue({ id: 're_admin', mock: true }),
    cancelPaymentIntent: jest.fn(),
    publishableKey: jest.fn(),
    retrievePaymentIntentStatus: jest.fn(),
    retrievePaymentIntentClientSecret: jest.fn(),
    isMockMode: jest.fn().mockReturnValue(true),
    createPaymentIntent: jest.fn(),
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

  it('rejects carrier role', async () => {
    const service = makeService({ isConnected: () => true });
    await expect(service.refundStub(carrier, 'job-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('admin refunds without senderCompanyId scope', async () => {
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn() },
      job: {
        findFirst: jest.fn().mockResolvedValue({ id: 'job-1' }),
      },
      paymentEvent: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'pe-1',
          stripePaymentIntentId: 'pi_1',
          type: PaymentEventType.CHARGE,
          status: PaymentEventStatus.SUCCEEDED,
        }),
      },
    };

    const result = await makeService(prisma).refundStub(admin, 'job-1');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.job.findFirst).toHaveBeenCalledWith({
      where: { id: 'job-1' },
    });
    expect(result).toMatchObject({
      success: true,
      refundId: 're_admin',
      mock: true,
    });
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        actorAdminId: 'admin-1',
        metadata: expect.objectContaining({ refundId: 're_admin', stub: true }),
      }),
    );
  });

  it('admin 404 when job missing', async () => {
    const prisma = {
      isConnected: () => true,
      job: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(makeService(prisma).refundStub(admin, 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('admin BadRequest when charge has no PI id', async () => {
    const prisma = {
      isConnected: () => true,
      job: { findFirst: jest.fn().mockResolvedValue({ id: 'job-1' }) },
      paymentEvent: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'pe-1',
          stripePaymentIntentId: null,
          type: PaymentEventType.CHARGE,
          status: PaymentEventStatus.SUCCEEDED,
        }),
      },
    };
    await expect(makeService(prisma).refundStub(admin, 'job-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
