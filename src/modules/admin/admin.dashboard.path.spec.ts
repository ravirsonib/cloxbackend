import { NotFoundException } from '@nestjs/common';
import { LeadStatus, LeadType } from '../../shared/types';
import { AdminService } from './admin.service';

describe('AdminService dashboard + lead detail paths', () => {
  const audit = { record: jest.fn() };

  function makeService(prisma: Record<string, unknown>) {
    return new AdminService(prisma as never, audit as never);
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('getDashboardStats aggregates totals and recent activity', async () => {
    const prisma = {
      isConnected: () => true,
      lead: {
        count: jest
          .fn()
          .mockResolvedValueOnce(10)
          .mockResolvedValueOnce(2)
          .mockResolvedValueOnce(5),
        groupBy: jest
          .fn()
          .mockResolvedValueOnce([
            { type: LeadType.INVESTOR, _count: { _all: 3 } },
            { type: LeadType.REGISTRY_SENDER, _count: { _all: 4 } },
          ])
          .mockResolvedValueOnce([{ status: LeadStatus.NEW, _count: { _all: 7 } }]),
        findMany: jest.fn().mockResolvedValue([{ id: 'lead-1' }]),
      },
      leadEvent: {
        findMany: jest.fn().mockResolvedValue([{ id: 'ev-1' }]),
      },
    };
    const service = makeService(prisma);
    const result = await service.getDashboardStats();
    expect(result.totals).toMatchObject({
      all: 10,
      today: 2,
      week: 5,
      investors: 3,
      registrySenders: 4,
    });
    expect(result.byStatus).toEqual({ NEW: 7 });
    expect(result.recentLeads).toHaveLength(1);
    expect(result.recentActivity).toHaveLength(1);
  });

  it('getDashboardStats defaults missing type counts to zero', async () => {
    const prisma = {
      isConnected: () => true,
      lead: {
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest
          .fn()
          .mockResolvedValueOnce([{ type: LeadType.EOI_LOCAL_BDE, _count: { _all: 1 } }])
          .mockResolvedValueOnce([]),
        findMany: jest.fn().mockResolvedValue([]),
      },
      leadEvent: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const result = await makeService(prisma).getDashboardStats();
    expect(result.totals).toMatchObject({
      registrySenders: 0,
      registryCarriers: 0,
      eoiStateMasters: 0,
      eoiLocalBdes: 1,
      investors: 0,
    });
  });

  it('getLead throws NotFound when missing', async () => {
    const prisma = {
      isConnected: () => true,
      lead: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const service = makeService(prisma);
    await expect(service.getLead('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getLead returns lead with notes and events', async () => {
    const lead = {
      id: 'lead-1',
      type: LeadType.INVESTOR,
      status: LeadStatus.NEW,
      notes: [{ id: 'n1' }],
      events: [{ id: 'e1' }],
    };
    const prisma = {
      isConnected: () => true,
      lead: { findUnique: jest.fn().mockResolvedValue(lead) },
    };
    const service = makeService(prisma);
    await expect(service.getLead('lead-1')).resolves.toEqual(lead);
  });

  it('addNote creates note and records audit', async () => {
    const prisma = {
      isConnected: () => true,
      lead: {
        findUnique: jest.fn().mockResolvedValue({ id: 'lead-1' }),
      },
      leadNote: {
        create: jest.fn().mockResolvedValue({
          id: 'note-1',
          body: 'hello',
        }),
      },
      adminUser: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'admin-1',
          email: 'a@x.com',
          name: 'A',
        }),
      },
    };
    const service = makeService(prisma);
    const note = await service.addNote(
      'lead-1',
      { body: 'hello' },
      'admin-1',
    );
    expect(note).toMatchObject({ id: 'note-1', body: 'hello' });
    expect(audit.record).toHaveBeenCalled();
  });

  it('listAudit returns paginated events', async () => {
    const prisma = {
      isConnected: () => true,
      leadEvent: {
        findMany: jest.fn().mockResolvedValue([{ id: 'ev-1' }]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const service = makeService(prisma);
    const result = await service.listAudit({ page: 1, pageSize: 20 });
    expect(result).toMatchObject({
      total: 1,
      totalPages: 1,
      items: [{ id: 'ev-1' }],
    });
  });
});
