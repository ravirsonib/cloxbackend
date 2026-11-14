import {
  estimateRangeIncGstCents,
  quoteForModel,
  quoteHourlyIncGstCents,
  quotePerKmIncGstCents,
  resolveClassRates,
} from './class-pricing.util';
import { DEFAULT_VEHICLE_CLASSES } from './job-pricing.util';

const legacy = {
  perKmRateCents: 250,
  hourlyRateCents: 8000,
  perKmMinBaseCents: 5000,
  hourlyMinBaseCents: 20000,
  hourlyMinFloorHours: 4,
  gstPercent: 10,
};

describe('class-pricing.util', () => {
  it('resolves UTE vs SEMI with different per-km rates', () => {
    const ute = resolveClassRates(
      'UTE',
      DEFAULT_VEHICLE_CLASSES.find((c) => c.code === 'UTE'),
      legacy,
    );
    const semi = resolveClassRates(
      'SEMI',
      DEFAULT_VEHICLE_CLASSES.find((c) => c.code === 'SEMI'),
      legacy,
    );
    expect(ute.perKmRateCents).toBe(250);
    expect(semi.perKmRateCents).toBe(775);
    expect(quotePerKmIncGstCents(ute, 100, legacy.perKmMinBaseCents)).toBeLessThan(
      quotePerKmIncGstCents(semi, 100, legacy.perKmMinBaseCents),
    );
  });

  it('hourly quote respects class rate and 4h floor hours', () => {
    const ute = resolveClassRates(
      'UTE',
      DEFAULT_VEHICLE_CLASSES.find((c) => c.code === 'UTE'),
      legacy,
    );
    const q = quoteHourlyIncGstCents(ute, 4, legacy.hourlyMinBaseCents);
    expect(q).toBe(Math.max(legacy.hourlyMinBaseCents, ute.hourlyMinBaseCents, 4 * ute.hourlyRateCents));
  });

  it('falls back to PlatformSettings globals when class has no rates', () => {
    const rates = resolveClassRates(
      'CUSTOM',
      {
        code: 'CUSTOM',
        rank: 99,
        maxChargeableWeightKg: 1,
        maxLengthCm: 1,
        maxWidthCm: 1,
        maxHeightCm: 1,
        minLicenceClass: 'C',
      },
      legacy,
    );
    expect(rates.perKmRateCents).toBe(legacy.perKmRateCents);
    expect(rates.hourlyRateCents).toBe(legacy.hourlyRateCents);
    expect(rates.usedLegacyFallback).toBe(true);
  });

  it('estimate range uses next larger class as max', () => {
    const range = estimateRangeIncGstCents({
      pricingModel: 'PER_KM',
      pricingClass: 'UTE',
      classes: DEFAULT_VEHICLE_CLASSES,
      legacy,
      distanceKm: 50,
      billableHours: null,
    });
    expect(range.maxClassCode).toBe('VAN');
    expect(range.maxIncGstCents).toBeGreaterThanOrEqual(range.minIncGstCents);
  });

  it('quoteForModel PER_KM uses distance × class rate', () => {
    const rates = resolveClassRates(
      'VAN',
      DEFAULT_VEHICLE_CLASSES.find((c) => c.code === 'VAN'),
      legacy,
    );
    const q = quoteForModel({
      pricingModel: 'PER_KM',
      rates,
      distanceKm: 40,
      billableHours: null,
      hourlyMinFloorHours: 4,
      globalHardFloorCents: legacy.perKmMinBaseCents,
    });
    expect(q).toBe(Math.max(legacy.perKmMinBaseCents, rates.perKmMinBaseCents, 40 * 300));
  });
});
