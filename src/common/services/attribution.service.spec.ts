import { ForbiddenException } from '@nestjs/common';
import { AdminUserStatus, CompanyType } from '@prisma/client';
import { hashValue } from '../utils/crypto';
import { AdminRole } from '../../shared/types';
import { AttributionService } from './attribution.service';
import type { AuthenticatedPrincipal } from '../guards/jwt-auth.guard';

function principal(
  overrides: Partial<AuthenticatedPrincipal> & Pick<AuthenticatedPrincipal, 'role'>,
): AuthenticatedPrincipal {
  return {
    id: 'local-1',
    email: 'local@clox.test',
    kind: 'admin',
    regionCodes: ['VIC'],
    territoryCodes: ['MEL'],
    adminStatus: AdminUserStatus.ACTIVE,
    active: true,
    ...overrides,
  };
}

describe('AttributionService', () => {
  const prisma = {
    companyInvite: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    prospect: { update: jest.fn() },
  };

  const service = new AttributionService(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolveInviteForRegister returns HQ when token missing', async () => {
    await expect(
      service.resolveInviteForRegister(undefined, CompanyType.SENDER),
    ).resolves.toEqual({
      referredByAdminUserId: null,
      inviteId: null,
      prospectId: null,
      homeRegionId: null,
    });
  });

  it('resolveInviteForRegister stamps active Local inviter', async () => {
    prisma.companyInvite.findUnique.mockResolvedValue({
      id: 'inv-1',
      acceptedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      companyType: CompanyType.SENDER,
      invitedByAdminUserId: 'local-1',
      prospectId: null,
      homeRegionId: 'reg-1',
      invitedByAdminUser: {
        id: 'local-1',
        role: AdminRole.LOCAL_BDE,
        status: AdminUserStatus.ACTIVE,
      },
    });

    const token = 'abcdefghijklmnopqrstuvwxyz';
    await expect(
      service.resolveInviteForRegister(token, CompanyType.SENDER),
    ).resolves.toEqual({
      referredByAdminUserId: 'local-1',
      inviteId: 'inv-1',
      prospectId: null,
      homeRegionId: 'reg-1',
    });
    expect(prisma.companyInvite.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashValue(token) },
      include: {
        invitedByAdminUser: { select: { id: true, role: true, status: true } },
      },
    });
  });

  it('resolveInviteForRegister returns HQ when expired', async () => {
    prisma.companyInvite.findUnique.mockResolvedValue({
      id: 'inv-1',
      acceptedAt: null,
      expiresAt: new Date(Date.now() - 1000),
      companyType: CompanyType.SENDER,
      invitedByAdminUserId: 'local-1',
      prospectId: null,
      homeRegionId: null,
      invitedByAdminUser: {
        id: 'local-1',
        role: AdminRole.LOCAL_BDE,
        status: AdminUserStatus.ACTIVE,
      },
    });
    await expect(
      service.resolveInviteForRegister('abcdefghijklmnopqrstuvwxyz', CompanyType.SENDER),
    ).resolves.toMatchObject({ referredByAdminUserId: null, inviteId: null });
  });

  it('assertLocalOwnsCompany forbids other Local book', () => {
    expect(() =>
      service.assertLocalOwnsCompany(principal({ role: AdminRole.LOCAL_BDE }), {
        referredByAdminUserId: 'local-2',
      }),
    ).toThrow(ForbiddenException);
  });

  it('assertLocalOwnsCompany allows own book', () => {
    expect(() =>
      service.assertLocalOwnsCompany(principal({ role: AdminRole.LOCAL_BDE }), {
        referredByAdminUserId: 'local-1',
      }),
    ).not.toThrow();
  });

  it('companyBookFilter Local is referredBy self', () => {
    expect(service.companyBookFilter(principal({ role: AdminRole.LOCAL_BDE }))).toEqual({
      referredByAdminUserId: 'local-1',
    });
  });
});
