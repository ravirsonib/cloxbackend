/**
 * Per-stop load profile (PICKUP +, DROPOFF −).
 * Keep in sync with admin/src/lib/job-stop-load.ts
 */

export const STOP_LOAD_BALANCE_TOLERANCE_KG = 0.1;

export type StopLoadInput = {
  sequence?: number;
  stopType: string;
  weightKg?: number | null;
};

export type StopLoadSegment = {
  sequence: number;
  stopType: string;
  weightKg: number | null;
  /** Onboard cargo kg after this stop. */
  onboardKgAfter: number;
};

export type StopLoadProfile = {
  ok: boolean;
  errors: string[];
  /** True when every PICKUP/DROPOFF has a positive weightKg. */
  hasStopWeights: boolean;
  totalPickupKg: number;
  totalDropoffKg: number;
  peakOnboardKg: number;
  segments: StopLoadSegment[];
};

function roundKg(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Walk stops in given order (caller should sort by sequence).
 * When any PICKUP/DROPOFF lacks weight, returns hasStopWeights=false and empty errors
 * (legacy job-level weight path).
 */
export function buildStopLoadProfile(stops: StopLoadInput[]): StopLoadProfile {
  const ordered = stops
    .map((s, i) => ({ ...s, sequence: s.sequence ?? i }))
    .slice()
    .sort((a, b) => a.sequence - b.sequence);

  const cargoStops = ordered.filter(
    (s) => s.stopType === 'PICKUP' || s.stopType === 'DROPOFF',
  );
  const hasStopWeights =
    cargoStops.length > 0 &&
    cargoStops.every(
      (s) => s.weightKg != null && Number.isFinite(s.weightKg) && s.weightKg > 0,
    );

  if (!hasStopWeights) {
    return {
      ok: true,
      errors: [],
      hasStopWeights: false,
      totalPickupKg: 0,
      totalDropoffKg: 0,
      peakOnboardKg: 0,
      segments: ordered.map((s) => ({
        sequence: s.sequence,
        stopType: s.stopType,
        weightKg: s.weightKg ?? null,
        onboardKgAfter: 0,
      })),
    };
  }

  const errors: string[] = [];
  let onboard = 0;
  let peak = 0;
  let totalPickupKg = 0;
  let totalDropoffKg = 0;
  const segments: StopLoadSegment[] = [];

  for (const s of ordered) {
    const w =
      s.weightKg != null && Number.isFinite(s.weightKg) ? Number(s.weightKg) : null;
    if (s.stopType === 'PICKUP' && w != null) {
      onboard = roundKg(onboard + w);
      totalPickupKg = roundKg(totalPickupKg + w);
    } else if (s.stopType === 'DROPOFF' && w != null) {
      onboard = roundKg(onboard - w);
      totalDropoffKg = roundKg(totalDropoffKg + w);
      if (onboard < -STOP_LOAD_BALANCE_TOLERANCE_KG) {
        errors.push(
          `Drop at sequence ${s.sequence} would leave negative onboard load (${onboard} kg)`,
        );
      }
    }
    if (onboard > peak) peak = onboard;
    segments.push({
      sequence: s.sequence,
      stopType: s.stopType,
      weightKg: w,
      onboardKgAfter: Math.max(0, onboard),
    });
  }

  if (Math.abs(totalPickupKg - totalDropoffKg) > STOP_LOAD_BALANCE_TOLERANCE_KG) {
    errors.push(
      `Pickup weights (${totalPickupKg} kg) must equal dropoff weights (${totalDropoffKg} kg)`,
    );
  }
  if (Math.abs(onboard) > STOP_LOAD_BALANCE_TOLERANCE_KG) {
    errors.push(`Route must finish empty (remaining onboard ${onboard} kg)`);
  }

  return {
    ok: errors.length === 0,
    errors,
    hasStopWeights: true,
    totalPickupKg,
    totalDropoffKg,
    peakOnboardKg: peak,
    segments,
  };
}

/** Weight used for vehicle-class recommendation when stop weights exist. */
export function classWeightKgFromProfile(
  profile: StopLoadProfile,
  volumetricKg: number,
  fallbackDeadWeightKg: number,
): number {
  if (profile.hasStopWeights && profile.ok) {
    return Math.max(profile.peakOnboardKg, volumetricKg);
  }
  return Math.max(fallbackDeadWeightKg, volumetricKg);
}
