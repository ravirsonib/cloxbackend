import { BadRequestException } from '@nestjs/common';
import {
  CompanyStatus,
  CompanyType,
  ComplianceCaseStatus,
  ComplianceDocStatus,
  ComplianceDocType,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { CarrierService } from './carrier.service';

const carrierPrincipal: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

const DOC_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

function carrierCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: 'co-c',
    type: CompanyType.CARRIER,
    status: CompanyStatus.DRAFT,
    legalName: 'Carrier Co',
    tradingName: null,
    abn: '51824753556',
    acn: null,
    phone: null,
    homeRegionId: 'reg-vic',
    stripeConnectAccountId: 'acct_1',
    stripeConnectPayoutsEnabled: true,
    capabilities: [],
    serviceRegionCodes: ['VIC'],
    homeRegion: { code: 'VIC' },
    vehicles: [{ status: 'ACTIVE' }],
    drivers: [
      {
        status: 'ACTIVE',
        user: {
          id: 'u',
          email: 'driver.clox@yopmail.com',
          name: 'D',
          phone: null,
        },
      },
    ],
    complianceCases: [],
    complianceDocuments: [],
    ...overrides,
  };
}

describe('CarrierService submitVerification leftover gates', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    isMockMode: () => true,
    createConnectAccount: jest.fn(),
    createAccountLink: jest.fn(),
    retrieveConnectAccount: jest.fn(),
  };
  const config = {
    get: (k: string) =>
      k === 'CORS_ORIGINS' ? 'http://localhost:3000,http://localhost:5174' : undefined,
  };
  const drivers = {
    createInviteToken: jest.fn(),
    sendInviteMail: jest.fn(),
    inviteUrl: jest.fn(),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new CarrierService(
      prisma as never,
      audit as never,
      stripe as never,
      config as never,
      drivers as never,
    );
  }

  function userWith(company: ReturnType<typeof carrierCompany>) {
    return {
      id: 'user-carrier',
      email: 'carrier@yopmail.com',
      name: null,
      phone: null,
      company,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects without ABN', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(userWith(carrierCompany({ abn: null }))),
      },
    };
    await expect(
      makeService(prisma).submitVerification(carrierPrincipal, { documentIds: DOC_IDS }),
    ).rejects.toMatchObject({ message: 'ABN required before submit' });
  });

  it('rejects when fleet not ready', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(
          userWith(carrierCompany({ vehicles: [], drivers: [] })),
        ),
      },
    };
    await expect(
      makeService(prisma).submitVerification(carrierPrincipal, { documentIds: DOC_IDS }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/ACTIVE vehicle/i),
    });
  });

  it('rejects when service regions empty', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(
          userWith(carrierCompany({ serviceRegionCodes: [] })),
        ),
      },
    };
    await expect(
      makeService(prisma).submitVerification(carrierPrincipal, { documentIds: DOC_IDS }),
    ).rejects.toMatchObject({ message: 'Set service regions before submit' });
  });

  it('rejects mismatched document ids', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(userWith(carrierCompany())),
      },
      complianceDocument: { findMany: jest.fn().mockResolvedValue([]) },
    };
    await expect(
      makeService(prisma).submitVerification(carrierPrincipal, { documentIds: DOC_IDS }),
    ).rejects.toMatchObject({
      message: 'All documents must be uploaded for this company',
    });
  });

  it('rejects missing required doc type', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(userWith(carrierCompany())),
      },
      complianceDocument: {
        findMany: jest.fn().mockResolvedValue([
          { id: DOC_IDS[0], docType: ComplianceDocType.PUBLIC_LIABILITY },
          { id: DOC_IDS[1], docType: ComplianceDocType.CARGO_INSURANCE },
          { id: DOC_IDS[2], docType: ComplianceDocType.GOVERNMENT_ID },
        ]),
      },
    };
    await expect(
      makeService(prisma).submitVerification(carrierPrincipal, { documentIds: DOC_IDS }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Missing required doc: RWC/),
    });
  });

  it('rejects when open (non-INFO_REQUESTED) case exists', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(userWith(carrierCompany())),
      },
      complianceDocument: {
        findMany: jest.fn().mockResolvedValue([
          { id: DOC_IDS[0], docType: ComplianceDocType.PUBLIC_LIABILITY },
          { id: DOC_IDS[1], docType: ComplianceDocType.CARGO_INSURANCE },
          { id: DOC_IDS[2], docType: ComplianceDocType.RWC },
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
      makeService(prisma).submitVerification(carrierPrincipal, { documentIds: DOC_IDS }),
    ).rejects.toMatchObject({
      message: 'An open compliance case already exists',
    });
  });

  it('reopens INFO_REQUESTED case instead of creating new', async () => {
    const company = carrierCompany();
    const infoCase = {
      id: 'case-info',
      status: ComplianceCaseStatus.INFO_REQUESTED,
    };
    const tx = {
      complianceCase: {
        update: jest.fn().mockResolvedValue({
          id: 'case-info',
          status: ComplianceCaseStatus.OPEN,
        }),
        create: jest.fn(),
      },
      complianceDocument: { updateMany: jest.fn() },
      company: { update: jest.fn() },
    };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(userWith(company)),
      },
      complianceDocument: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: DOC_IDS[0],
            docType: ComplianceDocType.PUBLIC_LIABILITY,
            status: ComplianceDocStatus.UPLOADED,
          },
          {
            id: DOC_IDS[1],
            docType: ComplianceDocType.CARGO_INSURANCE,
            status: ComplianceDocStatus.UPLOADED,
          },
          {
            id: DOC_IDS[2],
            docType: ComplianceDocType.RWC,
            status: ComplianceDocStatus.UPLOADED,
          },
        ]),
      },
      complianceCase: { findFirst: jest.fn().mockResolvedValue(infoCase) },
      $transaction: jest.fn().mockImplementation(async (fn: (t: unknown) => unknown) =>
        fn(tx),
      ),
    };

    const result = await makeService(prisma).submitVerification(carrierPrincipal, {
      documentIds: DOC_IDS,
    });
    expect(result).toMatchObject({
      company: expect.objectContaining({ id: 'co-c' }),
    });
    expect(tx.complianceCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'case-info' },
        data: expect.objectContaining({ status: ComplianceCaseStatus.OPEN }),
      }),
    );
    expect(tx.complianceCase.create).not.toHaveBeenCalled();
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'case-info' }),
    );
  });
});
