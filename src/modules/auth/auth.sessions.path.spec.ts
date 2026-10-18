import {
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { OtpPurpose } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { hashValue } from '../../common/utils/crypto';
import { AuthService } from './auth.service';

const adminPrincipal: AuthenticatedPrincipal = {
  id: 'admin-1',
  email: 'admin@yopmail.com',
  role: 'SUPER_ADMIN',
  kind: 'admin',
  regionCodes: [],
  territoryCodes: [],
};

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

describe('AuthService step-up / sessions / requestOtp paths', () => {
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

  it('requestOtp returns generic ok when account unknown (no enumeration)', async () => {
    const prisma = {
      isConnected: () => true,
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      adminUser: { findUnique: jest.fn().mockResolvedValue(null) },
      otpChallenge: { create: jest.fn() },
    };
    const service = makeService(prisma);
    const result = await service.requestOtp({ email: 'ghost.clox@yopmail.com' });
    expect(result).toMatchObject({ ok: true });
    expect(prisma.otpChallenge.create).not.toHaveBeenCalled();
  });

  it('requestOtp creates challenge and emails when user found', async () => {
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
        create: jest.fn().mockResolvedValue({ id: 'otp-1' }),
      },
    };
    const service = makeService(prisma);
    const result = await service.requestOtp({ email: 'sender.clox@yopmail.com' });
    expect(result).toMatchObject({ ok: true });
    expect(prisma.otpChallenge.create).toHaveBeenCalled();
    expect(notifications.sendOtpEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'sender.clox@yopmail.com', ttlMinutes: 10 }),
    );
  });

  it('requestStepUp requires admin principal', async () => {
    const service = makeService({ isConnected: () => true });
    await expect(
      service.requestStepUp({
        ...adminPrincipal,
        kind: 'user',
        role: 'SENDER',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requestStepUp creates OTP challenge for admin', async () => {
    const prisma = {
      isConnected: () => true,
      otpChallenge: {
        create: jest.fn().mockResolvedValue({ id: 'otp-su' }),
      },
    };
    const service = makeService(prisma);
    const result = await service.requestStepUp(adminPrincipal);
    expect(result).toMatchObject({ ok: true, message: 'Step-up code sent.' });
    expect(prisma.otpChallenge.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        purpose: OtpPurpose.STEP_UP,
        adminUserId: 'admin-1',
      }),
    });
    expect(notifications.sendOtpEmail).toHaveBeenCalled();
  });

  it('verifyStepUp rejects wrong code', async () => {
    const prisma = {
      isConnected: () => true,
      otpChallenge: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'otp-1',
          codeHash: hashValue('111111'),
          attempts: 0,
          consumedAt: null,
          expiresAt: new Date('2099-01-01'),
        }),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    const service = makeService(prisma);
    await expect(
      service.verifyStepUp(adminPrincipal, { code: '000000' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.otpChallenge.update).toHaveBeenCalled();
  });

  it('verifyStepUp returns step-up JWT when consume succeeds', async () => {
    const code = '424242';
    const prisma = {
      isConnected: () => true,
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
    };
    const service = makeService(prisma);
    const result = await service.verifyStepUp(adminPrincipal, { code });
    expect(result).toEqual({ stepUpToken: 'signed-token', expiresIn: '5m' });
    expect(jwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ typ: 'stepup', sub: 'admin-1' }),
      expect.objectContaining({ expiresIn: '5m' }),
    );
  });

  it('logout revokes session by refresh hash when provided', async () => {
    const prisma = {
      isConnected: () => true,
      authSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = makeService(prisma);
    await expect(
      service.logout(adminPrincipal, {
        allDevices: false,
        refreshToken: 'refresh-raw',
      }),
    ).resolves.toEqual({ ok: true });
    expect(prisma.authSession.updateMany).toHaveBeenCalled();
  });

  it('listSessions returns mapped data with isCurrent', async () => {
    const prisma = {
      isConnected: () => true,
      authSession: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 's1',
            deviceLabel: null,
            userAgent: 'ua',
            createdAt: new Date('2026-01-01'),
            lastUsedAt: null,
            expiresAt: new Date('2026-02-01'),
          },
        ]),
      },
    };
    const service = makeService(prisma);
    const result = await service.listSessions({
      ...adminPrincipal,
      sessionId: 's1',
    });
    expect(result).toEqual({
      data: [
        expect.objectContaining({ id: 's1', userAgent: 'ua', isCurrent: true }),
      ],
    });
  });

  it('revokeSession updates matching session', async () => {
    const prisma = {
      isConnected: () => true,
      authSession: {
        findFirst: jest.fn().mockResolvedValue({ id: 's1' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const service = makeService(prisma);
    await expect(service.revokeSession(adminPrincipal, 's1')).resolves.toEqual({
      ok: true,
    });
    expect(prisma.authSession.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('revokeSession throws when session missing', async () => {
    const prisma = {
      isConnected: () => true,
      authSession: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const service = makeService(prisma);
    await expect(
      service.revokeSession(adminPrincipal, 'missing'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
