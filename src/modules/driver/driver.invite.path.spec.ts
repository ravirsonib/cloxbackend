import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DriverStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { hashValue } from '../../common/utils/crypto';
import { DriverService } from './driver.service';

const driverPrincipal: AuthenticatedPrincipal = {
  id: 'user-driver',
  email: 'driver@yopmail.com',
  role: 'DRIVER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('DriverService invite + assignability paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const notifications = {
    sendDriverInviteEmail: jest.fn().mockResolvedValue({ skipped: true }),
  };
  const config = {
    get: (k: string) => {
      if (k === 'ADMIN_APP_URL') return 'https://app.clox.test';
      if (k === 'DRIVER_INVITE_TTL_HOURS') return 48;
      return undefined;
    },
  };

  function makeService(prisma: Record<string, unknown>) {
    return new DriverService(
      prisma as never,
      audit as never,
      notifications as never,
      config as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('peekInvite returns canAccept for valid INVITED token', async () => {
    const token = 'invite-raw';
    const prisma = {
      isConnected: () => true,
      driver: {
        findFirst: jest.fn().mockResolvedValue({
          status: DriverStatus.INVITED,
          inviteExpiresAt: new Date('2099-01-01'),
          inviteAcceptedAt: null,
          user: { email: 'driver.clox@yopmail.com', name: 'D' },
          company: { legalName: 'Carrier Co' },
        }),
      },
    };
    const service = makeService(prisma);
    const result = await service.peekInvite(token);
    expect(result).toMatchObject({
      email: 'driver.clox@yopmail.com',
      canAccept: true,
      expired: false,
      consumed: false,
    });
    expect(prisma.driver.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { inviteTokenHash: hashValue(token) },
      }),
    );
  });

  it('peekInvite throws when token unknown', async () => {
    const prisma = {
      isConnected: () => true,
      driver: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = makeService(prisma);
    await expect(service.peekInvite('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('acceptInvite rejects expired invite', async () => {
    const prisma = {
      isConnected: () => true,
      driver: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'drv-1',
          status: DriverStatus.INVITED,
          inviteExpiresAt: new Date('2020-01-01'),
          inviteAcceptedAt: null,
          user: { email: 'driver.clox@yopmail.com' },
          company: { legalName: 'C' },
        }),
      },
    };
    const service = makeService(prisma);
    await expect(service.acceptInvite({ token: 't' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('acceptInvite updates driver+user and returns otp_login next', async () => {
    const prisma = {
      isConnected: () => true,
      driver: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'drv-1',
          userId: 'user-driver',
          status: DriverStatus.INVITED,
          inviteExpiresAt: new Date('2099-01-01'),
          inviteAcceptedAt: null,
          user: { email: 'driver.clox@yopmail.com' },
          company: { legalName: 'Carrier Co' },
        }),
        update: jest.fn(),
      },
      user: { update: jest.fn() },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    const service = makeService(prisma);
    const result = await service.acceptInvite({ token: 'raw-token' });
    expect(result).toMatchObject({
      email: 'driver.clox@yopmail.com',
      next: 'otp_login',
    });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(audit.recordPlatform).toHaveBeenCalled();
  });

  it('getAssignability canBeAssigned when ACTIVE + licence + NHVR', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-driver',
          email: 'driver@yopmail.com',
          name: 'D',
          phone: null,
          driver: {
            id: 'drv-1',
            status: DriverStatus.ACTIVE,
            companyId: 'co-c',
            licenceNo: 'L1',
            licenceClass: 'HC',
            licenceExpiry: new Date('2030-01-01'),
            nhvrAcknowledgedAt: new Date('2026-01-01'),
            inviteAcceptedAt: new Date('2026-01-01'),
            company: { id: 'co-c', legalName: 'C', status: 'BID_ELIGIBLE' },
          },
        }),
      },
    };
    const service = makeService(prisma);
    const result = await service.getAssignability(driverPrincipal);
    expect(result.canBeAssigned).toBe(true);
  });

  it('submitProfile rejects INVITED before accept', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-driver',
          email: 'driver@yopmail.com',
          name: null,
          phone: null,
          driver: {
            id: 'drv-1',
            status: DriverStatus.INVITED,
            companyId: 'co-c',
            inviteAcceptedAt: null,
            licenceNo: null,
            licenceClass: null,
            licenceExpiry: null,
            nhvrAcknowledgedAt: null,
            company: { id: 'co-c', legalName: 'C', status: 'DRAFT' },
          },
        }),
      },
    };
    const service = makeService(prisma);
    await expect(
      service.submitProfile(driverPrincipal, {
        licenceNo: 'L1',
        licenceClass: 'HC',
        licenceExpiry: '2030-01-01',
        nhvrAcknowledged: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects non-driver principal', async () => {
    const service = makeService({ isConnected: () => true });
    await expect(
      service.getOnboarding({
        ...driverPrincipal,
        role: 'SENDER',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
