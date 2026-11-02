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

  const notifications = {
    sendAccountSuspendedEmail: jest.fn(),
  };

  const service = new AdminService(prisma, audit, notifications as never);

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

  it('getCompany throws NotFoundException when company missing', async () => {
    (prisma.isConnected as jest.Mock).mockReturnValue(true);
    (prisma as unknown as { company: { findUnique: jest.Mock } }).company = {
      findUnique: jest.fn().mockResolvedValue(null),
    };

    await expect(service.getCompany('unknown-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getCompany returns company details with nested documents, vehicles, and drivers', async () => {
    (prisma.isConnected as jest.Mock).mockReturnValue(true);
    (prisma as unknown as { company: { findUnique: jest.Mock } }).company = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'co-1',
        type: 'CARRIER',
        status: 'ACTIVE',
        legalName: 'Acme Carrier',
        tradingName: 'Acme',
        abn: '12345678901',
        acn: null,
        email: 'carrier@acme.com',
        phone: '+61400000000',
        address: '100 King St',
        serviceRegionCodes: ['VIC'],
        capabilities: ['GENERAL_FREIGHT'],
        stripeConnectAccountId: 'acct_123',
        stripeConnectPayoutsEnabled: true,
        reliabilityScore: 98,
        homeRegion: { code: 'VIC', name: 'Victoria' },
        referredByAdminUser: null,
        users: [
          {
            id: 'u-1',
            email: 'admin@acme.com',
            name: 'John',
            phone: null,
            role: 'TRANSPORT_COMPANY',
            status: 'ACTIVE',
            createdAt: new Date(),
          },
        ],
        complianceDocuments: [
          {
            id: 'doc-co-1',
            docType: 'COI',
            status: 'VERIFIED',
            originalFilename: 'coi.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            expiresAt: new Date(),
            reviewedAt: null,
            reviewNote: null,
            createdAt: new Date(),
          },
        ],
        vehicles: [
          {
            id: 'v-1',
            label: 'Truck 1',
            registration: 'XYZ123',
            vehicleClass: 'RIGID_HEAVY',
            tareKg: 5000,
            gvmKg: 15000,
            gcmKg: null,
            status: 'ACTIVE',
            disabledAt: null,
            disabledReason: null,
            disabledNote: null,
            createdAt: new Date(),
            complianceDocuments: [
              {
                id: 'doc-v-1',
                docType: 'RWC',
                status: 'VERIFIED',
                originalFilename: 'rwc.pdf',
                mimeType: 'application/pdf',
                sizeBytes: 2048,
                expiresAt: new Date(),
                reviewedAt: null,
                reviewNote: null,
                createdAt: new Date(),
              },
            ],
          },
        ],
        drivers: [
          {
            id: 'd-1',
            status: 'ACTIVE',
            licenceNo: 'L987654',
            licenceClass: 'HC',
            licenceExpiry: new Date(),
            reliabilityScore: 100,
            disabledAt: null,
            disabledReason: null,
            disabledNote: null,
            createdAt: new Date(),
            user: {
              id: 'u-2',
              email: 'driver@acme.com',
              name: 'Dave Driver',
              phone: '+61411111111',
              status: 'ACTIVE',
            },
            complianceDocuments: [
              {
                id: 'doc-d-1',
                docType: 'DRIVERS_LICENCE',
                status: 'VERIFIED',
                originalFilename: 'licence.pdf',
                mimeType: 'application/pdf',
                sizeBytes: 4096,
                expiresAt: new Date(),
                reviewedAt: null,
                reviewNote: null,
                createdAt: new Date(),
              },
            ],
          },
        ],
        complianceCases: [],
      }),
    };

    const res = await service.getCompany('co-1');
    expect(res.company.legalName).toBe('Acme Carrier');
    expect(res.documents).toHaveLength(1);
    expect(res.documents[0].docType).toBe('COI');
    expect(res.vehicles).toHaveLength(1);
    expect(res.vehicles[0].documents).toHaveLength(1);
    expect(res.vehicles[0].documents[0].docType).toBe('RWC');
    expect(res.drivers).toHaveLength(1);
    expect(res.drivers[0].documents).toHaveLength(1);
    expect(res.drivers[0].documents[0].docType).toBe('DRIVERS_LICENCE');
  });
});
