/**
 * Multi-unit RWC / COI — shared choke-point for required combination units.
 * Docs: docs/product/multi-unit-rwc-coi-implementation-plan.md
 */

export type VehicleUnitRoleCode = 'POWERED' | 'TRAILER_1' | 'TRAILER_2' | 'TRAILER_3';

export type CombinationConfigCode =
  | 'NONE'
  | 'SEMI'
  | 'BDOUBLE'
  | 'RT_DOUBLE'
  | 'RT_TRIPLE';

export const VEHICLE_UNIT_ROLE_LABELS: Record<VehicleUnitRoleCode, string> = {
  POWERED: 'Powered unit (prime mover / truck)',
  TRAILER_1: 'Trailer 1',
  TRAILER_2: 'Trailer 2',
  TRAILER_3: 'Trailer 3',
};

/** Classes that always require two registered units (powered + trailer). */
const TWO_UNIT_CLASSES = new Set(['SEMI', 'CONTAINER']);

/** Eligible RWC/COI statuses for fleet gates (same as prior single-RWC rule). */
export const RWC_ELIGIBLE_STATUSES = new Set(['UPLOADED', 'UNDER_REVIEW', 'APPROVED']);

export function defaultCombinationConfigForClass(
  vehicleClass: string | null | undefined,
): CombinationConfigCode {
  const cls = (vehicleClass ?? '').trim().toUpperCase();
  if (TWO_UNIT_CLASSES.has(cls)) return 'SEMI';
  if (cls === 'BDOUBLE') return 'BDOUBLE';
  if (cls === 'ROAD_TRAIN') return 'RT_DOUBLE';
  return 'NONE';
}

/**
 * Resolve required unit roles for a vehicle class + optional combination config.
 * ROAD_TRAIN uses combinationConfig (RT_DOUBLE = 3, RT_TRIPLE = 4); others derive from class.
 */
export function requiredUnitsForVehicle(
  vehicleClass: string | null | undefined,
  combinationConfig?: CombinationConfigCode | null,
): VehicleUnitRoleCode[] {
  const cls = (vehicleClass ?? '').trim().toUpperCase();
  const config =
    combinationConfig && combinationConfig !== 'NONE'
      ? combinationConfig
      : defaultCombinationConfigForClass(cls);

  switch (config) {
    case 'SEMI':
      return ['POWERED', 'TRAILER_1'];
    case 'BDOUBLE':
      return ['POWERED', 'TRAILER_1', 'TRAILER_2'];
    case 'RT_DOUBLE':
      return ['POWERED', 'TRAILER_1', 'TRAILER_2'];
    case 'RT_TRIPLE':
      return ['POWERED', 'TRAILER_1', 'TRAILER_2', 'TRAILER_3'];
    case 'NONE':
    default:
      return ['POWERED'];
  }
}

export type UnitRwcSnapshot = {
  status: string;
  expiresAt?: Date | string | null;
};

export type UnitCompletenessInput = {
  role: VehicleUnitRoleCode;
  registration?: string | null;
  rwc?: UnitRwcSnapshot | null;
};

export type UnitCompletenessResult = {
  ok: boolean;
  missingRoles: VehicleUnitRoleCode[];
  missingRegistration: VehicleUnitRoleCode[];
  missingRwc: VehicleUnitRoleCode[];
  expiredRwc: VehicleUnitRoleCode[];
};

function isRwcValid(rwc: UnitRwcSnapshot | null | undefined, now: Date): boolean {
  if (!rwc) return false;
  if (!RWC_ELIGIBLE_STATUSES.has(rwc.status)) return false;
  if (rwc.expiresAt != null) {
    const exp = rwc.expiresAt instanceof Date ? rwc.expiresAt : new Date(rwc.expiresAt);
    if (!Number.isNaN(exp.getTime()) && exp.getTime() <= now.getTime()) return false;
  }
  return true;
}

/**
 * Assert every required role has registration + non-expired eligible RWC/COI.
 */
export function assertUnitsComplete(
  vehicleClass: string | null | undefined,
  combinationConfig: CombinationConfigCode | null | undefined,
  units: UnitCompletenessInput[],
  now: Date = new Date(),
): UnitCompletenessResult {
  const required = requiredUnitsForVehicle(vehicleClass, combinationConfig);
  const byRole = new Map(units.map((u) => [u.role, u]));

  const missingRoles: VehicleUnitRoleCode[] = [];
  const missingRegistration: VehicleUnitRoleCode[] = [];
  const missingRwc: VehicleUnitRoleCode[] = [];
  const expiredRwc: VehicleUnitRoleCode[] = [];

  for (const role of required) {
    const unit = byRole.get(role);
    if (!unit) {
      missingRoles.push(role);
      continue;
    }
    if (!unit.registration?.trim()) {
      missingRegistration.push(role);
    }
    const rwc = unit.rwc;
    if (!rwc || !RWC_ELIGIBLE_STATUSES.has(rwc.status)) {
      missingRwc.push(role);
    } else if (rwc.expiresAt != null) {
      const exp = rwc.expiresAt instanceof Date ? rwc.expiresAt : new Date(rwc.expiresAt);
      if (!Number.isNaN(exp.getTime()) && exp.getTime() <= now.getTime()) {
        expiredRwc.push(role);
      }
    }
  }

  const ok =
    missingRoles.length === 0 &&
    missingRegistration.length === 0 &&
    missingRwc.length === 0 &&
    expiredRwc.length === 0;

  return { ok, missingRoles, missingRegistration, missingRwc, expiredRwc };
}

/** Aggregate pill: worst unit wins — EXPIRED > EXPIRING > PENDING > OK > MISSING. */
export type UnitRwcPill = 'OK' | 'PENDING' | 'EXPIRING' | 'EXPIRED' | 'MISSING';

export function pillForUnitRwc(
  rwc: UnitRwcSnapshot | null | undefined,
  now: Date = new Date(),
  expiringWithinMs = 30 * 24 * 60 * 60 * 1000,
): UnitRwcPill {
  if (!rwc || !RWC_ELIGIBLE_STATUSES.has(rwc.status)) return 'MISSING';
  if (rwc.expiresAt != null) {
    const exp = rwc.expiresAt instanceof Date ? rwc.expiresAt : new Date(rwc.expiresAt);
    if (!Number.isNaN(exp.getTime())) {
      if (exp.getTime() <= now.getTime()) return 'EXPIRED';
      if (exp.getTime() - now.getTime() <= expiringWithinMs) return 'EXPIRING';
    }
  }
  if (rwc.status === 'UPLOADED' || rwc.status === 'UNDER_REVIEW') return 'PENDING';
  return 'OK';
}

const PILL_RANK: Record<UnitRwcPill, number> = {
  EXPIRED: 4,
  EXPIRING: 3,
  PENDING: 2,
  MISSING: 1,
  OK: 0,
};

export function aggregateUnitPills(pills: UnitRwcPill[]): UnitRwcPill {
  if (pills.length === 0) return 'MISSING';
  return pills.reduce((worst, p) => (PILL_RANK[p] > PILL_RANK[worst] ? p : worst), 'OK' as UnitRwcPill);
}

export { isRwcValid };
