export type BodyCode =
  | 'DRY'
  | 'TAILLIFT'
  | 'REEFER'
  | 'TIPPER'
  | 'CRANE'
  | 'TANKER'
  | 'DG'
  | 'LIVESTOCK';

export type DefaultBodyLoading = {
  bodyCode: BodyCode;
  loadingPct: number;
  /** When set, raises hourly min engagement (e.g. crane = 4). */
  minHours: number | null;
};

/** PDF §4.4 DERIVED loadings — editable per floor version. */
export const DEFAULT_BODY_LOADINGS: DefaultBodyLoading[] = [
  { bodyCode: 'DRY', loadingPct: 0, minHours: null },
  { bodyCode: 'TAILLIFT', loadingPct: 5, minHours: null },
  { bodyCode: 'REEFER', loadingPct: 20, minHours: null },
  { bodyCode: 'TIPPER', loadingPct: 5, minHours: null },
  { bodyCode: 'CRANE', loadingPct: 60, minHours: 4 },
  { bodyCode: 'TANKER', loadingPct: 10, minHours: null },
  { bodyCode: 'DG', loadingPct: 12.5, minHours: null },
  { bodyCode: 'LIVESTOCK', loadingPct: 10, minHours: null },
];

/** Classes whose Section 4 floors already embed specialised body — skip stacking. */
const SPECIALISED_CLASS_CODES = new Set(['REEFER', 'CRANE']);

export function inferBodyCode(input: {
  bodyCode?: string | null;
  vehicleClassCode?: string | null;
  requiresReefer?: boolean | null;
  requiresDg?: boolean | null;
}): BodyCode {
  const explicit = input.bodyCode?.trim().toUpperCase();
  if (explicit) {
    const known = DEFAULT_BODY_LOADINGS.find((b) => b.bodyCode === explicit);
    if (known) return known.bodyCode;
  }

  const klass = input.vehicleClassCode?.trim().toUpperCase() ?? '';
  if (SPECIALISED_CLASS_CODES.has(klass)) return 'DRY';

  if (input.requiresReefer) return 'REEFER';
  if (input.requiresDg) return 'DG';
  return 'DRY';
}
