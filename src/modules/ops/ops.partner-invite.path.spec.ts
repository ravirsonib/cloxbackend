import { ForbiddenException } from '@nestjs/common';
import { AdminRole, AdminUserStatus, CompanyStatus, CompanyType } from '@prisma/client';
import { AuditAction } from '../../shared/types';
import { OpsService } from './ops.service';

describe('OpsService admin partner invite spine', () => {
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

  function makeService(prisma: Record<string, unknown>) {
    const audit = { recordPlatform: jest.fn().mockResolvedValue(undefined) };
    const notifications = {
      sendAdminInviteEmail: jest.fn().mockResolvedValue({ skipped: true }),
    };
    const config = {
      get: (key: string) => {
        if (key === 'ADMIN_APP_URL') return 'http://localhost:5174';
        if (key === 'DRIVER_INVITE_TTL_HOURS') return 72;
        if (key === 'NODE_ENV') return 'test';
        return undefined;
      },
    };
    return new OpsService(
      { isConnected: () => true, ...prisma } as never,
      audit as never,
      notifications as never,
      config as never,
    );
  }

  it('inviteAdmin creates INVITED partner + ADMIN_PARTNER company (not ACTIVE)', async () => {
    const createdAdmin = {
      id: 'admin-1',
      email: 'state@example.com',
      name: 'State Partner',
      phone: null,
      role: AdminRole.STATE_MASTER,
      status: AdminUserStatus.INVITED,
      active: false,
      companyId: 'co-1',
      leadId: null,
      inviteExpiresAt: new Date(Date.now() + 86_400_000),
      inviteAcceptedAt: null,
      declarationAccuracy: false,
      declarationNda: false,
      declarationNonCompete: false,
      profileJson: null,
      scopes: [
        {
          scopeType: 'STATE',
          region: { code: 'VIC' },
          localTerritory: null,
        },
      ],
      company: {
        id: 'co-1',
        legalName: 'State Partner',
        abn: null,
        acn: null,
        status: CompanyStatus.DRAFT,
        email: 'state@example.com',
        phone: null,
        invoiceAddressLine1: null,
      },
    };

    const prisma = {
      region: { findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }) },
      adminUser: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          company: {
            create: jest.fn().mockResolvedValue({
              id: 'co-1',
              type: CompanyType.ADMIN_PARTNER,
              status: CompanyStatus.DRAFT,
            }),
          },
          adminUser: {
            create: jest.fn().mockResolvedValue(createdAdmin),
          },
          lead: { update: jest.fn() },
        };
        return fn(tx);
      }),
    };

    const service = makeService(prisma);
    const result = await service.inviteAdmin(superAdmin, {
      email: 'state@example.com',
      name: 'State Partner',
      role: AdminRole.STATE_MASTER,
      regionCode: 'VIC',
    });

    expect(result.status).toBe(AdminUserStatus.INVITED);
    expect(result.active).toBe(false);
    expect(result.company?.status).toBe(CompanyStatus.DRAFT);
    expect(result.invite?.inviteUrl).toContain('/admin/invite/');
  });

  it('inviteAdmin rejects non-Super', async () => {
    const service = makeService({});
    await expect(
      service.inviteAdmin(
        {
          ...superAdmin,
          role: AdminRole.STATE_MASTER,
          id: 'state-1',
        },
        {
          email: 'x@example.com',
          role: AdminRole.LOCAL_BDE,
          regionCode: 'VIC',
          territoryCode: 'MEL',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('acceptAdminInvite moves to PENDING_DOCS', async () => {
    const admin = {
      id: 'admin-1',
      email: 'state@example.com',
      inviteExpiresAt: new Date(Date.now() + 86_400_000),
      inviteAcceptedAt: null,
      companyId: 'co-1',
      leadId: null,
      scopes: [],
      company: null,
    };
    const updated = {
      ...admin,
      name: null,
      phone: null,
      role: AdminRole.STATE_MASTER,
      status: AdminUserStatus.PENDING_DOCS,
      active: false,
      declarationAccuracy: false,
      declarationNda: false,
      declarationNonCompete: false,
      profileJson: null,
    };

    const prisma = {
      adminUser: {
        findFirst: jest.fn().mockResolvedValue(admin),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          adminUser: {
            update: jest.fn().mockResolvedValue(updated),
          },
          company: {
            update: jest.fn().mockResolvedValue({}),
          },
          lead: { update: jest.fn() },
        };
        return fn(tx);
      }),
    };

    const service = makeService(prisma);
    const result = await service.acceptAdminInvite({ token: 'a'.repeat(32) });
    expect(result.status).toBe(AdminUserStatus.PENDING_DOCS);
    expect(result.next).toBe('otp_login');
  });
});

describe('AuditAction admin partner constants', () => {
  it('includes invite lifecycle actions', () => {
    expect(AuditAction.ADMIN_INVITED).toBe('admin.invited');
    expect(AuditAction.ADMIN_PARTNER_ACTIVATED).toBe('admin.partner_activated');
  });
});
