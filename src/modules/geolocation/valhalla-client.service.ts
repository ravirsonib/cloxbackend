import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../../config/env.validation';
import {
  haversineMeters,
} from '../trips/geofence.util';
import { mergePolylines6 } from './polyline6.util';
import type {
  IsochroneResult,
  RouteResult,
  SnappedPoint,
  TraceResult,
  ValhallaCostingType,
  ValhallaIsochroneRequest,
  ValhallaIsochroneResponse,
  ValhallaLocateRequest,
  ValhallaLocateResult,
  ValhallaRouteRequest,
  ValhallaRouteResponse,
  ValhallaTraceRouteRequest,
  ValhallaTraceRouteResponse,
} from './valhalla.types';

/**
 * ValhallaClientService — typed HTTP wrapper for the self-hosted Valhalla engine.
 *
 * All methods:
 *   - Validate that VALHALLA_BASE_URL is set before attempting a call.
 *   - Return null (never throw) on network/routing failure so callers can
 *     fall back to Haversine / degraded mode without crashing the pipeline.
 *   - Log structured timing for each request (valhallaMs).
 */
@Injectable()
export class ValhallaClientService {
  private readonly logger = new Logger(ValhallaClientService.name);
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly costing: ValhallaCostingType;

  constructor(private readonly config: ConfigService<AppEnv, true>) {
    this.base = config.get('VALHALLA_BASE_URL', { infer: true });
    this.timeoutMs = config.get('VALHALLA_TIMEOUT_MS', { infer: true });
    this.costing = config.get('VALHALLA_COSTING', { infer: true }) as ValhallaCostingType;
  }

  get isEnabled(): boolean {
    return Boolean(this.base);
  }

  // ─── Health ────────────────────────────────────────────────────────────────

  async ping(): Promise<{ ok: boolean; version?: string; tileset?: string }> {
    if (!this.isEnabled) return { ok: false };
    try {
      const res = await this.fetch<{ version: string; tileset_last_modified: string }>(
        'GET',
        '/status',
      );
      return { ok: true, version: res?.version, tileset: res?.tileset_last_modified };
    } catch {
      return { ok: false };
    }
  }

  // ─── Snap to road ──────────────────────────────────────────────────────────

  /**
   * Snap a raw GPS coordinate to the nearest road node.
   * Falls back to returning the raw point when Valhalla is unavailable.
   */
  async snapToRoad(lat: number, lng: number): Promise<SnappedPoint | null> {
    if (!this.isEnabled) return null;
    const t0 = Date.now();
    try {
      const body: ValhallaLocateRequest = {
        locations: [{ lat, lon: lng }],
        costing: this.costing,
      };
      const results = await this.fetch<ValhallaLocateResult[]>('POST', '/locate', body);
      const ms = Date.now() - t0;
      if (!results?.length) return null;
      const node = results[0].nodes?.[0];
      if (
        !node ||
        !Number.isFinite(node.lat) ||
        !Number.isFinite(node.lon) ||
        (node.lat === 0 && node.lon === 0)
      ) {
        return null;
      }
      this.logger.debug({ valhallaMs: ms, op: 'snapToRoad' }, 'Valhalla snap OK');
      return { lat: node.lat, lng: node.lon };
    } catch (err) {
      this.logger.warn({ err, op: 'snapToRoad' }, 'Valhalla snapToRoad failed — using raw GPS');
      return null;
    }
  }

  // ─── Route ─────────────────────────────────────────────────────────────────

  /**
   * Calculate the optimal truck route between ordered stops.
   * Returns null when Valhalla unreachable (caller falls back to straight-line ETA).
   */
  async getRoute(
    stops: Array<{ lat: number; lng: number }>,
    costing?: ValhallaCostingType,
  ): Promise<RouteResult | null> {
    if (!this.isEnabled || stops.length < 2) return null;
    const t0 = Date.now();
    try {
      const body: ValhallaRouteRequest = {
        locations: stops.map((s) => ({ lat: s.lat, lon: s.lng, type: 'break' })),
        costing: costing ?? this.costing,
        directions_options: { units: 'kilometers' },
      };
      const data = await this.fetch<ValhallaRouteResponse>('POST', '/route', body);
      const ms = Date.now() - t0;
      if (!data?.trip?.legs?.length) return null;

      const length = data.trip.summary?.length;
      const time = data.trip.summary?.time;
      const encodedPolyline = mergePolylines6(
        data.trip.legs.map((leg) => (typeof leg?.shape === 'string' ? leg.shape : '')),
      );
      if (
        !encodedPolyline ||
        typeof length !== 'number' ||
        !Number.isFinite(length) ||
        length < 0 ||
        typeof time !== 'number' ||
        !Number.isFinite(time) ||
        time < 0
      ) {
        this.logger.warn({ op: 'getRoute' }, 'Valhalla returned malformed trip summary');
        return null;
      }
      this.logger.debug(
        { valhallaMs: ms, op: 'getRoute', legs: data.trip.legs.length },
        'Valhalla route OK',
      );
      return {
        encodedPolyline,
        distanceKm: length,
        durationMin: Math.ceil(time / 60),
      };
    } catch (err) {
      this.logger.warn({ err, op: 'getRoute' }, 'Valhalla getRoute failed');
      return null;
    }
  }

