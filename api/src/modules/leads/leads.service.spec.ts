import { ServiceUnavailableException } from '@nestjs/common';
import { LeadStatus, LeadType, type RegistryLeadInput } from '../../shared/types';
import { LeadsService } from './leads.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

describe('LeadsService', () => {
  const prisma = {
    isConnected: jest.fn(),
    lead: { create: jest.fn(), findMany: jest.fn() },
  } as unknown as PrismaService;

  const audit = {
    record: jest.fn(),
  } as unknown as AuditService;

  const notifications = {
    notifyLeadSubmitted: jest.fn().mockResolvedValue({ skipped: true }),
  } as unknown as NotificationsService;

  const service = new LeadsService(prisma, audit, notifications);

  const senderPayload: RegistryLeadInput = {
    userType: 'sender',
    companyLegalName: 'Acme Manufacturing Pty Ltd',
    abn: '51824753556',
    shippingOrigin: 'Melbourne',
    operationalModels: ['Interstate Linehaul Lanes'],
    biddingType: 'Per-KM Dynamic Spot Market Bidding',
    monthlyVolume: '$10k - $50k',
    infraAcknowledged: ['easyAML', 'Stripe', 'Monoova'],
    email: 'ops@acme.example',
    phone: '+61400000000',
    locale: 'en',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.lead.findMany as jest.Mock).mockResolvedValue([]);
  });

  it('returns a fake success when honeypot is filled', async () => {
    const result = await service.createRegistryLead(
      { ...senderPayload, honeypot: 'bot-filled' },
      { ip: '127.0.0.1' },
    );

    expect(result.id).toBe('00000000-0000-4000-8000-000000000000');
    expect(result.type).toBe(LeadType.REGISTRY_SENDER);
    expect(result.status).toBe(LeadStatus.NEW);
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('rejects when database is unavailable', async () => {
    (prisma.isConnected as jest.Mock).mockReturnValue(false);

    await expect(service.createRegistryLead(senderPayload, {})).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('creates a registry lead and records audit when DB is up', async () => {
    (prisma.isConnected as jest.Mock).mockReturnValue(true);
    const createdAt = new Date('2026-07-27T12:00:00.000Z');
    (prisma.lead.create as jest.Mock).mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      type: LeadType.REGISTRY_SENDER,
      status: LeadStatus.NEW,
      email: senderPayload.email,
      companyName: senderPayload.companyLegalName,
      createdAt,
    });

    const result = await service.createRegistryLead(senderPayload, { ip: '127.0.0.1' });

    expect(result.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(audit.record).toHaveBeenCalled();
    expect(notifications.notifyLeadSubmitted).toHaveBeenCalled();
  });

  it('creates an investor lead under review', async () => {
    (prisma.isConnected as jest.Mock).mockReturnValue(true);
    const createdAt = new Date('2026-07-27T12:00:00.000Z');
    (prisma.lead.create as jest.Mock).mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      type: LeadType.INVESTOR,
      status: LeadStatus.UNDER_REVIEW,
      email: 'invest@example.com',
      companyName: 'Capital Partners Pty Ltd',
      createdAt,
    });

    const result = await service.createInvestorLead(
      {
        fullNameOrEntity: 'Capital Partners Pty Ltd',
        email: 'invest@example.com',
        phone: '+61422222222',
        residence: 'VIC, Australia',
        investorClassifications: ['sophisticated_investor'],
        capitalAllocation: '100000_249999',
        ecosystemFocus: 'pure_financial_growth',
        strategicNotes: 'National freight corridors and enterprise shipper network.',
        authorizedName: 'Alex Investor',
        declarationAccepted: true,
        locale: 'en',
      },
      { ip: '127.0.0.1' },
    );

    expect(result.type).toBe(LeadType.INVESTOR);
    expect(result.status).toBe(LeadStatus.UNDER_REVIEW);
    expect(prisma.lead.create).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalled();
    expect(notifications.notifyLeadSubmitted).toHaveBeenCalled();
  });

  it('flags possible duplicate ABN without blocking create', async () => {
    (prisma.isConnected as jest.Mock).mockReturnValue(true);
    (prisma.lead.findMany as jest.Mock).mockResolvedValue([
      { id: '44444444-4444-4444-8444-444444444444' },
    ]);
    const createdAt = new Date('2026-07-27T12:00:00.000Z');
    (prisma.lead.create as jest.Mock).mockResolvedValue({
      id: '55555555-5555-4555-8555-555555555555',
      type: LeadType.REGISTRY_SENDER,
      status: LeadStatus.NEW,
      email: senderPayload.email,
      companyName: senderPayload.companyLegalName,
      createdAt,
    });

    const result = await service.createRegistryLead(senderPayload, { ip: '127.0.0.1' });

    expect(result.possibleDuplicate).toBe(true);
    expect(result.warnings?.[0]).toMatch(/duplicate ABN/i);
    expect(prisma.lead.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ priority: true }),
      }),
    );
  });
});
