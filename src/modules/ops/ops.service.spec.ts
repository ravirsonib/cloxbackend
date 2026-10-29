import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { OpsService } from './ops.service';
import { AppRole } from '../../shared/types';

const config = {
  get: (k: string) => (k === 'ADMIN_APP_URL' ? 'http://localhost:5174' : undefined),
};

describe('OpsService.provisionAdmin paths', () => {
  const superP = {
    id: 'super-1',
    email: 'super@x.com',
    role: AppRole.SUPER_ADMIN,
    kind: 'admin' as const,
    regionCodes: [] as string[],
    territoryCodes: [] as string[],
  };

  it('requires territoryCode for LOCAL_BDE', async () => {
    const prisma = {
      isConnected: () => true,
      region: {
        findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }),
      },
    };
    const service = new OpsService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { sendAdminProvisionedEmail: jest.fn() } as never,
      config as never,
    );
    await expect(
      service.provisionAdmin(superP, {
        email: 'local@x.com',
        role: AdminRole.LOCAL_BDE,
        regionCode: 'VIC',
        name: 'Local',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws NotFound for unknown region', async () => {
    const prisma = {
      isConnected: () => true,
      region: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const service = new OpsService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { sendAdminProvisionedEmail: jest.fn() } as never,
      config as never,
    );
    await expect(
      service.provisionAdmin(superP, {
        email: 'x@x.com',
        role: AdminRole.STATE_MASTER,
        regionCode: 'ZZZ',
        name: 'X',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('creates STATE_MASTER with nested STATE scope', async () => {
    const createdAdmin = {
      id: 'adm-1',
      email: 'state@x.com',
      role: AdminRole.STATE_MASTER,
      name: 'State',
      phone: null,
      status: 'INVITED',
      active: false,
      companyId: 'co-1',
      leadId: null,
      scopes: [
        {
          scopeType: 'STATE',
          region: { code: 'VIC' },
          localTerritory: null,
        },
      ],
      company: { id: 'co-1', legalName: 'State' },
    };
    const tx = {
      company: {
        create: jest.fn().mockResolvedValue({ id: 'co-1' }),
      },
      adminUser: {
        create: jest.fn().mockResolvedValue(createdAdmin),
      },
      lead: { update: jest.fn() },
    };
    const prisma = {
      isConnected: () => true,
      region: {
        findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }),
      },
      adminUser: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx)),
    };
    const audit = { recordPlatform: jest.fn() };
    const service = new OpsService(
      prisma as never,
      audit as never,
      {
        sendAdminInviteEmail: jest.fn().mockResolvedValue({ skipped: true }),
      } as never,
      config as never,
    );

    const result = await service.provisionAdmin(superP, {
      email: 'state@x.com',
      role: AdminRole.STATE_MASTER,
      regionCode: 'VIC',
      name: 'State',
    });

    expect(tx.adminUser.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'state@x.com',
          role: AdminRole.STATE_MASTER,
          scopes: {
            create: expect.objectContaining({
              regionId: 'reg-vic',
            }),
          },
        }),
      }),
    );
    expect(result).toMatchObject({
      email: 'state@x.com',
      scopes: [{ regionCode: 'VIC' }],
      invite: expect.objectContaining({ mailSkipped: true }),
    });
  });

  it('throws NotFound for unknown LOCAL_BDE territory', async () => {
    const prisma = {
      isConnected: () => true,
      region: {
        findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }),
      },
      localTerritory: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const service = new OpsService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { sendAdminProvisionedEmail: jest.fn() } as never,
      config as never,
    );
    await expect(
      service.provisionAdmin(superP, {
        email: 'local@x.com',
        role: AdminRole.LOCAL_BDE,
        regionCode: 'VIC',
        territoryCode: 'MISSING',
        name: 'Local',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('publishPolicyStub creates policy version', async () => {
    const prisma = {
      isConnected: () => true,
      policyVersion: {
        create: jest.fn().mockResolvedValue({
          id: 'pv-1',
          key: 'pilot.enabled_states',
          version: 123,
        }),
      },
    };
    const service = new OpsService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { sendAdminProvisionedEmail: jest.fn() } as never,
      config as never,
    );
    await expect(service.publishPolicyStub(superP)).resolves.toEqual({
      id: 'pv-1',
      key: 'pilot.enabled_states',
      version: 123,
    });
  });
});
