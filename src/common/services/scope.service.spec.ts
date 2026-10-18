import { ForbiddenException } from '@nestjs/common';
import { ScopeService } from '../services/scope.service';
import { AppRole } from '../../shared/types';
import type { AuthenticatedPrincipal } from '../guards/jwt-auth.guard';

describe('ScopeService', () => {
  const scope = new ScopeService();

  const stateVic: AuthenticatedPrincipal = {
    id: 's1',
    email: 'state@yopmail.com',
    role: AppRole.STATE_MASTER,
    kind: 'admin',
    regionCodes: ['VIC'],
    territoryCodes: [],
  };

  const localMel: AuthenticatedPrincipal = {
    id: 'l1',
    email: 'local@yopmail.com',
    role: AppRole.LOCAL_BDE,
    kind: 'admin',
    regionCodes: ['VIC'],
    territoryCodes: ['MEL'],
  };

  it('blocks State Master from foreign region', () => {
    expect(() => scope.assertRegionAccess(stateVic, 'NSW')).toThrow(ForbiddenException);
  });

  it('allows State Master in own region', () => {
    expect(() => scope.assertRegionAccess(stateVic, 'VIC')).not.toThrow();
  });

  it('blocks Local BDE from foreign territory', () => {
    expect(() => scope.assertTerritoryAccess(localMel, 'GEO')).toThrow(ForbiddenException);
  });

  it('allows Local BDE in own territory', () => {
    expect(() => scope.assertTerritoryAccess(localMel, 'MEL')).not.toThrow();
  });

  it('Super is unrestricted', () => {
    const superAdmin: AuthenticatedPrincipal = {
      id: 'su',
      email: 'super@yopmail.com',
      role: AppRole.SUPER_ADMIN,
      kind: 'admin',
      regionCodes: [],
      territoryCodes: [],
    };
    expect(scope.allowedRegionCodes(superAdmin)).toBeNull();
    expect(() => scope.assertRegionAccess(superAdmin, 'NSW')).not.toThrow();
  });
});
