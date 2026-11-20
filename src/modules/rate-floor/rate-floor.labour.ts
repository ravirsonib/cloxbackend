import { localDateIso } from '../../shared/timezone';

export { localDateIso };

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

export type HourlyLabourBlock = {
  atIso: string;
  localDate: string;
  periodCode: LabourPeriodCode;
  multiplier: number;
  blockHours: number;
  loadedHourlyFloorCents: number;
  labourAddCents: number;
  blockExGstCents: number;
};

/**
 * IT §4.1 / T12 — walk billable hours in ≤1h blocks; each block resolves its own
 * labour period at the local cursor. OT beyond 7.6h/day is intentionally deferred
 * (Legal/Award — see gap inventory).
 */
export function walkHourlyLabourBlocks(params: {
  startAt: Date;
  hoursCharged: number;
  timeZone: string;
  baseHourlyFloorCents: number;
  labourRateHrCents: number;
  multipliers: Array<{ periodCode: string; multiplier: number }>;
  /** Local YYYY-MM-DD dates that are public holidays in this jurisdiction. */
  holidayDates?: ReadonlySet<string>;
}): HourlyLabourBlock[] {
  const hours = Number.isFinite(params.hoursCharged) ? Math.max(0, params.hoursCharged) : 0;
  if (hours <= 0) return [];

  const multiplierFor = (code: LabourPeriodCode): number => {
    const row =
      params.multipliers.find((m) => m.periodCode === code) ??
      DEFAULT_LABOUR_MULTIPLIERS.find((m) => m.periodCode === code);
    const m = row?.multiplier ?? 1;
    return Number.isFinite(m) && m > 0 ? m : 1;
  };

  const blocks: HourlyLabourBlock[] = [];
  let remaining = hours;
  let cursorMs = params.startAt.getTime();

  while (remaining > 1e-9) {
    const blockHours = Math.min(1, remaining);
    const at = new Date(cursorMs);
    const localDate = localDateIso(at, params.timeZone);
    const isHoliday = params.holidayDates?.has(localDate) ?? false;
    const periodCode = resolveLabourPeriod(at, params.timeZone, isHoliday);
    const multiplier = multiplierFor(periodCode);
    const loaded = loadedHourlyFloorCents(
      params.baseHourlyFloorCents,
      params.labourRateHrCents,
      multiplier,
    );
    const labourAddCents = loaded - params.baseHourlyFloorCents;
    const blockExGstCents = Math.ceil(blockHours * loaded - 1e-9);
    blocks.push({
      atIso: at.toISOString(),
      localDate,
      periodCode,
      multiplier,
      blockHours: Math.round(blockHours * 1000) / 1000,
      loadedHourlyFloorCents: loaded,
      labourAddCents,
      blockExGstCents,
    });
    cursorMs += blockHours * 3_600_000;
    remaining -= blockHours;
  }

  return blocks;
}

/** Distinct local calendar dates touched by an hourly walk (for holiday lookup). */
export function localDatesForHourlyWalk(
  startAt: Date,
  hoursCharged: number,
  timeZone: string,
): string[] {
  const hours = Number.isFinite(hoursCharged) ? Math.max(0, hoursCharged) : 0;
  const dates = new Set<string>();
  let remaining = hours;
  let cursorMs = startAt.getTime();
  if (hours <= 0) {
    dates.add(localDateIso(startAt, timeZone));
    return [...dates];
  }
  while (remaining > 1e-9) {
    const blockHours = Math.min(1, remaining);
    dates.add(localDateIso(new Date(cursorMs), timeZone));
    cursorMs += blockHours * 3_600_000;
    remaining -= blockHours;
  }
  return [...dates];
}
