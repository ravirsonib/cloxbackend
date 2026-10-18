import {
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
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

describe('DriverService gate leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const notifications = { sendDriverInviteEmail: jest.fn() };
  const config = {
    get: (k: string) => {
      if (k === 'DRIVER_INVITE_TTL_HOURS') return 48;
      if (k === 'ADMIN_APP_URL') return 'https://admin.example';
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

  it('ensureDatabase throws when offline', async () => {
    await expect(
      makeService({ isConnected: () => false }).getOnboarding(driverPrincipal),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('requireDriver 404 when profile missing', async () => {
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-driver', driver: null }) },
    };
    await expect(
      makeService(prisma).getOnboarding(driverPrincipal),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('wizardStep returns complete when licence+nhvr filled but not ACTIVE', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-driver',
          driver: {
            id: 'drv-1',
            status: DriverStatus.INVITED,
            inviteAcceptedAt: new Date(),
            licenceNo: 'L1',
            licenceClass: 'HC',
            licenceExpiry: new Date('2030-01-01'),
            nhvrAcknowledgedAt: new Date(),
            companyId: 'co-c',
            company: { id: 'co-c', legalName: 'C', status: 'ACTIVE' },
          },
        }),
      },
    };
    const result = await makeService(prisma).getOnboarding(driverPrincipal);
    expect(result.step).toBe('complete');
  });
});
