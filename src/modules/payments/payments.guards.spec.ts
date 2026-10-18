import { NotFoundException } from '@nestjs/common';
import { PaymentEventStatus, PaymentEventType } from '@prisma/client';
import { PaymentsService } from './payments.service';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';

describe('PaymentsService.refundStub ownership', () => {
  const sender: AuthenticatedPrincipal = {
    id: 'user-sender',
    email: 'sender@yopmail.com',
    role: 'SENDER',
    kind: 'user',
    regionCodes: [],
    territoryCodes: [],
  };

  it('denies refund on another sender company job', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-a' }),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      paymentEvent: { findFirst: jest.fn() },
    };
    const service = new PaymentsService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { createRefundStub: jest.fn() } as never,
      {} as never,
    );

    await expect(service.refundStub(sender, 'job-other')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.paymentEvent.findFirst).not.toHaveBeenCalled();
  });

  it('allows refund when job belongs to sender company', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-a' }),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue({ id: 'job-1', senderCompanyId: 'co-a' }),
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
    const stripe = {
      createRefundStub: jest.fn().mockResolvedValue({ id: 're_1', mock: true }),
    };
    const audit = { recordPlatform: jest.fn() };
    const service = new PaymentsService(
      prisma as never,
      audit as never,
      stripe as never,
      {} as never,
    );

    const result = await service.refundStub(sender, 'job-1');
    expect(result.refundId).toBe('re_1');
    expect(prisma.job.findFirst).toHaveBeenCalledWith({
      where: { id: 'job-1', senderCompanyId: 'co-a' },
    });
  });
});

describe('PaymentsService.markSurchargePaid stale PI', () => {
  it('skips when webhook PI does not match current PE PI', async () => {
    const prisma = {
      paymentEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pe-1',
          stripePaymentIntentId: 'pi_current',
          surcharge: {
            id: 's-1',
            status: 'PENDING_PAYMENT',
            kind: 'WAITING',
            tripId: 't-1',
          },
        }),
      },
      $transaction: jest.fn(),
    };
    const audit = { recordPlatform: jest.fn() };
    const service = new PaymentsService(
      prisma as never,
      audit as never,
      {} as never,
      {} as never,
    );

    const result = await service.markSurchargePaid({
      paymentEventId: 'pe-1',
      paymentIntentId: 'pi_stale',
      source: 'webhook',
    });
    expect(result).toMatchObject({ skipped: true, stalePi: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
