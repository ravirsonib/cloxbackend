import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { LeadStatus, LeadType } from '../../shared/types';
import { AdminService } from './admin.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

describe('AdminService', () => {
  const prisma = {
    isConnected: jest.fn(),
    lead: {
      count: jest.fn(),
      groupBy: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    leadEvent: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    leadNote: {
      create: jest.fn(),
    },
    adminUser: {
      findUnique: jest.fn(),
    },
  } as unknown as PrismaService;

  const audit = {
    record: jest.fn(),
  } as unknown as AuditService;

  const service = new AdminService(prisma, audit);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('throws when database is down', async () => {
    (prisma.isConnected as jest.Mock).mockReturnValue(false);
    await expect(
      service.listLeads({ page: 1, pageSize: 20, priority: undefined }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('lists leads with pagination metadata', async () => {
    (prisma.isConnected as jest.Mock).mockReturnValue(true);
    (prisma.lead.findMany as jest.Mock).mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        type: LeadType.REGISTRY_SENDER,
        status: LeadStatus.NEW,
      },
    ]);
    (prisma.lead.count as jest.Mock).mockResolvedValue(1);

    const result = await service.listLeads({ page: 1, pageSize: 20, priority: undefined });
    expect(result.total).toBe(1);
    expect(result.totalPages).toBe(1);
    expect(result.items).toHaveLength(1);
  });

  it('throws NotFound when updating missing lead', async () => {
    (prisma.isConnected as jest.Mock).mockReturnValue(true);
    (prisma.lead.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(
      service.updateLead(
        '11111111-1111-4111-8111-111111111111',
        { status: LeadStatus.CONTACTED },
        '22222222-2222-4222-8222-222222222222',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('exports CSV with header row', async () => {
    (prisma.isConnected as jest.Mock).mockReturnValue(true);
    (prisma.lead.findMany as jest.Mock).mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        type: LeadType.EOI_STATE_MASTER,
        status: LeadStatus.UNDER_REVIEW,
        email: 'partner@example.com',
        phone: '+61411111111',
        companyName: 'Partner Co',
        abn: '51824753556',
        acn: null,
        state: 'VIC',
        territory: 'Melbourne',
        priority: false,
        locale: 'en',
        source: null,
        createdAt: new Date('2026-07-27T12:00:00.000Z'),
        updatedAt: new Date('2026-07-27T12:00:00.000Z'),
      },
    ]);

    const csv = await service.exportLeadsCsv({});
    expect(csv.split('\n')[0]).toContain('id,type,status,email');
    expect(csv).toContain('partner@example.com');
  });
});
