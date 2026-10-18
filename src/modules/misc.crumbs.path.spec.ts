import { Logger } from '@nestjs/common';
import {
  LeadStatus,
  LeadType,
  otpVerifySchema,
  senderProfileSchema,
} from '../shared/types';
import { AdminService } from './admin/admin.service';
import { LeadsService } from './leads/leads.service';
import { StripeService } from './payments/stripe.service';

describe('Shared types + admin/leads/stripe crumb leftovers', () => {
  it('otpVerifySchema accepts phone-only; sender BUSINESS requires ABN', () => {
    expect(
      otpVerifySchema.safeParse({ phone: '+61412345678', code: '123456' }).success,
    ).toBe(true);
    expect(
      senderProfileSchema.safeParse({
        accountType: 'BUSINESS',
        legalName: 'Acme Pty Ltd',
        invoiceLegalName: 'Acme Pty Ltd',
        phone: '+61412345678',
        invoiceAddressLine1: '1 Collins St',
        invoiceSuburb: 'Melbourne',
        invoiceState: 'VIC',
        invoicePostcode: '3000',
        gstRegistered: false,
      }).success,
    ).toBe(false);
    expect(
      senderProfileSchema.safeParse({
        accountType: 'BUSINESS',
        legalName: 'Acme Pty Ltd',
        invoiceLegalName: 'Acme Pty Ltd',
        abn: '   ',
        phone: '+61412345678',
        invoiceAddressLine1: '1 Collins St',
        invoiceSuburb: 'Melbourne',
        invoiceState: 'VIC',
        invoicePostcode: '3000',
        gstRegistered: false,
      }).success,
    ).toBe(false);
  });

  it('admin export CSV uses empty strings for null optional fields', async () => {
    const prisma = {
      isConnected: () => true,
      lead: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'lead-1',
            type: LeadType.INVESTOR,
            status: LeadStatus.NEW,
            email: 'investor@yopmail.com',
            phone: '0400111222',
            companyName: 'Fund',
            abn: '51824753556',
            acn: '123456789',
            state: 'NSW',
            territory: 'SYD',
            priority: false,
            locale: null,
            source: null,
            createdAt: new Date('2026-10-01T00:00:00.000Z'),
            updatedAt: new Date('2026-10-01T00:00:00.000Z'),
          },
          {
            id: 'lead-2',
            type: LeadType.REGISTRY_SENDER,
            status: LeadStatus.NEW,
            email: 'bare@yopmail.com',
            phone: null,
            companyName: null,
            abn: null,
            acn: null,
            state: null,
            territory: null,
            priority: true,
            locale: 'en',
            source: 'web',
            createdAt: new Date('2026-10-02T00:00:00.000Z'),
            updatedAt: new Date('2026-10-02T00:00:00.000Z'),
          },
        ]),
      },
    };
    const csv = await new AdminService(prisma as never, { record: jest.fn() } as never).exportLeadsCsv(
      {},
    );
    expect(csv).toContain('investor@yopmail.com');
    expect(csv).toContain('bare@yopmail.com');
    expect(csv.split('\n')[1]).toMatch(/,false,,,/);
  });

  it('admin updateLead priority/assignee patch without status change', async () => {
    const existing = {
      id: 'lead-1',
      status: LeadStatus.NEW,
      priority: false,
      assigneeId: null,
    };
    const prisma = {
      isConnected: () => true,
      lead: {
        findUnique: jest.fn().mockResolvedValue(existing),
        update: jest.fn().mockResolvedValue({ ...existing, priority: true, assigneeId: 'admin-2' }),
      },
      adminUser: {
        findUnique: jest.fn().mockResolvedValue({ id: 'admin-2', active: true }),
      },
    };
    const audit = { record: jest.fn() };
    await new AdminService(prisma as never, audit as never).updateLead(
      'lead-1',
      { priority: true, assigneeId: 'admin-2' },
      'admin-1',
    );
    expect(prisma.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          priority: true,
          assigneeId: 'admin-2',
        }),
      }),
    );
  });

  it('leads findDuplicateAbns empty + registry/investor notify Error vs string', async () => {
    const audit = { record: jest.fn() };
    const notifications = {
      notifyLeadSubmitted: jest.fn(),
    };
    const prisma = {
      isConnected: () => true,
      lead: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({
          id: 'lead-1',
          type: LeadType.REGISTRY_SENDER,
          status: LeadStatus.NEW,
          email: 'ops@yopmail.com',
          companyName: 'Acme',
          createdAt: new Date(),
        }),
      },
    };
    const service = new LeadsService(
      prisma as never,
      audit as never,
      notifications as never,
    );

    await (
      service as unknown as {
        findDuplicateAbns: (abn?: string) => Promise<string[]>;
      }
    ).findDuplicateAbns('   ');

    notifications.notifyLeadSubmitted.mockRejectedValueOnce('mailer down');
    await service.createRegistryLead(
      {
        userType: 'sender',
        companyLegalName: 'Acme Manufacturing Pty Ltd',
        abn: '51824753556',
        shippingOrigin: 'Melbourne',
        operationalModels: ['Interstate Linehaul Lanes'],
        biddingType: ['Per-KM Dynamic Spot Market Bidding'],
        monthlyVolume: '$10k - $50k',
        infraAcknowledged: ['easyAML', 'Stripe', 'Monoova'],
        email: 'ops@yopmail.com',
        phone: '+61400000000',
        locale: 'en',
      } as never,
      {},
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    notifications.notifyLeadSubmitted.mockRejectedValueOnce('ses string');
    prisma.lead.create = jest.fn().mockResolvedValue({
      id: 'inv-1',
      type: LeadType.INVESTOR,
      status: LeadStatus.UNDER_REVIEW,
      email: 'invest@yopmail.com',
      companyName: 'Fund',
      createdAt: new Date(),
    });
    await service.createInvestorLead(
      {
        fullNameOrEntity: 'Fund Co',
        email: 'invest@yopmail.com',
        phone: '+61412345678',
        abn: '51824753556',
        residence: 'VIC',
        investorClassifications: ['sophisticated_investor'],
        capitalAllocation: '25000_99999',
        ecosystemFocus: 'pure_financial_growth',
        strategicNotes: 'National freight corridors for investor crumb coverage path.',
        authorizedName: 'Alex',
        declarationAccepted: true,
        locale: 'en',
      } as never,
      {},
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    notifications.notifyLeadSubmitted.mockRejectedValueOnce(new Error('eoi smtp'));
    prisma.lead.create = jest.fn().mockResolvedValue({
      id: 'eoi-1',
      type: LeadType.EOI_STATE_MASTER,
      status: LeadStatus.UNDER_REVIEW,
      email: 'eoi@yopmail.com',
      companyName: 'EOI Co',
      createdAt: new Date(),
    });
    await service.createEoiLead(
      {
        role: 'state_master',
        targetState: 'VIC',
        targetTerritory: 'Melbourne',
        fullLegalName: 'EOI Admin',
        companyName: 'EOI Co',
        abn: '51824753556',
        email: 'eoi@yopmail.com',
        phone: '+61411111111',
        corporateAddress: '1 Collins St Melbourne',
        networkExperience: 'Ran state carrier networks for a decade.',
        executionStrategy: 'Recruit Local BDEs then scale ops.',
        declarationAccepted: true,
        locale: 'en',
      } as never,
      {},
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  });

  it('Stripe mock attach keeps pm_ prefix; account link with query; publishable null', async () => {
    const svc = new StripeService({
      get: (k: string) => {
        if (k === 'STRIPE_MOCK') return true;
        if (k === 'STRIPE_PUBLISHABLE_KEY') return undefined;
        return undefined;
      },
    } as never);

    await expect(
      svc.attachPaymentMethod({ customerId: 'cus_1', paymentMethodId: 'pm_existing' }),
    ).resolves.toMatchObject({ paymentMethodId: 'pm_existing' });

    await expect(
      svc.createAccountLink({
        accountId: 'acct_1',
        refreshUrl: 'https://ex.test/r',
        returnUrl: 'https://ex.test/done?x=1',
      }),
    ).resolves.toMatchObject({
      url: expect.stringContaining('&connect=mock'),
    });
    expect(svc.publishableKey()).toBeNull();
  });

  it('Stripe live cancel/refund non-Error and null status', async () => {
    const live = new StripeService({
      get: (k: string) => {
        if (k === 'STRIPE_MOCK') return false;
        if (k === 'STRIPE_SECRET_KEY') return 'sk_test_x';
        return undefined;
      },
    } as never);
    const client = {
      paymentIntents: {
        cancel: jest.fn().mockRejectedValue('already gone'),
      },
      refunds: {
        create: jest.fn().mockResolvedValue({ id: 're_1', status: null }),
      },
    };
    (live as unknown as { client: unknown }).client = client;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    await live.cancelPaymentIntent('pi_x');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already gone'));
    await expect(
      live.createRefundStub({
        paymentIntentId: 'pi_x',
        idempotencyKey: 'k',
      }),
    ).resolves.toMatchObject({ status: 'pending', mock: false });
    warn.mockRestore();
  });
});
