import { NotFoundException } from '@nestjs/common';
import { AuditAction, LeadStatus, LeadType } from '../../shared/types';
import { AdminService } from './admin.service';

describe('AdminService export / updateLead leftovers', () => {
  const audit = { record: jest.fn(), recordPlatform: jest.fn() };

  function makeService(prisma: Record<string, unknown>) {
    return new AdminService(prisma as never, audit as never, {
      sendAccountSuspendedEmail: jest.fn(),
    } as never);
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

  it('listCompanies filters by type and maps openCase', async () => {
    const prisma = {
      isConnected: () => true,
      company: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'co-1',
            type: 'CARRIER',
            status: 'BID_ELIGIBLE',
            legalName: 'Haul Co',
            tradingName: null,
            abn: '51824753556',
            email: 'haul@yopmail.com',
            phone: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
            homeRegion: { code: 'VIC', name: 'Victoria' },
            complianceCases: [{ id: 'case-1', status: 'OPEN', caseType: 'CARRIER_KYB' }],
            _count: { users: 1, vehicles: 2, drivers: 1 },
          },
        ]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const result = await makeService(prisma).listCompanies({
      page: 1,
      pageSize: 20,
      type: 'CARRIER',
    });
    expect(prisma.company.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ type: 'CARRIER' }),
      }),
    );

    await makeService(prisma).listCompanies({ page: 1, pageSize: 20 });
    expect(prisma.company.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: { in: ['SENDER', 'CARRIER'] },
        }),
      }),
    );
    expect(result).toMatchObject({
      total: 1,
      items: [
        expect.objectContaining({
          id: 'co-1',
          openCase: { id: 'case-1', status: 'OPEN', caseType: 'CARRIER_KYB' },
          counts: { users: 1, vehicles: 2, drivers: 1 },
        }),
      ],
    });
  });

  it('disableCompany cascades and notifies', async () => {
    const company = {
      id: 'co-1',
      type: 'CARRIER',
      status: 'BID_ELIGIBLE',
      legalName: 'Haul Co',
      tradingName: null,
      email: 'haul@yopmail.com',
      users: [{ id: 'u1', email: 'haul@yopmail.com', status: 'ACTIVE' }],
    };
    const tx = {
      company: {
        update: jest.fn().mockResolvedValue({
          ...company,
          status: 'SUSPENDED',
          statusBeforeSuspend: 'BID_ELIGIBLE',
          suspendedAt: new Date(),
          suspendedReason: 'Policy breach',
          suspendedNote: null,
        }),
      },
      user: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      driver: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      vehicle: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      authSession: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const notifications = { sendAccountSuspendedEmail: jest.fn() };
    const prisma = {
      isConnected: () => true,
      company: { findUnique: jest.fn().mockResolvedValue(company) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const service = new AdminService(prisma as never, audit as never, notifications as never);
    const result = await service.disableCompany('co-1', { reason: 'Policy breach' }, 'admin-1');
    expect(result.status).toBe('SUSPENDED');
    expect(result.cascade.usersSuspended).toBe(1);
    expect(notifications.sendAccountSuspendedEmail).toHaveBeenCalled();
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.COMPANY_SUSPENDED }),
    );
  });

  it('deleteCompany rejects non-draft', async () => {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          status: 'ACTIVE',
          users: [],
          _count: { jobsAsSender: 0, proposals: 0, assignments: 0 },
        }),
      },
    };
    await expect(makeService(prisma).deleteCompany('co-1', 'admin-1')).rejects.toThrow(
      /draft companies/i,
    );
  });

  it('deleteLead records LEAD_DELETED then removes row', async () => {
    const prisma = {
      isConnected: () => true,
      lead: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'lead-1',
          type: 'REGISTRY_SENDER',
          status: LeadStatus.NEW,
          email: 'lead@yopmail.com',
          companyName: 'Acme',
        }),
        delete: jest.fn().mockResolvedValue({ id: 'lead-1' }),
      },
    };
    await expect(makeService(prisma).deleteLead('lead-1', 'admin-1')).resolves.toEqual({
      ok: true,
      id: 'lead-1',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.LEAD_DELETED,
        leadId: 'lead-1',
        actorId: 'admin-1',
      }),
    );
    expect(prisma.lead.delete).toHaveBeenCalledWith({ where: { id: 'lead-1' } });
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
