import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AuthService } from './auth.service';

const admin: AuthenticatedPrincipal = {
  id: 'admin-1',
  email: 'admin@yopmail.com',
  role: 'SUPER_ADMIN',
  kind: 'admin',
  regionCodes: [],
  territoryCodes: [],
  sessionId: 'sess-current',
};

function configGet(k: string) {
  if (k === 'JWT_ACCESS_SECRET') return 'a'.repeat(32);
  if (k === 'JWT_REFRESH_SECRET') return 'b'.repeat(32);
  if (k === 'JWT_ACCESS_TTL') return '15m';
  if (k === 'JWT_REFRESH_TTL') return '7d';
  if (k === 'OTP_TTL_MINUTES') return 10;
  if (k === 'OTP_LENGTH') return 6;
  if (k === 'OTP_MAX_ATTEMPTS') return 5;
  if (k === 'EXPOSE_OTP_IN_RESPONSE') return true;
  return undefined;
}

describe('AuthService leftover logout / expose OTP paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const notifications = {
    sendOtpEmail: jest.fn().mockResolvedValue({ skipped: true }),
    sendMail: jest.fn().mockResolvedValue({ skipped: true }),
  };
  const jwt = {
    signAsync: jest.fn().mockResolvedValue('signed-token'),
    verifyAsync: jest.fn(),
  };

  function makeService(prisma: Record<string, unknown>) {
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

  it('logout allDevices revokes all admin sessions', async () => {
    const prisma = {
      isConnected: () => true,
      authSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const service = makeService(prisma);
    await expect(service.logout(admin, { allDevices: true })).resolves.toEqual({
      ok: true,
    });
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
      where: { revokedAt: null, adminUserId: 'admin-1' },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('logout by sessionId when no refreshToken', async () => {
    const prisma = {
      isConnected: () => true,
      authSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = makeService(prisma);
    await expect(
      service.logout(admin, { allDevices: false }),
    ).resolves.toEqual({ ok: true });
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'sess-current', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('requestOtp returns debugCode when EXPOSE_OTP_IN_RESPONSE', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u1',
          email: 'sender@yopmail.com',
          name: 'S',
          role: 'SENDER',
          status: 'ACTIVE',
        }),
      },
      adminUser: { findUnique: jest.fn().mockResolvedValue(null) },
      otpChallenge: { create: jest.fn().mockResolvedValue({ id: 'otp-1' }) },
    };
    const service = makeService(prisma);
    const result = await service.requestOtp({ email: 'sender@yopmail.com' });
    expect(result).toMatchObject({ ok: true });
    expect((result as { debugCode?: string }).debugCode).toMatch(/^\d{6}$/);
  });
});
