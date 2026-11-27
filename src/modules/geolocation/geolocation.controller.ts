import {
  Controller,
  Get,
  Query,
  ParseFloatPipe,
  BadRequestException,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ValhallaClientService } from './valhalla-client.service';
import type { ValhallaCostingType } from './valhalla.types';
import { encodePolyline6 } from './polyline6.util';

function assertValidLatLng(lat: number, lng: number, label: string): void {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180 ||
    (lat === 0 && lng === 0)
  ) {
    throw new BadRequestException(`Invalid ${label} coordinates provided`);
  }
}

@ApiTags('geolocation')
@Controller('geolocation')
export class GeolocationController {
  private readonly logger = new Logger(GeolocationController.name);

  constructor(private readonly valhalla: ValhallaClientService) {}

  @Get('_status')
  @ApiOperation({ summary: 'Valhalla and PostGIS geolocation status and engine health' })
  async status() {
    const ping = await this.valhalla.ping();
    return {
      module: 'geolocation',
      status: ping.ok ? 'ready' : 'degraded',
      valhalla: {
        enabled: this.valhalla.isEnabled,
        reachable: ping.ok,
        version: ping.version ?? null,
        tilesetLastModified: ping.tileset ?? null,
      },
      features: {
        roadSnapping: true,
        isochrones: true,
        routeDeviation: true,
        realtimeWebSocket: true,
        publicTrackingLink: true,
        geofenceZones: true,
      },
    };
  }

  @Get('route')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Calculate road-following route and polyline between two GPS points' })
  @ApiQuery({ name: 'fromLat', type: Number })
  @ApiQuery({ name: 'fromLng', type: Number })
  @ApiQuery({ name: 'toLat', type: Number })
  @ApiQuery({ name: 'toLng', type: Number })
  @ApiQuery({ name: 'costing', required: false, enum: ['auto', 'truck', 'bicycle', 'pedestrian', 'motorcycle'] })
  async getRoute(
    @Query('fromLat', ParseFloatPipe) fromLat: number,
    @Query('fromLng', ParseFloatPipe) fromLng: number,
    @Query('toLat', ParseFloatPipe) toLat: number,
    @Query('toLng', ParseFloatPipe) toLng: number,
    @Query('costing') costing?: ValhallaCostingType,
  ) {
    assertValidLatLng(fromLat, fromLng, 'origin');
    assertValidLatLng(toLat, toLng, 'destination');

    // 1. First attempt local Valhalla engine (HGV truck profile)
    try {
      const valhallaRoute = await this.valhalla.getRoute(
        [
          { lat: fromLat, lng: fromLng },
          { lat: toLat, lng: toLng },
        ],
        costing,
      );

      if (valhallaRoute?.encodedPolyline) {
        return {
          source: 'valhalla',
          encodedPolyline: valhallaRoute.encodedPolyline,
          distanceKm: valhallaRoute.distanceKm,
          durationMin: valhallaRoute.durationMin,
        };
      }
    } catch (err) {
      this.logger.warn({ err }, 'Local Valhalla route attempt failed — attempting fallback');
    }

    // 2. Fallback to public OSRM road routing if Valhalla is indexing or starting up
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=polyline6`;
      const res = await fetch(osrmUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        const data = (await res.json()) as any;
        if (data.routes && data.routes.length > 0) {
          const route = data.routes[0];
          return {
            source: 'osrm',
            encodedPolyline: route.geometry,
            distanceKm: parseFloat((route.distance / 1000).toFixed(2)),
            durationMin: Math.ceil(route.duration / 60),
          };
        }
      }
    } catch (err) {
      this.logger.warn({ err }, 'OSRM fallback failed — falling back to direct line');
    }

    // 3. Resilience fallback: direct polyline with estimated distance
    const distKm = parseFloat(
      (this.haversine(fromLat, fromLng, toLat, toLng) / 1000).toFixed(2),
    );
    const durationMin = Math.ceil((distKm / 60) * 60); // ~60 km/h avg
    return {
      source: 'direct',
      encodedPolyline: encodePolyline6([
        [fromLat, fromLng],
        [toLat, toLng],
      ]),
      distanceKm: distKm,
      durationMin: Math.max(1, durationMin),
    };
  }

  @Get('snap')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Snap GPS coordinate to nearest road segment' })
  async snap(
    @Query('lat', ParseFloatPipe) lat: number,
    @Query('lng', ParseFloatPipe) lng: number,
  ) {
    assertValidLatLng(lat, lng, 'GPS');
    const snapped = await this.valhalla.snapToRoad(lat, lng);
    return {
      lat,
      lng,
      snappedLat: snapped?.lat ?? lat,
      snappedLng: snapped?.lng ?? lng,
      isSnapped: Boolean(snapped),
    };
  }

  private haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
}
