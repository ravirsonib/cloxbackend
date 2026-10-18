import { UnauthorizedException } from '@nestjs/common';
import { AuthPrincipalType } from '@prisma/client';
import { AuthService } from './auth.service';
import { hashValue } from '../../common/utils/crypto';

describe('AuthService.refresh reuse detection', () => {
  it('revokes entire family when a revoked refresh token is reused', async () => {
    const familyId = 'fam-1';
    const oldToken = 'refresh.old.token';
    const prisma = {
      isConnected: () => true,
      authSession: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'sess-old',
          familyId,
          revokedAt: new Date('2026-01-01T00:00:00.000Z'),
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          refreshTokenHash: hashValue(oldToken),
          principalType: AuthPrincipalType.USER,
          userId: 'u1',
          adminUserId: null,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const jwt = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'u1',
        email: 'clox.mail@yopmail.com',
        role: 'SENDER',
        typ: 'refresh',
        kind: 'user',
        sid: 'sess-old',
      }),
    };
    const config = {
      get: (key: string) => {
        if (key === 'JWT_REFRESH_SECRET') return 'refresh-secret';
        return undefined;
      },
    };
    const service = new AuthService(
      prisma as never,
      jwt as never,
      config as never,
      { recordPlatform: jest.fn() } as never,
      { sendMail: jest.fn() } as never,
    );

    await expect(service.refresh({ refreshToken: oldToken })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
      where: { familyId, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
