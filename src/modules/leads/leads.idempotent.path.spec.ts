import { LeadStatus, LeadType } from '../../shared/types';
import { LeadsService } from './leads.service';

describe('LeadsService EOI / investor idempotent leftovers', () => {
  const audit = { record: jest.fn() };
  const notifications = {
    notifyLeadSubmitted: jest.fn().mockResolvedValue({ skipped: true }),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new LeadsService(prisma as never, audit as never, notifications as never);
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns existing EOI lead on idempotent retry', async () => {
    const createdAt = new Date('2026-10-01T00:00:00.000Z');
    const prisma = {
      isConnected: () => true,
      lead: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'eoi-existing',
          type: LeadType.EOI_STATE_MASTER,
          status: LeadStatus.UNDER_REVIEW,
          createdAt,
        }),
        create: jest.fn(),
        findMany: jest.fn(),
      },
    };
    const result = await makeService(prisma).createEoiLead(
      {
        email: 'partner@yopmail.com',
        phone: '0400000000',
        fullName: 'Partner',
        companyName: 'Partner Co',
        abn: '51824753556',
        role: 'state_master',
        targetState: 'VIC',
        locale: 'en',
        source: 'web',
      } as never,
      { ip: '10.0.0.1' },
    );
    expect(result.id).toBe('eoi-existing');
    expect(result.warnings?.[0]).toMatch(/already received/i);
    expect(prisma.lead.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('returns existing investor lead on idempotent retry', async () => {
    const createdAt = new Date('2026-10-01T00:00:00.000Z');
    const prisma = {
      isConnected: () => true,
      lead: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'inv-existing',
          type: LeadType.INVESTOR,
          status: LeadStatus.UNDER_REVIEW,
          createdAt,
        }),
        create: jest.fn(),
        findMany: jest.fn(),
      },
    };
    const result = await makeService(prisma).createInvestorLead(
      {
        email: 'investor@yopmail.com',
        phone: '0400000000',
        fullName: 'Investor',
        chequeSizeBand: 'UNDER_250K',
        locale: 'en',
        source: 'web',
      } as never,
      {},
    );
    expect(result.id).toBe('inv-existing');
    expect(result.type).toBe(LeadType.INVESTOR);
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('creates local_bde EOI when no recent duplicate', async () => {
    const createdAt = new Date('2026-10-02T00:00:00.000Z');
    const prisma = {
      isConnected: () => true,
      lead: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({
          id: 'eoi-new',
          type: LeadType.EOI_LOCAL_BDE,
          status: LeadStatus.UNDER_REVIEW,
          email: 'local@yopmail.com',
          companyName: 'Local Co',
          createdAt,
        }),
      },
    };
    const result = await makeService(prisma).createEoiLead(
      {
        email: 'local@yopmail.com',
        phone: '0400000001',
        fullName: 'Local Partner',
        companyName: 'Local Co',
        abn: '51824753556',
        role: 'local_bde',
        targetState: 'VIC',
        targetTerritory: 'MEL',
        locale: 'en',
        source: 'web',
      } as never,
      { ip: '10.0.0.2' },
    );
    expect(result).toMatchObject({
      id: 'eoi-new',
      type: LeadType.EOI_LOCAL_BDE,
      status: LeadStatus.UNDER_REVIEW,
    });
    expect(audit.record).toHaveBeenCalled();
    expect(notifications.notifyLeadSubmitted).toHaveBeenCalled();
  });
});
