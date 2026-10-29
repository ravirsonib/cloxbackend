import {
  allocateCents,
  assertAdminPool,
  assertNationalPayload,
  CARRIER_PERCENT_FIXED,
} from './revenue-split.types';

describe('revenue-split.types', () => {
  it('assertAdminPool requires sum 30', () => {
    expect(() =>
      assertAdminPool({ superPercent: 15, statePercent: 10, localPercent: 5 }),
    ).not.toThrow();
    expect(() =>
      assertAdminPool({ superPercent: 20, statePercent: 10, localPercent: 5 }),
    ).toThrow(/sum to 30/);
  });

  it('assertNationalPayload locks carrier at 70', () => {
    expect(
      assertNationalPayload({
        carrierPercent: 70,
        superPercent: 12,
        statePercent: 10,
        localPercent: 8,
      }),
    ).toEqual({
      carrierPercent: CARRIER_PERCENT_FIXED,
      superPercent: 12,
      statePercent: 10,
      localPercent: 8,
    });
    expect(() =>
      assertNationalPayload({
        carrierPercent: 65,
        superPercent: 15,
        statePercent: 10,
        localPercent: 5,
      }),
    ).toThrow(/carrierPercent/);
  });

  it('allocateCents sums to gross with remainder on local', () => {
    const gross = 10001;
    const parts = allocateCents(gross, {
      carrierPercent: 70,
      superPercent: 15,
      statePercent: 10,
      localPercent: 5,
    });
    expect(parts.carrier + parts.superShare + parts.stateShare + parts.localShare).toBe(
      gross,
    );
  });
});
