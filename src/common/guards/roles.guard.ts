import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminUserStatus } from '@prisma/client';
import type { AppRole } from '../../shared/types';
import { AdminRole } from '../../shared/types';
import { ALLOW_PENDING_PARTNER_KEY } from '../decorators/allow-pending-partner.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthenticatedPrincipal } from './jwt-auth.guard';

const PARTNER_ROLES: AppRole[] = [AdminRole.STATE_MASTER, AdminRole.LOCAL_BDE];

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AppRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedPrincipal }>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException('Missing authenticated principal');
    }

    if (!required.includes(user.role)) {
      throw new ForbiddenException('Insufficient role');
    }

    const allowPending = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PARTNER_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const isPendingPartner =
      user.kind === 'admin' &&
      PARTNER_ROLES.includes(user.role) &&
      user.adminStatus != null &&
      user.adminStatus !== AdminUserStatus.ACTIVE;

    if (isPendingPartner && !allowPending) {
      throw new ForbiddenException(
        'Ops access requires Super Admin approval — complete partner onboarding first',
      );
    }

    return true;
  }
}
