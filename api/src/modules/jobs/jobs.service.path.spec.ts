import { BadRequestException } from '@nestjs/common';
import { CompanyType, JobStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import type { JobCreateInput } from '../../shared/types';
import { JobsService } from './jobs.service';

const senderPrincipal: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

function baseCreateInput(stopState: string): JobCreateInput {
  return {
    pricingModel: 'PER_KM',
    pickupAt: '2026-10-10T10:00:00.000Z',
    receiverName: 'Receiver Co',
    receiverEmail: 'receiver@yopmail.com',
    deadWeightKg: 100,
    lengthCm: 100,
    widthCm: 100,
    heightCm: 100,
    distanceKm: 12,
    loadTypes: ['GENERAL'],
    siteManeuverability: 'EASY',
    siteFacility: 'DOCK',
    siteDisclaimerAccepted: true,
    stops: [
      {
        sequence: 0,
        stopType: 'PICKUP',
        label: 'Pickup',
        addressLine: '1 Pickup St',
        suburb: 'Melbourne',
        state: stopState,
        postcode: '3000',
        lat: -37.8136,
        lng: 144.9631,
      },
      {
        sequence: 1,
        stopType: 'DROPOFF',
        label: 'Drop',
        addressLine: '2 Drop St',
        suburb: 'Richmond',
        state: 'VIC',
        postcode: '3121',
        lat: -37.8197,
        lng: 144.998,
      },
    ],
  };
}

describe('JobsService path (mocked Prisma)', () => {
  it('publishJob rejects non-DRAFT jobs', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          companyId: 'co-sender',
        }),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'job-1',
          senderCompanyId: 'co-sender',
          status: JobStatus.BIDDING,
          receiverEmail: 'r@yopmail.com',
          receiverName: 'Receiver',
          siteDisclaimerAcceptedAt: new Date(),
          stops: [],
        }),
        update: jest.fn(),
      },
    };
    const senderService = {
      getBookingEligibility: jest.fn().mockResolvedValue({ canBook: true, goNoGo: {} }),
    };
    const service = new JobsService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      senderService as never,
      {} as never,
    );

    await expect(service.publishJob(senderPrincipal, 'job-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.publishJob(senderPrincipal, 'job-1')).rejects.toThrow(
      'Only DRAFT jobs can be published',
    );
    expect(prisma.job.update).not.toHaveBeenCalled();
  });

  it('createJob sets originRegionId from VIC pickup and prefers MEL territory', async () => {
    const createdJob = {
      id: 'job-new',
      status: JobStatus.DRAFT,
      pricingModel: 'PER_KM',
      title: 'PER_KM job',
      receiverName: 'Receiver Co',
      receiverEmail: 'receiver@yopmail.com',
      receiverPhone: null,
      pickupAt: new Date('2026-10-10T10:00:00.000Z'),
      deadWeightKg: 100,
      lengthCm: 100,
      widthCm: 100,
      heightCm: 100,
      chargeableWeightKg: 100,
      loadTypes: ['GENERAL'],
      requiresDg: false,
      requiresReefer: false,
      requiresOversize: false,
      minVehicleClass: 'UTE',
      recommendedVehicleClass: 'UTE',
      siteManeuverability: 'EASY',
      siteFacility: 'DOCK',
      siteDisclaimerAcceptedAt: new Date(),
      hourlyPattern: null,
      routeDistanceKm: 5,
      routeDurationMinutes: 10,
      routeFatigueBreakMinutes: 0,
      billableHours: null,
      estimateExGstCents: 5000,
      estimateGstCents: 500,
      estimateIncGstCents: 5500,
      publishedAt: null,
      createdAt: new Date(),
      stops: [],
    };

    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          company: {
            id: 'co-sender',
            type: CompanyType.SENDER,
            homeRegionId: 'region-home-fallback',
            homeRegion: { code: 'NSW', id: 'region-home-fallback' },
          },
        }),
      },
      policyVersion: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      region: {
        findUnique: jest.fn().mockResolvedValue({ id: 'region-vic', code: 'VIC' }),
      },
      localTerritory: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'terr-ballarat', code: 'BAL', regionId: 'region-vic', enabled: true },
          { id: 'terr-mel', code: 'MEL', regionId: 'region-vic', enabled: true },
        ]),
      },
      job: {
        create: jest.fn().mockResolvedValue(createdJob),
      },
    };
    const senderService = {
      getBookingEligibility: jest.fn().mockResolvedValue({ canBook: true, goNoGo: {} }),
    };
    const audit = { recordPlatform: jest.fn() };
    const service = new JobsService(
      prisma as never,
      audit as never,
      senderService as never,
      {} as never,
    );

    await service.createJob(senderPrincipal, baseCreateInput('VIC'));

    expect(prisma.region.findUnique).toHaveBeenCalledWith({ where: { code: 'VIC' } });
    expect(prisma.localTerritory.findMany).toHaveBeenCalledWith({
      where: { regionId: 'region-vic', enabled: true },
      orderBy: { code: 'asc' },
    });
    expect(prisma.job.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          originRegionId: 'region-vic',
          originTerritoryId: 'terr-mel',
        }),
      }),
    );
  });

  it('createJob falls back to company.homeRegionId when stop state is unknown', async () => {
    const createdJob = {
      id: 'job-fallback',
      status: JobStatus.DRAFT,
      pricingModel: 'PER_KM',
      title: 'PER_KM job',
      receiverName: 'Receiver Co',
      receiverEmail: 'receiver@yopmail.com',
      receiverPhone: null,
      pickupAt: new Date('2026-10-10T10:00:00.000Z'),
      deadWeightKg: 100,
      lengthCm: 100,
      widthCm: 100,
      heightCm: 100,
      chargeableWeightKg: 100,
      loadTypes: ['GENERAL'],
      requiresDg: false,
      requiresReefer: false,
      requiresOversize: false,
      minVehicleClass: 'UTE',
      recommendedVehicleClass: 'UTE',
      siteManeuverability: 'EASY',
      siteFacility: 'DOCK',
      siteDisclaimerAcceptedAt: new Date(),
      hourlyPattern: null,
      routeDistanceKm: 5,
      routeDurationMinutes: 10,
      routeFatigueBreakMinutes: 0,
      billableHours: null,
      estimateExGstCents: 5000,
      estimateGstCents: 500,
      estimateIncGstCents: 5500,
      publishedAt: null,
      createdAt: new Date(),
      stops: [],
    };

    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          company: {
            id: 'co-sender',
            type: CompanyType.SENDER,
            homeRegionId: 'region-home',
            homeRegion: { code: 'NSW', id: 'region-home' },
          },
        }),
      },
      policyVersion: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      region: {
        findUnique: jest.fn(),
      },
      localTerritory: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'terr-syd', code: 'SYD', regionId: 'region-home', enabled: true },
        ]),
      },
      job: {
        create: jest.fn().mockResolvedValue(createdJob),
      },
    };
    const senderService = {
      getBookingEligibility: jest.fn().mockResolvedValue({ canBook: true, goNoGo: {} }),
    };
    const service = new JobsService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      senderService as never,
      {} as never,
    );

    await service.createJob(senderPrincipal, baseCreateInput('ZZ'));

    expect(prisma.region.findUnique).not.toHaveBeenCalled();
    expect(prisma.localTerritory.findMany).toHaveBeenCalledWith({
      where: { regionId: 'region-home', enabled: true },
      orderBy: { code: 'asc' },
    });
    expect(prisma.job.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          originRegionId: 'region-home',
          originTerritoryId: 'terr-syd',
        }),
      }),
    );
  });
});
