import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
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
  homeRegionCode?: string | null;
  vehicles?: Array<{ vehicleClass: string | null; status: VehicleStatus }>;
}) {
  return {
    id: 'user-carrier',
    company: {
      id: 'co-carrier',
      type: CompanyType.CARRIER,
      status: CompanyStatus.BID_ELIGIBLE,
      capabilities: overrides?.capabilities ?? ['DG', 'REEFER', 'OVERSIZE'],
      serviceRegionCodes: overrides?.serviceRegionCodes ?? [],
      homeRegion:
        overrides?.homeRegionCode === null
          ? null
          : { code: overrides?.homeRegionCode ?? 'VIC' },
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
  estimateIncGstCents?: number | null;
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
    estimateIncGstCents:
      partial.estimateIncGstCents === undefined ? 10_000 : partial.estimateIncGstCents,
    pickupAt: new Date('2026-10-10T10:00:00.000Z'),
    publishedAt: new Date('2026-10-06T10:00:00.000Z'),
    originRegion: partial.originRegionCode
      ? { code: partial.originRegionCode }
      : null,
    stops: [{ stopType: 'PICKUP', suburb: 'Melbourne' }],
    proposals: [{ id: 'existing-prop' }],
  };
}

describe('MatchingService leftover paths', () => {
  it('listBoard filters REEFER/OVERSIZE and maps null estimate + alreadyBid', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(
          carrierUser({
            capabilities: ['DG'],
            serviceRegionCodes: [],
            homeRegionCode: 'VIC',
          }),
        ),
      },
      job: {
        findMany: jest.fn().mockResolvedValue([
          boardJob({ id: 'job-reefer', requiresReefer: true, originRegionCode: 'VIC' }),
          boardJob({ id: 'job-over', requiresOversize: true, originRegionCode: 'VIC' }),
          boardJob({
            id: 'job-ok',
            originRegionCode: 'VIC',
            estimateIncGstCents: null,
          }),
        ]),
      },
    };
    const service = new MatchingService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { getBidEligibility: jest.fn().mockResolvedValue({ canBid: true, goNoGo: {} }) } as never,
      {} as never,
    );

    const result = await service.listBoard(carrierPrincipal);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      id: 'job-ok',
      estimateIncGstCents: null,
      estimateNetToCarrierCents: null,
      alreadyBid: true,
    });
  });

  it('listBoard matches via homeRegion when serviceRegionCodes empty', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(
          carrierUser({
            capabilities: [],
            serviceRegionCodes: [],
            homeRegionCode: 'NSW',
          }),
        ),
      },
      job: {
        findMany: jest.fn().mockResolvedValue([
          boardJob({ id: 'job-nsw', originRegionCode: 'NSW' }),
          boardJob({ id: 'job-vic', originRegionCode: 'VIC' }),
        ]),
      },
    };
    const service = new MatchingService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { getBidEligibility: jest.fn().mockResolvedValue({ canBid: true, goNoGo: {} }) } as never,
      {} as never,
    );

    const result = await service.listBoard(carrierPrincipal);
    expect(result.jobs.map((j) => j.id)).toEqual(['job-nsw']);
  });

  it('requireCarrierCompany 404 when company missing', async () => {
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'u', company: null }) },
    };
    const service = new MatchingService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { getBidEligibility: jest.fn().mockResolvedValue({ canBid: true, goNoGo: {} }) } as never,
      {} as never,
    );
    await expect(service.listBoard(carrierPrincipal)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('submitProposal rejects JOB_NOT_ELIGIBLE, BID_BELOW_MIN_BASE, duplicate', async () => {
    const openJob = {
      id: 'job-1',
      status: JobStatus.BIDDING,
      pricingModel: 'HOURLY' as const,
      minVehicleClass: 'SEMI',
      requiresDg: true,
      requiresReefer: false,
      requiresOversize: false,
      originRegion: { code: 'VIC' },
    };
    const baseInput = {
      jobId: 'job-1',
      vehicleId: 'veh-1',
      driverId: 'drv-1',
      amountIncGstCents: 1_000,
      etaMinutes: 60,
    };

    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(
          carrierUser({
            capabilities: [],
            serviceRegionCodes: ['VIC'],
          }),
        ),
      },
      vehicle: { findFirst: jest.fn() },
      driver: { findFirst: jest.fn() },
      proposal: { findFirst: jest.fn(), create: jest.fn() },
      job: { update: jest.fn() },
    };
    const carrierService = {
      getBidEligibility: jest.fn().mockResolvedValue({ canBid: true, goNoGo: {} }),
    };
    const jobsService = {
      assertJobOpenForBidding: jest.fn().mockResolvedValue(openJob),
      getMinBaseCents: jest.fn().mockResolvedValue(20_000),
    };
    const service = new MatchingService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      carrierService as never,
      jobsService as never,
    );

    try {
      await service.submitProposal(carrierPrincipal, baseInput);
      fail('expected JOB_NOT_ELIGIBLE');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: 'JOB_NOT_ELIGIBLE',
      });
    }

    // Eligible carrier but bid below min
    prisma.user.findUnique.mockResolvedValue(
      carrierUser({
        capabilities: ['DG'],
        serviceRegionCodes: ['VIC'],
      }),
    );
    prisma.vehicle.findFirst.mockResolvedValue({
      id: 'veh-1',
      vehicleClass: 'SEMI',
      status: VehicleStatus.ACTIVE,
    });
    prisma.driver.findFirst.mockResolvedValue({
      id: 'drv-1',
      status: DriverStatus.ACTIVE,
      licenceClass: 'HC',
      licenceExpiry: new Date('2030-01-01T00:00:00.000Z'),
      nhvrAcknowledgedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    try {
      await service.submitProposal(carrierPrincipal, baseInput);
      fail('expected BID_BELOW_MIN_BASE');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'BID_BELOW_MIN_BASE',
        minBaseCents: 20_000,
      });
    }
    expect(jobsService.getMinBaseCents).toHaveBeenCalledWith('HOURLY');

    // Duplicate proposal
    prisma.proposal.findFirst.mockResolvedValue({ id: 'prop-old' });
    await expect(
      service.submitProposal(carrierPrincipal, {
        ...baseInput,
        amountIncGstCents: 50_000,
      }),
    ).rejects.toThrow('Already submitted a proposal for this job');
  });

  it('submitProposal rejects undersized vehicle class', async () => {
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
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'veh-1',
          vehicleClass: 'UTE',
          status: VehicleStatus.ACTIVE,
        }),
      },
      driver: { findFirst: jest.fn() },
      proposal: { findFirst: jest.fn(), create: jest.fn() },
      job: { update: jest.fn() },
    };
    const service = new MatchingService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { getBidEligibility: jest.fn().mockResolvedValue({ canBid: true, goNoGo: {} }) } as never,
      {
        assertJobOpenForBidding: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: JobStatus.BIDDING,
          pricingModel: 'PER_KM',
          minVehicleClass: 'SEMI',
          requiresDg: false,
          requiresReefer: false,
          requiresOversize: false,
          originRegion: { code: 'VIC' },
        }),
        getMinBaseCents: jest.fn().mockResolvedValue(5_000),
      } as never,
    );

    try {
      await service.submitProposal(carrierPrincipal, {
        jobId: 'job-1',
        vehicleId: 'veh-1',
        driverId: 'drv-1',
        amountIncGstCents: 50_000,
        etaMinutes: 30,
      });
      fail('expected VEHICLE_CLASS_UNDERSIZE');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'VEHICLE_CLASS_UNDERSIZE',
      });
    }
  });
});
