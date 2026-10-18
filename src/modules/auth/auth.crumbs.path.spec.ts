import { UnauthorizedException } from '@nestjs/common';
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
  sessionId: 'sess-a',
};

const user: AuthenticatedPrincipal = {
  id: 'user-1',
  email: 'sender@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
  sessionId: 'sess-u',
};

describe('AuthService crumb branch leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const notifications = {
    sendOtpEmail: jest.fn().mockResolvedValue({ skipped: true }),
    sendMail: jest.fn().mockResolvedValue({ skipped: true }),
  };

  function cfg(overrides: Record<string, unknown> = {}) {
    const base: Record<string, unknown> = {
      JWT_ACCESS_SECRET: 'a'.repeat(32),
      JWT_REFRESH_SECRET: 'b'.repeat(32),
      JWT_ACCESS_TTL: '15m',
      JWT_REFRESH_TTL: '7d',
      OTP_TTL_MINUTES: 10,
      OTP_LENGTH: 6,
      OTP_MAX_ATTEMPTS: 5,
      EXPOSE_OTP_IN_RESPONSE: false,
      NODE_ENV: 'test',
    };
    return (k: string) => (k in overrides ? overrides[k] : base[k]);
  }

  function makeService(prisma: Record<string, unknown>, overrides?: Record<string, unknown>) {
    const jwt = {
      signAsync: jest
        .fn()
        .mockResolvedValueOnce('refresh.jwt')
        .mockResolvedValueOnce('access.jwt'),
      verifyAsync: jest.fn(),
    };
    return {
      service: new AuthService(
        prisma as never,
        jwt as never,
        { get: cfg(overrides) } as never,
        audit as never,
        notifications as never,
      ),
      jwt,
    };
  }

  beforeEach(() => jest.clearAllMocks());

  it('ttlToMs covers refresh TTL seconds and minutes', async () => {
    const code = '123456';
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
          codeHash: hashValue(code),
          attempts: 0,
          consumedAt: null,
          expiresAt: new Date('2099-01-01'),
          purpose: OtpPurpose.LOGIN,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      authSession: { create: jest.fn().mockResolvedValue({ id: 'sess-1' }) },
    };
    await makeService(prisma, { JWT_REFRESH_TTL: '30s' }).service.verifyOtp({
      email: 'sender@yopmail.com',
      code,
    });
    await makeService(prisma, { JWT_REFRESH_TTL: '20m' }).service.verifyOtp({
      email: 'sender@yopmail.com',
      code,
    });
    expect(prisma.authSession.create).toHaveBeenCalled();
  });

  it('requestOtp notify catch stringifies non-Error', async () => {
    notifications.sendOtpEmail.mockRejectedValueOnce('smtp offline');
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
    await makeService(prisma).service.requestOtp({ email: 'sender@yopmail.com' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  });

  it('verifyOtp missing challenge records admin actorAdminId', async () => {
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      adminUser: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'admin-1',
          email: 'admin@yopmail.com',
          name: 'A',
          role: 'SUPER_ADMIN',
          active: true,
          scopes: [],
        }),
      },
      otpChallenge: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).service.verifyOtp({
        email: 'admin@yopmail.com',
        code: '000000',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        actorAdminId: 'admin-1',
        actorUserId: undefined,
        metadata: { reason: 'missing_or_expired' },
      }),
    );
  });

  it('refresh reissues with null device fields for admin session', async () => {
    const session = {
      id: 'sess-1',
      refreshTokenHash: hashValue('refresh.jwt'),
      revokedAt: null,
      expiresAt: new Date('2099-01-01'),
      familyId: 'fam-1',
      deviceLabel: null,
      userAgent: null,
      ipHash: null,
      adminUserId: 'admin-1',
      userId: null,
      principalType: AuthPrincipalType.ADMIN,
    };
    const prisma = {
      isConnected: () => true,
      authSession: {
        findUnique: jest.fn().mockResolvedValue(session),
        update: jest.fn().mockResolvedValue(session),
        create: jest.fn().mockResolvedValue({ id: 'sess-2' }),
      },
      adminUser: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'admin-1',
          email: 'admin@yopmail.com',
          name: 'A',
          role: 'SUPER_ADMIN',
          active: true,
          scopes: [],
        }),
      },
      user: { findUnique: jest.fn() },
    };
    const { service, jwt } = makeService(prisma);
    jwt.verifyAsync.mockResolvedValue({
      sub: 'admin-1',
      email: 'admin@yopmail.com',
      role: 'SUPER_ADMIN',
      typ: 'refresh',
      kind: 'admin',
      sid: 'sess-1',
    });
    jwt.signAsync
      .mockReset()
      .mockResolvedValueOnce('refresh2')
      .mockResolvedValueOnce('access2');
    await expect(
      service.refresh({ refreshToken: 'refresh.jwt' }),
    ).resolves.toMatchObject({ accessToken: 'access2' });
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ actorAdminId: 'admin-1' }),
    );
  });

  it('logout sessionId path + revokeSession admin actor', async () => {
    const prisma = {
      isConnected: () => true,
      authSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({
          id: 'sess-a',
          adminUserId: 'admin-1',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    await makeService(prisma).service.logout(admin, { allDevices: false });
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sess-a', revokedAt: null },
      }),
    );
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        actorAdminId: 'admin-1',
        metadata: { allDevices: false },
      }),
    );

    await makeService(prisma).service.revokeSession(admin, 'sess-a');
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        actorAdminId: 'admin-1',
        actorUserId: undefined,
        entityId: 'sess-a',
      }),
    );
  });

  it('listSessions + logout allDevices for user principal', async () => {
    const prisma = {
      isConnected: () => true,
      authSession: {
        findMany: jest.fn().mockResolvedValue([{ id: 'sess-u' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    await makeService(prisma).service.listSessions(user);
    expect(prisma.authSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-1' }),
      }),
    );
    await makeService(prisma).service.logout(user, { allDevices: true });
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-1' }),
      }),
    );
  });

  it('verifyOtp mismatch records admin actor; logout allDevices undefined', async () => {
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      adminUser: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'admin-1',
          email: 'admin@yopmail.com',
          name: 'A',
          role: 'SUPER_ADMIN',
          active: true,
          scopes: [],
        }),
      },
      otpChallenge: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'otp-1',
          codeHash: hashValue('999999'),
          attempts: 0,
          consumedAt: null,
          expiresAt: new Date('2099-01-01'),
          purpose: OtpPurpose.LOGIN,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      authSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    await expect(
      makeService(prisma).service.verifyOtp({
        email: 'admin@yopmail.com',
        code: '000000',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        actorAdminId: 'admin-1',
        actorUserId: undefined,
        metadata: { reason: 'mismatch' },
      }),
    );

    await makeService(prisma).service.logout(admin, {
      allDevices: undefined,
    } as never);
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { allDevices: false },
      }),
    );
  });

  it('refresh + revokeSession user principal arms', async () => {
    const session = {
      id: 'sess-u',
      refreshTokenHash: hashValue('refresh.jwt'),
      revokedAt: null,
      expiresAt: new Date('2099-01-01'),
      familyId: 'fam-u',
      deviceLabel: null,
      userAgent: null,
      ipHash: null,
      adminUserId: null,
      userId: 'user-1',
      principalType: AuthPrincipalType.USER,
    };
    const prisma = {
      isConnected: () => true,
      authSession: {
        findUnique: jest.fn().mockResolvedValue(session),
        findFirst: jest.fn().mockResolvedValue(session),
        update: jest.fn().mockResolvedValue(session),
        create: jest.fn().mockResolvedValue({ id: 'sess-u2' }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-1',
          email: 'sender@yopmail.com',
          name: 'S',
          role: 'SENDER',
          status: 'ACTIVE',
        }),
      },
      adminUser: { findUnique: jest.fn() },
    };
    const { service, jwt } = makeService(prisma);
    jwt.verifyAsync.mockResolvedValue({
      sub: 'user-1',
      email: 'sender@yopmail.com',
      role: 'SENDER',
      typ: 'refresh',
      kind: 'user',
      sid: 'sess-u',
    });
    jwt.signAsync.mockReset().mockResolvedValueOnce('r2').mockResolvedValueOnce('a2');
    await expect(
      service.refresh({ refreshToken: 'refresh.jwt' }),
    ).resolves.toMatchObject({ accessToken: 'a2' });
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'user-1', actorAdminId: undefined }),
    );

    await service.revokeSession(user, 'sess-u');
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        actorAdminId: undefined,
        entityId: 'sess-u',
      }),
    );
  });
});
