import { ComplianceCaseStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AdminRole } from '../../shared/types';
import { ComplianceService } from './compliance.service';

const superAdmin: AuthenticatedPrincipal = {
  id: 'admin-1',
  email: 'admin@yopmail.com',
  role: AdminRole.SUPER_ADMIN,
  kind: 'admin',
  regionCodes: [],
  territoryCodes: [],
};

const stateMaster: AuthenticatedPrincipal = {
  id: 'admin-state',
  email: 'state@yopmail.com',
  role: AdminRole.STATE_MASTER,
  kind: 'admin',
  regionCodes: ['VIC'],
  territoryCodes: [],
};

describe('ComplianceService listCases leftover filters', () => {
  const audit = { recordPlatform: jest.fn() };
  const abr = { lookupAbn: jest.fn() };

  function makeService(
    prisma: Record<string, unknown>,
    scopeOverrides: Record<string, unknown> = {},
  ) {
    const scope = {
      assertAdmin: jest.fn(),
      assertRegionAccess: jest.fn(),
      allowedRegionCodes: jest.fn().mockReturnValue(null),
      allowedTerritoryCodes: jest.fn().mockReturnValue(null),
      assertTerritoryAccess: jest.fn(),
      ...scopeOverrides,
    };
    return new ComplianceService(
      prisma as never,
      audit as never,
      scope as never,
      abr as never,
    );
  }

  it('Super applies status + caseType filters without region constraint', async () => {
    const count = jest.fn().mockResolvedValue(1);
    const findMany = jest.fn().mockResolvedValue([
      { id: 'case-1', status: ComplianceCaseStatus.OPEN },
    ]);
    const prisma = {
      isConnected: () => true,
      complianceCase: { count, findMany },
      $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    };
    const result = await makeService(prisma).listCases(superAdmin, {
      page: 1,
      pageSize: 10,
      status: ComplianceCaseStatus.OPEN,
      caseType: 'CARRIER_KYB' as never,
    });
    expect(result.meta).toMatchObject({ total: 1, page: 1, limit: 10, totalPages: 1 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: ComplianceCaseStatus.OPEN,
          caseType: 'CARRIER_KYB',
        },
        take: 10,
        skip: 0,
      }),
    );
  });

  it('State Master scopes to allowed regions and optional regionCode', async () => {
    const count = jest.fn().mockResolvedValue(0);
    const findMany = jest.fn().mockResolvedValue([]);
    const scope = {
      assertAdmin: jest.fn(),
      assertRegionAccess: jest.fn(),
      allowedRegionCodes: jest.fn().mockReturnValue(['VIC', 'NSW']),
      allowedTerritoryCodes: jest.fn().mockReturnValue(null),
      assertTerritoryAccess: jest.fn(),
    };
    const prisma = {
      isConnected: () => true,
      complianceCase: { count, findMany },
      $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    };
    const service = new ComplianceService(
      prisma as never,
      audit as never,
      scope as never,
      abr as never,
    );

    await service.listCases(stateMaster, { page: 2, pageSize: 5 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { region: { code: { in: ['VIC', 'NSW'] } } },
        skip: 5,
        take: 5,
      }),
    );

    await service.listCases(stateMaster, {
      page: 1,
      pageSize: 20,
      regionCode: 'VIC',
    });
    expect(scope.assertRegionAccess).toHaveBeenCalledWith(stateMaster, 'VIC');
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { region: { code: 'VIC' } },
      }),
    );
  });
});
