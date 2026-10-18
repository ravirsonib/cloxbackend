import { ForbiddenException } from '@nestjs/common';
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

function createInput(): JobCreateInput {
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
        state: 'VIC',
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

describe('JobsService createJob + list/get paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const payments = { acceptProposal: jest.fn() };

  function makeService(
    prisma: Record<string, unknown>,
    canBook = true,
  ) {
    const senderService = {
      getBookingEligibility: jest.fn().mockResolvedValue({
        canBook,
        goNoGo: { canBook },
      }),
    };
    return new JobsService(
      prisma as never,
      audit as never,
      senderService as never,
      payments as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('createJob rejects when sender cannot book', async () => {
    const service = makeService({ isConnected: () => true }, false);
    await expect(
      service.createJob(senderPrincipal, createInput()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('createJob creates DRAFT job with stops + estimate', async () => {
    const created = {
      id: 'job-1',
      title: null,
      status: JobStatus.DRAFT,
      pricingModel: 'PER_KM',
      senderCompanyId: 'co-s',
      deadWeightKg: 100,
      chargeableWeightKg: 250,
      minVehicleClass: 'UTE',
      requiresDg: false,
      requiresReefer: false,
      requiresOversize: false,
      loadTypes: ['GENERAL'],
      siteManeuverability: 'EASY',
      siteFacility: 'DOCK',
      siteDisclaimerAcceptedAt: new Date(),
      hourlyPattern: null,
      routeDistanceKm: 10,
      routeDurationMinutes: 20,
      routeFatigueBreakMinutes: 0,
      billableHours: null,
      estimateExGstCents: 5000,
      estimateGstCents: 500,
      estimateIncGstCents: 5500,
      publishedAt: null,
      createdAt: new Date(),
      pickupAt: new Date('2026-10-10T10:00:00Z'),
      stops: [],
      proposals: [],
    };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          companyId: 'co-s',
          company: {
            id: 'co-s',
            type: CompanyType.SENDER,
            homeRegionId: 'reg-vic',
            homeRegion: { code: 'VIC' },
          },
        }),
      },
      region: {
        findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }),
      },
      localTerritory: {
        findMany: jest.fn().mockResolvedValue([{ id: 'terr-mel', code: 'MEL' }]),
      },
      policyVersion: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      job: {
        create: jest.fn().mockResolvedValue(created),
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
    };
    const service = makeService(prisma, true);
    const result = await service.createJob(senderPrincipal, createInput());
    expect(prisma.job.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          routeDistanceKm: 12,
        }),
      }),
    );
    expect(result).toMatchObject({
      id: 'job-1',
      status: JobStatus.DRAFT,
    });
    expect(audit.recordPlatform).toHaveBeenCalled();
  });

  it('createJob uses sender distanceKm even when stops suggest differently', async () => {
    const created = {
      id: 'job-override',
      title: null,
      status: JobStatus.DRAFT,
      pricingModel: 'PER_KM',
      senderCompanyId: 'co-s',
      deadWeightKg: 100,
      chargeableWeightKg: 250,
      minVehicleClass: 'UTE',
      requiresDg: false,
      requiresReefer: false,
      requiresOversize: false,
      loadTypes: ['GENERAL'],
      siteManeuverability: 'EASY',
      siteFacility: 'DOCK',
      siteDisclaimerAcceptedAt: new Date(),
      hourlyPattern: null,
      routeDistanceKm: 99,
      routeDurationMinutes: 99,
      routeFatigueBreakMinutes: 0,
      billableHours: null,
      estimateExGstCents: 24_750,
      estimateGstCents: 2_475,
      estimateIncGstCents: 24_750,
      publishedAt: null,
      createdAt: new Date(),
      pickupAt: new Date('2026-10-10T10:00:00Z'),
      stops: [],
      proposals: [],
    };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          companyId: 'co-s',
          company: {
            id: 'co-s',
            type: CompanyType.SENDER,
            homeRegionId: 'reg-vic',
            homeRegion: { code: 'VIC' },
          },
        }),
      },
      region: {
        findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }),
      },
      localTerritory: {
        findMany: jest.fn().mockResolvedValue([{ id: 'terr-mel', code: 'MEL' }]),
      },
      policyVersion: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      job: {
        create: jest.fn().mockResolvedValue(created),
      },
    };
    const service = makeService(prisma, true);
    await service.createJob(senderPrincipal, { ...createInput(), distanceKm: 99 });
    expect(prisma.job.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          routeDistanceKm: 99,
        }),
      }),
    );
  });

  it('listSenderJobs maps jobs for sender', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          company: { id: 'co-s', type: CompanyType.SENDER },
        }),
      },
      job: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'job-1',
            title: 'J',
            status: JobStatus.DRAFT,
            pricingModel: 'PER_KM',
            deadWeightKg: 100,
            chargeableWeightKg: 100,
            minVehicleClass: 'UTE',
            requiresDg: false,
            requiresReefer: false,
            requiresOversize: false,
            loadTypes: [],
            siteManeuverability: null,
            siteFacility: null,
            siteDisclaimerAcceptedAt: null,
            hourlyPattern: null,
            routeDistanceKm: 1,
            routeDurationMinutes: 1,
            routeFatigueBreakMinutes: 0,
            billableHours: null,
            estimateExGstCents: 1000,
            estimateGstCents: 100,
            estimateIncGstCents: 1100,
            publishedAt: null,
            createdAt: new Date(),
            pickupAt: new Date(),
            stops: [],
            proposals: [],
          },
        ]),
      },
    };
    const service = makeService(prisma);
    const rows = await service.listSenderJobs(senderPrincipal);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('job-1');
  });
});
