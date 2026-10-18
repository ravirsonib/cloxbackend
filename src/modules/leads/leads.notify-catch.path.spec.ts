import { Logger } from '@nestjs/common';
import { LeadStatus, LeadType, type RegistryLeadInput } from '../../shared/types';
import { LeadsService } from './leads.service';

describe('LeadsService notifyLeadSubmitted catch leftovers', () => {
  const prisma = {
    isConnected: jest.fn().mockReturnValue(true),
    lead: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const audit = { record: jest.fn() };
  const notifications = {
    notifyLeadSubmitted: jest.fn(),
  };

  const service = new LeadsService(
    prisma as never,
    audit as never,
    notifications as never,
  );

  const senderPayload: RegistryLeadInput = {
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
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.isConnected.mockReturnValue(true);
    prisma.lead.findMany.mockResolvedValue([]);
    prisma.lead.findFirst.mockResolvedValue(null);
  });

  async function flushNotifyCatch() {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }

  it('logs registry notify failure without failing the create response', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    notifications.notifyLeadSubmitted.mockRejectedValue(new Error('smtp down'));
    prisma.lead.create.mockResolvedValue({
      id: 'lead-reg',
      type: LeadType.REGISTRY_SENDER,
      status: LeadStatus.NEW,
      email: senderPayload.email,
      companyName: senderPayload.companyLegalName,
      createdAt: new Date('2026-10-07T00:00:00.000Z'),
    });

    const result = await service.createRegistryLead(senderPayload, { ip: '127.0.0.1' });
    expect(result.id).toBe('lead-reg');
    await flushNotifyCatch();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('registry lead lead-reg'),
      expect.stringContaining('smtp down'),
    );
    errorSpy.mockRestore();
  });

  it('logs EOI notify failure (non-Error reject) without failing response', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    notifications.notifyLeadSubmitted.mockRejectedValue('mailer offline');
    prisma.lead.create.mockResolvedValue({
      id: 'lead-eoi',
      type: LeadType.EOI_STATE_MASTER,
      status: LeadStatus.UNDER_REVIEW,
      email: 'eoi@yopmail.com',
      companyName: 'EOI Co',
      createdAt: new Date('2026-10-07T00:00:00.000Z'),
    });

    const result = await service.createEoiLead(
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
      },
      {},
    );
    expect(result.id).toBe('lead-eoi');
    await flushNotifyCatch();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('EOI lead lead-eoi'),
      'mailer offline',
    );
    errorSpy.mockRestore();
  });

  it('logs investor notify failure without failing response', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    notifications.notifyLeadSubmitted.mockRejectedValue(new Error('ses timeout'));
    prisma.lead.create.mockResolvedValue({
      id: 'lead-inv',
      type: LeadType.INVESTOR,
      status: LeadStatus.UNDER_REVIEW,
      email: 'invest@yopmail.com',
      companyName: 'Capital Partners',
      createdAt: new Date('2026-10-07T00:00:00.000Z'),
    });

    const result = await service.createInvestorLead(
      {
        fullNameOrEntity: 'Capital Partners',
        email: 'invest@yopmail.com',
        phone: '+61422222222',
        residence: 'VIC',
        investorClassifications: ['sophisticated_investor'],
        capitalAllocation: '100000_249999',
        ecosystemFocus: 'pure_financial_growth',
        strategicNotes: 'National freight corridors and enterprise shipper network.',
        authorizedName: 'Alex Investor',
        declarationAccepted: true,
        locale: 'en',
      },
      {},
    );
    expect(result.id).toBe('lead-inv');
    await flushNotifyCatch();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('investor lead lead-inv'),
      expect.stringContaining('ses timeout'),
    );
    errorSpy.mockRestore();
  });
});
