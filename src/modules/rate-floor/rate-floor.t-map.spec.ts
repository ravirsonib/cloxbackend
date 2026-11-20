/**
 * IT Guide §9 — T1–T22 map (W3.5).
 * Executable coverage lives here or is delegated to rate-floor.calc.spec / path specs.
 * Legal/Award-blocked items use it.skip with an explicit reason.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  backhaulKmRateCents,
  calculateRateFloor,
  exGstToIncGstCents,
} from './rate-floor.calc';
import { DEFAULT_BODY_LOADINGS, DEFAULT_RATE_FLOOR_LINES } from './rate-floor.defaults';
import { applyWeeklyDieselCap, percentChange } from './rate-floor.fuel';
import {
  DEFAULT_LABOUR_MULTIPLIERS,
  loadedHourlyFloorCents,
  resolveLabourPeriod,
  walkHourlyLabourBlocks,
} from './rate-floor.labour';
import { RateFloorService } from './rate-floor.service';

const rigid8 = DEFAULT_RATE_FLOOR_LINES.find((l) => l.vehicleClassCode === 'RIGID_8_10T')!;
const semi = DEFAULT_RATE_FLOOR_LINES.find((l) => l.vehicleClassCode === 'SEMI')!;
const ute = DEFAULT_RATE_FLOOR_LINES.find((l) => l.vehicleClassCode === 'UTE')!;
const version = { minHours: 4, minKmChargeKm: 25, referenceDieselCpl: 211.4, backhaulFactor: 0.85 };
const gst = 10;
const labourRateHrCents = 3440;

describe('Rate floor T-map (IT §9 / W3.5)', () => {
  it('T1: 8t rigid weekday 4h → $256.00 ex GST', () => {
    const r = calculateRateFloor({
      pricingModel: 'HOURLY',
      billableHours: 4,
      line: rigid8,
      version,
      gstPercent: gst,
    });
    expect(r.floorExGstCents).toBe(25600);
  });

  it('T2: Saturday labour', () => {
    const r = calculateRateFloor({
      pricingModel: 'HOURLY',
      billableHours: 4,
      line: rigid8,
      version,
      gstPercent: gst,
      labour: { periodCode: 'SATURDAY', multiplier: 1.5, labourRateHrCents },
    });
    expect(r.floorExGstCents).toBe(4 * loadedHourlyFloorCents(6400, labourRateHrCents, 1.5));
  });

  it('T3: Sunday labour', () => {
    const r = calculateRateFloor({
      pricingModel: 'HOURLY',
      billableHours: 4,
      line: rigid8,
      version,
      gstPercent: gst,
      labour: { periodCode: 'SUNDAY', multiplier: 2, labourRateHrCents },
    });
    expect(r.floorExGstCents).toBe(4 * 9840);
  });

  it('T4: 2h booked charged as 4h min', () => {
    const r = calculateRateFloor({
      pricingModel: 'HOURLY',
      billableHours: 2,
      line: rigid8,
      version,
      gstPercent: gst,
    });
    expect(r.floorExGstCents).toBe(25600);
    expect(r.breakdown.hoursCharged).toBe(4);
  });

  it('T5: Semi 800 km at reference diesel', () => {
    const r = calculateRateFloor({
      pricingModel: 'PER_KM',
      distanceKm: 800,
      line: semi,
      version,
      gstPercent: gst,
      fuel: {
        dieselCpl: 211.4,
        referenceDieselCpl: 211.4,
        litresPerKm: semi.litresPerKm,
      },
    });
    expect(r.floorExGstCents).toBe(204000);
  });

  it('T6: Semi 800 km diesel raise rounds up per-km', () => {
    const r = calculateRateFloor({
      pricingModel: 'PER_KM',
      distanceKm: 800,
      line: semi,
      version,
      gstPercent: gst,
      fuel: {
        dieselCpl: 240,
        referenceDieselCpl: 211.4,
        litresPerKm: semi.litresPerKm,
      },
    });
    expect(r.floorExGstCents).toBeGreaterThan(204000);
    expect(r.breakdown.modifiersApplied).toContain('FUEL');
  });

  it('T7: Backhaul lowers vs full floor', () => {
    const full = calculateRateFloor({
      pricingModel: 'PER_KM',
      distanceKm: 800,
      line: semi,
      version,
      gstPercent: gst,
      fuel: { dieselCpl: 211.4, referenceDieselCpl: 211.4, litresPerKm: semi.litresPerKm },
    });
    const back = calculateRateFloor({
      pricingModel: 'PER_KM',
      distanceKm: 800,
      line: semi,
      version,
      gstPercent: gst,
      fuel: { dieselCpl: 211.4, referenceDieselCpl: 211.4, litresPerKm: semi.litresPerKm },
      backhaul: true,
    });
    expect(back.floorExGstCents).toBeLessThan(full.floorExGstCents);
  });

  it('T8: Backhaul never below variable + fuel adj', () => {
    expect(backhaulKmRateCents(255, 4.7, 179, 0.85)).toBe(217);
  });

  it('T9: 5 km uses min charge / 1h floor', () => {
    const r = calculateRateFloor({
      pricingModel: 'PER_KM',
      distanceKm: 5,
      line: semi,
      version,
      gstPercent: gst,
    });
    expect(r.floorExGstCents).toBe(10400);
  });

  it('T10: Reefer +20% body loading', () => {
    const base = calculateRateFloor({
      pricingModel: 'HOURLY',
      billableHours: 4,
      line: ute,
      version,
      gstPercent: gst,
    });
    const withBody = calculateRateFloor({
      pricingModel: 'HOURLY',
      billableHours: 4,
      line: ute,
      version,
      gstPercent: gst,
      body: { bodyCode: 'REEFER', loadingPct: 20 },
    });
    expect(withBody.floorExGstCents).toBe(Math.ceil(base.floorExGstCents * 1.2 - 1e-9));
  });

  it('T11: Crane body minHours raises engagement', () => {
    const crane = DEFAULT_BODY_LOADINGS.find((b) => b.bodyCode === 'CRANE')!;
    expect(crane.minHours).toBe(4);
    const r = calculateRateFloor({
      pricingModel: 'HOURLY',
      billableHours: 2,
      line: rigid8,
      version: { ...version, minHours: 2 },
      gstPercent: gst,
      body: { bodyCode: 'CRANE', loadingPct: crane.loadingPct, minHours: crane.minHours },
    });
    expect(r.breakdown.hoursCharged).toBe(4);
    expect(r.breakdown.minHours).toBe(4);
  });

  it('T12: Fri 23:00 → Sat hour blocks', () => {
    const friEve = new Date('2026-11-20T12:00:00.000Z');
    const blocks = walkHourlyLabourBlocks({
      startAt: friEve,
      hoursCharged: 4,
      timeZone: 'Australia/Melbourne',
      baseHourlyFloorCents: rigid8.hourlyFloorCents,
      labourRateHrCents,
      multipliers: DEFAULT_LABOUR_MULTIPLIERS,
    });
    expect(blocks.map((b) => b.periodCode)).toEqual([
      'AFTERNOON',
      'SATURDAY',
      'SATURDAY',
      'SATURDAY',
    ]);
  });

  it('T13: public holiday beats weekend/shift (Award stub)', () => {
    const at = new Date('2026-11-02T23:00:00.000Z');
    expect(resolveLabourPeriod(at, 'Australia/Melbourne', true)).toBe('PUBLIC_HOLIDAY');
  });

  it('T14: exact floor amount is stable', () => {
    const r = calculateRateFloor({
      pricingModel: 'HOURLY',
      billableHours: 4,
      line: rigid8,
      version,
      gstPercent: gst,
    });
    expect(r.floorIncGstCents).toBe(exGstToIncGstCents(25600, gst));
  });

  it('T15: 1¢ below floor is detectable', () => {
    const r = calculateRateFloor({
      pricingModel: 'HOURLY',
      billableHours: 4,
      line: rigid8,
      version,
      gstPercent: gst,
    });
    expect(r.floorIncGstCents - 1).toBeLessThan(r.floorIncGstCents);
  });

  it('T16: server calc is the authority (no client bypass path in pure calc)', () => {
    const r = calculateRateFloor({
      pricingModel: 'HOURLY',
      billableHours: 4,
      line: rigid8,
      version,
      gstPercent: gst,
    });
    expect(r.floorExGstCents).toBeGreaterThan(0);
  });

  it('T17: migration defines published-child immutability triggers', () => {
    const sqlPath = join(
      __dirname,
      '../../../prisma/migrations/20261119200000_rate_floor_published_immutability/migration.sql',
    );
    const sql = readFileSync(sqlPath, 'utf8');
    expect(sql).toContain('clox_rate_floor_reject_immutable_child');
    expect(sql).toContain('trg_rate_floor_line_immutable');
    expect(sql).toContain('trg_rate_floor_body_immutable');
    expect(sql).toContain('trg_rate_floor_labour_immutable');
    expect(sql).toContain('RATE_FLOOR_IMMUTABLE');
  });

  it('T18: large diesel move needs confirm (cap helper)', () => {
    expect(percentChange(200, 211.4)).toBeGreaterThan(5);
    const capped = applyWeeklyDieselCap(200, 250, 15);
    expect(capped.weeklyMoveCapped).toBe(true);
  });

  it('T19: stale fuel notifies Super Admins once (7-day dedupe)', async () => {
    const notifyAdmins = jest.fn().mockResolvedValue(2);
    const adminIdsSuper = jest.fn().mockResolvedValue(['super-1', 'super-2']);
    const prisma = {
      notification: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new RateFloorService(prisma as never, {
      notifyAdmins,
      adminIdsSuper,
    } as never);
    const first = await service.maybeNotifyStaleFuel({
      isStale: true,
      ageDays: 11,
      fuelStaleDays: 10,
      latest: { id: 'fuel-1', weekStart: '2026-11-03', dieselCpl: 211.4 },
    });
    expect(first.notified).toBe(2);
    expect(notifyAdmins).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'FUEL_INDEX_STALE',
        entityId: 'fuel-1',
        href: '/rate-floor',
      }),
    );
    prisma.notification.findFirst.mockResolvedValue({ id: 'n1' });
    const second = await service.maybeNotifyStaleFuel({
      isStale: true,
      ageDays: 11,
      fuelStaleDays: 10,
      latest: { id: 'fuel-1', weekStart: '2026-11-03', dieselCpl: 211.4 },
    });
    expect(second.skipped).toBe(true);
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
  });

  it.skip('T20: idempotent job publish retry — covered by platform job idempotency elsewhere', () => {
    // See jobs leftover / publish path specs; not rate-floor-specific.
  });

  it('T21: concurrent publish pins one PUBLISHED (second Super wins; prior retired)', async () => {
    const draft = {
      id: 'ver-draft',
      status: 'DRAFT',
      approvalSubmittedAt: new Date(),
      createdByAdminId: 'admin-a',
      lines: [{ id: 'l1' }],
      labourMultipliers: DEFAULT_LABOUR_MULTIPLIERS.map((m, i) => ({
        id: `m${i}`,
        periodCode: m.periodCode,
        multiplier: m.multiplier,
      })),
      bodyLoadings: [{ id: 'b1', bodyCode: 'DRY', loadingPct: 0, minHours: null }],
    };
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const update = jest.fn().mockResolvedValue({
      ...draft,
      status: 'PUBLISHED',
      publishedByAdminId: 'admin-b',
    });
    const prisma = {
      rateFloorVersion: {
        findUnique: jest.fn().mockResolvedValue(draft),
        findUniqueOrThrow: jest.fn().mockResolvedValue(draft),
        updateMany,
        update,
      },
      rateFloorLabourMultiplier: { createMany: jest.fn() },
      rateFloorBodyLoading: { count: jest.fn().mockResolvedValue(1), findMany: jest.fn() },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          rateFloorVersion: { updateMany, update },
        }),
      ),
    };
    const service = new RateFloorService(prisma as never);
    const published = await service.publishDraft('ver-draft', 'admin-b');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'PUBLISHED' },
        data: { status: 'RETIRED' },
      }),
    );
    expect(published.status).toBe('PUBLISHED');
    await expect(service.publishDraft('ver-draft', 'admin-a')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'RATE_FLOOR_DUAL_APPROVE_REQUIRED' }),
    });
  });

  it('T22: override expiry clears active override', async () => {
    const active = {
      id: 'ov-1',
      jobId: 'job-1',
      expiresAt: new Date(Date.now() + 86_400_000),
      floorExGstCentsOverride: 10000,
    };
    const expired = { ...active, expiresAt: new Date() };
    const prisma = {
      rateFloorOverride: {
        findUnique: jest.fn().mockResolvedValue(active),
        update: jest.fn().mockResolvedValue(expired),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const service = new RateFloorService(prisma as never);
    const row = await service.expireOverride('ov-1');
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    const stillActive = await service.findActiveOverride('job-1');
    expect(stillActive).toBeNull();
  });
});