  // ─── Isochrone ─────────────────────────────────────────────────────────────

  /**
   * Get a "reachable within N minutes" GeoJSON polygon centred on a point.
   * Used for "driver approaching" push notifications (e.g. 10-minute contour).
   */
  async getIsochrone(
    lat: number,
    lng: number,
    contourMinutes: number,
  ): Promise<IsochroneResult | null> {
    if (!this.isEnabled) return null;
    const t0 = Date.now();
    try {
      const body: ValhallaIsochroneRequest = {
        locations: [{ lat, lon: lng }],
        costing: this.costing,
        contours: [{ time: contourMinutes, color: 'ff0000' }],
        polygons: true,
        denoise: 0.5,
        generalize: 150,
      };
      const data = await this.fetch<ValhallaIsochroneResponse>('POST', '/isochrone', body);
      const ms = Date.now() - t0;
      if (!data?.features?.length) return null;
      const feature = data.features[0];
      if (feature.geometry.type !== 'Polygon') return null;
      this.logger.debug({ valhallaMs: ms, op: 'getIsochrone', contourMinutes }, 'Valhalla isochrone OK');
      return {
        polygon: feature.geometry as GeoJSON.Polygon,
        contourMinutes,
      };
    } catch (err) {
      this.logger.warn({ err, op: 'getIsochrone' }, 'Valhalla getIsochrone failed');
      return null;
    }
  }

  // ─── Trace / map-match ─────────────────────────────────────────────────────

  /**
   * Map-match an array of raw GPS breadcrumbs to the road network.
   * Returns road-snapped points + a confidence score (0–1).
   * Used for route deviation detection (M6).
   */
  async traceRoute(
    points: Array<{ lat: number; lng: number; timeEpochSeconds?: number }>,
  ): Promise<TraceResult | null> {
    if (!this.isEnabled || points.length < 2) return null;
    const t0 = Date.now();
    try {
      const body: ValhallaTraceRouteRequest = {
        shape: points.map((p) => ({
          lat: p.lat,
          lon: p.lng,
          ...(p.timeEpochSeconds ? { time: p.timeEpochSeconds } : {}),
        })),
        costing: this.costing,
        shape_match: 'map_snap',
        trace_options: { search_radius: 50, gps_accuracy: 15, breakage_distance: 2000 },
        directions_options: { units: 'kilometers' },
      };
      const data = await this.fetch<ValhallaTraceRouteResponse>('POST', '/trace_route', body);
      const ms = Date.now() - t0;
      if (!data?.trip?.legs?.length) return null;

      const matched = data.matched_points ?? [];
      const total = matched.length;
      const good = matched.filter((p) => p.type === 'matched').length;
      const confidence = total > 0 ? good / total : 0;

      const matchedPoints = matched
        .filter((p) => p.type !== 'unmatched')
        .map((p) => ({ lat: p.lat, lng: p.lon, type: p.type }));

      this.logger.debug(
        { valhallaMs: ms, op: 'traceRoute', confidence, points: total },
        'Valhalla traceRoute OK',
      );
      return {
        matchedPoints,
        confidence,
        distanceKm: data.trip.summary.length,
      };
    } catch (err) {
      this.logger.warn({ err, op: 'traceRoute' }, 'Valhalla traceRoute failed');
      return null;
    }
  }

  // ─── ETA helper ────────────────────────────────────────────────────────────

  /**
   * Calculate ETA in minutes from origin to destination.
   * Falls back to Haversine / assumed speed when Valhalla unavailable.
   */
  async etaMinutes(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number },
    fallbackSpeedKmh = 40,
  ): Promise<number> {
    const route = await this.getRoute([from, to]);
    if (route) return route.durationMin;
    const distKm = haversineMeters(from.lat, from.lng, to.lat, to.lng) / 1000;
    return Math.ceil((distKm / fallbackSpeedKmh) * 60);
  }

  // ─── Point-in-polygon ─────────────────────────────────────────────────────

  /**
   * Check if a point (lat, lng) lies inside a GeoJSON Polygon.
   * Uses ray-casting algorithm — no external dependency.
   */
  static pointInPolygon(
    point: { lat: number; lng: number },
    polygon: GeoJSON.Polygon,
  ): boolean {
    const [ring] = polygon.coordinates;
    const x = point.lng;
    const y = point.lat;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const intersect =
        yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // ─── Internal fetch ────────────────────────────────────────────────────────

  private async fetch<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.base}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await globalThis.fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Valhalla ${method} ${path} → HTTP ${res.status}: ${text}`);
      }
      return res.json() as Promise<T>;
    } finally {
      clearTimeout(timer);
    }
  }
}

