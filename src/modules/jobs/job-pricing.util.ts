import {
  MAX_JOB_CHARGEABLE_WEIGHT_KG,
  MAX_JOB_DEAD_WEIGHT_KG,
  MAX_JOB_HEIGHT_CM,
  MAX_JOB_LENGTH_CM,
  MAX_JOB_WIDTH_CM,
  chargeableWeightKg as chargeableWeightKgShared,
} from '../../shared/job-cargo.limits';

export {
  MAX_JOB_CHARGEABLE_WEIGHT_KG,
  MAX_JOB_DEAD_WEIGHT_KG,
  MAX_JOB_HEIGHT_CM,
  MAX_JOB_LENGTH_CM,
  MAX_JOB_WIDTH_CM,
  JOB_WEIGHT_OVER_LIMIT_CODE,
  isChargeableOverLimit,
} from '../../shared/job-cargo.limits';

export interface VehicleClassRateFields {
  perKmRateCents?: number | null;
  hourlyRateCents?: number | null;
  perKmMinBaseCents?: number | null;
  hourlyMinBaseCents?: number | null;
  perKmGuidanceMinCents?: number | null;
  perKmGuidanceMaxCents?: number | null;
  hourlyGuidanceMinCents?: number | null;
  hourlyGuidanceMaxCents?: number | null;
}

export interface VehicleClassSpec extends VehicleClassRateFields {
  code: string;
  name?: string;
  rank: number;
  maxChargeableWeightKg: number;
  maxLengthCm: number;
  maxWidthCm: number;
  maxHeightCm: number;
  minLicenceClass: string;
  suggestedGvmKg?: number;
  suggestedTareKg?: number;
  isActive?: boolean;
}

/**
 * Seed midpoints from docs/product/vehicle-type-average-pricing.md (AUD ex-GST → cents).
 * Tailgate is an add-on (not a class). Motorbike/Car seeded inactive per G0-12 Phase 1 floor.
 */
function classRates(params: {
  perKmMin: number;
  perKmMax: number;
  hourlyMin: number;
  hourlyMax: number;
}): VehicleClassRateFields {
  const perKmRateCents = Math.round(((params.perKmMin + params.perKmMax) / 2) * 100);
  const hourlyRateCents = Math.round(((params.hourlyMin + params.hourlyMax) / 2) * 100);
  return {
    perKmRateCents,
    hourlyRateCents,
    perKmMinBaseCents: perKmRateCents * 20,
    hourlyMinBaseCents: hourlyRateCents * 4,
    perKmGuidanceMinCents: Math.round(params.perKmMin * 100),
    perKmGuidanceMaxCents: Math.round(params.perKmMax * 100),
    hourlyGuidanceMinCents: Math.round(params.hourlyMin * 100),
    hourlyGuidanceMaxCents: Math.round(params.hourlyMax * 100),
  };
}

