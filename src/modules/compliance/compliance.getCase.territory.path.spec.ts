import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CompanyType, ComplianceCaseStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AdminRole } from '../../shared/types';
import { ComplianceService } from './compliance.service';

const localBde: AuthenticatedPrincipal = {
  id: 'admin-bde',
  email: 'bde@yopmail.com',
  role: AdminRole.LOCAL_BDE,
  kind: 'admin',
  regionCodes: ['VIC'],
  territoryCodes: ['MEL'],
};

const stateMaster: AuthenticatedPrincipal = {
  id: 'admin-state',
  email: 'state@yopmail.com',
  role: AdminRole.STATE_MASTER,
  kind: 'admin',
  regionCodes: ['VIC'],
  territoryCodes: [],
};

describe('ComplianceService getCase territory leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const abr = { lookupAbn: jest.fn().mockResolvedValue(null) };

  function makeService(
    prisma: Record<string, unknown>,
    scopeOverrides: Record<string, unknown> = {},
  ) {
    const scope = {
      assertAdmin: jest.fn(),
      assertRegionAccess: jest.fn(),
      assertTerritoryAccess: jest.fn(),
      allowedRegionCodes: jest.fn().mockReturnValue(['VIC']),
      allowedTerritoryCodes: jest.fn().mockReturnValue(['MEL']),
      ...scopeOverrides,
    };
    return {
      service: new ComplianceService(
        prisma as never,
        audit as never,
        scope as never,
        abr as never,
      ),
      scope,
    };
  }

  function openCase(overrides: Record<string, unknown> = {}) {
    return {
      id: 'case-1',
      status: ComplianceCaseStatus.OPEN,
      companyId: 'co-1',
      company: {
        id: 'co-1',
        type: CompanyType.CARRIER,
        abn: null,
        homeRegionId: 'reg-vic',
        homeRegion: { code: 'VIC' },
      },
      region: { code: 'VIC' },
      documents: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('404 when case missing', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const { service } = makeService(prisma);
    await expect(service.getCase(stateMaster, 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('forbids non-Super when case has no region', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue(
          openCase({
            region: null,
            company: {
              id: 'co-1',
              type: CompanyType.CARRIER,
              abn: null,
              homeRegionId: null,
              homeRegion: null,
            },
          }),
        ),
      },
    };
    const { service } = makeService(prisma, {
      allowedTerritoryCodes: jest.fn().mockReturnValue(null),
    });
    await expect(service.getCase(stateMaster, 'case-1')).rejects.toMatchObject({
      message: 'Case has no region — Super only',
    });
  });

  it('Local BDE allowed via home-region territory match', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue(openCase()),
      },
      job: { findFirst: jest.fn().mockResolvedValue(null) },
      localTerritory: {
        findFirst: jest.fn().mockResolvedValue({ code: 'MEL', enabled: true }),
      },
    };
    const { service, scope } = makeService(prisma);
    const result = await service.getCase(localBde, 'case-1');
    expect(result).toMatchObject({
      id: 'case-1',
      abrAssist: null,
    });
    expect(scope.assertTerritoryAccess).toHaveBeenCalledWith(localBde, 'MEL');
  });

  it('Local BDE forbidden outside territory', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue(openCase()),
      },
      job: { findFirst: jest.fn().mockResolvedValue(null) },
      localTerritory: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const { service } = makeService(prisma);
    await expect(service.getCase(localBde, 'case-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('Local BDE with empty territory scope forbidden', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue(openCase()),
      },
    };
    const { service } = makeService(prisma, {
      allowedTerritoryCodes: jest.fn().mockReturnValue([]),
    });
    await expect(service.getCase(localBde, 'case-1')).rejects.toMatchObject({
      message: 'Local BDE has no territory scope',
    });
  });
});
