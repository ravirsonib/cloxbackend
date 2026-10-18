import {
  freeWaitMs,
  parseGeofencePolicy,
  waitOverageMinutes,
} from './geofence.util';

describe('geofence.util branch leftovers', () => {
  it('parseGeofencePolicy falls back for null / non-object / bad numbers', () => {
    expect(parseGeofencePolicy(null).radiusMeters).toBe(200);
    expect(parseGeofencePolicy('nope').antiBounceSamples).toBe(2);
    expect(
      parseGeofencePolicy({
        radiusMeters: 'x',
        freeWaitSecondsOverride: 0,
        massTolerancePct: Number.NaN,
      }).freeWaitSecondsOverride,
    ).toBeNull();
    expect(
      parseGeofencePolicy({ freeWaitSecondsOverride: 15 }).freeWaitSecondsOverride,
    ).toBe(15);
  });

  it('freeWaitMs uses policy override and DROPOFF minutes', () => {
    const policy = parseGeofencePolicy({
      freeWaitSecondsOverride: 9,
      freeWaitDropMinutes: 45,
      freeWaitPickupMinutes: 30,
    });
    expect(freeWaitMs('PICKUP', policy)).toBe(9_000);
    expect(freeWaitMs('DROPOFF', parseGeofencePolicy({}), undefined)).toBe(
      60 * 60_000,
    );
    expect(freeWaitMs('PICKUP', parseGeofencePolicy({}), 0)).toBe(30 * 60_000);
  });

  it('waitOverageMinutes default now is still in free window for future end', () => {
    const ends = new Date(Date.now() + 60_000);
    expect(waitOverageMinutes(ends)).toBe(0);
  });
});
