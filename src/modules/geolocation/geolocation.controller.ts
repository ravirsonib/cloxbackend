import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('geolocation')
@Controller('geolocation')
export class GeolocationController {
  @Get('_status')
  @ApiOperation({ summary: 'Geolocation module scaffold — Valhalla + PostGIS (M10+)' })
  status() {
    return {
      module: 'geolocation',
      status: 'scaffold',
      milestone: 'M10',
      implemented: false,
      note: 'Trip geofence uses in-process policy; Valhalla client not wired',
    };
  }
}
