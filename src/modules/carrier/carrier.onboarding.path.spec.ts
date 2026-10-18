import { BadRequestException, NotFoundException } from '@nestjs/common';
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
    stripeConnectAccountId: null,
    stripeConnectPayoutsEnabled: false,
    capabilities: [],
    serviceRegionCodes: ['VIC'],
    homeRegion: { code: 'VIC' },
    vehicles: [{ status: 'ACTIVE' }],
    drivers: [{ status: 'ACTIVE', user: { id: 'u', email: 'driver.clox@yopmail.com', name: 'D', phone: null } }],
    complianceCases: [],
    complianceDocuments: [],
    ...overrides,
  };
}

describe('CarrierService profile / connect / submit leftover paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    isMockMode: () => true,
    createConnectAccount: jest.fn().mockResolvedValue({ id: 'acct_new', mock: true }),
    createAccountLink: jest.fn().mockResolvedValue({
      url: 'https://connect.mock/link',
      mock: true,
    }),
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

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updateProfile rejects unknown region', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          email: 'carrier@yopmail.com',
          name: null,
          phone: null,
          company: carrierCompany(),
        }),
      },
      region: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const service = makeService(prisma);
    await expect(
      service.updateProfile(carrierPrincipal, {
        legalName: 'Carrier Co',
        abn: '51824753556',
        homeRegionCode: 'ZZZ',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updateProfile updates company in draft', async () => {
    const company = carrierCompany();
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          email: 'carrier@yopmail.com',
          name: null,
          phone: null,
          company,
        }),
        update: jest.fn(),
      },
      region: {
        findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }),
      },
      company: { update: jest.fn() },
    };
    const service = makeService(prisma);
    await service.updateProfile(carrierPrincipal, {
      legalName: 'Carrier Co Pty',
      abn: '51824753556',
      homeRegionCode: 'VIC',
    });
    expect(prisma.company.update).toHaveBeenCalledWith({
      where: { id: 'co-c' },
      data: expect.objectContaining({ legalName: 'Carrier Co Pty', abn: '51824753556' }),
    });
  });

  it('createConnectOnboarding requires ABN', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          email: 'carrier@yopmail.com',
          name: null,
          phone: null,
          company: carrierCompany({ abn: null }),
        }),
      },
    };
    const service = makeService(prisma);
    await expect(service.createConnectOnboarding(carrierPrincipal)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('createConnectOnboarding creates account + link', async () => {
    const company = carrierCompany({ stripeConnectAccountId: null });
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          email: 'carrier@yopmail.com',
          name: null,
          phone: null,
          company,
        }),
      },
      company: { update: jest.fn() },
    };
    const service = makeService(prisma);
    const result = await service.createConnectOnboarding(carrierPrincipal);
    expect(result).toMatchObject({
      accountId: 'acct_new',
      url: 'https://connect.mock/link',
      mock: true,
    });
    expect(stripe.createConnectAccount).toHaveBeenCalled();
    expect(prisma.company.update).toHaveBeenCalledWith({
      where: { id: 'co-c' },
      data: { stripeConnectAccountId: 'acct_new' },
    });
  });

  it('updateCapabilities rejects unknown region code', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          email: 'carrier@yopmail.com',
          name: null,
          phone: null,
          company: carrierCompany(),
        }),
      },
      region: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const service = makeService(prisma);
    await expect(
      service.updateCapabilities(carrierPrincipal, {
        capabilities: ['DG'],
        serviceRegionCodes: ['ZZZ'],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('submitVerification rejects without Connect payouts', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          email: 'carrier@yopmail.com',
          name: null,
          phone: null,
          company: carrierCompany({ stripeConnectPayoutsEnabled: false }),
        }),
      },
    };
    const service = makeService(prisma);
    await expect(
      service.submitVerification(carrierPrincipal, {
        documentIds: ['11111111-1111-4111-8111-111111111111'],
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/Connect/i) });
  });

  it('submitVerification creates case when gates pass', async () => {
    const docIds = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];
    const company = carrierCompany({
      stripeConnectPayoutsEnabled: true,
      stripeConnectAccountId: 'acct_1',
    });
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          email: 'carrier@yopmail.com',
          name: null,
          phone: null,
          company,
        }),
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
            create: jest.fn().mockResolvedValue({
              id: 'case-c',
              status: ComplianceCaseStatus.OPEN,
            }),
          },
          complianceDocument: { updateMany: jest.fn() },
          company: { update: jest.fn() },
        };
        return fn(tx);
      }),
    };
    const service = makeService(prisma);
    const result = await service.submitVerification(carrierPrincipal, {
      documentIds: docIds,
    });
    expect(result).toMatchObject({
      step: 'documents',
      company: expect.objectContaining({
        id: 'co-c',
        stripeConnectPayoutsEnabled: true,
      }),
      goNoGo: expect.objectContaining({
        connectReady: true,
        fleetReady: true,
      }),
    });
    expect(audit.recordPlatform).toHaveBeenCalled();
  });
});
