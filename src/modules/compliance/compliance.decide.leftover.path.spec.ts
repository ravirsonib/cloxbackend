import { ForbiddenException } from '@nestjs/common';
import {
  ComplianceCaseStatus,
  CompanyStatus,
  CompanyType,
} from '@prisma/client';
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

describe('ComplianceService approve/reject region + decision leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const abr = { lookupAbn: jest.fn() };
  const scope = {
    assertAdmin: jest.fn(),
    assertRegionAccess: jest.fn(),
    allowedRegionCodes: jest.fn().mockReturnValue(['VIC']),
    allowedTerritoryCodes: jest.fn().mockReturnValue(null),
    assertTerritoryAccess: jest.fn(),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new ComplianceService(
      prisma as never,
      audit as never,
      scope as never,
      abr as never,
    );
  }

  function openCase(companyType: CompanyType, withRegion: boolean) {
    return {
      id: 'case-1',
      status: ComplianceCaseStatus.OPEN,
      companyId: 'co-1',
      company: {
        id: 'co-1',
        type: companyType,
        status: CompanyStatus.PENDING_REVIEW,
        homeRegionId: withRegion ? 'reg-1' : null,
        homeRegion: withRegion ? { code: 'VIC' } : null,
      },
      region: withRegion ? { code: 'VIC' } : null,
      documents: [],
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('State Master cannot load regionless case (Super only)', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue(openCase(CompanyType.CARRIER, false)),
      },
    };
    await expect(
      makeService(prisma).approve(stateMaster, 'case-1', { note: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('Super can approve regionless sender → PENDING_PAYMENT', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue(openCase(CompanyType.SENDER, false)),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          complianceCase: { update: jest.fn() },
          complianceDocument: { updateMany: jest.fn() },
          company: { update: jest.fn() },
        };
        return fn(tx);
      }),
    };
    await expect(
      makeService(prisma).approve(superAdmin, 'case-1', { note: 'sender ok' }),
    ).resolves.toEqual({
      id: 'case-1',
      status: ComplianceCaseStatus.APPROVED,
      companyStatus: CompanyStatus.PENDING_PAYMENT,
    });
    expect(audit.recordPlatform).toHaveBeenCalled();
  });

  it('State Master reject OPEN carrier → company REJECTED', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue(openCase(CompanyType.CARRIER, true)),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          complianceCase: { update: jest.fn() },
          complianceDocument: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          company: { update: jest.fn() },
        };
        return fn(tx);
      }),
    };
    const result = await makeService(prisma).reject(stateMaster, 'case-1', {
      note: 'docs incomplete',
    });
    expect(result).toEqual({
      id: 'case-1',
      status: ComplianceCaseStatus.REJECTED,
      companyStatus: CompanyStatus.REJECTED,
    });
    expect(scope.assertRegionAccess).toHaveBeenCalledWith(stateMaster, 'VIC');
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { note: 'docs incomplete' },
      }),
    );
  });

  it('Super cannot escalate (Local BDE only)', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue(openCase(CompanyType.CARRIER, true)),
      },
    };
    await expect(
      makeService(prisma).escalate(superAdmin, 'case-1', { note: 'nope' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects non-actionable ESCALATED for reject', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue({
          ...openCase(CompanyType.CARRIER, true),
          status: ComplianceCaseStatus.REJECTED,
        }),
      },
      $transaction: jest.fn(),
    };
    await expect(
      makeService(prisma).reject(superAdmin, 'case-1', {}),
    ).rejects.toThrow(/not actionable/i);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
