import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AppRole } from '../../shared/types';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthenticatedPrincipal } from './jwt-auth.guard';

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

    return true;
  }
}
