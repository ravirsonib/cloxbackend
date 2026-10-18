import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedPrincipal } from '../guards/jwt-auth.guard';

/** Extract authenticated principal from request (testable factory). */
export function extractCurrentPrincipal(
  _data: unknown,
  ctx: ExecutionContext,
): AuthenticatedPrincipal {
  const request = ctx.switchToHttp().getRequest<{ user: AuthenticatedPrincipal }>();
  return request.user;
}

export const CurrentPrincipal = createParamDecorator(extractCurrentPrincipal);

/** @deprecated Use CurrentPrincipal */
export const CurrentAdmin = CurrentPrincipal;
