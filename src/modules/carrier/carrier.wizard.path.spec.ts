import { CompanyStatus, CompanyType, ComplianceDocType } from '@prisma/client';
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

const REQUIRED_DOCS = [
  { docType: ComplianceDocType.PUBLIC_LIABILITY },
  { docType: ComplianceDocType.CARGO_INSURANCE },
  { docType: ComplianceDocType.RWC },
];

function company(overrides: Record<string, unknown> = {}) {
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
    vehicles: [{ status: 'ACTIVE', id: 'veh-1', label: 'V1', registration: 'ABC' }],
    drivers: [
      {
        status: 'ACTIVE',
        id: 'drv-1',
        licenceNo: null,
        user: {
          id: 'u-d',
          email: 'driver.clox@yopmail.com',
          name: 'D',
          phone: null,
        },
      },
    ],
    complianceCases: [],
    complianceDocuments: REQUIRED_DOCS,
    ...overrides,
  };
}

describe('CarrierService getOnboarding wizardStep leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = { isMockMode: () => true };
  const config = { get: () => undefined };
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

  function prismaFor(co: ReturnType<typeof company>) {
    return {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          email: 'carrier@yopmail.com',
          name: null,
          phone: null,
          company: co,
        }),
      },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['rejected', company({ status: CompanyStatus.REJECTED }), 'rejected'],
    ['suspended', company({ status: CompanyStatus.SUSPENDED }), 'suspended'],
    ['complete', company({ status: CompanyStatus.BID_ELIGIBLE }), 'complete'],
    [
      'waiting_ops PENDING_REVIEW',
      company({ status: CompanyStatus.PENDING_REVIEW }),
      'waiting_ops',
    ],
    [
      'waiting_ops PENDING_VERIFICATION',
      company({ status: CompanyStatus.PENDING_VERIFICATION }),
      'waiting_ops',
    ],
    [
      'documents INFO_REQUESTED',
      company({ status: CompanyStatus.INFO_REQUESTED }),
      'documents',
    ],
    ['profile missing ABN', company({ abn: null }), 'profile'],
    [
      'documents missing RWC',
      company({
        complianceDocuments: [
          { docType: ComplianceDocType.PUBLIC_LIABILITY },
          { docType: ComplianceDocType.CARGO_INSURANCE },
        ],
      }),
      'documents',
    ],
    [
      'connect payouts off',
      company({ stripeConnectPayoutsEnabled: false }),
      'connect',
    ],
    ['vehicles empty', company({ vehicles: [] }), 'vehicles'],
    ['drivers empty', company({ drivers: [] }), 'drivers'],
    [
      'capabilities empty regions',
      company({ serviceRegionCodes: [] }),
      'capabilities',
    ],
    ['submit ready', company(), 'submit'],
  ] as const)('%s', async (_label, co, step) => {
    const result = await makeService(prismaFor(co)).getOnboarding(carrierPrincipal);
    expect(result.step).toBe(step);
  });
});
