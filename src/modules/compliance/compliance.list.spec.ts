import { AdminRole } from '../../shared/types';
import { ComplianceService } from './compliance.service';

describe('ComplianceService.listCases territory filter', () => {
  it('returns empty page when Local BDE has empty territoryCodes', async () => {
    const prisma = {
      isConnected: () => true,
      $transaction: jest.fn(),
    };
    const scope = {
      assertAdmin: jest.fn(),
      allowedRegionCodes: jest.fn().mockReturnValue(['VIC']),
      allowedTerritoryCodes: jest.fn().mockReturnValue([]),
      assertRegionAccess: jest.fn(),
    };
    const service = new ComplianceService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      scope as never,
      { lookupAbn: jest.fn() } as never,
    );

    const result = await service.listCases(
      {
        id: 'local-1',
        email: 'l@x.com',
        role: AdminRole.LOCAL_BDE,
        kind: 'admin',
        regionCodes: ['VIC'],
        territoryCodes: [],
      },
      { page: 1, pageSize: 20 },
    );

    expect(result.meta.total).toBe(0);
    expect(result.data).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('applies territory AND clause for Local BDE with MEL', async () => {
    const prisma = {
      isConnected: () => true,
      $transaction: jest.fn().mockResolvedValue([0, []]),
      complianceCase: {
        count: jest.fn(),
        findMany: jest.fn(),
      },
    };
    // $transaction receives array of promises - need to match service
    prisma.$transaction = jest.fn().mockImplementation(async (ops: unknown[]) => {
      return [0, []];
    });
    const scope = {
      assertAdmin: jest.fn(),
      allowedRegionCodes: jest.fn().mockReturnValue(['VIC']),
      allowedTerritoryCodes: jest.fn().mockReturnValue(['MEL']),
      assertRegionAccess: jest.fn(),
    };
    const service = new ComplianceService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      scope as never,
      { lookupAbn: jest.fn() } as never,
    );

    // Patch count/findMany used inside $transaction array - service passes prisma promises
    // Re-implement by making $transaction call through
    const count = jest.fn().mockResolvedValue(0);
    const findMany = jest.fn().mockResolvedValue([]);
    (service as unknown as { prisma: { complianceCase: { count: unknown; findMany: unknown }; $transaction: unknown } }).prisma = {
      isConnected: () => true,
      complianceCase: { count, findMany },
      $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    } as never;

    await service.listCases(
      {
        id: 'local-1',
        email: 'l@x.com',
        role: AdminRole.LOCAL_BDE,
        kind: 'admin',
        regionCodes: ['VIC'],
        territoryCodes: ['MEL'],
      },
      { page: 1, pageSize: 20 },
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.any(Array),
          region: { code: { in: ['VIC'] } },
        }),
      }),
    );
  });
});
