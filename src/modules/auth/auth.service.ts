import { randomUUID } from 'crypto';
import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  AuthPrincipalType,
  OtpPurpose,
  UserStatus,
  type AdminRole as PrismaAdminRole,
  type PlatformRole as PrismaPlatformRole,
} from '@prisma/client';
import {
  AuditAction,
  AppRole,
  isAdminRole,
  type AdminRole,
  type AuthTokens,
  type LogoutInput,
  type OtpRequestInput,
  type OtpVerifyInput,
  type RefreshTokenInput,
  type StepUpVerifyInput,
} from '../../shared/types';
import type { AppEnv } from '../../config/env.validation';
import { generateOtpCode, hashValue, safeEqual } from '../../common/utils/crypto';
import type {
  AuthenticatedPrincipal,
  PrincipalKind,
} from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

type ResolvedAccount =
  | {
      kind: 'admin';
      id: string;
      email: string;
      name: string | null;
      role: PrismaAdminRole;
      regionCodes: string[];
      territoryCodes: string[];
      scopes: Array<{
        scopeType: 'STATE' | 'LOCAL';
        regionCode: string | null;
        territoryCode: string | null;
      }>;
    }
  | {
      kind: 'user';
      id: string;
      email: string;
      name: string | null;
      role: PrismaPlatformRole;
      regionCodes: string[];
      territoryCodes: string[];
      scopes?: undefined;
    };

