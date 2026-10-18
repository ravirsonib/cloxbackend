import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CompanyType, ComplianceCaseType } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { ComplianceService } from './compliance.service';

const sender: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

const localBde: AuthenticatedPrincipal = {
  id: 'admin-bde',
  email: 'bde@yopmail.com',
  role: 'LOCAL_BDE',
  kind: 'admin',
  regionCodes: ['VIC'],
  territoryCodes: ['MEL'],
};

const stateMaster: AuthenticatedPrincipal = {
  id: 'admin-state',
  email: 'state@yopmail.com',
  role: 'STATE_MASTER',
  kind: 'admin',
  regionCodes: ['VIC'],
  territoryCodes: [],
};

describe('ComplianceService member/decide leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const abr = { lookupAbn: jest.fn() };

  function makeService(
    prisma: Record<string, unknown>,
    scopeOverrides?: Partial<{
      assertRegionAccess: jest.Mock;
      assertTerritoryAccess: jest.Mock;
      assertAdmin: jest.Mock;
      allowedTerritoryCodes: jest.Mock;
    }>,
  ) {
    const scope = {
      assertRegionAccess: jest.fn(),
      assertTerritoryAccess: jest.fn(),
      assertAdmin: jest.fn(),
      allowedTerritoryCodes: jest.fn().mockReturnValue(['MEL']),
      ...scopeOverrides,
    };
    return new ComplianceService(
      prisma as never,
      audit as never,
      scope as never,
      abr as never,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('ensureDatabase throws when offline', async () => {
    const service = makeService({ isConnected: () => false });
    await expect(
      service.listCases(stateMaster, { page: 1, pageSize: 20 }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('assertCompanyMember 404 / no-region Super-only / non-member', async () => {
    const prismaMissing = {
      isConnected: () => true,
      company: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prismaMissing).submit(sender, {
        companyId: 'co-x',
        caseType: ComplianceCaseType.SENDER_KYB,
        documentIds: ['d1'],
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    const prismaNoRegion = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          type: CompanyType.SENDER,
          homeRegion: null,
          homeRegionId: null,
        }),
      },
      job: { findFirst: jest.fn() },
    };
    await expect(
      makeService(prismaNoRegion).submit(localBde, {
        companyId: 'co-1',
        caseType: ComplianceCaseType.SENDER_KYB,
        documentIds: ['d1'],
      } as never),
    ).rejects.toThrow('Company has no region — Super only');

    const prismaMember = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          type: CompanyType.SENDER,
          homeRegion: { code: 'VIC' },
          homeRegionId: 'reg-1',
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'other' }),
      },
    };
    await expect(
      makeService(prismaMember).submit(sender, {
        companyId: 'co-1',
        caseType: ComplianceCaseType.SENDER_KYB,
        documentIds: ['d1'],
      } as never),
    ).rejects.toThrow('Not a member of this company');
  });

  it('assertAdminTerritoryForCompany blocks LOCAL_BDE without home region', async () => {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-1',
          type: CompanyType.SENDER,
          homeRegion: { code: 'VIC' },
          homeRegionId: null,
        }),
      },
      job: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).submit(localBde, {
        companyId: 'co-1',
        caseType: ComplianceCaseType.SENDER_KYB,
        documentIds: ['d1'],
      } as never),
    ).rejects.toThrow('Company has no territory assignment — Super/State only');
  });

  it('assertCanDecide rejects LOCAL_BDE on approve', async () => {
    const prisma = {
      isConnected: () => true,
      complianceCase: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'case-1',
          status: 'SUBMITTED',
          company: { homeRegion: { code: 'VIC' }, homeRegionId: 'reg-1' },
        }),
      },
    };
    const service = makeService(prisma);
    await expect(
      service.approve(localBde, 'case-1', { note: 'x' } as never),
    ).rejects.toThrow('Local BDE may view/escalate only');
  });

  it('submit rejects carrier company with non-CARRIER_KYB case', async () => {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-c',
          type: CompanyType.CARRIER,
          homeRegion: { code: 'VIC' },
          homeRegionId: 'reg-1',
        }),
      },
      job: { findFirst: jest.fn().mockResolvedValue(null) },
      localTerritory: {
        findFirst: jest.fn().mockResolvedValue({ id: 't-mel', code: 'MEL' }),
      },
    };
    await expect(
      makeService(prisma).submit(stateMaster, {
        companyId: 'co-c',
        caseType: ComplianceCaseType.SENDER_KYB,
        documentIds: ['d1'],
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
