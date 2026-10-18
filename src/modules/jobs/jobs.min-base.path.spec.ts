import { JobsService } from './jobs.service';

describe('JobsService getMinBaseCents leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const senderService = {
    getBookingEligibility: jest.fn().mockResolvedValue({ canBook: true }),
  };

  function makeService(prisma: Record<string, unknown>) {
    return new JobsService(
      prisma as never,
      audit as never,
      senderService as never,
      {} as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads perKmMinCents / hourlyMinCents from published policy', async () => {
    const prisma = {
      isConnected: () => true,
      policyVersion: {
        findFirst: jest.fn().mockResolvedValue({
          payload: { perKmMinCents: 7777, hourlyMinCents: 8888 },
        }),
      },
    };
    const service = makeService(prisma);
    await expect(service.getMinBaseCents('PER_KM')).resolves.toBe(7777);
    await expect(service.getMinBaseCents('HOURLY')).resolves.toBe(8888);
  });

  it('falls back to defaults when policy missing', async () => {
    const prisma = {
      isConnected: () => true,
      policyVersion: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = makeService(prisma);
    const perKm = await service.getMinBaseCents('PER_KM');
    const hourly = await service.getMinBaseCents('HOURLY');
    expect(perKm).toBeGreaterThan(0);
    expect(hourly).toBeGreaterThan(0);
    expect(hourly).not.toBe(perKm);
  });
});
