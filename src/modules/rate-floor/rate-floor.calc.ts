import {
  loadedHourlyFloorCents,
  walkHourlyLabourBlocks,
  type HourlyLabourBlock,
} from './rate-floor.labour';

/** Round money up to whole cents (never under-floor). */
export function ceilCents(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value - 1e-9);
}

export function exGstToIncGstCents(exGstCents: number, gstPercent: number): number {
  const rate = gstPercent > 0 ? gstPercent / 100 : 0;
  return ceilCents(exGstCents * (1 + rate));
}

export type RateFloorLineInput = {
  vehicleClassCode: string;
  hourlyFloorCents: number;
  kmFloorCents: number;
  litresPerKm?: number;
  variableKmCents?: number;
};

export type RateFloorVersionParams = {
  minHours: number;
  minKmChargeKm: number;
  referenceDieselCpl?: number;
  labourRateHrCents?: number;
  backhaulFactor?: number;
};

/** Wave 2.1 — diesel already resolved (cap/stale handled in service). */
export type RateFloorFuelInput = {
  dieselCpl: number;
  referenceDieselCpl: number;
  litresPerKm: number;
  isStale?: boolean;
  weeklyMoveCapped?: boolean;
  fuelIndexId?: string | null;
  weekStart?: string | null;
};

/** Wave 2.2 — labour period already resolved (single start period / PER_KM 1h floor). */
export type RateFloorLabourInput = {
  periodCode: string;
  multiplier: number;
  labourRateHrCents: number;
};

/**
 * W3.3 — HOURLY hour-block labour walk (IT §4.1 / T12).
 * When present, each ≤1h block resolves its own period; OT &gt;7.6h deferred.
 */
export type RateFloorLabourWalkInput = {
  startAt: Date;
  timeZone: string;
  labourRateHrCents: number;
  multipliers: Array<{ periodCode: string; multiplier: number }>;
  holidayDates?: ReadonlySet<string>;
};

/** Wave 2.3 — body loading already resolved. */
export type RateFloorBodyInput = {
  bodyCode: string;
  loadingPct: number;
  minHours?: number | null;
};

export type RateFloorCalcInput = {
  pricingModel: 'PER_KM' | 'HOURLY';
  distanceKm?: number | null;
  billableHours?: number | null;
  line: RateFloorLineInput;
  version: RateFloorVersionParams;
  gstPercent: number;
  fuel?: RateFloorFuelInput | null;
  labour?: RateFloorLabourInput | null;
  /** Preferred for HOURLY when pickup time is known. */
  labourWalk?: RateFloorLabourWalkInput | null;
  body?: RateFloorBodyInput | null;
  /** Wave 2.4 — PER_KM return-leg discount. */
  backhaul?: boolean;
};

export type RateFloorCalcResult = {
  floorExGstCents: number;
  floorIncGstCents: number;
  breakdown: Record<string, unknown>;
};

/**
 * Fuel adj cents per km = litresPerKm × (dieselCpl − referenceDieselCpl).
 * PDF §5.2: +10 c/L × 0.111 L/km → +1.1 c/km.
 */
export function fuelAdjCentsPerKm(
  litresPerKm: number,
  dieselCpl: number,
  referenceDieselCpl: number,
): number {
  if (!Number.isFinite(litresPerKm) || litresPerKm <= 0) return 0;
  if (!Number.isFinite(dieselCpl) || !Number.isFinite(referenceDieselCpl)) return 0;
  return litresPerKm * (dieselCpl - referenceDieselCpl);
}

export function effectiveKmFloorCents(
  kmFloorCents: number,
  litresPerKm: number,
  dieselCpl: number,
  referenceDieselCpl: number,
): { effectiveKmFloorCents: number; fuelAdjCentsPerKm: number } {
  const adj = fuelAdjCentsPerKm(litresPerKm, dieselCpl, referenceDieselCpl);
  const effective =
    adj >= 0 ? ceilCents(kmFloorCents + adj) : Math.max(0, Math.floor(kmFloorCents + adj + 1e-9));
  return { effectiveKmFloorCents: effective, fuelAdjCentsPerKm: adj };
}

/** Backhaul rate: max(effectiveKm × factor, variableKm + fuelAdj). */
export function backhaulKmRateCents(
  effectiveKmFloorCents: number,
  fuelAdjCents: number,
  variableKmCents: number,
  backhaulFactor: number,
): number {
  const factor = backhaulFactor > 0 && backhaulFactor <= 1 ? backhaulFactor : 0.85;
  const discounted = ceilCents(effectiveKmFloorCents * factor);
  const variableFloor = ceilCents(Math.max(0, variableKmCents) + fuelAdjCents);
  return Math.max(discounted, variableFloor);
}

