import { LeadStatus, LeadType } from '../../shared/types';
import { LeadsService } from './leads.service';

describe('LeadsService branch leftovers', () => {
  const audit = { record: jest.fn() };
  const notifications = {
    notifyLeadSubmitted: jest.fn().mockResolvedValue({ skipped: true }),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new LeadsService(prisma as never, audit as never, notifications as never);
  }

  beforeEach(() => jest.clearAllMocks());

  it('whitespace honeypot does not trigger; blank ABN skips duplicate scan', async () => {
    const createdAt = new Date('2026-10-07T00:00:00.000Z');
    const prisma = {
      isConnected: () => true,
      lead: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn(),
        create: jest.fn().mockResolvedValue({
          id: 'inv-1',
          type: LeadType.INVESTOR,
          status: LeadStatus.UNDER_REVIEW,
          email: 'invest@yopmail.com',
          companyName: 'Fund',
          createdAt,
        }),
      },
    };
    const result = await makeService(prisma).createInvestorLead(
      {
        fullNameOrEntity: 'Fund',
        email: 'invest@yopmail.com',
        phone: '+61412345678',
        residence: 'VIC',
        investorClassifications: ['sophisticated_investor'],
        capitalAllocation: '25000_99999',
        ecosystemFocus: 'pure_financial_growth',
        strategicNotes: 'Branch leftover path for blank ABN investor create.',
        authorizedName: 'Alex',
        declarationAccepted: true,
        locale: 'en',
        honeypot: '   ',
        abn: '   ',
      } as never,
      {},
    );
    expect(result.id).toBe('inv-1');
    expect(prisma.lead.findMany).not.toHaveBeenCalled();
    expect(prisma.lead.create).toHaveBeenCalled();
  });

  it('carrier registry create uses fleet entity + depot state', async () => {
    const createdAt = new Date('2026-10-07T00:00:00.000Z');
    const prisma = {
      isConnected: () => true,
      lead: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([{ id: 'dup-1' }]),
        create: jest.fn().mockResolvedValue({
          id: 'reg-c',
          type: LeadType.REGISTRY_CARRIER,
          status: LeadStatus.NEW,
          email: 'fleet@yopmail.com',
          companyName: 'Fleet Co',
          createdAt,
        }),
      },
    };
    const result = await makeService(prisma).createRegistryLead(
      {
        userType: 'carrier',
        email: 'fleet@yopmail.com',
        phone: '+61400000000',
        abn: '51 824 753 556',
        fleetEntityName: 'Fleet Co',
        depotState: 'NSW',
        locale: 'en',
        source: 'web',
      } as never,
      { ip: '10.0.0.9' },
    );
    expect(result).toMatchObject({
      id: 'reg-c',
      possibleDuplicate: true,
    });
    expect(prisma.lead.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          companyName: 'Fleet Co',
          state: 'NSW',
          priority: true,
          abn: '51824753556',
        }),
      }),
    );
  });
});
