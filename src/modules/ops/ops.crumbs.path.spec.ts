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

describe('OpsService crumb branch leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const notifications = { sendMail: jest.fn().mockResolvedValue({ skipped: true }) };

  it('provisionAdmin without name → null; scope without region/territory codes', async () => {
    const prisma = {
      isConnected: () => true,
      region: { findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }) },
      adminUser: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'admin-new',
          email: 'state@yopmail.com',
          name: null,
          role: 'STATE_MASTER',
          scopes: [
            {
              scopeType: 'STATE',
              region: null,
              localTerritory: null,
            },
          ],
        }),
      },
    };
    const result = await new OpsService(
      prisma as never,
      audit as never,
      notifications as never,
    ).provisionAdmin(superAdmin, {
      email: 'state@yopmail.com',
      role: 'STATE_MASTER',
      regionCode: 'VIC',
    } as never);
    expect(prisma.adminUser.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: null }),
      }),
    );
    expect(result.scopes[0]).toMatchObject({
      regionCode: null,
      territoryCode: null,
    });
  });
});
