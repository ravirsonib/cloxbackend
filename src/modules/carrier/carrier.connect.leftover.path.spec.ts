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
    createConnectManageLink: jest.fn(),
    getConnectPayoutSummary: jest.fn(),
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
      {
        get: (k: string) => (k === 'ADMIN_APP_URL' ? 'http://localhost:5174' : undefined),
      } as never,
      drivers as never,
      { sendRegistrationConfirmation: jest.fn().mockResolvedValue({ skipped: true }) } as never,
      { resolveInviteForRegister: jest.fn().mockResolvedValue({ referredByAdminUserId: null, inviteId: null, prospectId: null, homeRegionId: null }), markInviteAccepted: jest.fn() } as never,
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

  it('getConnectStatus returns masked bank summary and syncs payoutsEnabled drift', async () => {
    stripe.getConnectPayoutSummary.mockResolvedValue({
      id: 'acct_1',
      payoutsEnabled: false,
      chargesEnabled: true,
      requirementsDue: true,
      bankAccount: {
        bankName: 'Commonwealth Bank',
        last4: '4321',
        routingNumber: '062-000',
        currency: 'aud',
      },
      mock: false,
    });
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(
          carrierUser({
            stripeConnectAccountId: 'acct_1',
            stripeConnectPayoutsEnabled: true,
          }),
        ),
      },
      company: { update: jest.fn().mockResolvedValue({}) },
    };

    const res = await makeService(prisma).getConnectStatus(carrierPrincipal);
    expect(res).toMatchObject({
      connected: true,
      accountId: 'acct_1',
      payoutsEnabled: false,
      requirementsDue: true,
      bankAccount: {
        bankName: 'Commonwealth Bank',
        last4: '4321',
        routingNumber: '062-000',
        currency: 'aud',
      },
    });
    expect(prisma.company.update).toHaveBeenCalledWith({
      where: { id: 'co-c' },
      data: { stripeConnectPayoutsEnabled: false },
    });
  });

  it('createConnectManageLink returns Express dashboard link, audits, and sanitizes returnPath', async () => {
    stripe.createConnectManageLink.mockResolvedValue({
      url: 'https://connect.stripe.com/express/login_123',
      kind: 'dashboard',
      mock: false,
    });
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(
          carrierUser({
            stripeConnectAccountId: 'acct_1',
            stripeConnectPayoutsEnabled: true,
          }),
        ),
      },
    };

    const res = await makeService(prisma).createConnectManageLink(carrierPrincipal, {
      returnPath: 'https://evil.example/phish',
    });

    expect(stripe.createConnectManageLink).toHaveBeenCalledWith({
      accountId: 'acct_1',
      payoutsEnabled: true,
      refreshUrl: 'http://localhost:5174/account?connect=return',
      returnUrl: 'http://localhost:5174/account?connect=return',
    });
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'carrier.connect_manage_opened',
        entityId: 'co-c',
      }),
    );
    expect(res).toEqual({
      accountId: 'acct_1',
      url: 'https://connect.stripe.com/express/login_123',
      kind: 'dashboard',
      mock: false,
    });
  });

  it('createConnectManageLink falls back to onboarding when company has no Connect account yet', async () => {
    stripe.createConnectAccount.mockResolvedValue({ id: 'acct_fresh', mock: true });
    stripe.createAccountLink.mockResolvedValue({
      url: 'https://connect.stripe.test/onboard',
      mock: true,
    });
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(
          carrierUser({
            stripeConnectAccountId: null,
            stripeConnectPayoutsEnabled: false,
          }),
        ),
      },
      company: { update: jest.fn().mockResolvedValue({}) },
    };

    const res = await makeService(prisma).createConnectManageLink(carrierPrincipal, {
      returnPath: '/carrier/earnings',
    });
    expect(res).toEqual({
      accountId: 'acct_fresh',
      url: 'https://connect.stripe.test/onboard',
      kind: 'account_onboarding',
      mock: true,
    });
  });
});
