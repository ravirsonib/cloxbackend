import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { AppRole } from '../../shared/types';
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

function principal(role: AppRole, kind: 'admin' | 'user' = 'user'): AuthenticatedPrincipal {
  return {
    id: `id-${role}`,
    email: `${role.toLowerCase()}@yopmail.com`,
    role,
    kind: kind === 'admin' || role === AppRole.SUPER_ADMIN || role === AppRole.STATE_MASTER || role === AppRole.LOCAL_BDE
      ? 'admin'
      : 'user',
    regionCodes: role === AppRole.STATE_MASTER || role === AppRole.LOCAL_BDE ? ['VIC'] : [],
    territoryCodes: role === AppRole.LOCAL_BDE ? ['MEL'] : [],
  };
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
    const reflector = {
      getAllAndOverride: () => undefined,
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(mockContext())).toBe(true);
  });

  it('denies State Master on Super-only route', () => {
    const reflector = {
      getAllAndOverride: () => [AppRole.SUPER_ADMIN],
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(mockContext(principal(AppRole.STATE_MASTER)))).toThrow(
      ForbiddenException,
    );
  });

  it('denies Local BDE on Super policy route', () => {
    const reflector = {
      getAllAndOverride: () => [AppRole.SUPER_ADMIN],
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(mockContext(principal(AppRole.LOCAL_BDE)))).toThrow(
      ForbiddenException,
    );
  });

  it('denies Sender on admin route', () => {
    const reflector = {
      getAllAndOverride: () => [AppRole.SUPER_ADMIN],
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(mockContext(principal(AppRole.SENDER)))).toThrow(
      ForbiddenException,
    );
  });

  it('allows matching role', () => {
    const reflector = {
      getAllAndOverride: () => [AppRole.SUPER_ADMIN],
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(mockContext(principal(AppRole.SUPER_ADMIN)))).toBe(true);
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
          const reflector = {
            getAllAndOverride: () => [required],
          } as unknown as Reflector;
          const guard = new RolesGuard(reflector);
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
