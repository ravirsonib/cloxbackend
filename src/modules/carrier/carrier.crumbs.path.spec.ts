import { CompanyStatus, CompanyType, DriverStatus } from '@prisma/client';
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

describe('CarrierService crumb branch leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createConnectAccount: jest.fn().mockResolvedValue({ id: 'acct_new', mock: true }),
    createAccountLink: jest.fn().mockResolvedValue({ url: 'https://connect/link', mock: true }),
    isMockMode: jest.fn().mockReturnValue(true),
  };
  const drivers = {
    createInviteToken: jest.fn().mockReturnValue({
      raw: 'raw-token',
      hash: 'hash-token',
      expiresAt: new Date('2099-01-01'),
    }),
    sendInviteMail: jest.fn().mockResolvedValue({ skipped: false }),
    inviteUrl: jest.fn((t: string) => `https://app/invite/${t}`),
  };

  function makeService(
    prisma: Record<string, unknown>,
    cors = 'http://localhost:3000,http://localhost:5174',
  ) {
    return new CarrierService(
      prisma as never,
      audit as never,
      stripe as never,
      {
        get: (k: string) => (k === 'CORS_ORIGINS' ? cors : undefined),
      } as never,
      drivers as never,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('register without VIC region uses empty serviceRegionCodes', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'user-new',
          email: 'carrier2@yopmail.com',
        }),
      },
      region: { findUnique: jest.fn().mockResolvedValue(null) },
      company: {
        create: jest.fn().mockResolvedValue({ id: 'co-new' }),
      },
    };
    await makeService(prisma).register({
      email: 'carrier2@yopmail.com',
      name: 'Carrier Two',
      phone: '+61400000001',
      acceptedTerms: true,
    });
    expect(prisma.company.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          homeRegionId: undefined,
          serviceRegionCodes: [],
        }),
      }),
    );
  });

  it('getOnboarding maps latestCase; connect uses CORS second origin', async () => {
    const company = {
      id: 'co-c',
      type: CompanyType.CARRIER,
      status: CompanyStatus.DRAFT,
      legalName: 'Carrier Co',
      tradingName: null,
      abn: '51824753556',
      acn: null,
      phone: null,
      stripeConnectAccountId: null as string | null,
      stripeConnectPayoutsEnabled: false,
      capabilities: [],
      serviceRegionCodes: ['VIC'],
      homeRegion: { code: 'VIC' },
      vehicles: [],
      drivers: [],
      complianceDocuments: [],
      complianceCases: [
        {
          id: 'case-1',
          status: 'OPEN',
          caseType: 'CARRIER_KYB',
          decisionNote: 'need RWC',
        },
      ],
    };
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
      company: { update: jest.fn().mockResolvedValue({}) },
    };
    const onboarding = await makeService(prisma).getOnboarding(carrierPrincipal);
    expect(onboarding.latestCase).toMatchObject({
      id: 'case-1',
      decisionNote: 'need RWC',
    });

    await makeService(prisma).createConnectOnboarding(carrierPrincipal);
    expect(stripe.createAccountLink).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshUrl: 'http://localhost:5174/carrier/onboarding',
        returnUrl: 'http://localhost:5174/carrier/onboarding?connect=return',
      }),
    );

    // Falsy / single CORS → localhost:5174 fallback
    stripe.createAccountLink.mockClear();
    company.stripeConnectAccountId = 'acct_existing';
    await makeService(prisma, '').createConnectOnboarding(carrierPrincipal);
    expect(stripe.createAccountLink).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshUrl: 'http://localhost:5174/carrier/onboarding',
      }),
    );
  });

  it('invite/resend without skipped mail omits debugToken; name falls back to email', async () => {
    const company = {
      id: 'co-c',
      type: CompanyType.CARRIER,
      status: CompanyStatus.DRAFT,
      legalName: 'Carrier Co',
      tradingName: null,
      abn: '51824753556',
      acn: null,
      phone: null,
      stripeConnectAccountId: null,
      stripeConnectPayoutsEnabled: false,
      capabilities: [],
      serviceRegionCodes: ['VIC'],
      homeRegion: { code: 'VIC' },
      vehicles: [],
      drivers: [],
      complianceCases: [],
      complianceDocuments: [],
    };
    const findUnique = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'user-carrier',
        email: 'carrier@yopmail.com',
        company,
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        id: 'user-carrier',
        email: 'carrier@yopmail.com',
        name: null,
        phone: null,
        company,
      });
    const prisma = {
      isConnected: () => true,
      user: { findUnique },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          user: {
            create: jest.fn().mockResolvedValue({
              id: 'user-drv',
              email: 'driver2@yopmail.com',
            }),
          },
          driver: {
            create: jest.fn().mockResolvedValue({
              id: 'drv-2',
              status: DriverStatus.INVITED,
            }),
          },
        };
        return fn(tx);
      }),
      driver: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'drv-2',
          inviteAcceptedAt: null,
          status: DriverStatus.INVITED,
          user: { email: 'driver2@yopmail.com', name: null },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const invited = await makeService(prisma).inviteDriver(carrierPrincipal, {
      email: 'driver2@yopmail.com',
      name: 'Driver Two',
      phone: '+61400000002',
      licenceNo: 'LIC2',
    });
    expect(invited.invite.mailSkipped).toBe(false);
    expect(invited.invite.debugToken).toBeUndefined();

    const resent = await makeService(prisma).resendDriverInvite(carrierPrincipal, {
      driverId: 'drv-2',
    });
    expect(drivers.sendInviteMail).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'driver2@yopmail.com',
      }),
    );
    expect(resent.debugToken).toBeUndefined();
    expect(resent.mailSkipped).toBe(false);
  });
});
