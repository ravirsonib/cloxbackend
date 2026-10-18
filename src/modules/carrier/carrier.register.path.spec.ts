import { BadRequestException, ConflictException } from '@nestjs/common';
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
    stripeConnectAccountId: 'acct_mock_1',
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

describe('CarrierService register / connect / vehicle paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    isMockMode: () => true,
    retrieveConnectAccount: jest.fn(),
    createConnectAccount: jest.fn(),
    createAccountLink: jest.fn(),
  };
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

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('register rejects duplicate email', async () => {
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1' }) },
    };
    const service = makeService(prisma);
    await expect(
      service.register({
        email: 'carrier.clox@yopmail.com',
        name: 'Carrier',
        phone: '+61400000000',
        acceptedTerms: true,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('register creates company + user', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'user-new',
          email: 'carrier.clox@yopmail.com',
        }),
      },
      region: {
        findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }),
      },
      company: {
        create: jest.fn().mockResolvedValue({ id: 'co-new' }),
      },
    };
    const service = makeService(prisma);
    const result = await service.register({
      email: 'carrier.clox@yopmail.com',
      name: 'Carrier',
      phone: '+61400000000',
      acceptedTerms: true,
    });
    expect(result).toMatchObject({
      ok: true,
      userId: 'user-new',
      companyId: 'co-new',
      email: 'carrier.clox@yopmail.com',
    });
    expect(audit.recordPlatform).toHaveBeenCalled();
  });

  it('confirmConnect rejects without connect account', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          email: 'carrier@yopmail.com',
          name: null,
          phone: null,
          company: carrierCompany({ stripeConnectAccountId: null }),
        }),
      },
    };
    const service = makeService(prisma);
    await expect(service.confirmConnect(carrierPrincipal)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('confirmConnect enables payouts when Stripe says ready', async () => {
    stripe.retrieveConnectAccount.mockResolvedValue({
      id: 'acct_mock_1',
      payoutsEnabled: true,
      chargesEnabled: true,
      mock: true,
    });
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
      },
      company: {
        update: jest.fn().mockImplementation(async ({ data }) => {
          Object.assign(company, data);
          return company;
        }),
      },
    };
    const service = makeService(prisma);
    const result = await service.confirmConnect(carrierPrincipal);
    expect(prisma.company.update).toHaveBeenCalledWith({
      where: { id: 'co-c' },
      data: { stripeConnectPayoutsEnabled: true },
    });
    expect(result.goNoGo.connectReady).toBe(true);
  });

  it('addVehicle rejects when company not draft/info-requested', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          email: 'carrier@yopmail.com',
          name: null,
          phone: null,
          company: carrierCompany({ status: CompanyStatus.BID_ELIGIBLE }),
        }),
      },
    };
    const service = makeService(prisma);
    await expect(
      service.addVehicle(carrierPrincipal, {
        label: 'Truck 1',
        registration: 'abc123',
        vehicleClass: 'SEMI',
        tareKg: 5000,
        gvmKg: 15000,
        gcmKg: 20000,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('addVehicle creates ACTIVE vehicle in draft', async () => {
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
      },
      vehicle: {
        create: jest.fn().mockResolvedValue({
          id: 'veh-1',
          status: 'ACTIVE',
        }),
      },
    };
    const service = makeService(prisma);
    await service.addVehicle(carrierPrincipal, {
      label: 'Truck 1',
      registration: 'abc123',
      vehicleClass: 'SEMI',
      tareKg: 5000,
      gvmKg: 15000,
      gcmKg: 20000,
    });
    expect(prisma.vehicle.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: 'co-c',
        status: 'ACTIVE',
        registration: 'ABC123',
        vehicleClass: 'SEMI',
      }),
    });
  });
});