function resolveLoadedHourly(
  baseHourlyCents: number,
  labour: RateFloorLabourInput | null | undefined,
): { hourlyFloorCents: number; labourAddCents: number } {
  if (!labour || labour.multiplier <= 1 + 1e-9) {
    return { hourlyFloorCents: baseHourlyCents, labourAddCents: 0 };
  }
  const loaded = loadedHourlyFloorCents(
    baseHourlyCents,
    labour.labourRateHrCents,
    labour.multiplier,
  );
  return { hourlyFloorCents: loaded, labourAddCents: loaded - baseHourlyCents };
}

function applyBodyLoading(
  baseExGstCents: number,
  body: RateFloorBodyInput | null | undefined,
): { floorExGstCents: number; bodyAddCents: number } {
  const pct = body?.loadingPct ?? 0;
  if (!body || !Number.isFinite(pct) || pct <= 0) {
    return { floorExGstCents: baseExGstCents, bodyAddCents: 0 };
  }
  const loaded = ceilCents(baseExGstCents * (1 + pct / 100));
  return { floorExGstCents: loaded, bodyAddCents: loaded - baseExGstCents };
}

/**
 * Hard-floor total (PDF §5.3 + W2.1 fuel + W2.2 labour + W2.3 body + W2.4 backhaul + W3.3 hour blocks).
 * TODO(W3.3+/Legal): OT beyond 7.6h/day (1.5 then 2.0 on labour) — not applied here.
 */
