import { ForbiddenException } from '@nestjs/common';
import {
  ComplianceCaseStatus,
  CompanyStatus,
  CompanyType,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AppRole } from '../../shared/types';
import { AbrService } from './abr.service';
import { ComplianceService } from './compliance.service';

const superAdmin: AuthenticatedPrincipal = {
  id: 'admin-1',
  email: 'admin@yopmail.com',
  role: AppRole.SUPER_ADMIN,
  kind: 'admin',
  regionCodes: [],
  territoryCodes: [],
};

const localBde: AuthenticatedPrincipal = {
  id: 'admin-local',
  email: 'local@yopmail.com',
  role: AppRole.LOCAL_BDE,
  kind: 'admin',
  regionCodes: ['VIC'],
  territoryCodes: ['MEL'],
};

describe('ComplianceService requestInfo + escalate paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const scope = {
    assertAdmin: jest.fn(),
    assertRegionAccess: jest.fn(),
    allowedTerritoryCodes: jest.fn().mockReturnValue(null),
    assertTerritoryAccess: jest.fn(),
  };
  const abr = {
    lookupAbn: jest.fn(),
  } as unknown as AbrService;

  function openCase() {
    return {
      id: 'case-1',
      status: ComplianceCaseStatus.OPEN,
      companyId: 'co-1',
      company: {
        id: 'co-1',
        type: CompanyType.CARRIER,
        status: CompanyStatus.PENDING_REVIEW,
        homeRegion: { code: 'VIC' },
        homeRegionId: 'reg-vic',
      },
      region: { code: 'VIC' },
      documents: [],
    };
  }

  function makeService(prisma: Record<string, unknown>) {
    return new ComplianceService(
      prisma as never,
      audit as never,
      scope as never,
      abr,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requestInfo sets INFO_REQUESTED on case + company', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue(openCase()),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          complianceCase: { update: jest.fn() },
          company: { update: jest.fn() },
        };
        return fn(tx);
      }),
    };
    const service = makeService(prisma);
    await expect(
      service.requestInfo(superAdmin, 'case-1', { note: 'Need RWC photo' }),
    ).resolves.toEqual({
      id: 'case-1',
      status: ComplianceCaseStatus.INFO_REQUESTED,
      companyStatus: CompanyStatus.INFO_REQUESTED,
    });
    expect(audit.recordPlatform).toHaveBeenCalled();
  });

  it('escalate rejects non-LOCAL_BDE', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: { findUnique: jest.fn().mockResolvedValue(openCase()) },
    };
    const service = makeService(prisma);
    await expect(
      service.escalate(superAdmin, 'case-1', { note: 'up' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('escalate marks ESCALATED for Local BDE', async () => {
    scope.allowedTerritoryCodes.mockReturnValue(['MEL']);
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue(openCase()),
        update: jest.fn().mockResolvedValue({}),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'job-1',
          originTerritory: { code: 'MEL' },
        }),
      },
      localTerritory: { findFirst: jest.fn() },
    };
    const service = makeService(prisma);
    await expect(
      service.escalate(localBde, 'case-1', { note: 'Need Super eyes' }),
    ).resolves.toEqual({
      id: 'case-1',
      status: ComplianceCaseStatus.ESCALATED,
    });
    expect(prisma.complianceCase.update).toHaveBeenCalledWith({
      where: { id: 'case-1' },
      data: expect.objectContaining({
        status: ComplianceCaseStatus.ESCALATED,
        decisionNote: 'Need Super eyes',
      }),
    });
  });

  it('getCase returns case with abrAssist null when no ABN', async () => {
    const row = openCase();
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue(row),
      },
    };
    const service = makeService(prisma);
    await expect(service.getCase(superAdmin, 'case-1')).resolves.toEqual({
      ...row,
      abrAssist: null,
    });
  });

  it('getCase includes abrAssist when company has ABN', async () => {
    const row = {
      ...openCase(),
      company: {
        ...openCase().company,
        abn: '51824753556',
      },
    };
    (abr.lookupAbn as jest.Mock).mockResolvedValue({
      configured: false,
      abn: '51824753556',
      active: null,
      entityName: null,
      abnStatus: null,
      message: 'ABR_GUID not configured',
    });
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue(row),
      },
    };
    const service = makeService(prisma);
    const result = await service.getCase(superAdmin, 'case-1');
    expect(result.abrAssist).toMatchObject({ abn: '51824753556', configured: false });
    expect(abr.lookupAbn).toHaveBeenCalledWith('51824753556');
  });
});
