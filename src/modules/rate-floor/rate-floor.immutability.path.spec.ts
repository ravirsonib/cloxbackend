import { BadRequestException } from '@nestjs/common';
import { RateFloorVersionStatus } from '@prisma/client';
import { DEFAULT_LABOUR_MULTIPLIERS } from './rate-floor.defaults';
import { RateFloorService } from './rate-floor.service';

const fullLabour = DEFAULT_LABOUR_MULTIPLIERS.map((m, i) => ({
  id: `m${i}`,
  periodCode: m.periodCode,
  multiplier: m.multiplier,
}));

describe('RateFloorService immutability guards (W3.5)', () => {
  it('updateDraftLine rejects PUBLISHED versions (app gate before DB trigger)', async () => {
    const prisma = {
      rateFloorVersion: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ver-1',
          status: RateFloorVersionStatus.PUBLISHED,
          approvalSubmittedAt: null,
          lines: [{ id: 'line-1', vehicleClassCode: 'SEMI' }],
          labourMultipliers: fullLabour,
          bodyLoadings: [{ id: 'b1', bodyCode: 'DRY', loadingPct: 0, minHours: null }],
        }),
      },
    };
    const service = new RateFloorService(prisma as never);
    await expect(
      service.updateDraftLine('ver-1', 'SEMI', { hourlyFloorCents: 9999 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updateDraftBodyLoading rejects when approval pending', async () => {
    const prisma = {
      rateFloorVersion: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ver-1',
          status: RateFloorVersionStatus.DRAFT,
          approvalSubmittedAt: new Date(),
          lines: [],
          labourMultipliers: fullLabour,
          bodyLoadings: [{ id: 'b1', bodyCode: 'REEFER', loadingPct: 20, minHours: null }],
        }),
      },
      rateFloorLabourMultiplier: { createMany: jest.fn() },
      rateFloorBodyLoading: { count: jest.fn().mockResolvedValue(1), createMany: jest.fn() },
    };
    const service = new RateFloorService(prisma as never);
    await expect(
      service.updateDraftBodyLoading('ver-1', 'REEFER', { loadingPct: 25 }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'RATE_FLOOR_PENDING_APPROVAL' }),
    });
  });

  it('ensureLabourMultipliers is not invoked for PUBLISHED getVersion reload path', async () => {
    const createMany = jest.fn();
    const prisma = {
      rateFloorVersion: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ver-pub',
          status: RateFloorVersionStatus.PUBLISHED,
          approvalSubmittedAt: null,
          lines: [],
          labourMultipliers: [],
          bodyLoadings: [],
        }),
      },
      rateFloorLabourMultiplier: { createMany },
      rateFloorBodyLoading: { count: jest.fn(), createMany: jest.fn() },
    };
    const service = new RateFloorService(prisma as never);
    await service.getVersion('ver-pub');
    expect(createMany).not.toHaveBeenCalled();
  });
});
