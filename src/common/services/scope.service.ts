import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthenticatedPrincipal } from '../guards/jwt-auth.guard';
import { AdminRole } from '../../shared/types';

/**
 * Server-side scope filter helpers — never trust client `state=` alone.
 */
@Injectable()
export class ScopeService {
  assertAdmin(principal: AuthenticatedPrincipal) {
    if (principal.kind !== 'admin') {
      throw new ForbiddenException('Admin principal required');
    }
  }

  /** Super sees all; State/Local only their region codes. */
  allowedRegionCodes(principal: AuthenticatedPrincipal): string[] | null {
    this.assertAdmin(principal);
    if (principal.role === AdminRole.SUPER_ADMIN) {
      return null; // unrestricted
    }
    return principal.regionCodes;
  }

  allowedTerritoryCodes(principal: AuthenticatedPrincipal): string[] | null {
    this.assertAdmin(principal);
    if (principal.role === AdminRole.SUPER_ADMIN) {
      return null;
    }
    if (principal.role === AdminRole.STATE_MASTER) {
      return null; // whole state — territories unrestricted within region
    }
    return principal.territoryCodes;
  }

  assertRegionAccess(principal: AuthenticatedPrincipal, regionCode: string) {
    const allowed = this.allowedRegionCodes(principal);
    if (allowed === null) {
      return;
    }
    if (!allowed.includes(regionCode.toUpperCase())) {
      throw new ForbiddenException('Outside admin scope (region)');
    }
  }

  assertTerritoryAccess(principal: AuthenticatedPrincipal, territoryCode: string) {
    const allowed = this.allowedTerritoryCodes(principal);
    if (allowed === null) {
      return;
    }
    if (!allowed.includes(territoryCode.toUpperCase())) {
      throw new ForbiddenException('Outside admin scope (territory)');
    }
  }
}
