import { OtpPurpose } from '@prisma/client';
import { AuthService } from './auth.service';

describe('AuthService admin + phone OTP resolve leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const notifications = {
    sendOtpEmail: jest.fn().mockResolvedValue({ skipped: true }),
    sendMail: jest.fn().mockResolvedValue({ skipped: true }),
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue('tok'), verifyAsync: jest.fn() };

  function configGet(k: string) {
    if (k === 'JWT_ACCESS_SECRET') return 'a'.repeat(32);
    if (k === 'JWT_REFRESH_SECRET') return 'b'.repeat(32);
    if (k === 'JWT_ACCESS_TTL') return '15m';
    if (k === 'JWT_REFRESH_TTL') return '7d';
    if (k === 'OTP_TTL_MINUTES') return 10;
    if (k === 'OTP_LENGTH') return 6;
    if (k === 'OTP_MAX_ATTEMPTS') return 5;
    return undefined;
  }

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

  it('requestOtp resolves active admin by email with scopes', async () => {
    const prisma = {
      isConnected: () => true,
      adminUser: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'admin-1',
          email: 'admin@yopmail.com',
          name: 'Admin',
          role: 'SUPER_ADMIN',
          active: true,
          scopes: [
            { scopeType: 'REGION', region: { code: 'VIC' }, localTerritory: null },
            { scopeType: 'TERRITORY', region: null, localTerritory: { code: 'MEL' } },
          ],
        }),
      },
      user: { findUnique: jest.fn() },
      otpChallenge: { create: jest.fn().mockResolvedValue({ id: 'otp-a' }) },
    };
    const result = await makeService(prisma).requestOtp({ email: 'admin@yopmail.com' });
    expect(result).toMatchObject({ ok: true });
    expect(prisma.otpChallenge.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        purpose: OtpPurpose.LOGIN,
        adminUserId: 'admin-1',
        userId: null,
      }),
    });
    expect(notifications.sendOtpEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin@yopmail.com' }),
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('requestOtp skips inactive admin and falls through to user', async () => {
    const prisma = {
      isConnected: () => true,
      adminUser: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'admin-x',
          email: 'sender@yopmail.com',
          active: false,
          scopes: [],
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u1',
          email: 'sender@yopmail.com',
          name: 'S',
          role: 'SENDER',
          status: 'ACTIVE',
        }),
      },
      otpChallenge: { create: jest.fn().mockResolvedValue({ id: 'otp-u' }) },
    };
    await makeService(prisma).requestOtp({ email: 'sender@yopmail.com' });
    expect(prisma.otpChallenge.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u1', adminUserId: null }),
    });
  });

  it('requestOtp resolves ACTIVE user by phone', async () => {
    const prisma = {
      isConnected: () => true,
      adminUser: { findUnique: jest.fn() },
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue({
          id: 'u-phone',
          email: 'driver@yopmail.com',
          name: 'D',
          role: 'DRIVER',
          status: 'ACTIVE',
          phone: '+61400000000',
        }),
      },
      otpChallenge: { create: jest.fn().mockResolvedValue({ id: 'otp-p' }) },
    };
    const result = await makeService(prisma).requestOtp({ phone: '+61400000000' });
    expect(result).toMatchObject({ ok: true });
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { phone: '+61400000000' },
    });
    expect(prisma.otpChallenge.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u-phone' }),
    });
  });

  it('requestOtp ignores inactive phone user (no enumeration leak)', async () => {
    const prisma = {
      isConnected: () => true,
      user: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'u-bad',
          email: 'x@yopmail.com',
          status: 'INVITED',
          role: 'DRIVER',
        }),
      },
      otpChallenge: { create: jest.fn() },
    };
    const result = await makeService(prisma).requestOtp({ phone: '+61411111111' });
    expect(result).toMatchObject({ ok: true });
    expect(prisma.otpChallenge.create).not.toHaveBeenCalled();
  });
});
