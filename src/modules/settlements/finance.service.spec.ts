import { ForbiddenException } from '@nestjs/common';
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
import { AppRole } from '../../shared/types';

describe('FinanceService', () => {
  let service: FinanceService;
  let prisma: {
    isConnected: jest.Mock;
    settlementLine: { findMany: jest.Mock };
    surcharge: { findMany: jest.Mock };
    paymentEvent: { findMany: jest.Mock };
    job: { findMany: jest.Mock };
    region: { findMany: jest.Mock };
    company: { findMany: jest.Mock };
    adminUser: { findUnique: jest.Mock };
    user: { findUnique: jest.Mock };
    assignment: { findMany: jest.Mock };
  };

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
      company: { findMany: jest.fn() },
      adminUser: { findUnique: jest.fn() },
      user: { findUnique: jest.fn() },
      assignment: { findMany: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FinanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { recordPlatform: jest.fn(), recordActor: jest.fn() } },
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
          trip: { id: 'trip-1', status: TripStatus.COMPLETED, completedAt: new Date() },
        },
      ]);

      prisma.settlementLine.findMany.mockResolvedValue([
        {
          id: 'line-c-1',
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
      expect(result.tripLedger[0].carrierNetCents).toBe(70000);
      expect(result.tripLedger[0].status).toBe('PAID');
      expect(result.recentTransfers).toHaveLength(1);
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
          paymentEvents: [{ id: 'pe-1', status: 'SUCCEEDED', amountIncGstCents: 110000, stripePaymentIntentId: 'pi_123' }],
        },
      ]);

      prisma.surcharge.findMany.mockResolvedValue([
        {
          id: 'sur-1',
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
      expect(result.jobSpendHistory[0].totalPaidCents).toBe(110000);
    });
  });
});