export const DEFAULT_VEHICLE_CLASSES: VehicleClassSpec[] = [
  {
    code: 'MOTORBIKE',
    name: 'Motorbike / Scooter (up to 30kg)',
    rank: 1,
    maxChargeableWeightKg: 30,
    maxLengthCm: 50,
    maxWidthCm: 40,
    maxHeightCm: 40,
    minLicenceClass: 'C',
    suggestedGvmKg: 400,
    suggestedTareKg: 180,
    isActive: false,
    ...classRates({ perKmMin: 1.2, perKmMax: 1.8, hourlyMin: 45, hourlyMax: 70 }),
  },
  {
    code: 'CAR',
    name: 'Car / Hatchback / Sedan (up to 200kg)',
    rank: 2,
    maxChargeableWeightKg: 200,
    maxLengthCm: 120,
    maxWidthCm: 100,
    maxHeightCm: 80,
    minLicenceClass: 'C',
    suggestedGvmKg: 2000,
    suggestedTareKg: 1400,
    isActive: false,
    ...classRates({ perKmMin: 1.4, perKmMax: 2.0, hourlyMin: 50, hourlyMax: 80 }),
  },
  {
    code: 'UTE',
    name: 'Ute (up to 1t)',
    rank: 3,
    maxChargeableWeightKg: 1000,
    maxLengthCm: 240,
    maxWidthCm: 180,
    maxHeightCm: 150,
    minLicenceClass: 'C',
    suggestedGvmKg: 3500,
    suggestedTareKg: 2000,
    isActive: true,
    ...classRates({ perKmMin: 2.0, perKmMax: 3.0, hourlyMin: 70, hourlyMax: 100 }),
  },
  {
    code: 'VAN_SWB',
    name: 'Small Van SWB (up to 1t)',
    rank: 4,
    maxChargeableWeightKg: 1000,
    maxLengthCm: 250,
    maxWidthCm: 150,
    maxHeightCm: 150,
    minLicenceClass: 'C',
    suggestedGvmKg: 3500,
    suggestedTareKg: 2000,
    isActive: true,
    ...classRates({ perKmMin: 2.2, perKmMax: 3.0, hourlyMin: 75, hourlyMax: 95 }),
  },
  {
    code: 'VAN_MWB',
    name: 'Medium Van MWB (up to 1.2t)',
    rank: 5,
    maxChargeableWeightKg: 1200,
    maxLengthCm: 300,
    maxWidthCm: 170,
    maxHeightCm: 170,
    minLicenceClass: 'C',
    suggestedGvmKg: 4000,
    suggestedTareKg: 2200,
    isActive: true,
    ...classRates({ perKmMin: 2.5, perKmMax: 3.5, hourlyMin: 85, hourlyMax: 110 }),
  },
  {
    code: 'VAN',
    name: 'Large Van LWB (up to 1.5t)',
    rank: 6,
    maxChargeableWeightKg: 1500,
    maxLengthCm: 340,
    maxWidthCm: 180,
    maxHeightCm: 190,
    minLicenceClass: 'C',
    suggestedGvmKg: 4500,
    suggestedTareKg: 2500,
    isActive: true,
    ...classRates({ perKmMin: 2.8, perKmMax: 4.0, hourlyMin: 95, hourlyMax: 130 }),
  },
  {
    code: 'RIGID_1_2T',
    name: 'Rigid 1–2T (up to 2.5t)',
    rank: 7,
    maxChargeableWeightKg: 2500,
    maxLengthCm: 450,
    maxWidthCm: 220,
    maxHeightCm: 220,
    minLicenceClass: 'LR',
    suggestedGvmKg: 8000,
    suggestedTareKg: 3500,
    isActive: true,
    ...classRates({ perKmMin: 3.5, perKmMax: 4.8, hourlyMin: 110, hourlyMax: 150 }),
  },
  {
    code: 'RIGID_3T',
    name: 'Rigid 3T (up to 3t)',
    rank: 8,
    maxChargeableWeightKg: 3000,
    maxLengthCm: 520,
    maxWidthCm: 230,
    maxHeightCm: 230,
    minLicenceClass: 'MR',
    suggestedGvmKg: 10000,
    suggestedTareKg: 4500,
    isActive: true,
    ...classRates({ perKmMin: 4.0, perKmMax: 5.5, hourlyMin: 120, hourlyMax: 170 }),
  },
  {
    code: 'RIGID_3_4T',
    name: 'Rigid 3–4T (up to 5t)',
    rank: 9,
    maxChargeableWeightKg: 5000,
    maxLengthCm: 650,
    maxWidthCm: 245,
    maxHeightCm: 250,
    minLicenceClass: 'MR',
    suggestedGvmKg: 15000,
    suggestedTareKg: 7000,
    isActive: true,
    ...classRates({ perKmMin: 4.0, perKmMax: 5.5, hourlyMin: 120, hourlyMax: 170 }),
  },
  {
    code: 'RIGID_4_6T',
    name: 'Rigid 4–6T (up to 6t)',
    rank: 10,
    maxChargeableWeightKg: 6000,
    maxLengthCm: 700,
    maxWidthCm: 245,
    maxHeightCm: 250,
    minLicenceClass: 'MR',
    suggestedGvmKg: 16000,
    suggestedTareKg: 7500,
    isActive: true,
    ...classRates({ perKmMin: 4.5, perKmMax: 6.5, hourlyMin: 140, hourlyMax: 200 }),
  },
  {
    code: 'RIGID_8_10T',
    name: 'Rigid 8–10T (up to 10t)',
    rank: 11,
    maxChargeableWeightKg: 10000,
    maxLengthCm: 850,
    maxWidthCm: 245,
    maxHeightCm: 260,
    minLicenceClass: 'HR',
    suggestedGvmKg: 22000,
    suggestedTareKg: 10000,
    isActive: true,
    ...classRates({ perKmMin: 5.5, perKmMax: 8.0, hourlyMin: 170, hourlyMax: 240 }),
  },
  {
    code: 'RIGID_12_14',
    name: 'Rigid 12–14 pallet (up to 12t)',
    rank: 12,
    maxChargeableWeightKg: 12000,
    maxLengthCm: 1000,
    maxWidthCm: 245,
    maxHeightCm: 270,
    minLicenceClass: 'HR',
    suggestedGvmKg: 26000,
    suggestedTareKg: 12000,
    isActive: true,
    ...classRates({ perKmMin: 6.5, perKmMax: 9.0, hourlyMin: 180, hourlyMax: 260 }),
  },
  {
    code: 'FLATBED',
    name: 'Flatbed / Tray (up to 12t)',
    rank: 13,
    maxChargeableWeightKg: 12000,
    maxLengthCm: 1200,
    maxWidthCm: 250,
    maxHeightCm: 300,
    minLicenceClass: 'HR',
    suggestedGvmKg: 26000,
    suggestedTareKg: 11000,
    isActive: true,
    ...classRates({ perKmMin: 6.0, perKmMax: 9.0, hourlyMin: 160, hourlyMax: 240 }),
  },
  {
    code: 'REEFER',
    name: 'Refrigerated Truck (up to 12t)',
    rank: 14,
    maxChargeableWeightKg: 12000,
    maxLengthCm: 1000,
    maxWidthCm: 245,
    maxHeightCm: 270,
    minLicenceClass: 'HR',
    suggestedGvmKg: 26000,
    suggestedTareKg: 13000,
    isActive: true,
    ...classRates({ perKmMin: 7.0, perKmMax: 10.0, hourlyMin: 200, hourlyMax: 300 }),
  },
  {
    code: 'CRANE',
    name: 'Crane Truck / Hiab (up to 12t)',
    rank: 15,
    maxChargeableWeightKg: 12000,
    maxLengthCm: 1000,
    maxWidthCm: 250,
    maxHeightCm: 300,
    minLicenceClass: 'HR',
    suggestedGvmKg: 28000,
    suggestedTareKg: 14000,
    isActive: true,
    ...classRates({ perKmMin: 7.5, perKmMax: 12.0, hourlyMin: 220, hourlyMax: 350 }),
  },
  {
    code: 'SEMI',
    name: 'Semi-Trailer (up to 24t)',
    rank: 16,
    maxChargeableWeightKg: 24000,
    maxLengthCm: 1360,
    maxWidthCm: 250,
    maxHeightCm: 270,
    minLicenceClass: 'HC',
    suggestedGvmKg: 42500,
    suggestedTareKg: 15000,
    isActive: true,
    ...classRates({ perKmMin: 4.0, perKmMax: 5.0, hourlyMin: 220, hourlyMax: 260 }),
  },
  {
    code: 'CONTAINER',
    name: 'Container (up to 28t)',
    rank: 17,
    maxChargeableWeightKg: 28000,
    maxLengthCm: 1220,
    maxWidthCm: 250,
    maxHeightCm: 290,
    minLicenceClass: 'HC',
    suggestedGvmKg: 45000,
    suggestedTareKg: 16000,
    isActive: true,
    ...classRates({ perKmMin: 4.5, perKmMax: 6.0, hourlyMin: 240, hourlyMax: 300 }),
  },
  {
    code: 'BDOUBLE',
    name: 'B-Double (up to 38t)',
    rank: 18,
    maxChargeableWeightKg: 38000,
    maxLengthCm: 2000,
    maxWidthCm: 250,
    maxHeightCm: 430,
    minLicenceClass: 'MC',
    suggestedGvmKg: 62500,
    suggestedTareKg: 20000,
    isActive: true,
    ...classRates({ perKmMin: 5.5, perKmMax: 6.5, hourlyMin: 320, hourlyMax: 380 }),
  },
  {
    code: 'ROAD_TRAIN',
    name: 'Road Train (up to 120t)',
    rank: 19,
    maxChargeableWeightKg: 120000,
    maxLengthCm: 3500,
    maxWidthCm: 250,
    maxHeightCm: 430,
    minLicenceClass: 'MC',
    suggestedGvmKg: 140000,
    suggestedTareKg: 40000,
    isActive: true,
    ...classRates({ perKmMin: 7.0, perKmMax: 10.0, hourlyMin: 380, hourlyMax: 480 }),
  },
];

