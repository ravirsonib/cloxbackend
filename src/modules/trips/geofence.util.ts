/** Haversine distance in meters between two WGS84 points. */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function isInsideRadius(
  point: { lat: number; lng: number },
  center: { lat: number; lng: number },
  radiusMeters: number,
): boolean {
  return haversineMeters(point.lat, point.lng, center.lat, center.lng) <= radiusMeters;
}

export type GeofencePolicy = {
  radiusMeters: number;
  antiBounceSamples: number;
  freeWaitPickupMinutes: number;
  freeWaitDropMinutes: number;
  waitingCentsPerMinuteIncGst: number;
  massBaseCentsIncGst: number;
  massPerKgCentsIncGst: number;
  massTolerancePct: number;
  freeWaitSecondsOverride: number | null;
};

export const DEFAULT_GEOFENCE_POLICY: GeofencePolicy = {
  radiusMeters: 200,
  antiBounceSamples: 2,
  freeWaitPickupMinutes: 30,
  freeWaitDropMinutes: 60,
  waitingCentsPerMinuteIncGst: 100,
  massBaseCentsIncGst: 5000,
  massPerKgCentsIncGst: 100,
  massTolerancePct: 2,
  freeWaitSecondsOverride: null,
};

export function parseGeofencePolicy(payload: unknown): GeofencePolicy {
  if (!payload || typeof payload !== 'object') return { ...DEFAULT_GEOFENCE_POLICY };
  const p = payload as Record<string, unknown>;
  const num = (key: string, fallback: number) => {
    const v = p[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  const override = p.freeWaitSecondsOverride;
  return {
    radiusMeters: num('radiusMeters', DEFAULT_GEOFENCE_POLICY.radiusMeters),
    antiBounceSamples: num('antiBounceSamples', DEFAULT_GEOFENCE_POLICY.antiBounceSamples),
    freeWaitPickupMinutes: num(
      'freeWaitPickupMinutes',
      DEFAULT_GEOFENCE_POLICY.freeWaitPickupMinutes,
    ),
    freeWaitDropMinutes: num(
      'freeWaitDropMinutes',
      DEFAULT_GEOFENCE_POLICY.freeWaitDropMinutes,
    ),
    waitingCentsPerMinuteIncGst: num(
      'waitingCentsPerMinuteIncGst',
      DEFAULT_GEOFENCE_POLICY.waitingCentsPerMinuteIncGst,
    ),
    massBaseCentsIncGst: num(
      'massBaseCentsIncGst',
      DEFAULT_GEOFENCE_POLICY.massBaseCentsIncGst,
    ),
    massPerKgCentsIncGst: num(
      'massPerKgCentsIncGst',
      DEFAULT_GEOFENCE_POLICY.massPerKgCentsIncGst,
    ),
    massTolerancePct: num('massTolerancePct', DEFAULT_GEOFENCE_POLICY.massTolerancePct),
    freeWaitSecondsOverride:
      typeof override === 'number' && override > 0 ? override : null,
  };
}

/** Free-wait duration in ms for a stop type, applying DEV seconds override when set. */
export function freeWaitMs(
  stopType: string,
  policy: GeofencePolicy,
  envSecondsOverride?: number,
): number {
  if (envSecondsOverride && envSecondsOverride > 0) {
    return envSecondsOverride * 1000;
  }
  if (policy.freeWaitSecondsOverride && policy.freeWaitSecondsOverride > 0) {
    return policy.freeWaitSecondsOverride * 1000;
  }
  const minutes =
    stopType === 'DROPOFF' ? policy.freeWaitDropMinutes : policy.freeWaitPickupMinutes;
  return minutes * 60_000;
}

/** Whole minutes past freeWaitEndsAt (0 if still in free window). */
export function waitOverageMinutes(freeWaitEndsAt: Date, now = new Date()): number {
  const ms = now.getTime() - freeWaitEndsAt.getTime();
  if (ms <= 0) return 0;
  return Math.floor(ms / 60_000);
}

/** Split inc-GST cents into ex/gst/inc (10% GST inclusive). */
export function splitIncGst(incGstCents: number): {
  amountExGstCents: number;
  amountGstCents: number;
  amountIncGstCents: number;
} {
  const amountIncGstCents = Math.max(0, Math.round(incGstCents));
  const amountExGstCents = Math.round(amountIncGstCents / 1.1);
  const amountGstCents = amountIncGstCents - amountExGstCents;
  return { amountExGstCents, amountGstCents, amountIncGstCents };
}

export function massSurchargeIncGstCents(
  declaredKg: number,
  actualKg: number,
  policy: GeofencePolicy,
): number {
  const overKg = Math.max(0, actualKg - declaredKg);
  return Math.round(policy.massBaseCentsIncGst + overKg * policy.massPerKgCentsIncGst);
}

export function waitingSurchargeIncGstCents(
  overageMinutes: number,
  policy: GeofencePolicy,
): number {
  return Math.max(0, overageMinutes) * policy.waitingCentsPerMinuteIncGst;
}
