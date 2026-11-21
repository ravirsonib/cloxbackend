import {
  aggregateUnitPills,
  assertUnitsComplete,
  defaultCombinationConfigForClass,
  pillForUnitRwc,
  requiredUnitsForVehicle,
} from './vehicle-units.util';

describe('vehicle-units.util', () => {
  describe('defaultCombinationConfigForClass', () => {
    it('maps SEMI and CONTAINER to SEMI', () => {
      expect(defaultCombinationConfigForClass('SEMI')).toBe('SEMI');
      expect(defaultCombinationConfigForClass('CONTAINER')).toBe('SEMI');
    });
    it('maps BDOUBLE and ROAD_TRAIN', () => {
      expect(defaultCombinationConfigForClass('BDOUBLE')).toBe('BDOUBLE');
      expect(defaultCombinationConfigForClass('ROAD_TRAIN')).toBe('RT_DOUBLE');
    });
    it('maps single-unit classes to NONE', () => {
      expect(defaultCombinationConfigForClass('UTE')).toBe('NONE');
      expect(defaultCombinationConfigForClass('RIGID_1_2T')).toBe('NONE');
      expect(defaultCombinationConfigForClass(null)).toBe('NONE');
    });
  });

  describe('requiredUnitsForVehicle', () => {
    it('returns POWERED only for single-unit', () => {
      expect(requiredUnitsForVehicle('UTE')).toEqual(['POWERED']);
      expect(requiredUnitsForVehicle('VAN', 'NONE')).toEqual(['POWERED']);
    });
    it('returns 2 units for SEMI / CONTAINER', () => {
      expect(requiredUnitsForVehicle('SEMI')).toEqual(['POWERED', 'TRAILER_1']);
      expect(requiredUnitsForVehicle('CONTAINER')).toEqual(['POWERED', 'TRAILER_1']);
    });
    it('returns 3 units for BDOUBLE', () => {
      expect(requiredUnitsForVehicle('BDOUBLE')).toEqual([
        'POWERED',
        'TRAILER_1',
        'TRAILER_2',
      ]);
    });
    it('returns 3 or 4 for ROAD_TRAIN via combinationConfig', () => {
      expect(requiredUnitsForVehicle('ROAD_TRAIN', 'RT_DOUBLE')).toEqual([
        'POWERED',
        'TRAILER_1',
        'TRAILER_2',
      ]);
      expect(requiredUnitsForVehicle('ROAD_TRAIN', 'RT_TRIPLE')).toEqual([
        'POWERED',
        'TRAILER_1',
        'TRAILER_2',
        'TRAILER_3',
      ]);
      expect(requiredUnitsForVehicle('ROAD_TRAIN')).toEqual([
        'POWERED',
        'TRAILER_1',
        'TRAILER_2',
      ]);
    });
  });

  describe('assertUnitsComplete', () => {
    const now = new Date('2026-06-15T00:00:00Z');
    const future = new Date('2027-01-01T00:00:00Z');
    const past = new Date('2025-01-01T00:00:00Z');

    it('blocks SEMI with only powered RWC', () => {
      const result = assertUnitsComplete(
        'SEMI',
        'SEMI',
        [
          {
            role: 'POWERED',
            registration: 'ABC123',
            rwc: { status: 'APPROVED', expiresAt: future },
          },
        ],
        now,
      );
      expect(result.ok).toBe(false);
      expect(result.missingRoles).toContain('TRAILER_1');
    });

    it('requires three BDOUBLE units with rego + RWC', () => {
      const incomplete = assertUnitsComplete(
        'BDOUBLE',
        'BDOUBLE',
        [
          {
            role: 'POWERED',
            registration: 'PM1',
            rwc: { status: 'APPROVED', expiresAt: future },
          },
          {
            role: 'TRAILER_1',
            registration: 'T1',
            rwc: { status: 'APPROVED', expiresAt: future },
          },
          { role: 'TRAILER_2', registration: 'T2', rwc: null },
        ],
        now,
      );
      expect(incomplete.ok).toBe(false);
      expect(incomplete.missingRwc).toContain('TRAILER_2');

      const complete = assertUnitsComplete(
        'BDOUBLE',
        'BDOUBLE',
        [
          {
            role: 'POWERED',
            registration: 'PM1',
            rwc: { status: 'UPLOADED', expiresAt: future },
          },
          {
            role: 'TRAILER_1',
            registration: 'T1',
            rwc: { status: 'UNDER_REVIEW', expiresAt: future },
          },
          {
            role: 'TRAILER_2',
            registration: 'T2',
            rwc: { status: 'APPROVED', expiresAt: future },
          },
        ],
        now,
      );
      expect(complete.ok).toBe(true);
    });

    it('treats expired trailer RWC as not complete', () => {
      const result = assertUnitsComplete(
        'SEMI',
        'SEMI',
        [
          {
            role: 'POWERED',
            registration: 'PM1',
            rwc: { status: 'APPROVED', expiresAt: future },
          },
          {
            role: 'TRAILER_1',
            registration: 'TRL1',
            rwc: { status: 'APPROVED', expiresAt: past },
          },
        ],
        now,
      );
      expect(result.ok).toBe(false);
      expect(result.expiredRwc).toContain('TRAILER_1');
    });

    it('passes single-unit with one RWC', () => {
      const result = assertUnitsComplete(
        'UTE',
        'NONE',
        [
          {
            role: 'POWERED',
            registration: 'UTE99',
            rwc: { status: 'APPROVED', expiresAt: future },
          },
        ],
        now,
      );
      expect(result.ok).toBe(true);
    });
  });

  describe('pill aggregation', () => {
    it('worst unit wins', () => {
      expect(aggregateUnitPills(['OK', 'PENDING'])).toBe('PENDING');
      expect(aggregateUnitPills(['OK', 'EXPIRING', 'PENDING'])).toBe('EXPIRING');
      expect(aggregateUnitPills(['OK', 'EXPIRED'])).toBe('EXPIRED');
      expect(pillForUnitRwc(null)).toBe('MISSING');
      expect(
        pillForUnitRwc(
          { status: 'APPROVED', expiresAt: new Date(Date.now() - 1000) },
          new Date(),
        ),
      ).toBe('EXPIRED');
    });
  });
});
