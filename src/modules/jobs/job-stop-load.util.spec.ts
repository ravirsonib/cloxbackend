import {
  buildStopLoadProfile,
  classWeightKgFromProfile,
} from './job-stop-load.util';

describe('buildStopLoadProfile', () => {
  it('Pattern A: three pickups then one drop — peak is sum, finishes empty', () => {
    const profile = buildStopLoadProfile([
      { sequence: 0, stopType: 'PICKUP', weightKg: 500 },
      { sequence: 1, stopType: 'PICKUP', weightKg: 10_000 },
      { sequence: 2, stopType: 'PICKUP', weightKg: 4000 },
      { sequence: 3, stopType: 'DROPOFF', weightKg: 14_500 },
    ]);
    expect(profile.ok).toBe(true);
    expect(profile.hasStopWeights).toBe(true);
    expect(profile.totalPickupKg).toBe(14_500);
    expect(profile.peakOnboardKg).toBe(14_500);
    expect(profile.segments.map((s) => s.onboardKgAfter)).toEqual([
      500, 10_500, 14_500, 0,
    ]);
  });

  it('interleaved pick/drop — peak can be less than total freight moved', () => {
    // 500 on → drop 500 → 10000 on → drop 10000 (scaled to 4 stops)
    const profile = buildStopLoadProfile([
      { sequence: 0, stopType: 'PICKUP', weightKg: 500 },
      { sequence: 1, stopType: 'DROPOFF', weightKg: 500 },
      { sequence: 2, stopType: 'PICKUP', weightKg: 10_000 },
      { sequence: 3, stopType: 'DROPOFF', weightKg: 10_000 },
    ]);
    expect(profile.ok).toBe(true);
    expect(profile.totalPickupKg).toBe(10_500);
    expect(profile.peakOnboardKg).toBe(10_000);
    expect(profile.segments.map((s) => s.onboardKgAfter)).toEqual([
      500, 0, 10_000, 0,
    ]);
  });

  it('rejects unbalanced pickup vs drop totals', () => {
    const profile = buildStopLoadProfile([
      { sequence: 0, stopType: 'PICKUP', weightKg: 800 },
      { sequence: 1, stopType: 'DROPOFF', weightKg: 500 },
    ]);
    expect(profile.ok).toBe(false);
    expect(profile.errors.some((e) => e.includes('must equal'))).toBe(true);
  });

  it('rejects drop that would go negative onboard', () => {
    const profile = buildStopLoadProfile([
      { sequence: 0, stopType: 'PICKUP', weightKg: 500 },
      { sequence: 1, stopType: 'DROPOFF', weightKg: 800 },
      { sequence: 2, stopType: 'PICKUP', weightKg: 300 },
      { sequence: 3, stopType: 'DROPOFF', weightKg: 0 }, // invalid weight → not hasStopWeights
    ]);
    // weight 0 on last drop → treated as missing stop weights
    expect(profile.hasStopWeights).toBe(false);

    const neg = buildStopLoadProfile([
      { sequence: 0, stopType: 'PICKUP', weightKg: 500 },
      { sequence: 1, stopType: 'DROPOFF', weightKg: 800 },
    ]);
    expect(neg.ok).toBe(false);
    expect(neg.errors.some((e) => e.includes('negative'))).toBe(true);
  });

  it('legacy: missing weights skips balance rules', () => {
    const profile = buildStopLoadProfile([
      { sequence: 0, stopType: 'PICKUP' },
      { sequence: 1, stopType: 'DROPOFF' },
    ]);
    expect(profile.ok).toBe(true);
    expect(profile.hasStopWeights).toBe(false);
  });
});

describe('classWeightKgFromProfile', () => {
  it('uses peak vs volumetric when stop weights present', () => {
    const profile = buildStopLoadProfile([
      { sequence: 0, stopType: 'PICKUP', weightKg: 500 },
      { sequence: 1, stopType: 'DROPOFF', weightKg: 500 },
      { sequence: 2, stopType: 'PICKUP', weightKg: 10_000 },
      { sequence: 3, stopType: 'DROPOFF', weightKg: 10_000 },
    ]);
    expect(classWeightKgFromProfile(profile, 200, 10_500)).toBe(10_000);
    expect(classWeightKgFromProfile(profile, 12_000, 10_500)).toBe(12_000);
  });

  it('falls back to max(dead, volumetric) without stop weights', () => {
    const profile = buildStopLoadProfile([
      { sequence: 0, stopType: 'PICKUP' },
      { sequence: 1, stopType: 'DROPOFF' },
    ]);
    expect(classWeightKgFromProfile(profile, 900, 800)).toBe(900);
  });
});
