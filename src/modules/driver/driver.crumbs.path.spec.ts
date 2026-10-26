import { CompanyStatus, CompanyType, DriverStatus } from '@prisma/client';
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

describe('DriverService crumb branch leftovers', () => {
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

  beforeEach(() => jest.clearAllMocks());

  it('previewInvite unknown company name; acceptInvite + getOnboarding null company', async () => {
    const token = 'tok-crumb';
    const prisma = {
      isConnected: () => true,
      driver: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'drv-1',
          status: DriverStatus.INVITED,
          inviteAcceptedAt: null,
          inviteExpiresAt: new Date('2099-01-01'),
          user: { email: 'driver@yopmail.com', name: 'D' },
          company: null,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-driver',
          email: 'driver@yopmail.com',
          name: 'D',
          phone: null,
          role: 'DRIVER',
          driver: {
            id: 'drv-1',
            status: DriverStatus.ACTIVE,
            companyId: null,
            company: null,
            licenceNo: 'L1',
            licenceClass: 'C',
            licenceExpiry: new Date('2030-01-01'),
            nhvrAcknowledgedAt: new Date(),
            inviteAcceptedAt: new Date(),
          },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(async (ops: unknown[]) => ops),
    };

    await expect(makeService(prisma).peekInvite(token)).resolves.toMatchObject({
      companyName: 'Unknown company',
    });

    prisma.driver.findFirst.mockResolvedValue({
      id: 'drv-1',
      userId: 'user-driver',
      status: DriverStatus.INVITED,
      inviteAcceptedAt: null,
      inviteExpiresAt: new Date('2099-01-01'),
      user: { email: 'driver@yopmail.com' },
      company: null,
    });
    await expect(
      makeService(prisma).acceptInvite({ token }),
    ).resolves.toMatchObject({
      companyName: 'Unknown company',
    });
    expect(prisma.driver.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { inviteTokenHash: hashValue(token) },
      }),
    );

    const onboarding = await makeService(prisma).getOnboarding(driverPrincipal);
    expect(onboarding.company).toBeNull();
  });

  it('submitProfile ISO licenceExpiry + licenceDocumentId metadata', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'user-driver',
            email: 'driver@yopmail.com',
            name: 'D',
            phone: null,
            driver: {
              id: 'drv-1',
              status: DriverStatus.PENDING_REVIEW,
              companyId: 'co-c',
              company: { id: 'co-c', legalName: 'Carrier Co', status: 'ACTIVE' },
              licenceNo: null,
              licenceClass: null,
              licenceExpiry: null,
              nhvrAcknowledgedAt: null,
              inviteAcceptedAt: new Date(),
              emergencyContactName: null,
              emergencyContactPhone: null,
              addressLine1: null,
              suburb: null,
              state: null,
              postcode: null,
            },
          })
          .mockResolvedValueOnce({
            id: 'user-driver',
            email: 'driver@yopmail.com',
            name: 'Driver One',
            phone: '0412345678',
            driver: {
              id: 'drv-1',
              status: DriverStatus.ACTIVE,
              companyId: 'co-c',
              company: { id: 'co-c', legalName: 'Carrier Co', status: 'ACTIVE' },
              licenceNo: 'L1',
              licenceClass: 'C',
              licenceExpiry: new Date('2030-06-01T12:00:00.000Z'),
              nhvrAcknowledgedAt: new Date(),
              inviteAcceptedAt: new Date(),
              emergencyContactName: 'Emergency Contact',
              emergencyContactPhone: '0498765432',
              addressLine1: '12 Test Street',
              suburb: 'Richmond',
              state: 'VIC',
              postcode: '3121',
            },
          }),
        update: jest.fn().mockResolvedValue({}),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-c',
          status: CompanyStatus.ACTIVE,
          homeRegionId: null,
          type: CompanyType.CARRIER,
        }),
      },
      complianceDocument: {
        findFirst: jest.fn().mockResolvedValue({ id: 'doc-lic' }),
      },
      driver: {
        update: jest.fn().mockResolvedValue({ id: 'drv-1', status: DriverStatus.ACTIVE }),
      },
      $transaction: jest.fn(async (ops: unknown[]) => ops),
    };
    await makeService(prisma).submitProfile(driverPrincipal, {
      name: 'Driver One',
      phone: '0412345678',
      emergencyContactName: 'Emergency Contact',
      emergencyContactPhone: '0498765432',
      addressLine1: '12 Test Street',
      suburb: 'Richmond',
      state: 'VIC',
      postcode: '3121',
      licenceNo: 'L1',
      licenceClass: 'C',
      licenceExpiry: '2030-06-01T12:00:00.000Z',
      nhvrAcknowledged: true,
      licenceDocumentId: 'doc-lic',
    });
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ licenceDocumentId: 'doc-lic' }),
      }),
    );
  });
});
