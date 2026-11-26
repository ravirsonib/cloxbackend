import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PushPlatform } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  RegisterPushDeviceInput,
  UnregisterPushDeviceInput,
  UpdateNotificationPreferencesInput,
} from '../../shared/types';
import {
  DEFAULT_NOTIFICATION_PREFERENCE,
  maskPushToken,
  type PreferenceSnapshot,
} from './push.types';

function isValidTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat('en-AU', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

@Injectable()
export class PushDevicesService {
  private readonly logger = new Logger(PushDevicesService.name);

  constructor(private readonly prisma: PrismaService) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  private requirePushPrincipal(principal: AuthenticatedPrincipal) {
    if (principal.kind !== 'user' && principal.kind !== 'admin') {
      throw new ForbiddenException('Authenticated principal required for push notifications');
    }
    return principal;
  }

  private ownerFields(principal: AuthenticatedPrincipal) {
    return principal.kind === 'admin'
      ? { userId: null, adminUserId: principal.id }
      : { userId: principal.id, adminUserId: null };
  }

  private ownerWhere(principal: AuthenticatedPrincipal) {
    return principal.kind === 'admin'
      ? { adminUserId: principal.id }
      : { userId: principal.id };
  }

  async registerDevice(
    principal: AuthenticatedPrincipal,
    input: RegisterPushDeviceInput,
  ) {
    this.ensureDatabase();
    const actor = this.requirePushPrincipal(principal);
    const owner = this.ownerFields(actor);
    const now = new Date();
    const platform = input.platform as PushPlatform;

    const device = await this.prisma.pushDevice.upsert({
      where: { token: input.token },
      create: {
        ...owner,
        sessionId: actor.sessionId ?? null,
        platform,
        token: input.token,
        deviceId: input.deviceId ?? null,
        appVersion: input.appVersion ?? null,
        osVersion: input.osVersion ?? null,
        deviceModel: input.deviceModel ?? null,
        locale: input.locale ?? null,
        isActive: true,
        lastSeenAt: now,
        disabledAt: null,
        disableReason: null,
      },
      update: {
        // Reassign ownership if a shared device/browser switches accounts.
        ...owner,
        sessionId: actor.sessionId ?? null,
        platform,
        deviceId: input.deviceId ?? undefined,
        appVersion: input.appVersion ?? undefined,
        osVersion: input.osVersion ?? undefined,
        deviceModel: input.deviceModel ?? undefined,
        locale: input.locale ?? undefined,
        isActive: true,
        lastSeenAt: now,
        disabledAt: null,
        disableReason: null,
      },
    });

    return {
      id: device.id,
      platform: device.platform,
      deviceId: device.deviceId,
      tokenMasked: maskPushToken(device.token),
      isActive: device.isActive,
      lastSeenAt: device.lastSeenAt.toISOString(),
    };
  }

  async unregisterDevice(
    principal: AuthenticatedPrincipal,
    input: UnregisterPushDeviceInput,
  ) {
    this.ensureDatabase();
    const actor = this.requirePushPrincipal(principal);
    const now = new Date();

    const where = input.token
      ? { ...this.ownerWhere(actor), token: input.token, isActive: true }
      : { ...this.ownerWhere(actor), deviceId: input.deviceId, isActive: true };

    const result = await this.prisma.pushDevice.updateMany({
      where,
      data: {
        isActive: false,
        disabledAt: now,
        disableReason: 'LOGOUT',
      },
    });

    return { deactivated: result.count };
  }

  async listDevices(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const actor = this.requirePushPrincipal(principal);

    const rows = await this.prisma.pushDevice.findMany({
      where: { ...this.ownerWhere(actor), isActive: true },
      orderBy: { lastSeenAt: 'desc' },
      take: 20,
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        platform: row.platform,
        deviceId: row.deviceId,
        tokenMasked: maskPushToken(row.token),
        appVersion: row.appVersion,
        osVersion: row.osVersion,
        deviceModel: row.deviceModel,
        locale: row.locale,
        lastSeenAt: row.lastSeenAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /** Called by AuthService when a single session is revoked or logged out. Best-effort. */
  async deactivateForSession(sessionId: string, reason = 'SESSION_REVOKED'): Promise<number> {
    if (!sessionId || !this.prisma.isConnected()) return 0;
    try {
      const res = await this.prisma.pushDevice.updateMany({
        where: { sessionId, isActive: true },
        data: {
          isActive: false,
          disabledAt: new Date(),
          disableReason: reason,
        },
      });
      return res.count;
    } catch (error: unknown) {
      this.logger.warn(
        `Failed to deactivate push devices for session ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  /** Called by AuthService on logout(allDevices: true) for marketplace User. Best-effort. */
  async deactivateAllForUser(userId: string, reason = 'LOGOUT_ALL'): Promise<number> {
    if (!userId || !this.prisma.isConnected()) return 0;
    try {
      const res = await this.prisma.pushDevice.updateMany({
        where: { userId, isActive: true },
        data: {
          isActive: false,
          disabledAt: new Date(),
          disableReason: reason,
        },
      });
      return res.count;
    } catch (error: unknown) {
      this.logger.warn(
        `Failed to deactivate push devices for user ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  /** Called by AuthService on logout(allDevices: true) for Ops AdminUser. Best-effort. */
  async deactivateAllForAdmin(adminUserId: string, reason = 'LOGOUT_ALL'): Promise<number> {
    if (!adminUserId || !this.prisma.isConnected()) return 0;
    try {
      const res = await this.prisma.pushDevice.updateMany({
        where: { adminUserId, isActive: true },
        data: {
          isActive: false,
          disabledAt: new Date(),
          disableReason: reason,
        },
      });
      return res.count;
    } catch (error: unknown) {
      this.logger.warn(
        `Failed to deactivate push devices for admin ${adminUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  async getPreferences(principal: AuthenticatedPrincipal): Promise<PreferenceSnapshot> {
    this.ensureDatabase();
    const actor = this.requirePushPrincipal(principal);

    const row = await this.prisma.notificationPreference.findUnique({
      where: actor.kind === 'admin' ? { adminUserId: actor.id } : { userId: actor.id },
    });

    if (!row) {
      return { ...DEFAULT_NOTIFICATION_PREFERENCE };
    }

    return {
      pushEnabled: row.pushEnabled,
      tripUpdates: row.tripUpdates,
      jobsAndBids: row.jobsAndBids,
      scheduleAndCompliance: row.scheduleAndCompliance,
      paymentsAndBilling: row.paymentsAndBilling,
      quietHoursEnabled: row.quietHoursEnabled,
      quietStartMinute: row.quietStartMinute,
      quietEndMinute: row.quietEndMinute,
      timezone: row.timezone,
    };
  }

  async updatePreferences(
    principal: AuthenticatedPrincipal,
    input: UpdateNotificationPreferencesInput,
  ): Promise<PreferenceSnapshot> {
    this.ensureDatabase();
    const actor = this.requirePushPrincipal(principal);

    if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) {
      throw new BadRequestException(`Invalid IANA timezone: ${input.timezone}`);
    }

    const where =
      actor.kind === 'admin' ? { adminUserId: actor.id } : { userId: actor.id };
    const row = await this.prisma.notificationPreference.upsert({
      where,
      create: {
        ...this.ownerFields(actor),
        ...DEFAULT_NOTIFICATION_PREFERENCE,
        ...input,
      },
      update: {
        ...(input.pushEnabled !== undefined ? { pushEnabled: input.pushEnabled } : {}),
        ...(input.tripUpdates !== undefined ? { tripUpdates: input.tripUpdates } : {}),
        ...(input.jobsAndBids !== undefined ? { jobsAndBids: input.jobsAndBids } : {}),
        ...(input.scheduleAndCompliance !== undefined
          ? { scheduleAndCompliance: input.scheduleAndCompliance }
          : {}),
        ...(input.paymentsAndBilling !== undefined
          ? { paymentsAndBilling: input.paymentsAndBilling }
          : {}),
        ...(input.quietHoursEnabled !== undefined
          ? { quietHoursEnabled: input.quietHoursEnabled }
          : {}),
        ...(input.quietStartMinute !== undefined
          ? { quietStartMinute: input.quietStartMinute }
          : {}),
        ...(input.quietEndMinute !== undefined
          ? { quietEndMinute: input.quietEndMinute }
          : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      },
    });

    return {
      pushEnabled: row.pushEnabled,
      tripUpdates: row.tripUpdates,
      jobsAndBids: row.jobsAndBids,
      scheduleAndCompliance: row.scheduleAndCompliance,
      paymentsAndBilling: row.paymentsAndBilling,
      quietHoursEnabled: row.quietHoursEnabled,
      quietStartMinute: row.quietStartMinute,
      quietEndMinute: row.quietEndMinute,
      timezone: row.timezone,
    };
  }
}
