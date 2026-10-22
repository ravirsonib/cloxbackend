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
      { sendRegistrationConfirmation: jest.fn().mockResolvedValue({ skipped: true }) } as never,
      { resolveInviteForRegister: jest.fn().mockResolvedValue({ referredByAdminUserId: null, inviteId: null, prospectId: null, homeRegionId: null }), markInviteAccepted: jest.fn() } as never,
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
    } as never,
    );
    expect(prisma.vehicle.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        registration: 'ABC123',
        vehicleClass: 'VAN',
        status: VehicleStatus.ACTIVE,
      }),
    });
    expect(result).toMatchObject({ step: expect.any(String) });
  });

  it('addVehicle allows BID_ELIGIBLE and rejects SUSPENDED', async () => {
    const eligibleCompany = carrierCompany({ status: CompanyStatus.BID_ELIGIBLE });
    const eligiblePrisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          email: 'carrier@yopmail.com',
          role: 'TRANSPORT_COMPANY',
          name: 'C',
          phone: null,
          company: {
            ...eligibleCompany,
            vehicles: [],
            drivers: [],
          },
        }),
      },
      vehicle: {
        create: jest.fn().mockResolvedValue({ id: 'veh-2' }),
      },
    };
    await expect(
      makeService(eligiblePrisma).addVehicle(carrier, {
        label: 'X',
        registration: 'x1',
        vehicleClass: 'VAN',
        tareKg: 1,
        gvmKg: 1,
        gcmKg: 1,
      } as never),
    ).resolves.toMatchObject({ step: expect.any(String) });

    const suspendedPrisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: carrierCompany({ status: CompanyStatus.SUSPENDED }),
        }),
      },
    };
    await expect(
      makeService(suspendedPrisma).addVehicle(carrier, {
        label: 'X',
        registration: 'x',
        vehicleClass: 'VAN',
        tareKg: 1,
        gvmKg: 1,
        gcmKg: 1,
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('listVehicles returns company fleet with RWC compliance summary', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: carrierCompany({ status: CompanyStatus.BID_ELIGIBLE }),
        }),
      },
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'veh-1',
            status: VehicleStatus.ACTIVE,
            label: 'Primary',
            registration: 'ABC123',
            vehicleClass: 'RIGID_1_2T',
            tareKg: 3500,
            gvmKg: 8000,
            gcmKg: null,
            disabledAt: null,
            disabledReason: null,
            disabledNote: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]),
      },
      complianceDocument: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'doc-rwc',
            vehicleId: 'veh-1',
            companyId: 'co-c',
            status: 'APPROVED',
            expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
          },
        ]),
      },
      assignment: {
        findMany: jest.fn().mockResolvedValue([
          {
            vehicleId: 'veh-1',
            trip: {
              id: 'trip-1',
              status: 'AT_DROPOFF',
              onBreak: false,
              breakStartedAt: null,
            },
            job: { id: 'job-1', title: 'Melbourne → Tullamarine · PER_KM' },
          },
        ]),
      },
    };
    const result = await makeService(prisma).listVehicles(carrier);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].compliance.rwc.state).toBe('EXPIRING');
    expect(result.items[0].activityStatus).toBe('AT_DROPOFF');
    expect(result.items[0].currentTrip?.jobTitle).toContain('Tullamarine');
    expect(prisma.vehicle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 'co-c' } }),
    );
  });

  it('disableVehicle rejects last active vehicle when bid-eligible', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: carrierCompany({ status: CompanyStatus.BID_ELIGIBLE }),
        }),
      },
      vehicle: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'veh-1',
            companyId: 'co-c',
            status: VehicleStatus.ACTIVE,
          })
          .mockResolvedValueOnce({ status: VehicleStatus.ACTIVE }),
        count: jest.fn().mockResolvedValue(1),
      },
      assignment: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).disableVehicle(carrier, 'veh-1', { reason: 'Sold truck' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('disableVehicle suspends when another active vehicle exists', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: carrierCompany({ status: CompanyStatus.BID_ELIGIBLE }),
        }),
      },
      vehicle: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'veh-1',
            companyId: 'co-c',
            status: VehicleStatus.ACTIVE,
          })
          .mockResolvedValueOnce({ status: VehicleStatus.ACTIVE }),
        count: jest.fn().mockResolvedValue(2),
        update: jest.fn().mockResolvedValue({
          id: 'veh-1',
          status: VehicleStatus.SUSPENDED,
          disabledReason: 'Maintenance',
        }),
      },
      assignment: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const result = await makeService(prisma).disableVehicle(carrier, 'veh-1', {
      reason: 'Maintenance',
    });
    expect(result.status).toBe(VehicleStatus.SUSPENDED);
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'carrier.vehicle_disabled' }),
    );
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

  it('deleteDriver removes never-assigned invite', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: carrierCompany({ status: CompanyStatus.BID_ELIGIBLE }),
        }),
        delete: jest.fn().mockResolvedValue({}),
      },
      driver: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'drv-1',
          companyId: 'co-c',
          userId: 'user-drv',
          status: DriverStatus.INVITED,
          inviteAcceptedAt: null,
          user: { id: 'user-drv', email: 'd@yopmail.com', name: 'D' },
          _count: { assignments: 0, proposals: 0 },
        }),
        delete: jest.fn().mockResolvedValue({}),
        count: jest.fn(),
      },
      assignment: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          driver: { delete: jest.fn().mockResolvedValue({}) },
          user: { delete: jest.fn().mockResolvedValue({}) },
        }),
      ),
    };
    const result = await makeService(prisma).deleteDriver(carrier, 'drv-1');
    expect(result).toEqual({ ok: true, id: 'drv-1' });
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'carrier.driver_deleted' }),
    );
  });

  it('deleteDriver rejects when driver has assignment history', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: carrierCompany({ status: CompanyStatus.BID_ELIGIBLE }),
        }),
      },
      driver: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'drv-1',
          companyId: 'co-c',
          userId: 'user-drv',
          status: DriverStatus.ACTIVE,
          inviteAcceptedAt: new Date(),
          user: { id: 'user-drv', email: 'd@yopmail.com', name: 'D' },
          _count: { assignments: 1, proposals: 0 },
        }),
      },
    };
    try {
      await makeService(prisma).deleteDriver(carrier, 'drv-1');
      fail('expected BadRequestException');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'DRIVER_HAS_HISTORY',
      });
    }
  });

  it('deleteVehicle removes never-assigned vehicle', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: carrierCompany({ status: CompanyStatus.BID_ELIGIBLE }),
        }),
      },
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'veh-1',
          companyId: 'co-c',
          status: VehicleStatus.ACTIVE,
          registration: 'ABC123',
          label: 'Spare',
          vehicleClass: 'VAN',
          _count: { assignments: 0, proposals: 0 },
        }),
        delete: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(2),
      },
      assignment: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const result = await makeService(prisma).deleteVehicle(carrier, 'veh-1');
    expect(result).toEqual({ ok: true, id: 'veh-1' });
    expect(prisma.vehicle.delete).toHaveBeenCalledWith({ where: { id: 'veh-1' } });
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'carrier.vehicle_deleted' }),
    );
  });

  it('deleteVehicle rejects when vehicle has history', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: carrierCompany({ status: CompanyStatus.BID_ELIGIBLE }),
        }),
      },
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'veh-1',
          companyId: 'co-c',
          status: VehicleStatus.ACTIVE,
          registration: 'ABC123',
          label: 'Primary',
          vehicleClass: 'VAN',
          _count: { assignments: 0, proposals: 2 },
        }),
      },
    };
    try {
      await makeService(prisma).deleteVehicle(carrier, 'veh-1');
      fail('expected BadRequestException');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'VEHICLE_HAS_HISTORY',
      });
    }
  });
});
