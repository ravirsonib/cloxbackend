/**
 * Gate A pre-trip checklist — NHVR-aligned.
 * Docs: docs/UI-UX-MASTER-SPECIFICATION.md DRV-MOB-03
 *       docs/product/technical-operational-specification.md § Pre-trip checklist
 */

export const NHVR_VEHICLE_SAFETY_GUIDE_URL =
  'https://www.nhvr.gov.au/safety-accreditation-compliance/vehicle-standards-and-safety';

export const NHVR_FATIGUE_GUIDE_URL =
  'https://www.nhvr.gov.au/safety-accreditation-compliance/fatigue-management';

export const TRIP_SAFETY_CHECK_ITEM_IDS = [
  'WHEELS_TYRES',
  'BRAKES_AIR',
  'LIGHTS',
  'ENGINE_FLUIDS',
  'CABIN_SAFETY',
  'LOAD_COUPLINGS',
  'FIT_FOR_DUTY',
] as const;

export type TripSafetyCheckItemId = (typeof TRIP_SAFETY_CHECK_ITEM_IDS)[number];

export function isTripSafetyCheckItemId(value: string): value is TripSafetyCheckItemId {
  return (TRIP_SAFETY_CHECK_ITEM_IDS as readonly string[]).includes(value);
}

/** True when every required checklist item id is present (order-independent). */
export function hasAllTripSafetyCheckItems(
  checkedItemIds: readonly string[] | null | undefined,
): boolean {
  if (!checkedItemIds || checkedItemIds.length < TRIP_SAFETY_CHECK_ITEM_IDS.length) {
    return false;
  }
  const set = new Set(checkedItemIds);
  return TRIP_SAFETY_CHECK_ITEM_IDS.every((id) => set.has(id));
}

export function formatTripSafetyNotes(params: {
  checkedItemIds?: readonly string[] | null;
  notes?: string | null;
  safetySuspend?: boolean;
}): string | null {
  const parts: string[] = [];
  if (params.checkedItemIds && params.checkedItemIds.length > 0) {
    parts.push(`[CHECKLIST] ${[...params.checkedItemIds].sort().join(',')}`);
  }
  const note = params.notes?.trim();
  if (note) parts.push(note);
  if (params.safetySuspend) parts.push('[SAFETY_SUSPEND]');
  return parts.length > 0 ? parts.join('\n') : null;
}
