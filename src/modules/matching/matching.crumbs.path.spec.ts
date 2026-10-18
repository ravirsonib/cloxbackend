import { BadRequestException } from '@nestjs/common';
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

describe('MatchingService crumb branch leftovers', () => {
  it('listBoard: null homeRegion + null suburb; submitProposal missing driver + null licenceClass', async () => {
    const company = {
      id: 'co-carrier',
      type: CompanyType.CARRIER,
      status: CompanyStatus.BID_ELIGIBLE,
      capabilities: [] as string[],
      serviceRegionCodes: ['VIC'],
      homeRegion: null,
      vehicles: [{ vehicleClass: 'SEMI', status: VehicleStatus.ACTIVE }],
      drivers: [],
    };
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-carrier', company }),
      },
      job: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'job-1',
            title: 'Haul',
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
            pickupAt: new Date(),
            publishedAt: new Date(),
            originRegion: { code: 'VIC' },
            stops: [
              { stopType: 'PICKUP', suburb: null },
              { stopType: 'DROPOFF', suburb: 'Geelong' },
            ],
            proposals: [],
          },
        ]),
      },
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'veh-1',
          vehicleClass: 'SEMI',
          status: VehicleStatus.ACTIVE,
        }),
      },
      driver: { findFirst: jest.fn().mockResolvedValue(null) },
      proposal: { findFirst: jest.fn(), create: jest.fn() },
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

    const board = await service.listBoard(carrierPrincipal);
    expect(board.jobs[0].stopsSummary).toBe('PICKUP: → DROPOFF:Geelong');

    await expect(
      service.submitProposal(carrierPrincipal, {
        jobId: 'job-1',
        vehicleId: 'veh-1',
        driverId: 'missing',
        amountIncGstCents: 50_000,
        etaMinutes: 60,
      }),
    ).rejects.toThrow('Active driver required');

    prisma.driver.findFirst.mockResolvedValue({
      id: 'drv-1',
      status: DriverStatus.ACTIVE,
      licenceClass: null,
      licenceExpiry: new Date('2030-01-01T00:00:00.000Z'),
      nhvrAcknowledgedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    try {
      await service.submitProposal(carrierPrincipal, {
        jobId: 'job-1',
        vehicleId: 'veh-1',
        driverId: 'drv-1',
        amountIncGstCents: 50_000,
        etaMinutes: 60,
      });
      fail('expected LICENCE_CLASS_MISMATCH');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'LICENCE_CLASS_MISMATCH',
        message: expect.stringContaining('none'),
      });
    }
  });
});
