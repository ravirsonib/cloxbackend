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

function carrierUser() {
  return {
    id: 'user-carrier',
    company: {
      id: 'co-carrier',
      type: CompanyType.CARRIER,
      status: CompanyStatus.BID_ELIGIBLE,
      capabilities: [],
      serviceRegionCodes: ['VIC'],
      homeRegion: { code: 'VIC' },
      vehicles: [{ vehicleClass: 'SEMI', status: VehicleStatus.ACTIVE }],
      drivers: [],
    },
  };
}

function openJob(overrides?: Partial<{ status: JobStatus; rateFloorIncGstCents: number | null }>) {
  return {
    id: 'job-1',
    status: overrides?.status ?? JobStatus.BIDDING,
    pricingModel: 'PER_KM' as const,
    minVehicleClass: 'SEMI',
    requiresDg: false,
    requiresReefer: false,
    requiresOversize: false,
    chargeableWeightKg: 1000,
    routeDistanceKm: 50,
    billableHours: null,
    estimateIncGstCents: 30_000,
    rescueDiscountPercent: null,
    rateFloorIncGstCents: overrides?.rateFloorIncGstCents ?? null,
    rateFloorExGstCents: null,
    rateFloorVersionId: null,
    rateFloorBreakdown: null,
    senderCompanyId: 'co-sender',
    pickupAt: new Date('2026-10-10T10:00:00.000Z'),
    originRegion: { code: 'VIC' },
    stops: [{ stopType: 'PICKUP', state: 'VIC', suburb: 'Melbourne' }],
  };
}