/** Prisma create/update payload for VehicleClassConfig from a default spec. */
export function vehicleClassConfigWriteData(c: VehicleClassSpec) {
  return {
    code: c.code,
    name: c.name ?? c.code,
    rank: c.rank,
    maxChargeableWeightKg: c.maxChargeableWeightKg,
    maxLengthCm: c.maxLengthCm,
    maxWidthCm: c.maxWidthCm,
    maxHeightCm: c.maxHeightCm,
    minLicenceClass: c.minLicenceClass,
    suggestedGvmKg: c.suggestedGvmKg ?? 3500,
    suggestedTareKg: c.suggestedTareKg ?? 2000,
    isActive: c.isActive !== false,
    perKmRateCents: c.perKmRateCents ?? null,
    hourlyRateCents: c.hourlyRateCents ?? null,
    perKmMinBaseCents: c.perKmMinBaseCents ?? null,
    hourlyMinBaseCents: c.hourlyMinBaseCents ?? null,
    perKmGuidanceMinCents: c.perKmGuidanceMinCents ?? null,
    perKmGuidanceMaxCents: c.perKmGuidanceMaxCents ?? null,
    hourlyGuidanceMinCents: c.hourlyGuidanceMinCents ?? null,
    hourlyGuidanceMaxCents: c.hourlyGuidanceMaxCents ?? null,
  };
}

