import { BadRequestException } from '@nestjs/common';
import { CompanyStatus, CompanyType } from '@prisma/client';
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

describe('CarrierService connect leftover paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    createConnectAccount: jest.fn(),
    createAccountLink: jest.fn(),
    retrieveConnectAccount: jest.fn(),
    isMockMode: jest.fn().mockReturnValue(true),
  };
  const drivers = {
    createInviteToken: jest.fn().mockReturnValue({
      raw: 'raw-token',
      hash: 'hash-token',
      expiresAt: new Date('2099-01-01'),
    }),
    sendInviteMail: jest.fn().mockResolvedValue({ skipped: true }),
    inviteUrl: jest.fn((t: string) => `https://app/driver/invite/${t}`),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new CarrierService(
      prisma as never,
      audit as never,
      stripe as never,
      { get: () => 'http://localhost:3000,http://localhost:5174' } as never,
      drivers as never,
    );
  }

  function carrierUser(overrides: Record<string, unknown> = {}) {
    return {
      id: 'user-carrier',
      email: 'carrier@yopmail.com',
      companyId: 'co-c',
      company: {
        id: 'co-c',
        type: CompanyType.CARRIER,
        status: CompanyStatus.DRAFT,
        legalName: 'Haul Co',
        abn: '51824753556',
        stripeConnectAccountId: 'acct_1',
        stripeConnectPayoutsEnabled: false,
        complianceCases: [] as unknown[],
        ...overrides,
      },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('confirmConnect rejects when payouts not enabled yet', async () => {
    stripe.retrieveConnectAccount.mockResolvedValue({
      id: 'acct_1',
      payoutsEnabled: false,
      mock: true,
    });
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue(carrierUser()) },
    };
    await expect(
      makeService(prisma).confirmConnect(carrierPrincipal),
    ).rejects.toMatchObject({
      message: 'Connect account payouts not enabled yet',
    });
  });

  it('createConnectOnboarding reuses existing Connect account id', async () => {
    stripe.createAccountLink.mockResolvedValue({
      url: 'https://connect.stripe.test/link',
      mock: true,
    });
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue(carrierUser()) },
      company: { update: jest.fn() },
    };

    const result = await makeService(prisma).createConnectOnboarding(carrierPrincipal);
    expect(stripe.createConnectAccount).not.toHaveBeenCalled();
    expect(stripe.createAccountLink).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct_1' }),
    );
    expect(result).toMatchObject({
      accountId: 'acct_1',
      url: 'https://connect.stripe.test/link',
      mock: true,
    });
    expect(prisma.company.update).not.toHaveBeenCalled();
  });

  it('createConnectOnboarding accepts custom refresh/return urls', async () => {
    stripe.createAccountLink.mockResolvedValue({
      url: 'https://connect.stripe.test/custom',
      mock: true,
    });
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue(carrierUser()) },
    };

    await makeService(prisma).createConnectOnboarding(carrierPrincipal, {
      refreshUrl: 'https://app.example/refresh',
      returnUrl: 'https://app.example/return',
    });
    expect(stripe.createAccountLink).toHaveBeenCalledWith({
      accountId: 'acct_1',
      refreshUrl: 'https://app.example/refresh',
      returnUrl: 'https://app.example/return',
    });
  });

  it('confirmConnect without account id is BadRequest', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(
          carrierUser({ stripeConnectAccountId: null }),
        ),
      },
    };
    await expect(
      makeService(prisma).confirmConnect(carrierPrincipal),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
