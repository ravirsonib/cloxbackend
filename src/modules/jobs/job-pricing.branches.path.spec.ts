import {
  carrierNetPayoutCents,
  isVehicleClassAdequate,
  licenceClassRank,
  licenceCoversVehicleClass,
  recommendVehicleClass,
  vehicleClassRank,
} from './job-pricing.util';

describe('job-pricing.util branch leftovers', () => {
  it('vehicleClassRank null / unknown → 0', () => {
    expect(vehicleClassRank(null)).toBe(0);
    expect(vehicleClassRank(undefined)).toBe(0);
    expect(vehicleClassRank('')).toBe(0);
    expect(vehicleClassRank('UNKNOWN')).toBe(0);
    expect(vehicleClassRank('ute')).toBe(1);
  });

  it('licenceClassRank null / unknown → 0', () => {
    expect(licenceClassRank(null)).toBe(0);
    expect(licenceClassRank(undefined)).toBe(0);
    expect(licenceClassRank('ZZ')).toBe(0);
    expect(licenceClassRank('lr')).toBe(2);
  });

  it('isVehicleClassAdequate treats missing min as adequate', () => {
    expect(isVehicleClassAdequate(null, null)).toBe(true);
    expect(isVehicleClassAdequate(undefined, undefined)).toBe(true);
    expect(isVehicleClassAdequate('UTE', '')).toBe(true);
  });

  it('licenceCoversVehicleClass null vehicle / unknown class', () => {
    expect(licenceCoversVehicleClass(null, null)).toBe(false);
    expect(licenceCoversVehicleClass('C', null)).toBe(true);
    expect(licenceCoversVehicleClass(undefined, undefined)).toBe(false);
    expect(licenceCoversVehicleClass('MC', 'NOPE')).toBe(false);
    expect(licenceCoversVehicleClass('C', 'VAN')).toBe(true);
  });

  it('recommendVehicleClass covers every weight band', () => {
    expect(recommendVehicleClass(0)).toBe('UTE');
    expect(recommendVehicleClass(500)).toBe('UTE');
    expect(recommendVehicleClass(501)).toBe('VAN');
    expect(recommendVehicleClass(1200)).toBe('VAN');
    expect(recommendVehicleClass(1201)).toBe('RIGID_1_2T');
    expect(recommendVehicleClass(2500)).toBe('RIGID_1_2T');
    expect(recommendVehicleClass(2501)).toBe('RIGID_3_4T');
    expect(recommendVehicleClass(5000)).toBe('RIGID_3_4T');
    expect(recommendVehicleClass(5001)).toBe('SEMI');
    expect(recommendVehicleClass(15000)).toBe('SEMI');
    expect(recommendVehicleClass(15001)).toBe('BDOUBLE');
  });

  it('carrierNetPayoutCents rounds 70%', () => {
    expect(carrierNetPayoutCents(1)).toBe(1);
    expect(carrierNetPayoutCents(11000)).toBe(7700);
  });
});
