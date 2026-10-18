import {
  estimateRoute,
  orderStopsTsp,
  orderStopsTspObjects,
} from './routing.mock';

describe('routing.mock leftovers', () => {
  it('estimateRoute returns zeros for fewer than 2 stops', () => {
    expect(estimateRoute({ stops: [{ lat: 0, lng: 0 }], pricingModel: 'PER_KM' })).toMatchObject({
      distanceKm: 0,
      billableHours: null,
      mock: true,
    });
    expect(
      estimateRoute({ stops: [{ lat: 0, lng: 0 }], pricingModel: 'HOURLY' }).billableHours,
    ).toBe(4);
  });

  it('orderStopsTspObjects falls back to nearestNeighbour when no stopType', () => {
    const stops = [
      { lat: -37.8, lng: 144.9 },
      { lat: -37.81, lng: 144.95 },
      { lat: -37.82, lng: 145.0 },
    ];
    const ordered = orderStopsTspObjects(stops);
    expect(ordered[0]).toEqual(stops[0]);
    expect(ordered).toHaveLength(3);
  });

  it('orderStopsTspObjects with only DROPOFFs and other types', () => {
    const stops = [
      { lat: -37.8, lng: 144.9, stopType: 'WAYPOINT' },
      { lat: -37.81, lng: 144.95, stopType: 'DROPOFF' },
      { lat: -37.82, lng: 145.0, stopType: 'DROPOFF' },
    ];
    const ordered = orderStopsTspObjects(stops);
    expect(ordered.map((s) => s.stopType)).toEqual(['WAYPOINT', 'DROPOFF', 'DROPOFF']);
  });

  it('orderStopsTsp delegates to orderStopsTspObjects', () => {
    const stops = [
      { lat: -37.8, lng: 144.9 },
      { lat: -37.9, lng: 145.0 },
    ];
    expect(orderStopsTsp(stops)).toEqual(orderStopsTspObjects(stops));
  });

  it('orderStopsTspObjects keeps ≤2 stops and PICKUP-first with no dropoffs', () => {
    const two = [
      { lat: -37.8, lng: 144.9, stopType: 'PICKUP' },
      { lat: -37.81, lng: 144.95, stopType: 'PICKUP' },
    ];
    expect(orderStopsTspObjects(two)).toEqual(two);

    const pickupsOnly = [
      { lat: -37.8, lng: 144.9, stopType: 'PICKUP' },
      { lat: -37.81, lng: 144.95, stopType: 'PICKUP' },
      { lat: -37.82, lng: 145.0, stopType: 'PICKUP' },
    ];
    const ordered = orderStopsTspObjects(pickupsOnly);
    expect(ordered[0].stopType).toBe('PICKUP');
    expect(ordered).toHaveLength(3);

    // pickups + empty dropoffs → nearestNeighbourOrderFrom(start, [])
    const pickupAndWaypoint = [
      { lat: -37.8, lng: 144.9, stopType: 'PICKUP' },
      { lat: -37.81, lng: 144.95, stopType: 'WAYPOINT' },
      { lat: -37.82, lng: 145.0, stopType: 'PICKUP' },
    ];
    expect(orderStopsTspObjects(pickupAndWaypoint)).toHaveLength(3);

  });

  it('orderStopsTspObjects dropoffs-only and pickup-not-first', () => {
    const dropOnly = [
      { lat: -37.8, lng: 144.9, stopType: 'DROPOFF' },
      { lat: -37.81, lng: 144.95, stopType: 'DROPOFF' },
      { lat: -37.82, lng: 145.0, stopType: 'DROPOFF' },
    ];
    expect(orderStopsTspObjects(dropOnly)).toHaveLength(3);

    const mixed = [
      { lat: -37.8, lng: 144.9, stopType: 'WAYPOINT' },
      { lat: -37.81, lng: 144.95, stopType: 'PICKUP' },
      { lat: -37.82, lng: 145.0, stopType: 'DROPOFF' },
      { lat: -37.83, lng: 145.05, stopType: 'DROPOFF' },
    ];
    const ordered = orderStopsTspObjects(mixed);
    expect(ordered.map((s) => s.stopType)).toEqual([
      'PICKUP',
      'WAYPOINT',
      'DROPOFF',
      'DROPOFF',
    ]);
  });

  it('estimateRoute HOURLY without fatigue on short hop', () => {
    const route = estimateRoute({
      stops: [
        { lat: -37.81, lng: 144.96 },
        { lat: -37.812, lng: 144.962 },
      ],
      pricingModel: 'HOURLY',
    });
    expect(route.fatigueBreakMinutes).toBe(0);
    expect(route.billableHours).toBeGreaterThanOrEqual(4);
  });
});
