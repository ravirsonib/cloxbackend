import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { HealthController } from '../health/health.controller';
import { JobsController } from '../jobs/jobs.controller';

const sender: AuthenticatedPrincipal = {
  id: 'user-sender',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('Jobs + Health controller leftovers', () => {
  it('JobsController list/get/create/publish/accept delegate', async () => {
    const jobs = {
      listSenderJobs: jest.fn().mockResolvedValue([{ id: 'j1' }]),
      getJobForSender: jest.fn().mockResolvedValue({ id: 'j1' }),
      createJob: jest.fn().mockResolvedValue({ id: 'j2' }),
      publishJob: jest.fn().mockResolvedValue({ id: 'j2', status: 'BIDDING' }),
      acceptProposal: jest.fn().mockResolvedValue({ paymentEventId: 'pe1' }),
    };
    const c = new JobsController(jobs as never);
    await expect(c.list(sender)).resolves.toEqual([{ id: 'j1' }]);
    await expect(c.get(sender, 'j1')).resolves.toEqual({ id: 'j1' });
    await expect(c.create(sender, {} as never)).resolves.toEqual({ id: 'j2' });
    await expect(c.publish(sender, 'j2')).resolves.toEqual({
      id: 'j2',
      status: 'BIDDING',
    });
    await expect(c.accept(sender, 'j2', 'prop-1')).resolves.toEqual({
      paymentEventId: 'pe1',
    });
  });

  it('HealthController reports ok when DB + PostGIS up', async () => {
    const prisma = {
      isConnected: () => true,
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ '?column?': 1 }])
        .mockResolvedValueOnce([{ postgis: '3.4' }]),
    };
    const c = new HealthController(prisma as never);
    const result = await c.check();
    expect(result).toMatchObject({
      status: 'ok',
      service: 'clox-api',
      database: 'up',
      postgis: 'up',
    });
    expect(result.timestamp).toBeTruthy();
  });

  it('HealthController degraded when disconnected or query fails', async () => {
    const down = new HealthController({ isConnected: () => false } as never);
    await expect(down.check()).resolves.toMatchObject({
      status: 'degraded',
      database: 'down',
      postgis: 'unknown',
    });

    const prisma = {
      isConnected: () => true,
      $queryRaw: jest.fn().mockRejectedValue(new Error('db down')),
    };
    const failing = new HealthController(prisma as never);
    await expect(failing.check()).resolves.toMatchObject({
      status: 'degraded',
      database: 'down',
      postgis: 'down',
    });
  });

  it('HealthController postgis down when PostGIS query fails', async () => {
    const prisma = {
      isConnected: () => true,
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ '?column?': 1 }])
        .mockRejectedValueOnce(new Error('no postgis')),
    };
    const c = new HealthController(prisma as never);
    await expect(c.check()).resolves.toMatchObject({
      status: 'ok',
      database: 'up',
      postgis: 'down',
    });
  });

  it('HealthController postgis down when version row empty', async () => {
    const prisma = {
      isConnected: () => true,
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ '?column?': 1 }])
        .mockResolvedValueOnce([{ postgis: '' }]),
    };
    const c = new HealthController(prisma as never);
    await expect(c.check()).resolves.toMatchObject({
      status: 'ok',
      database: 'up',
      postgis: 'down',
    });
  });
});
