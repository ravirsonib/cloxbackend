import { BadRequestException } from '@nestjs/common';
import { JobStatus } from '@prisma/client';
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

describe('JobsService.publishJob floor re-check (W3.2)', () => {
  const audit = { recordPlatform: jest.fn() };
  const senderService = {
    getBookingEligibility: jest.fn().mockResolvedValue({
      canPublishLive: true,
      canBook: true,
      goNoGo: {},
      blockers: [],
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function draftJob(overrides: Record<string, unknown> = {}) {
    return {
      id: 'job-1',
      status: JobStatus.DRAFT,
      pricingModel: 'PER_KM',
      title: 'Job',
      receiverName: 'R',
      receiverEmail: 'r@yopmail.com',
      pickupAt: new Date('2026-10-10T10:00:00.000Z'),
      siteDisclaimerAcceptedAt: new Date(),
      siteManeuverability: 'EASY',
      siteFacility: 'DOCK',
      requiresDg: false,
      requiresReefer: false,
      isBackhaul: false,
      minVehicleClass: 'SEMI',
      pricingVehicleClass: 'SEMI',
      recommendedVehicleClass: 'SEMI',
      routeDistanceKm: 800,
      billableHours: null,
      estimateIncGstCents: 200_000,
      estimateExGstCents: 181_818,
      estimateGstCents: 18_182,
      rateFloorVersionId: 'old-ver',
      rateFloorExGstCents: 100_000,
      rateFloorIncGstCents: 110_000,
      rateFloorBreakdown: null,
      stops: [{ stopType: 'PICKUP', state: 'VIC' }],
      originRegion: { enabled: true, code: 'VIC' },
      ...overrides,
    };
  }

  it('refreshes floor snapshot and records JOB_PUBLISH check when RateFloorService present', async () => {
    const draft = draftJob();
    const bidding = { ...draft, status: JobStatus.BIDDING, publishedAt: new Date(), stops: [] };
    const calculate = jest.fn().mockResolvedValue({
      versionId: 'ver-new',
      versionLabel: '2026-10',
      floorExGstCents: 181_818,
      floorIncGstCents: 200_000,
      breakdown: { fuelIndexId: 'fuel-1', dieselCpl: 211.4, mode: 'PER_KM' },
    });
    const recordCheck = jest.fn().mockResolvedValue({});
    const prisma = {
      isConnected: () => true,
      platformSettings: {
        findUnique: jest.fn().mockResolvedValue({ gstPercent: 10 }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-s' }),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue(draft),
        update: jest
          .fn()
          .mockResolvedValueOnce({ ...draft, status: JobStatus.PUBLISHED })
          .mockResolvedValueOnce(bidding),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      company: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const service = new JobsService(
      prisma as never,
      audit as never,
      senderService as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      { calculate, recordCheck } as never,
    );

    const result = await service.publishJob(sender, 'job-1');
    expect(result.status).toBe(JobStatus.BIDDING);
    expect(calculate).toHaveBeenCalled();
    expect(recordCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        result: 'PASS',
        inputs: expect.objectContaining({ source: 'JOB_PUBLISH' }),
      }),
    );
    expect(prisma.job.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rateFloorVersionId: 'ver-new',
          rateFloorIncGstCents: 200_000,
        }),
      }),
    );
  });

  it('rejects PRICE_BELOW_FLOOR when draft estimate is under refreshed floor', async () => {
    const draft = draftJob({ estimateIncGstCents: 150_000 });
    const calculate = jest.fn().mockResolvedValue({
      versionId: 'ver-new',
      versionLabel: '2026-10',
      floorExGstCents: 204_000,
      floorIncGstCents: 224_400,
      breakdown: { fuelIndexId: 'fuel-1', dieselCpl: 211.4, mode: 'PER_KM' },
    });
    const recordCheck = jest.fn().mockResolvedValue({});
    const prisma = {
      isConnected: () => true,
      platformSettings: {
        findUnique: jest.fn().mockResolvedValue({ gstPercent: 10 }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-sender', companyId: 'co-s' }),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue(draft),
        update: jest.fn(),
      },
    };

    const service = new JobsService(
      prisma as never,
      audit as never,
      senderService as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      { calculate, recordCheck } as never,
    );

    let caught: unknown;
    try {
      await service.publishJob(sender, 'job-1');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getResponse()).toEqual(
      expect.objectContaining({
        code: 'PRICE_BELOW_FLOOR',
        floorIncGstCents: 224_400,
      }),
    );
    expect(recordCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 'REJECT',
        inputs: expect.objectContaining({ source: 'JOB_PUBLISH' }),
      }),
    );
    expect(prisma.job.update).not.toHaveBeenCalled();
  });
});