export const DEFAULT_VEHICLE_CLASS_CODES = DEFAULT_VEHICLE_CLASSES.map((c) => c.code);
/** Vehicle class rank — higher can take lower-class jobs; undersize blocked. */
export const VEHICLE_CLASS_RANK: Record<string, number> = Object.fromEntries(
  DEFAULT_VEHICLE_CLASSES.map((c) => [c.code, c.rank]),
);

/** Minimum licence required to operate each vehicle class. */
export const VEHICLE_MIN_LICENCE: Record<string, string> = Object.fromEntries(
  DEFAULT_VEHICLE_CLASSES.map((c) => [c.code, c.minLicenceClass]),
);

/** Max chargeable kg per class */
export const VEHICLE_CLASS_MAX_CHARGEABLE_KG: Record<string, number> = Object.fromEntries(
  DEFAULT_VEHICLE_CLASSES.map((c) => [c.code, c.maxChargeableWeightKg]),
);

/** Max cargo bay envelope (cm) per vehicle class */
export const VEHICLE_CLASS_MAX_DIMS_CM: Record<
  string,
  { lengthCm: number; widthCm: number; heightCm: number }
> = Object.fromEntries(
  DEFAULT_VEHICLE_CLASSES.map((c) => [
    c.code,
    { lengthCm: c.maxLengthCm, widthCm: c.maxWidthCm, heightCm: c.maxHeightCm },
  ]),
);

/** AU licence class rank (Phase 1 hierarchy for assignment gate). */
export const LICENCE_CLASS_RANK: Record<string, number> = {
  C: 1,
  LR: 2,
  MR: 3,
  HR: 4,
  HC: 5,
  MC: 6,
};

export function vehicleClassRank(
  vehicleClass: string | null | undefined,
  rankMap?: Record<string, number>,
): number {
  if (!vehicleClass) return 0;
  const map = rankMap ?? VEHICLE_CLASS_RANK;
  return map[vehicleClass.toUpperCase()] ?? 0;
}

