import { BadRequestException } from '@nestjs/common';
import { ComplianceCaseStatus, CompanyStatus, CompanyType } from '@prisma/client';
import { AbrService } from './abr.service';
import { ComplianceService } from './compliance.service';
import { AppRole } from '../../shared/types';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';

function superAdmin(): AuthenticatedPrincipal {
  return {
    id: 'admin-1',
    email: 'cloxadmin@yopmail.com',
    role: AppRole.SUPER_ADMIN,
    kind: 'admin',
    regionCodes: [],
    territoryCodes: [],
  };
}

describe('ComplianceService decision gates', () => {
  it('rejects already-APPROVED case (does not trash company)', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'case-1',
          status: ComplianceCaseStatus.APPROVED,
          companyId: 'co-1',
          company: {
            id: 'co-1',
            type: CompanyType.CARRIER,
            status: CompanyStatus.BID_ELIGIBLE,
            homeRegion: { code: 'VIC' },
            homeRegionId: 'reg-vic',
          },
          region: { code: 'VIC' },
          documents: [],
        }),
      },
      $transaction: jest.fn(),
    };
    const audit = { recordPlatform: jest.fn() };
    const scope = {
      assertAdmin: jest.fn(),
      assertRegionAccess: jest.fn(),
      allowedTerritoryCodes: jest.fn().mockReturnValue(null),
      assertTerritoryAccess: jest.fn(),
    };
    const abr = { lookupAbn: jest.fn() } as unknown as AbrService;
    const service = new ComplianceService(
      prisma as never,
      audit as never,
      scope as never,
      abr,
    );

    await expect(service.reject(superAdmin(), 'case-1', { note: 'oops' })).rejects.toThrow(
      /not actionable/i,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects requestInfo on APPROVED case', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'case-1',
          status: ComplianceCaseStatus.APPROVED,
          companyId: 'co-1',
          company: {
            id: 'co-1',
            type: CompanyType.SENDER,
            status: CompanyStatus.ACTIVE,
            homeRegion: { code: 'VIC' },
            homeRegionId: 'reg-vic',
          },
          region: { code: 'VIC' },
          documents: [],
        }),
      },
      $transaction: jest.fn(),
    };
    const service = new ComplianceService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      {
        assertAdmin: jest.fn(),
        assertRegionAccess: jest.fn(),
        allowedTerritoryCodes: jest.fn().mockReturnValue(null),
        assertTerritoryAccess: jest.fn(),
      } as never,
      { lookupAbn: jest.fn() } as never,
    );

    await expect(service.requestInfo(superAdmin(), 'case-1', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
