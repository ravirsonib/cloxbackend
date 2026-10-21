import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AdminUserStatus, CompanyType } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AdminRole } from '../../shared/types';
import { GrowthService } from './growth.service';

const tom: AuthenticatedPrincipal = {
  id: 'local-tom',
  email: 'tom@clox.test',
  role: AdminRole.LOCAL_BDE,
  kind: 'admin',
  regionCodes: ['VIC'],
  territoryCodes: ['MEL'],
  adminStatus: AdminUserStatus.ACTIVE,
  active: true,
};

const jane: AuthenticatedPrincipal = {
  id: 'local-jane',
  email: 'jane@clox.test',
  role: AdminRole.LOCAL_BDE,
  kind: 'admin',
  regionCodes: ['VIC'],
  territoryCodes: ['MEL'],
  adminStatus: AdminUserStatus.ACTIVE,
  active: true,
};

const stateVic: AuthenticatedPrincipal = {
  id: 'state-vic',
  email: 'state@clox.test',
  role: AdminRole.STATE_MASTER,
  kind: 'admin',
  regionCodes: ['VIC'],
  territoryCodes: [],
  adminStatus: AdminUserStatus.ACTIVE,
  active: true,
};

const stateNsw: AuthenticatedPrincipal = {
  id: 'state-nsw',
  email: 'nsw@clox.test',
  role: AdminRole.STATE_MASTER,
  kind: 'admin',
  regionCodes: ['NSW'],
  territoryCodes: [],
  adminStatus: AdminUserStatus.ACTIVE,
  active: true,
};

describe('GrowthService cross-session isolation', () => {
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
  const scope = { assertAdmin: jest.fn() };

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

  it('Jane cannot resend Tom invite (404 — not 200)', async () => {
    const service = makeService({
      isConnected: () => true,
      companyInvite: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'inv-1',
          invitedByAdminUserId: 'local-tom',
          acceptedAt: null,
        }),
      },
    });
    await expect(service.resendInvite(jane, 'inv-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('Jane cannot get Tom prospect (403)', async () => {
    const service = makeService({
      isConnected: () => true,
      prospect: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p-1',
          ownerAdminUserId: 'local-tom',
          legalName: 'ABC',
          companyType: CompanyType.SENDER,
          invites: [],
          ownerAdminUser: { id: 'local-tom', name: 'Tom', email: 'tom@clox.test' },
          company: null,
        }),
      },
    });
    await expect(service.getProspect(jane, 'p-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.getProspect(jane, 'p-1')).rejects.toThrow(
      'Outside your book of business',
    );
  });

  it('Jane cannot update Tom prospect (404)', async () => {
    const update = jest.fn();
    const service = makeService({
      isConnected: () => true,
      prospect: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p-1',
          ownerAdminUserId: 'local-tom',
        }),
        update,
      },
    });
    await expect(
      service.updateProspect(jane, 'p-1', { stage: 'CONTACTED' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(update).not.toHaveBeenCalled();
  });

  it('listMyCompanies for Jane never queries Tom referrer', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const service = makeService({
      isConnected: () => true,
      company: { findMany, count },
    });
    await service.listMyCompanies(jane, { page: 1, pageSize: 20 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ referredByAdminUserId: 'local-jane' }),
      }),
    );
    expect(findMany.mock.calls[0][0].where.referredByAdminUserId).not.toBe(
      'local-tom',
    );
  });

  it('Local cannot call reassignReferrer (403)', async () => {
    const service = makeService({ isConnected: () => true });
    await expect(
      service.reassignReferrer(tom, 'co-1', { adminUserId: 'local-jane' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('State NSW cannot reassign VIC company (403)', async () => {
    const service = makeService({
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          type: CompanyType.SENDER,
          referredByAdminUserId: 'local-tom',
          referredAt: new Date(),
          homeRegion: { code: 'VIC' },
        }),
        update: jest.fn(),
      },
    });
    await expect(
      service.reassignReferrer(stateNsw, 'co-1', { adminUserId: null }),
    ).rejects.toThrow('Outside admin scope (region)');
  });

  it('State VIC can reassign VIC company to Jane', async () => {
    const update = jest.fn().mockResolvedValue({
      id: 'co-1',
      referredByAdminUserId: 'local-jane',
      referredAt: new Date(),
      referredByAdminUser: { id: 'local-jane', name: 'Jane', email: 'jane@clox.test' },
    });
    const service = makeService({
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          type: CompanyType.SENDER,
          referredByAdminUserId: 'local-tom',
          referredAt: new Date(),
          homeRegion: { code: 'VIC' },
        }),
        update,
      },
      adminUser: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'local-jane',
          role: AdminRole.LOCAL_BDE,
          status: AdminUserStatus.ACTIVE,
          scopes: [{ region: { code: 'VIC' } }],
        }),
      },
    });
    await service.reassignReferrer(stateVic, 'co-1', { adminUserId: 'local-jane' });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ referredByAdminUserId: 'local-jane' }),
      }),
    );
  });

  it('invite from other Local prospect id is 404 for Jane', async () => {
    const service = makeService({
      isConnected: () => true,
      prospect: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p-tom',
          ownerAdminUserId: 'local-tom',
          companyType: CompanyType.SENDER,
        }),
      },
      adminScope: { findMany: jest.fn() },
      companyInvite: { create: jest.fn() },
    });
    await expect(
      service.createInvite(jane, {
        companyType: 'SENDER',
        email: 'x@yopmail.com',
        prospectId: 'p-tom',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
