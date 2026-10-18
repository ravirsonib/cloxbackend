import { DriverStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { DriverService } from './driver.service';

const driverPrincipal: AuthenticatedPrincipal = {
  id: 'user-driver',
  email: 'driver@yopmail.com',
  role: 'DRIVER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('DriverService wizard / invite helper leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const notifications = {
    sendDriverInviteEmail: jest.fn().mockResolvedValue({ skipped: false, messageId: 'm1' }),
  };
  const config = {
    get: (k: string) => {
      if (k === 'ADMIN_APP_URL') return 'https://app.clox.test';
      if (k === 'DRIVER_INVITE_TTL_HOURS') return 72;
      return undefined;
    },
  };

  function makeService(prisma: Record<string, unknown> = { isConnected: () => true }) {
    return new DriverService(
      prisma as never,
      audit as never,
      notifications as never,
      config as never,
    );
  }

  function userWithDriver(overrides: Record<string, unknown> = {}) {
    return {
      id: 'user-driver',
      email: 'driver@yopmail.com',
      name: 'Drv',
      phone: null,
      role: 'DRIVER',
      driver: {
        id: 'drv-1',
        status: DriverStatus.PENDING_REVIEW,
        companyId: 'co-c',
        company: { id: 'co-c', legalName: 'Carrier Co', status: 'ACTIVE' },
        licenceNo: null,
        licenceClass: null,
        licenceExpiry: null,
        nhvrAcknowledgedAt: null,
        inviteAcceptedAt: new Date('2026-01-01'),
        ...overrides,
      },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('invite helpers expose ttl / url / token', () => {
    const service = makeService();
    expect(service.inviteTtlHours()).toBe(72);
    expect(service.inviteBaseUrl()).toBe('https://app.clox.test');
    const token = service.createInviteToken();
    expect(token.raw.length).toBeGreaterThan(10);
    expect(token.hash).toBeTruthy();
    expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(service.inviteUrl(token.raw)).toContain('/driver/invite/');
    expect(service.inviteUrl(token.raw)).toContain(token.raw);
  });

  it('sendInviteMail delegates to notifications', async () => {
    const service = makeService();
    await expect(
      service.sendInviteMail({
        email: 'driver@yopmail.com',
        name: 'Drv',
        companyName: 'Carrier Co',
        rawToken: 'tok123',
      }),
    ).resolves.toMatchObject({ skipped: false });
    expect(notifications.sendDriverInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'driver@yopmail.com',
        inviteUrl: expect.stringContaining('tok123'),
        expiresHours: 72,
      }),
    );
  });

  it('getOnboarding wizard steps: accept / licence / suspended / complete', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(
            userWithDriver({
              inviteAcceptedAt: null,
              status: DriverStatus.INVITED,
            }),
          )
          .mockResolvedValueOnce(userWithDriver())
          .mockResolvedValueOnce(
            userWithDriver({ status: DriverStatus.SUSPENDED }),
          )
          .mockResolvedValueOnce(
            userWithDriver({
              status: DriverStatus.ACTIVE,
              licenceNo: 'L1',
              licenceClass: 'C',
              licenceExpiry: new Date('2030-01-01'),
              nhvrAcknowledgedAt: new Date(),
            }),
          ),
      },
    };
    const service = makeService(prisma);
    await expect(service.getOnboarding(driverPrincipal)).resolves.toMatchObject({
      step: 'accept',
    });
    await expect(service.getOnboarding(driverPrincipal)).resolves.toMatchObject({
      step: 'licence',
    });
    await expect(service.getOnboarding(driverPrincipal)).resolves.toMatchObject({
      step: 'suspended',
    });
    await expect(service.getOnboarding(driverPrincipal)).resolves.toMatchObject({
      step: 'complete',
    });
  });

  it('getAssignability reasons for inactive / invalid licence / missing NHVR', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(
            userWithDriver({
              status: DriverStatus.PENDING_REVIEW,
              licenceClass: 'C',
              licenceExpiry: new Date('2030-01-01'),
              nhvrAcknowledgedAt: new Date(),
            }),
          )
          .mockResolvedValueOnce(
            userWithDriver({
              status: DriverStatus.ACTIVE,
              licenceClass: 'C',
              licenceExpiry: new Date('2020-01-01'),
              nhvrAcknowledgedAt: new Date(),
            }),
          )
          .mockResolvedValueOnce(
            userWithDriver({
              status: DriverStatus.ACTIVE,
              licenceClass: 'C',
              licenceExpiry: new Date('2030-01-01'),
              nhvrAcknowledgedAt: null,
            }),
          ),
      },
    };
    const service = makeService(prisma);
    await expect(service.getAssignability(driverPrincipal)).resolves.toMatchObject({
      reason: 'DRIVER_NOT_ACTIVE',
      canBeAssigned: false,
    });
    await expect(service.getAssignability(driverPrincipal)).resolves.toMatchObject({
      reason: 'LICENCE_INVALID',
    });
    await expect(service.getAssignability(driverPrincipal)).resolves.toMatchObject({
      reason: 'NHVR_REQUIRED',
    });
  });
});
