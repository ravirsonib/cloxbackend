import { createHash } from 'crypto';
import { AbrService } from './abr.service';
import { ComplianceService } from './compliance.service';
import { AppRole } from '../../shared/types';
import type { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';

describe('ComplianceService gates', () => {
  it('denies Local BDE approve via assertCanDecide path', async () => {
    const prisma = {
      isConnected: () => true,
    };
    const audit = { recordPlatform: jest.fn() };
    const scope = {
      assertAdmin: jest.fn(),
      assertRegionAccess: jest.fn(),
      allowedRegionCodes: jest.fn(),
    };
    const abr = { lookupAbn: jest.fn() } as unknown as AbrService;

    const service = new ComplianceService(
      prisma as never,
      audit as never,
      scope as never,
      abr,
    );

    const local: AuthenticatedPrincipal = {
      id: 'local-1',
      email: 'local.mel@yopmail.com',
      role: AppRole.LOCAL_BDE,
      kind: 'admin',
      regionCodes: ['VIC'],
      territoryCodes: ['MEL'],
    };

    await expect(
      service.approve(local, '00000000-0000-4000-8000-000000000099', {}),
    ).rejects.toThrow(/Local BDE|Insufficient/);
  });
});

describe('AbrService', () => {
  it('returns assist-only stub when ABR_GUID missing', async () => {
    const config = {
      get: () => undefined,
    };
    const abr = new AbrService(config as never);
    const result = await abr.lookupAbn('51824753556');
    expect(result.configured).toBe(false);
    expect(result.active).toBeNull();
    expect(result.message).toMatch(/not configured/i);
  });
});

describe('document hash helper', () => {
  it('sha256 hex length is 64', () => {
    const hash = createHash('sha256').update('clox').digest('hex');
    expect(hash).toHaveLength(64);
  });
});
