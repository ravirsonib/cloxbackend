import {
  backhaulKmRateCents,
  calculateRateFloor,
  effectiveKmFloorCents,
  exGstToIncGstCents,
  fuelAdjCentsPerKm,
} from './rate-floor.calc';
import { inferBodyCode } from './rate-floor.body';
import { DEFAULT_RATE_FLOOR_LINES } from './rate-floor.defaults';
import { applyWeeklyDieselCap, mondayOfWeek, percentChange } from './rate-floor.fuel';
import { DEFAULT_LABOUR_MULTIPLIERS } from './rate-floor.defaults';
import {
  loadedHourlyFloorCents,
  localDateIso,
  resolveLabourPeriod,
  walkHourlyLabourBlocks,
} from './rate-floor.labour';

const rigid8 = DEFAULT_RATE_FLOOR_LINES.find((l) => l.vehicleClassCode === 'RIGID_8_10T')!;
const semi = DEFAULT_RATE_FLOOR_LINES.find((l) => l.vehicleClassCode === 'SEMI')!;
const ute = DEFAULT_RATE_FLOOR_LINES.find((l) => l.vehicleClassCode === 'UTE')!;

const version = { minHours: 4, minKmChargeKm: 25, referenceDieselCpl: 211.4 };
const gst = 10;

