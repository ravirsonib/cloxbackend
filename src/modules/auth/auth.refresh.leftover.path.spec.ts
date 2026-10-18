import { UnauthorizedException } from '@nestjs/common';
import { AuthPrincipalType } from '@prisma/client';
import { hashValue } from '../../common/utils/crypto';
import { AuthService } from './auth.service';

describe('AuthService refresh leftover failure paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const notifications = { sendMail: jest.fn(), sendOtpEmail: jest.fn() };

  function configGet(k: string) {
    if (k === 'JWT_ACCESS_SECRET') return 'a'.repeat(32);
    if (k === 'JWT_REFRESH_SECRET') return 'b'.repeat(32);
    if (k === 'JWT_ACCESS_TTL') return '15m';
    if (k === 'JWT_REFRESH_TTL') return '7d';
    return undefined;
  }

  function makeService(prisma: Record<string, unknown>, jwt: Record<string, unknown>) {
    return new AuthService(
      prisma as never,
      jwt as never,
      { get: configGet } as never,
      audit as never,
      notifications as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects when JWT verify throws', async () => {
    const service = makeService(
      { isConnected: () => true },
      { verifyAsync: jest.fn().mockRejectedValue(new Error('bad jwt')) },
    );
    await expect(service.refresh({ refreshToken: 'x' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects when typ is not refresh or sid missing', async () => {
    const jwt = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'u1',
        typ: 'access',
        sid: 's1',
      }),
    };
    await expect(
      makeService({ isConnected: () => true }, jwt).refresh({ refreshToken: 't' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', typ: 'refresh' });
    await expect(
      makeService({ isConnected: () => true }, jwt).refresh({ refreshToken: 't' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when session hash mismatches (no family revoke without familyId)', async () => {
    const token = 'refresh.good';
    const prisma = {
      isConnected: () => true,
      authSession: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'sess-1',
          familyId: null,
          revokedAt: null,
          expiresAt: new Date('2099-01-01'),
          refreshTokenHash: hashValue('other'),
          principalType: AuthPrincipalType.USER,
          userId: 'u1',
          adminUserId: null,
        }),
        updateMany: jest.fn(),
      },
    };
    const jwt = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'u1',
        typ: 'refresh',
        kind: 'user',
        sid: 'sess-1',
      }),
    };
    await expect(
      makeService(prisma, jwt).refresh({ refreshToken: token }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
  });

  it('rejects when account missing after valid session', async () => {
    const token = 'refresh.ok';
    const prisma = {
      isConnected: () => true,
      authSession: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'sess-1',
          familyId: 'fam-1',
          revokedAt: null,
          expiresAt: new Date('2099-01-01'),
          refreshTokenHash: hashValue(token),
          principalType: AuthPrincipalType.USER,
          userId: 'u1',
          adminUserId: null,
        }),
        update: jest.fn(),
      },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      adminUser: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const jwt = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'u1',
        typ: 'refresh',
        kind: 'user',
        sid: 'sess-1',
      }),
      signAsync: jest.fn(),
    };
    await expect(
      makeService(prisma, jwt).refresh({ refreshToken: token }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
