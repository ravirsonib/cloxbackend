import {
  DEFAULT_GEOFENCE_POLICY,
  freeWaitMs,
} from './geofence.util';

describe('geofence.util freeWaitSecondsOverride leftover', () => {
  it('uses policy.freeWaitSecondsOverride when env override absent', () => {
    const ms = freeWaitMs('PICKUP', {
      ...DEFAULT_GEOFENCE_POLICY,
      freeWaitSecondsOverride: 12,
    });
    expect(ms).toBe(12_000);
  });
});
