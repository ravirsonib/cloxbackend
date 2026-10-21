import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminUserStatus } from '@prisma/client';
import { RolesGuard } from './roles.guard';
import { AppRole } from '../../shared/types';
import { ALLOW_PENDING_PARTNER_KEY } from '../decorators/allow-pending-partner.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthenticatedPrincipal } from './jwt-auth.guard';

function mockContext(user?: AuthenticatedPrincipal) {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as never;
}

function principal(
  role: AppRole,
  kind: 'admin' | 'user' = 'user',
  adminStatus?: AdminUserStatus,
): AuthenticatedPrincipal {
  return {
    id: `id-${role}`,
    email: `${role.toLowerCase()}@yopmail.com`,
    role,
    kind: kind === 'admin' || role === AppRole.SUPER_ADMIN || role === AppRole.STATE_MASTER || role === AppRole.LOCAL_BDE
      ? 'admin'
      : 'user',
    regionCodes: role === AppRole.STATE_MASTER || role === AppRole.LOCAL_BDE ? ['VIC'] : [],
    territoryCodes: role === AppRole.LOCAL_BDE ? ['MEL'] : [],
    adminStatus,
  };
}

function reflectorFor(required: AppRole[] | undefined, allowPending = false) {
  return {
    getAllAndOverride: (key: unknown) => {
      if (key === ROLES_KEY) return required;
      if (key === ALLOW_PENDING_PARTNER_KEY) return allowPending;
      return undefined;
    },
  } as unknown as Reflector;
}

const ALL_ROLES = [
  AppRole.SUPER_ADMIN,
  AppRole.STATE_MASTER,
  AppRole.LOCAL_BDE,
  AppRole.SENDER,
  AppRole.TRANSPORT_COMPANY,
  AppRole.DRIVER,
] as const;

describe('RolesGuard', () => {
  it('allows when no roles metadata', () => {
    const guard = new RolesGuard(reflectorFor(undefined));
    expect(guard.canActivate(mockContext())).toBe(true);
  });

  it('denies State Master on Super-only route', () => {
    const guard = new RolesGuard(reflectorFor([AppRole.SUPER_ADMIN]));
    expect(() => guard.canActivate(mockContext(principal(AppRole.STATE_MASTER)))).toThrow(
      ForbiddenException,
    );
  });

  it('denies Local BDE on Super policy route', () => {
    const guard = new RolesGuard(reflectorFor([AppRole.SUPER_ADMIN]));
    expect(() => guard.canActivate(mockContext(principal(AppRole.LOCAL_BDE)))).toThrow(
      ForbiddenException,
    );
  });

  it('denies Sender on admin route', () => {
    const guard = new RolesGuard(reflectorFor([AppRole.SUPER_ADMIN]));
    expect(() => guard.canActivate(mockContext(principal(AppRole.SENDER)))).toThrow(
      ForbiddenException,
    );
  });

  it('allows matching role', () => {
    const guard = new RolesGuard(reflectorFor([AppRole.SUPER_ADMIN]));
    expect(guard.canActivate(mockContext(principal(AppRole.SUPER_ADMIN)))).toBe(true);
  });

  it('denies pending State Master on ops route without AllowPendingPartner', () => {
    const guard = new RolesGuard(reflectorFor([AppRole.STATE_MASTER], false));
    expect(() =>
      guard.canActivate(
        mockContext(principal(AppRole.STATE_MASTER, 'admin', AdminUserStatus.PENDING_DOCS)),
      ),
    ).toThrow(ForbiddenException);
  });

  it('allows pending State Master when AllowPendingPartner is set', () => {
    const guard = new RolesGuard(reflectorFor([AppRole.STATE_MASTER], true));
    expect(
      guard.canActivate(
        mockContext(principal(AppRole.STATE_MASTER, 'admin', AdminUserStatus.PENDING_DOCS)),
      ),
    ).toBe(true);
  });

  it('allows ACTIVE State Master on ops route', () => {
    const guard = new RolesGuard(reflectorFor([AppRole.STATE_MASTER], false));
    expect(
      guard.canActivate(
        mockContext(principal(AppRole.STATE_MASTER, 'admin', AdminUserStatus.ACTIVE)),
      ),
    ).toBe(true);
  });

  describe('deny matrix — wrong role on protected route', () => {
    const cases: Array<{ required: AppRole; allowed: AppRole[] }> = [
      { required: AppRole.SUPER_ADMIN, allowed: [AppRole.SUPER_ADMIN] },
      { required: AppRole.SENDER, allowed: [AppRole.SENDER] },
      { required: AppRole.TRANSPORT_COMPANY, allowed: [AppRole.TRANSPORT_COMPANY] },
      { required: AppRole.DRIVER, allowed: [AppRole.DRIVER] },
      {
        required: AppRole.STATE_MASTER,
        allowed: [AppRole.STATE_MASTER],
      },
      {
        required: AppRole.LOCAL_BDE,
        allowed: [AppRole.LOCAL_BDE],
      },
    ];

    for (const { required, allowed } of cases) {
      for (const actor of ALL_ROLES) {
        const shouldAllow = allowed.includes(actor);
        it(`${actor} → route requiring ${required}: ${shouldAllow ? 'allow' : 'deny'}`, () => {
          const guard = new RolesGuard(reflectorFor([required]));
          if (shouldAllow) {
            expect(guard.canActivate(mockContext(principal(actor)))).toBe(true);
          } else {
            expect(() => guard.canActivate(mockContext(principal(actor)))).toThrow(
              ForbiddenException,
            );
          }
        });
      }
    }
  });
});
