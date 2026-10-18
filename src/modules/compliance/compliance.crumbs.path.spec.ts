import {
  CompanyStatus,
  CompanyType,
  ComplianceCaseStatus,
  ComplianceCaseType,
  ComplianceDocStatus,
  ComplianceDocType,
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
  id: 'admin-bde',
  email: 'bde@yopmail.com',
  role: AppRole.LOCAL_BDE,
  kind: 'admin',
  regionCodes: ['VIC'],
  territoryCodes: ['MEL'],
};

describe('ComplianceService crumb branch leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const scope = {
    assertAdmin: jest.fn(),
    assertRegionAccess: jest.fn(),
    allowedTerritoryCodes: jest.fn().mockReturnValue(null),
    allowedRegionCodes: jest.fn().mockReturnValue(null),
    assertTerritoryAccess: jest.fn(),
  };
  const abr = { lookupAbn: jest.fn() } as unknown as AbrService;

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
    scope.allowedTerritoryCodes.mockReturnValue(null);
    scope.allowedRegionCodes.mockReturnValue(null);
  });

  it('LOCAL_BDE territory null early-return on getCase', async () => {
    scope.allowedTerritoryCodes.mockReturnValue(null);
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'case-1',
          status: ComplianceCaseStatus.OPEN,
          companyId: 'co-c',
          company: {
            id: 'co-c',
            homeRegionId: 'reg-vic',
            homeRegion: { code: 'VIC' },
            abn: null,
          },
          region: { code: 'VIC' },
          documents: [],
        }),
      },
    };
    await expect(makeService(prisma).getCase(localBde, 'case-1')).resolves.toMatchObject({
      id: 'case-1',
    });
  });

  it('admin submit sets submittedByUserId null + admin audit actors', async () => {
    const docIds = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-c',
          type: CompanyType.CARRIER,
          abn: '51824753556',
          homeRegionId: 'reg-vic',
          homeRegion: { code: 'VIC' },
        }),
        update: jest.fn(),
      },
      complianceDocument: {
        findMany: jest.fn().mockResolvedValue([
          { id: docIds[0], docType: ComplianceDocType.PUBLIC_LIABILITY, status: ComplianceDocStatus.UPLOADED },
          { id: docIds[1], docType: ComplianceDocType.CARGO_INSURANCE, status: ComplianceDocStatus.UPLOADED },
          { id: docIds[2], docType: ComplianceDocType.RWC, status: ComplianceDocStatus.UPLOADED },
        ]),
      },
      complianceCase: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          complianceCase: {
            create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
              expect(data.submittedByUserId).toBeNull();
              return {
                id: 'case-admin',
                status: ComplianceCaseStatus.OPEN,
                caseType: ComplianceCaseType.CARRIER_KYB,
              };
            }),
          },
          complianceDocument: { updateMany: jest.fn() },
          company: { update: jest.fn() },
        };
        return fn(tx);
      }),
    };
    await makeService(prisma).submit(superAdmin, {
      companyId: 'co-c',
      caseType: ComplianceCaseType.CARRIER_KYB,
      documentIds: docIds,
    });
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        actorAdminId: 'admin-1',
        actorUserId: undefined,
      }),
    );
  });

  it('reject / requestInfo / escalate with undefined note → null metadata', async () => {
    const open = {
      id: 'case-1',
      status: ComplianceCaseStatus.OPEN,
      companyId: 'co-c',
      company: {
        id: 'co-c',
        type: CompanyType.CARRIER,
        status: CompanyStatus.PENDING_REVIEW,
        homeRegion: { code: 'VIC' },
        homeRegionId: 'reg-vic',
      },
      region: { code: 'VIC' },
      documents: [],
    };
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue(open),
        update: jest.fn().mockResolvedValue({}),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'job-1',
          originTerritory: { code: 'MEL' },
        }),
      },
      localTerritory: { findFirst: jest.fn() },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          complianceCase: { update: jest.fn() },
          complianceDocument: { updateMany: jest.fn() },
          company: { update: jest.fn() },
        };
        return fn(tx);
      }),
    };
    const svc = makeService(prisma);
    await svc.reject(superAdmin, 'case-1', {} as never);
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { note: null } }),
    );

    await svc.requestInfo(superAdmin, 'case-1', {} as never);
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.anything(),
        metadata: { note: null },
      }),
    );

    scope.allowedTerritoryCodes.mockReturnValue(['MEL']);
    await svc.escalate(localBde, 'case-1', {} as never);
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { note: null } }),
    );
  });
});
