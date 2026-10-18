import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { hashValue } from '../../common/utils/crypto';
import { AuthService } from './auth.service';

describe('AuthService verifyOtp leftover lockout / mismatch paths', () => {
  const audit = { recordPlatform: jest.fn() };
  const notifications = { sendMail: jest.fn(), sendOtpEmail: jest.fn() };

  function configGet(k: string) {
    if (k === 'JWT_ACCESS_SECRET') return 'a'.repeat(32);
    if (k === 'JWT_REFRESH_SECRET') return 'b'.repeat(32);
    if (k === 'JWT_ACCESS_TTL') return '15m';
    if (k === 'JWT_REFRESH_TTL') return '7d';
    if (k === 'OTP_MAX_ATTEMPTS') return 5;
    return undefined;
  }

  function makeService(prisma: Record<string, unknown>) {
    return new AuthService(
      prisma as never,
      { signAsync: jest.fn() } as never,
      { get: configGet } as never,
      audit as never,
      notifications as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects unknown account', async () => {
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      adminUser: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).verifyOtp({ email: 'ghost@yopmail.com', code: '123456' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects missing/expired challenge', async () => {
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
      otpChallenge: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).verifyOtp({ email: 'sender@yopmail.com', code: '123456' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: 'missing_or_expired' }),
      }),
    );
  });

  it('rejects when attempts >= 5', async () => {
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
      otpChallenge: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'otp-1',
          codeHash: hashValue('111111'),
          attempts: 5,
          consumedAt: null,
          expiresAt: new Date('2099-01-01'),
        }),
      },
    };
    await expect(
      makeService(prisma).verifyOtp({ email: 'sender@yopmail.com', code: '111111' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('increments attempts on code mismatch', async () => {
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
      otpChallenge: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'otp-1',
          codeHash: hashValue('111111'),
          attempts: 1,
          consumedAt: null,
          expiresAt: new Date('2099-01-01'),
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    await expect(
      makeService(prisma).verifyOtp({ email: 'sender@yopmail.com', code: '000000' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.otpChallenge.update).toHaveBeenCalledWith({
      where: { id: 'otp-1' },
      data: { attempts: { increment: 1 } },
    });
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: 'mismatch' }),
      }),
    );
  });
});
