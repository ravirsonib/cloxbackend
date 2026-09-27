import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness / DB readiness' })
  async check() {
    let database: 'up' | 'down' = 'down';

    if (this.prisma.isConnected()) {
      try {
        await this.prisma.$queryRaw`SELECT 1`;
        database = 'up';
      } catch {
        database = 'down';
      }
    }

    return {
      status: database === 'up' ? 'ok' : 'degraded',
      service: 'clox-api',
      database,
      timestamp: new Date().toISOString(),
    };
  }
}
