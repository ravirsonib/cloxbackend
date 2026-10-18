import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { AppEnv } from '../../config/env.validation';
import type { AuthenticatedPrincipal } from './jwt-auth.guard';

/**
 * Sensitive admin actions (policy / payouts / suspend).
 * Client must send `X-Step-Up-Token` from POST /v1/auth/otp/step-up/verify.
 */
@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedPrincipal }>();
    const principal = request.user;
    if (!principal) {
      throw new UnauthorizedException('Missing authenticated principal');
    }

    const header = request.headers['x-step-up-token'];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token) {
      throw new ForbiddenException('Step-up OTP required');
    }

    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        typ: string;
        kind: string;
      }>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      });

      if (payload.typ !== 'stepup' || payload.sub !== principal.id) {
        throw new ForbiddenException('Invalid step-up token');
      }
      return true;
    } catch {
      throw new ForbiddenException('Invalid or expired step-up token');
    }
  }
}
