import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CompanyStatus,
  CompanyType,
  ComplianceDocType,
  DriverStatus,
  VehicleStatus,
} from '@prisma/client';
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

function carrierCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: 'co-c',
    type: CompanyType.CARRIER,
    status: CompanyStatus.ACTIVE,
    legalName: 'Carrier',
    homeRegion: { code: 'VIC' },
    vehicles: [],
    drivers: [],
    complianceCases: [],
    complianceDocuments: [],
    ...overrides,
  };
}

describe('CarrierService gate leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const stripe = { isMockMode: jest.fn().mockReturnValue(true) };
  const config = { get: jest.fn() };
  const drivers = {};

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

  it('ensureDatabase throws when offline', async () => {
    await expect(
      makeService({ isConnected: () => false }).getOnboarding(carrier),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('requireCarrier 404 when company missing', async () => {
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-carrier', company: null }) },
    };
    await expect(makeService(prisma).getOnboarding(carrier)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('updateProfile rejects when not draft/info-requested', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: carrierCompany({ status: CompanyStatus.ACTIVE }),
        }),
      },
    };
    await expect(
      makeService(prisma).updateProfile(carrier, {
        legalName: 'X',
        homeRegionCode: 'VIC',
        abn: '51824753556',
      } as never,
    ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updateCapabilities rejects when company is suspended', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: carrierCompany({ status: CompanyStatus.SUSPENDED }),
        }),
      },
    };
    await expect(
      makeService(prisma).updateCapabilities(carrier, {
        capabilities: ['DG'],
        serviceRegionCodes: ['VIC'],
      } as never),
    ).rejects.toThrow(/suspended or closed/i);
  });

  it('fleetReady / canBid when at least one ACTIVE truck is RWC-complete despite incomplete B-double', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: carrierCompany({
            status: CompanyStatus.BID_ELIGIBLE,
            abn: '51824753556',
            stripeConnectPayoutsEnabled: true,
            serviceRegionCodes: ['VIC'],
            vehicles: [
              {
                id: 'veh-ute',
                status: VehicleStatus.ACTIVE,
                vehicleClass: 'UTE',
                combinationConfig: 'NONE',
                registration: 'UTE001',
                units: [
                  { id: 'u-pm', role: 'POWERED', registration: 'UTE001' },
                ],
              },
              {
                id: 'veh-bd',
                status: VehicleStatus.ACTIVE,
                vehicleClass: 'BDOUBLE',
                combinationConfig: 'BDOUBLE',
                registration: '1MR9FM',
                units: [
                  { id: 'bd-pm', role: 'POWERED', registration: '1MR9FM' },
                  { id: 'bd-t1', role: 'TRAILER_1', registration: 'T1' },
                  { id: 'bd-t2', role: 'TRAILER_2', registration: 'T2' },
                ],
              },
            ],
            drivers: [{ status: DriverStatus.ACTIVE }],
            complianceDocuments: [
              {
                docType: ComplianceDocType.RWC,
                vehicleId: 'veh-ute',
                vehicleUnitId: 'u-pm',
                status: 'APPROVED',
                expiresAt: null,
              },
              {
                docType: ComplianceDocType.RWC,
                vehicleId: 'veh-bd',
                vehicleUnitId: 'bd-pm',
                status: 'APPROVED',
                expiresAt: null,
              },
              {
                docType: ComplianceDocType.RWC,
                vehicleId: 'veh-bd',
                vehicleUnitId: 'bd-t1',
                status: 'APPROVED',
                expiresAt: null,
              },
              // Trailer 2 missing — must not block company when another truck is ready
            ],
          }),
        }),
      },
    };

    const result = await makeService(prisma).getBidEligibility(carrier);
    expect(result.goNoGo.fleetReady).toBe(true);
    expect(result.goNoGo.driversReady).toBe(true);
    expect(result.canBid).toBe(true);
  });

  it('driversReady false when only invited drivers exist (fleet alone does not unlock canBid)', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: carrierCompany({
            status: CompanyStatus.BID_ELIGIBLE,
            abn: '51824753556',
            stripeConnectPayoutsEnabled: true,
            serviceRegionCodes: ['VIC'],
            vehicles: [
              {
                id: 'veh-ute',
                status: VehicleStatus.ACTIVE,
                vehicleClass: 'UTE',
                combinationConfig: 'NONE',
                registration: 'UTE001',
                units: [{ id: 'u-pm', role: 'POWERED', registration: 'UTE001' }],
              },
            ],
            drivers: [{ status: DriverStatus.INVITED }, { status: DriverStatus.PENDING_REVIEW }],
            complianceDocuments: [
              {
                docType: ComplianceDocType.RWC,
                vehicleId: 'veh-ute',
                vehicleUnitId: 'u-pm',
                status: 'APPROVED',
                expiresAt: null,
              },
            ],
          }),
        }),
      },
    };

    const result = await makeService(prisma).getBidEligibility(carrier);
    expect(result.goNoGo.fleetReady).toBe(true);
    expect(result.goNoGo.driversReady).toBe(false);
    expect(result.canBid).toBe(false);
  });

  it('fleetReady false when every ACTIVE truck is incomplete', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-carrier',
          company: carrierCompany({
            status: CompanyStatus.BID_ELIGIBLE,
            abn: '51824753556',
            stripeConnectPayoutsEnabled: true,
            serviceRegionCodes: ['VIC'],
            vehicles: [
              {
                id: 'veh-bd',
                status: VehicleStatus.ACTIVE,
                vehicleClass: 'BDOUBLE',
                combinationConfig: 'BDOUBLE',
                registration: '1MR9FM',
                units: [
                  { id: 'bd-pm', role: 'POWERED', registration: '1MR9FM' },
                  { id: 'bd-t1', role: 'TRAILER_1', registration: 'T1' },
                  { id: 'bd-t2', role: 'TRAILER_2', registration: 'T2' },
                ],
              },
            ],
            drivers: [{ status: DriverStatus.ACTIVE }],
            complianceDocuments: [
              {
                docType: ComplianceDocType.RWC,
                vehicleId: 'veh-bd',
                vehicleUnitId: 'bd-pm',
                status: 'APPROVED',
                expiresAt: null,
              },
              {
                docType: ComplianceDocType.RWC,
                vehicleId: 'veh-bd',
                vehicleUnitId: 'bd-t1',
                status: 'APPROVED',
                expiresAt: null,
              },
            ],
          }),
        }),
      },
    };

    const result = await makeService(prisma).getBidEligibility(carrier);
    expect(result.goNoGo.fleetReady).toBe(false);
    expect(result.canBid).toBe(false);
  });
});