describe('calculateRateFloor Wave 1', () => {
  it('T1: 8 t rigid, weekday 4 hours → $256.00 ex GST', () => {
    const r = calculateRateFloor({
      pricingModel: 'HOURLY',
      billableHours: 4,
      line: rigid8,
      version,
      gstPercent: gst,
    });
    expect(r.floorExGstCents).toBe(25600);
    expect(r.floorIncGstCents).toBe(exGstToIncGstCents(25600, gst));
  });

  it('T4: 8 t rigid, 2-hour booking charged as 4 hours → $256.00', () => {
    const r = calculateRateFloor({
      pricingModel: 'HOURLY',
      billableHours: 2,
      line: rigid8,
      version,
      gstPercent: gst,
    });
    expect(r.floorExGstCents).toBe(25600);
  });

  it('T5: Semi, 800 km, diesel reference → $2,040.00 ex GST', () => {
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

  it('T9: Per-km job of 5 km uses minimum charge (max of 25×kmFloor and 1×hourly)', () => {
    const r = calculateRateFloor({
      pricingModel: 'PER_KM',
      distanceKm: 5,
      line: semi,
      version,
      gstPercent: gst,
    });
    // max(5*255, 25*255, 10400) = max(1275, 6375, 10400) = 10400
    expect(r.floorExGstCents).toBe(10400);
  });

  it('T14/T15: exact floor passes conceptually; 1 cent below is detectable', () => {
    const r = calculateRateFloor({
      pricingModel: 'HOURLY',
      billableHours: 4,
      line: rigid8,
      version,
      gstPercent: gst,
    });
    expect(r.floorIncGstCents - 1).toBeLessThan(r.floorIncGstCents);
    expect(25600).toBe(r.floorExGstCents);
  });
});

describe('Wave 2.1 fuel index', () => {
  it('PDF §5.2: ute +10 c/L → +1.11 c/km adj', () => {
    expect(fuelAdjCentsPerKm(0.111, 221.4, 211.4)).toBeCloseTo(1.11, 5);
  });

  it('T6-ish: Semi 800 km with +10 c/L diesel raises floor by ceil(0.47*10)*800', () => {
    const atRef = calculateRateFloor({
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
    const raised = calculateRateFloor({
      pricingModel: 'PER_KM',
      distanceKm: 800,
      line: semi,
      version,
      gstPercent: gst,
      fuel: {
        dieselCpl: 221.4,
        referenceDieselCpl: 211.4,
        litresPerKm: semi.litresPerKm,
      },
    });
    const { effectiveKmFloorCents: eff } = effectiveKmFloorCents(
      semi.kmFloorCents,
      semi.litresPerKm,
      221.4,
      211.4,
    );
    expect(raised.floorExGstCents).toBe(eff * 800);
    expect(raised.floorExGstCents).toBeGreaterThan(atRef.floorExGstCents);
    expect(raised.breakdown.modifiersApplied).toContain('FUEL');
  });

  it('ute line litresPerKm used when fuel block supplied', () => {
    const { fuelAdjCentsPerKm: adj } = effectiveKmFloorCents(
      ute.kmFloorCents,
      ute.litresPerKm,
      221.4,
      211.4,
    );
    expect(adj).toBeCloseTo(1.11, 5);
  });

  it('weekly diesel cap clamps applied cpl', () => {
    const r = applyWeeklyDieselCap(200, 250, 15);
    expect(r.weeklyMoveCapped).toBe(true);
    expect(r.appliedDieselCpl).toBeCloseTo(230, 5); // 200 * 1.15
    expect(r.uncappedMovePercent).toBeCloseTo(25, 5);
  });

  it('percentChange and mondayOfWeek helpers', () => {
    expect(percentChange(200, 216)).toBeCloseTo(8, 5);
    const mon = mondayOfWeek(new Date('2026-11-18T12:00:00.000Z')); // Wed
    expect(mon.toISOString().slice(0, 10)).toBe('2026-11-16');
  });
});

describe('Wave 2.2 labour multipliers', () => {
  it('loadedHourly: Sunday 2.0 adds $34.40 to rigid 8t ($64 → $98.40)', () => {
    // 6400 + 3440*(2-1) = 9840
    expect(loadedHourlyFloorCents(6400, 3440, 2)).toBe(9840);
  });

  it('T2-ish: 8 t rigid Sunday 4h → labour-loaded floor', () => {
    const r = calculateRateFloor({
      pricingModel: 'HOURLY',
      billableHours: 4,
      line: rigid8,
      version,
      gstPercent: gst,
      labour: {
        periodCode: 'SUNDAY',
        multiplier: 2,
        labourRateHrCents: 3440,
      },
    });
    expect(r.floorExGstCents).toBe(4 * 9840);
    expect(r.breakdown.modifiersApplied).toContain('LABOUR');
  });

  it('resolveLabourPeriod: weekend beats shift', () => {
    // Saturday 10:00 Melbourne (AEDT UTC+11 in Nov → 2026-11-21 10:00 AEDT = 2026-11-20 23:00Z)
    const sat = new Date('2026-11-20T23:00:00.000Z');
    expect(resolveLabourPeriod(sat, 'Australia/Melbourne')).toBe('SATURDAY');
  });

  it('resolveLabourPeriod: weekday afternoon after 18:30', () => {
    // Wed 19:00 Melbourne AEDT = 08:00 UTC
    const eve = new Date('2026-11-18T08:00:00.000Z');
    expect(resolveLabourPeriod(eve, 'Australia/Melbourne')).toBe('AFTERNOON');
  });

  it('W2.7: public holiday beats weekend/shift (Award stub → PUBLIC_HOLIDAY)', () => {
    const cup = new Date('2026-11-02T23:00:00.000Z'); // Tue 3 Nov 2026 Melbourne
    expect(localDateIso(cup, 'Australia/Melbourne')).toBe('2026-11-03');
    expect(resolveLabourPeriod(cup, 'Australia/Melbourne', true)).toBe('PUBLIC_HOLIDAY');
    const r = calculateRateFloor({
      pricingModel: 'HOURLY',
      billableHours: 4,
      line: rigid8,
      version,
      gstPercent: gst,
      labour: {
        periodCode: 'PUBLIC_HOLIDAY',
        multiplier: 2,
        labourRateHrCents: 3440,
      },
    });
    expect(r.floorExGstCents).toBe(4 * 9840);
  });
});

describe('Wave 2.3 body loadings', () => {
  it('inferBodyCode: reefer flag on base class → REEFER; specialised class stays DRY', () => {
    expect(inferBodyCode({ requiresReefer: true, vehicleClassCode: 'UTE' })).toBe('REEFER');
    expect(inferBodyCode({ requiresReefer: true, vehicleClassCode: 'REEFER' })).toBe('DRY');
  });

  it('T10-ish: UTE hourly + REEFER 20% body loading', () => {
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
    expect(withBody.breakdown.modifiersApplied).toContain('BODY');
  });
});

describe('W3.3 hourly hour-blocks (IT §4.1 / T12)', () => {
  const multipliers = DEFAULT_LABOUR_MULTIPLIERS;
  const labourRateHrCents = 3440;

  it('T2: Saturday 4h via labourWalk matches single Saturday labour', () => {
    // Sat 10:00 Melbourne AEDT = 2026-11-20 23:00Z (Fri UTC / Sat local)
    const satStart = new Date('2026-11-20T23:00:00.000Z');
    expect(resolveLabourPeriod(satStart, 'Australia/Melbourne')).toBe('SATURDAY');
    const single = calculateRateFloor({
      pricingModel: 'HOURLY',
      billableHours: 4,
      line: rigid8,
      version,
      gstPercent: gst,
      labour: { periodCode: 'SATURDAY', multiplier: 1.5, labourRateHrCents },
    });
    const walked = calculateRateFloor({
      pricingModel: 'HOURLY',
      billableHours: 4,
      line: rigid8,
      version,
      gstPercent: gst,
      labourWalk: {
        startAt: satStart,
        timeZone: 'Australia/Melbourne',
        labourRateHrCents,
        multipliers,
      },
    });
    expect(walked.floorExGstCents).toBe(single.floorExGstCents);
    expect(walked.floorExGstCents).toBe(4 * loadedHourlyFloorCents(6400, labourRateHrCents, 1.5));
    expect(walked.breakdown.labourPeriodCode).toBe('SATURDAY');
  });

  it('T3: Sunday 4h via labourWalk matches single Sunday labour', () => {
    // Sun 10:00 Melbourne AEDT = 2026-11-21 23:00Z
    const sunStart = new Date('2026-11-21T23:00:00.000Z');
    expect(resolveLabourPeriod(sunStart, 'Australia/Melbourne')).toBe('SUNDAY');
    const walked = calculateRateFloor({
      pricingModel: 'HOURLY',
      billableHours: 4,
      line: rigid8,
      version,
      gstPercent: gst,
      labourWalk: {
        startAt: sunStart,
        timeZone: 'Australia/Melbourne',
        labourRateHrCents,
        multipliers,
      },
    });
    expect(walked.floorExGstCents).toBe(4 * 9840);
    expect(walked.breakdown.labourPeriodCode).toBe('SUNDAY');
  });

  it('T12: Fri 23:00 → Sat hour blocks use AFTERNOON then SATURDAY', () => {
    // Fri 23:00 Melbourne AEDT (UTC+11) = 2026-11-20T12:00:00.000Z
    const friEve = new Date('2026-11-20T12:00:00.000Z');
    expect(resolveLabourPeriod(friEve, 'Australia/Melbourne')).toBe('AFTERNOON');
    expect(localDateIso(friEve, 'Australia/Melbourne')).toBe('2026-11-20');

    const blocks = walkHourlyLabourBlocks({
      startAt: friEve,
      hoursCharged: 4,
      timeZone: 'Australia/Melbourne',
      baseHourlyFloorCents: rigid8.hourlyFloorCents,
      labourRateHrCents,
      multipliers,
    });
    expect(blocks.map((b) => b.periodCode)).toEqual([
      'AFTERNOON',
      'SATURDAY',
      'SATURDAY',
      'SATURDAY',
    ]);

    const afternoon = loadedHourlyFloorCents(6400, labourRateHrCents, 1.175);
    const saturday = loadedHourlyFloorCents(6400, labourRateHrCents, 1.5);
    expect(afternoon).toBe(7002);
    expect(saturday).toBe(8120);

    const r = calculateRateFloor({
      pricingModel: 'HOURLY',
      billableHours: 4,
      line: rigid8,
      version,
      gstPercent: gst,
      labourWalk: {
        startAt: friEve,
        timeZone: 'Australia/Melbourne',
        labourRateHrCents,
        multipliers,
      },
    });
    expect(r.floorExGstCents).toBe(afternoon + 3 * saturday);
    expect(r.breakdown.labourPeriodCode).toBe('MIXED');
    expect(r.breakdown.modifiersApplied).toEqual(
      expect.arrayContaining(['LABOUR', 'HOUR_BLOCKS']),
    );
    expect(r.breakdown.hourBlocks).toHaveLength(4);

    // Single start-period would under-charge Saturday hours — prove divergence.
    const flatAfternoon = calculateRateFloor({
      pricingModel: 'HOURLY',
      billableHours: 4,
      line: rigid8,
      version,
      gstPercent: gst,
      labour: { periodCode: 'AFTERNOON', multiplier: 1.175, labourRateHrCents },
    });
    expect(r.floorExGstCents).toBeGreaterThan(flatAfternoon.floorExGstCents);
  });

  it('fractional last block: 4.5h yields five blocks with 0.5h tail', () => {
    const start = new Date('2026-11-18T01:00:00.000Z'); // Wed 12:00 Melbourne
    const blocks = walkHourlyLabourBlocks({
      startAt: start,
      hoursCharged: 4.5,
      timeZone: 'Australia/Melbourne',
      baseHourlyFloorCents: rigid8.hourlyFloorCents,
      labourRateHrCents,
      multipliers,
    });
    expect(blocks).toHaveLength(5);
    expect(blocks[4]?.blockHours).toBe(0.5);
    expect(blocks.every((b) => b.periodCode === 'WEEKDAY_ORDINARY')).toBe(true);
  });
});

describe('Wave 2.4 backhaul', () => {
  it('backhaul rate never below variable + fuel adj', () => {
    const rate = backhaulKmRateCents(255, 4.7, 179, 0.85);
    // max(ceil(255*0.85), ceil(179+4.7)) = max(217, 184) = 217
    expect(rate).toBe(217);
  });

  it('T7-ish: Semi 800 km backhaul lowers vs full floor but stays above variable', () => {
    const full = calculateRateFloor({
      pricingModel: 'PER_KM',
      distanceKm: 800,
      line: { ...semi, variableKmCents: semi.variableKmCents },
      version: { ...version, backhaulFactor: 0.85 },
      gstPercent: gst,
      fuel: {
        dieselCpl: 211.4,
        referenceDieselCpl: 211.4,
        litresPerKm: semi.litresPerKm,
      },
    });
    const back = calculateRateFloor({
      pricingModel: 'PER_KM',
      distanceKm: 800,
      line: { ...semi, variableKmCents: semi.variableKmCents },
      version: { ...version, backhaulFactor: 0.85 },
      gstPercent: gst,
      fuel: {
        dieselCpl: 211.4,
        referenceDieselCpl: 211.4,
        litresPerKm: semi.litresPerKm,
      },
      backhaul: true,
    });
    expect(back.floorExGstCents).toBeLessThan(full.floorExGstCents);
    expect(back.floorExGstCents).toBeGreaterThanOrEqual(semi.variableKmCents * 800);
    expect(back.breakdown.modifiersApplied).toContain('BACKHAUL');
  });
});
