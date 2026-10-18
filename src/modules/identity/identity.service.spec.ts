import { ServiceUnavailableException } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { AppRole } from '../../shared/types';

describe('IdentityService.getMe paths', () => {
  it('throws when database disconnected', async () => {
    const service = new IdentityService({ isConnected: () => false } as never);
    await expect(
      service.getMe({
        id: 'a1',
        email: 'a@x.com',
        role: AppRole.SUPER_ADMIN,
        kind: 'admin',
        regionCodes: [],
        territoryCodes: [],
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns admin scopes from DB', async () => {
    const prisma = {
      isConnected: () => true,
      adminUser: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'a1',
          email: 'state@x.com',
          name: 'State',
          role: 'STATE_MASTER',
          active: true,
          scopes: [
            {
              scopeType: 'STATE',
              region: { code: 'VIC' },
              localTerritory: null,
            },
          ],
        }),
      },
    };
    const service = new IdentityService(prisma as never);
    const me = await service.getMe({
      id: 'a1',
      email: 'ignored@jwt.com',
      role: AppRole.SUPER_ADMIN,
      kind: 'admin',
      regionCodes: [],
      territoryCodes: [],
    });
    expect(me).toMatchObject({
      kind: 'admin',
      email: 'state@x.com',
      role: 'STATE_MASTER',
      scopes: [{ regionCode: 'VIC', territoryCode: null }],
    });
  });

  it('returns user company snapshot', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'u1',
          email: 'sender.clox@yopmail.com',
          phone: null,
          name: 'Sender',
          role: 'SENDER',
          status: 'ACTIVE',
          company: {
            id: 'co1',
            type: 'SENDER',
            legalName: 'Acme',
            status: 'ACTIVE',
          },
        }),
      },
    };
    const service = new IdentityService(prisma as never);
    const me = await service.getMe({
      id: 'u1',
      email: 'sender.clox@yopmail.com',
      role: AppRole.SENDER,
      kind: 'user',
      regionCodes: [],
      territoryCodes: [],
    });
    expect(me).toMatchObject({
      kind: 'user',
      company: { id: 'co1', legalName: 'Acme' },
    });
  });

  it('returns null company and null scope codes when joins missing', async () => {
    const adminPrisma = {
      isConnected: () => true,
      adminUser: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'a2',
          email: 'ops@yopmail.com',
          name: 'Ops',
          role: 'SUPER_ADMIN',
          active: true,
          scopes: [
            {
              scopeType: 'LOCAL',
              region: null,
              localTerritory: { code: 'MEL' },
            },
          ],
        }),
      },
    };
    const adminMe = await new IdentityService(adminPrisma as never).getMe({
      id: 'a2',
      email: 'ops@yopmail.com',
      role: AppRole.SUPER_ADMIN,
      kind: 'admin',
      regionCodes: [],
      territoryCodes: [],
    });
    expect(adminMe).toMatchObject({
      kind: 'admin',
      scopes: [{ regionCode: null, territoryCode: 'MEL' }],
    });

    const userPrisma = {
      isConnected: () => true,
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'u2',
          email: 'solo@yopmail.com',
          phone: null,
          name: 'Solo',
          role: 'SENDER',
          status: 'ACTIVE',
          company: null,
        }),
      },
    };
    const userMe = await new IdentityService(userPrisma as never).getMe({
      id: 'u2',
      email: 'solo@yopmail.com',
      role: AppRole.SENDER,
      kind: 'user',
      regionCodes: [],
      territoryCodes: [],
    });
    expect(userMe).toMatchObject({ kind: 'user', company: null });
  });
});
