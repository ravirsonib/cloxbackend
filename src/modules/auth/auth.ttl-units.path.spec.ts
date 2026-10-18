import { OtpPurpose } from '@prisma/client';
import { hashValue } from '../../common/utils/crypto';
import { AuthService } from './auth.service';

describe('AuthService ttlToMs unit leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const notifications = {
    sendOtpEmail: jest.fn().mockResolvedValue({ skipped: true }),
    sendMail: jest.fn().mockResolvedValue({ skipped: true }),
  };

  function makeService(accessTtl: string, refreshTtl: string) {
    const code = '123456';
    const jwt = {
      signAsync: jest
        .fn()
        .mockResolvedValueOnce('refresh.jwt')
        .mockResolvedValueOnce('access.jwt'),
      verifyAsync: jest.fn(),
    };
    const service = new AuthService(
      {
        isConnected: () => true,
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'u1',
            email: 'sender@yopmail.com',
            phone: null,
            name: 'Sender',
            role: 'SENDER',
            status: 'ACTIVE',
            companyId: 'co-1',
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
          update: jest.fn(),
        },
        authSession: {
          create: jest.fn().mockResolvedValue({ id: 'sess-1' }),
        },
      } as never,
      jwt as never,
      {
        get: (k: string) => {
          const map: Record<string, unknown> = {
            JWT_ACCESS_SECRET: 'a'.repeat(32),
            JWT_REFRESH_SECRET: 'b'.repeat(32),
            JWT_ACCESS_TTL: accessTtl,
            JWT_REFRESH_TTL: refreshTtl,
            OTP_TTL_MINUTES: 10,
            OTP_LENGTH: 6,
            OTP_MAX_ATTEMPTS: 5,
            EXPOSE_OTP_IN_RESPONSE: false,
            NODE_ENV: 'test',
          };
          return map[k];
        },
      } as never,
      audit as never,
      notifications as never,
    );
    return { service, jwt, code };
  }

  beforeEach(() => jest.clearAllMocks());

  it('issues tokens with seconds access + hours refresh TTLs', async () => {
    const { service, jwt, code } = makeService('45s', '2h');
    const tokens = await service.verifyOtp({
      email: 'sender@yopmail.com',
      code,
    });
    expect(tokens).toMatchObject({
      accessToken: 'access.jwt',
      refreshToken: 'refresh.jwt',
    });
    expect(jwt.signAsync).toHaveBeenCalledTimes(2);
  });

  it('issues tokens with seconds access + days refresh', async () => {
    const { service, code } = makeService('30s', '1d');
    await expect(
      service.verifyOtp({ email: 'sender@yopmail.com', code }),
    ).resolves.toMatchObject({ accessToken: 'access.jwt' });
  });
});
