import { HealthController } from './health.controller';
import { PrismaService } from '../../prisma/prisma.service';

describe('HealthController', () => {
  it('reports degraded when database is down', async () => {
    const prisma = {
      isConnected: () => false,
      $queryRaw: jest.fn(),
    } as unknown as PrismaService;

    const controller = new HealthController(prisma);
    const result = await controller.check();

    expect(result.status).toBe('degraded');
    expect(result.database).toBe('down');
    expect(result.service).toBe('clox-api');
  });
});
