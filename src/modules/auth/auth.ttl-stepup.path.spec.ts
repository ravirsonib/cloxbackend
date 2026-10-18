import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthPrincipalType, OtpPurpose } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { hashValue } from '../../common/utils/crypto';
import { AuthService } from './auth.service';

const admin: AuthenticatedPrincipal = {
  id: 'admin-1',
  email: 'admin@yopmail.com',
  role: 'SUPER_ADMIN',
  kind: 'admin',
  regionCodes: [],
  territoryCodes: [],
  sessionId: 'sess-1',
};

const userPrincipal: AuthenticatedPrincipal = {
  id: 'user-1',
  email: 'user@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

function adminRow() {
  return {
    id: 'admin-1',
    email: 'admin@yopmail.com',
    name: 'Super',
    role: 'SUPER_ADMIN',
    active: true,
    scopes: [],
  };
}

function configGet(overrides?: Record<string, unknown>) {
  const base: Record<string, unknown> = {
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: 'not-a-ttl',
    OTP_TTL_MINUTES: 10,
    OTP_LENGTH: 6,
    OTP_MAX_ATTEMPTS: 5,
    EXPOSE_OTP_IN_RESPONSE: true,
    NODE_ENV: 'test',
  };
  return (k: string) => (overrides && k in overrides ? overrides[k] : base[k]);
}

describe('AuthService ttl / step-up / refresh leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const notifications = {
    sendOtpEmail: jest.fn().mockResolvedValue({ skipped: true }),
    sendMail: jest.fn().mockResolvedValue({ skipped: true }),
  };
  const jwt = {
    signAsync: jest.fn().mockResolvedValue('signed-token'),
    verifyAsync: jest.fn(),
  };

  function makeService(
    prisma: Record<string, unknown>,
    cfg?: Record<string, unknown>,
  ) {
    return new AuthService(
      prisma as never,
      jwt as never,
      { get: configGet(cfg) } as never,
      audit as never,
      notifications as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    notifications.sendOtpEmail.mockResolvedValue({ skipped: true });
  });

  it('ensureDatabase throws when offline', async () => {
    const service = makeService({ isConnected: () => false });
    await expect(
      service.requestOtp({ email: 'admin@yopmail.com' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('requestOtp catch path logs when sendOtpEmail rejects', async () => {
    notifications.sendOtpEmail.mockRejectedValueOnce(new Error('smtp down'));
    const prisma = {
      isConnected: () => true,
      adminUser: {
        findUnique: jest.fn().mockResolvedValue(adminRow()),
      },
      user: { findUnique: jest.fn() },
      otpChallenge: {
        create: jest.fn().mockResolvedValue({ id: 'otp-1' }),
      },
    };
    const service = makeService(prisma);
    await expect(
      service.requestOtp({ email: 'admin@yopmail.com' }),
    ).resolves.toMatchObject({ ok: true });
    expect(notifications.sendOtpEmail).toHaveBeenCalled();
    await new Promise((r) => setImmediate(r));
  });

  it('refresh rotates session using invalid TTL fallback and admin resolve', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 'admin-1',
      kind: 'admin',
      sid: 'sess-old',
      typ: 'refresh',
      email: 'admin@yopmail.com',
      role: 'SUPER_ADMIN',
    });
    const prisma = {
      isConnected: () => true,
      authSession: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'sess-old',
          revokedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
          principalType: AuthPrincipalType.ADMIN,
          adminUserId: 'admin-1',
          userId: null,
          refreshTokenHash: hashValue('refresh-token'),
          familyId: 'fam-1',
          deviceLabel: 'chrome',
          userAgent: 'ua',
          ipHash: 'ip',
        }),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({ id: 'sess-new' }),
      },
      adminUser: {
        findUnique: jest.fn().mockResolvedValue(adminRow()),
      },
      user: { findUnique: jest.fn() },
    };
    const service = makeService(prisma);
    const result = await service.refresh({ refreshToken: 'refresh-token' });
    expect(result).toMatchObject({
      accessToken: 'signed-token',
      refreshToken: 'signed-token',
    });
    expect(prisma.authSession.update).toHaveBeenCalled();
    expect(audit.recordPlatform).toHaveBeenCalled();
    expect(prisma.authSession.create).toHaveBeenCalled();
  });

  it('requestStepUp returns debugCode when expose enabled', async () => {
    const prisma = {
      isConnected: () => true,
      otpChallenge: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ id: 'otp-su' }),
      },
    };
    const service = makeService(prisma);
    const result = await service.requestStepUp(admin);
    expect(result).toMatchObject({ ok: true, debugCode: expect.any(String) });
  });

  it('requestStepUp omits debugCode when expose disabled', async () => {
    const prisma = {
      isConnected: () => true,
      otpChallenge: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ id: 'otp-su' }),
      },
    };
    const service = makeService(prisma, { EXPOSE_OTP_IN_RESPONSE: false });
    await expect(service.requestStepUp(admin)).resolves.toEqual({
      ok: true,
      message: 'Step-up code sent.',
    });
  });

  it('verifyStepUp forbids non-admin and rejects missing/consumed challenges', async () => {
    const serviceUser = makeService({ isConnected: () => true });
    await expect(
      serviceUser.verifyStepUp(userPrincipal, { code: '123456' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const prismaMissing = {
      isConnected: () => true,
      otpChallenge: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prismaMissing).verifyStepUp(admin, { code: '123456' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const prismaConsumed = {
      isConnected: () => true,
      otpChallenge: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'ch-1',
          attempts: 0,
          codeHash: hashValue('123456'),
          purpose: OtpPurpose.STEP_UP,
        }),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    await expect(
      makeService(prismaConsumed).verifyStepUp(admin, { code: '123456' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
