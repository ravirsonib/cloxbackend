import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { ComplianceService } from './compliance.service';

describe('ComplianceService assertCanDecide role leftover', () => {
  it('rejects admin role that is neither Super nor State Master', async () => {
    const weirdAdmin: AuthenticatedPrincipal = {
      id: 'admin-x',
      email: 'ops@yopmail.com',
      role: 'AUDITOR' as AuthenticatedPrincipal['role'],
      kind: 'admin',
      regionCodes: ['VIC'],
      territoryCodes: [],
    };
    const scope = {
      assertAdmin: jest.fn(),
      assertRegionAccess: jest.fn(),
      assertTerritoryAccess: jest.fn(),
      allowedTerritoryCodes: jest.fn(),
    };
    const service = new ComplianceService(
      {
        isConnected: () => true,
        complianceCase: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'case-1',
            status: 'SUBMITTED',
            company: { homeRegion: { code: 'VIC' }, homeRegionId: 'reg-1' },
          }),
        },
      } as never,
      { recordPlatform: jest.fn() } as never,
      scope as never,
      { lookupAbn: jest.fn() } as never,
    );

    await expect(
      service.approve(weirdAdmin, 'case-1', { note: 'n' } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.approve(weirdAdmin, 'case-1', { note: 'n' } as never),
    ).rejects.toThrow('Insufficient role for compliance decision');
  });
});
