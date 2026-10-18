import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { AppEnv } from '../../config/env.validation';
import type { AppRole } from '../../shared/types';
import { PrismaService } from '../../prisma/prisma.service';

export type PrincipalKind = 'admin' | 'user';

export type AuthenticatedPrincipal = {
  id: string;
  email: string;
  role: AppRole;
  kind: PrincipalKind;
  sessionId?: string;
  /** Region codes for admin scope (empty = Super / national). */
  regionCodes: string[];
  /** Local territory codes for Local BDE. */
  territoryCodes: string[];
};

/** @deprecated Prefer AuthenticatedPrincipal — kept for Phase 0 admin controllers. */
export type AuthenticatedAdmin = AuthenticatedPrincipal;

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedPrincipal }>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const token = header.slice('Bearer '.length).trim();
    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        email: string;
        role: AppRole;
        typ: string;
        kind: PrincipalKind;
        sid?: string;
        regions?: string[];
        territories?: string[];
      }>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      });

      if (payload.typ !== 'access') {
        throw new UnauthorizedException('Invalid access token');
      }

      if (payload.kind !== 'admin' && payload.kind !== 'user') {
        throw new UnauthorizedException('Invalid access token');
      }

      // Fail closed — never skip revoke/status/role checks.
      if (!this.prisma.isConnected()) {
        throw new ServiceUnavailableException('Auth unavailable — database offline');
      }

      if (payload.sid) {
        const session = await this.prisma.authSession.findUnique({
          where: { id: payload.sid },
          select: { id: true, revokedAt: true },
        });
        if (!session || session.revokedAt) {
          throw new UnauthorizedException('Session revoked');
        }
      }

      if (payload.kind === 'admin') {
        const admin = await this.prisma.adminUser.findUnique({
          where: { id: payload.sub },
          include: {
            scopes: {
              include: { region: true, localTerritory: true },
            },
          },
        });
        if (!admin || !admin.active) {
          throw new UnauthorizedException('Account disabled');
        }
        request.user = {
          id: admin.id,
          email: admin.email,
          role: admin.role as AppRole,
          kind: 'admin',
          sessionId: payload.sid,
          regionCodes: admin.scopes
            .map((s) => s.region?.code)
            .filter((code): code is string => Boolean(code)),
          territoryCodes: admin.scopes
            .map((s) => s.localTerritory?.code)
            .filter((code): code is string => Boolean(code)),
        };
        return true;
      }

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, role: true, status: true },
      });
      if (!user || user.status === 'DISABLED' || user.status === 'SUSPENDED') {
        throw new UnauthorizedException('Account disabled');
      }
      if (user.status !== 'ACTIVE') {
        throw new UnauthorizedException('Account not active');
      }

      request.user = {
        id: user.id,
        email: user.email,
        role: user.role as AppRole,
        kind: 'user',
        sessionId: payload.sid,
        regionCodes: [],
        territoryCodes: [],
      };
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      if (err instanceof ServiceUnavailableException) throw err;
      throw new UnauthorizedException('Invalid access token');
    }
  }
}
