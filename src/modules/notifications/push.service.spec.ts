import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NotificationType,
  PushDeliveryStatus,
  PushPlatform,
} from '@prisma/client';
import type { AppEnv } from '../../config/env.validation';
import { FcmPushProvider } from './fcm-push.provider';
import { InAppNotificationsService } from './in-app-notifications.service';
import { PushDevicesService } from './push-devices.service';
import { PushDispatchService } from './push-dispatch.service';
import {
  buildCollapseKey,
  buildPushData,
  DEFAULT_NOTIFICATION_PREFERENCE,
  getPushPolicy,
  isWithinQuietHours,
  maskPushToken,
} from './push.types';

function makeConfig(overrides: Partial<Record<keyof AppEnv, unknown>> = {}) {
  const map: Record<string, unknown> = {
    NODE_ENV: 'test',
    PUSH_ENABLED: true,
    PUSH_MOCK: true,
    PUSH_WORKER_INTERVAL_MS: 0,
    PUSH_MAX_ATTEMPTS: 4,
    ...overrides,
  };
  return {
    get: jest.fn((key: string) => map[key]),
  } as unknown as ConfigService<AppEnv, true>;
}

const driverPrincipal = {
  kind: 'user' as const,
  id: 'driver-user-1',
  sessionId: 'sess-1',
  email: 'driver@yopmail.com',
  role: 'DRIVER' as const,
  regionCodes: [],
  territoryCodes: [],
};

describe('push.types helpers', () => {
  it('evaluates wrap-around quiet hours (22:00 -> 06:00 UTC)', () => {
    const pref = {
      quietHoursEnabled: true,
      quietStartMinute: 22 * 60,
      quietEndMinute: 6 * 60,
      timezone: 'UTC',
    };
    expect(isWithinQuietHours(pref, new Date('2026-11-25T23:30:00Z'))).toBe(true);
    expect(isWithinQuietHours(pref, new Date('2026-11-25T05:15:00Z'))).toBe(true);
    expect(isWithinQuietHours(pref, new Date('2026-11-25T12:00:00Z'))).toBe(false);
  });

  it('evaluates same-day quiet hours (13:00 -> 15:00 UTC)', () => {
    const pref = {
      quietHoursEnabled: true,
      quietStartMinute: 13 * 60,
      quietEndMinute: 15 * 60,
      timezone: 'UTC',
    };
    expect(isWithinQuietHours(pref, new Date('2026-11-25T14:00:00Z'))).toBe(true);
    expect(isWithinQuietHours(pref, new Date('2026-11-25T16:00:00Z'))).toBe(false);
  });

  it('builds flat string FCM data payload with deep-link and entity IDs', () => {
    const data = buildPushData({
      notificationId: 'notif-1',
      type: NotificationType.TRIP_ASSIGNED,
      entityType: 'Trip',
      entityId: 'trip-99',
      href: '/trips/trip-99',
      unreadCount: 4,
    });
    expect(data).toEqual({
      schemaVersion: '1',
      notificationId: 'notif-1',
      type: 'TRIP_ASSIGNED',
      category: 'trip_updates',
      priority: 'high',
      channelId: 'clox_trips',
      entityType: 'Trip',
      entityId: 'trip-99',
      tripId: 'trip-99',
      route: '/trips/trip-99',
      unreadCount: '4',
    });
  });

  it('marks TRIP_EXCEPTION as critical and Ops types as Web Push eligible', () => {
    expect(getPushPolicy(NotificationType.TRIP_EXCEPTION).isCritical).toBe(true);
    expect(getPushPolicy(NotificationType.TRIP_EXCEPTION).channelId).toBe('clox_urgent');
    expect(getPushPolicy(NotificationType.COMPLIANCE_CASE_OPENED).pushEligible).toBe(true);
    expect(getPushPolicy(NotificationType.TRIP_EXCEPTION_ESCALATED).isCritical).toBe(true);
  });

  it('generates collapse key for repeatable alerts and masks tokens', () => {
    expect(buildCollapseKey(NotificationType.TRIP_APPROACHING, 'trip-1')).toBe(
      'trip_approaching:trip-1',
    );
    expect(buildCollapseKey(NotificationType.TRIP_ASSIGNED, 'trip-1')).toBeNull();
    expect(maskPushToken('abcdefghijklmnop123456')).toBe('abcdef...123456');
  });
});

