import { ConfigService } from '@nestjs/config';
import { NotificationType } from '@prisma/client';
import type { AppEnv } from '../../config/env.validation';
import { DriverService } from '../driver/driver.service';
import type { InAppNotificationsService } from '../notifications/in-app-notifications.service';
import { TripReminderWatchdog } from './trip-reminder.watchdog';

function makeConfig() {
  return {
    get: jest.fn((key: string) => {
      if (key === 'NODE_ENV') return 'test';
      if (key === 'TRIP_REMINDER_WATCHDOG_MS') return 0;
      return undefined;
    }),
  } as unknown as ConfigService<AppEnv, true>;
}

describe('TripReminderWatchdog', () => {
  it('reminds assigned driver once for upcoming unstarted trip and skips already-reminded trips', async () => {
    const now = new Date('2026-11-25T10:00:00Z');
    const prisma = {
      isConnected: () => true,
      trip: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'trip-1',
            job: { id: 'job-1', title: 'Sydney → Melbourne', pickupAt: new Date('2026-11-25T10:45:00Z') },
            assignment: { driver: { userId: 'driver-u1' } },
          },
          {
            id: 'trip-2',
            job: { id: 'job-2', title: 'Brisbane → Gold Coast', pickupAt: new Date('2026-11-25T10:30:00Z') },
            assignment: { driver: { userId: 'driver-u2' } },
          },
        ]),
      },
      notification: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 'existing-reminder' }),
      },
    };
    const inbox = {
      notifyUsersLocalized: jest.fn().mockResolvedValue(1),
    } as unknown as InAppNotificationsService;

    const watchdog = new TripReminderWatchdog(prisma as never, makeConfig(), inbox);
    await expect(watchdog.runReminderSweep(now)).resolves.toEqual({ reminded: 1 });

    expect(inbox.notifyUsersLocalized).toHaveBeenCalledTimes(1);
    expect(inbox.notifyUsersLocalized).toHaveBeenCalledWith(
      expect.objectContaining({
        userIds: ['driver-u1'],
        type: NotificationType.TRIP_REMINDER,
        titleKey: 'trip.reminder.title',
        entityType: 'Trip',
        entityId: 'trip-1',
      }),
    );
  });
});

describe('DriverService.notifyExpiringDriverLicences', () => {
  it('notifies driver whose licence expires within 14 days and skips recently notified', async () => {
    const now = new Date('2026-11-25T10:00:00Z');
    const prisma = {
      isConnected: () => true,
      driver: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'drv-1',
            userId: 'u-drv-1',
            licenceExpiry: new Date('2026-12-03T10:00:00Z'), // 8 days left
          },
          {
            id: 'drv-2',
            userId: 'u-drv-2',
            licenceExpiry: new Date('2026-12-01T10:00:00Z'),
          },
        ]),
      },
      notification: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 'recent-notif' }),
      },
    };
    const inbox = {
      notifyUsersLocalized: jest.fn().mockResolvedValue(1),
    } as unknown as InAppNotificationsService;

    const svc = new DriverService(
      prisma as never,
      {} as never,
      {} as never,
      makeConfig(),
      inbox,
    );
    await expect(svc.notifyExpiringDriverLicences(14, now)).resolves.toEqual({
      notified: 1,
    });
    expect(inbox.notifyUsersLocalized).toHaveBeenCalledTimes(1);
    expect(inbox.notifyUsersLocalized).toHaveBeenCalledWith(
      expect.objectContaining({
        userIds: ['u-drv-1'],
        type: NotificationType.DOCUMENT_EXPIRING,
        titleKey: 'document.expiring.title',
        vars: expect.objectContaining({ days: 8 }),
      }),
    );
  });
});
