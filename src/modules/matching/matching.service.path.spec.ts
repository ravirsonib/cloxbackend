import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  CompanyStatus,
  CompanyType,
  DriverStatus,
  JobStatus,
  VehicleStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { MatchingService } from './matching.service';

const carrierPrincipal: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

function carrierUser(overrides?: {
  capabilities?: string[];
  serviceRegionCodes?: string[];
  homeRegionCode?: string;
  vehicles?: Array<{ vehicleClass: string | null; status: VehicleStatus }>;
}) {
  return {
    id: 'user-carrier',
    company: {
      id: 'co-carrier',
      type: CompanyType.CARRIER,
      status: CompanyStatus.BID_ELIGIBLE,
      capabilities: overrides?.capabilities ?? [],
      serviceRegionCodes: overrides?.serviceRegionCodes ?? ['VIC'],
      homeRegion: { code: overrides?.homeRegionCode ?? 'VIC' },
      vehicles: overrides?.vehicles ?? [
        { vehicleClass: 'SEMI', status: VehicleStatus.ACTIVE },
      ],
      drivers: [],
    },
  };
}

function boardJob(partial: {
  id: string;
  requiresDg?: boolean;
  requiresReefer?: boolean;
  requiresOversize?: boolean;
  minVehicleClass?: string | null;
  originRegionCode?: string | null;
}) {
  return {
    id: partial.id,
    title: partial.id,
    status: JobStatus.BIDDING,
    pricingModel: 'PER_KM',
    minVehicleClass: partial.minVehicleClass ?? 'UTE',
    requiresDg: partial.requiresDg ?? false,
    requiresReefer: partial.requiresReefer ?? false,
    requiresOversize: partial.requiresOversize ?? false,
    chargeableWeightKg: 100,
    routeDistanceKm: 10,
    routeDurationMinutes: 20,
    routeFatigueBreakMinutes: 0,
    billableHours: null,
    estimateIncGstCents: 10_000,
    pickupAt: new Date('2026-10-10T10:00:00.000Z'),
    publishedAt: new Date('2026-10-06T10:00:00.000Z'),
    originRegion: partial.originRegionCode
      ? { code: partial.originRegionCode }
      : null,
    stops: [{ stopType: 'PICKUP', suburb: 'Melbourne' }],
    proposals: [],
  };
}

