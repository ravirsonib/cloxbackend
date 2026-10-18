import { NotFoundException } from '@nestjs/common';
import { AuditAction, LeadStatus, LeadType } from '../../shared/types';
import { AdminService } from './admin.service';

describe('AdminService export / updateLead leftovers', () => {
  const audit = { record: jest.fn() };

  function makeService(prisma: Record<string, unknown>) {
    return new AdminService(prisma as never, audit as never);
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exportLeadsCsv escapes commas quotes and newlines', async () => {
    const prisma = {
      isConnected: () => true,
      lead: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'lead-1',
            type: LeadType.INVESTOR,
            status: LeadStatus.NEW,
            email: 'investor@yopmail.com',
            phone: null,
            companyName: 'Acme, "Inc"',
            abn: null,
            acn: null,
            state: 'VIC',
            territory: 'Line1\nLine2',
            priority: true,
            locale: 'en',
            source: 'web',
            createdAt: new Date('2026-10-01T00:00:00.000Z'),
            updatedAt: new Date('2026-10-01T00:00:00.000Z'),
          },
        ]),
      },
    };
    const csv = await makeService(prisma).exportLeadsCsv({});
    expect(csv).toContain('"Acme, ""Inc"""');
    expect(csv).toContain('"Line1\nLine2"');
    expect(csv).toContain('investor@yopmail.com');
  });

  it('listAudit filters by action and leadId', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const prisma = {
      isConnected: () => true,
      leadEvent: { findMany, count },
    };
    await makeService(prisma).listAudit({
      page: 1,
      pageSize: 10,
      action: AuditAction.LEAD_UPDATED as never,
      leadId: 'lead-1',
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { action: AuditAction.LEAD_UPDATED, leadId: 'lead-1' },
        take: 10,
        skip: 0,
      }),
    );
  });

  it('updateLead status change records LEAD_STATUS_CHANGED', async () => {
    const prisma = {
      isConnected: () => true,
      lead: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'lead-1',
          status: LeadStatus.NEW,
          priority: false,
          assigneeId: null,
        }),
        update: jest.fn().mockResolvedValue({
          id: 'lead-1',
          status: LeadStatus.CONTACTED,
        }),
      },
    };
    const result = await makeService(prisma).updateLead(
      'lead-1',
      { status: LeadStatus.CONTACTED },
      'admin-1',
    );
    expect(result).toMatchObject({ status: LeadStatus.CONTACTED });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.LEAD_STATUS_CHANGED,
        leadId: 'lead-1',
        metadata: expect.objectContaining({
          from: LeadStatus.NEW,
          to: LeadStatus.CONTACTED,
        }),
      }),
    );
  });

  it('updateLead rejects inactive assignee', async () => {
    const prisma = {
      isConnected: () => true,
      lead: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'lead-1',
          status: LeadStatus.NEW,
          priority: false,
          assigneeId: null,
        }),
      },
      adminUser: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'admin-2',
          active: false,
        }),
      },
    };
    await expect(
      makeService(prisma).updateLead(
        'lead-1',
        { assigneeId: 'admin-2' },
        'admin-1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
