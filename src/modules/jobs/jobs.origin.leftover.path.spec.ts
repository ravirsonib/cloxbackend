import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { JobsService } from './jobs.service';

const sender: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

const carrier: AuthenticatedPrincipal = {
  id: 'user-carrier',
  email: 'carrier@yopmail.com',
  role: 'TRANSPORT_COMPANY',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('JobsService origin/create leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const senderService = {
    getBookingEligibility: jest.fn().mockResolvedValue({ canBook: true, goNoGo: {} }),
  };
  const payments = { acceptProposal: jest.fn() };

  function makeService(prisma: Record<string, unknown>) {
    return new JobsService(
      prisma as never,
      audit as never,
      senderService as never,
      payments as never,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('ensureDatabase throws when offline', async () => {
    const service = makeService({ isConnected: () => false });
    await expect(service.listSenderJobs(sender)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('getJobForSender forbids non-sender', async () => {
    const service = makeService({ isConnected: () => true });
    await expect(service.getJobForSender(carrier, 'job-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('createJob rejects disclaimer / receiver / multi-drop / undersize', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          company: { id: 'co-s', homeRegionId: null },
        }),
      },
      region: { findUnique: jest.fn() },
      localTerritory: { findMany: jest.fn().mockResolvedValue([]) },
      policyVersion: { findFirst: jest.fn().mockResolvedValue(null) },
      job: { create: jest.fn() },
    };
    const service = makeService(prisma);

    const baseStops = [
      {
        sequence: 1,
        stopType: 'PICKUP' as const,
        lat: -37.8,
        lng: 144.9,
        suburb: 'Melbourne',
        state: 'XX',
        postcode: '3000',
        addressLine: '1 St',
      },
      {
        sequence: 2,
        stopType: 'DROPOFF' as const,
        lat: -37.9,
        lng: 145.0,
        suburb: 'Richmond',
        state: 'VIC',
        postcode: '3121',
        addressLine: '2 St',
      },
    ];

    await expect(
      service.createJob(sender, {
        title: 'J',
        pricingModel: 'PER_KM',
        deadWeightKg: 100,
        lengthCm: 100,
        widthCm: 100,
        heightCm: 100,
        loadTypes: ['GENERAL'],
        siteDisclaimerAccepted: false,
        receiverName: 'R',
        receiverEmail: 'recv@yopmail.com',
        stops: baseStops,
      } as never),
    ).rejects.toThrow('Site access disclaimer must be accepted');

    await expect(
      service.createJob(sender, {
        title: 'J',
        pricingModel: 'PER_KM',
        deadWeightKg: 100,
        lengthCm: 100,
        widthCm: 100,
        heightCm: 100,
        distanceKm: 12,
        loadTypes: ['GENERAL'],
        siteDisclaimerAccepted: true,
        receiverName: '',
        receiverEmail: '',
        stops: baseStops,
      } as never),
    ).rejects.toThrow('Receiver name + email required');

    await expect(
      service.createJob(sender, {
        title: 'J',
        pricingModel: 'PER_KM',
        deadWeightKg: 100,
        lengthCm: 100,
        widthCm: 100,
        heightCm: 100,
        distanceKm: 12,
        loadTypes: ['GENERAL'],
        siteDisclaimerAccepted: true,
        receiverName: 'R',
        receiverEmail: 'recv@yopmail.com',
        minVehicleClass: 'UTE',
        stops: [
          ...baseStops,
          {
            sequence: 3,
            stopType: 'DROPOFF' as const,
            lat: -38.0,
            lng: 145.1,
            suburb: 'X',
            state: 'VIC',
            postcode: '3001',
            addressLine: '3 St',
          },
        ],
      } as never),
    ).rejects.toThrow('Each drop requires receiver name + email for multi-drop');

    try {
      await service.createJob(sender, {
        title: 'J',
        pricingModel: 'PER_KM',
        deadWeightKg: 20_000,
        lengthCm: 1200,
        widthCm: 240,
        heightCm: 240,
        distanceKm: 12,
        loadTypes: ['GENERAL'],
        siteDisclaimerAccepted: true,
        receiverName: 'R',
        receiverEmail: 'recv@yopmail.com',
        minVehicleClass: 'UTE',
        stops: baseStops,
      } as never);
      fail('expected VEHICLE_CLASS_UNDERSIZE');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'VEHICLE_CLASS_UNDERSIZE',
      });
    }
  });

  it('createJob keeps originTerritory null when region has no enabled territories', async () => {
    const created = {
      id: 'job-t',
      status: 'DRAFT',
      pricingModel: 'PER_KM',
      title: 'NoTerr',
      receiverName: 'R',
      receiverEmail: 'recv@yopmail.com',
      receiverPhone: null,
      pickupAt: null,
      deadWeightKg: 50,
      lengthCm: 50,
      widthCm: 50,
      heightCm: 50,
      chargeableWeightKg: 50,
      loadTypes: ['GENERAL'],
      requiresDg: false,
      requiresReefer: false,
      requiresOversize: false,
      minVehicleClass: 'UTE',
      recommendedVehicleClass: 'UTE',
      siteManeuverability: null,
      siteFacility: null,
      siteDisclaimerAcceptedAt: new Date(),
      hourlyPattern: null,
      routeDistanceKm: 10,
      routeDurationMinutes: 20,
      routeFatigueBreakMinutes: 0,
      billableHours: null,
      estimateExGstCents: 4545,
      estimateGstCents: 455,
      estimateIncGstCents: 5000,
      publishedAt: null,
      createdAt: new Date(),
      stops: [],
      proposals: [],
    };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          company: { id: 'co-s', homeRegionId: 'reg-vic' },
        }),
      },
      region: {
        findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }),
      },
      localTerritory: { findMany: jest.fn().mockResolvedValue([]) },
      policyVersion: { findFirst: jest.fn().mockResolvedValue(null) },
      job: { create: jest.fn().mockResolvedValue(created) },
    };
    const service = makeService(prisma);
    await service.createJob(sender, {
      title: 'NoTerr',
      pricingModel: 'PER_KM',
      deadWeightKg: 50,
      lengthCm: 50,
      widthCm: 50,
      heightCm: 50,
      distanceKm: 12,
      loadTypes: ['GENERAL'],
      siteDisclaimerAccepted: true,
      receiverName: 'R',
      receiverEmail: 'recv@yopmail.com',
      stops: [
        {
          sequence: 1,
          stopType: 'PICKUP',
          lat: -37.8,
          lng: 144.9,
          suburb: 'Melbourne',
          state: 'VIC',
          postcode: '3000',
          addressLine: '1 St',
        },
        {
          sequence: 2,
          stopType: 'DROPOFF',
          lat: -37.9,
          lng: 145.0,
          suburb: 'Richmond',
          state: 'VIC',
          postcode: '3121',
          addressLine: '2 St',
        },
      ],
    } as never);
    expect(prisma.job.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          originRegionId: 'reg-vic',
          originTerritoryId: null,
        }),
      }),
    );
  });

  it('createJob HOURLY with null origin region still creates', async () => {
    const created = {
      id: 'job-h',
      status: 'DRAFT',
      pricingModel: 'HOURLY',
      title: 'Hourly',
      receiverName: 'R',
      receiverEmail: 'recv@yopmail.com',
      receiverPhone: null,
      pickupAt: null,
      deadWeightKg: 50,
      lengthCm: 50,
      widthCm: 50,
      heightCm: 50,
      chargeableWeightKg: 50,
      loadTypes: ['GENERAL'],
      requiresDg: false,
      requiresReefer: false,
      requiresOversize: false,
      minVehicleClass: 'UTE',
      recommendedVehicleClass: 'UTE',
      siteManeuverability: null,
      siteFacility: null,
      siteDisclaimerAcceptedAt: new Date(),
      hourlyPattern: null,
      routeDistanceKm: 0,
      routeDurationMinutes: 240,
      routeFatigueBreakMinutes: 0,
      billableHours: 4,
      estimateExGstCents: 29091,
      estimateGstCents: 2909,
      estimateIncGstCents: 32000,
      publishedAt: null,
      createdAt: new Date(),
      stops: [],
      proposals: [],
    };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          company: { id: 'co-s', homeRegionId: null },
        }),
      },
      region: { findUnique: jest.fn().mockResolvedValue(null) },
      localTerritory: { findMany: jest.fn() },
      policyVersion: { findFirst: jest.fn().mockResolvedValue(null) },
      job: { create: jest.fn().mockResolvedValue(created) },
    };
    const service = makeService(prisma);
    const result = await service.createJob(sender, {
      title: 'Hourly',
      pricingModel: 'HOURLY',
      deadWeightKg: 50,
      lengthCm: 50,
      widthCm: 50,
      heightCm: 50,
      distanceKm: 12,
      loadTypes: ['GENERAL'],
      siteDisclaimerAccepted: true,
      receiverName: 'R',
      receiverEmail: 'recv@yopmail.com',
      stops: [
        {
          sequence: 1,
          stopType: 'PICKUP',
          lat: -37.8,
          lng: 144.9,
          suburb: 'Melbourne',
          state: 'ZZ',
          postcode: '3000',
          addressLine: '1 St',
        },
        {
          sequence: 2,
          stopType: 'DROPOFF',
          lat: -37.9,
          lng: 145.0,
          suburb: 'Richmond',
          state: 'ZZ',
          postcode: '3121',
          addressLine: '2 St',
        },
      ],
    } as never);
    expect(result.id).toBe('job-h');
    expect(prisma.job.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          originRegionId: null,
          originTerritoryId: null,
          pricingModel: 'HOURLY',
        }),
      }),
    );
  });
});
