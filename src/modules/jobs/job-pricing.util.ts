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
  const volumetric = (params.lengthCm * params.widthCm * params.heightCm) / 4000;
  return Math.max(params.deadWeightKg, volumetric);
}

/** Recommend minimum class from chargeable weight (Phase 1 rules stub). */
export function recommendVehicleClass(chargeableKg: number): string {
  if (chargeableKg <= 500) return 'UTE';
  if (chargeableKg <= 1200) return 'VAN';
  if (chargeableKg <= 2500) return 'RIGID_1_2T';
  if (chargeableKg <= 5000) return 'RIGID_3_4T';
  if (chargeableKg <= 15000) return 'SEMI';
  return 'BDOUBLE';
}

export function gstSplitFromIncCents(incGstCents: number) {
  const ex = Math.round(incGstCents / 1.1);
  const gst = incGstCents - ex;
  return { amountExGstCents: ex, amountGstCents: gst, amountIncGstCents: incGstCents };
}

/** Carrier net display = 70% of gross (G0 share stub). */
export function carrierNetPayoutCents(grossIncGstCents: number): number {
  return Math.round(grossIncGstCents * 0.7);
}
