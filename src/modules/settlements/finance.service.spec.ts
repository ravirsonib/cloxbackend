import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  AdminRole,
  PaymentEventStatus,
  PaymentEventType,
  SettlementLineStatus,
  SettlementRecipientType,
  SurchargeKind,
  SurchargeStatus,
  TripStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { FinanceService } from './finance.service';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AppRole, AuditAction } from '../../shared/types';

describe('FinanceService', () => {
  let service: FinanceService;
  let prisma: {
    isConnected: jest.Mock;
    settlementLine: { findMany: jest.Mock };
    surcharge: { findMany: jest.Mock };
    paymentEvent: { findMany: jest.Mock };
    job: { findMany: jest.Mock };
    region: { findMany: jest.Mock };
    company: { findMany: jest.Mock; findUnique: jest.Mock };
    adminUser: { findUnique: jest.Mock };
    user: { findUnique: jest.Mock };
    assignment: { findMany: jest.Mock };
  };
  let audit: { recordPlatform: jest.Mock; recordActor: jest.Mock };

  const superAdmin: AuthenticatedPrincipal = {
    id: 'admin-super-1',
    email: 'super@clox.com.au',
    role: AdminRole.SUPER_ADMIN,
    kind: 'admin',
    regionCodes: [],
    territoryCodes: [],
  };

  const stateAdmin: AuthenticatedPrincipal = {
    id: 'admin-state-vic',
    email: 'vic.state@clox.com.au',
    role: AdminRole.STATE_MASTER,
    kind: 'admin',
    regionCodes: ['VIC'],
    territoryCodes: [],
  };

  const carrierPrincipal: AuthenticatedPrincipal = {
    id: 'user-carrier-1',
    email: 'carrier@express.com.au',
    role: AppRole.TRANSPORT_COMPANY,
    kind: 'user',
    regionCodes: [],
    territoryCodes: [],
  };

  const senderPrincipal: AuthenticatedPrincipal = {
    id: 'user-sender-1',
    email: 'sender@bigretail.com.au',
    role: AppRole.SENDER,
    kind: 'user',
    regionCodes: [],
    territoryCodes: [],
  };

  beforeEach(async () => {
    prisma = {
      isConnected: jest.fn().mockReturnValue(true),
      settlementLine: { findMany: jest.fn() },
      surcharge: { findMany: jest.fn() },
      paymentEvent: { findMany: jest.fn() },
      job: { findMany: jest.fn() },
      region: { findMany: jest.fn() },
      company: { findMany: jest.fn(), findUnique: jest.fn() },
      adminUser: { findUnique: jest.fn() },
      user: { findUnique: jest.fn() },
      assignment: { findMany: jest.fn() },
    };
    audit = { recordPlatform: jest.fn(), recordActor: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FinanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get<FinanceService>(FinanceService);
  });

  describe('getSuperFinanceOverview', () => {
    it('aggregates GMV, platform revenue, payouts, surcharges, and company leaderboard', async () => {
      // 1. Settlement Lines mock
      prisma.settlementLine.findMany.mockResolvedValue([
        {
          id: 'line-carrier-1',
          recipientType: SettlementRecipientType.CARRIER,
          amountCents: 70000,
          status: SettlementLineStatus.PAID,
          regionId: 'reg-vic',
          job: { id: 'job-1', senderCompanyId: 'comp-sender-1', assignment: { carrierCompanyId: 'comp-carrier-1' } },
          createdAt: new Date(),
        },
        {
          id: 'line-super-1',
          recipientType: SettlementRecipientType.SUPER_ADMIN,
          amountCents: 15000,
          status: SettlementLineStatus.ACCRUED,
          regionId: 'reg-vic',
          job: { id: 'job-1', senderCompanyId: 'comp-sender-1', assignment: { carrierCompanyId: 'comp-carrier-1' } },
          createdAt: new Date(),
        },
        {
          id: 'line-state-1',
          recipientType: SettlementRecipientType.STATE_MASTER,
          amountCents: 10000,
          status: SettlementLineStatus.ACCRUED,
          regionId: 'reg-vic',
          job: { id: 'job-1', senderCompanyId: 'comp-sender-1', assignment: { carrierCompanyId: 'comp-carrier-1' } },
          createdAt: new Date(),
        },
        {
          id: 'line-local-1',
          recipientType: SettlementRecipientType.LOCAL_BDE,
          amountCents: 5000,
          status: SettlementLineStatus.ACCRUED,
          regionId: 'reg-vic',
          job: { id: 'job-1', senderCompanyId: 'comp-sender-1', assignment: { carrierCompanyId: 'comp-carrier-1' } },
          createdAt: new Date(),
        },
      ]);

      // 2. Surcharges mock
      prisma.surcharge.findMany.mockResolvedValue([
        {
          id: 'sur-1',
          kind: SurchargeKind.MASS,
          status: SurchargeStatus.PAID,
          amountIncGstCents: 5500,
          amountExGstCents: 5000,
          paidAt: new Date(),
          waivedAt: null,
          jobId: 'job-1',
        },
        {
          id: 'sur-2',
          kind: SurchargeKind.WAITING,
          status: SurchargeStatus.PENDING_PAYMENT,
          amountIncGstCents: 4400,
          amountExGstCents: 4000,
          paidAt: null,
          waivedAt: null,
          jobId: 'job-1',
        },
      ]);

      // 3. Payment Events mock
      prisma.paymentEvent.findMany.mockResolvedValue([
        {
          id: 'pe-1',
          type: PaymentEventType.CHARGE,
          status: PaymentEventStatus.SUCCEEDED,
          amountIncGstCents: 100000,
          stripePaymentIntentId: 'pi_test123',
          stripeTransferId: null,
        },
        {
          id: 'pe-2',
          type: PaymentEventType.TRANSFER,
          status: PaymentEventStatus.SUCCEEDED,
          amountIncGstCents: 70000,
          stripePaymentIntentId: null,
          stripeTransferId: 'tr_test456',
        },
      ]);

      // 4. Jobs mock
      prisma.job.findMany.mockResolvedValue([
        {
          id: 'job-1',
          title: 'Pallet Delivery Melb to Geelong',
          status: 'COMPLETED',
          estimateIncGstCents: 100000,
          originRegionId: 'reg-vic',
          originTerritoryId: 'terr-mel',
          senderCompanyId: 'comp-sender-1',
          createdAt: new Date(),
          assignment: { carrierCompanyId: 'comp-carrier-1', status: 'COMPLETED' },
          trip: { status: TripStatus.COMPLETED, completedAt: new Date() },
        },
      ]);

      // 5. Regions mock
      prisma.region.findMany.mockResolvedValue([
        { id: 'reg-vic', code: 'VIC', name: 'Victoria', localTerritories: [] },
      ]);

      // 6. Companies mock
      prisma.company.findMany.mockResolvedValue([
        { id: 'comp-sender-1', legalName: 'Alpha Logistics Pty Ltd', tradingName: 'Alpha Freight', email: 'alpha@test.com', type: 'SENDER' },
        { id: 'comp-carrier-1', legalName: 'Fastline Express Haulage', tradingName: 'Fastline', email: 'fast@test.com', type: 'CARRIER' },
      ]);

      const result = await service.getSuperFinanceOverview(superAdmin, { period: 'month' });

      // Verifications
      expect(result.summary.gmvCents).toBe(100000);
      expect(result.summary.platformRevenueCents).toBe(15000); // 15% HQ
      expect(result.summary.carrierPayoutsCents).toBe(70000); // 70% Carrier
      expect(result.summary.carrierPaidCents).toBe(70000);
      expect(result.summary.partnerCommissionsCents).toBe(15000); // 10% State + 5% Local
      expect(result.summary.stateCommissionsCents).toBe(10000);
      expect(result.summary.localCommissionsCents).toBe(5000);
      expect(result.summary.netMarginPercent).toBe(15.0);

      // Surcharges
      expect(result.surcharges.totalCount).toBe(2);
      expect(result.surcharges.totalAmountCents).toBe(9900);
      expect(result.surcharges.paidAmountCents).toBe(5500);
      expect(result.surcharges.pendingAmountCents).toBe(4400);
      expect(result.surcharges.byKind.mass.count).toBe(1);
      expect(result.surcharges.byKind.waiting.count).toBe(1);

      // Companies
      expect(result.companies.topSenders).toHaveLength(1);
      expect(result.companies.topSenders[0].name).toBe('Alpha Freight');
      expect(result.companies.topCarriers).toHaveLength(1);
      expect(result.companies.topCarriers[0].name).toBe('Fastline');
      expect(result.companies.topCarriers[0].earningsCents).toBe(70000);

      // Regional breakdown
      expect(result.regionalBreakdown).toHaveLength(1);
      expect(result.regionalBreakdown[0].regionCode).toBe('VIC');
      expect(result.regionalBreakdown[0].gmvCents).toBe(100000);
    });

    it('forbids non-super admin callers', async () => {
      await expect(
        service.getSuperFinanceOverview(stateAdmin, { period: 'month' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getPartnerFinance', () => {
    it('returns regional scoped revenue and commissions for State Master', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({
        id: 'admin-state-vic',
        email: 'vic.state@clox.com.au',
        name: 'VIC State Master Admin',
        scopes: [{ regionId: 'reg-vic', region: { code: 'VIC', name: 'Victoria' } }],
      });

      prisma.settlementLine.findMany.mockResolvedValue([
        {
          id: 'line-sm-1',
          jobId: 'job-1',
          amountCents: 10000,
          sharePercent: 10,
          status: SettlementLineStatus.ACCRUED,
          createdAt: new Date(),
          paidAt: null,
          job: { id: 'job-1', title: 'Pallet Delivery', status: 'COMPLETED', estimateIncGstCents: 100000 },
        },
      ]);

      prisma.company.findMany.mockResolvedValue([
        { id: 'c-1', type: 'SENDER' },
        { id: 'c-2', type: 'CARRIER' },
      ]);

      const result = await service.getPartnerFinance(stateAdmin, { period: 'month' });

      expect(result.role).toBe('STATE_MASTER');
      expect(result.adminName).toBe('VIC State Master Admin');
      expect(result.summary.attributedGmvCents).toBe(100000);
      expect(result.summary.grossCommissionCents).toBe(10000);
      expect(result.summary.accruedCents).toBe(10000);
      expect(result.summary.settledCents).toBe(0);
      expect(result.bookOfBusiness.sendersCount).toBe(1);
      expect(result.bookOfBusiness.carriersCount).toBe(1);
      expect(result.recentSettlements).toHaveLength(1);
      expect(result.recentSettlements[0].amountCents).toBe(10000);
    });
  });

  describe('getCarrierFinance', () => {
    it('returns 70% earnings, clearing pipeline, and trip ledger', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-carrier-1',
        companyId: 'comp-carrier-1',
        company: {
          id: 'comp-carrier-1',
          legalName: 'Fastline Express Haulage',
          tradingName: 'Fastline',
          stripeConnectPayoutsEnabled: true,
        },
      });

      prisma.assignment.findMany.mockResolvedValue([
        {
          id: 'asg-1',
          createdAt: new Date(),
          job: { id: 'job-1', title: 'Express Freight', estimateIncGstCents: 100000, status: 'COMPLETED' },
          proposal: { amountIncGstCents: 100000 },
          trip: { id: 'trip-1', status: TripStatus.COMPLETED, completedAt: new Date() },
        },
      ]);

      prisma.settlementLine.findMany.mockResolvedValue([
        {
          id: 'line-c-1',
          jobId: 'job-1',
          amountCents: 70000,
          status: SettlementLineStatus.PAID,
          job: { id: 'job-1', title: 'Express Freight' },
        },
      ]);

      prisma.paymentEvent.findMany.mockResolvedValue([
        {
          id: 'pe-tr-1',
          amountIncGstCents: 70000,
          status: PaymentEventStatus.SUCCEEDED,
          stripeTransferId: 'tr_test123',
          createdAt: new Date(),
        },
      ]);

      const result = await service.getCarrierFinance(carrierPrincipal, { period: 'month' });

      expect(result.companyName).toBe('Fastline');
      expect(result.payoutsEnabled).toBe(true);
      expect(result.summary.totalEarnedCents).toBe(70000);
      expect(result.summary.paidOutCents).toBe(70000);
      expect(result.tripLedger).toHaveLength(1);
      expect(result.tripLedger[0].grossFareCents).toBe(100000);
      expect(result.tripLedger[0].carrierNetCents).toBe(70000);
      expect(result.tripLedger[0].status).toBe('PAID');
      expect(result.recentTransfers).toHaveLength(1);
    });

    it('uses accepted proposal + settlement net when estimate differs from bid', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-carrier-1',
        companyId: 'comp-carrier-1',
        company: {
          id: 'comp-carrier-1',
          legalName: 'Fastline',
          tradingName: 'Fastline',
          stripeConnectPayoutsEnabled: true,
        },
      });

      // Estimate $27,500 vs accepted bid $28,000 — ledger must follow the bid/settlement.
      prisma.assignment.findMany.mockResolvedValue([
        {
          id: 'asg-1',
          createdAt: new Date(),
          job: {
            id: 'job-1',
            title: 'Hourly Load',
            estimateIncGstCents: 2_750_000,
            status: 'COMPLETED',
          },
          proposal: { amountIncGstCents: 2_800_000 },
          trip: { id: 'trip-1', status: TripStatus.COMPLETED, completedAt: new Date() },
        },
      ]);

      prisma.settlementLine.findMany.mockResolvedValue([
        {
          id: 'line-c-1',
          jobId: 'job-1',
          amountCents: 1_960_000,
          status: SettlementLineStatus.ACCRUED,
          job: { id: 'job-1', title: 'Hourly Load' },
        },
      ]);
      prisma.paymentEvent.findMany.mockResolvedValue([]);

      const result = await service.getCarrierFinance(carrierPrincipal, { period: 'month' });

      expect(result.summary.totalEarnedCents).toBe(1_960_000);
      expect(result.summary.clearingCents).toBe(1_960_000);
      expect(result.tripLedger[0].grossFareCents).toBe(2_800_000);
      expect(result.tripLedger[0].carrierNetCents).toBe(1_960_000);
      expect(result.tripLedger[0].status).toBe('ACCRUED');
    });
  });

  describe('getSenderFinance', () => {
    it('returns total freight spend, GST, surcharges, and job spend history', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-sender-1',
        companyId: 'comp-sender-1',
        company: {
          id: 'comp-sender-1',
          legalName: 'Alpha Logistics Pty Ltd',
          tradingName: 'Alpha Freight',
        },
      });

      prisma.job.findMany.mockResolvedValue([
        {
          id: 'job-1',
          title: 'Pallet Delivery',
          createdAt: new Date(),
          status: 'COMPLETED',
          estimateIncGstCents: 110000,
          paymentEvents: [
            {
              id: 'pe-1',
              type: PaymentEventType.CHARGE,
              status: PaymentEventStatus.SUCCEEDED,
              amountIncGstCents: 110000,
              stripePaymentIntentId: 'pi_123',
              createdAt: new Date(),
            },
          ],
          assignment: { status: 'COMPLETED', proposal: { amountIncGstCents: 110000 } },
        },
      ]);

      prisma.surcharge.findMany.mockResolvedValue([
        {
          id: 'sur-1',
          jobId: 'job-1',
          kind: SurchargeKind.MASS,
          status: SurchargeStatus.PAID,
          amountIncGstCents: 5500,
        },
      ]);

      const result = await service.getSenderFinance(senderPrincipal, { period: 'month' });

      expect(result.companyName).toBe('Alpha Freight');
      expect(result.summary.totalSpendIncGstCents).toBe(110000);
      expect(result.summary.totalSpendExGstCents).toBe(100000);
      expect(result.summary.totalGstCents).toBe(10000);
      expect(result.summary.surchargesSpendCents).toBe(5500);
      expect(result.jobSpendHistory).toHaveLength(1);
      expect(result.jobSpendHistory[0].baseFareIncGstCents).toBe(110000);
      expect(result.jobSpendHistory[0].surchargesIncGstCents).toBe(5500);
      expect(result.jobSpendHistory[0].totalPaidCents).toBe(115500);
    });

    it('uses accepted bid / charge when estimate differs', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-sender-1',
        companyId: 'comp-sender-1',
        company: {
          id: 'comp-sender-1',
          legalName: 'Alpha',
          tradingName: 'Alpha',
        },
      });

      prisma.job.findMany.mockResolvedValue([
        {
          id: 'job-1',
          title: 'Hourly',
          createdAt: new Date(),
          status: 'COMPLETED',
          estimateIncGstCents: 2_750_000,
          paymentEvents: [
            {
              id: 'pe-1',
              type: PaymentEventType.CHARGE,
              status: PaymentEventStatus.SUCCEEDED,
              amountIncGstCents: 2_800_000,
              stripePaymentIntentId: 'pi_abc',
              createdAt: new Date(),
            },
          ],
          assignment: {
            status: 'COMPLETED',
            proposal: { amountIncGstCents: 2_800_000 },
          },
        },
      ]);
      prisma.surcharge.findMany.mockResolvedValue([]);

      const result = await service.getSenderFinance(senderPrincipal, { period: 'month' });

      expect(result.summary.totalSpendIncGstCents).toBe(2_800_000);
      expect(result.jobSpendHistory[0].baseFareIncGstCents).toBe(2_800_000);
      expect(result.jobSpendHistory[0].totalPaidCents).toBe(2_800_000);
    });
  });

  describe('export*FinanceCsv', () => {
    it('exportSuperFinanceCsv emits stable header, escapes fields, and applies date filter', async () => {
      prisma.settlementLine.findMany.mockResolvedValue([
        {
          id: 'sl-1',
          createdAt: new Date('2026-10-15T00:00:00.000Z'),
          amountCents: 11000,
          currency: 'AUD',
          status: SettlementLineStatus.ACCRUED,
          recipientType: SettlementRecipientType.CARRIER,
          sharePercent: 70,
          jobId: 'job-1',
          job: {
            id: 'job-1',
            title: 'Load, "Metro"',
            senderCompanyId: 'comp-s1',
            assignment: { carrierCompanyId: 'comp-c1' },
          },
        },
      ]);
      prisma.surcharge.findMany.mockResolvedValue([]);
      prisma.paymentEvent.findMany.mockResolvedValue([]);
      prisma.company.findMany.mockResolvedValue([
        { id: 'comp-s1', legalName: 'Sender Co', tradingName: 'Sender Co' },
        { id: 'comp-c1', legalName: 'Carrier Co', tradingName: 'Carrier Co' },
      ]);

      const { csv, filename } = await service.exportSuperFinanceCsv(superAdmin, {
        from: '2026-10-01',
        to: '2026-10-31',
      });

      expect(filename).toBe('clox-finance-super-2026-10-01-2026-10-31.csv');
      expect(csv.split('\n')[0]).toBe(
        'date,jobId,jobTitle,entryType,recipientType,companyName,amountExGstCents,gstCents,amountIncGstCents,currency,status,stripeRef,notes',
      );
      expect(csv).toContain('"Load, ""Metro"""');
      expect(csv).toContain('SETTLEMENT_LINE');
      expect(prisma.settlementLine.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: {
              gte: new Date('2026-10-01'),
              lte: new Date('2026-10-31'),
            },
          }),
        }),
      );
      expect(audit.recordPlatform).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.FINANCE_LEDGER_EXPORTED,
          actorAdminId: superAdmin.id,
          entityId: 'super',
        }),
      );
    });

    it('rejects non-super for super export and partner role for partner export', async () => {
      await expect(
        service.exportSuperFinanceCsv(stateAdmin, { period: 'month' }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        service.exportPartnerFinanceCsv(carrierPrincipal, { period: 'month' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('exportPartnerFinanceCsv scopes to admin commission lines', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({
        id: stateAdmin.id,
        scopes: [{ regionId: 'reg-vic', region: { code: 'VIC' }, localTerritoryId: null }],
      });
      prisma.settlementLine.findMany.mockResolvedValue([
        {
          id: 'sl-p1',
          createdAt: new Date('2026-10-10T00:00:00.000Z'),
          amountCents: 5500,
          currency: 'AUD',
          status: SettlementLineStatus.ACCRUED,
          recipientType: SettlementRecipientType.STATE_MASTER,
          sharePercent: 10,
          jobId: 'job-2',
          job: { id: 'job-2', title: 'Partner job' },
        },
      ]);

      const { csv, filename } = await service.exportPartnerFinanceCsv(stateAdmin, {
        period: 'month',
      });

      expect(filename).toBe('clox-finance-partner-month.csv');
      expect(csv).toContain('STATE_MASTER');
      expect(csv).toContain('sharePercent=10');
      expect(prisma.settlementLine.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              { adminUserId: stateAdmin.id },
              expect.objectContaining({
                regionId: { in: ['reg-vic'] },
                recipientType: SettlementRecipientType.STATE_MASTER,
              }),
            ]),
          }),
        }),
      );
    });

    it('exportCarrierFinanceCsv requires company and includes CARRIER lines', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: carrierPrincipal.id,
        companyId: 'comp-c1',
      });
      prisma.company.findUnique.mockResolvedValue({
        legalName: 'Express Freight',
        tradingName: 'Express',
      });
      prisma.settlementLine.findMany.mockResolvedValue([
        {
          id: 'sl-c1',
          createdAt: new Date('2026-10-12T00:00:00.000Z'),
          amountCents: 22000,
          currency: 'AUD',
          status: SettlementLineStatus.ACCRUED,
          recipientType: SettlementRecipientType.CARRIER,
          sharePercent: 70,
          jobId: 'job-3',
          job: { id: 'job-3', title: 'Carrier haul' },
        },
      ]);
      prisma.paymentEvent.findMany.mockResolvedValue([]);

      const { csv } = await service.exportCarrierFinanceCsv(carrierPrincipal, {
        period: 'week',
      });

      expect(csv).toContain('CARRIER');
      expect(csv).toContain('Express');
      expect(prisma.settlementLine.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            recipientType: SettlementRecipientType.CARRIER,
            job: { assignment: { carrierCompanyId: 'comp-c1' } },
          }),
        }),
      );
    });

    it('exportSenderFinanceCsv rejects missing company and exports charges', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: senderPrincipal.id, companyId: null });
      await expect(
        service.exportSenderFinanceCsv(senderPrincipal, { period: 'month' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      prisma.user.findUnique.mockResolvedValue({
        id: senderPrincipal.id,
        companyId: 'comp-s1',
      });
      prisma.company.findUnique.mockResolvedValue({
        legalName: 'Big Retail',
        tradingName: 'Big Retail',
      });
      prisma.paymentEvent.findMany.mockResolvedValue([
        {
          id: 'pe-1',
          createdAt: new Date('2026-10-05T00:00:00.000Z'),
          type: PaymentEventType.CHARGE,
          status: PaymentEventStatus.SUCCEEDED,
          amountExGstCents: 10000,
          amountGstCents: 1000,
          amountIncGstCents: 11000,
          currency: 'AUD',
          stripePaymentIntentId: 'pi_test',
          jobId: 'job-4',
          job: { id: 'job-4', title: 'Sender load' },
        },
      ]);
      prisma.surcharge.findMany.mockResolvedValue([]);

      const { csv, filename } = await service.exportSenderFinanceCsv(senderPrincipal, {
        period: 'year',
      });

      expect(filename).toBe('clox-finance-sender-year.csv');
      expect(csv).toContain('PAYMENT_EVENT');
      expect(csv).toContain('pi_test');
      expect(csv).toContain('11000');
    });
  });
});
