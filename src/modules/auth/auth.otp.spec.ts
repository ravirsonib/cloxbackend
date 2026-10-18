import { UnauthorizedException } from '@nestjs/common';
import { OtpPurpose } from '@prisma/client';
import { AuthService } from './auth.service';
import { hashValue } from '../../common/utils/crypto';

describe('AuthService.verifyOtp atomic consume', () => {
  it('rejects when concurrent updateMany consumes already', async () => {
    const code = '123456';
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u1',
          email: 'sender.clox@yopmail.com',
          name: null,
          role: 'SENDER',
          status: 'ACTIVE',
        }),
      },
      adminUser: { findUnique: jest.fn().mockResolvedValue(null) },
      otpChallenge: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'otp-1',
          codeHash: hashValue(code),
          attempts: 0,
          consumedAt: null,
          expiresAt: new Date('2099-01-01'),
        }),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const audit = { recordPlatform: jest.fn() };
    const service = new AuthService(
      prisma as never,
      { signAsync: jest.fn() } as never,
      {
        get: (k: string) => {
          if (k === 'JWT_ACCESS_SECRET') return 'a'.repeat(32);
          if (k === 'JWT_REFRESH_SECRET') return 'b'.repeat(32);
          if (k === 'JWT_ACCESS_TTL') return '15m';
          if (k === 'JWT_REFRESH_TTL') return '7d';
          return undefined;
        },
      } as never,
      audit as never,
      { sendMail: jest.fn() } as never,
    );

    await expect(
      service.verifyOtp({ email: 'sender.clox@yopmail.com', code }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.otpChallenge.updateMany).toHaveBeenCalledWith({
      where: { id: 'otp-1', consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it('issues tokens when updateMany count is 1', async () => {
    const code = '654321';
    const prisma = {
      isConnected: () => true,
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u1',
          email: 'sender.clox@yopmail.com',
          name: 'S',
          role: 'SENDER',
          status: 'ACTIVE',
        }),
      },
      adminUser: { findUnique: jest.fn().mockResolvedValue(null) },
      otpChallenge: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'otp-1',
          codeHash: hashValue(code),
          attempts: 0,
          consumedAt: null,
          expiresAt: new Date('2099-01-01'),
          purpose: OtpPurpose.LOGIN,
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
    const audit = { recordPlatform: jest.fn() };
    const service = new AuthService(
      prisma as never,
      jwt as never,
      {
        get: (k: string) => {
          if (k === 'JWT_ACCESS_SECRET') return 'a'.repeat(32);
          if (k === 'JWT_REFRESH_SECRET') return 'b'.repeat(32);
          if (k === 'JWT_ACCESS_TTL') return '15m';
          if (k === 'JWT_REFRESH_TTL') return '7d';
          return undefined;
        },
      } as never,
      audit as never,
      { sendMail: jest.fn() } as never,
    );

    const tokens = await service.verifyOtp({ email: 'sender.clox@yopmail.com', code });
    expect(tokens.accessToken).toBe('access.jwt');
    expect(tokens.refreshToken).toBe('refresh.jwt');
    expect(prisma.authSession.create).toHaveBeenCalled();
  });
});
