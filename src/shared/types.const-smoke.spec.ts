import {
  ADMIN_ROLES,
  AdminRole,
  AppRole,
  AuditAction,
  ComplianceDocType,
  LeadStatus,
  LeadType,
  Locale,
  PlatformRole,
  isAdminRole,
  provisionAdminSchema,
  jobCreateSchema,
} from './types';

describe('shared/types const + helper smoke', () => {
  it('exposes all const enum values', () => {
    expect(Object.values(LeadType).length).toBeGreaterThan(3);
    expect(Object.values(LeadStatus).length).toBeGreaterThan(5);
    expect(Object.values(AdminRole)).toEqual(
      expect.arrayContaining(['SUPER_ADMIN', 'STATE_MASTER', 'LOCAL_BDE']),
    );
    expect(Object.values(PlatformRole)).toEqual(
      expect.arrayContaining(['SENDER', 'TRANSPORT_COMPANY', 'DRIVER']),
    );
    expect(Object.values(AppRole)).toEqual(
      expect.arrayContaining([...Object.values(AdminRole), ...Object.values(PlatformRole)]),
    );
    expect(ADMIN_ROLES).toHaveLength(3);
    expect(Object.values(Locale)).toEqual(expect.arrayContaining(['en', 'hi', 'pa']));
    expect(Object.values(AuditAction).length).toBeGreaterThan(10);
    expect(Object.values(ComplianceDocType).length).toBeGreaterThan(3);
  });

  it('isAdminRole narrows admin roles only', () => {
    expect(isAdminRole('SUPER_ADMIN')).toBe(true);
    expect(isAdminRole('SENDER')).toBe(false);
  });

  it('provisionAdminSchema requires territory for LOCAL_BDE', () => {
    expect(
      provisionAdminSchema.safeParse({
        email: 'bde@yopmail.com',
        role: 'LOCAL_BDE',
        regionCode: 'VIC',
      }).success,
    ).toBe(false);
    expect(
      provisionAdminSchema.safeParse({
        email: 'bde@yopmail.com',
        role: 'LOCAL_BDE',
        regionCode: 'VIC',
        territoryCode: 'MEL',
      }).success,
    ).toBe(true);
  });

  it('jobCreateSchema rejects empty stops', () => {
    expect(
      jobCreateSchema.safeParse({
        title: 'J',
        pricingModel: 'PER_KM',
        deadWeightKg: 10,
        lengthCm: 10,
        widthCm: 10,
        heightCm: 10,
        distanceKm: 12,
        loadTypes: ['GENERAL'],
        siteDisclaimerAccepted: true,
        receiverName: 'R',
        receiverEmail: 'r@yopmail.com',
        stops: [],
      }).success,
    ).toBe(false);
  });
});
