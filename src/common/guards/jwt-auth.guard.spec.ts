import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AppRole } from '../../shared/types';

describe('JwtAuthGuard', () => {
  function mockCtx(auth?: string) {
    const request: { headers: { authorization?: string }; user?: unknown } = {
      headers: { authorization: auth },
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      __request: request,
    };
  }

  it('fails closed when database is disconnected', async () => {
    const guard = new JwtAuthGuard(
      {
        verifyAsync: jest.fn().mockResolvedValue({
          sub: 'u1',
          email: 'clox.mail@yopmail.com',
          role: AppRole.SENDER,
          typ: 'access',
          kind: 'user',
          sid: 's1',
        }),
      } as never,
      { get: () => 'secret' } as never,
      { isConnected: () => false } as never,
    );
    await expect(
      guard.canActivate(mockCtx('Bearer tok') as never),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('loads live admin role/scopes from DB not JWT claims', async () => {
    const ctx = mockCtx('Bearer tok');
    const guard = new JwtAuthGuard(
      {
        verifyAsync: jest.fn().mockResolvedValue({
          sub: 'admin-1',
          email: 'old@x.com',
          role: AppRole.SUPER_ADMIN,
          typ: 'access',
          kind: 'admin',
          sid: 's1',
          regions: ['NSW'],
          territories: [],
        }),
      } as never,
      { get: () => 'secret' } as never,
      {
        isConnected: () => true,
        authSession: {
          findUnique: jest.fn().mockResolvedValue({ id: 's1', revokedAt: null }),
        },
        adminUser: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'admin-1',
            email: 'state@x.com',
            active: true,
            role: AppRole.STATE_MASTER,
            scopes: [
              {
                region: { code: 'VIC' },
                localTerritory: null,
              },
            ],
          }),
        },
      } as never,
    );

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
    expect((ctx as { __request: { user: { role: string; regionCodes: string[] } } }).__request.user).toMatchObject({
      role: AppRole.STATE_MASTER,
      regionCodes: ['VIC'],
      email: 'state@x.com',
    });
  });

  it('rejects non-ACTIVE users', async () => {
    const guard = new JwtAuthGuard(
      {
        verifyAsync: jest.fn().mockResolvedValue({
          sub: 'u1',
          email: 'clox.mail@yopmail.com',
          role: AppRole.DRIVER,
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
            email: 'clox.mail@yopmail.com',
            role: AppRole.DRIVER,
            status: 'PENDING',
          }),
        },
      } as never,
    );
    await expect(
      guard.canActivate(mockCtx('Bearer tok') as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
