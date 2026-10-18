import { BadRequestException } from '@nestjs/common';
import {
  AssignmentStatus,
  PaymentEventStatus,
  PaymentEventType,
  SurchargeKind,
  SurchargeStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { PaymentsService } from './payments.service';

const adminPrincipal: AuthenticatedPrincipal = {
  id: 'admin-1',
  email: 'admin@yopmail.com',
  role: 'SUPER_ADMIN',
  kind: 'admin',
  regionCodes: [],
  territoryCodes: [],
};

describe('PaymentsService deep paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createPaymentIntent: jest.fn(),
    cancelPaymentIntent: jest.fn(),
    publishableKey: jest.fn(),
  };
  const trips = { ensureTripForAssignment: jest.fn() };

  function makeService(prisma: Record<string, unknown>) {
    // Constructor order: prisma, audit, stripe, trips (forwardRef)
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

  describe('idempotencyKey', () => {
    it('returns accept:job:proposal format', () => {
      const service = makeService({ isConnected: () => true });
      expect(service.idempotencyKey('job-1', 'prop-1')).toBe('accept:job-1:prop-1');
    });
  });

  describe('markPaidAndLock', () => {
    it('skips when assignment already LOCKED', async () => {
      const prisma = {
        paymentEvent: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'pe-1',
            jobId: 'job-1',
            status: PaymentEventStatus.SUCCEEDED,
            metadata: { assignmentId: 'asg-1' },
            amountIncGstCents: 11000,
          }),
        },
        assignment: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'asg-1',
            status: AssignmentStatus.LOCKED,
          }),
        },
        $transaction: jest.fn(),
      };
      trips.ensureTripForAssignment.mockResolvedValue(null);
      const service = makeService(prisma);

      const result = await service.markPaidAndLock({
        paymentEventId: 'pe-1',
        paymentIntentId: 'pi_1',
        source: 'webhook',
      });

      expect(result).toEqual({ skipped: true, alreadyPaid: true });
      expect(trips.ensureTripForAssignment).toHaveBeenCalledWith('asg-1');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('markPaymentFailed', () => {
    it('no-ops when PE status is SUCCEEDED', async () => {
      const prisma = {
        paymentEvent: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'pe-1',
            jobId: 'job-1',
            type: PaymentEventType.CHARGE,
            status: PaymentEventStatus.SUCCEEDED,
            stripePaymentIntentId: 'pi_1',
            metadata: {},
          }),
          update: jest.fn(),
        },
        assignment: { findUnique: jest.fn() },
      };
      const service = makeService(prisma);

      await service.markPaymentFailed({
        paymentEventId: 'pe-1',
        paymentIntentId: 'pi_1',
      });

      expect(prisma.paymentEvent.update).not.toHaveBeenCalled();
      expect(prisma.assignment.findUnique).not.toHaveBeenCalled();
      expect(audit.recordPlatform).not.toHaveBeenCalled();
    });

    it('no-ops when assignment is LOCKED', async () => {
      const prisma = {
        paymentEvent: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'pe-1',
            jobId: 'job-1',
            type: PaymentEventType.CHARGE,
            status: PaymentEventStatus.PENDING,
            stripePaymentIntentId: 'pi_1',
            metadata: {},
          }),
          update: jest.fn(),
        },
        assignment: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'asg-1',
            status: AssignmentStatus.LOCKED,
          }),
        },
      };
      const service = makeService(prisma);

      await service.markPaymentFailed({
        paymentEventId: 'pe-1',
        paymentIntentId: 'pi_1',
      });

      expect(prisma.assignment.findUnique).toHaveBeenCalledWith({
        where: { jobId: 'job-1' },
      });
      expect(prisma.paymentEvent.update).not.toHaveBeenCalled();
      expect(audit.recordPlatform).not.toHaveBeenCalled();
    });
  });

  describe('waiveSurcharge', () => {
    it('throws Already paid when status is PAID', async () => {
      const prisma = {
        isConnected: () => true,
        surcharge: {
          findUnique: jest.fn().mockResolvedValue({
            id: 's-1',
            status: SurchargeStatus.PAID,
            paymentEvent: null,
          }),
          updateMany: jest.fn(),
        },
      };
      const service = makeService(prisma);

      await expect(service.waiveSurcharge(adminPrincipal, 's-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.waiveSurcharge(adminPrincipal, 's-1')).rejects.toMatchObject({
        message: 'Already paid',
      });
      expect(prisma.surcharge.updateMany).not.toHaveBeenCalled();
    });

    it('on PENDING_PAYMENT uses updateMany with PENDING_PAYMENT and returns WAIVED mapping', async () => {
      const pending = {
        id: 's-1',
        jobId: 'job-1',
        tripId: 'trip-1',
        kind: SurchargeKind.WAITING,
        status: SurchargeStatus.PENDING_PAYMENT,
        amountExGstCents: 1000,
        amountGstCents: 100,
        amountIncGstCents: 1100,
        paymentEventId: 'pe-s-1',
        stopProgressId: null,
        idempotencyKey: 'waiting:trip-1:stop-1',
        paidAt: null,
        waivedAt: null,
        metadata: null,
        paymentEvent: {
          id: 'pe-s-1',
          status: PaymentEventStatus.PENDING,
          stripePaymentIntentId: null,
        },
      };
      const waivedAt = new Date('2026-01-03T12:00:00Z');
      const refreshed = {
        ...pending,
        status: SurchargeStatus.WAIVED,
        waivedAt,
        paymentEvent: {
          id: 'pe-s-1',
          status: PaymentEventStatus.CANCELLED,
          stripePaymentIntentId: null,
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
        paymentEvent: {
          update: jest.fn().mockResolvedValue({}),
        },
        trip: { update: jest.fn() },
      };
      const service = makeService(prisma);

      const result = await service.waiveSurcharge(adminPrincipal, 's-1');

      expect(prisma.surcharge.updateMany).toHaveBeenCalledWith({
        where: { id: 's-1', status: SurchargeStatus.PENDING_PAYMENT },
        data: {
          status: SurchargeStatus.WAIVED,
          waivedAt: expect.any(Date),
          waivedByAdminId: 'admin-1',
        },
      });
      expect(prisma.paymentEvent.update).toHaveBeenCalledWith({
        where: { id: 'pe-s-1' },
        data: { status: PaymentEventStatus.CANCELLED },
      });
      expect(result).toEqual({
        id: 's-1',
        jobId: 'job-1',
        tripId: 'trip-1',
        kind: SurchargeKind.WAITING,
        status: SurchargeStatus.WAIVED,
        amountExGstCents: 1000,
        amountGstCents: 100,
        amountIncGstCents: 1100,
        paymentEventId: 'pe-s-1',
        stopProgressId: null,
        idempotencyKey: 'waiting:trip-1:stop-1',
        paidAt: null,
        waivedAt,
        metadata: null,
        payment: {
          id: 'pe-s-1',
          status: PaymentEventStatus.CANCELLED,
          stripePaymentIntentId: null,
        },
      });
    });
  });

  describe('createSurcharge', () => {
    it('with chargeNow false creates PE+surcharge without calling stripe createPaymentIntent', async () => {
      const createdSurcharge = {
        id: 's-new',
        jobId: 'job-1',
        tripId: 'trip-1',
        kind: SurchargeKind.MASS,
        status: SurchargeStatus.PENDING_PAYMENT,
        amountExGstCents: 909,
        amountGstCents: 91,
        amountIncGstCents: 1000,
        paymentEventId: 'pe-new',
        stopProgressId: null,
        idempotencyKey: 'mass:trip-1',
        paidAt: null,
        waivedAt: null,
        metadata: { declaredMassKg: 100 },
        paymentEvent: {
          id: 'pe-new',
          status: PaymentEventStatus.PENDING,
          stripePaymentIntentId: null,
        },
      };
      const prisma = {
        isConnected: () => true,
        surcharge: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
        job: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'job-1',
            senderCompany: {
              stripeCustomerId: 'cus_1',
              stripeDefaultPaymentMethodId: 'pm_1',
            },
          }),
        },
        $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
          const tx = {
            paymentEvent: {
              create: jest.fn().mockResolvedValue({
                id: 'pe-new',
                status: PaymentEventStatus.PENDING,
              }),
            },
            surcharge: {
              create: jest.fn().mockResolvedValue(createdSurcharge),
            },
          };
          return fn(tx);
        }),
      };
      const service = makeService(prisma);

      const result = await service.createSurcharge({
        jobId: 'job-1',
        tripId: 'trip-1',
        kind: SurchargeKind.MASS,
        amountIncGstCents: 1000,
        idempotencyKey: 'mass:trip-1',
        chargeNow: false,
        metadata: { declaredMassKg: 100 },
      });

      expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        id: 's-new',
        kind: SurchargeKind.MASS,
        status: SurchargeStatus.PENDING_PAYMENT,
        amountIncGstCents: 1000,
        idempotencyKey: 'mass:trip-1',
      });
      expect(audit.recordPlatform).toHaveBeenCalled();
    });
  });
});
