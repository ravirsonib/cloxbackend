import { NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';

describe('AdminService leftover paths', () => {
  const audit = { record: jest.fn(), recordPlatform: jest.fn() };

  function makeService(prisma: Record<string, unknown>) {
    return new AdminService(prisma as never, audit as never);
  }

  beforeEach(() => jest.clearAllMocks());

  it('listLeads applies from/to and q filters', async () => {
    const prisma = {
      isConnected: () => true,
      lead: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const service = makeService(prisma);
    await service.listLeads({
      page: 1,
      pageSize: 20,
      from: '2026-01-01',
      to: '2026-12-31',
      q: 'acme',
    } as never);
    expect(prisma.lead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({
            gte: expect.any(Date),
            lte: expect.any(Date),
          }),
          OR: expect.any(Array),
        }),
      }),
    );
  });

  it('listLeads applies type/status/priority and from-only / to-only', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const prisma = {
      isConnected: () => true,
      lead: { findMany, count },
    };
    const service = makeService(prisma);
    await service.listLeads({
      page: 1,
      pageSize: 10,
      type: 'INVESTOR',
      status: 'NEW',
      priority: true,
      from: '2026-06-01',
    } as never);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: 'INVESTOR',
          status: 'NEW',
          priority: true,
          createdAt: expect.objectContaining({ gte: expect.any(Date) }),
        }),
      }),
    );
    await service.listLeads({
      page: 1,
      pageSize: 10,
      priority: false,
      to: '2026-06-30',
    } as never);
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          priority: false,
          createdAt: expect.objectContaining({ lte: expect.any(Date) }),
        }),
      }),
    );
  });

  it('updateLead records LEAD_UPDATED when status unchanged', async () => {
    const existing = {
      id: 'lead-1',
      status: 'NEW',
      priority: false,
      assigneeId: null,
    };
    const prisma = {
      isConnected: () => true,
      lead: {
        findUnique: jest.fn().mockResolvedValue(existing),
        update: jest.fn().mockResolvedValue({ ...existing, companyName: 'X' }),
      },
      adminUser: { findUnique: jest.fn() },
    };
    const service = makeService(prisma);
    await service.updateLead('lead-1', { companyName: 'X' } as never, 'admin-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'lead.updated' }),
    );
  });

  it('addNote 404 when lead missing', async () => {
    const prisma = {
      isConnected: () => true,
      lead: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).addNote('missing', { body: 'hi' } as never, 'admin-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
