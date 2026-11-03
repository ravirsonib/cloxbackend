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

export interface VehicleClassSpec {
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

export const DEFAULT_VEHICLE_CLASSES: VehicleClassSpec[] = [
  {
    code: 'UTE',
    name: 'Ute (up to 1t)',
    rank: 1,
    maxChargeableWeightKg: 1000,
    maxLengthCm: 240,
    maxWidthCm: 180,
    maxHeightCm: 150,
    minLicenceClass: 'C',
    suggestedGvmKg: 3500,
    suggestedTareKg: 2000,
    isActive: true,
  },
  {
    code: 'VAN',
    name: 'Van (up to 1.5t)',
    rank: 2,
    maxChargeableWeightKg: 1500,
    maxLengthCm: 340,
    maxWidthCm: 180,
    maxHeightCm: 190,
    minLicenceClass: 'C',
    suggestedGvmKg: 4500,
    suggestedTareKg: 2500,
    isActive: true,
  },
  {
    code: 'RIGID_1_2T',
    name: 'Rigid 1–2T (up to 2.5t)',
    rank: 3,
    maxChargeableWeightKg: 2500,
    maxLengthCm: 450,
    maxWidthCm: 220,
    maxHeightCm: 220,
    minLicenceClass: 'LR',
    suggestedGvmKg: 8000,
    suggestedTareKg: 3500,
    isActive: true,
  },
  {
    code: 'RIGID_3_4T',
    name: 'Rigid 3–4T (up to 5t)',
    rank: 4,
    maxChargeableWeightKg: 5000,
    maxLengthCm: 650,
    maxWidthCm: 245,
    maxHeightCm: 250,
    minLicenceClass: 'MR',
    suggestedGvmKg: 15000,
    suggestedTareKg: 7000,
    isActive: true,
  },
  {
    code: 'SEMI',
    name: 'Semi-Trailer (up to 15t)',
    rank: 5,
    maxChargeableWeightKg: 15000,
    maxLengthCm: 1360,
    maxWidthCm: 250,
    maxHeightCm: 270,
    minLicenceClass: 'HC',
    suggestedGvmKg: 42500,
    suggestedTareKg: 15000,
    isActive: true,
  },
  {
    code: 'BDOUBLE',
    name: 'B-Double (up to 50t)',
    rank: 6,
    maxChargeableWeightKg: 50000,
    maxLengthCm: 2000,
    maxWidthCm: 500,
    maxHeightCm: 500,
    minLicenceClass: 'MC',
    suggestedGvmKg: 62500,
    suggestedTareKg: 20000,
    isActive: true,
  },
];

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
  const rankMap = Object.fromEntries(classes.map((c) => [c.code, c.rank]));
  const maxChargeableMap = Object.fromEntries(
    classes.map((c) => [c.code, c.maxChargeableWeightKg]),
  );

  if (isVehicleClassAdequate(offeredClass, minClass, rankMap)) return true;
  if (chargeableKg == null || chargeableKg <= 0 || !offeredClass) return false;
  const offeredMax = maxChargeableMap[offeredClass.toUpperCase()];
  if (offeredMax == null || chargeableKg > offeredMax) return false;
  const weightMin = recommendVehicleClass(chargeableKg, undefined, classes);
  if (!minClass) return isVehicleClassAdequate(offeredClass, weightMin, rankMap);
  // Allow when stored min is not far above weight-based min (legacy auto VAN for ≤1000 kg).
  if (vehicleClassRank(minClass, rankMap) > vehicleClassRank(weightMin, rankMap) + 1) return false;
  return isVehicleClassAdequate(offeredClass, weightMin, rankMap);
}

export function gstSplitFromIncCents(incGstCents: number, gstRatePercent: number = 10) {
  const rateFactor = 1 + (gstRatePercent > 0 ? gstRatePercent / 100 : 0);
  const ex = Math.round(incGstCents / rateFactor);
  const gst = incGstCents - ex;
  return { amountExGstCents: ex, amountGstCents: gst, amountIncGstCents: incGstCents };
}

/**
 * Carrier net display — locked at 70% of gross (revenue split 2A).
 * Admin 30% pool is policy/override-driven at settlement accrual.
 */
export function carrierNetPayoutCents(grossIncGstCents: number): number {
  return Math.round(grossIncGstCents * 0.7);
}
