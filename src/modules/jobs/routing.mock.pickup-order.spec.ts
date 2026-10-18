import { orderStopsTspObjects } from './routing.mock';

describe('routing.mock pickup order leftover', () => {
  it('orders pickups when first stop is not a PICKUP', () => {
    const stops = [
      { lat: -37.8, lng: 144.9, stopType: 'DROPOFF' },
      { lat: -37.81, lng: 144.95, stopType: 'PICKUP' },
      { lat: -37.82, lng: 145.0, stopType: 'PICKUP' },
      { lat: -37.83, lng: 145.1, stopType: 'DROPOFF' },
    ];
    const ordered = orderStopsTspObjects(stops);
    const types = ordered.map((s) => s.stopType);
    expect(types.filter((t) => t === 'PICKUP')).toHaveLength(2);
    expect(types.indexOf('PICKUP')).toBeLessThan(types.lastIndexOf('DROPOFF'));
    // pickups come before dropoffs
    expect(types.slice(0, 2).every((t) => t === 'PICKUP')).toBe(true);
  });
});
