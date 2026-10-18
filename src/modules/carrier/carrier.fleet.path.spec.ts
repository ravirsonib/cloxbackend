import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { CompanyStatus, DriverStatus, VehicleStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { CarrierService } from './carrier.service';

const carrier: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('CarrierService resend / vehicle / capabilities leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = {
    isMockMode: jest.fn().mockReturnValue(true),
    createConnectAccount: jest.fn(),
    createAccountLink: jest.fn(),
    retrieveConnectAccount: jest.fn(),
  };
  const config = { get: () => undefined };
  const drivers = {
    createInviteToken: jest.fn().mockReturnValue({
      raw: 'raw-token',
      hash: 'hash-token',
      expiresAt: new Date('2099-01-01'),
    }),
    sendInviteMail: jest.fn().mockResolvedValue({ skipped: true }),
    inviteUrl: jest.fn((t: string) => `https://app/driver/invite/${t}`),
  };

  function carrierCompany(overrides: Record<string, unknown> = {}) {
    return {
      id: 'co-c',
      type: 'CARRIER',
      status: CompanyStatus.DRAFT,
      legalName: 'Carrier Co',
      tradingName: null,
      abn: null,
      acn: null,
      phone: null,
      stripeConnectAccountId: null,
      stripeConnectPayoutsEnabled: false,
      serviceRegionCodes: [] as string[],
      capabilities: [] as string[],
      vehicles: [] as unknown[],
      drivers: [] as unknown[],
      complianceCases: [] as unknown[],
      complianceDocuments: [] as unknown[],
      homeRegion: null,
      ...overrides,
    };
  }

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

  it('resendDriverInvite rotates token and returns inviteUrl', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          email: 'carrier@yopmail.com',
          role: 'TRANSPORT_COMPANY',
          company: carrierCompany(),
        }),
      },
      driver: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'drv-1',
          inviteAcceptedAt: null,
          status: DriverStatus.INVITED,
          user: { email: 'driver@yopmail.com', name: 'Drv' },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const result = await makeService(prisma).resendDriverInvite(carrier, {
      driverId: 'drv-1',
    });
    expect(result).toMatchObject({
      driverId: 'drv-1',
      email: 'driver@yopmail.com',
      inviteUrl: 'https://app/driver/invite/raw-token',
      mailSkipped: true,
      debugToken: 'raw-token',
    });
    expect(prisma.driver.update).toHaveBeenCalledWith({
      where: { id: 'drv-1' },
      data: expect.objectContaining({ inviteTokenHash: 'hash-token' }),
    });
    expect(drivers.sendInviteMail).toHaveBeenCalled();
  });

  it('resendDriverInvite 404 when driver missing', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: carrierCompany(),
        }),
      },
      driver: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).resendDriverInvite(carrier, { driverId: 'missing' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('addVehicle creates ACTIVE vehicle in DRAFT then returns onboarding', async () => {
    const company = carrierCompany({ status: CompanyStatus.DRAFT });
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          email: 'carrier@yopmail.com',
          role: 'TRANSPORT_COMPANY',
          name: 'C',
          phone: null,
          company: {
            ...company,
            vehicles: [{ id: 'veh-1', status: VehicleStatus.ACTIVE }],
            drivers: [],
          },
        }),
      },
      vehicle: {
        create: jest.fn().mockResolvedValue({ id: 'veh-1' }),
      },
      company: { findUnique: jest.fn() },
    };
    const result = await makeService(prisma).addVehicle(carrier, {
      label: 'Van 1',
      registration: 'abc123',
      vehicleClass: 'van',
      tareKg: 1000,
      gvmKg: 3000,
      gcmKg: 3000,
    } as never);
    expect(prisma.vehicle.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        registration: 'ABC123',
        vehicleClass: 'VAN',
        status: VehicleStatus.ACTIVE,
      }),
    });
    expect(result).toMatchObject({ step: expect.any(String) });
  });

  it('addVehicle rejects when company not draft/info-requested', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: carrierCompany({ status: CompanyStatus.BID_ELIGIBLE }),
        }),
      },
    };
    await expect(
      makeService(prisma).addVehicle(carrier, {
        label: 'X',
        registration: 'x',
        vehicleClass: 'VAN',
        tareKg: 1,
        gvmKg: 1,
        gcmKg: 1,
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updateCapabilities validates regions and persists', async () => {
    const company = carrierCompany({ status: CompanyStatus.INFO_REQUESTED });
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          email: 'carrier@yopmail.com',
          role: 'TRANSPORT_COMPANY',
          name: 'C',
          phone: null,
          company: {
            ...company,
            serviceRegionCodes: ['VIC'],
            capabilities: ['GENERAL'],
            vehicles: [],
            drivers: [],
          },
        }),
      },
      region: {
        findUnique: jest.fn().mockResolvedValue({ code: 'VIC' }),
      },
      company: {
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const result = await makeService(prisma).updateCapabilities(carrier, {
      capabilities: ['GENERAL', 'REEFER'],
      serviceRegionCodes: ['VIC'],
    } as never);
    expect(prisma.company.update).toHaveBeenCalledWith({
      where: { id: 'co-c' },
      data: {
        capabilities: ['GENERAL', 'REEFER'],
        serviceRegionCodes: ['VIC'],
      },
    });
    expect(result).toMatchObject({ step: expect.any(String) });

    prisma.region.findUnique.mockResolvedValue(null);
    await expect(
      makeService(prisma).updateCapabilities(carrier, {
        capabilities: ['GENERAL'],
        serviceRegionCodes: ['ZZZ'],
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
