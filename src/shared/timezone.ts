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
