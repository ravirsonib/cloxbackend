import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness / DB + PostGIS readiness' })
  async check() {
    let database: 'up' | 'down' = 'down';
    let postgis: 'up' | 'down' | 'unknown' = 'unknown';

    if (this.prisma.isConnected()) {
      try {
        await this.prisma.$queryRaw`SELECT 1`;
        database = 'up';
        try {
          const rows = await this.prisma.$queryRaw<Array<{ postgis: string }>>`
            SELECT PostGIS_Version() AS postgis
          `;
          postgis = rows[0]?.postgis ? 'up' : 'down';
        } catch {
          postgis = 'down';
        }
      } catch {
        database = 'down';
        postgis = 'down';
      }
    }

    const ok = database === 'up';
    return {
      status: ok ? 'ok' : 'degraded',
      service: 'clox-api',
      database,
      postgis,
      timestamp: new Date().toISOString(),
    };
  }
}
