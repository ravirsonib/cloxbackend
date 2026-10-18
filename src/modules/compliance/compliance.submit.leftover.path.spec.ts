import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import {
  CompanyStatus,
  CompanyType,
  ComplianceCaseStatus,
  ComplianceCaseType,
  ComplianceDocStatus,
  ComplianceDocType,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AbrService } from './abr.service';
import { ComplianceService } from './compliance.service';

const senderPrincipal: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

const carrierPrincipal: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('ComplianceService submit leftover validation paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const scope = {
    assertAdmin: jest.fn(),
    assertRegionAccess: jest.fn(),
    allowedTerritoryCodes: jest.fn().mockReturnValue(null),
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
  });

  it('rejects non-carrier for CARRIER_KYB', async () => {
    const service = makeService({ isConnected: () => true });
    await expect(
      service.submit(senderPrincipal, {
        companyId: 'co-s',
        caseType: ComplianceCaseType.CARRIER_KYB,
        documentIds: ['11111111-1111-4111-8111-111111111111'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects non-sender for SENDER_KYC', async () => {
    const service = makeService({ isConnected: () => true });
    await expect(
      service.submit(carrierPrincipal, {
        companyId: 'co-c',
        caseType: ComplianceCaseType.SENDER_KYC,
        documentIds: ['11111111-1111-4111-8111-111111111111'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects sender company submitting CARRIER_KYB', async () => {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-s',
          type: CompanyType.SENDER,
          abn: null,
          homeRegionId: 'reg-vic',
          homeRegion: { code: 'VIC' },
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          companyId: 'co-s',
        }),
      },
    };
    // Role gate fires first for CARRIER_KYB from sender role — use admin-like bypass
    // by setting role TRANSPORT_COMPANY while company is SENDER.
    await expect(
      makeService(prisma).submit(
        { ...senderPrincipal, role: 'TRANSPORT_COMPANY' },
        {
          companyId: 'co-s',
          caseType: ComplianceCaseType.CARRIER_KYB,
          documentIds: ['11111111-1111-4111-8111-111111111111'],
        },
      ),
    ).rejects.toMatchObject({
      message: 'Sender company cannot submit CARRIER_KYB',
    });
  });

  it('rejects carrier ABN missing before KYB submit', async () => {
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
          abn: null,
          homeRegionId: 'reg-vic',
          homeRegion: { code: 'VIC' },
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          companyId: 'co-c',
        }),
      },
      complianceDocument: {
        findMany: jest.fn().mockResolvedValue([
          { id: docIds[0], docType: ComplianceDocType.PUBLIC_LIABILITY },
          { id: docIds[1], docType: ComplianceDocType.CARGO_INSURANCE },
          { id: docIds[2], docType: ComplianceDocType.RWC },
        ]),
      },
    };
    await expect(
      makeService(prisma).submit(carrierPrincipal, {
        companyId: 'co-c',
        caseType: ComplianceCaseType.CARRIER_KYB,
        documentIds: docIds,
      }),
    ).rejects.toMatchObject({ message: 'Carrier ABN required before submit' });
  });

  it('rejects SENDER_KYC without GOVERNMENT_ID', async () => {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-s',
          type: CompanyType.SENDER,
          abn: '51824753556',
          homeRegionId: 'reg-vic',
          homeRegion: { code: 'VIC' },
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          companyId: 'co-s',
        }),
      },
      complianceDocument: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: '11111111-1111-4111-8111-111111111111',
            docType: ComplianceDocType.ABN_EXTRACT,
            status: ComplianceDocStatus.UPLOADED,
          },
        ]),
      },
    };
    await expect(
      makeService(prisma).submit(senderPrincipal, {
        companyId: 'co-s',
        caseType: ComplianceCaseType.SENDER_KYC,
        documentIds: ['11111111-1111-4111-8111-111111111111'],
      }),
    ).rejects.toMatchObject({
      message: 'Sender individual requires GOVERNMENT_ID',
    });
  });

  it('rejects SENDER_KYB when neither ABN extract nor company ABN', async () => {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-s',
          type: CompanyType.SENDER,
          abn: null,
          homeRegionId: 'reg-vic',
          homeRegion: { code: 'VIC' },
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          companyId: 'co-s',
        }),
      },
      complianceDocument: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: '11111111-1111-4111-8111-111111111111',
            docType: ComplianceDocType.GOVERNMENT_ID,
            status: ComplianceDocStatus.UPLOADED,
          },
        ]),
      },
    };
    await expect(
      makeService(prisma).submit(senderPrincipal, {
        companyId: 'co-s',
        caseType: ComplianceCaseType.SENDER_KYB,
        documentIds: ['11111111-1111-4111-8111-111111111111'],
      }),
    ).rejects.toMatchObject({
      message: 'Sender business requires ABN extract or company ABN',
    });
  });

  it('rejects when company already has open compliance case', async () => {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-s',
          type: CompanyType.SENDER,
          abn: '51824753556',
          homeRegionId: 'reg-vic',
          homeRegion: { code: 'VIC' },
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          companyId: 'co-s',
        }),
      },
      complianceDocument: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: '11111111-1111-4111-8111-111111111111',
            docType: ComplianceDocType.GOVERNMENT_ID,
            status: ComplianceDocStatus.UPLOADED,
          },
        ]),
      },
      complianceCase: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'case-open',
          status: ComplianceCaseStatus.OPEN,
        }),
      },
    };
    await expect(
      makeService(prisma).submit(senderPrincipal, {
        companyId: 'co-s',
        caseType: ComplianceCaseType.SENDER_KYC,
        documentIds: ['11111111-1111-4111-8111-111111111111'],
      }),
    ).rejects.toMatchObject({
      message: 'Company already has an open compliance case',
    });
  });

  it('creates OPEN SENDER_KYC case when GOVERNMENT_ID present', async () => {
    const docId = '11111111-1111-4111-8111-111111111111';
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-s',
          type: CompanyType.SENDER,
          abn: '51824753556',
          homeRegionId: 'reg-vic',
          homeRegion: { code: 'VIC' },
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          companyId: 'co-s',
        }),
      },
      complianceDocument: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: docId,
            docType: ComplianceDocType.GOVERNMENT_ID,
            status: ComplianceDocStatus.UPLOADED,
          },
        ]),
      },
      complianceCase: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          complianceCase: {
            create: jest.fn().mockResolvedValue({
              id: 'case-kyc',
              status: ComplianceCaseStatus.OPEN,
              caseType: ComplianceCaseType.SENDER_KYC,
            }),
          },
          complianceDocument: { updateMany: jest.fn() },
          company: { update: jest.fn() },
        };
        return fn(tx);
      }),
    };

    const result = await makeService(prisma).submit(senderPrincipal, {
      companyId: 'co-s',
      caseType: ComplianceCaseType.SENDER_KYC,
      documentIds: [docId],
    });
    expect(result).toEqual({
      id: 'case-kyc',
      status: ComplianceCaseStatus.OPEN,
      caseType: ComplianceCaseType.SENDER_KYC,
      companyStatus: CompanyStatus.PENDING_REVIEW,
    });
    expect(audit.recordPlatform).toHaveBeenCalled();
  });

  it('rejects mismatched / non-UPLOADED document ids', async () => {
    const prisma = {
      isConnected: () => true,
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-s',
          type: CompanyType.SENDER,
          abn: '51824753556',
          homeRegionId: 'reg-vic',
          homeRegion: { code: 'VIC' },
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          companyId: 'co-s',
        }),
      },
      complianceDocument: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    await expect(
      makeService(prisma).submit(senderPrincipal, {
        companyId: 'co-s',
        caseType: ComplianceCaseType.SENDER_KYC,
        documentIds: ['11111111-1111-4111-8111-111111111111'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
