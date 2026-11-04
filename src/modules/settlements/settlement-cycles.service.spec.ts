import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  AdminRole,
  SettlementCycleStatus,
  SettlementLineStatus,
  SettlementRecipientType,
} from '@prisma/client';
import { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { SettlementCyclesService } from './settlement-cycles.service';

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

describe('SettlementCyclesService', () => {
  const audit = { recordPlatform: jest.fn().mockResolvedValue({}) };
  const config = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'SETTLEMENT_WATCHDOG_MS') return 3600000;
      return undefined;
    }),
  };
  const stripe = {
    createTransfer: jest.fn().mockResolvedValue({ id: 'tr_mock_1', status: 'paid' }),
  };
  const inbox = {
    adminIdsSuper: jest.fn().mockResolvedValue(['admin-super']),
    notifyAdmins: jest.fn().mockResolvedValue(1),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeService(prisma: Record<string, unknown>) {
    return new SettlementCyclesService(
      prisma as never,
      audit as never,
      config as never,
      stripe as never,
      inbox as never,
    );
  }

  describe('getOrCreateActiveCycle', () => {
    it('returns existing OPEN cycle if available', async () => {
      const existingCycle = {
        id: 'cyc-1',
        cycleNumber: 'CYC-2026-10-18-2026-11-01',
        periodStart: new Date('2026-10-18T00:00:00Z'),
        periodEnd: new Date('2026-11-01T23:59:59Z'),
        scheduledDisburseAt: new Date('2026-11-02T04:00:00Z'),
        status: SettlementCycleStatus.OPEN,
        disbursedAt: null,
        totalAccruedCents: 50000,
        totalDisbursedCents: 0,
        carrierPayoutCents: 35000,
        adminPayoutCents: 7500,
        hqHoldingCents: 7500,
        lineCount: 4,
        notes: null,
        createdAt: new Date(),
      };

      const prisma = {
        isConnected: () => true,
        settlementCycle: {
          findFirst: jest.fn().mockResolvedValue(existingCycle),
        },
      };

      const service = makeService(prisma);
      const result = await service.getOrCreateActiveCycle();

      expect(result.id).toBe('cyc-1');
      expect(result.cycleNumber).toBe('CYC-2026-10-18-2026-11-01');
      expect(result.status).toBe(SettlementCycleStatus.OPEN);
    });

    it('creates new rolling cycle if none currently OPEN', async () => {
      const createdCycle = {
        id: 'cyc-new',
        cycleNumber: 'CYC-2026-10-21-2026-11-04',
        periodStart: new Date('2026-10-21T00:00:00Z'),
        periodEnd: new Date('2026-11-04T23:59:59Z'),
        scheduledDisburseAt: new Date('2026-11-05T04:00:00Z'),
        status: SettlementCycleStatus.OPEN,
        disbursedAt: null,
        totalAccruedCents: 0,
        totalDisbursedCents: 0,
        carrierPayoutCents: 0,
        adminPayoutCents: 0,
        hqHoldingCents: 0,
        lineCount: 0,
        notes: null,
        createdAt: new Date(),
      };

      const prisma = {
        isConnected: () => true,
        settlementCycle: {
          findFirst: jest.fn().mockResolvedValue(null),
          upsert: jest.fn().mockResolvedValue(createdCycle),
        },
      };

      const service = makeService(prisma);
      const result = await service.getOrCreateActiveCycle();

      expect(result.id).toBe('cyc-new');
      expect(result.status).toBe(SettlementCycleStatus.OPEN);
      expect(prisma.settlementCycle.upsert).toHaveBeenCalled();
    });
  });

  describe('runDisbursement', () => {
    it('denies non-Super Admin from triggering disbursement', async () => {
      const prisma = { isConnected: () => true };
      const service = makeService(prisma);

      await expect(service.runDisbursement(stateAdmin)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects already completed cycles', async () => {
      const completedCycle = {
        id: 'cyc-done',
        cycleNumber: 'CYC-OLD',
        status: SettlementCycleStatus.COMPLETED,
        periodStart: new Date(),
        periodEnd: new Date(),
        scheduledDisburseAt: new Date(),
      };

      const prisma = {
        isConnected: () => true,
        settlementCycle: {
          findUnique: jest.fn().mockResolvedValue(completedCycle),
        },
      };

      const service = makeService(prisma);
      await expect(
        service.runDisbursement(superAdmin, { cycleId: 'cyc-done' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('calculates totals in dryRun without mutating lines', async () => {
      const cycle = {
        id: 'cyc-1',
        cycleNumber: 'CYC-2026-11-01',
        status: SettlementCycleStatus.OPEN,
        periodStart: new Date('2026-10-18T00:00:00Z'),
        periodEnd: new Date('2026-11-01T23:59:59Z'),
        scheduledDisburseAt: new Date('2026-11-02T04:00:00Z'),
      };

      const eligibleLines = [
        {
          id: 'line-1',
          recipientType: SettlementRecipientType.CARRIER,
          amountCents: 70000,
          status: SettlementLineStatus.ACCRUED,
          jobId: 'job-1',
          job: {
            id: 'job-1',
            title: 'Melbourne to Sydney',
            assignment: {
              carrierCompanyId: 'co-1',
              carrierCompany: { stripeConnectAccountId: 'acct_carrier_1' },
            },
          },
        },
        {
          id: 'line-2',
          recipientType: SettlementRecipientType.SUPER_ADMIN,
          amountCents: 15000,
          status: SettlementLineStatus.ACCRUED,
          jobId: 'job-1',
        },
        {
          id: 'line-3',
          recipientType: SettlementRecipientType.STATE_MASTER,
          amountCents: 10000,
          status: SettlementLineStatus.ACCRUED,
          jobId: 'job-1',
          adminUser: { id: 'usr-state', company: { stripeConnectAccountId: 'acct_state_1' } },
        },
        {
          id: 'line-4',
          recipientType: SettlementRecipientType.HQ_HOLDING, // Vacant local territory
          amountCents: 5000,
          status: SettlementLineStatus.ACCRUED,
          jobId: 'job-1',
        },
      ];

      const prisma = {
        isConnected: () => true,
        settlementCycle: {
          findUnique: jest.fn().mockResolvedValue(cycle),
        },
        settlementLine: {
          findMany: jest.fn().mockResolvedValue(eligibleLines),
          updateMany: jest.fn(),
        },
        $transaction: jest.fn(),
      };

      const service = makeService(prisma);
      const result = await service.runDisbursement(superAdmin, {
        cycleId: 'cyc-1',
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
      expect(result.totalAccruedCents).toBe(100000);
      expect(result.carrierPayoutCents).toBe(70000);
      expect(result.adminPayoutCents).toBe(10000);
      expect(result.hqHoldingCents).toBe(20000); // 15000 Super + 5000 HQ Holding
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('marks lines PAID, completes cycle, and audits execution on live run', async () => {
      const cycle = {
        id: 'cyc-1',
        cycleNumber: 'CYC-2026-11-01',
        status: SettlementCycleStatus.OPEN,
        periodStart: new Date('2026-10-18T00:00:00Z'),
        periodEnd: new Date('2026-11-01T23:59:59Z'),
        scheduledDisburseAt: new Date('2026-11-02T04:00:00Z'),
      };

      const eligibleLines = [
        {
          id: 'line-1',
          recipientType: SettlementRecipientType.CARRIER,
          amountCents: 70000,
          status: SettlementLineStatus.ACCRUED,
          jobId: 'job-1',
          job: {
            id: 'job-1',
            assignment: {
              carrierCompanyId: 'co-1',
              carrierCompany: { stripeConnectAccountId: 'acct_carrier_1' },
            },
          },
        },
        {
          id: 'line-2',
          recipientType: SettlementRecipientType.SUPER_ADMIN,
          amountCents: 15000,
          status: SettlementLineStatus.ACCRUED,
          jobId: 'job-1',
        },
        {
          id: 'line-3',
          recipientType: SettlementRecipientType.STATE_MASTER,
          amountCents: 10000,
          status: SettlementLineStatus.ACCRUED,
          jobId: 'job-1',
          adminUser: { id: 'usr-state', company: { stripeConnectAccountId: 'acct_state_1' } },
        },
      ];

      const lineUpdateManyMock = jest.fn().mockResolvedValue({ count: 3 });
      const cycleUpdateMock = jest.fn().mockResolvedValue({});

      const prisma = {
        isConnected: () => true,
        settlementCycle: {
          findUnique: jest.fn().mockResolvedValue(cycle),
        },
        settlementLine: {
          findMany: jest.fn().mockResolvedValue(eligibleLines),
        },
        paymentEvent: {
          create: jest.fn().mockResolvedValue({}),
        },
        $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
          return callback({
            settlementLine: { updateMany: lineUpdateManyMock },
            settlementCycle: { update: cycleUpdateMock },
          });
        }),
      };

      const service = makeService(prisma);
      const result = await service.runDisbursement(superAdmin, { cycleId: 'cyc-1' });

      expect(result.success).toBe(true);
      expect(result.lineCount).toBe(3);
      expect(result.totalDisbursedCents).toBe(95000);
      expect(lineUpdateManyMock).toHaveBeenCalledWith({
        where: { id: { in: ['line-1', 'line-2', 'line-3'] } },
        data: expect.objectContaining({
          status: SettlementLineStatus.PAID,
          cycleId: 'cyc-1',
        }),
      });
      expect(cycleUpdateMock).toHaveBeenCalledWith({
        where: { id: 'cyc-1' },
        data: expect.objectContaining({
          status: SettlementCycleStatus.COMPLETED,
          totalDisbursedCents: 95000,
        }),
      });
      expect(audit.recordPlatform).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'settlement.cycle_run',
          entityType: 'SettlementCycle',
          entityId: 'cyc-1',
        }),
      );
    });
  });
});