export function licenceClassRank(licenceClass: string | null | undefined): number {
  if (!licenceClass) return 0;
  return LICENCE_CLASS_RANK[licenceClass.toUpperCase()] ?? 0;
}

/** True if offered class is same or larger than required minimum. */
export function isVehicleClassAdequate(
  offeredClass: string | null | undefined,
  minClass: string | null | undefined,
  rankMap?: Record<string, number>,
): boolean {
  if (!minClass) return true;
  return vehicleClassRank(offeredClass, rankMap) >= vehicleClassRank(minClass, rankMap);
}

/** True if driver licence class covers the vehicle class (AU Phase 1 ranks). */
export function licenceCoversVehicleClass(
  licenceClass: string | null | undefined,
  vehicleClass: string | null | undefined,
  minLicenceMap?: Record<string, string>,
): boolean {
  if (!vehicleClass) return Boolean(licenceClass);
  const map = minLicenceMap ?? VEHICLE_MIN_LICENCE;
  const minLicence = map[vehicleClass.toUpperCase()];
  if (!minLicence) return false;
  return licenceClassRank(licenceClass) >= licenceClassRank(minLicence);
}

/** Chargeable kg = max(dead, L×W×Hcm / 4000). */
export function chargeableWeightKg(params: {
  deadWeightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}): number {
  return chargeableWeightKgShared(params);
}

export type JobCargoInput = {
  deadWeightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
};

/** True when dead weight, dims, or resulting chargeable kg exceed platform caps. */
export function isJobCargoOverLimit(params: JobCargoInput): boolean {
  if (
    params.deadWeightKg > MAX_JOB_DEAD_WEIGHT_KG ||
    params.lengthCm > MAX_JOB_LENGTH_CM ||
    params.widthCm > MAX_JOB_WIDTH_CM ||
    params.heightCm > MAX_JOB_HEIGHT_CM
  ) {
    return true;
  }
  return chargeableWeightKg(params) > MAX_JOB_CHARGEABLE_WEIGHT_KG;
}

export function recommendVehicleClassFromDims(
  dims?: {
    lengthCm?: number | null;
    widthCm?: number | null;
    heightCm?: number | null;
  },
  classes: VehicleClassSpec[] = DEFAULT_VEHICLE_CLASSES,
): string {
  const active = classes
    .filter((c) => c.isActive !== false)
    .sort((a, b) => a.rank - b.rank);
  if (active.length === 0) return 'UTE';
  if (!dims) return active[0].code;
  const l = dims.lengthCm ?? 0;
  const w = dims.widthCm ?? 0;
  const h = dims.heightCm ?? 0;
  if (l <= 0 && w <= 0 && h <= 0) return active[0].code;
  for (const cls of active) {
    if (l <= cls.maxLengthCm && w <= cls.maxWidthCm && h <= cls.maxHeightCm) {
      return cls.code;
    }
  }
  return active[active.length - 1].code;
}

/** Recommend minimum class from chargeable weight (+ optional physical dimensions and custom classes catalog). */
export function recommendVehicleClass(
  chargeableKg: number,
  dims?: {
    lengthCm?: number | null;
    widthCm?: number | null;
    heightCm?: number | null;
  },
  classes: VehicleClassSpec[] = DEFAULT_VEHICLE_CLASSES,
): string {
  const active = classes
    .filter((c) => c.isActive !== false)
    .sort((a, b) => a.rank - b.rank);

  if (active.length === 0) return 'BDOUBLE';

  const l = dims?.lengthCm ?? 0;
  const w = dims?.widthCm ?? 0;
  const h = dims?.heightCm ?? 0;

  for (const cls of active) {
    const weightOk = chargeableKg <= cls.maxChargeableWeightKg;
    const dimsOk =
      (l <= 0 || l <= cls.maxLengthCm) &&
      (w <= 0 || w <= cls.maxWidthCm) &&
      (h <= 0 || h <= cls.maxHeightCm);
    if (weightOk && dimsOk) {
      return cls.code;
    }
  }

  return active[active.length - 1].code;
}

