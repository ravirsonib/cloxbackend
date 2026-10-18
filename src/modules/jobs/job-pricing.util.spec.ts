import {
  chargeableWeightKg,
  isVehicleClassAdequate,
  licenceCoversVehicleClass,
  recommendVehicleClass,
} from './job-pricing.util';
import { estimateRoute } from './routing.mock';

describe('job-pricing.util', () => {
  it('chargeable uses volumetric when larger', () => {
    expect(
      chargeableWeightKg({ deadWeightKg: 100, lengthCm: 200, widthCm: 100, heightCm: 100 }),
    ).toBe(500);
  });

  it('recommends class from weight', () => {
    expect(recommendVehicleClass(400)).toBe('UTE');
    expect(recommendVehicleClass(2000)).toBe('RIGID_1_2T');
  });

  it('blocks undersize', () => {
    expect(isVehicleClassAdequate('UTE', 'RIGID_1_2T')).toBe(false);
    expect(isVehicleClassAdequate('SEMI', 'RIGID_1_2T')).toBe(true);
  });

  it('licence must cover vehicle class', () => {
    expect(licenceCoversVehicleClass('C', 'UTE')).toBe(true);
    expect(licenceCoversVehicleClass('C', 'SEMI')).toBe(false);
    expect(licenceCoversVehicleClass('HC', 'SEMI')).toBe(true);
    expect(licenceCoversVehicleClass('HC', 'BDOUBLE')).toBe(false);
    expect(licenceCoversVehicleClass('MC', 'BDOUBLE')).toBe(true);
    expect(licenceCoversVehicleClass('HR', 'RIGID_3_4T')).toBe(true);
    expect(licenceCoversVehicleClass('MR', 'RIGID_1_2T')).toBe(true);
  });
});

describe('routing.mock', () => {
  it('inserts fatigue break when long distance', () => {
    // ~400 km road ≈ > 5.25h at 60km/h with factor
    const a = { lat: -37.81, lng: 144.96 };
    const b = { lat: -33.86, lng: 151.21 }; // Melbourne → Sydney ~700+ km road
    const route = estimateRoute({ stops: [a, b], pricingModel: 'PER_KM' });
    expect(route.fatigueBreakMinutes).toBe(15);
    expect(route.mock).toBe(true);
  });

  it('hourly floors at 4 hours', () => {
    const a = { lat: -37.81, lng: 144.96 };
    const b = { lat: -37.82, lng: 144.97 };
    const route = estimateRoute({ stops: [a, b], pricingModel: 'HOURLY' });
    expect(route.billableHours).toBeGreaterThanOrEqual(4);
  });
});
