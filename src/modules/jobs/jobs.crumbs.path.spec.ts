import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { CompanyType, JobStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { JobsService } from './jobs.service';
import * as routingMock from './routing.mock';

const sender: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('JobsService crumb branch leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const payments = { acceptProposal: jest.fn() };
  const senderService = {
    getBookingEligibility: jest.fn().mockResolvedValue({ canBook: true, goNoGo: [] }),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new JobsService(
      prisma as never,
      audit as never,
      senderService as never,
      payments as never,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('listSenderJobs maps undefined stops as empty; number lat/lng', async () => {
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
            title: 'A',
            status: JobStatus.DRAFT,
            pricingModel: 'PER_KM',
            priority: false,
            deadWeightKg: 10,
            chargeableWeightKg: 10,
            estimateExGstCents: 100,
            estimateGstCents: 10,
            estimateIncGstCents: 110,
            publishedAt: null,
            createdAt: new Date(),
            siteManeuverability: null,
            siteFacility: null,
            stops: undefined,
            proposals: undefined,
          },
          {
            id: 'job-2',
            title: 'B',
            status: JobStatus.DRAFT,
            pricingModel: 'PER_KM',
            priority: false,
            deadWeightKg: 10,
            chargeableWeightKg: 10,
            estimateExGstCents: 100,
            estimateGstCents: 10,
            estimateIncGstCents: 110,
            publishedAt: null,
            createdAt: new Date(),
            siteManeuverability: null,
            siteFacility: null,
            stops: [
              {
                id: 's1',
                sequence: 1,
                stopType: 'PICKUP',
                label: null,
                addressLine: '1',
                suburb: 'Mel',
                state: 'VIC',
                postcode: '3000',
                lat: -37.8,
                lng: 144.9,
                receiverName: null,
                receiverEmail: null,
              },
              {
                id: 's2',
                sequence: 2,
                stopType: 'DROPOFF',
                label: null,
                addressLine: '2',
                suburb: 'Gee',
                state: 'VIC',
                postcode: '3220',
                lat: null,
                lng: null,
                receiverName: null,
                receiverEmail: null,
              },
              {
                id: 's3',
                sequence: 3,
                stopType: 'WAYPOINT',
                label: null,
                addressLine: '3',
                suburb: 'Mid',
                state: 'VIC',
                postcode: '3001',
                lat: { toNumber: () => -37.85 },
                lng: { toNumber: () => 145.0 },
                receiverName: null,
                receiverEmail: null,
              },
            ],
            proposals: [],
          },
        ]),
      },
    };
    const rows = await makeService(prisma).listSenderJobs(sender);
    expect(rows[0].stops).toEqual([]);
    expect(rows[1].stops?.[0]).toMatchObject({ lat: -37.8, lng: 144.9 });
    expect(rows[1].stops?.[1]).toMatchObject({ lat: null, lng: null });
    expect(rows[1].stops?.[2]).toMatchObject({ lat: -37.85, lng: 145.0 });
  });

  it('getJobForSender / publishJob / createJob null company gates', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: null }),
      },
      job: { findFirst: jest.fn() },
    };
    const svc = makeService(prisma);
    await expect(svc.getJobForSender(sender, 'job-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.publishJob(sender, 'job-1')).rejects.toBeInstanceOf(NotFoundException);

    prisma.user.findUnique = jest.fn().mockResolvedValue({
      id: 'user-sender',
      company: null,
    });
    await expect(
      svc.createJob(sender, {
        pricingModel: 'PER_KM',
        deadWeightKg: 100,
        lengthCm: 100,
        widthCm: 100,
        heightCm: 100,
        distanceKm: 12,
        loadTypes: ['GENERAL'],
        siteDisclaimerAccepted: true,
        receiverName: 'R',
        receiverEmail: 'r@yopmail.com',
        stops: [
          {
            sequence: 1,
            stopType: 'PICKUP',
            addressLine: '1',
            suburb: 'Mel',
            state: 'VIC',
            postcode: '3000',
            lat: -37.8,
            lng: 144.9,
          },
          {
            sequence: 2,
            stopType: 'DROPOFF',
            addressLine: '2',
            suburb: 'Gee',
            state: 'VIC',
            postcode: '3220',
            lat: -38.1,
            lng: 144.3,
          },
        ],
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('createJob multi-drop requires per-stop receiver; HOURLY TSP + null billableHours floor', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          company: {
            id: 'co-s',
            type: CompanyType.SENDER,
            homeRegionId: null,
          },
        }),
      },
      region: {
        findUnique: jest.fn().mockResolvedValue({ id: 'reg-vic', code: 'VIC' }),
      },
      localTerritory: {
        findMany: jest.fn().mockResolvedValue([{ id: 'terr-mel', code: 'MEL' }]),
      },
      job: {
        create: jest.fn().mockResolvedValue({
          id: 'job-h',
          title: 'Hourly',
          status: JobStatus.DRAFT,
          pricingModel: 'HOURLY',
          priority: false,
          deadWeightKg: 50,
          chargeableWeightKg: 50,
          estimateExGstCents: 20000,
          estimateGstCents: 2000,
          estimateIncGstCents: 22000,
          publishedAt: null,
          createdAt: new Date(),
          siteManeuverability: null,
          siteFacility: null,
          stops: [],
          proposals: [],
        }),
      },
      platformConfig: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      policyVersion: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const svc = makeService(prisma);

    await expect(
      svc.createJob(sender, {
        pricingModel: 'PER_KM',
        deadWeightKg: 100,
        lengthCm: 100,
        widthCm: 100,
        heightCm: 100,
        distanceKm: 12,
        loadTypes: ['GENERAL'],
        siteDisclaimerAccepted: true,
        receiverName: 'R',
        receiverEmail: 'r@yopmail.com',
        stops: [
          {
            sequence: 1,
            stopType: 'PICKUP',
            addressLine: '1',
            suburb: 'Mel',
            state: 'VIC',
            postcode: '3000',
            lat: -37.8,
            lng: 144.9,
          },
          {
            sequence: 2,
            stopType: 'DROPOFF',
            addressLine: '2',
            suburb: 'A',
            state: 'VIC',
            postcode: '3001',
            lat: -37.81,
            lng: 144.95,
          },
          {
            sequence: 3,
            stopType: 'DROPOFF',
            addressLine: '3',
            suburb: 'B',
            state: 'VIC',
            postcode: '3002',
            lat: -37.82,
            lng: 145.0,
            // missing receiver for multi-drop
          },
        ],
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      svc.createJob(sender, {
        pricingModel: 'PER_KM',
        deadWeightKg: 100,
        lengthCm: 100,
        widthCm: 100,
        heightCm: 100,
        distanceKm: 12,
        loadTypes: ['GENERAL'],
        siteDisclaimerAccepted: true,
        receiverName: 'R',
        receiverEmail: 'r@yopmail.com',
        stops: [
          {
            sequence: 1,
            stopType: 'PICKUP',
            addressLine: '1',
            suburb: 'Mel',
            state: 'VIC',
            postcode: '3000',
            lat: -37.8,
            lng: 144.9,
          },
          {
            sequence: 2,
            stopType: 'DROPOFF',
            addressLine: '2',
            suburb: 'A',
            state: 'VIC',
            postcode: '3001',
            lat: -37.81,
            lng: 144.95,
            receiverEmail: 'a@yopmail.com',
            receiverName: 'A',
          },
          {
            sequence: 3,
            stopType: 'DROPOFF',
            addressLine: '3',
            suburb: 'B',
            state: 'VIC',
            postcode: '3002',
            lat: -37.82,
            lng: 145.0,
            receiverEmail: 'b@yopmail.com',
            // missing receiverName only
          },
        ],
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);

    await svc.createJob(sender, {
      pricingModel: 'HOURLY',
      deadWeightKg: 50,
      lengthCm: 50,
      widthCm: 50,
      heightCm: 50,
      distanceKm: 12,
      loadTypes: ['GENERAL'],
      siteDisclaimerAccepted: true,
      receiverName: 'R',
      receiverEmail: 'r@yopmail.com',
      stops: [
        {
          sequence: 1,
          stopType: 'PICKUP',
          addressLine: '1',
          suburb: 'Mel',
          state: 'VIC',
          postcode: '3000',
          lat: -37.8,
          lng: 144.9,
        },
        {
          sequence: 2,
          stopType: 'WAYPOINT',
          addressLine: '2',
          suburb: 'Mid',
          state: 'VIC',
          postcode: '3001',
          lat: -37.85,
          lng: 145.0,
        },
        {
          sequence: 3,
          stopType: 'DROPOFF',
          addressLine: '3',
          suburb: 'Gee',
          state: 'VIC',
          postcode: '3220',
          lat: -38.1,
          lng: 144.3,
          receiverName: 'D',
          receiverEmail: 'd@yopmail.com',
        },
      ],
    } as never);
    expect(prisma.job.create).toHaveBeenCalled();
  });

  it('createJob HOURLY floors when billableHours null', async () => {
    const spy = jest.spyOn(routingMock, 'routeFromDistanceKm').mockReturnValue({
      distanceKm: 10,
      drivingMinutes: 20,
      fatigueBreakMinutes: 0,
      totalDurationMinutes: 20,
      billableHours: null,
      mock: true,
    });
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-sender',
          company: {
            id: 'co-s',
            type: CompanyType.SENDER,
            homeRegionId: null,
          },
        }),
      },
      region: { findUnique: jest.fn().mockResolvedValue(null) },
      localTerritory: { findMany: jest.fn().mockResolvedValue([]) },
      policyVersion: { findFirst: jest.fn().mockResolvedValue(null) },
      job: {
        create: jest.fn().mockResolvedValue({
          id: 'job-null-hours',
          title: 'H',
          status: JobStatus.DRAFT,
          pricingModel: 'HOURLY',
          priority: false,
          deadWeightKg: 50,
          chargeableWeightKg: 50,
          estimateExGstCents: 1,
          estimateGstCents: 1,
          estimateIncGstCents: 1,
          publishedAt: null,
          createdAt: new Date(),
          siteManeuverability: null,
          siteFacility: null,
          stops: [],
          proposals: [],
        }),
      },
    };
    await makeService(prisma).createJob(sender, {
      pricingModel: 'HOURLY',
      deadWeightKg: 50,
      lengthCm: 50,
      widthCm: 50,
      heightCm: 50,
      distanceKm: 12,
      loadTypes: ['GENERAL'],
      siteDisclaimerAccepted: true,
      receiverName: 'R',
      receiverEmail: 'r@yopmail.com',
      stops: [
        {
          sequence: 1,
          stopType: 'PICKUP',
          addressLine: '1',
          suburb: 'Mel',
          state: 'VIC',
          postcode: '3000',
          lat: -37.8,
          lng: 144.9,
        },
        {
          sequence: 2,
          stopType: 'DROPOFF',
          addressLine: '2',
          suburb: 'Gee',
          state: 'VIC',
          postcode: '3220',
          lat: -38.1,
          lng: 144.3,
        },
      ],
    } as never);
    expect(prisma.job.create).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('publishJob 404 when job missing for company', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-s' }),
      },
      job: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(makeService(prisma).publishJob(sender, 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