/**
 * Board / bid gate: class rank adequate, or vehicle payload covers chargeable kg
 * when stored minClass is only one step above the weight recommendation.
 */
export function isVehicleAdequateForJob(
  offeredClass: string | null | undefined,
  minClass: string | null | undefined,
  chargeableKg: number | null | undefined,
  classes: VehicleClassSpec[] = DEFAULT_VEHICLE_CLASSES,
): boolean {
  const rankMap: Record<string, number> = {
    ...VEHICLE_CLASS_RANK,
    ...Object.fromEntries(classes.map((c) => [c.code.toUpperCase(), c.rank])),
  };
  const maxChargeableMap: Record<string, number> = {
    ...VEHICLE_CLASS_MAX_CHARGEABLE_KG,
    ...Object.fromEntries(
      classes.map((c) => [c.code.toUpperCase(), c.maxChargeableWeightKg]),
    ),
  };

  if (isVehicleClassAdequate(offeredClass, minClass, rankMap)) return true;
  if (chargeableKg == null || chargeableKg <= 0 || !offeredClass) return false;
  const offeredMax = maxChargeableMap[offeredClass.toUpperCase()];
  if (offeredMax == null || chargeableKg > offeredMax) return false;
  const weightMin = recommendVehicleClass(chargeableKg, undefined, classes);
  if (!minClass) return isVehicleClassAdequate(offeredClass, weightMin, rankMap);
  // Allow when stored min capacity is only modestly above weight need (legacy auto VAN for ≤1000 kg).
  // Rank-step slack is too brittle once the docs catalog inserts intermediate van/rigid classes.
  const weightMinMax = maxChargeableMap[weightMin.toUpperCase()] ?? 0;
  const storedMinMax = maxChargeableMap[minClass.toUpperCase()] ?? 0;
  if (storedMinMax > Math.max(weightMinMax * 2, chargeableKg * 2)) return false;
  return isVehicleClassAdequate(offeredClass, weightMin, rankMap);
}

export function gstSplitFromIncCents(incGstCents: number, gstRatePercent: number = 10) {
  const rateFactor = 1 + (gstRatePercent > 0 ? gstRatePercent / 100 : 0);
  const ex = Math.round(incGstCents / rateFactor);
  const gst = incGstCents - ex;
  return { amountExGstCents: ex, amountGstCents: gst, amountIncGstCents: incGstCents };
}

/**
 * Carrier net display from settlement gross.
 * Default 70% matches national default; pass resolved carrier % when known.
 */
export function carrierNetPayoutCents(
  grossIncGstCents: number,
  carrierPercent: number = 70,
): number {
  const pct = Math.max(1, Math.min(99, Math.trunc(carrierPercent)));
  return Math.round((grossIncGstCents * pct) / 100);
}

export async function loadVehicleClassMaps(prisma?: {
  vehicleClassConfig?: {
    findMany?: (args?: { where?: { isActive?: boolean } }) => Promise<
      Array<{
        code: string;
        rank: number;
        maxChargeableWeightKg: number;
        minLicenceClass: string;
      }>
    >;
  };
}): Promise<{
  rankMap: Record<string, number>;
  minLicenceMap: Record<string, string>;
  maxChargeableMap: Record<string, number>;
}> {
  const rankMap: Record<string, number> = { ...VEHICLE_CLASS_RANK };
  const minLicenceMap: Record<string, string> = { ...VEHICLE_MIN_LICENCE };
  const maxChargeableMap: Record<string, number> = { ...VEHICLE_CLASS_MAX_CHARGEABLE_KG };
  try {
    const rows = await prisma?.vehicleClassConfig?.findMany?.({ where: { isActive: true } });
    for (const r of rows ?? []) {
      const key = r.code.toUpperCase();
      rankMap[key] = r.rank;
      minLicenceMap[key] = r.minLicenceClass;
      maxChargeableMap[key] = r.maxChargeableWeightKg;
    }
  } catch {
    // Fallback to defaults when table or test mock is absent.
  }
  return { rankMap, minLicenceMap, maxChargeableMap };
}
