/**
 * Mock Valhalla / routing for M6 local QA.
 * Replace with real Valhalla client when docker service is available.
 */

export type LatLng = { lat: number; lng: number };

function toRad(deg: number) {
  return (deg * Math.PI) / 180;
}

/** Haversine km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const ROAD_FACTOR = 1.3;
const AVG_SPEED_KMH = 60;
const FATIGUE_THRESHOLD_HOURS = 5.25;
const FATIGUE_BREAK_MINUTES = 15;
const HOURLY_FLOOR_HOURS = 4;

export type RouteEstimate = {
  distanceKm: number;
  drivingMinutes: number;
  fatigueBreakMinutes: number;
  totalDurationMinutes: number;
  billableHours: number | null;
  mock: true;
};

/**
 * Derive duration / fatigue / billable from an effective distance (sender km or suggested).
 * Hourly jobs: billable hours = max(4, ceil(totalHours*4)/4).
 */
export function routeFromDistanceKm(
  distanceKm: number,
  pricingModel: 'PER_KM' | 'HOURLY',
): RouteEstimate {
  const km = Math.round(Math.max(0, distanceKm) * 10) / 10;
  if (km <= 0) {
    return {
      distanceKm: 0,
      drivingMinutes: 0,
      fatigueBreakMinutes: 0,
      totalDurationMinutes: 0,
      billableHours: pricingModel === 'HOURLY' ? HOURLY_FLOOR_HOURS : null,
      mock: true,
    };
  }

  const drivingMinutes = Math.round((km / AVG_SPEED_KMH) * 60);
  const drivingHours = drivingMinutes / 60;
  const fatigueBreakMinutes = drivingHours > FATIGUE_THRESHOLD_HOURS ? FATIGUE_BREAK_MINUTES : 0;
  const totalDurationMinutes = drivingMinutes + fatigueBreakMinutes;
  const billableHours =
    pricingModel === 'HOURLY'
      ? Math.max(HOURLY_FLOOR_HOURS, Math.ceil((totalDurationMinutes / 60) * 4) / 4)
      : null;

  return {
    distanceKm: km,
    drivingMinutes,
    fatigueBreakMinutes,
    totalDurationMinutes,
    billableHours,
    mock: true,
  };
}

/**
 * Suggest route for ordered stops (mock Valhalla). Inserts unpaid 15 min rest when driving > 5.25 h.
 */
export function estimateRoute(params: {
  stops: LatLng[];
  pricingModel: 'PER_KM' | 'HOURLY';
}): RouteEstimate {
  const { stops, pricingModel } = params;
  if (stops.length < 2) {
    return routeFromDistanceKm(0, pricingModel);
  }

  let distanceKm = 0;
  for (let i = 0; i < stops.length - 1; i += 1) {
    distanceKm += haversineKm(stops[i], stops[i + 1]) * ROAD_FACTOR;
  }
  distanceKm = Math.round(distanceKm * 10) / 10;
  return routeFromDistanceKm(distanceKm, pricingModel);
}

/** Naive nearest-neighbour TSP for ≤4 stops (keeps first as start).
 * When stops have `stopType`, all PICKUPs are ordered before DROPOFFs
 * (TSP within each phase) so HOURLY runs never drop before remaining picks.
 */
export function orderStopsTspObjects<T extends LatLng & { stopType?: string }>(
  stops: T[],
): T[] {
  if (stops.length <= 2) return [...stops];

  const hasTypes = stops.some((s) => s.stopType === 'PICKUP' || s.stopType === 'DROPOFF');
  if (!hasTypes) {
    return nearestNeighbourOrder(stops);
  }

  const pickups = stops.filter((s) => s.stopType === 'PICKUP');
  const dropoffs = stops.filter((s) => s.stopType === 'DROPOFF');
  const other = stops.filter(
    (s) => s.stopType !== 'PICKUP' && s.stopType !== 'DROPOFF',
  );

  // Preserve first stop as start when it is a PICKUP (typical job start).
  let orderedPickups: T[];
  if (pickups.length > 0 && stops[0].stopType === 'PICKUP') {
    orderedPickups = nearestNeighbourOrder(pickups);
  } else if (pickups.length > 0) {
    orderedPickups = nearestNeighbourOrder(pickups);
  } else {
    orderedPickups = [];
  }

  // When pickups exist, NN-from last pickup (empty dropoffs → []).
  // Otherwise NN the dropoff list (also [] when empty).
  const orderedDropoffs =
    orderedPickups.length > 0
      ? nearestNeighbourOrderFrom(orderedPickups[orderedPickups.length - 1], dropoffs)
      : nearestNeighbourOrder(dropoffs);

  return [...orderedPickups, ...other, ...orderedDropoffs];
}

function nearestNeighbourOrder<T extends LatLng>(stops: T[]): T[] {
  if (stops.length <= 1) return [...stops];
  const remaining = stops.slice(1);
  const ordered: T[] = [stops[0]];
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const d = haversineKm(last, remaining[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }
  return ordered;
}

function nearestNeighbourOrderFrom<T extends LatLng>(start: LatLng, stops: T[]): T[] {
  if (stops.length === 0) return [];
  const remaining = [...stops];
  const ordered: T[] = [];
  let cursor = start;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const d = haversineKm(cursor, remaining[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    ordered.push(next);
    cursor = next;
  }
  return ordered;
}

/** @deprecated Prefer orderStopsTspObjects when stop identity matters. */
export function orderStopsTsp(stops: LatLng[]): LatLng[] {
  return orderStopsTspObjects(stops);
}
