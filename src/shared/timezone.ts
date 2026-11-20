/**
 * Canonical Australian timezones for platform operations.
 */
export const AU_STATE_TIMEZONES: Record<string, string> = {
  NSW: 'Australia/Sydney',
  VIC: 'Australia/Melbourne',
  ACT: 'Australia/Sydney',
  TAS: 'Australia/Hobart',
  QLD: 'Australia/Brisbane',
  SA: 'Australia/Adelaide',
  NT: 'Australia/Darwin',
  WA: 'Australia/Perth',
};

/**
 * Single platform-wide reference timezone (AEST / AEDT).
 */
export const PLATFORM_TIMEZONE = 'Australia/Sydney';

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

/** Prisma `@db.Date` value for a YYYY-MM-DD calendar day (UTC midnight). */
export function utcDateFromLocalDateIso(dateIso: string): Date {
  return new Date(`${dateIso}T00:00:00.000Z`);
}
