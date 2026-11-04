import { AdminService } from './admin.service';

describe('AdminService platform settings', () => {
  it('getPlatformSettings upserts default singleton', async () => {
    const row = {
      id: 'default',
      rescueDiscountPercent: 10,
      marketplaceRelistSlaMs: 300_000,
      driverUnavailableScoreDelta: 5,
      carrierMarketplaceReleaseScoreDelta: 10,
      carrierClearingDays: 1,
      gstPercent: 10.0,
      perKmRateCents: 250,
      perKmMinBaseCents: 5000,
      hourlyRateCents: 8000,
      hourlyMinFloorHours: 4.0,
      hourlyMinBaseCents: 20000,
      settlementCycleCadenceDays: 14,
      settlementCutoffHour: 4,
      updatedAt: new Date('2026-10-26T00:00:00.000Z'),
    };
    const prisma = {
      isConnected: () => true,
      platformSettings: {
        upsert: jest.fn().mockResolvedValue(row),
      },
    };
    const service = new AdminService(
      prisma as never,
      { recordPlatform: jest.fn() } as never,
      {} as never,
    );

    const result = await service.getPlatformSettings();
    expect(result).toMatchObject({
      id: 'default',
      rescueDiscountPercent: 10,
      marketplaceRelistSlaMs: 300_000,
      carrierClearingDays: 1,
    });
    expect(prisma.platformSettings.upsert).toHaveBeenCalledWith({
      where: { id: 'default' },
      create: { id: 'default' },
      update: {},
    });
  });

  it('patchPlatformSettings updates fields and audits', async () => {
    const updated = {
      id: 'default',
      rescueDiscountPercent: 15,
      marketplaceRelistSlaMs: 600_000,
      driverUnavailableScoreDelta: 7,
      carrierMarketplaceReleaseScoreDelta: 12,
      carrierClearingDays: 2,
      gstPercent: 12.5,
      perKmRateCents: 300,
      perKmMinBaseCents: 6000,
      hourlyRateCents: 9000,
      hourlyMinFloorHours: 3.5,
      hourlyMinBaseCents: 25000,
      settlementCycleCadenceDays: 7,
      settlementCutoffHour: 3,
      updatedAt: new Date('2026-10-26T01:00:00.000Z'),
    };
    const audit = { recordPlatform: jest.fn() };
    const prisma = {
      isConnected: () => true,
      platformSettings: {
        upsert: jest.fn().mockResolvedValue({ id: 'default' }),
        update: jest.fn().mockResolvedValue(updated),
      },
    };
    const service = new AdminService(prisma as never, audit as never, {} as never);

    const result = await service.patchPlatformSettings(
      {
        rescueDiscountPercent: 15,
        marketplaceRelistSlaMs: 600_000,
        driverUnavailableScoreDelta: 7,
        carrierMarketplaceReleaseScoreDelta: 12,
        carrierClearingDays: 2,
        gstPercent: 12.5,
        perKmRateCents: 300,
        perKmMinBaseCents: 6000,
        hourlyRateCents: 9000,
        hourlyMinFloorHours: 3.5,
        hourlyMinBaseCents: 25000,
        settlementCycleCadenceDays: 7,
        settlementCutoffHour: 3,
      },
      'admin-1',
    );

    expect(result.rescueDiscountPercent).toBe(15);
    expect(result.carrierClearingDays).toBe(2);
    expect(result.gstPercent).toBe(12.5);
    expect(result.perKmRateCents).toBe(300);
    expect(result.hourlyRateCents).toBe(9000);
    expect(result.hourlyMinFloorHours).toBe(3.5);
    expect(result.settlementCycleCadenceDays).toBe(7);
    expect(result.settlementCutoffHour).toBe(3);
    expect(prisma.platformSettings.update).toHaveBeenCalledWith({
      where: { id: 'default' },
      data: {
        rescueDiscountPercent: 15,
        marketplaceRelistSlaMs: 600_000,
        driverUnavailableScoreDelta: 7,
        carrierMarketplaceReleaseScoreDelta: 12,
        carrierClearingDays: 2,
        gstPercent: 12.5,
        perKmRateCents: 300,
        perKmMinBaseCents: 6000,
        hourlyRateCents: 9000,
        hourlyMinFloorHours: 3.5,
        hourlyMinBaseCents: 25000,
        settlementCycleCadenceDays: 7,
        settlementCutoffHour: 3,
      },
    });
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.settings_updated',
        actorAdminId: 'admin-1',
        entityType: 'PlatformSettings',
      }),
    );
  });
});
