import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppRole } from '../../shared/types';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { ScopeService } from '../services/scope.service';
import type { AuthenticatedPrincipal } from './jwt-auth.guard';

function mockCtx(auth?: string) {
  const request: { headers: { authorization?: string }; user?: unknown } = {
    headers: { authorization: auth },
  };
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    __request: request,
  };
}

describe('Guards / scope crumbs', () => {
  it('RolesGuard throws when principal missing on protected route', () => {
    const reflector = {
      getAllAndOverride: () => [AppRole.SUPER_ADMIN],
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(() =>
      guard.canActivate({
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({ getRequest: () => ({}) }),
      } as never),
    ).toThrow(ForbiddenException);
  });

  it('JwtAuthGuard rejects DISABLED and SUSPENDED users', async () => {
    for (const status of ['DISABLED', 'SUSPENDED'] as const) {
      const guard = new JwtAuthGuard(
        {
          verifyAsync: jest.fn().mockResolvedValue({
            sub: 'u1',
            email: 'user@yopmail.com',
            role: AppRole.SENDER,
            typ: 'access',
            kind: 'user',
          }),
        } as never,
        { get: () => 'secret' } as never,
        {
          isConnected: () => true,
          user: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'u1',
              email: 'user@yopmail.com',
              role: AppRole.SENDER,
              status,
            }),
          },
        } as never,
      );
      await expect(
        guard.canActivate(mockCtx('Bearer tok') as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it('assertTerritoryAccess no-ops for Super Admin', () => {
    const scope = new ScopeService();
    const superAdmin: AuthenticatedPrincipal = {
      id: 'a1',
      email: 'super@yopmail.com',
      role: 'SUPER_ADMIN',
      kind: 'admin',
      regionCodes: [],
      territoryCodes: [],
    };
    expect(() => scope.assertTerritoryAccess(superAdmin, 'MEL')).not.toThrow();
  });
});
