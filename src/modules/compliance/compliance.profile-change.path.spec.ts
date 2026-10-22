import {
  CompanyStatus,
  CompanyType,
  ComplianceCaseStatus,
  ComplianceCaseType,
} from '@prisma/client';
import { ComplianceService } from './compliance.service';
import { AppRole } from '../../shared/types';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';

describe('ComplianceService COMPANY_PROFILE_CHANGE', () => {
  const superAdmin: AuthenticatedPrincipal = {
    id: 'admin-1',
    email: 'super@yopmail.com',
    role: AppRole.SUPER_ADMIN,
    kind: 'admin',
    regionCodes: [],
    territoryCodes: [],
  };

  const scope = {
    assertAdmin: jest.fn(),
    assertRegionAccess: jest.fn(),
    allowedRegionCodes: jest.fn().mockReturnValue(null),
    allowedTerritoryCodes: jest.fn().mockReturnValue(null),
    assertTerritoryAccess: jest.fn(),
  };
  const audit = { recordPlatform: jest.fn() };
  const abr = { lookupAbn: jest.fn() };
  const notifications = {
    sendComplianceApprovedEmail: jest.fn().mockResolvedValue({ skipped: true }),
    sendComplianceInfoRequestedEmail: jest.fn().mockResolvedValue({ skipped: true }),
  };
  const attribution = {
    assertLocalOwnsCompany: jest.fn(),
    complianceCaseBookFilter: jest.fn().mockReturnValue(null),
  };

  function openProfileCase() {
    return {
      id: 'case-p',
      status: ComplianceCaseStatus.OPEN,
      caseType: ComplianceCaseType.COMPANY_PROFILE_CHANGE,
      companyId: 'co-c',
      proposedChanges: { legalName: 'Haul Co Pty', abn: '11111111111' },
      region: { code: 'VIC' },
      company: {
        id: 'co-c',
        type: CompanyType.CARRIER,
        status: CompanyStatus.BID_ELIGIBLE,
        legalName: 'Haul Co',
        email: 'c@x.com',
        homeRegion: { code: 'VIC' },
        homeRegionId: 'reg-vic',
        referredByAdminUserId: null,
      },
      documents: [],
    };
  }

  it('approve applies proposedChanges and keeps company status', async () => {
    const applied = { legalName: 'Haul Co Pty', abn: '11111111111' };
    const applyProposedChanges = jest.fn().mockResolvedValue(applied);
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue(openProfileCase()),
        update: jest.fn(),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) => {
        const tx = {
          complianceCase: { update: jest.fn() },
        };
        await fn(tx);
      }),
    };

    const service = new ComplianceService(
      prisma as never,
      audit as never,
      scope as never,
      attribution as never,
      abr as never,
      notifications as never,
      { applyProposedChanges } as never,
    );

    const result = await service.approve(superAdmin, 'case-p', { note: 'ok' });
    expect(result).toEqual({
      id: 'case-p',
      status: ComplianceCaseStatus.APPROVED,
      companyStatus: CompanyStatus.BID_ELIGIBLE,
    });
    expect(applyProposedChanges).toHaveBeenCalledWith(
      expect.anything(),
      'co-c',
      { legalName: 'Haul Co Pty', abn: '11111111111' },
    );
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'compliance.approved',
        metadata: expect.objectContaining({
          caseType: ComplianceCaseType.COMPANY_PROFILE_CHANGE,
          nextCompanyStatus: CompanyStatus.BID_ELIGIBLE,
        }),
      }),
    );
  });

  it('reject closes case without rejecting company', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue(openProfileCase()),
      },
      complianceDocument: { updateMany: jest.fn() },
      company: { update: jest.fn() },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) => {
        await fn({
          complianceCase: { update: jest.fn() },
          complianceDocument: { updateMany: jest.fn() },
        });
      }),
    };

    const service = new ComplianceService(
      prisma as never,
      audit as never,
      scope as never,
      attribution as never,
      abr as never,
      notifications as never,
      { applyProposedChanges: jest.fn() } as never,
    );

    const result = await service.reject(superAdmin, 'case-p', { note: 'no' });
    expect(result.companyStatus).toBe(CompanyStatus.BID_ELIGIBLE);
    expect(prisma.company.update).not.toHaveBeenCalled();
  });
});
