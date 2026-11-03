import { gstSplitFromIncCents, carrierNetPayoutCents, vehicleClassRank, licenceClassRank } from './job-pricing.util';

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

  it('ranks increase with class size', () => {
    expect(vehicleClassRank('UTE')).toBeLessThan(vehicleClassRank('SEMI'));
    expect(licenceClassRank('C')).toBeLessThan(licenceClassRank('MC'));
  });
});
