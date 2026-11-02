import {
  allocateCents,
  assertAdminPool,
  assertNationalPayload,
  CARRIER_PERCENT_FIXED,
} from './revenue-split.types';

describe('revenue-split.types', () => {
  it('assertAdminPool requires sum 30 by default and respects dynamic carrier share', () => {
    expect(() =>
      assertAdminPool({ superPercent: 15, statePercent: 10, localPercent: 5 }),
    ).not.toThrow();
    expect(() =>
      assertAdminPool({ superPercent: 20, statePercent: 10, localPercent: 5 }),
    ).toThrow(/sum to 30/);

    // Dynamic carrier share of 60% leaves 40% admin pool (e.g. Super 25, State 10, Local 5)
    expect(() =>
      assertAdminPool({
        superPercent: 25,
        statePercent: 10,
        localPercent: 5,
        carrierPercent: 60,
      }),
    ).not.toThrow();
    expect(() =>
      assertAdminPool({
        superPercent: 20,
        statePercent: 10,
        localPercent: 5,
        carrierPercent: 60,
      }),
    ).toThrow(/sum to 40/);
  });

  it('assertNationalPayload supports dynamic carrier percent and requires sum 100', () => {
    expect(
      assertNationalPayload({
        carrierPercent: 70,
        superPercent: 12,
        statePercent: 10,
        localPercent: 8,
      }),
    ).toEqual({
      carrierPercent: 70,
      superPercent: 12,
      statePercent: 10,
      localPercent: 8,
    });

    // Dynamic carrier share (e.g. 65% carrier + 35% admin)
    expect(
      assertNationalPayload({
        carrierPercent: 65,
        superPercent: 18,
        statePercent: 10,
        localPercent: 7,
      }),
    ).toEqual({
      carrierPercent: 65,
      superPercent: 18,
      statePercent: 10,
      localPercent: 7,
    });

    // Defaults to 70 if carrierPercent omitted
    expect(
      assertNationalPayload({
        superPercent: 15,
        statePercent: 10,
        localPercent: 5,
      }),
    ).toEqual({
      carrierPercent: 70,
      superPercent: 15,
      statePercent: 10,
      localPercent: 5,
    });

    // Throws if sum != 100
    expect(() =>
      assertNationalPayload({
        carrierPercent: 65,
        superPercent: 15,
        statePercent: 10,
        localPercent: 5,
      }),
    ).toThrow(/Total revenue split must equal 100%/);
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
