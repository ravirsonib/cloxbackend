import {
  orderStopsTspObjects,
  estimateRoute,
  routeFromDistanceKm,
  haversineKm,
} from './routing.mock';

describe('routing.mock', () => {
  describe('orderStopsTspObjects', () => {
    it('keeps ≤2 stops unchanged', () => {
      const stops = [
        { lat: -37.8, lng: 144.9, stopType: 'PICKUP' as const },
        { lat: -37.9, lng: 145.0, stopType: 'DROPOFF' as const },
      ];
      expect(orderStopsTspObjects(stops)).toEqual(stops);
    });

    it('never places DROPOFF before remaining PICKUPs', () => {
      // Geometry that would tempt NN to drop first if unconstrained:
      // start pickup A, dropoff near A, pickup B far away.
      const stops = [
        { id: 'p1', lat: -37.81, lng: 144.96, stopType: 'PICKUP' as const },
        { id: 'd1', lat: -37.812, lng: 144.961, stopType: 'DROPOFF' as const },
        { id: 'p2', lat: -38.1, lng: 145.3, stopType: 'PICKUP' as const },
        { id: 'd2', lat: -38.11, lng: 145.31, stopType: 'DROPOFF' as const },
      ];
      const ordered = orderStopsTspObjects(stops);
      const types = ordered.map((s) => s.stopType);
      const firstDrop = types.indexOf('DROPOFF');
      const lastPick = types.lastIndexOf('PICKUP');
      expect(firstDrop).toBeGreaterThan(lastPick);
      expect(ordered.map((s) => s.id).slice(0, 2)).toEqual(['p1', 'p2']);
    });

    it('preserves object identity', () => {
      const a = { lat: 0, lng: 0, stopType: 'PICKUP' as const, seq: 1 };
      const b = { lat: 1, lng: 1, stopType: 'DROPOFF' as const, seq: 2 };
      const c = { lat: 0.5, lng: 0.5, stopType: 'PICKUP' as const, seq: 3 };
      const ordered = orderStopsTspObjects([a, b, c]);
      expect(ordered).toContain(a);
      expect(ordered).toContain(b);
      expect(ordered).toContain(c);
    });
  });

  describe('routeFromDistanceKm', () => {
    it('persists sender km and null billable for PER_KM', () => {
      const r = routeFromDistanceKm(42.5, 'PER_KM');
      expect(r.distanceKm).toBe(42.5);
      expect(r.billableHours).toBeNull();
      expect(r.drivingMinutes).toBe(Math.round((42.5 / 60) * 60));
    });

    it('applies hourly 4h floor for short distance', () => {
      const r = routeFromDistanceKm(10, 'HOURLY');
      expect(r.billableHours).toBe(4);
    });
  });

  describe('estimateRoute', () => {
    it('applies hourly 4h floor', () => {
      const r = estimateRoute({
        stops: [
          { lat: -37.81, lng: 144.96 },
          { lat: -37.82, lng: 144.97 },
        ],
        pricingModel: 'HOURLY',
      });
      expect(r.billableHours).toBe(4);
      expect(r.mock).toBe(true);
    });

    it('PER_KM has null billableHours', () => {
      const r = estimateRoute({
        stops: [
          { lat: -37.81, lng: 144.96 },
          { lat: -38.0, lng: 145.2 },
        ],
        pricingModel: 'PER_KM',
      });
      expect(r.billableHours).toBeNull();
      expect(r.distanceKm).toBeGreaterThan(0);
    });
  });

  describe('haversineKm', () => {
    it('is ~0 for identical points', () => {
      expect(haversineKm({ lat: 1, lng: 2 }, { lat: 1, lng: 2 })).toBeLessThan(0.001);
    });
  });
});
