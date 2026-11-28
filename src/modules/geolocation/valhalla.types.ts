// =============================================================================
// Valhalla API — TypeScript type definitions
// Covers: /route, /isochrone, /locate, /trace_route endpoints
// =============================================================================

export interface ValhallaLocation {
  lon: number;
  lat: number;
  type?: 'break' | 'through' | 'via' | 'break_through';
  node_snap_tolerance?: number;
}

// ─── /route ──────────────────────────────────────────────────────────────────

export type ValhallaCostingType = 'auto' | 'truck' | 'bicycle' | 'pedestrian' | 'bus' | 'hov';

export interface ValhallaRouteRequest {
  locations: ValhallaLocation[];
  costing: ValhallaCostingType;
  costing_options?: {
    truck?: {
      length?: number;
      width?: number;
      height?: number;
      weight?: number;
      axle_load?: number;
      hazmat?: boolean;
    };
    auto?: Record<string, unknown>;
  };
  directions_options?: {
    units?: 'kilometers' | 'miles';
    language?: string;
  };
}

export interface ValhallaRouteLeg {
  summary: { length: number; time: number };
  shape: string; // encoded polyline (precision 6)
  maneuvers: Array<{
    type: number;
    instruction: string;
    length: number;
    time: number;
  }>;
}

export interface ValhallaRouteResponse {
  trip: {
    status: number;
    status_message: string;
    units: string;
    legs: ValhallaRouteLeg[];
    summary: {
      length: number;   // km
      time: number;     // seconds
      has_time_restrictions: boolean;
      has_toll?: boolean;
    };
    language: string;
  };
}

// ─── /isochrone ──────────────────────────────────────────────────────────────

export interface ValhallaIsochroneContour {
  time?: number;    // minutes
  distance?: number; // km
  color?: string;
}

export interface ValhallaIsochroneRequest {
  locations: [ValhallaLocation];  // exactly one origin
  costing: ValhallaCostingType;
  contours: ValhallaIsochroneContour[];
  polygons?: boolean;   // true = GeoJSON Polygon, false = LineString
  denoise?: number;     // 0–1 smoothing
  generalize?: number;  // metres tolerance
}

export interface ValhallaIsochroneFeature {
  type: 'Feature';
  geometry: {
    type: 'Polygon' | 'LineString';
    coordinates: number[][][] | number[][];
  };
  properties: {
    contour: number;
    color: string;
    opacity: number;
    metric: 'time' | 'distance';
  };
}

export interface ValhallaIsochroneResponse {
  type: 'FeatureCollection';
  features: ValhallaIsochroneFeature[];
}

// ─── /locate ─────────────────────────────────────────────────────────────────

export interface ValhallaLocateRequest {
  locations: ValhallaLocation[];
  costing: ValhallaCostingType;
}

export interface ValhallaLocateResult {
  input_lon: number;
  input_lat: number;
  edges: Array<{
    id: number;
    side_of_street: string;
    edge_info: {
      names: string[];
      shape: string;
    };
  }>;
  nodes?: Array<{
    lat: number;
    lon: number;
  }>;
}

// ─── /trace_route ─────────────────────────────────────────────────────────────

export interface ValhallaTracePoint {
  lon: number;
  lat: number;
  time?: number; // Unix epoch seconds
}

export interface ValhallaTraceRouteRequest {
  encoded_polyline?: string;
  shape?: ValhallaTracePoint[];
  costing: ValhallaCostingType;
  shape_match?: 'map_snap' | 'edge_walk' | 'walk_or_snap';
  trace_options?: {
    search_radius?: number;      // metres
    gps_accuracy?: number;       // metres
    breakage_distance?: number;  // metres
  };
  directions_options?: {
    units?: 'kilometers' | 'miles';
  };
}

export interface ValhallaTraceMatchedPoint {
  lat: number;
  lon: number;
  type: 'matched' | 'unmatched' | 'interpolated';
  edge_index?: number;
  distance_along_edge?: number;
  distance_from_trace_point?: number;
}

export interface ValhallaTraceRouteResponse {
  trip: {
    status: number;
    status_message: string;
    units: string;
    legs: ValhallaRouteLeg[];
    summary: { length: number; time: number };
  };
  matched_points?: ValhallaTraceMatchedPoint[];
}

// ─── Shared result types used by ValhallaClientService ────────────────────────

export interface SnappedPoint {
  lat: number;
  lng: number;
}

export interface RouteResult {
  /** Valhalla-encoded polyline (precision 6, decode with @mapbox/polyline). */
  encodedPolyline: string;
  distanceKm: number;
  durationMin: number;
  hasToll?: boolean;
}

export interface IsochroneResult {
  polygon: GeoJSON.Polygon;
  contourMinutes: number;
}

export interface TraceResult {
  matchedPoints: Array<SnappedPoint & { type: string }>;
  /** 0–1; 1 = fully road-matched. */
  confidence: number;
  distanceKm: number;
}

