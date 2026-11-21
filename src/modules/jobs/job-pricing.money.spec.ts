import {
  gstSplitFromIncCents,
  carrierNetPayoutCents,
  grossFromCarrierNetCents,
  minCarrierNetClearingGrossFloor,
  vehicleClassRank,
  licenceClassRank,
} from './job-pricing.util';

describe('job-pricing money helpers', () => {
  it('gstSplitFromIncCents splits 1/11 GST', () => {
    const s = gstSplitFromIncCents(11000);
    expect(s.amountGstCents).toBe(1000);
    expect(s.amountExGstCents).toBe(10000);
    expect(s.amountIncGstCents).toBe(11000);
  });

  it('gstSplitFromIncCents supports custom GST rates', () => {
    const s15 = gstSplitFromIncCents(11500, 15);
    expect(s15.amountGstCents).toBe(1500);
    expect(s15.amountExGstCents).toBe(10000);

    const s0 = gstSplitFromIncCents(10000, 0);
    expect(s0.amountGstCents).toBe(0);
    expect(s0.amountExGstCents).toBe(10000);
  });

  it('carrierNetPayoutCents is 70%', () => {
    expect(carrierNetPayoutCents(10000)).toBe(7000);
  });

  it('grossFromCarrierNetCents inverts net at carrier %', () => {
    expect(grossFromCarrierNetCents(7000, 70)).toBe(10000);
    expect(carrierNetPayoutCents(grossFromCarrierNetCents(9000, 70), 70)).toBeGreaterThanOrEqual(
      9000,
    );
    // No under-pay: typed net always clears after round-trip.
    for (const n of [1, 99, 7000, 9000, 12345, 99999]) {
      expect(carrierNetPayoutCents(grossFromCarrierNetCents(n, 70), 70)).toBeGreaterThanOrEqual(n);
    }
  });

  it('minCarrierNetClearingGrossFloor never under-converts', () => {
    for (const minGross of [10_000, 20_001, 50_000, 14287]) {
      const minNet = minCarrierNetClearingGrossFloor(minGross, 70);
      expect(grossFromCarrierNetCents(minNet, 70)).toBeGreaterThanOrEqual(minGross);
    }
  });

  it('money helpers reject NaN / Infinity / non-finite without looping', () => {
    expect(carrierNetPayoutCents(Number.NaN, 70)).toBe(0);
    expect(carrierNetPayoutCents(10_000, Number.NaN)).toBe(0);
    expect(carrierNetPayoutCents(Number.POSITIVE_INFINITY, 70)).toBe(0);
    expect(carrierNetPayoutCents(10_000, Number.POSITIVE_INFINITY)).toBe(0);

    expect(grossFromCarrierNetCents(Number.NaN, 70)).toBe(0);
    expect(grossFromCarrierNetCents(0, 70)).toBe(0);
    expect(grossFromCarrierNetCents(-5, 70)).toBe(0);
    expect(grossFromCarrierNetCents(7000, Number.NaN)).toBe(0);
    expect(grossFromCarrierNetCents(7000, Number.POSITIVE_INFINITY)).toBe(0);

    expect(minCarrierNetClearingGrossFloor(Number.NaN, 70)).toBe(1);
    expect(minCarrierNetClearingGrossFloor(0, 70)).toBe(1);
    expect(minCarrierNetClearingGrossFloor(10_000, Number.NaN)).toBe(1);
  });

  it('grossFromCarrierNetCents clamps extreme carrier %', () => {
    // trunc + clamp to [1,99]
    expect(carrierNetPayoutCents(grossFromCarrierNetCents(1000, 0.4), 1)).toBeGreaterThanOrEqual(
      1000,
    );
    expect(carrierNetPayoutCents(grossFromCarrierNetCents(1000, 150), 99)).toBeGreaterThanOrEqual(
      1000,
    );
  });

  it('1-cent and odd cent round-trips never under-pay', () => {
    for (const n of [1, 2, 3, 7, 13, 99, 101, 333, 1001, 7777]) {
      for (const pct of [50, 65, 70, 80, 99]) {
        const gross = grossFromCarrierNetCents(n, pct);
        expect(Number.isFinite(gross)).toBe(true);
        expect(gross).toBeGreaterThan(0);
        expect(carrierNetPayoutCents(gross, pct)).toBeGreaterThanOrEqual(n);
      }
    }
  });

  it('ranks increase with class size', () => {
    expect(vehicleClassRank('UTE')).toBeLessThan(vehicleClassRank('SEMI'));
    expect(licenceClassRank('C')).toBeLessThan(licenceClassRank('MC'));
  });
});
