/**
 * Shared cargo limits for sender job create / recommend.
 * Chargeable kg = max(deadWeight, L×W×Hcm/4000) must also stay within this cap.
 */
export const MAX_JOB_DEAD_WEIGHT_KG = 50_000;
export const MAX_JOB_CHARGEABLE_WEIGHT_KG = 50_000;
export const MAX_JOB_LENGTH_CM = 2_000;
export const MAX_JOB_WIDTH_CM = 500;
export const MAX_JOB_HEIGHT_CM = 500;

export const JOB_WEIGHT_OVER_LIMIT_CODE = 'JOB_WEIGHT_OVER_LIMIT';

/** Chargeable kg = max(dead, L×W×Hcm / 4000). */
export function chargeableWeightKg(params: {
  deadWeightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}): number {
  const volumetric = (params.lengthCm * params.widthCm * params.heightCm) / 4000;
  return Math.max(params.deadWeightKg, volumetric);
}

export function isChargeableOverLimit(chargeableKg: number): boolean {
  return chargeableKg > MAX_JOB_CHARGEABLE_WEIGHT_KG;
}
