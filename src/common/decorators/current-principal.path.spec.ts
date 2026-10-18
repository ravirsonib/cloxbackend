import {
  CurrentAdmin,
  CurrentPrincipal,
  extractCurrentPrincipal,
} from './current-admin.decorator';
import type { AuthenticatedPrincipal } from '../guards/jwt-auth.guard';

describe('CurrentPrincipal / CurrentAdmin decorator', () => {
  it('CurrentAdmin aliases CurrentPrincipal', () => {
    expect(CurrentAdmin).toBe(CurrentPrincipal);
  });

  it('extractCurrentPrincipal returns request.user', () => {
    const user: AuthenticatedPrincipal = {
      id: 'u1',
      email: 'sender@yopmail.com',
      role: 'SENDER',
      kind: 'user',
      regionCodes: [],
      territoryCodes: [],
    };
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    };
    expect(extractCurrentPrincipal(undefined, ctx as never)).toEqual(user);
  });
});
