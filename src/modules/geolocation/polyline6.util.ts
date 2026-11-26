/**
 * Google Encoded Polyline (precision 6 — Valhalla / OSRM polyline6) helpers.
 * Shared across GeolocationController and ValhallaClientService.
 */

export type PolylineCoord = [lat: number, lng: number];

const PRECISION = 1e6;

function encodeSignedNumber(num: number): string {
  let sgn = num < 0 ? ~(num << 1) : num << 1;
  let res = '';
  while (sgn >= 0x20) {
    res += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63);
    sgn >>= 5;
  }
  res += String.fromCharCode(sgn + 63);
  return res;
}

export function encodePolyline6(coords: PolylineCoord[]): string {
  let res = '';
  let prevLat = 0;
  let prevLng = 0;
  for (const [lat, lng] of coords) {
    const l1 = Math.round(lat * PRECISION);
    const l2 = Math.round(lng * PRECISION);
    res += encodeSignedNumber(l1 - prevLat) + encodeSignedNumber(l2 - prevLng);
    prevLat = l1;
    prevLng = l2;
  }
  return res;
}

export function decodePolyline6(encoded: string): PolylineCoord[] {
  const coords: PolylineCoord[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    const dLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dLat;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    const dLng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dLng;

    coords.push([lat / PRECISION, lng / PRECISION]);
  }

  return coords;
}

/**
 * Concatenate multiple Valhalla leg shapes into a single continuous polyline6 string,
 * deduplicating adjacent leg junction points.
 */
export function mergePolylines6(shapes: string[]): string {
  const nonEmpty = shapes.filter((s) => s.length > 0);
  if (nonEmpty.length === 0) return '';
  if (nonEmpty.length === 1) return nonEmpty[0];

  const merged: PolylineCoord[] = [];
  for (const shape of nonEmpty) {
    const pts = decodePolyline6(shape);
    for (const pt of pts) {
      const prev = merged[merged.length - 1];
      if (prev && prev[0] === pt[0] && prev[1] === pt[1]) continue;
      merged.push(pt);
    }
  }
  return encodePolyline6(merged);
}