describe('MatchingService path (mocked Prisma)', () => {
  it('listBoard throws Forbidden CARRIER_NOT_BID_ELIGIBLE when canBid is false', async () => {
    const prisma = { isConnected: () => true };
    const carrierService = {
      getBidEligibility: jest.fn().mockResolvedValue({
        canBid: false,
        goNoGo: { reasons: ['not eligible'] },
      }),
    };
    const service = new MatchingService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      carrierService as never,
      {} as never,
    );

    await expect(service.listBoard(carrierPrincipal)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    try {
      await service.listBoard(carrierPrincipal);
    } catch (err) {
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        message: 'Carrier cannot view job board until bid-eligible',
        code: 'CARRIER_NOT_BID_ELIGIBLE',
      });
    }
  });

  it('listBoard returns only jobs that pass carrierMatchesJob filters', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(
          carrierUser({
            capabilities: [],
            serviceRegionCodes: ['VIC'],
            homeRegionCode: 'VIC',
            vehicles: [{ vehicleClass: 'SEMI', status: VehicleStatus.ACTIVE }],
          }),
        ),
      },
      job: {
        findMany: jest.fn().mockResolvedValue([
          boardJob({
            id: 'job-dg',
            requiresDg: true,
            originRegionCode: 'VIC',
          }),
          boardJob({
            id: 'job-nsw',
            originRegionCode: 'NSW',
          }),
          boardJob({
            id: 'job-vic-ok',
            originRegionCode: 'VIC',
            minVehicleClass: 'UTE',
          }),
        ]),
      },
    };
    const carrierService = {
      getBidEligibility: jest.fn().mockResolvedValue({ canBid: true, goNoGo: {} }),
    };
    const service = new MatchingService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      carrierService as never,
      {} as never,
    );

    const result = await service.listBoard(carrierPrincipal);
    expect(result.jobs.map((j) => j.id)).toEqual(['job-vic-ok']);
  });

  describe('submitProposal rejection codes', () => {
    const openJob = {
      id: 'job-1',
      status: JobStatus.BIDDING,
      pricingModel: 'PER_KM' as const,
      minVehicleClass: 'SEMI',
      requiresDg: false,
      requiresReefer: false,
      requiresOversize: false,
      originRegion: { code: 'VIC' },
    };

    const baseInput = {
      jobId: 'job-1',
      vehicleId: 'veh-1',
      driverId: 'drv-1',
      amountIncGstCents: 50_000,
      etaMinutes: 90,
    };

    function buildService(prismaOverrides: Record<string, unknown>) {
      const prisma = {
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue(
            carrierUser({
              capabilities: [],
              serviceRegionCodes: ['VIC'],
              vehicles: [{ vehicleClass: 'SEMI', status: VehicleStatus.ACTIVE }],
            }),
          ),
        },
        vehicle: { findFirst: jest.fn() },
        driver: { findFirst: jest.fn() },
        proposal: { findFirst: jest.fn(), create: jest.fn() },
        job: { update: jest.fn() },
        ...prismaOverrides,
      };
      const carrierService = {
        getBidEligibility: jest.fn().mockResolvedValue({ canBid: true, goNoGo: {} }),
      };
      const jobsService = {
        assertJobOpenForBidding: jest.fn().mockResolvedValue(openJob),
        getMinBaseCents: jest.fn().mockResolvedValue(5_000),
      };
      return {
        service: new MatchingService(
          prisma as never,
          { recordPlatform: jest.fn() } as never,
          carrierService as never,
          jobsService as never,
        ),
        prisma,
      };
    }

    it('rejects non-ACTIVE vehicle with VEHICLE_NOT_ACTIVE', async () => {
      const { service, prisma } = buildService({
        vehicle: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      });

      await expect(service.submitProposal(carrierPrincipal, baseInput)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      try {
        await service.submitProposal(carrierPrincipal, baseInput);
      } catch (err) {
        expect((err as BadRequestException).getResponse()).toMatchObject({
          message: 'Active vehicle required',
          code: 'VEHICLE_NOT_ACTIVE',
        });
      }
      expect(prisma.vehicle.findFirst).toHaveBeenCalledWith({
        where: {
          id: baseInput.vehicleId,
          companyId: 'co-carrier',
          status: VehicleStatus.ACTIVE,
        },
      });
    });

    it('rejects expired licence with LICENCE_EXPIRED', async () => {
      const { service } = buildService({
        vehicle: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'veh-1',
            vehicleClass: 'SEMI',
            status: VehicleStatus.ACTIVE,
          }),
        },
        driver: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'drv-1',
            status: DriverStatus.ACTIVE,
            licenceClass: 'HC',
            licenceExpiry: new Date('2020-01-01T00:00:00.000Z'),
            nhvrAcknowledgedAt: new Date('2026-01-01T00:00:00.000Z'),
          }),
        },
      });

      try {
        await service.submitProposal(carrierPrincipal, baseInput);
        fail('expected BadRequestException');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({
          message: 'Driver licence expired or missing expiry',
          code: 'LICENCE_EXPIRED',
        });
      }
    });

    it('rejects missing NHVR with NHVR_REQUIRED', async () => {
      const { service } = buildService({
        vehicle: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'veh-1',
            vehicleClass: 'SEMI',
            status: VehicleStatus.ACTIVE,
          }),
        },
        driver: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'drv-1',
            status: DriverStatus.ACTIVE,
            licenceClass: 'HC',
            licenceExpiry: new Date('2030-01-01T00:00:00.000Z'),
            nhvrAcknowledgedAt: null,
          }),
        },
      });

      try {
        await service.submitProposal(carrierPrincipal, baseInput);
        fail('expected BadRequestException');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({
          message: 'Driver NHVR acknowledgement required',
          code: 'NHVR_REQUIRED',
        });
      }
    });

    it('rejects wrong licence class with LICENCE_CLASS_MISMATCH', async () => {
      const { service } = buildService({
        vehicle: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'veh-1',
            vehicleClass: 'SEMI',
            status: VehicleStatus.ACTIVE,
          }),
        },
        driver: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'drv-1',
            status: DriverStatus.ACTIVE,
            licenceClass: 'C',
            licenceExpiry: new Date('2030-01-01T00:00:00.000Z'),
            nhvrAcknowledgedAt: new Date('2026-01-01T00:00:00.000Z'),
          }),
        },
      });

      try {
        await service.submitProposal(carrierPrincipal, baseInput);
        fail('expected BadRequestException');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({
          message: 'Driver licence C does not cover vehicle class SEMI',
          code: 'LICENCE_CLASS_MISMATCH',
        });
      }
    });

    it('happy path creates proposal and flips PUBLISHED job to BIDDING', async () => {
      const created = {
        id: 'prop-new',
        jobId: 'job-1',
        status: 'SUBMITTED',
        amountIncGstCents: 12_000,
        etaMinutes: 90,
        vehicleId: 'veh-1',
        driverId: 'drv-1',
      };
      const { service, prisma } = buildService({
        vehicle: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'veh-1',
            vehicleClass: 'SEMI',
            status: VehicleStatus.ACTIVE,
          }),
        },
        driver: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'drv-1',
            status: DriverStatus.ACTIVE,
            licenceClass: 'HC',
            licenceExpiry: new Date('2030-01-01T00:00:00.000Z'),
            nhvrAcknowledgedAt: new Date('2026-01-01T00:00:00.000Z'),
          }),
        },
        proposal: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue(created),
        },
        job: { update: jest.fn() },
      });

      // openJob in buildService defaults BIDDING — force PUBLISHED via jobsService override
      const carrierService = {
        getBidEligibility: jest.fn().mockResolvedValue({ canBid: true, goNoGo: {} }),
      };
      const jobsService = {
        assertJobOpenForBidding: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: JobStatus.PUBLISHED,
          pricingModel: 'PER_KM',
          minVehicleClass: 'UTE',
          requiresDg: false,
          requiresReefer: false,
          requiresOversize: false,
          originRegion: { code: 'VIC' },
        }),
        getMinBaseCents: jest.fn().mockResolvedValue(5_000),
      };
      const happy = new MatchingService(
        prisma as never,
        { recordPlatform: jest.fn() } as never,
        carrierService as never,
        jobsService as never,
      );

      const result = await happy.submitProposal(carrierPrincipal, baseInput);
      expect(result).toMatchObject({
        id: 'prop-new',
        jobId: 'job-1',
        status: 'SUBMITTED',
        amountIncGstCents: 12_000,
        vehicleId: 'veh-1',
        driverId: 'drv-1',
      });
      expect(typeof result.netToCarrierCents).toBe('number');
      expect(prisma.job.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: { status: JobStatus.BIDDING },
      });
    });
  });
});
