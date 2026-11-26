import { decodePolyline6, encodePolyline6, mergePolylines6 } from './polyline6.util';

describe('polyline6.util', () => {
  it('round-trips precision-6 coordinates', () => {
    const coords: Array<[number, number]> = [
      [-37.8136, 144.9631],
      [-37.823, 144.998],
      [-37.669, 144.841],
    ];
    const encoded = encodePolyline6(coords);
    const decoded = decodePolyline6(encoded);
    expect(decoded).toHaveLength(3);
    for (let i = 0; i < coords.length; i += 1) {
      expect(decoded[i][0]).toBeCloseTo(coords[i][0], 5);
      expect(decoded[i][1]).toBeCloseTo(coords[i][1], 5);
    }
  });

  it('merges multi-leg shapes without duplicating leg junction points', () => {
    const leg1 = encodePolyline6([
      [-37.8136, 144.9631],
      [-37.82, 144.98],
    ]);
    const leg2 = encodePolyline6([
      [-37.82, 144.98],
      [-37.83, 145.0],
    ]);
    const merged = mergePolylines6([leg1, leg2]);
    const decoded = decodePolyline6(merged);
    expect(decoded).toHaveLength(3);
    expect(decoded[0][0]).toBeCloseTo(-37.8136, 5);
    expect(decoded[1][0]).toBeCloseTo(-37.82, 5);
    expect(decoded[2][0]).toBeCloseTo(-37.83, 5);
  });
});
