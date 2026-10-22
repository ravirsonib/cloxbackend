import { AdminRole } from '../../shared/types';
import { ComplianceService } from './compliance.service';

describe('ComplianceService.listCases book-of-business filter', () => {
  it('applies referredBy filter for Local BDE', async () => {
    const count = jest.fn().mockResolvedValue(0);
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      isConnected: () => true,
      complianceCase: { count, findMany },
      $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    };
    const scope = {
      assertAdmin: jest.fn(),
      allowedRegionCodes: jest.fn().mockReturnValue(['VIC']),
      allowedTerritoryCodes: jest.fn().mockReturnValue(['MEL']),
      assertRegionAccess: jest.fn(),
    };
    const attribution = {
      assertLocalOwnsCompany: jest.fn(),
      complianceCaseBookFilter: jest.fn().mockReturnValue({
        company: { referredByAdminUserId: 'local-1' },
      }),
    };
    const service = new ComplianceService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      scope as never,
      attribution as never,
      { lookupAbn: jest.fn() } as never,
      {
        sendComplianceApprovedEmail: jest.fn().mockResolvedValue({ skipped: true }),
        sendComplianceInfoRequestedEmail: jest.fn().mockResolvedValue({ skipped: true }),
      } as never,
      { applyProposedChanges: jest.fn() } as never
    );

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

    expect(attribution.complianceCaseBookFilter).toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { company: { referredByAdminUserId: 'local-1' } },
          ]),
          region: { code: { in: ['VIC'] } },
        }),
      }),
    );
  });
});
