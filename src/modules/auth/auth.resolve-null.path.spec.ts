import { UnauthorizedException } from '@nestjs/common';
import { AuthPrincipalType } from '@prisma/client';
import { hashValue } from '../../common/utils/crypto';
import { AuthService } from './auth.service';

describe('AuthService resolveAccountById null leftover', () => {
  it('refresh rejects when ADMIN session has null adminUserId', async () => {
    const token = 'refresh.null.admin';
    const jwt = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'x',
        typ: 'refresh',
        kind: 'admin',
        sid: 'sess-1',
        email: 'a@yopmail.com',
        role: 'SUPER_ADMIN',
      }),
      signAsync: jest.fn(),
    };
    const prisma = {
      isConnected: () => true,
      authSession: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'sess-1',
          revokedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
          principalType: AuthPrincipalType.ADMIN,
          adminUserId: null,
          userId: null,
          refreshTokenHash: hashValue(token),
          familyId: 'fam-1',
          deviceLabel: null,
          userAgent: null,
          ipHash: null,
        }),
      },
    };
    const service = new AuthService(
      prisma as never,
      jwt as never,
      {
        get: (k: string) => {
          if (k === 'JWT_REFRESH_SECRET') return 'b'.repeat(32);
          if (k === 'JWT_ACCESS_SECRET') return 'a'.repeat(32);
          if (k === 'JWT_ACCESS_TTL') return '15m';
          if (k === 'JWT_REFRESH_TTL') return '7d';
          return undefined;
        },
      } as never,
      { recordPlatform: jest.fn() } as never,
      { sendOtpEmail: jest.fn() } as never,
    );

    await expect(service.refresh({ refreshToken: token })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
