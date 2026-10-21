import { ForbiddenException } from '@nestjs/common';
import {
  AdminRole,
  AdminUserStatus,
  CompanyStatus,
  CompanyType,
  ComplianceCaseStatus,
  ComplianceCaseType,
} from '@prisma/client';
import { ComplianceService } from './compliance.service';

describe('ComplianceService ADMIN_PARTNER_KYB decide', () => {
  const superAdmin = {
    id: 'super-1',
    email: 'super@example.com',
    role: AdminRole.SUPER_ADMIN,
    kind: 'admin' as const,
    regionCodes: [] as string[],
    territoryCodes: [] as string[],
    adminStatus: AdminUserStatus.ACTIVE,
    active: true,
  };

  const stateMaster = {
    ...superAdmin,
    id: 'state-1',
    role: AdminRole.STATE_MASTER,
    regionCodes: ['VIC'],
  };

  function baseCase() {
    return {
      id: 'case-1',
      companyId: 'co-1',
      caseType: ComplianceCaseType.ADMIN_PARTNER_KYB,
      status: ComplianceCaseStatus.OPEN,
      region: { code: 'VIC' },
      company: {
        id: 'co-1',
        type: CompanyType.ADMIN_PARTNER,
        legalName: 'Partner Co',
        email: 'partner@example.com',
        abn: '51824753556',
        homeRegion: { code: 'VIC' },
        homeRegionId: 'reg-vic',
      },
      documents: [],
    };
  }

  function makeService(prisma: Record<string, unknown>) {
    const scope = {
      assertAdmin: jest.fn(),
      assertRegionAccess: jest.fn(),
      allowedTerritoryCodes: jest.fn().mockReturnValue(null),
      assertTerritoryAccess: jest.fn(),
    };
    const audit = { recordPlatform: jest.fn().mockResolvedValue(undefined) };
    const abr = { lookupAbn: jest.fn() };
    const notifications = {
      sendAdminProvisionedEmail: jest.fn().mockResolvedValue({ skipped: true }),
      sendAdminPartnerInfoRequestedEmail: jest.fn().mockResolvedValue({ skipped: true }),
    };
    return new ComplianceService(
      { isConnected: () => true, ...prisma } as never,
      audit as never,
      scope as never,
      { assertLocalOwnsCompany: jest.fn(), complianceCaseBookFilter: jest.fn().mockImplementation((p) => (p.role === 'LOCAL_BDE' ? { company: { referredByAdminUserId: p.id } } : null)) } as never,
      abr as never,
      notifications as never,
    );
  }

  it('State Master cannot approve ADMIN_PARTNER_KYB', async () => {
    const prisma = {
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue(baseCase()),
      },
      job: { findFirst: jest.fn() },
      localTerritory: { findFirst: jest.fn() },
    };
    const service = makeService(prisma);
    await expect(service.approve(stateMaster, 'case-1', { note: 'no' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('Super approve activates AdminUser + company ACTIVE', async () => {
    const partner = {
      id: 'admin-1',
      email: 'partner@example.com',
      name: 'Partner',
      role: AdminRole.STATE_MASTER,
      leadId: 'lead-1',
      companyId: 'co-1',
    };
    const prisma = {
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue(baseCase()),
        update: jest.fn(),
      },
      adminUser: {
        findFirst: jest.fn().mockResolvedValue(partner),
        update: jest.fn(),
      },
      complianceDocument: { updateMany: jest.fn() },
      company: { update: jest.fn() },
      lead: { update: jest.fn() },
      job: { findFirst: jest.fn() },
      localTerritory: { findFirst: jest.fn() },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          complianceCase: { update: jest.fn() },
          complianceDocument: { updateMany: jest.fn() },
          company: { update: jest.fn() },
          adminUser: { update: jest.fn() },
          lead: { update: jest.fn() },
        };
        return fn(tx);
      }),
    };
    const service = makeService(prisma);
    const result = await service.approve(superAdmin, 'case-1', { note: 'ok' });
    expect(result.companyStatus).toBe(CompanyStatus.ACTIVE);
    expect(result).toMatchObject({
      adminStatus: AdminUserStatus.ACTIVE,
      adminUserId: 'admin-1',
    });
  });
});
