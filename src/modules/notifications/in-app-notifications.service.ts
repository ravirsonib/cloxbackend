import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { NotificationType, PlatformRole } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';

export type NotifyUsersInput = {
  userIds: string[];
  type: NotificationType;
  title: string;
  body?: string | null;
  href?: string | null;
  entityType?: string | null;
  entityId?: string | null;
};

@Injectable()
export class InAppNotificationsService {
  private readonly logger = new Logger(InAppNotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  private requireMarketplaceUser(principal: AuthenticatedPrincipal) {
    if (principal.kind !== 'user') {
      throw new ForbiddenException('Marketplace user required');
    }
    return principal;
  }

  private mapRow(row: {
    id: string;
    type: NotificationType;
    title: string;
    body: string | null;
    href: string | null;
    entityType: string | null;
    entityId: string | null;
    readAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      href: row.href,
      entityType: row.entityType,
      entityId: row.entityId,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      unread: row.readAt == null,
    };
  }

  async listForPrincipal(
    principal: AuthenticatedPrincipal,
    opts?: { limit?: number; cursor?: string },
  ) {
    this.ensureDatabase();
    const user = this.requireMarketplaceUser(principal);
    const take = Math.min(Math.max(opts?.limit ?? 20, 1), 50);
    const rows = await this.prisma.notification.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(opts?.cursor
        ? { cursor: { id: opts.cursor }, skip: 1 }
        : {}),
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return {
      items: page.map((r) => this.mapRow(r)),
      nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    };
  }

  async unreadCount(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const user = this.requireMarketplaceUser(principal);
    const count = await this.prisma.notification.count({
      where: { userId: user.id, readAt: null },
    });
    return { count };
  }

  async markRead(principal: AuthenticatedPrincipal, id: string) {
    this.ensureDatabase();
    const user = this.requireMarketplaceUser(principal);
    const existing = await this.prisma.notification.findFirst({
      where: { id, userId: user.id },
    });
    if (!existing) throw new NotFoundException('Notification not found');
    if (existing.readAt) return this.mapRow(existing);
    const updated = await this.prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });
    return this.mapRow(updated);
  }

  async markAllRead(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const user = this.requireMarketplaceUser(principal);
    const result = await this.prisma.notification.updateMany({
      where: { userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  /** Fan-out create — never throws to callers; logs and returns 0 on failure. */
  async notifyUsers(input: NotifyUsersInput): Promise<number> {
    const userIds = [...new Set(input.userIds.filter(Boolean))];
    if (userIds.length === 0) return 0;
    if (!this.prisma.isConnected()) {
      this.logger.warn('Skipped in-app notify — database unavailable');
      return 0;
    }
    try {
      const result = await this.prisma.notification.createMany({
        data: userIds.map((userId) => ({
          userId,
          type: input.type,
          title: input.title,
          body: input.body ?? null,
          href: input.href ?? null,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
        })),
      });
      return result.count;
    } catch (error: unknown) {
      this.logger.warn(
        `In-app notify failed (${input.type}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  async userIdsForCompanies(params: {
    companyIds: string[];
    roles: PlatformRole[];
  }): Promise<string[]> {
    if (!this.prisma.isConnected() || params.companyIds.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: {
        companyId: { in: params.companyIds },
        role: { in: params.roles },
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  async userIdForDriver(driverId: string | null | undefined): Promise<string | null> {
    if (!driverId || !this.prisma.isConnected()) return null;
    const driver = await this.prisma.driver.findUnique({
      where: { id: driverId },
      select: { userId: true },
    });
    return driver?.userId ?? null;
  }
}
