import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { OpsService } from './ops.service';

const superAdmin: AuthenticatedPrincipal = {
  id: 'admin-1',
  email: 'super@yopmail.com',
  role: 'SUPER_ADMIN',
  kind: 'admin',
  regionCodes: [],
  territoryCodes: [],
};

describe('OpsService leftover paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const notifications = { sendMail: jest.fn() };

  function makeService(prisma: Record<string, unknown>) {
    return new OpsService(prisma as never, audit as never, notifications as never);
  }

  it('ensureDatabase throws when offline', async () => {
    await expect(
      makeService({ isConnected: () => false }).provisionAdmin(superAdmin, {
        email: 'new@yopmail.com',
        role: 'STATE_MASTER',
        regionCode: 'VIC',
      } as never),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('provisionAdmin LOCAL_BDE sets territoryId', async () => {
    const prisma = {
      isConnected: () => true,
      region: { findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }) },
      localTerritory: {
        findUnique: jest.fn().mockResolvedValue({ id: 't-mel', code: 'MEL' }),
      },
      adminUser: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'admin-new',
          email: 'bde@yopmail.com',
          name: 'BDE',
          role: 'LOCAL_BDE',
          scopes: [
            {
              scopeType: 'LOCAL',
              region: { code: 'VIC' },
              localTerritory: { code: 'MEL' },
            },
          ],
        }),
      },
    };
    const result = await makeService(prisma).provisionAdmin(superAdmin, {
      email: 'bde@yopmail.com',
      name: 'BDE',
      role: 'LOCAL_BDE',
      regionCode: 'VIC',
      territoryCode: 'MEL',
    } as never);
    expect(result).toMatchObject({ email: 'bde@yopmail.com' });
    expect(prisma.adminUser.create).toHaveBeenCalled();
  });

  it('provisionAdmin conflicts on duplicate email', async () => {
    const prisma = {
      isConnected: () => true,
      region: { findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }) },
      adminUser: {
        findUnique: jest.fn().mockResolvedValue({ id: 'existing' }),
      },
    };
    await expect(
      makeService(prisma).provisionAdmin(superAdmin, {
        email: 'dup@yopmail.com',
        role: 'STATE_MASTER',
        regionCode: 'VIC',
      } as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('provisionAdmin 404 unknown territory', async () => {
    const prisma = {
      isConnected: () => true,
      region: { findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }) },
      localTerritory: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).provisionAdmin(superAdmin, {
        email: 'bde@yopmail.com',
        role: 'LOCAL_BDE',
        regionCode: 'VIC',
        territoryCode: 'ZZZ',
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