function buildHappyPathPrisma(opts?: {
  /** Same-job SUBMITTED row for this carrier (txn race re-check). */
  existingSubmitted?: { id: string } | null;
  onCreate?: () => void;
}) {
  const proposalStore = {
    existing: (opts?.existingSubmitted ?? null) as { id: string } | null,
    createCount: 0,
  };

  const proposal = {
    findFirst: jest.fn(async (args?: { where?: Record<string, unknown> }) => {
      const where = args?.where ?? {};
      // Crew open-bid checks filter by vehicleId/driverId — keep clear for happy path.
      if ('vehicleId' in where || 'driverId' in where) return null;
      // Duplicate re-check: jobId + carrierCompanyId + SUBMITTED
      if ('jobId' in where && 'carrierCompanyId' in where) {
        return proposalStore.existing;
      }
      return null;
    }),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      proposalStore.createCount += 1;
      opts?.onCreate?.();
      const created = { id: `prop-${proposalStore.createCount}`, ...data };
      proposalStore.existing = { id: created.id };
      return created;
    }),
  };

  const job = {
    update: jest.fn(),
    findUnique: jest.fn().mockResolvedValue({
      id: 'job-1',
      title: 'Job',
      senderCompanyId: 'co-sender',
    }),
  };
  // Serialize interactive transactions so findFirst→create cannot interleave
  // (mirrors a DB that holds the row lock for the txn duration).
  let txTail: Promise<unknown> = Promise.resolve();
  const prisma = {
    isConnected: () => true,
    user: { findUnique: jest.fn().mockResolvedValue(carrierUser()) },
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
    proposal,
    assignment: { findFirst: jest.fn().mockResolvedValue(null) },
    complianceDocument: {
      // Satisfies DRIVER_LICENCE + RWC gates (any truthy id).
      findFirst: jest.fn().mockResolvedValue({ id: 'doc-ok' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    platformSettings: {
      findUnique: jest.fn().mockResolvedValue({ gstPercent: 10 }),
    },
    job,
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => {
      const run = txTail.then(() => fn({ proposal, job }));
      txTail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }),
    _store: proposalStore,
  };

  return prisma;
}

function buildJobsService(job = openJob()) {
  return {
    assertJobOpenForBidding: jest.fn().mockResolvedValue(job),
    getMinBaseCents: jest.fn().mockResolvedValue(5_000),
    quoteForVehicleClass: jest.fn().mockResolvedValue({
      estimateIncGstCents: 5_000,
    }),
    getActiveVehicleClasses: jest.fn().mockResolvedValue([
      { code: 'SEMI', rank: 80, maxChargeableWeightKg: 42_000, minLicenceClass: 'HC' },
      { code: 'UTE', rank: 10, maxChargeableWeightKg: 1_000, minLicenceClass: 'C' },
    ]),
  };
}

describe('MatchingService race + NaN bid paths', () => {
  const baseInput = {
    jobId: 'job-1',
    vehicleId: 'veh-1',
    driverId: 'drv-1',
    amountIncGstCents: 20_000,
    etaMinutes: 45,
  };

  it('rejects NaN / 0 / negative / Infinity bid amounts as BID_AMOUNT_INVALID', async () => {
    for (const bad of [Number.NaN, 0, -100, Number.POSITIVE_INFINITY]) {
      const prisma = buildHappyPathPrisma();
      const service = new MatchingService(
        prisma as never,
        { recordPlatform: jest.fn() } as never,
        { getBidEligibility: jest.fn().mockResolvedValue({ canBid: true, goNoGo: {} }) } as never,
        buildJobsService() as never,
      );

      try {
        await service.submitProposal(carrierPrincipal, {
          ...baseInput,
          amountIncGstCents: bad,
        });
        fail(`expected BID_AMOUNT_INVALID for ${String(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: 'BID_AMOUNT_INVALID',
        });
      }
      expect(prisma.proposal.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    }
  });

  it('txn re-check rejects duplicate SUBMITTED bid (race shrink)', async () => {
    const prisma = buildHappyPathPrisma({
      existingSubmitted: { id: 'prop-old' },
    });
    const service = new MatchingService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { getBidEligibility: jest.fn().mockResolvedValue({ canBid: true, goNoGo: {} }) } as never,
      buildJobsService() as never,
    );

    try {
      await service.submitProposal(carrierPrincipal, baseInput);
      fail('expected BID_ALREADY_SUBMITTED');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'BID_ALREADY_SUBMITTED',
      });
    }
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.proposal.findFirst).toHaveBeenCalled();
    expect(prisma.proposal.create).not.toHaveBeenCalled();
  });

  it('serializes concurrent submits: second sees existing and fails', async () => {
    const prisma = buildHappyPathPrisma();
    const audit = { recordPlatform: jest.fn() };
    const service = new MatchingService(
      prisma as never,
      audit as never,
      { getBidEligibility: jest.fn().mockResolvedValue({ canBid: true, goNoGo: {} }) } as never,
      buildJobsService() as never,
    );

    // $transaction is async-serial for this mock: first create wins, second findFirst sees it.
    const results = await Promise.allSettled([
      service.submitProposal(carrierPrincipal, baseInput),
      service.submitProposal(carrierPrincipal, {
        ...baseInput,
        amountIncGstCents: 21_000,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].status).toBe('rejected');
    if (rejected[0].status === 'rejected') {
      expect(rejected[0].reason).toBeInstanceOf(BadRequestException);
      expect((rejected[0].reason as BadRequestException).getResponse()).toMatchObject({
        code: 'BID_ALREADY_SUBMITTED',
      });
    }
    expect(prisma._store.createCount).toBe(1);
  });

  it('happy path creates proposal with finite GST split from converted base', async () => {
    const prisma = buildHappyPathPrisma();
    const audit = { recordPlatform: jest.fn() };
    const service = new MatchingService(
      prisma as never,
      audit as never,
      { getBidEligibility: jest.fn().mockResolvedValue({ canBid: true, goNoGo: {} }) } as never,
      buildJobsService() as never,
    );

    const created = await service.submitProposal(carrierPrincipal, baseInput);
    expect(created.id).toMatch(/^prop-/);
    expect(prisma.proposal.create).toHaveBeenCalledTimes(1);
    const data = prisma.proposal.create.mock.calls[0][0].data as {
      amountIncGstCents: number;
      amountExGstCents: number;
      amountGstCents: number;
    };
    expect(Number.isFinite(data.amountIncGstCents)).toBe(true);
    expect(data.amountIncGstCents).toBeGreaterThan(0);
    expect(data.amountExGstCents + data.amountGstCents).toBe(data.amountIncGstCents);
    expect(audit.recordPlatform).toHaveBeenCalled();
  });

  it('fee-aware path still rejects non-finite target net', async () => {
    const prisma = buildHappyPathPrisma();
    const revenueSplit = {
      resolvePercents: jest.fn().mockResolvedValue({
        percents: { carrierPercent: 70 },
      }),
      resolveSenderFee: jest.fn().mockResolvedValue({
        feePercent: 2,
        mode: 'EXCLUSIVE',
      }),
    };
    const service = new MatchingService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      { getBidEligibility: jest.fn().mockResolvedValue({ canBid: true, goNoGo: {} }) } as never,
      buildJobsService() as never,
      undefined,
      undefined,
      revenueSplit as never,
    );

    await expect(
      service.submitProposal(carrierPrincipal, {
        ...baseInput,
        amountIncGstCents: Number.NaN,
      }),
    ).rejects.toMatchObject({
      response: { code: 'BID_AMOUNT_INVALID' },
    });
  });
});
