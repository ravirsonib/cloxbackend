import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NotificationType,
  Prisma,
  PushDeliveryStatus,
  PushPlatform,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import type { AppEnv } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import { AppRole, type TestPushInput } from '../../shared/types';
import { FcmPushProvider } from './fcm-push.provider';
import {
  buildCollapseKey,
  buildPushData,
  DEFAULT_NOTIFICATION_PREFERENCE,
  getPushPolicy,
  isCategoryEnabled,
  isWithinQuietHours,
  type PreferenceSnapshot,
  type PushPayload,
} from './push.types';

export type EnqueuePushNotificationItem = {
  notificationId: string | null;
  userId?: string | null;
  adminUserId?: string | null;
  type: NotificationType;
  title: string;
  body: string | null;
  href: string | null;
  entityType: string | null;
  entityId: string | null;
};

const BACKOFF_SECONDS = [10, 60, 300, 900];

@Injectable()
export class PushDispatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushDispatchService.name);
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly provider: FcmPushProvider,
  ) {}

  onModuleInit() {
    const nodeEnv = this.config.get('NODE_ENV', { infer: true });
    const intervalMs = this.config.get('PUSH_WORKER_INTERVAL_MS', { infer: true });
    if (nodeEnv === 'test' || !intervalMs || intervalMs <= 0) {
      return;
    }
    this.timer = setInterval(() => {
      void this.processPendingBatch();
    }, intervalMs);
    this.timer.unref?.();
    this.logger.log(
      `Push dispatch worker started (mode=${this.provider.mode}, interval=${intervalMs}ms)`,
    );
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private isPushEnabled(): boolean {
    return Boolean(this.config.get('PUSH_ENABLED', { infer: true }));
  }

  /**
   * Enqueues durable PushDelivery rows for active mobile devices of the recipients.
   * Respects NotificationPolicy, per-user category toggles, and quiet hours (critical alerts bypass quiet hours).
   * Best-effort: never throws to domain callers.
   */
  async enqueueForNotifications(
    items: EnqueuePushNotificationItem[],
  ): Promise<number> {
    if (!this.isPushEnabled() || items.length === 0 || !this.prisma.isConnected()) {
      return 0;
    }
    if (!this.prisma.pushDevice?.findMany || !this.prisma.pushDelivery?.createMany) {
      return 0;
    }

    const eligibleItems = items.filter((item) => getPushPolicy(item.type).pushEligible);
    if (eligibleItems.length === 0) return 0;

    try {
      const userIds = [
        ...new Set(eligibleItems.map((i) => i.userId).filter((v): v is string => Boolean(v))),
      ];
      const adminUserIds = [
        ...new Set(
          eligibleItems.map((i) => i.adminUserId).filter((v): v is string => Boolean(v)),
        ),
      ];
      if (userIds.length === 0 && adminUserIds.length === 0) return 0;

      const deviceOr: Prisma.PushDeviceWhereInput[] = [];
      const prefOr: Prisma.NotificationPreferenceWhereInput[] = [];
      if (userIds.length > 0) {
        deviceOr.push({ userId: { in: userIds } });
        prefOr.push({ userId: { in: userIds } });
      }
      if (adminUserIds.length > 0) {
        deviceOr.push({ adminUserId: { in: adminUserIds } });
        prefOr.push({ adminUserId: { in: adminUserIds } });
      }

      const [devices, prefs, userUnreadGroups, adminUnreadGroups] = await Promise.all([
        this.prisma.pushDevice.findMany({
          where: { isActive: true, OR: deviceOr },
          select: { id: true, userId: true, adminUserId: true, platform: true },
        }),
        this.prisma.notificationPreference.findMany({
          where: { OR: prefOr },
        }),
        userIds.length > 0
          ? this.prisma.notification.groupBy({
              by: ['userId'],
              where: { userId: { in: userIds }, readAt: null },
              _count: { _all: true },
            })
          : Promise.resolve([]),
        adminUserIds.length > 0
          ? this.prisma.notification.groupBy({
              by: ['adminUserId'],
              where: { adminUserId: { in: adminUserIds }, readAt: null },
              _count: { _all: true },
            })
          : Promise.resolve([]),
      ]);

      if (devices.length === 0) return 0;

      const ownerKey = (kind: 'user' | 'admin', id: string) => `${kind}:${id}`;
      const devicesByOwner = new Map<string, Array<{ id: string }>>();
      for (const dev of devices) {
        const key = dev.adminUserId
          ? ownerKey('admin', dev.adminUserId)
          : dev.userId
          ? ownerKey('user', dev.userId)
          : null;
        if (!key) continue;
        const list = devicesByOwner.get(key) ?? [];
        list.push({ id: dev.id });
        devicesByOwner.set(key, list);
      }

      const prefByOwner = new Map<string, PreferenceSnapshot>();
      for (const p of prefs) {
        const key = p.adminUserId
          ? ownerKey('admin', p.adminUserId)
          : p.userId
          ? ownerKey('user', p.userId)
          : null;
        if (!key) continue;
        prefByOwner.set(key, {
          pushEnabled: p.pushEnabled,
          tripUpdates: p.tripUpdates,
          jobsAndBids: p.jobsAndBids,
          scheduleAndCompliance: p.scheduleAndCompliance,
          paymentsAndBilling: p.paymentsAndBilling,
          quietHoursEnabled: p.quietHoursEnabled,
          quietStartMinute: p.quietStartMinute,
          quietEndMinute: p.quietEndMinute,
          timezone: p.timezone,
        });
      }

      const unreadByOwner = new Map<string, number>();
      for (const row of userUnreadGroups) {
        if (row.userId) unreadByOwner.set(ownerKey('user', row.userId), row._count._all);
      }
      for (const row of adminUnreadGroups) {
        if (row.adminUserId) {
          unreadByOwner.set(ownerKey('admin', row.adminUserId), row._count._all);
        }
      }

      const now = new Date();
      const deliveriesToCreate: Prisma.PushDeliveryCreateManyInput[] = [];

      for (const item of eligibleItems) {
        const key = item.adminUserId
          ? ownerKey('admin', item.adminUserId)
          : item.userId
          ? ownerKey('user', item.userId)
          : null;
        if (!key) continue;

        const targetDevices = devicesByOwner.get(key);
        if (!targetDevices || targetDevices.length === 0) continue;

        const policy = getPushPolicy(item.type);
        const pref = prefByOwner.get(key) ?? DEFAULT_NOTIFICATION_PREFERENCE;

        if (!pref.pushEnabled && !policy.isCritical) continue;
        if (!isCategoryEnabled(pref, policy.category) && !policy.isCritical) continue;
        if (!policy.isCritical && isWithinQuietHours(pref, now)) continue;

        const unreadCount = unreadByOwner.get(key) ?? 1;
        const payload: PushPayload = {
          title: item.title,
          body: item.body,
          data: buildPushData({
            notificationId: item.notificationId,
            type: item.type,
            entityType: item.entityType,
            entityId: item.entityId,
            href: item.href,
            unreadCount,
          }),
          channelId: policy.channelId,
          priority: policy.priority,
          collapseKey: buildCollapseKey(item.type, item.entityId),
          badge: unreadCount,
          isCritical: policy.isCritical,
        };

        for (const dev of targetDevices) {
          deliveriesToCreate.push({
            notificationId: item.notificationId,
            userId: item.userId ?? null,
            adminUserId: item.adminUserId ?? null,
            deviceId: dev.id,
            type: item.type,
            payload: payload as unknown as Prisma.InputJsonValue,
            status: PushDeliveryStatus.PENDING,
            nextAttemptAt: now,
          });
        }
      }

      if (deliveriesToCreate.length === 0) return 0;

      const created = await this.prisma.pushDelivery.createMany({
        data: deliveriesToCreate,
        skipDuplicates: true,
      });

      if (created.count > 0) {
        // Kick immediate async dispatch so push delivers with low latency.
        void this.processPendingBatch();
      }
      return created.count;
    } catch (error: unknown) {
      this.logger.warn(
        `Push enqueue failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  /**
   * Processes due PENDING PushDelivery rows, updating status, backoff, and deactivating stale tokens.
   */
  async processPendingBatch(limit = 50): Promise<{
    processed: number;
    sent: number;
    failed: number;
    retried: number;
  }> {
    if (
      this.isProcessing ||
      !this.isPushEnabled() ||
      !this.prisma.isConnected() ||
      !this.prisma.pushDelivery?.findMany
    ) {
      return { processed: 0, sent: 0, failed: 0, retried: 0 };
    }

    this.isProcessing = true;
    let sent = 0;
    let failed = 0;
    let retried = 0;

    try {
      const now = new Date();
      const maxAttempts = this.config.get('PUSH_MAX_ATTEMPTS', { infer: true });
      const pending = await this.prisma.pushDelivery.findMany({
        where: {
          status: PushDeliveryStatus.PENDING,
          nextAttemptAt: { lte: now },
        },
        include: {
          device: {
            select: { id: true, token: true, platform: true, isActive: true },
          },
        },
        orderBy: { nextAttemptAt: 'asc' },
        take: limit,
      });

      for (const row of pending) {
        if (!row.device || !row.device.isActive) {
          await this.prisma.pushDelivery.update({
            where: { id: row.id },
            data: {
              status: PushDeliveryStatus.SKIPPED,
              lastError: 'Device inactive',
            },
          });
          continue;
        }

        const payload = row.payload as unknown as PushPayload;
        const result = await this.provider.send({
          token: row.device.token,
          platform: row.device.platform,
          payload,
        });

        const nextAttemptNumber = row.attempts + 1;

        if (result.ok) {
          sent += 1;
          await this.prisma.pushDelivery.update({
            where: { id: row.id },
            data: {
              status: PushDeliveryStatus.SENT,
              attempts: nextAttemptNumber,
              providerMessageId: result.messageId,
              sentAt: new Date(),
              lastError: null,
            },
          });
          continue;
        }

        if (result.shouldDeactivateDevice) {
          await this.prisma.pushDevice.updateMany({
            where: { id: row.device.id, isActive: true },
            data: {
              isActive: false,
              disabledAt: new Date(),
              disableReason: result.errorCode === 'UNREGISTERED'
                ? 'FCM_UNREGISTERED'
                : 'FCM_INVALID_TOKEN',
            },
          });
        }

        if (result.retryable && nextAttemptNumber < maxAttempts) {
          retried += 1;
          const backoffSec =
            BACKOFF_SECONDS[Math.min(nextAttemptNumber - 1, BACKOFF_SECONDS.length - 1)] ?? 300;
          await this.prisma.pushDelivery.update({
            where: { id: row.id },
            data: {
              attempts: nextAttemptNumber,
              nextAttemptAt: new Date(Date.now() + backoffSec * 1000),
              lastError: result.errorMessage.slice(0, 500),
            },
          });
        } else {
          failed += 1;
          await this.prisma.pushDelivery.update({
            where: { id: row.id },
            data: {
              status: PushDeliveryStatus.FAILED,
              attempts: nextAttemptNumber,
              lastError: result.errorMessage.slice(0, 500),
            },
          });
        }
      }

      return { processed: pending.length, sent, failed, retried };
    } catch (error: unknown) {
      this.logger.warn(
        `Push batch processing failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { processed: 0, sent, failed, retried };
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Sends a direct test push to all active devices of the authenticated caller.
   * Allowed in non-production environments or for SUPER_ADMIN.
   */
  async sendTestPush(principal: AuthenticatedPrincipal, input: TestPushInput) {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
    const nodeEnv = this.config.get('NODE_ENV', { infer: true });
    const isSuperAdmin = principal.role === AppRole.SUPER_ADMIN;
    if (nodeEnv === 'production' && !isSuperAdmin) {
      throw new ForbiddenException('Test push is disabled in production');
    }
    if (principal.kind !== 'user' && principal.kind !== 'admin') {
      throw new ForbiddenException('Authenticated session required for test push');
    }

    const devices = await this.prisma.pushDevice.findMany({
      where: {
        isActive: true,
        ...(principal.kind === 'admin'
          ? { adminUserId: principal.id }
          : { userId: principal.id }),
      },
      select: { id: true, token: true, platform: true },
    });

    if (devices.length === 0) {
      return {
        mode: this.provider.mode,
        attempted: 0,
        sent: 0,
        failed: 0,
        results: [] as Array<{ deviceId: string; ok: boolean; error?: string }>,
      };
    }

    const type = (input.type as NotificationType | undefined) ?? NotificationType.TRIP_ASSIGNED;
    const policy = getPushPolicy(type);
    const payload: PushPayload = {
      title: input.title ?? 'CLOX test notification',
      body: input.body ?? 'Push notifications are connected and working on this device.',
      data: buildPushData({
        notificationId: null,
        type,
        entityType: 'Test',
        entityId: null,
        href: '/notifications',
        unreadCount: 1,
      }),
      channelId: policy.channelId,
      priority: policy.priority,
      collapseKey: null,
      badge: 1,
      isCritical: false,
    };

    let sent = 0;
    let failed = 0;
    const results: Array<{ deviceId: string; ok: boolean; messageId?: string; error?: string }> = [];

    for (const dev of devices) {
      const res = await this.provider.send({
        token: dev.token,
        platform: dev.platform,
        payload,
      });
      if (res.ok) {
        sent += 1;
        results.push({ deviceId: dev.id, ok: true, messageId: res.messageId });
      } else {
        failed += 1;
        results.push({ deviceId: dev.id, ok: false, error: res.errorMessage });
      }
    }

    return {
      mode: this.provider.mode,
      attempted: devices.length,
      sent,
      failed,
      results,
    };
  }

  /**
   * Super Admin operational health snapshot for mobile push notifications.
   * Returns active device counts by platform, last-24h delivery outcomes, and recent error summaries (no tokens/PII).
   */
  async getPushStats() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [deviceGroups, deliveryGroups, recentFailureRows] = await Promise.all([
      this.prisma.pushDevice.groupBy({
        by: ['platform'],
        where: { isActive: true },
        _count: { _all: true },
      }),
      this.prisma.pushDelivery.groupBy({
        by: ['status'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.pushDelivery.findMany({
        where: { status: PushDeliveryStatus.FAILED },
        orderBy: { updatedAt: 'desc' },
        take: 5,
        select: {
          id: true,
          type: true,
          attempts: true,
          lastError: true,
          updatedAt: true,
          device: { select: { platform: true } },
        },
      }),
    ]);

    const activeDevices = { total: 0, android: 0, ios: 0, web: 0 };
    for (const row of deviceGroups) {
      const count = row._count._all;
      activeDevices.total += count;
      if (row.platform === PushPlatform.ANDROID) activeDevices.android = count;
      else if (row.platform === PushPlatform.IOS) activeDevices.ios = count;
      else if (row.platform === PushPlatform.WEB) activeDevices.web = count;
    }

    const last24h = { sent: 0, failed: 0, pending: 0, skipped: 0 };
    for (const row of deliveryGroups) {
      const count = row._count._all;
      if (row.status === PushDeliveryStatus.SENT) last24h.sent = count;
      else if (row.status === PushDeliveryStatus.FAILED) last24h.failed = count;
      else if (row.status === PushDeliveryStatus.PENDING) last24h.pending = count;
      else if (row.status === PushDeliveryStatus.SKIPPED) last24h.skipped = count;
    }

    return {
      enabled: this.isPushEnabled(),
      mode: this.provider.mode,
      activeDevices,
      last24h,
      recentFailures: recentFailureRows.map((row) => ({
        id: row.id,
        type: row.type,
        platform: row.device?.platform ?? null,
        attempts: row.attempts,
        lastError: row.lastError,
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }
}
