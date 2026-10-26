import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  CompanyStatus,
  CompanyType,
  ComplianceCaseStatus,
  ComplianceCaseType,
  DriverStatus,
  UserStatus,
} from '@prisma/client';
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

describe('DriverService acceptInvite + submitProfile leftovers', () => {
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

  function driverUser(overrides: Record<string, unknown> = {}) {
    return {
      id: 'user-driver',
      email: 'driver@yopmail.com',
      role: 'DRIVER',
      name: 'Drv',
      phone: '0412345678',
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
        emergencyContactName: null,
        emergencyContactPhone: null,
        addressLine1: null,
        suburb: null,
        state: null,
        postcode: null,
        ...overrides,
      },
    };
  }

  const personalProfile = {
    name: 'Driver One',
    phone: '0412345678',
    emergencyContactName: 'Emergency Contact',
    emergencyContactPhone: '0498765432',
    addressLine1: '12 Test Street',
    suburb: 'Richmond',
    state: 'VIC' as const,
    postcode: '3121',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('acceptInvite activates driver + user', async () => {
    const token = 'invite-ok';
    const prisma = {
      isConnected: () => true,
      driver: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'drv-1',
          userId: 'user-driver',
          status: DriverStatus.INVITED,
          inviteAcceptedAt: null,
          inviteExpiresAt: new Date('2099-01-01'),
          user: { email: 'driver@yopmail.com' },
          company: { legalName: 'Carrier Co' },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      user: { update: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (ops: unknown[]) => ops),
    };
    const service = makeService(prisma);
    await expect(service.acceptInvite({ token })).resolves.toMatchObject({
      email: 'driver@yopmail.com',
      next: 'otp_login',
    });
    expect(prisma.driver.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { inviteTokenHash: hashValue(token) },
      }),
    );
    expect(audit.recordPlatform).toHaveBeenCalled();
  });

  it('acceptInvite rejects unknown / consumed / expired / wrong status', async () => {
    const base = {
      id: 'drv-1',
      userId: 'user-driver',
      status: DriverStatus.INVITED,
      inviteAcceptedAt: null,
      inviteExpiresAt: new Date('2099-01-01'),
      user: { email: 'driver@yopmail.com' },
      company: { legalName: 'Carrier Co' },
    };
    const prisma = {
      isConnected: () => true,
      driver: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = makeService(prisma);
    await expect(service.acceptInvite({ token: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );

    prisma.driver.findFirst.mockResolvedValue({
      ...base,
      inviteAcceptedAt: new Date(),
    });
    await expect(service.acceptInvite({ token: 'x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    prisma.driver.findFirst.mockResolvedValue({
      ...base,
      inviteExpiresAt: new Date('2020-01-01'),
    });
    await expect(service.acceptInvite({ token: 'x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    prisma.driver.findFirst.mockResolvedValue({
      ...base,
      status: DriverStatus.ACTIVE,
    });
    await expect(service.acceptInvite({ token: 'x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('submitProfile activates after licence + NHVR when company not bid-eligible', async () => {
    const future = new Date(Date.now() + 86_400_000 * 30)
      .toISOString()
      .slice(0, 10);
    const driverUpdate = jest
      .fn()
      .mockResolvedValue({ id: 'drv-1', status: DriverStatus.ACTIVE });
    const userUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(driverUser())
          .mockResolvedValueOnce(
            driverUser({
              licenceNo: 'L1',
              licenceClass: 'C',
              licenceExpiry: new Date(`${future}T23:59:59.000Z`),
              nhvrAcknowledgedAt: new Date(),
              status: DriverStatus.ACTIVE,
              emergencyContactName: personalProfile.emergencyContactName,
              emergencyContactPhone: personalProfile.emergencyContactPhone,
              addressLine1: personalProfile.addressLine1,
              suburb: personalProfile.suburb,
              state: personalProfile.state,
              postcode: personalProfile.postcode,
            }),
          ),
        update: userUpdate,
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-c',
          status: CompanyStatus.DRAFT,
          homeRegionId: 'reg-vic',
          type: CompanyType.CARRIER,
        }),
      },
      complianceDocument: {
        findFirst: jest.fn().mockResolvedValue({ id: 'doc-lic' }),
      },
      driver: { update: driverUpdate },
      $transaction: jest.fn(async (ops: unknown[]) => ops),
    };
    const service = makeService(prisma);
    const result = await service.submitProfile(driverPrincipal, {
      ...personalProfile,
      licenceNo: 'L1',
      licenceClass: 'C',
      licenceExpiry: future,
      nhvrAcknowledged: true,
      licenceDocumentId: 'doc-lic',
    });
    expect(result.driver.status).toBe(DriverStatus.ACTIVE);
    expect(driverUpdate).toHaveBeenCalledWith({
      where: { id: 'drv-1' },
      data: expect.objectContaining({
        status: DriverStatus.ACTIVE,
        addressLine1: personalProfile.addressLine1,
        state: 'VIC',
        postcode: '3121',
      }),
    });
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'user-driver' },
      data: { name: personalProfile.name, phone: personalProfile.phone },
    });
    expect(audit.recordPlatform).toHaveBeenCalledTimes(2);
  });

  it('submitProfile BID_ELIGIBLE stays PENDING_REVIEW and opens driver licence case', async () => {
    const future = new Date(Date.now() + 86_400_000 * 30)
      .toISOString()
      .slice(0, 10);
    const driverUpdate = jest
      .fn()
      .mockResolvedValue({ id: 'drv-1', status: DriverStatus.PENDING_REVIEW });
    const userUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(driverUser())
          .mockResolvedValueOnce(
            driverUser({
              licenceNo: 'L1',
              licenceClass: 'C',
              licenceExpiry: new Date(`${future}T23:59:59.000Z`),
              nhvrAcknowledgedAt: new Date(),
              status: DriverStatus.PENDING_REVIEW,
              emergencyContactName: personalProfile.emergencyContactName,
              emergencyContactPhone: personalProfile.emergencyContactPhone,
              addressLine1: personalProfile.addressLine1,
              suburb: personalProfile.suburb,
              state: personalProfile.state,
              postcode: personalProfile.postcode,
            }),
          ),
        update: userUpdate,
      },
      company: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'co-c',
          status: CompanyStatus.BID_ELIGIBLE,
          homeRegionId: 'reg-vic',
          type: CompanyType.CARRIER,
        }),
      },
      complianceCase: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'case-drv',
          status: ComplianceCaseStatus.OPEN,
          caseType: ComplianceCaseType.CARRIER_DRIVER_LICENCE,
        }),
      },
      complianceDocument: {
        findFirst: jest.fn().mockResolvedValue({ id: 'doc-lic' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'doc-lic' }]),
        updateMany: jest.fn(),
      },
      driver: { update: driverUpdate },
      $transaction: jest.fn(async (ops: unknown[]) => ops),
    };
    const service = makeService(prisma);
    const result = await service.submitProfile(driverPrincipal, {
      ...personalProfile,
      licenceNo: 'L1',
      licenceClass: 'C',
      licenceExpiry: future,
      nhvrAcknowledged: true,
      licenceDocumentId: 'doc-lic',
    });
    expect(result.driver.status).toBe(DriverStatus.PENDING_REVIEW);
    expect(driverUpdate).toHaveBeenCalledWith({
      where: { id: 'drv-1' },
      data: expect.objectContaining({ status: DriverStatus.PENDING_REVIEW }),
    });
    expect(prisma.complianceCase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        caseType: ComplianceCaseType.CARRIER_DRIVER_LICENCE,
        companyId: 'co-c',
      }),
    });
    expect(prisma.complianceDocument.updateMany).toHaveBeenCalled();
  });

  it('submitProfile rejects unlinked / not accepted / past expiry / bad doc', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue(driverUser({ companyId: null, company: null })),
      },
      complianceDocument: { findFirst: jest.fn() },
      driver: { update: jest.fn() },
    };
    const service = makeService(prisma);
    const baseProfile = {
      ...personalProfile,
      licenceNo: 'L1',
      licenceClass: 'C',
      licenceExpiry: '2099-01-01',
      nhvrAcknowledged: true as const,
      licenceDocumentId: 'doc-lic',
    };
    await expect(
      service.submitProfile(driverPrincipal, baseProfile),
    ).rejects.toBeInstanceOf(ForbiddenException);

    prisma.user.findUnique.mockResolvedValue(
      driverUser({
        inviteAcceptedAt: null,
        status: DriverStatus.INVITED,
      }),
    );
    await expect(
      service.submitProfile(driverPrincipal, baseProfile),
    ).rejects.toBeInstanceOf(BadRequestException);

    prisma.user.findUnique.mockResolvedValue(driverUser());
    await expect(
      service.submitProfile(driverPrincipal, {
        ...baseProfile,
        licenceExpiry: '2020-01-01',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    prisma.complianceDocument.findFirst.mockResolvedValue(null);
    await expect(
      service.submitProfile(driverPrincipal, {
        ...baseProfile,
        licenceDocumentId: 'missing',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('suspendExpiredLicences returns 0 when db down', async () => {
    const service = makeService({ isConnected: () => false });
    await expect(service.suspendExpiredLicences()).resolves.toEqual({ suspended: 0 });
  });
});
