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

  const adminPrincipal = {
    kind: 'admin' as const,
    id: 'admin-1',
    email: 'super@yopmail.com',
    role: 'SUPER_ADMIN' as const,
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

  it('unreadCount returns count for admin principal', async () => {
    const prisma = {
      isConnected: () => true,
      notification: { count: jest.fn().mockResolvedValue(2) },
    };
    await expect(makeService(prisma).unreadCount(adminPrincipal)).resolves.toEqual({
      count: 2,
    });
    expect(prisma.notification.count).toHaveBeenCalledWith({
      where: { adminUserId: 'admin-1', readAt: null },
    });
  });

  it('listForPrincipal maps rows and nextCursor (marketplace)', async () => {
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
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
      }),
    );
  });

  it('listForPrincipal scopes admin to adminUserId', async () => {
    const prisma = {
      isConnected: () => true,
      notification: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: '11111111-1111-1111-1111-111111111111',
            type: NotificationType.COMPLIANCE_CASE_OPENED,
            title: 'Case open',
            body: null,
            href: '/compliance/c1',
            entityType: 'ComplianceCase',
            entityId: 'c1',
            readAt: null,
            createdAt: new Date('2026-10-29T00:00:00.000Z'),
          },
        ]),
      },
    };
    const result = await makeService(prisma).listForPrincipal(adminPrincipal);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.type).toBe(NotificationType.COMPLIANCE_CASE_OPENED);
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { adminUserId: 'admin-1' },
      }),
    );
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

  it('markRead updates unread row for admin', async () => {
    const existing = {
      id: '11111111-1111-1111-1111-111111111111',
      type: NotificationType.TRIP_EXCEPTION_ESCALATED,
      title: 'Escalated',
      body: null,
      href: '/ops/exceptions',
      entityType: 'TripException',
      entityId: 'e1',
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
    const result = await makeService(prisma).markRead(adminPrincipal, existing.id);
    expect(result.unread).toBe(false);
    expect(prisma.notification.findFirst).toHaveBeenCalledWith({
      where: { id: existing.id, adminUserId: 'admin-1' },
    });
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
        expect.objectContaining({
          userId: 'u1',
          adminUserId: null,
          type: NotificationType.JOB_PUBLISHED,
        }),
        expect.objectContaining({ userId: 'u2', adminUserId: null }),
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

  it('notifyAdmins createMany with adminUserId only', async () => {
    const prisma = {
      isConnected: () => true,
      notification: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const count = await makeService(prisma).notifyAdmins({
      adminUserIds: ['a1', 'a2', 'a1'],
      type: NotificationType.COMPLIANCE_CASE_OPENED,
      title: 'KYB submitted',
      href: '/compliance/c1',
      regionId: 'reg-vic',
    });
    expect(count).toBe(2);
    expect(prisma.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          adminUserId: 'a1',
          userId: null,
          type: NotificationType.COMPLIANCE_CASE_OPENED,
          regionId: 'reg-vic',
        }),
        expect.objectContaining({ adminUserId: 'a2', userId: null }),
      ],
    });
  });

  it('adminIdsSuperAndStateForRegion unions Super + scoped State', async () => {
    const prisma = {
      isConnected: () => true,
      adminUser: {
        findMany: jest.fn().mockResolvedValue([{ id: 'super-1' }]),
      },
      adminScope: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ adminUserId: 'state-1' }, { adminUserId: 'state-1' }]),
      },
    };
    await expect(
      makeService(prisma).adminIdsSuperAndStateForRegion('reg-1'),
    ).resolves.toEqual(['super-1', 'state-1']);
  });

  it('notifyComplianceCaseToOps fans Super+State with case href', async () => {
    const prisma = {
      isConnected: () => true,
      adminUser: {
        findMany: jest.fn().mockResolvedValue([{ id: 'super-1' }]),
      },
      adminScope: {
        findMany: jest.fn().mockResolvedValue([{ adminUserId: 'state-vic' }]),
      },
      notification: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const count = await makeService(prisma).notifyComplianceCaseToOps({
      caseId: 'case-1',
      regionId: 'reg-vic',
      type: NotificationType.COMPLIANCE_CASE_OPENED,
      title: 'Compliance review: Acme',
    });
    expect(count).toBe(2);
    expect(prisma.adminScope.findMany).toHaveBeenCalled();
    expect(prisma.notification.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          adminUserId: 'super-1',
          href: '/compliance/case-1',
          entityType: 'ComplianceCase',
          entityId: 'case-1',
          regionId: 'reg-vic',
        }),
        expect.objectContaining({ adminUserId: 'state-vic' }),
      ]),
    });
  });

  it('notifyComplianceCaseToOps superOnly skips State Masters', async () => {
    const prisma = {
      isConnected: () => true,
      adminUser: {
        findMany: jest.fn().mockResolvedValue([{ id: 'super-1' }]),
      },
      adminScope: {
        findMany: jest.fn().mockResolvedValue([{ adminUserId: 'state-vic' }]),
      },
      notification: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    await makeService(prisma).notifyComplianceCaseToOps({
      caseId: 'case-partner',
      regionId: 'reg-vic',
      type: NotificationType.ADMIN_PARTNER_KYB_SUBMITTED,
      title: 'Partner KYB',
      superOnly: true,
    });
    expect(prisma.adminScope.findMany).not.toHaveBeenCalled();
    expect(prisma.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          adminUserId: 'super-1',
          type: NotificationType.ADMIN_PARTNER_KYB_SUBMITTED,
          href: '/compliance/case-partner',
        }),
      ],
    });
  });

  it('rejects unknown principal kind', async () => {
    const service = makeService({ isConnected: () => true });
    await expect(
      service.unreadCount({
        ...userPrincipal,
        kind: 'other' as never,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
