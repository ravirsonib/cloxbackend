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
    expect(result.postgis).toBe('unknown');
    expect(result.service).toBe('clox-api');
  });

  it('reports postgis when database is up', async () => {
    const prisma = {
      isConnected: () => true,
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ '?column?': 1 }])
        .mockResolvedValueOnce([{ postgis: '3.4 USE_GEOS=1' }]),
    } as unknown as PrismaService;

    const controller = new HealthController(prisma);
    const result = await controller.check();

    expect(result.status).toBe('ok');
    expect(result.database).toBe('up');
    expect(result.postgis).toBe('up');
  });
});