describe('PushDevicesService', () => {
  it('upserts token bound to current user and session', async () => {
    const now = new Date('2026-11-25T10:00:00Z');
    const prisma = {
      isConnected: () => true,
      pushDevice: {
        upsert: jest.fn().mockResolvedValue({
          id: 'dev-1',
          platform: PushPlatform.ANDROID,
          deviceId: 'pixel-9',
          token: 'fcm-token-1234567890abcdef',
          isActive: true,
          lastSeenAt: now,
        }),
      },
    };
    const svc = new PushDevicesService(prisma as never);
    const res = await svc.registerDevice(driverPrincipal, {
      token: 'fcm-token-1234567890abcdef',
      platform: 'ANDROID',
      deviceId: 'pixel-9',
      appVersion: '1.2.0',
    });
    expect(res.id).toBe('dev-1');
    expect(res.tokenMasked).toBe('fcm-to...abcdef');
    expect(prisma.pushDevice.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { token: 'fcm-token-1234567890abcdef' },
        create: expect.objectContaining({
          userId: 'driver-user-1',
          sessionId: 'sess-1',
          platform: PushPlatform.ANDROID,
        }),
        update: expect.objectContaining({
          userId: 'driver-user-1',
          sessionId: 'sess-1',
          isActive: true,
        }),
      }),
    );
  });

  it('deactivates devices on logout and session revocation', async () => {
    const prisma = {
      isConnected: () => true,
      pushDevice: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const svc = new PushDevicesService(prisma as never);
    await expect(
      svc.unregisterDevice(driverPrincipal, { token: 'fcm-token-1234567890abcdef' }),
    ).resolves.toEqual({ deactivated: 1 });
    await expect(svc.deactivateForSession('sess-1')).resolves.toBe(1);
    await expect(svc.deactivateAllForUser('driver-user-1')).resolves.toBe(1);
  });

  it('returns default preferences and rejects invalid timezone on update', async () => {
    const prisma = {
      isConnected: () => true,
      notificationPreference: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
      },
    };
    const svc = new PushDevicesService(prisma as never);
    await expect(svc.getPreferences(driverPrincipal)).resolves.toEqual(
      DEFAULT_NOTIFICATION_PREFERENCE,
    );
    await expect(
      svc.updatePreferences(driverPrincipal, { timezone: 'Mars/Olympus_Mons' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PushDispatchService', () => {
  it('enqueues deliveries respecting category preferences while letting critical alerts bypass', async () => {
    const prisma = {
      isConnected: () => true,
      pushDevice: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'dev-1', userId: 'u1', platform: PushPlatform.ANDROID },
        ]),
      },
      notificationPreference: {
        findMany: jest.fn().mockResolvedValue([
          {
            userId: 'u1',
            ...DEFAULT_NOTIFICATION_PREFERENCE,
            pushEnabled: true,
            tripUpdates: false,
          },
        ]),
      },
      notification: {
        groupBy: jest.fn().mockResolvedValue([{ userId: 'u1', _count: { _all: 2 } }]),
      },
      pushDelivery: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const provider = new FcmPushProvider(makeConfig());
    const svc = new PushDispatchService(prisma as never, makeConfig(), provider);

    const count = await svc.enqueueForNotifications([
      {
        notificationId: 'n1',
        userId: 'u1',
        type: NotificationType.TRIP_STARTED, // muted by tripUpdates: false
        title: 'Started',
        body: null,
        href: '/trips/t1',
        entityType: 'Trip',
        entityId: 't1',
      },
      {
        notificationId: 'n2',
        userId: 'u1',
        type: NotificationType.TRIP_EXCEPTION, // critical -> bypasses mute!
        title: 'Breakdown',
        body: 'Action required',
        href: '/jobs/j1',
        entityType: 'TripException',
        entityId: 'ex1',
      },
    ]);

    expect(count).toBe(1);
    const callArg = prisma.pushDelivery.createMany.mock.calls[0]?.[0] as {
      data: Array<{ notificationId: string; type: NotificationType }>;
    };
    expect(callArg.data).toHaveLength(1);
    expect(callArg.data[0]?.notificationId).toBe('n2');
    expect(callArg.data[0]?.type).toBe(NotificationType.TRIP_EXCEPTION);
  });

  it('deactivates device on UNREGISTERED and retries on TRANSIENT error', async () => {
    const prisma = {
      isConnected: () => true,
      pushDelivery: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'del-1',
            attempts: 0,
            payload: {
              title: 'Assigned',
              body: null,
              data: { type: 'TRIP_ASSIGNED' },
              channelId: 'clox_trips',
              priority: 'high',
              collapseKey: null,
              badge: 1,
              isCritical: false,
            },
            device: {
              id: 'dev-dead',
              token: 'dead-token-1234567890',
              platform: PushPlatform.IOS,
              isActive: true,
            },
          },
          {
            id: 'del-2',
            attempts: 0,
            payload: {
              title: 'Assigned',
              body: null,
              data: { type: 'TRIP_ASSIGNED' },
              channelId: 'clox_trips',
              priority: 'high',
              collapseKey: null,
              badge: 1,
              isCritical: false,
            },
            device: {
              id: 'dev-ok',
              token: 'live-token-1234567890',
              platform: PushPlatform.ANDROID,
              isActive: true,
            },
          },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
      pushDevice: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const mockProvider = {
      mode: 'fcm' as const,
      send: jest
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          errorCode: 'UNREGISTERED',
          errorMessage: 'Not registered',
          shouldDeactivateDevice: true,
          retryable: false,
        })
        .mockResolvedValueOnce({
          ok: false,
          errorCode: 'TRANSIENT',
          errorMessage: '503 Service Unavailable',
          shouldDeactivateDevice: false,
          retryable: true,
        }),
    };

    const svc = new PushDispatchService(
      prisma as never,
      makeConfig(),
      mockProvider as unknown as FcmPushProvider,
    );
    const result = await svc.processPendingBatch();

    expect(result).toEqual({ processed: 2, sent: 0, failed: 1, retried: 1 });
    expect(prisma.pushDevice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dev-dead', isActive: true },
        data: expect.objectContaining({
          isActive: false,
          disableReason: 'FCM_UNREGISTERED',
        }),
      }),
    );
    expect(prisma.pushDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'del-1' },
        data: expect.objectContaining({ status: PushDeliveryStatus.FAILED }),
      }),
    );
    expect(prisma.pushDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'del-2' },
        data: expect.objectContaining({ attempts: 1 }),
      }),
    );
  });

  it('blocks test-push in production for non-SuperAdmin', async () => {
    const prisma = { isConnected: () => true };
    const cfg = makeConfig({ NODE_ENV: 'production' });
    const svc = new PushDispatchService(prisma as never, cfg, new FcmPushProvider(cfg));
    await expect(svc.sendTestPush(driverPrincipal, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('InAppNotificationsService forwards created marketplace notifications to PushDispatchService', async () => {
    const prisma = {
      isConnected: () => true,
      notification: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const pushDispatch = {
      enqueueForNotifications: jest.fn().mockResolvedValue(1),
    };
    const inbox = new InAppNotificationsService(
      prisma as never,
      pushDispatch as unknown as PushDispatchService,
    );

    await inbox.notifyUsers({
      userIds: ['u1'],
      type: NotificationType.TRIP_ASSIGNED,
      title: 'New trip assigned',
      body: 'Ready for pickup',
      href: '/trips/t1',
      entityType: 'Trip',
      entityId: 't1',
    });

    expect(pushDispatch.enqueueForNotifications).toHaveBeenCalledWith([
      expect.objectContaining({
        userId: 'u1',
        type: NotificationType.TRIP_ASSIGNED,
        title: 'New trip assigned',
        entityType: 'Trip',
        entityId: 't1',
      }),
    ]);
  });

  it('getPushStats aggregates active devices, 24h deliveries, and recent failures', async () => {
    const prisma = {
      isConnected: () => true,
      pushDevice: {
        groupBy: jest.fn().mockResolvedValue([
          { platform: PushPlatform.ANDROID, _count: { _all: 5 } },
          { platform: PushPlatform.IOS, _count: { _all: 3 } },
        ]),
      },
      pushDelivery: {
        groupBy: jest.fn().mockResolvedValue([
          { status: PushDeliveryStatus.SENT, _count: { _all: 42 } },
          { status: PushDeliveryStatus.FAILED, _count: { _all: 2 } },
          { status: PushDeliveryStatus.PENDING, _count: { _all: 1 } },
        ]),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'fail-1',
            type: NotificationType.TRIP_ASSIGNED,
            attempts: 4,
            lastError: 'FCM HTTP 503',
            updatedAt: new Date('2026-11-25T12:00:00Z'),
            device: { platform: PushPlatform.ANDROID },
          },
        ]),
      },
    };
    const cfg = makeConfig({ PUSH_ENABLED: true, PUSH_MOCK: true });
    const svc = new PushDispatchService(prisma as never, cfg, new FcmPushProvider(cfg));
    const stats = await svc.getPushStats();

    expect(stats).toEqual({
      enabled: true,
      mode: 'mock',
      activeDevices: { total: 8, android: 5, ios: 3, web: 0 },
      last24h: { sent: 42, failed: 2, pending: 1, skipped: 0 },
      recentFailures: [
        {
          id: 'fail-1',
          type: NotificationType.TRIP_ASSIGNED,
          platform: PushPlatform.ANDROID,
          attempts: 4,
          lastError: 'FCM HTTP 503',
          updatedAt: '2026-11-25T12:00:00.000Z',
        },
      ],
    });
  });
});
