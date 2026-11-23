import { BadRequestException } from '@nestjs/common';
import { DriverStatus, JobStatus, VehicleStatus } from '@prisma/client';
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

function carrierUser() {
  return {
    id: 'user-carrier',
    companyId: 'co-c',
    company: {
      id: 'co-c',
      status: 'BID_ELIGIBLE',
      type: 'CARRIER',
      serviceRegionCodes: ['VIC'],
      capabilities: [],
      homeRegion: { code: 'VIC' },
      vehicles: [{ vehicleClass: 'UTE', status: VehicleStatus.ACTIVE }],
    },
  };
}

function stubJobsService(quoteIncGstCents = 100_000) {
  return {
    getMinBaseCents: jest.fn().mockResolvedValue(20_000),
    quoteForVehicleClass: jest.fn().mockResolvedValue({
      estimateIncGstCents: quoteIncGstCents,
      ratesClassCode: 'UTE',
      usedLegacyFallback: false,
    }),
  };
}

describe('MatchingService marketplace rescue', () => {
  it('listBoard exposes priority + discounted min bid', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(carrierUser()),
      },
      job: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'job-rescue',
            title: 'Rescue',
            status: JobStatus.BIDDING,
            pricingModel: 'PER_KM',
            minVehicleClass: 'UTE',
            requiresDg: false,
            requiresReefer: false,
            requiresOversize: false,
            chargeableWeightKg: 100,
            routeDistanceKm: 10,
            routeDurationMinutes: 20,
            routeFatigueBreakMinutes: 0,
            billableHours: null,
            estimateIncGstCents: 10_000,
            marketplacePriority: true,
            rescueDiscountPercent: 10,
            pickupAt: new Date(),
            publishedAt: new Date(),
            originRegion: { code: 'VIC' },
            stops: [{ stopType: 'PICKUP', suburb: 'Melbourne' }],
            proposals: [],
          },
        ]),
      },
    };

    const service = new MatchingService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { getBidEligibility: jest.fn().mockResolvedValue({ canBid: true, goNoGo: {} }) } as never,
      stubJobsService() as never,
    );

    const board = await service.listBoard(carrierPrincipal);
    expect(board.jobs[0]).toMatchObject({
      id: 'job-rescue',
      marketplacePriority: true,
      rescueDiscountPercent: 10,
      minBidIncGstCents: 9_000,
    });
    expect(prisma.job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ marketplacePriority: 'desc' }, { publishedAt: 'desc' }],
      }),
    );
  });

  it('submitProposal uses discounted estimate as floor on rescued jobs', async () => {
    const job = {
      id: 'job-1',
      status: JobStatus.BIDDING,
      pricingModel: 'PER_KM' as const,
      minVehicleClass: 'UTE',
      requiresDg: false,
      requiresReefer: false,
      requiresOversize: false,
      estimateIncGstCents: 10_000,
      rescueDiscountPercent: 10,
      marketplacePriority: true,
      originRegion: { code: 'VIC' },
    };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(carrierUser()),
      },
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'veh-1',
          vehicleClass: 'UTE',
          status: VehicleStatus.ACTIVE,
          combinationConfig: null,
          registration: 'TEST1',
          units: [],
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
      proposal: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      assignment: { findFirst: jest.fn().mockResolvedValue(null) },
      complianceDocument: {
        findFirst: jest.fn().mockResolvedValue({ id: 'doc-ok' }),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'rwc-ok',
            status: 'APPROVED',
            expiresAt: null,
            vehicleUnitId: null,
          },
        ]),
      },
      job: { update: jest.fn() },
    };
    const jobsService = {
      assertJobOpenForBidding: jest.fn().mockResolvedValue(job),
      getMinBaseCents: jest.fn().mockResolvedValue(5_000),
      quoteForVehicleClass: jest.fn().mockResolvedValue({
        estimateIncGstCents: 100_000,
        ratesClassCode: 'UTE',
        usedLegacyFallback: false,
      }),
      getActiveVehicleClasses: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MatchingService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { getBidEligibility: jest.fn().mockResolvedValue({ canBid: true, goNoGo: {} }) } as never,
      jobsService as never,
    );

    const input = {
      jobId: 'job-1',
      vehicleId: 'veh-1',
      driverId: 'drv-1',
      // Carrier types take-home net; ~6000 net → ~8571 gross, below rescue min base 9000.
      amountIncGstCents: 6_000,
      etaMinutes: 60,
    };

    try {
      await service.submitProposal(carrierPrincipal, input);
      fail('expected BID_BELOW_MIN_BASE');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'BID_BELOW_MIN_BASE',
        minBaseCents: 9_000,
      });
    }
  });
});
