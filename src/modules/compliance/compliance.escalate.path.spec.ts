import { ForbiddenException } from '@nestjs/common';
import {
  ComplianceCaseStatus,
  ComplianceCaseType,
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
      caseType: ComplianceCaseType.CARRIER_KYB,
      infoRequestedAt: null as Date | null,
      company: {
        id: 'co-1',
        type: CompanyType.CARRIER,
        status: CompanyStatus.PENDING_REVIEW,
        legalName: 'Carrier Co',
        email: 'carrier@yopmail.com',
        homeRegion: { code: 'VIC' },
        homeRegionId: 'reg-vic',
      },
      region: { code: 'VIC' },
      documents: [] as Array<{
        id: string;
        createdAt: Date;
        docType: string;
        status: string;
      }>,
    };
  }

  function makeService(
    prisma: Record<string, unknown>,
    inbox?: { notifyComplianceCaseToOps: jest.Mock },
  ) {
    return new ComplianceService(
      prisma as never,
      audit as never,
      scope as never,
      { assertLocalOwnsCompany: jest.fn(), complianceCaseBookFilter: jest.fn().mockImplementation((p) => (p.role === 'LOCAL_BDE' ? { company: { referredByAdminUserId: p.id } } : null)) } as never,
      abr,
      { sendComplianceApprovedEmail: jest.fn().mockResolvedValue({ skipped: true }), sendComplianceInfoRequestedEmail: jest.fn().mockResolvedValue({ skipped: true }) } as never,
      { applyProposedChanges: jest.fn() } as never,
      inbox as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requestInfo sets INFO_REQUESTED on case + company', async () => {
    const caseUpdate = jest.fn();
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue(openCase()),
      },
      user: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'u-carrier', email: 'carrier@yopmail.com' }]),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          complianceCase: { update: caseUpdate },
          company: { update: jest.fn() },
        };
        return fn(tx);
      }),
    };
    const inbox = {
      notifyUsers: jest.fn().mockResolvedValue(1),
      notifyComplianceCaseToOps: jest.fn().mockResolvedValue(0),
    };
    const service = makeService(prisma, inbox);
    await expect(
      service.requestInfo(superAdmin, 'case-1', { note: 'Need RWC photo' }),
    ).resolves.toEqual({
      id: 'case-1',
      status: ComplianceCaseStatus.INFO_REQUESTED,
      companyStatus: CompanyStatus.INFO_REQUESTED,
    });
    expect(caseUpdate).toHaveBeenCalledWith({
      where: { id: 'case-1' },
      data: expect.objectContaining({
        status: ComplianceCaseStatus.INFO_REQUESTED,
        decisionNote: 'Need RWC photo',
        infoRequestedAt: expect.any(Date),
      }),
    });
    expect(audit.recordPlatform).toHaveBeenCalled();
    // fire-and-forget; allow microtask flush
    await Promise.resolve();
    expect(inbox.notifyUsers).toHaveBeenCalledWith(
      expect.objectContaining({
        userIds: ['u-carrier'],
        type: 'COMPLIANCE_INFO_REQUESTED',
        entityId: 'case-1',
        href: '/carrier/onboarding',
      }),
    );
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
    const inbox = {
      notifyComplianceCaseToOps: jest.fn().mockResolvedValue(2),
    };
    const service = makeService(prisma, inbox);
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
    expect(inbox.notifyComplianceCaseToOps).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: 'case-1',
        regionId: 'reg-vic',
        type: 'COMPLIANCE_ESCALATED',
        title: 'Compliance escalated: Carrier Co',
      }),
    );
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

  it('getCase flags documents uploaded after infoRequestedAt', async () => {
    const infoRequestedAt = new Date('2026-10-01T10:00:00.000Z');
    const row = {
      ...openCase(),
      infoRequestedAt,
      documents: [
        {
          id: 'doc-old',
          docType: 'RWC',
          status: 'UNDER_REVIEW',
          createdAt: new Date('2026-09-20T10:00:00.000Z'),
        },
        {
          id: 'doc-new',
          docType: 'RWC',
          status: 'UNDER_REVIEW',
          createdAt: new Date('2026-10-02T10:00:00.000Z'),
        },
      ],
    };
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue(row),
      },
    };
    const result = await makeService(prisma).getCase(superAdmin, 'case-1');
    expect(result.documents.map((d) => d.id)).toEqual(['doc-new', 'doc-old']);
    expect(result.documents[0].isNewSinceInfoRequest).toBe(true);
    expect(result.documents[1].isNewSinceInfoRequest).toBe(false);
  });
});
