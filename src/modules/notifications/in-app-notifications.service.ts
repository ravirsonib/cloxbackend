import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AdminRole, AdminUserStatus, NotificationType, PlatformRole } from '@prisma/client';
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

export type NotifyAdminsInput = {
  adminUserIds: string[];
  type: NotificationType;
  title: string;
  body?: string | null;
  href?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  regionId?: string | null;
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

  /** Marketplace User or Ops AdminUser — both use the same inbox APIs. */
  private requireInboxPrincipal(principal: AuthenticatedPrincipal) {
    if (principal.kind !== 'user' && principal.kind !== 'admin') {
      throw new ForbiddenException('Authenticated principal required');
    }
    return principal;
  }

  private recipientWhere(principal: AuthenticatedPrincipal) {
    if (principal.kind === 'admin') {
      return { adminUserId: principal.id };
    }
    return { userId: principal.id };
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
    const actor = this.requireInboxPrincipal(principal);
    const take = Math.min(Math.max(opts?.limit ?? 20, 1), 50);
    const rows = await this.prisma.notification.findMany({
      where: this.recipientWhere(actor),
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
    const actor = this.requireInboxPrincipal(principal);
    const count = await this.prisma.notification.count({
      where: { ...this.recipientWhere(actor), readAt: null },
    });
    return { count };
  }

  async markRead(principal: AuthenticatedPrincipal, id: string) {
    this.ensureDatabase();
    const actor = this.requireInboxPrincipal(principal);
    const existing = await this.prisma.notification.findFirst({
      where: { id, ...this.recipientWhere(actor) },
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
    const actor = this.requireInboxPrincipal(principal);
    const result = await this.prisma.notification.updateMany({
      where: { ...this.recipientWhere(actor), readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  /** Fan-out create for marketplace users — never throws to callers. */
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
          adminUserId: null,
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

  /** Fan-out create for Ops AdminUsers — never throws to callers. */
  async notifyAdmins(input: NotifyAdminsInput): Promise<number> {
    const adminUserIds = [...new Set(input.adminUserIds.filter(Boolean))];
    if (adminUserIds.length === 0) return 0;
    if (!this.prisma.isConnected()) {
      this.logger.warn('Skipped admin in-app notify — database unavailable');
      return 0;
    }
    try {
      const result = await this.prisma.notification.createMany({
        data: adminUserIds.map((adminUserId) => ({
          adminUserId,
          userId: null,
          type: input.type,
          title: input.title,
          body: input.body ?? null,
          href: input.href ?? null,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          regionId: input.regionId ?? null,
        })),
      });
      return result.count;
    } catch (error: unknown) {
      this.logger.warn(
        `Admin in-app notify failed (${input.type}): ${
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

  /** ACTIVE Super Admins — national Ops inbox. */
  async adminIdsSuper(): Promise<string[]> {
    if (!this.prisma.isConnected()) return [];
    const rows = await this.prisma.adminUser.findMany({
      where: {
        role: AdminRole.SUPER_ADMIN,
        status: AdminUserStatus.ACTIVE,
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * ACTIVE State Masters whose AdminScope includes the region.
   * Used by A2+ emitters; Local is intentionally excluded from approve-type fans.
   */
  async adminIdsStateForRegion(regionId: string | null | undefined): Promise<string[]> {
    if (!regionId || !this.prisma.isConnected()) return [];
    const scopes = await this.prisma.adminScope.findMany({
      where: {
        regionId,
        adminUser: {
          role: AdminRole.STATE_MASTER,
          status: AdminUserStatus.ACTIVE,
        },
      },
      select: { adminUserId: true },
    });
    return [...new Set(scopes.map((s) => s.adminUserId))];
  }

  /** Super + State Masters for a region (compliance / exception fans). Local omitted. */
  async adminIdsSuperAndStateForRegion(
    regionId: string | null | undefined,
  ): Promise<string[]> {
    const [supers, state] = await Promise.all([
      this.adminIdsSuper(),
      this.adminIdsStateForRegion(regionId),
    ]);
    return [...new Set([...supers, ...state])];
  }

  /**
   * Ops inbox for a compliance case. Local is never included (G0-4 / Phase A).
   * `superOnly` — partner KYB (Super queue only).
   */
  async notifyComplianceCaseToOps(input: {
    caseId: string;
    regionId?: string | null;
    type: NotificationType;
    title: string;
    body?: string | null;
    superOnly?: boolean;
  }): Promise<number> {
    const adminUserIds = input.superOnly
      ? await this.adminIdsSuper()
      : await this.adminIdsSuperAndStateForRegion(input.regionId);
    return this.notifyAdmins({
      adminUserIds,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      href: `/compliance/${input.caseId}`,
      entityType: 'ComplianceCase',
      entityId: input.caseId,
      regionId: input.regionId ?? null,
    });
  }
}
