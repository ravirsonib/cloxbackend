import { ForbiddenException } from '@nestjs/common';
import { AdminUserStatus, CompanyType } from '@prisma/client';
import { AdminRole } from '../../shared/types';
import { GrowthService } from './growth.service';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';

const local: AuthenticatedPrincipal = {
  id: 'local-1',
  email: 'tom@clox.test',
  role: AdminRole.LOCAL_BDE,
  kind: 'admin',
  regionCodes: ['VIC'],
  territoryCodes: ['MEL'],
  adminStatus: AdminUserStatus.ACTIVE,
  active: true,
};

describe('GrowthService book-of-business paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const notifications = {
    sendCompanyInviteEmail: jest.fn().mockResolvedValue({ skipped: true }),
  };
  const config = {
    get: (key: string) => {
      if (key === 'ADMIN_APP_URL') return 'http://localhost:5174';
      if (key === 'DRIVER_INVITE_TTL_HOURS') return 72;
      if (key === 'NODE_ENV') return 'test';
      return undefined;
    },
  };
  const scope = {
    assertAdmin: jest.fn(),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new GrowthService(
      prisma as never,
      audit as never,
      notifications as never,
      config as never,
      scope as never,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('createInvite requires ACTIVE Local BDE', async () => {
    const service = makeService({ isConnected: () => true });
    await expect(
      service.createInvite(
        { ...local, adminStatus: AdminUserStatus.PENDING_DOCS },
        { companyType: 'SENDER', email: 'abc@yopmail.com' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('listMyCompanies filters by referredBy self', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const service = makeService({
      isConnected: () => true,
      company: { findMany, count },
    });
    await service.listMyCompanies(local, { page: 1, pageSize: 20 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ referredByAdminUserId: 'local-1' }),
      }),
    );
  });

  it('reassignReferrer forbids Local BDE', async () => {
    const service = makeService({ isConnected: () => true });
    await expect(
      service.reassignReferrer(local, 'co-1', { adminUserId: 'local-2' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reassignReferrer Super can clear to HQ', async () => {
    const update = jest.fn().mockResolvedValue({
      id: 'co-1',
      referredByAdminUserId: null,
      referredAt: null,
      referredByAdminUser: null,
    });
    const service = makeService({
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          type: CompanyType.SENDER,
          referredByAdminUserId: 'local-1',
          referredAt: new Date(),
          homeRegion: { code: 'VIC' },
        }),
        update,
      },
    });
    const superAdmin: AuthenticatedPrincipal = {
      id: 'super-1',
      email: 'super@clox.test',
      role: AdminRole.SUPER_ADMIN,
      kind: 'admin',
      regionCodes: [],
      territoryCodes: [],
      adminStatus: AdminUserStatus.ACTIVE,
      active: true,
    };
    await service.reassignReferrer(superAdmin, 'co-1', { adminUserId: null });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ referredByAdminUserId: null }),
      }),
    );
  });
});
