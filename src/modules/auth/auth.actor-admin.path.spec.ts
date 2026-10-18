import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { AuthService } from './auth.service';

const admin: AuthenticatedPrincipal = {
  id: 'admin-1',
  email: 'admin@yopmail.com',
  role: 'SUPER_ADMIN',
  kind: 'admin',
  regionCodes: [],
  territoryCodes: [],
  sessionId: 'sess-admin',
};

describe('AuthService admin actor branch leftovers', () => {
  const audit = { recordPlatform: jest.fn() };
  const notifications = { sendOtpEmail: jest.fn(), sendMail: jest.fn() };
  const jwt = { signAsync: jest.fn(), verifyAsync: jest.fn() };

  function makeService(prisma: Record<string, unknown>) {
    return new AuthService(
      prisma as never,
      jwt as never,
      {
        get: (k: string) => {
          const map: Record<string, unknown> = {
            JWT_ACCESS_SECRET: 'a'.repeat(32),
            JWT_REFRESH_SECRET: 'b'.repeat(32),
            JWT_ACCESS_TTL: '15m',
            JWT_REFRESH_TTL: '7d',
          };
          return map[k];
        },
      } as never,
      audit as never,
      notifications as never,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('logout allDevices for admin uses adminUserId filter', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 2 });
    const prisma = {
      isConnected: () => true,
      authSession: { updateMany },
    };
    await expect(
      makeService(prisma).logout(admin, { allDevices: true }),
    ).resolves.toEqual({ ok: true });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ adminUserId: 'admin-1', revokedAt: null }),
      }),
    );
    expect(audit.recordPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        actorAdminId: 'admin-1',
        actorUserId: undefined,
      }),
    );
  });

  it('listSessions for admin filters by adminUserId', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      isConnected: () => true,
      authSession: { findMany },
    };
    await makeService(prisma).listSessions(admin);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ adminUserId: 'admin-1' }),
      }),
    );
  });
});