export function calculateRateFloor(input: RateFloorCalcInput): RateFloorCalcResult {
  const { line, version, pricingModel, gstPercent, fuel, labour, labourWalk, body } = input;
  const versionMinHours = version.minHours > 0 ? version.minHours : 4;
  const bodyMin = body?.minHours != null && body.minHours > 0 ? body.minHours : 0;
  const minHours = Math.max(versionMinHours, bodyMin);
  const minKm = version.minKmChargeKm > 0 ? version.minKmChargeKm : 25;
  const { hourlyFloorCents: loadedHourly, labourAddCents } = resolveLoadedHourly(
    line.hourlyFloorCents,
    labour,
  );

  if (pricingModel === 'HOURLY') {
    const hoursRaw = input.billableHours ?? minHours;
    const hours = Math.max(hoursRaw, minHours);

    let baseEx: number;
    let hourBlocks: HourlyLabourBlock[] | null = null;
    let labourAddTotal = labourAddCents;
    let loadedHourlyForBreakdown = loadedHourly;
    let labourPeriodCode: string | null = labour?.periodCode ?? null;
    let labourMultiplier: number | null = labour?.multiplier ?? 1;

    if (labourWalk?.startAt instanceof Date && !Number.isNaN(labourWalk.startAt.getTime())) {
      hourBlocks = walkHourlyLabourBlocks({
        startAt: labourWalk.startAt,
        hoursCharged: hours,
        timeZone: labourWalk.timeZone,
        baseHourlyFloorCents: line.hourlyFloorCents,
        labourRateHrCents: labourWalk.labourRateHrCents,
        multipliers: labourWalk.multipliers,
        holidayDates: labourWalk.holidayDates,
      });
      baseEx = hourBlocks.reduce((sum, b) => sum + b.blockExGstCents, 0);
      labourAddTotal = hourBlocks.reduce(
        (sum, b) => sum + Math.ceil(b.blockHours * b.labourAddCents - 1e-9),
        0,
      );
      const periods = [...new Set(hourBlocks.map((b) => b.periodCode))];
      labourPeriodCode = periods.length === 1 ? periods[0]! : 'MIXED';
      labourMultiplier = periods.length === 1 ? hourBlocks[0]?.multiplier ?? 1 : null;
      loadedHourlyForBreakdown =
        hours > 0 ? Math.ceil(baseEx / hours - 1e-9) : line.hourlyFloorCents;
    } else {
      baseEx = ceilCents(hours * loadedHourly);
    }

    const { floorExGstCents, bodyAddCents } = applyBodyLoading(baseEx, body);
    const modifiersApplied: string[] = [];
    if (labourAddTotal > 0) modifiersApplied.push('LABOUR');
    if (hourBlocks && hourBlocks.length > 1) {
      const distinct = new Set(hourBlocks.map((b) => b.periodCode));
      if (distinct.size > 1) modifiersApplied.push('HOUR_BLOCKS');
    }
    if (bodyAddCents > 0) modifiersApplied.push('BODY');
    const breakdown = {
      mode: 'HOURLY',
      vehicleClassCode: line.vehicleClassCode,
      hourlyFloorCents: line.hourlyFloorCents,
      loadedHourlyFloorCents: loadedHourlyForBreakdown,
      labourPeriodCode,
      labourMultiplier,
      labourAddCents: labourAddTotal,
      hourBlocks: hourBlocks?.map((b) => ({
        at: b.atIso,
        localDate: b.localDate,
        periodCode: b.periodCode,
        multiplier: b.multiplier,
        blockHours: b.blockHours,
        loadedHourlyFloorCents: b.loadedHourlyFloorCents,
        blockExGstCents: b.blockExGstCents,
      })) ?? null,
      bodyCode: body?.bodyCode ?? 'DRY',
      bodyLoadingPct: body?.loadingPct ?? 0,
      bodyAddCents,
      baseFloorExGstCents: baseEx,
      billableHoursInput: input.billableHours ?? null,
      hoursCharged: hours,
      minHours,
      floorExGstCents,
      modifiersApplied,
      /** OT &gt;7.6h/day not applied — Legal/Award deferred. */
      overtimeBeyond76Deferred: true,
    };
    return {
      floorExGstCents,
      floorIncGstCents: exGstToIncGstCents(floorExGstCents, gstPercent),
      breakdown,
    };
  }

  const referenceDieselCpl =
    fuel?.referenceDieselCpl ?? version.referenceDieselCpl ?? 211.4;
  const litresPerKm = fuel?.litresPerKm ?? line.litresPerKm ?? 0;
  const dieselCpl = fuel?.dieselCpl ?? referenceDieselCpl;
  const { effectiveKmFloorCents: kmFloorFuelled, fuelAdjCentsPerKm: fuelAdj } =
    effectiveKmFloorCents(line.kmFloorCents, litresPerKm, dieselCpl, referenceDieselCpl);

  const backhaulFactor = version.backhaulFactor ?? 0.85;
  const variableKmCents = line.variableKmCents ?? 0;
  const isBackhaul = Boolean(input.backhaul);
  const kmRate = isBackhaul
    ? backhaulKmRateCents(kmFloorFuelled, fuelAdj, variableKmCents, backhaulFactor)
    : kmFloorFuelled;

  const distanceKm = Math.max(0, input.distanceKm ?? 0);
  const distanceTotal = distanceKm * kmRate;
  const minDistanceCharge = kmRate * minKm;
  const oneHourFloor = loadedHourly;
  const baseEx = ceilCents(Math.max(distanceTotal, minDistanceCharge, oneHourFloor));
  const { floorExGstCents, bodyAddCents } = applyBodyLoading(baseEx, body);

  const modifiersApplied: string[] = [];
  if (fuel && Math.abs(fuelAdj) > 1e-9) modifiersApplied.push('FUEL');
  if (labourAddCents > 0) modifiersApplied.push('LABOUR');
  if (isBackhaul) modifiersApplied.push('BACKHAUL');
  if (bodyAddCents > 0) modifiersApplied.push('BODY');

  const breakdown = {
    mode: 'PER_KM',
    vehicleClassCode: line.vehicleClassCode,
    kmFloorCents: line.kmFloorCents,
    effectiveKmFloorCents: kmFloorFuelled,
    appliedKmRateCents: kmRate,
    backhaul: isBackhaul,
    backhaulFactor: isBackhaul ? backhaulFactor : null,
    variableKmCents,
    fuelAdjCentsPerKm: fuelAdj,
    litresPerKm,
    dieselCpl,
    referenceDieselCpl,
    fuelIndexId: fuel?.fuelIndexId ?? null,
    fuelWeekStart: fuel?.weekStart ?? null,
    fuelIsStale: fuel?.isStale ?? false,
    fuelWeeklyMoveCapped: fuel?.weeklyMoveCapped ?? false,
    hourlyFloorCents: line.hourlyFloorCents,
    loadedHourlyFloorCents: loadedHourly,
    labourPeriodCode: labour?.periodCode ?? null,
    labourMultiplier: labour?.multiplier ?? 1,
    labourAddCents,
    bodyCode: body?.bodyCode ?? 'DRY',
    bodyLoadingPct: body?.loadingPct ?? 0,
    bodyAddCents,
    baseFloorExGstCents: baseEx,
    distanceKm,
    distanceTotalCents: ceilCents(distanceTotal),
    minDistanceChargeCents: ceilCents(minDistanceCharge),
    oneHourFloorCents: oneHourFloor,
    minKmChargeKm: minKm,
    floorExGstCents,
    modifiersApplied,
  };
  return {
    floorExGstCents,
    floorIncGstCents: exGstToIncGstCents(floorExGstCents, gstPercent),
    breakdown,
  };
}
