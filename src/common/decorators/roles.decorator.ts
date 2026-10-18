import { SetMetadata } from '@nestjs/common';
import type { AppRole } from '../../shared/types';

export const ROLES_KEY = 'roles';

/** Require at least one of the listed roles. */
export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);
