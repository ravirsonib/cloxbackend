import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { InAppNotificationsService } from './in-app-notifications.service';

describe('InAppNotificationsService', () => {
  const userPrincipal = {
    kind: 'user' as const,
    id: 'user-1',
    email: 'carrier@yopmail.com',
    role: 'TRANSPORT_COMPANY' as const,
    regionCodes: [],
    territoryCodes: [],
  };

  function makeService(prisma: Record<string, unknown>) {
    return new InAppNotificationsService(prisma as never);
  }

  it('unreadCount returns count for marketplace user', async () => {
    const prisma = {
      isConnected: () => true,
      notification: { count: jest.fn().mockResolvedValue(3) },
    };
    await expect(makeService(prisma).unreadCount(userPrincipal)).resolves.toEqual({
      count: 3,
    });
    expect(prisma.notification.count).toHaveBeenCalledWith({
      where: { userId: 'user-1', readAt: null },
    });
  });

  it('unreadCount rejects admin principal', async () => {
    const service = makeService({ isConnected: () => true });
    await expect(
      service.unreadCount({
        ...userPrincipal,
        kind: 'admin',
        role: 'SUPER_ADMIN' as never,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('listForPrincipal maps rows and nextCursor', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `11111111-1111-1111-1111-11111111111${i}`,
      type: NotificationType.JOB_PUBLISHED,
      title: `Job ${i}`,
      body: null,
      href: '/market',
      entityType: 'Job',
      entityId: 'job-1',
      readAt: null,
      createdAt: new Date('2026-10-29T00:00:00.000Z'),
    }));
    const prisma = {
      isConnected: () => true,
      notification: {
        findMany: jest.fn().mockResolvedValue(rows),
      },
    };
    const result = await makeService(prisma).listForPrincipal(userPrincipal, {
      limit: 2,
    });
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBe(rows[1]!.id);
    expect(result.items[0]).toMatchObject({
      title: 'Job 0',
      unread: true,
      href: '/market',
    });
  });

  it('markRead 404 when missing', async () => {
    const prisma = {
      isConnected: () => true,
      notification: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).markRead(userPrincipal, '11111111-1111-1111-1111-111111111111'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('markRead updates unread row', async () => {
    const existing = {
      id: '11111111-1111-1111-1111-111111111111',
      type: NotificationType.TRIP_STARTED,
      title: 'Trip started',
      body: null,
      href: '/jobs/j1',
      entityType: 'Trip',
      entityId: 't1',
      readAt: null,
      createdAt: new Date('2026-10-29T00:00:00.000Z'),
    };
    const prisma = {
      isConnected: () => true,
      notification: {
        findFirst: jest.fn().mockResolvedValue(existing),
        update: jest.fn().mockResolvedValue({
          ...existing,
          readAt: new Date('2026-10-29T01:00:00.000Z'),
        }),
      },
    };
    const result = await makeService(prisma).markRead(userPrincipal, existing.id);
    expect(result.unread).toBe(false);
    expect(prisma.notification.update).toHaveBeenCalled();
  });

  it('markAllRead updates many', async () => {
    const prisma = {
      isConnected: () => true,
      notification: {
        updateMany: jest.fn().mockResolvedValue({ count: 4 }),
      },
    };
    await expect(makeService(prisma).markAllRead(userPrincipal)).resolves.toEqual({
      updated: 4,
    });
  });

  it('notifyUsers createMany and returns count', async () => {
    const prisma = {
      isConnected: () => true,
      notification: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const count = await makeService(prisma).notifyUsers({
      userIds: ['u1', 'u2', 'u1'],
      type: NotificationType.JOB_PUBLISHED,
      title: 'New job',
      href: '/market',
    });
    expect(count).toBe(2);
    expect(prisma.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ userId: 'u1', type: NotificationType.JOB_PUBLISHED }),
        expect.objectContaining({ userId: 'u2' }),
      ],
    });
  });

  it('notifyUsers returns 0 when empty ids', async () => {
    const prisma = {
      isConnected: () => true,
      notification: { createMany: jest.fn() },
    };
    await expect(
      makeService(prisma).notifyUsers({
        userIds: [],
        type: NotificationType.JOB_PUBLISHED,
        title: 'x',
      }),
    ).resolves.toBe(0);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });
});
