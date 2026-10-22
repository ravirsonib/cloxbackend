import {
  CompanyStatus,
  CompanyType,
  ComplianceCaseStatus,
  ComplianceCaseType,
  ComplianceDocStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AdminRole } from '../../shared/types';
import { ComplianceService } from './compliance.service';

const superAdmin: AuthenticatedPrincipal = {
  id: 'admin-1',
  email: 'super@yopmail.com',
  role: AdminRole.SUPER_ADMIN,
  kind: 'admin',
  regionCodes: [],
  territoryCodes: [],
};

describe('ComplianceService CARRIER_FLEET_RWC', () => {
  const audit = { recordPlatform: jest.fn() };
  const abr = { lookupAbn: jest.fn() };
  const scope = {
    assertAdmin: jest.fn(),
    assertRegionAccess: jest.fn(),
  };
  const notifications = {
    sendComplianceDecisionEmail: jest.fn(),
  };
  const attribution = {
    assertLocalOwnsCompany: jest.fn(),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new ComplianceService(
      prisma as never,
      audit as never,
      scope as never,
      attribution as never,
      abr as never,
      notifications as never,
      { applyProposedChanges: jest.fn() } as never
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('approve fleet RWC case marks docs APPROVED without changing company status', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'case-fleet',
          status: ComplianceCaseStatus.OPEN,
          caseType: ComplianceCaseType.CARRIER_FLEET_RWC,
          companyId: 'co-c',
          region: { code: 'VIC' },
          company: {
            id: 'co-c',
            type: CompanyType.CARRIER,
            status: CompanyStatus.BID_ELIGIBLE,
            email: 'c@yopmail.com',
            legalName: 'Carrier',
            homeRegion: { code: 'VIC' },
            referredByAdminUserId: null,
          },
          documents: [{ id: 'rwc-1', vehicleId: 'veh-1' }],
        }),
        update: jest.fn(),
      },
      complianceDocument: { updateMany: jest.fn() },
      company: { update: jest.fn() },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          complianceCase: { update: jest.fn() },
          complianceDocument: { updateMany: jest.fn() },
          company: { update: jest.fn() },
        };
        return fn(tx);
      }),
    };

    const result = await makeService(prisma).approve(superAdmin, 'case-fleet', {
      note: 'fleet ok',
    });
    expect(result).toEqual({
      id: 'case-fleet',
      status: ComplianceCaseStatus.APPROVED,
      companyStatus: CompanyStatus.BID_ELIGIBLE,
    });
    expect(prisma.company.update).not.toHaveBeenCalled();
  });

  it('getCase includes vehicle registration for RWC docs', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'case-kyb',
          status: ComplianceCaseStatus.OPEN,
          caseType: ComplianceCaseType.CARRIER_KYB,
          companyId: 'co-c',
          infoRequestedAt: null,
          region: { code: 'VIC' },
          company: {
            id: 'co-c',
            type: CompanyType.CARRIER,
            status: CompanyStatus.PENDING_REVIEW,
            abn: '51824753556',
            email: 'c@yopmail.com',
            legalName: 'Carrier',
            homeRegion: { code: 'VIC' },
            referredByAdminUserId: null,
          },
          documents: [
            {
              id: 'rwc-1',
              docType: 'RWC',
              vehicleId: 'veh-1',
              status: ComplianceDocStatus.UNDER_REVIEW,
              createdAt: new Date('2026-10-22T00:00:00Z'),
              originalFilename: 'rwc.pdf',
              expiresAt: null,
            },
          ],
        }),
      },
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'veh-1', registration: 'ABC123', label: 'Primary' },
        ]),
      },
    };

    const result = await makeService(prisma).getCase(superAdmin, 'case-kyb');
    expect(result.documents[0]).toMatchObject({
      id: 'rwc-1',
      vehicleRegistration: 'ABC123',
      vehicleLabel: 'Primary',
    });
  });
});
