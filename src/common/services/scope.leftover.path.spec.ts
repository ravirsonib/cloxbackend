import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedPrincipal } from '../guards/jwt-auth.guard';
import { ScopeService } from './scope.service';

const superAdmin: AuthenticatedPrincipal = {
  id: 'a1',
  email: 'super@yopmail.com',
  role: 'SUPER_ADMIN',
  kind: 'admin',
  regionCodes: [],
  territoryCodes: [],
};

const stateMaster: AuthenticatedPrincipal = {
  id: 'a2',
  email: 'state@yopmail.com',
  role: 'STATE_MASTER',
  kind: 'admin',
  regionCodes: ['VIC'],
  territoryCodes: [],
};

const localBde: AuthenticatedPrincipal = {
  id: 'a3',
  email: 'bde@yopmail.com',
  role: 'LOCAL_BDE',
  kind: 'admin',
  regionCodes: ['VIC'],
  territoryCodes: ['MEL'],
};

const user: AuthenticatedPrincipal = {
  id: 'u1',
  email: 'user@yopmail.com',
  role: 'SENDER',
  kind: 'user',
  regionCodes: [],
  territoryCodes: [],
};

describe('ScopeService leftovers', () => {
  const scope = new ScopeService();

  it('assertAdmin rejects non-admin', () => {
    expect(() => scope.assertAdmin(user)).toThrow(ForbiddenException);
  });

  it('allowedTerritoryCodes unrestricted for Super and State', () => {
    expect(scope.allowedTerritoryCodes(superAdmin)).toBeNull();
    expect(scope.allowedTerritoryCodes(stateMaster)).toBeNull();
  });

  it('assertTerritoryAccess denies outside local BDE scope', () => {
    expect(() => scope.assertTerritoryAccess(localBde, 'SYD')).toThrow(
      ForbiddenException,
    );
  });
});
