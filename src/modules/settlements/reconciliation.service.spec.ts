import { ForbiddenException } from '@nestjs/common';
import {
  AdminRole,
  PaymentEventStatus,
  PaymentEventType,
  SettlementLineStatus,
  SettlementRecipientType,
  TripStatus,
} from '@prisma/client';
import { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { ReconciliationService } from './reconciliation.service';

const superAdmin: AuthenticatedPrincipal = {
  id: 'admin-super',
  email: 'super@clox.com.au',
  role: AdminRole.SUPER_ADMIN,
  kind: 'admin',
  regionCodes: [],
  territoryCodes: [],
};

const stateAdmin: AuthenticatedPrincipal = {
  id: 'admin-state',
  email: 'state@clox.com.au',
  role: AdminRole.STATE_MASTER,
  kind: 'admin',
  regionCodes: ['VIC'],
  territoryCodes: [],
};

describe('ReconciliationService', () => {
  const audit = { recordPlatform: jest.fn().mockResolvedValue({}) };
  const stripe = {
    getClient: jest.fn().mockReturnValue({}),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new ReconciliationService(
      prisma as never,
      audit as never,
      stripe as never,
    );
  }

  it('denies non-Super Admin from generating reconciliation report', async () => {
    const prisma = { isConnected: () => true };
    const service = makeService(prisma);

    await expect(service.getReconciliationReport(stateAdmin)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('returns HEALTHY status when all ledgers balance and payments match', async () => {
    const now = new Date();
    const paymentEvents = [
      {
        id: 'pe-1',
        jobId: 'job-1',
        type: PaymentEventType.CHARGE,
        status: PaymentEventStatus.SUCCEEDED,
        amountIncGstCents: 100000,
        stripePaymentIntentId: 'pi_stripe_123',
        createdAt: now,
      },
    ];

    const settlementLines = [
      {
        id: 'sl-1',
        jobId: 'job-1',
        recipientType: SettlementRecipientType.CARRIER,
        amountCents: 70000,
        status: SettlementLineStatus.PAID,
        createdAt: now,
        job: { id: 'job-1', estimateIncGstCents: 100000 },
      },
      {
        id: 'sl-2',
        jobId: 'job-1',
        recipientType: SettlementRecipientType.SUPER_ADMIN,
        amountCents: 15000,
        status: SettlementLineStatus.PAID,
        createdAt: now,
        job: { id: 'job-1', estimateIncGstCents: 100000 },
      },
      {
        id: 'sl-3',
        jobId: 'job-1',
        recipientType: SettlementRecipientType.STATE_MASTER,
        amountCents: 10000,
        status: SettlementLineStatus.PAID,
        createdAt: now,
        job: { id: 'job-1', estimateIncGstCents: 100000 },
      },
      {
        id: 'sl-4',
        jobId: 'job-1',
        recipientType: SettlementRecipientType.LOCAL_BDE,
        amountCents: 5000,
        status: SettlementLineStatus.PAID,
        createdAt: now,
        job: { id: 'job-1', estimateIncGstCents: 100000 },
      },
    ];

    const prisma = {
      isConnected: () => true,
      paymentEvent: { findMany: jest.fn().mockResolvedValue(paymentEvents) },
      settlementLine: { findMany: jest.fn().mockResolvedValue(settlementLines) },
      trip: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const service = makeService(prisma);
    const report = await service.getReconciliationReport(superAdmin);

    expect(report.status).toBe('HEALTHY');
    expect(report.metrics.totalGmvCents).toBe(100000);
    expect(report.metrics.discrepancyCount).toBe(0);
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'settlement.reconciliation_run' }),
    );
  });

  it('detects and flags LEDGER_MISMATCH when lines variance exceeds tolerance', async () => {
    const now = new Date();
    const settlementLines = [
      {
        id: 'sl-1',
        jobId: 'job-1',
        recipientType: SettlementRecipientType.CARRIER,
        amountCents: 60000, // Missing 10,000 cents
        status: SettlementLineStatus.ACCRUED,
        createdAt: now,
        job: { id: 'job-1', estimateIncGstCents: 100000 },
      },
    ];

    const prisma = {
      isConnected: () => true,
      paymentEvent: { findMany: jest.fn().mockResolvedValue([]) },
      settlementLine: { findMany: jest.fn().mockResolvedValue(settlementLines) },
      trip: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const service = makeService(prisma);
    const report = await service.getReconciliationReport(superAdmin);

    expect(report.status).toBe('MISMATCH_DETECTED');
    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0].kind).toBe('LEDGER_MISMATCH');
    expect(report.discrepancies[0].entityId).toBe('job-1');
  });

  it('flags UNTRANSFERRED_CLEARING when completed trip is past 7-day clearing without payment', async () => {
    const pastClearingDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago

    const completedTrips = [
      {
        id: 'trip-1',
        jobId: 'job-1',
        completedAt: pastClearingDate,
        job: {
          id: 'job-1',
          title: 'Sydney to Newcastle',
          estimateIncGstCents: 100000,
          assignment: {
            carrierCompanyId: 'co-1',
            carrierCompany: { stripeConnectAccountId: 'acct_1' },
          },
        },
      },
    ];

    const settlementLines = [
      {
        id: 'sl-1',
        jobId: 'job-1',
        recipientType: SettlementRecipientType.CARRIER,
        amountCents: 70000,
        status: SettlementLineStatus.ACCRUED, // Still ACCRUED past clearing!
        createdAt: pastClearingDate,
        job: { id: 'job-1', estimateIncGstCents: 100000 },
      },
      {
        id: 'sl-2',
        jobId: 'job-1',
        recipientType: SettlementRecipientType.SUPER_ADMIN,
        amountCents: 15000,
        status: SettlementLineStatus.PAID,
        createdAt: pastClearingDate,
        job: { id: 'job-1', estimateIncGstCents: 100000 },
      },
      {
        id: 'sl-3',
        jobId: 'job-1',
        recipientType: SettlementRecipientType.STATE_MASTER,
        amountCents: 10000,
        status: SettlementLineStatus.PAID,
        createdAt: pastClearingDate,
        job: { id: 'job-1', estimateIncGstCents: 100000 },
      },
      {
        id: 'sl-4',
        jobId: 'job-1',
        recipientType: SettlementRecipientType.LOCAL_BDE,
        amountCents: 5000,
        status: SettlementLineStatus.PAID,
        createdAt: pastClearingDate,
        job: { id: 'job-1', estimateIncGstCents: 100000 },
      },
    ];

    const prisma = {
      isConnected: () => true,
      paymentEvent: { findMany: jest.fn().mockResolvedValue([]) },
      settlementLine: { findMany: jest.fn().mockResolvedValue(settlementLines) },
      trip: { findMany: jest.fn().mockResolvedValue(completedTrips) },
    };

    const service = makeService(prisma);
    const report = await service.getReconciliationReport(superAdmin);

    expect(report.status).toBe('WARNING');
    expect(report.discrepancies.some((d) => d.kind === 'UNTRANSFERRED_CLEARING')).toBe(true);
  });

  it('detects SURCHARGE_SPIKE when surcharges exceed 20% of GMV', async () => {
    const paymentEvents = [
      {
        id: 'pe-charge',
        jobId: 'job-1',
        type: PaymentEventType.CHARGE,
        status: PaymentEventStatus.SUCCEEDED,
        amountIncGstCents: 100000,
        stripePaymentIntentId: 'pi_1',
        createdAt: new Date(),
      },
      {
        id: 'pe-surcharge',
        jobId: 'job-1',
        type: PaymentEventType.SURCHARGE,
        status: PaymentEventStatus.SUCCEEDED,
        amountIncGstCents: 30000, // 30% of GMV -> triggers anomaly alert
        stripePaymentIntentId: 'pi_2',
        createdAt: new Date(),
      },
    ];

    const prisma = {
      isConnected: () => true,
      paymentEvent: { findMany: jest.fn().mockResolvedValue(paymentEvents) },
      settlementLine: { findMany: jest.fn().mockResolvedValue([]) },
      trip: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const service = makeService(prisma);
    const report = await service.getReconciliationReport(superAdmin);

    expect(report.discrepancies.some((d) => d.kind === 'SURCHARGE_SPIKE')).toBe(true);
  });

  it('handles empty database gracefully with HEALTHY status and zero metrics', async () => {
    const prisma = {
      isConnected: () => true,
      paymentEvent: { findMany: jest.fn().mockResolvedValue([]) },
      settlementLine: { findMany: jest.fn().mockResolvedValue([]) },
      trip: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const service = makeService(prisma);
    const report = await service.getReconciliationReport(superAdmin);

    expect(report.status).toBe('HEALTHY');
    expect(report.metrics.totalGmvCents).toBe(0);
    expect(report.metrics.discrepancyCount).toBe(0);
  });
});
