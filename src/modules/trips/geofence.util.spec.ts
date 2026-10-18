import {
  freeWaitMs,
  haversineMeters,
  isInsideRadius,
  massSurchargeIncGstCents,
  parseGeofencePolicy,
  splitIncGst,
  waitOverageMinutes,
  waitingSurchargeIncGstCents,
  type GeofencePolicy,
} from './geofence.util';

describe('geofence.util', () => {
  it('haversine ~0 for same point', () => {
    expect(haversineMeters(-37.8136, 144.9631, -37.8136, 144.9631)).toBeLessThan(0.01);
  });

  it('isInsideRadius for 200m', () => {
    const center = { lat: -37.8136, lng: 144.9631 };
    expect(isInsideRadius(center, center, 200)).toBe(true);
    // ~1.1 km north
    expect(isInsideRadius({ lat: -37.8036, lng: 144.9631 }, center, 200)).toBe(false);
  });

  it('waitOverageMinutes', () => {
    const ends = new Date('2026-01-01T12:00:00.000Z');
    expect(waitOverageMinutes(ends, new Date('2026-01-01T11:59:00.000Z'))).toBe(0);
    expect(waitOverageMinutes(ends, new Date('2026-01-01T12:05:30.000Z'))).toBe(5);
  });

  it('freeWaitMs uses seconds override', () => {
    const policy = parseGeofencePolicy({ freeWaitPickupMinutes: 30 });
    expect(freeWaitMs('PICKUP', policy, 30)).toBe(30_000);
    expect(freeWaitMs('PICKUP', policy, 0)).toBe(30 * 60_000);
  });

  it('mass and waiting surcharge formulas', () => {
    const policy: GeofencePolicy = parseGeofencePolicy({});
    expect(massSurchargeIncGstCents(100, 120, policy)).toBe(5000 + 20 * 100);
    expect(waitingSurchargeIncGstCents(3, policy)).toBe(300);
  });

  it('splitIncGst adds to total', () => {
    const s = splitIncGst(1100);
    expect(s.amountExGstCents + s.amountGstCents).toBe(1100);
  });
});
