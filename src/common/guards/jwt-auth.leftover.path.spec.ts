import { UnauthorizedException } from '@nestjs/common';
import { AppRole } from '../../shared/types';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtAuthGuard leftover auth paths', () => {
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

  it('rejects missing bearer header', async () => {
    const guard = new JwtAuthGuard(
      { verifyAsync: jest.fn() } as never,
      { get: () => 'secret' } as never,
      { isConnected: () => true } as never,
    );
    await expect(guard.canActivate(mockCtx() as never)).rejects.toMatchObject({
      message: 'Missing bearer token',
    });
  });

  it('rejects non-access typ', async () => {
    const guard = new JwtAuthGuard(
      {
        verifyAsync: jest.fn().mockResolvedValue({
          sub: 'u1',
          email: 'user@yopmail.com',
          role: AppRole.SENDER,
          typ: 'refresh',
          kind: 'user',
        }),
      } as never,
      { get: () => 'secret' } as never,
      { isConnected: () => true } as never,
    );
    await expect(
      guard.canActivate(mockCtx('Bearer tok') as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects invalid kind', async () => {
    const guard = new JwtAuthGuard(
      {
        verifyAsync: jest.fn().mockResolvedValue({
          sub: 'u1',
          email: 'user@yopmail.com',
          role: AppRole.SENDER,
          typ: 'access',
          kind: 'bot',
        }),
      } as never,
      { get: () => 'secret' } as never,
      { isConnected: () => true } as never,
    );
    await expect(
      guard.canActivate(mockCtx('Bearer tok') as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects revoked session', async () => {
    const guard = new JwtAuthGuard(
      {
        verifyAsync: jest.fn().mockResolvedValue({
          sub: 'u1',
          email: 'user@yopmail.com',
          role: AppRole.SENDER,
          typ: 'access',
          kind: 'user',
          sid: 's-revoked',
        }),
      } as never,
      { get: () => 'secret' } as never,
      {
        isConnected: () => true,
        authSession: {
          findUnique: jest.fn().mockResolvedValue({
            id: 's-revoked',
            revokedAt: new Date(),
          }),
        },
      } as never,
    );
    await expect(
      guard.canActivate(mockCtx('Bearer tok') as never),
    ).rejects.toMatchObject({ message: 'Session revoked' });
  });

  it('rejects disabled admin', async () => {
    const guard = new JwtAuthGuard(
      {
        verifyAsync: jest.fn().mockResolvedValue({
          sub: 'admin-1',
          email: 'admin@yopmail.com',
          role: AppRole.SUPER_ADMIN,
          typ: 'access',
          kind: 'admin',
        }),
      } as never,
      { get: () => 'secret' } as never,
      {
        isConnected: () => true,
        adminUser: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'admin-1',
            email: 'admin@yopmail.com',
            active: false,
            role: AppRole.SUPER_ADMIN,
            scopes: [],
          }),
        },
      } as never,
    );
    await expect(
      guard.canActivate(mockCtx('Bearer tok') as never),
    ).rejects.toMatchObject({ message: 'Account disabled' });
  });

  it('loads ACTIVE user principal', async () => {
    const ctx = mockCtx('Bearer tok');
    const guard = new JwtAuthGuard(
      {
        verifyAsync: jest.fn().mockResolvedValue({
          sub: 'u1',
          email: 'sender@yopmail.com',
          role: AppRole.SENDER,
          typ: 'access',
          kind: 'user',
          sid: 's1',
        }),
      } as never,
      { get: () => 'secret' } as never,
      {
        isConnected: () => true,
        authSession: {
          findUnique: jest.fn().mockResolvedValue({ id: 's1', revokedAt: null }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'u1',
            email: 'sender@yopmail.com',
            role: AppRole.SENDER,
            status: 'ACTIVE',
          }),
        },
      } as never,
    );
    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
    expect(
      (ctx as { __request: { user: { id: string; kind: string } } }).__request.user,
    ).toMatchObject({
      id: 'u1',
      kind: 'user',
      email: 'sender@yopmail.com',
      sessionId: 's1',
    });
  });

  it('maps verify errors to Invalid access token', async () => {
    const guard = new JwtAuthGuard(
      {
        verifyAsync: jest.fn().mockRejectedValue(new Error('jwt expired')),
      } as never,
      { get: () => 'secret' } as never,
      { isConnected: () => true } as never,
    );
    await expect(
      guard.canActivate(mockCtx('Bearer bad') as never),
    ).rejects.toMatchObject({ message: 'Invalid access token' });
  });
});
