import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AssignmentStatus,
  NotificationType,
  TripStatus,
} from '@prisma/client';
import type { AppEnv } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import { InAppNotificationsService } from '../notifications/in-app-notifications.service';

const LOOKAHEAD_MS = 60 * 60 * 1000; // 60 minutes before pickup
const GRACE_PAST_MS = 15 * 60 * 1000; // up to 15 minutes past pickup if not started

/**
 * Periodically scans for locked, unstarted trips whose scheduled pickup is approaching
 * and sends a single idempotent TRIP_REMINDER notification (in-app + mobile push) to the driver.
 */
@Injectable()
export class TripReminderWatchdog implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TripReminderWatchdog.name);
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
    @Optional() private readonly inbox?: InAppNotificationsService,
  ) {}

  onModuleInit() {
    const nodeEnv = this.config.get('NODE_ENV', { infer: true });
    const ms = this.config.get('TRIP_REMINDER_WATCHDOG_MS', { infer: true });
    if (nodeEnv === 'test' || !ms || ms <= 0) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runReminderSweep();
    }, ms);
    this.timer.unref?.();
    this.logger.log(`Trip pickup reminder watchdog scheduled every ${ms}ms`);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runReminderSweep(now: Date = new Date()): Promise<{ reminded: number }> {
    if (this.isRunning || !this.inbox || !this.prisma.isConnected()) {
      return { reminded: 0 };
    }
    this.isRunning = true;
    let reminded = 0;

    try {
      const windowStart = new Date(now.getTime() - GRACE_PAST_MS);
      const windowEnd = new Date(now.getTime() + LOOKAHEAD_MS);

      const dueTrips = await this.prisma.trip.findMany({
        where: {
          status: TripStatus.PENDING_GATES,
          startedAt: null,
          assignment: { status: AssignmentStatus.LOCKED },
          job: {
            pickupAt: {
              gte: windowStart,
              lte: windowEnd,
            },
          },
        },
        select: {
          id: true,
          job: { select: { id: true, title: true, pickupAt: true } },
          assignment: {
            select: {
              driver: { select: { userId: true } },
            },
          },
        },
        take: 100,
      });

      for (const trip of dueTrips) {
        const driverUserId = trip.assignment?.driver?.userId;
        if (!driverUserId) continue;

        const alreadyReminded = await this.prisma.notification.findFirst({
          where: {
            userId: driverUserId,
            type: NotificationType.TRIP_REMINDER,
            entityType: 'Trip',
            entityId: trip.id,
          },
          select: { id: true },
        });
        if (alreadyReminded) continue;

        const jobLabel = trip.job?.title || trip.job?.id.slice(0, 8) || trip.id.slice(0, 8);
        const sent = await this.inbox.notifyUsersLocalized({
          userIds: [driverUserId],
          type: NotificationType.TRIP_REMINDER,
          titleKey: 'trip.reminder.title',
          bodyKey: 'trip.reminder.body',
          vars: { jobTitle: jobLabel },
          href: `/trips/${trip.id}`,
          entityType: 'Trip',
          entityId: trip.id,
        });
        if (sent > 0) reminded += 1;
      }

      return { reminded };
    } catch (error: unknown) {
      this.logger.warn(
        `Trip reminder sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { reminded };
    } finally {
      this.isRunning = false;
    }
  }
}
