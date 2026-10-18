import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  CompanyStatus,
  CompanyType,
  DriverStatus,
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
    stripeConnectAccountId: null,
    stripeConnectPayoutsEnabled: false,
    capabilities: [],
    serviceRegionCodes: ['VIC'],
    homeRegion: { code: 'VIC' },
    vehicles: [],
    drivers: [],
    complianceCases: [],
    complianceDocuments: [],
    ...overrides,
  };
}

describe('CarrierService invite + eligibility paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = { isMockMode: () => true };
  const config = { get: () => undefined };
  const drivers = {
    createInviteToken: jest.fn().mockReturnValue({
      raw: 'raw-token',
      hash: 'hash-token',
      expiresAt: new Date('2026-12-01T00:00:00Z'),
    }),
    sendInviteMail: jest.fn().mockResolvedValue({ skipped: true }),
    inviteUrl: jest.fn().mockReturnValue('https://app/invite/raw-token'),
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

  it('inviteDriver rejects suspended company', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: carrierCompany({ status: CompanyStatus.SUSPENDED }),
        }),
      },
    };
    const service = makeService(prisma);
    await expect(
      service.inviteDriver(carrierPrincipal, {
        email: 'driver.clox@yopmail.com',
        name: 'Driver',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('inviteDriver rejects duplicate email', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'user-carrier',
            company: carrierCompany(),
          })
          .mockResolvedValueOnce({ id: 'existing' }),
      },
    };
    const service = makeService(prisma);
    await expect(
      service.inviteDriver(carrierPrincipal, {
        email: 'driver.clox@yopmail.com',
        name: 'Driver',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('inviteDriver creates driver+user and returns debugToken when mail skipped', async () => {
    const company = carrierCompany();
    const findUnique = jest
      .fn()
      .mockResolvedValueOnce({ id: 'user-carrier', email: 'carrier@yopmail.com', company })
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'user-carrier', email: 'carrier@yopmail.com', name: null, phone: null, company });
    const prisma = {
      isConnected: () => true,
      user: { findUnique },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          user: {
            create: jest.fn().mockResolvedValue({
              id: 'user-drv',
              email: 'driver.clox@yopmail.com',
            }),
          },
          driver: {
            create: jest.fn().mockResolvedValue({
              id: 'drv-1',
              status: DriverStatus.INVITED,
            }),
          },
        };
        return fn(tx);
      }),
    };

    const service = makeService(prisma);
    const result = await service.inviteDriver(carrierPrincipal, {
      email: 'driver.clox@yopmail.com',
      name: 'Driver',
      phone: '+61400000000',
      licenceNo: 'LIC1',
    });

    expect(result.invite).toMatchObject({
      driverId: 'drv-1',
      email: 'driver.clox@yopmail.com',
      inviteUrl: 'https://app/invite/raw-token',
      mailSkipped: true,
      debugToken: 'raw-token',
    });
    expect(drivers.sendInviteMail).toHaveBeenCalled();
    expect(audit.recordPlatform).toHaveBeenCalled();
  });

  it('resendDriverInvite rejects accepted invite', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: carrierCompany(),
        }),
      },
      driver: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'drv-1',
          inviteAcceptedAt: new Date(),
          status: DriverStatus.ACTIVE,
          user: { email: 'driver.clox@yopmail.com', name: 'D' },
        }),
      },
    };
    const service = makeService(prisma);
    await expect(
      service.resendDriverInvite(carrierPrincipal, { driverId: 'drv-1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('getBidEligibility canBid true when all gates pass', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          email: 'carrier@yopmail.com',
          role: 'TRANSPORT_COMPANY',
          company: carrierCompany({
            status: CompanyStatus.BID_ELIGIBLE,
            stripeConnectPayoutsEnabled: true,
            abn: '51824753556',
            serviceRegionCodes: ['VIC'],
            vehicles: [{ status: 'ACTIVE' }],
            drivers: [{ status: 'ACTIVE' }],
          }),
        }),
      },
    };
    const service = makeService(prisma);
    const result = await service.getBidEligibility(carrierPrincipal);
    expect(result.canBid).toBe(true);
    expect(result.goNoGo).toMatchObject({
      opsApproved: true,
      connectReady: true,
      fleetReady: true,
      profileComplete: true,
      capabilitiesSet: true,
    });
  });

  it('rejects non-carrier principal', async () => {
    const service = makeService({ isConnected: () => true });
    await expect(
      service.getOnboarding({
        ...carrierPrincipal,
        role: 'SENDER',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
