import { hashValue } from '../../common/utils/crypto';
import { AuthService } from './auth.service';

describe('AuthService admin verifyOtp leftover', () => {
  const audit = { recordPlatform: jest.fn() };
  const notifications = {
    sendOtpEmail: jest.fn().mockResolvedValue({ skipped: true }),
    sendMail: jest.fn().mockResolvedValue({ skipped: true }),
  };

  function configGet(k: string) {
    if (k === 'JWT_ACCESS_SECRET') return 'a'.repeat(32);
    if (k === 'JWT_REFRESH_SECRET') return 'b'.repeat(32);
    if (k === 'JWT_ACCESS_TTL') return '15m';
    if (k === 'JWT_REFRESH_TTL') return '7d';
    return undefined;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('verifyOtp for admin returns principal.admin + scopes', async () => {
    const code = '424242';
    const prisma = {
      isConnected: () => true,
      adminUser: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'admin-1',
          email: 'admin@yopmail.com',
          name: 'Super',
          role: 'SUPER_ADMIN',
          active: true,
          scopes: [
            { scopeType: 'REGION', region: { code: 'VIC' }, localTerritory: null },
          ],
        }),
      },
      user: { findUnique: jest.fn() },
      otpChallenge: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'otp-1',
          codeHash: hashValue(code),
          attempts: 0,
          consumedAt: null,
          expiresAt: new Date('2099-01-01'),
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      authSession: {
        create: jest.fn().mockResolvedValue({ id: 'sess-1' }),
      },
    };
    const jwt = {
      signAsync: jest
        .fn()
        .mockResolvedValueOnce('refresh.jwt')
        .mockResolvedValueOnce('access.jwt'),
    };
    const service = new AuthService(
      prisma as never,
      jwt as never,
      { get: configGet } as never,
      audit as never,
      notifications as never,
    );

    const tokens = await service.verifyOtp({ email: 'admin@yopmail.com', code });
    expect(tokens.accessToken).toBe('access.jwt');
    expect(tokens.principal).toMatchObject({
      kind: 'admin',
      role: 'SUPER_ADMIN',
      scopes: [expect.objectContaining({ regionCode: 'VIC' })],
    });
    expect(tokens.admin).toEqual({
      id: 'admin-1',
      email: 'admin@yopmail.com',
      name: 'Super',
      role: 'SUPER_ADMIN',
    });
    expect(prisma.authSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adminUserId: 'admin-1',
          userId: null,
        }),
      }),
    );
  });
});
