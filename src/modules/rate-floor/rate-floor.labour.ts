export type LabourPeriodCode =
  | 'WEEKDAY_ORDINARY'
  | 'AFTERNOON'
  | 'NIGHT'
  | 'SATURDAY'
  | 'SUNDAY'
  /** Award multiplier TBD — seeded as Sunday (2.0) until Legal confirms. */
  | 'PUBLIC_HOLIDAY';

export const DEFAULT_LABOUR_MULTIPLIERS: Array<{
  periodCode: LabourPeriodCode;
  multiplier: number;
}> = [
  { periodCode: 'WEEKDAY_ORDINARY', multiplier: 1.0 },
  { periodCode: 'AFTERNOON', multiplier: 1.175 },
  { periodCode: 'NIGHT', multiplier: 1.3 },
  { periodCode: 'SATURDAY', multiplier: 1.5 },
  { periodCode: 'SUNDAY', multiplier: 2.0 },
  // Wave 2.7 stub: same as Sunday until Award public-holiday rate is confirmed.
  { periodCode: 'PUBLIC_HOLIDAY', multiplier: 2.0 },
];

const STATE_TIMEZONES: Record<string, string> = {
  VIC: 'Australia/Melbourne',
  NSW: 'Australia/Sydney',
  ACT: 'Australia/Sydney',
  QLD: 'Australia/Brisbane',
  SA: 'Australia/Adelaide',
  WA: 'Australia/Perth',
  NT: 'Australia/Darwin',
  TAS: 'Australia/Hobart',
};

export function timezoneForPickupState(state?: string | null): string {
  if (!state) return 'Australia/Melbourne';
  const key = state.trim().toUpperCase();
  return STATE_TIMEZONES[key] ?? 'Australia/Melbourne';
}

/** Local calendar date (YYYY-MM-DD) in the given IANA timezone. */
export function localDateIso(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}

/**
 * Resolve PDF §5.1 period from local wall-clock at pickup.
 * When `isPublicHoliday` is true, returns PUBLIC_HOLIDAY (beats weekend/shift).
 * Weekend beats shift; afternoon = after 18:30 before 00:30; night = after 00:30 before 08:30.
 */
export function resolveLabourPeriod(
  at: Date,
  timeZone = 'Australia/Melbourne',
  isPublicHoliday = false,
): LabourPeriodCode {
  if (isPublicHoliday) return 'PUBLIC_HOLIDAY';

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at);

  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  let hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  if (!Number.isFinite(hour)) hour = 0;
  if (hour === 24) hour = 0;

  if (weekday === 'Sat') return 'SATURDAY';
  if (weekday === 'Sun') return 'SUNDAY';

  const mins = hour * 60 + (Number.isFinite(minute) ? minute : 0);
  if (mins >= 18 * 60 + 30 || mins < 30) return 'AFTERNOON';
  if (mins >= 30 && mins < 8 * 60 + 30) return 'NIGHT';
  return 'WEEKDAY_ORDINARY';
}

/** Loaded hourly floor = base + labour × (m − 1). */
export function loadedHourlyFloorCents(
  hourlyFloorCents: number,
  labourRateHrCents: number,
  multiplier: number,
): number {
  const m = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  const labour = Math.max(0, labourRateHrCents);
  const add = labour * (m - 1);
  if (add <= 0) return hourlyFloorCents;
  return Math.ceil(hourlyFloorCents + add - 1e-9);
}