function ttlToMs(ttl: string): number {
  const match = /^(\d+)([smhd])$/i.exec(ttl.trim());
  if (!match) {
    return 7 * 24 * 60 * 60 * 1000;
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const mult =
    unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return amount * mult;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private ensureDatabase() {
    if (!this.prisma.isConnected()) {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  private async resolveAccount(input: {
    email?: string;
    phone?: string;
  }): Promise<ResolvedAccount | null> {
    if (input.email) {
      const admin = await this.prisma.adminUser.findUnique({
        where: { email: input.email },
        include: {
          scopes: {
            include: { region: true, localTerritory: true },
          },
        },
      });
      if (admin?.active) {
        return {
          kind: 'admin',
          id: admin.id,
          email: admin.email,
          name: admin.name,
          role: admin.role,
          regionCodes: admin.scopes
            .map((s) => s.region?.code)
            .filter((code): code is string => Boolean(code)),
          territoryCodes: admin.scopes
            .map((s) => s.localTerritory?.code)
            .filter((code): code is string => Boolean(code)),
          scopes: admin.scopes.map((s) => ({
            scopeType: s.scopeType,
            regionCode: s.region?.code ?? null,
            territoryCode: s.localTerritory?.code ?? null,
          })),
        };
      }

      const user = await this.prisma.user.findUnique({ where: { email: input.email } });
      if (user && user.status === UserStatus.ACTIVE) {
        return {
          kind: 'user',
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          regionCodes: [],
          territoryCodes: [],
        };
      }
    }

    if (input.phone) {
      const user = await this.prisma.user.findFirst({
        where: { phone: input.phone },
      });
      if (user && user.status === UserStatus.ACTIVE) {
        return {
          kind: 'user',
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          regionCodes: [],
          territoryCodes: [],
        };
      }
    }

    return null;
  }

  async requestOtp(input: OtpRequestInput) {
    this.ensureDatabase();

    const generic = {
      ok: true,
      message: 'If this account is registered, a login code has been sent.',
    };

    const account = await this.resolveAccount(input);
    if (!account) {
      if (this.config.get('NODE_ENV', { infer: true }) !== 'production') {
        this.logger.warn(
          `OTP requested for unknown account email=${input.email ?? '-'} phone=${input.phone ?? '-'}`,
        );
      }
      return generic;
    }

    const ttlMinutes = this.config.get('OTP_TTL_MINUTES', { infer: true });
    const length = this.config.get('OTP_LENGTH', { infer: true });
    const code = generateOtpCode(length);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

    await this.prisma.otpChallenge.create({
      data: {
        adminUserId: account.kind === 'admin' ? account.id : null,
        userId: account.kind === 'user' ? account.id : null,
        purpose: OtpPurpose.LOGIN,
        codeHash: hashValue(code),
        expiresAt,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.AUTH_OTP_REQUESTED,
      actorAdminId: account.kind === 'admin' ? account.id : undefined,
      actorUserId: account.kind === 'user' ? account.id : undefined,
      metadata: { email: account.email, role: account.role },
    });

    void this.notifications
      .sendOtpEmail({
        to: account.email,
        code,
        ttlMinutes,
      })
      .then((mailResult) => {
        if (mailResult.skipped) {
          if (this.config.get('NODE_ENV', { infer: true }) !== 'production') {
            this.logger.warn(`DEV OTP for ${account.email}: ${code}`);
          }
        }
      })
      .catch((error: unknown) => {
        this.logger.error(
          `Failed to send OTP email for ${account.email}`,
          error instanceof Error ? error.stack : String(error),
        );
      });

    if (this.config.get('EXPOSE_OTP_IN_RESPONSE', { infer: true })) {
      return { ...generic, debugCode: code };
    }

    return generic;
  }

  async verifyOtp(
    input: OtpVerifyInput,
    meta?: { userAgent?: string; ipHash?: string },
  ): Promise<AuthTokens> {
    this.ensureDatabase();

    const account = await this.resolveAccount(input);
    if (!account) {
      throw new UnauthorizedException('Invalid email or code');
    }

    const challenge = await this.prisma.otpChallenge.findFirst({
      where: {
        purpose: OtpPurpose.LOGIN,
        consumedAt: null,
        expiresAt: { gt: new Date() },
        ...(account.kind === 'admin'
          ? { adminUserId: account.id }
          : { userId: account.id }),
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!challenge) {
      await this.audit.recordPlatform({
        action: AuditAction.AUTH_OTP_FAILED,
        actorAdminId: account.kind === 'admin' ? account.id : undefined,
        actorUserId: account.kind === 'user' ? account.id : undefined,
        metadata: { reason: 'missing_or_expired' },
      });
      throw new UnauthorizedException('Invalid email or code');
    }

    if (challenge.attempts >= 5) {
      throw new ForbiddenException('Too many OTP attempts. Request a new code.');
    }

    const matches = safeEqual(challenge.codeHash, hashValue(input.code));
    if (!matches) {
      await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      await this.audit.recordPlatform({
        action: AuditAction.AUTH_OTP_FAILED,
        actorAdminId: account.kind === 'admin' ? account.id : undefined,
        actorUserId: account.kind === 'user' ? account.id : undefined,
        metadata: { reason: 'mismatch' },
      });
      throw new UnauthorizedException('Invalid email or code');
    }

    // Atomic consume — concurrent verify with same code issues at most one session.
    const consumed = await this.prisma.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw new UnauthorizedException('Invalid email or code');
    }

    await this.audit.recordPlatform({
      action: AuditAction.AUTH_OTP_VERIFIED,
      actorAdminId: account.kind === 'admin' ? account.id : undefined,
      actorUserId: account.kind === 'user' ? account.id : undefined,
      metadata: { email: account.email, role: account.role },
    });

    return this.issueTokens(account, {
      deviceLabel: input.deviceLabel,
      userAgent: meta?.userAgent,
      ipHash: meta?.ipHash,
    });
  }

  async refresh(input: RefreshTokenInput): Promise<AuthTokens> {
    this.ensureDatabase();

    let payload: {
      sub: string;
      email: string;
      role: string;
      typ: string;
      kind: PrincipalKind;
      sid?: string;
    };
    try {
      payload = await this.jwt.verifyAsync(input.refreshToken, {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (payload.typ !== 'refresh' || !payload.sid) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokenHash = hashValue(input.refreshToken);
    const session = await this.prisma.authSession.findUnique({
      where: { id: payload.sid },
    });

    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      !safeEqual(session.refreshTokenHash, tokenHash)
    ) {
      // Reuse of a rotated/revoked refresh token → kill the whole family.
      if (session?.familyId) {
        await this.prisma.authSession.updateMany({
          where: { familyId: session.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      throw new UnauthorizedException('Invalid refresh token');
    }

    const account = await this.resolveAccountById(session.principalType, session);
    if (!account) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    await this.prisma.authSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    await this.audit.recordPlatform({
      action: AuditAction.AUTH_TOKEN_REFRESHED,
      actorAdminId: account.kind === 'admin' ? account.id : undefined,
      actorUserId: account.kind === 'user' ? account.id : undefined,
      metadata: { sessionId: session.id },
    });

    return this.issueTokens(account, {
      deviceLabel: session.deviceLabel ?? undefined,
      userAgent: session.userAgent ?? undefined,
      ipHash: session.ipHash ?? undefined,
      familyId: session.familyId,
    });
  }

  async logout(principal: AuthenticatedPrincipal, input: LogoutInput) {
    this.ensureDatabase();

    if (input.allDevices) {
      await this.prisma.authSession.updateMany({
        where: {
          revokedAt: null,
          ...(principal.kind === 'admin'
            ? { adminUserId: principal.id }
            : { userId: principal.id }),
        },
        data: { revokedAt: new Date() },
      });
    } else if (input.refreshToken) {
      const hash = hashValue(input.refreshToken);
      await this.prisma.authSession.updateMany({
        where: { refreshTokenHash: hash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } else if (principal.sessionId) {
      await this.prisma.authSession.updateMany({
        where: { id: principal.sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await this.audit.recordPlatform({
      action: AuditAction.AUTH_LOGOUT,
      actorAdminId: principal.kind === 'admin' ? principal.id : undefined,
      actorUserId: principal.kind === 'user' ? principal.id : undefined,
      metadata: { allDevices: input.allDevices ?? false },
    });

    return { ok: true };
  }

  async listSessions(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    const sessions = await this.prisma.authSession.findMany({
      where: {
        revokedAt: null,
        expiresAt: { gt: new Date() },
        ...(principal.kind === 'admin'
          ? { adminUserId: principal.id }
          : { userId: principal.id }),
      },
      orderBy: { lastUsedAt: 'desc' },
      select: {
        id: true,
        deviceLabel: true,
        userAgent: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    });

    return {
      data: sessions.map((s) => ({
        ...s,
        isCurrent: s.id === principal.sessionId,
      })),
    };
  }

  async revokeSession(principal: AuthenticatedPrincipal, sessionId: string) {
    this.ensureDatabase();
    const session = await this.prisma.authSession.findFirst({
      where: {
        id: sessionId,
        revokedAt: null,
        ...(principal.kind === 'admin'
          ? { adminUserId: principal.id }
          : { userId: principal.id }),
      },
    });

    if (!session) {
      throw new UnauthorizedException('Session not found');
    }

    await this.prisma.authSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    await this.audit.recordPlatform({
      action: AuditAction.AUTH_SESSION_REVOKED,
      actorAdminId: principal.kind === 'admin' ? principal.id : undefined,
      actorUserId: principal.kind === 'user' ? principal.id : undefined,
      entityType: 'AuthSession',
      entityId: session.id,
    });

    return { ok: true };
  }

  async requestStepUp(principal: AuthenticatedPrincipal) {
    this.ensureDatabase();
    if (principal.kind !== 'admin') {
      throw new ForbiddenException('Step-up is for admin principals');
    }

    const ttlMinutes = this.config.get('OTP_TTL_MINUTES', { infer: true });
    const length = this.config.get('OTP_LENGTH', { infer: true });
    const code = generateOtpCode(length);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

    await this.prisma.otpChallenge.create({
      data: {
        adminUserId: principal.id,
        purpose: OtpPurpose.STEP_UP,
        codeHash: hashValue(code),
        expiresAt,
      },
    });

    await this.audit.recordPlatform({
      action: AuditAction.AUTH_STEP_UP_REQUESTED,
      actorAdminId: principal.id,
    });

    void this.notifications.sendOtpEmail({
      to: principal.email,
      code,
      ttlMinutes,
    });

    if (this.config.get('EXPOSE_OTP_IN_RESPONSE', { infer: true })) {
      return {
        ok: true,
        message: 'Step-up code sent.',
        debugCode: code,
      };
    }

    return { ok: true, message: 'Step-up code sent.' };
  }

  async verifyStepUp(principal: AuthenticatedPrincipal, input: StepUpVerifyInput) {
    this.ensureDatabase();
    if (principal.kind !== 'admin') {
      throw new ForbiddenException('Step-up is for admin principals');
    }

    const challenge = await this.prisma.otpChallenge.findFirst({
      where: {
        adminUserId: principal.id,
        purpose: OtpPurpose.STEP_UP,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!challenge || challenge.attempts >= 5) {
      throw new UnauthorizedException('Invalid or expired step-up code');
    }

    if (!safeEqual(challenge.codeHash, hashValue(input.code))) {
      await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('Invalid or expired step-up code');
    }

    const consumed = await this.prisma.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw new UnauthorizedException('Invalid or expired step-up code');
    }

    await this.audit.recordPlatform({
      action: AuditAction.AUTH_STEP_UP_VERIFIED,
      actorAdminId: principal.id,
    });

    const stepUpToken = await this.jwt.signAsync(
      {
        sub: principal.id,
        kind: principal.kind,
        typ: 'stepup',
      },
      {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
        expiresIn: '5m',
      },
    );

    return { stepUpToken, expiresIn: '5m' };
  }

  private async resolveAccountById(
    principalType: AuthPrincipalType,
    session: { adminUserId: string | null; userId: string | null },
  ): Promise<ResolvedAccount | null> {
    if (principalType === AuthPrincipalType.ADMIN && session.adminUserId) {
      return this.resolveAccount({
        email: (
          await this.prisma.adminUser.findUnique({ where: { id: session.adminUserId } })
        )?.email,
      });
    }
    if (principalType === AuthPrincipalType.USER && session.userId) {
      const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
      return user ? this.resolveAccount({ email: user.email }) : null;
    }
    return null;
  }

  private async issueTokens(
    account: ResolvedAccount,
    opts?: {
      deviceLabel?: string;
      userAgent?: string;
      ipHash?: string;
      familyId?: string;
    },
  ): Promise<AuthTokens> {
    const accessTtl = this.config.get('JWT_ACCESS_TTL', { infer: true });
    const refreshTtl = this.config.get('JWT_REFRESH_TTL', { infer: true });
    const familyId = opts?.familyId ?? randomUUID();
    const sessionId = randomUUID();

    const refreshPayload = {
      sub: account.id,
      email: account.email,
      role: account.role,
      typ: 'refresh' as const,
      kind: account.kind,
      sid: sessionId,
    };

    const refreshToken = await this.jwt.signAsync(refreshPayload, {
      secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
      expiresIn: refreshTtl as `${number}${'s' | 'm' | 'h' | 'd'}`,
    });

    await this.prisma.authSession.create({
      data: {
        id: sessionId,
        principalType:
          account.kind === 'admin' ? AuthPrincipalType.ADMIN : AuthPrincipalType.USER,
        adminUserId: account.kind === 'admin' ? account.id : null,
        userId: account.kind === 'user' ? account.id : null,
        refreshTokenHash: hashValue(refreshToken),
        familyId,
        deviceLabel: opts?.deviceLabel,
        userAgent: opts?.userAgent,
        ipHash: opts?.ipHash,
        expiresAt: new Date(Date.now() + ttlToMs(refreshTtl)),
      },
    });

    const accessPayload = {
      sub: account.id,
      email: account.email,
      role: account.role,
      typ: 'access' as const,
      kind: account.kind,
      sid: sessionId,
      regions: account.regionCodes,
      territories: account.territoryCodes,
    };

    const accessToken = await this.jwt.signAsync(accessPayload, {
      secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      expiresIn: accessTtl as `${number}${'s' | 'm' | 'h' | 'd'}`,
    });

    const role = account.role as AppRole;
    const principal = {
      kind: account.kind,
      id: account.id,
      email: account.email,
      name: account.name,
      role,
      scopes: account.kind === 'admin' ? account.scopes : undefined,
    };

    return {
      accessToken,
      refreshToken,
      expiresIn: accessTtl,
      sessionId,
      principal,
      admin:
        account.kind === 'admin' && isAdminRole(role)
          ? {
              id: account.id,
              email: account.email,
              name: account.name,
              role: role as AdminRole,
            }
          : undefined,
    };
  }
}
