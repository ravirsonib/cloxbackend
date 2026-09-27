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
  AuditAction,
  AdminRole,
  type AuthTokens,
  type OtpRequestInput,
  type OtpVerifyInput,
  type RefreshTokenInput,
} from '../../shared/types';
import type { AppEnv } from '../../config/env.validation';
import { generateOtpCode, hashValue, safeEqual } from '../../common/utils/crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

type AccessPayload = {
  sub: string;
  email: string;
  role: string;
  typ: 'access';
};

type RefreshPayload = {
  sub: string;
  email: string;
  role: string;
  typ: 'refresh';
};

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

  async requestOtp(input: OtpRequestInput) {
    this.ensureDatabase();

    const admin = await this.prisma.adminUser.findUnique({
      where: { email: input.email },
    });

    // Avoid account enumeration — always return the same shape.
    const generic = {
      ok: true,
      message: 'If this email is registered, a login code has been sent.',
    };

    if (!admin || !admin.active) {
      if (this.config.get('NODE_ENV', { infer: true }) !== 'production') {
        this.logger.warn(
          `OTP requested for unknown/inactive admin email: ${input.email} (no email sent)`,
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
        adminUserId: admin.id,
        codeHash: hashValue(code),
        expiresAt,
      },
    });

    await this.audit.record({
      action: AuditAction.AUTH_OTP_REQUESTED,
      actorId: admin.id,
      metadata: { email: admin.email },
    });

    // Don't block the HTTP response on SMTP (Gmail from Render can take many seconds).
    void this.notifications
      .sendOtpEmail({
        to: admin.email,
        code,
        ttlMinutes,
      })
      .then((mailResult) => {
        if (mailResult.skipped) {
          if (this.config.get('NODE_ENV', { infer: true }) !== 'production') {
            this.logger.warn(`DEV OTP for ${admin.email}: ${code}`);
          } else {
            this.logger.warn(`OTP email skipped (SMTP not configured) for ${admin.email}`);
          }
          return;
        }
        this.logger.log(`OTP email accepted by SMTP for ${admin.email}`);
      })
      .catch((error: unknown) => {
        this.logger.error(
          `Failed to send OTP email for ${admin.email}`,
          error instanceof Error ? error.stack : String(error),
        );
      });

    if (this.config.get('EXPOSE_OTP_IN_RESPONSE', { infer: true })) {
      this.logger.warn(`EXPOSE_OTP_IN_RESPONSE is on — returning OTP in API body for ${admin.email}`);
      return { ...generic, debugCode: code };
    }

    return generic;
  }

  async verifyOtp(input: OtpVerifyInput): Promise<AuthTokens> {
    this.ensureDatabase();

    const admin = await this.prisma.adminUser.findUnique({
      where: { email: input.email },
    });

    if (!admin || !admin.active) {
      throw new UnauthorizedException('Invalid email or code');
    }

    const challenge = await this.prisma.otpChallenge.findFirst({
      where: {
        adminUserId: admin.id,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!challenge) {
      await this.audit.record({
        action: AuditAction.AUTH_OTP_FAILED,
        actorId: admin.id,
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
      await this.audit.record({
        action: AuditAction.AUTH_OTP_FAILED,
        actorId: admin.id,
        metadata: { reason: 'mismatch' },
      });
      throw new UnauthorizedException('Invalid email or code');
    }

    await this.prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });

    await this.audit.record({
      action: AuditAction.AUTH_OTP_VERIFIED,
      actorId: admin.id,
      metadata: { email: admin.email },
    });

    return this.issueTokens(admin);
  }

  async refresh(input: RefreshTokenInput): Promise<AuthTokens> {
    this.ensureDatabase();

    let payload: RefreshPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshPayload>(input.refreshToken, {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (payload.typ !== 'refresh') {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const admin = await this.prisma.adminUser.findUnique({
      where: { id: payload.sub },
    });

    if (!admin || !admin.active) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    await this.audit.record({
      action: AuditAction.AUTH_TOKEN_REFRESHED,
      actorId: admin.id,
    });

    return this.issueTokens(admin);
  }

  private async issueTokens(admin: {
    id: string;
    email: string;
    name: string | null;
    role: string;
  }): Promise<AuthTokens> {
    const accessTtl = this.config.get('JWT_ACCESS_TTL', { infer: true });
    const refreshTtl = this.config.get('JWT_REFRESH_TTL', { infer: true });

    const accessPayload: AccessPayload = {
      sub: admin.id,
      email: admin.email,
      role: admin.role,
      typ: 'access',
    };
    const refreshPayload: RefreshPayload = {
      sub: admin.id,
      email: admin.email,
      role: admin.role,
      typ: 'refresh',
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(accessPayload, {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
        expiresIn: accessTtl as `${number}${'s' | 'm' | 'h' | 'd'}`,
      }),
      this.jwt.signAsync(refreshPayload, {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
        expiresIn: refreshTtl as `${number}${'s' | 'm' | 'h' | 'd'}`,
      }),
    ]);

    return {
      accessToken,
      refreshToken,
      expiresIn: accessTtl,
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: AdminRole.SUPER_ADMIN,
      },
    };
  }
}
