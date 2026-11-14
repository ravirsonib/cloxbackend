import type { VehicleClassSpec } from './job-pricing.util';
import { DEFAULT_VEHICLE_CLASSES } from './job-pricing.util';

/** Legacy PlatformSettings globals used when a class has no rate card yet. */
export type LegacyPlatformRateFallback = {
  perKmRateCents: number;
  hourlyRateCents: number;
  perKmMinBaseCents: number;
  hourlyMinBaseCents: number;
  hourlyMinFloorHours: number;
  gstPercent: number;
};

export type ResolvedClassRates = {
  classCode: string;
  perKmRateCents: number;
  hourlyRateCents: number;
  perKmMinBaseCents: number;
  hourlyMinBaseCents: number;
  perKmGuidanceMinCents: number | null;
  perKmGuidanceMaxCents: number | null;
  hourlyGuidanceMinCents: number | null;
  hourlyGuidanceMaxCents: number | null;
  usedLegacyFallback: boolean;
};

function defaultForCode(code: string): VehicleClassSpec | undefined {
  return DEFAULT_VEHICLE_CLASSES.find((c) => c.code === code);
}

/** Resolve Ops rates for a vehicle class, falling back to PlatformSettings globals. */
export function resolveClassRates(
  classCode: string | null | undefined,
  classRow: VehicleClassSpec | null | undefined,
  legacy: LegacyPlatformRateFallback,
): ResolvedClassRates {
  const code = classCode?.trim() || classRow?.code || 'UTE';
  const seeded = defaultForCode(code);
  const perKmRate =
    classRow?.perKmRateCents ?? seeded?.perKmRateCents ?? legacy.perKmRateCents;
  const hourlyRate =
    classRow?.hourlyRateCents ?? seeded?.hourlyRateCents ?? legacy.hourlyRateCents;
  const usedLegacyFallback =
    classRow?.perKmRateCents == null &&
    classRow?.hourlyRateCents == null &&
    seeded?.perKmRateCents == null;

  return {
    classCode: code,
    perKmRateCents: perKmRate,
    hourlyRateCents: hourlyRate,
    perKmMinBaseCents:
      classRow?.perKmMinBaseCents ??
      seeded?.perKmMinBaseCents ??
      legacy.perKmMinBaseCents,
    hourlyMinBaseCents:
      classRow?.hourlyMinBaseCents ??
      seeded?.hourlyMinBaseCents ??
      legacy.hourlyMinBaseCents,
    perKmGuidanceMinCents:
      classRow?.perKmGuidanceMinCents ?? seeded?.perKmGuidanceMinCents ?? null,
    perKmGuidanceMaxCents:
      classRow?.perKmGuidanceMaxCents ?? seeded?.perKmGuidanceMaxCents ?? null,
    hourlyGuidanceMinCents:
      classRow?.hourlyGuidanceMinCents ?? seeded?.hourlyGuidanceMinCents ?? null,
    hourlyGuidanceMaxCents:
      classRow?.hourlyGuidanceMaxCents ?? seeded?.hourlyGuidanceMaxCents ?? null,
    usedLegacyFallback,
  };
}

export function quotePerKmIncGstCents(
  rates: ResolvedClassRates,
  distanceKm: number,
  globalHardFloorCents: number,
): number {
  const fromRate = Math.round(distanceKm * rates.perKmRateCents);
  return Math.max(globalHardFloorCents, rates.perKmMinBaseCents, fromRate);
}

export function quoteHourlyIncGstCents(
  rates: ResolvedClassRates,
  billableHours: number,
  globalHardFloorCents: number,
): number {
  const fromRate = Math.round(billableHours * rates.hourlyRateCents);
  return Math.max(globalHardFloorCents, rates.hourlyMinBaseCents, fromRate);
}

export function quoteForModel(params: {
  pricingModel: 'PER_KM' | 'HOURLY';
  rates: ResolvedClassRates;
  distanceKm: number;
  billableHours: number | null | undefined;
  hourlyMinFloorHours: number;
  globalHardFloorCents: number;
}): number {
  if (params.pricingModel === 'PER_KM') {
    return quotePerKmIncGstCents(
      params.rates,
      params.distanceKm,
      params.globalHardFloorCents,
    );
  }
  const hours = params.billableHours ?? params.hourlyMinFloorHours;
  return quoteHourlyIncGstCents(params.rates, hours, params.globalHardFloorCents);
}

/** Next larger active class by rank (for sender estimate range). */
export function nextLargerClass(
  classes: readonly VehicleClassSpec[],
  classCode: string,
): VehicleClassSpec | null {
  const current = classes.find((c) => c.code === classCode);
  if (!current) return null;
  const larger = classes
    .filter((c) => c.isActive !== false && c.rank > current.rank)
    .sort((a, b) => a.rank - b.rank);
  return larger[0] ?? null;
}

export function estimateRangeIncGstCents(params: {
  pricingModel: 'PER_KM' | 'HOURLY';
  pricingClass: string;
  classes: readonly VehicleClassSpec[];
  legacy: LegacyPlatformRateFallback;
  distanceKm: number;
  billableHours: number | null | undefined;
}): { minIncGstCents: number; maxIncGstCents: number; maxClassCode: string | null } {
  const row = params.classes.find((c) => c.code === params.pricingClass);
  const rates = resolveClassRates(params.pricingClass, row, params.legacy);
  const globalFloor =
    params.pricingModel === 'HOURLY'
      ? params.legacy.hourlyMinBaseCents
      : params.legacy.perKmMinBaseCents;
  const minInc = quoteForModel({
    pricingModel: params.pricingModel,
    rates,
    distanceKm: params.distanceKm,
    billableHours: params.billableHours,
    hourlyMinFloorHours: params.legacy.hourlyMinFloorHours,
    globalHardFloorCents: globalFloor,
  });

  const larger = nextLargerClass(params.classes, params.pricingClass);
  if (!larger) {
    return { minIncGstCents: minInc, maxIncGstCents: minInc, maxClassCode: null };
  }
  const largerRates = resolveClassRates(larger.code, larger, params.legacy);
  const maxInc = quoteForModel({
    pricingModel: params.pricingModel,
    rates: largerRates,
    distanceKm: params.distanceKm,
    billableHours: params.billableHours,
    hourlyMinFloorHours: params.legacy.hourlyMinFloorHours,
    globalHardFloorCents: globalFloor,
  });
  return {
    minIncGstCents: Math.min(minInc, maxInc),
    maxIncGstCents: Math.max(minInc, maxInc),
    maxClassCode: larger.code,
  };
}
