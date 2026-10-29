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

/** Vehicle class rank — higher can take lower-class jobs; undersize blocked. */
export const VEHICLE_CLASS_RANK: Record<string, number> = {
  UTE: 1,
  VAN: 2,
  RIGID_1_2T: 3,
  RIGID_3_4T: 4,
  SEMI: 5,
  BDOUBLE: 6,
};

/** AU licence class rank (Phase 1 hierarchy for assignment gate). */
export const LICENCE_CLASS_RANK: Record<string, number> = {
  C: 1,
  LR: 2,
  MR: 3,
  HR: 4,
  HC: 5,
  MC: 6,
};

/** Minimum licence required to operate each vehicle class. */
export const VEHICLE_MIN_LICENCE: Record<string, string> = {
  UTE: 'C',
  VAN: 'C',
  RIGID_1_2T: 'LR',
  RIGID_3_4T: 'MR',
  SEMI: 'HC',
  BDOUBLE: 'MC',
};

export function vehicleClassRank(vehicleClass: string | null | undefined): number {
  if (!vehicleClass) return 0;
  return VEHICLE_CLASS_RANK[vehicleClass.toUpperCase()] ?? 0;
}

export function licenceClassRank(licenceClass: string | null | undefined): number {
  if (!licenceClass) return 0;
  return LICENCE_CLASS_RANK[licenceClass.toUpperCase()] ?? 0;
}

/** True if offered class is same or larger than required minimum. */
export function isVehicleClassAdequate(
  offeredClass: string | null | undefined,
  minClass: string | null | undefined,
): boolean {
  if (!minClass) return true;
  return vehicleClassRank(offeredClass) >= vehicleClassRank(minClass);
}

/** True if driver licence class covers the vehicle class (AU Phase 1 ranks). */
export function licenceCoversVehicleClass(
  licenceClass: string | null | undefined,
  vehicleClass: string | null | undefined,
): boolean {
  if (!vehicleClass) return Boolean(licenceClass);
  const minLicence = VEHICLE_MIN_LICENCE[vehicleClass.toUpperCase()];
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

/**
 * Max chargeable kg each class can take (AU “1 tonne ute” ≈ 1000 kg payload).
 * Used for recommend + board visibility when a lighter class can still carry the load.
 */
export const VEHICLE_CLASS_MAX_CHARGEABLE_KG: Record<string, number> = {
  UTE: 1000,
  VAN: 1500,
  RIGID_1_2T: 2500,
  RIGID_3_4T: 5000,
  SEMI: 15_000,
  BDOUBLE: 50_000,
};

/** Recommend minimum class from chargeable weight. */
export function recommendVehicleClass(chargeableKg: number): string {
  if (chargeableKg <= 1000) return 'UTE';
  if (chargeableKg <= 1500) return 'VAN';
  if (chargeableKg <= 2500) return 'RIGID_1_2T';
  if (chargeableKg <= 5000) return 'RIGID_3_4T';
  if (chargeableKg <= 15_000) return 'SEMI';
  return 'BDOUBLE';
}

/**
 * Board / bid gate: class rank adequate, or vehicle payload covers chargeable kg
 * when stored minClass is only one step above the weight recommendation
 * (covers jobs created under the old UTE≤500 ladder, e.g. 800 kg → VAN).
 */
export function isVehicleAdequateForJob(
  offeredClass: string | null | undefined,
  minClass: string | null | undefined,
  chargeableKg: number | null | undefined,
): boolean {
  if (isVehicleClassAdequate(offeredClass, minClass)) return true;
  if (chargeableKg == null || chargeableKg <= 0 || !offeredClass) return false;
  const offeredMax = VEHICLE_CLASS_MAX_CHARGEABLE_KG[offeredClass.toUpperCase()];
  if (offeredMax == null || chargeableKg > offeredMax) return false;
  const weightMin = recommendVehicleClass(chargeableKg);
  if (!minClass) return isVehicleClassAdequate(offeredClass, weightMin);
  // Allow when stored min is not far above weight-based min (legacy auto VAN for ≤1000 kg).
  if (vehicleClassRank(minClass) > vehicleClassRank(weightMin) + 1) return false;
  return isVehicleClassAdequate(offeredClass, weightMin);
}

export function gstSplitFromIncCents(incGstCents: number) {
  const ex = Math.round(incGstCents / 1.1);
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
