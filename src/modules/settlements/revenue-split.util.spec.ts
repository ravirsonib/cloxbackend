import {
  absoluteAdminToCloxPool,
  allocateCents,
  allocateTwoStage,
  applySenderPlatformFee,
  assertAdminPool,
  assertNationalPayload,
  CARRIER_PERCENT_FIXED,
  effectiveCarrierPercent,
  maxCarrierBonusPercent,
  normalizeAdminPoolShares,
} from './revenue-split.types';

describe('revenue-split.types', () => {
  it('assertAdminPool accepts legacy sum-30 and pool-relative sum-100', () => {
    expect(() =>
      assertAdminPool({ superPercent: 15, statePercent: 10, localPercent: 5 }),
    ).not.toThrow();
    expect(() =>
      assertAdminPool({ superPercent: 50, statePercent: 30, localPercent: 20 }),
    ).not.toThrow();
    expect(() =>
      assertAdminPool({ superPercent: 20, statePercent: 10, localPercent: 5 }),
    ).toThrow(/sum to 30/);

    expect(() =>
      assertAdminPool({
        superPercent: 25,
        statePercent: 10,
        localPercent: 5,
        carrierPercent: 60,
      }),
    ).not.toThrow();
    expect(() =>
      assertAdminPool({
        superPercent: 20,
        statePercent: 10,
        localPercent: 5,
        carrierPercent: 60,
      }),
    ).toThrow(/sum to 40/);
  });

  it('assertNationalPayload supports dynamic carrier percent and requires sum 100', () => {
    expect(
      assertNationalPayload({
        carrierPercent: 70,
        superPercent: 12,
        statePercent: 10,
        localPercent: 8,
      }),
    ).toMatchObject({
      carrierPercent: 70,
      superPercent: 12,
      statePercent: 10,
      localPercent: 8,
    });

    expect(
      assertNationalPayload({
        carrierPercent: 65,
        superPercent: 18,
        statePercent: 10,
        localPercent: 7,
      }),
    ).toMatchObject({
      carrierPercent: 65,
      superPercent: 18,
      statePercent: 10,
      localPercent: 7,
    });

    expect(
      assertNationalPayload({
        superPercent: 15,
        statePercent: 10,
        localPercent: 5,
      }),
    ).toMatchObject({
      carrierPercent: 70,
      superPercent: 15,
      statePercent: 10,
      localPercent: 5,
      // Proportional pool from 15/10/5 absolute
      cloxSuperPercent: 50,
      cloxStatePercent: 33,
      cloxLocalPercent: 17,
    });

    expect(() =>
      assertNationalPayload({
        carrierPercent: 65,
        superPercent: 15,
        statePercent: 10,
        localPercent: 5,
      }),
    ).toThrow(/Total revenue split must equal 100%/);
  });

  it('assertNationalPayload accepts CLOX pool-relative input', () => {
    const n = assertNationalPayload({
      carrierPercent: 70,
      cloxSuperPercent: 50,
      cloxStatePercent: 30,
      cloxLocalPercent: 20,
    });
    expect(n).toMatchObject({
      carrierPercent: 70,
      superPercent: 15,
      statePercent: 9,
      localPercent: 6,
      cloxSuperPercent: 50,
      cloxStatePercent: 30,
      cloxLocalPercent: 20,
    });
    // 15+9+6 = 30; local absorbs rounding from cloxPoolToGrossAdmin
    expect(n.superPercent + n.statePercent + n.localPercent).toBe(30);
  });

  it('allocateCents sums to gross with remainder on local', () => {
    const gross = 10001;
    const parts = allocateCents(gross, {
      carrierPercent: 70,
      superPercent: 15,
      statePercent: 10,
      localPercent: 5,
    });
    expect(parts.carrier + parts.superShare + parts.stateShare + parts.localShare).toBe(
      gross,
    );
  });

  it('allocateTwoStage: exclusive fee gross 10200 at 70/30 pool 50/30/20', () => {
    const gross = 10200;
    const parts = allocateTwoStage(gross, 70, {
      cloxSuperPercent: 50,
      cloxStatePercent: 30,
      cloxLocalPercent: 20,
    });
    expect(parts.carrier + parts.superShare + parts.stateShare + parts.localShare).toBe(gross);
    expect(parts.carrier).toBe(7140);
    expect(parts.cloxPoolPercent).toBe(30);
    expect(parts.superShare + parts.stateShare + parts.localShare).toBe(3060);
  });

  it('allocateTwoStage with carrier uplift 80/20 keeps pool mix', () => {
    const parts = allocateTwoStage(10000, 80, {
      cloxSuperPercent: 50,
      cloxStatePercent: 30,
      cloxLocalPercent: 20,
    });
    expect(parts.carrier).toBe(8000);
    expect(parts.superShare).toBe(1000);
    expect(parts.stateShare).toBe(600);
    expect(parts.localShare).toBe(400);
  });

  it('applySenderPlatformFee exclusive and inclusive', () => {
    expect(
      applySenderPlatformFee({ baseIncGstCents: 10000, feePercent: 2, mode: 'EXCLUSIVE' }),
    ).toEqual({
      baseIncGstCents: 10000,
      feeIncGstCents: 200,
      chargeIncGstCents: 10200,
      feePercent: 2,
      mode: 'EXCLUSIVE',
    });
    expect(
      applySenderPlatformFee({ baseIncGstCents: 10000, feePercent: 2, mode: 'INCLUSIVE' }),
    ).toEqual({
      baseIncGstCents: 10000,
      feeIncGstCents: 200,
      chargeIncGstCents: 10000,
      feePercent: 2,
      mode: 'INCLUSIVE',
    });
  });

  it('effectiveCarrierPercent caps by minPlatformPercent', () => {
    expect(
      effectiveCarrierPercent({
        nationalCarrierPercent: 70,
        bonusPercent: 10,
        minPlatformPercent: 10,
      }),
    ).toBe(80);
    expect(
      effectiveCarrierPercent({
        nationalCarrierPercent: 70,
        bonusPercent: 25,
        minPlatformPercent: 10,
      }),
    ).toBe(90);
  });

  it('maxCarrierBonusPercent follows national + min CLOX (not fixed 0–30)', () => {
    expect(
      maxCarrierBonusPercent({
        nationalCarrierPercent: 70,
        minPlatformPercent: 10,
      }),
    ).toBe(20);
    expect(
      maxCarrierBonusPercent({
        nationalCarrierPercent: 50,
        minPlatformPercent: 10,
      }),
    ).toBe(40);
    expect(
      maxCarrierBonusPercent({
        nationalCarrierPercent: 90,
        minPlatformPercent: 10,
      }),
    ).toBe(0);
  });

  it('normalizeAdminPoolShares converts legacy absolute to pool %', () => {
    // 15/10/5 of gross → proportional pool (rounding: 50/33/17)
    expect(normalizeAdminPoolShares({ superPercent: 15, statePercent: 10, localPercent: 5 })).toEqual(
      {
        cloxSuperPercent: 50,
        cloxStatePercent: 33,
        cloxLocalPercent: 17,
      },
    );
    expect(absoluteAdminToCloxPool({ superPercent: 50, statePercent: 30, localPercent: 20 })).toEqual(
      {
        cloxSuperPercent: 50,
        cloxStatePercent: 30,
        cloxLocalPercent: 20,
      },
    );
  });

  it('CARRIER_PERCENT_FIXED remains 70 for defaults', () => {
    expect(CARRIER_PERCENT_FIXED).toBe(70);
  });

  describe('Wave 6 regression matrix', () => {
    const pool503020 = {
      cloxSuperPercent: 50,
      cloxStatePercent: 30,
      cloxLocalPercent: 20,
    };

    it('fee 0 + national 70 + pool 50/30/20 → carrier 70%; CLOX 15/9/6 of gross', () => {
      const parts = allocateTwoStage(10000, 70, pool503020);
      expect(parts.carrier).toBe(7000);
      expect(parts.superShare).toBe(1500);
      expect(parts.stateShare).toBe(900);
      expect(parts.localShare).toBe(600);
      expect(
        parts.carrier + parts.superShare + parts.stateShare + parts.localShare,
      ).toBe(10000);
    });

    it('exclusive 2% on $100 → charge 10200; split sums to 10200', () => {
      const fee = applySenderPlatformFee({
        baseIncGstCents: 10000,
        feePercent: 2,
        mode: 'EXCLUSIVE',
      });
      expect(fee.chargeIncGstCents).toBe(10200);
      const parts = allocateTwoStage(fee.chargeIncGstCents, 70, pool503020);
      expect(
        parts.carrier + parts.superShare + parts.stateShare + parts.localShare,
      ).toBe(10200);
      expect(parts.carrier).toBe(7140);
    });

    it('inclusive 2% on $100 → charge 10000; fee disclosure 200', () => {
      const fee = applySenderPlatformFee({
        baseIncGstCents: 10000,
        feePercent: 2,
        mode: 'INCLUSIVE',
      });
      expect(fee.chargeIncGstCents).toBe(10000);
      expect(fee.feeIncGstCents).toBe(200);
      const parts = allocateTwoStage(fee.chargeIncGstCents, 70, pool503020);
      expect(
        parts.carrier + parts.superShare + parts.stateShare + parts.localShare,
      ).toBe(10000);
    });

    it('carrier uplift +10 → 80/20 with pool mix on CLOX', () => {
      const effective = effectiveCarrierPercent({
        nationalCarrierPercent: 70,
        bonusPercent: 10,
        minPlatformPercent: 10,
      });
      expect(effective).toBe(80);
      const parts = allocateTwoStage(10000, effective, pool503020);
      expect(parts.carrier).toBe(8000);
      expect(parts.superShare + parts.stateShare + parts.localShare).toBe(2000);
    });

    it('uplift capped by minPlatform 10', () => {
      expect(
        effectiveCarrierPercent({
          nationalCarrierPercent: 70,
          bonusPercent: 25,
          minPlatformPercent: 10,
        }),
      ).toBe(90);
    });

    it('admin package pool mix does not change carrier %', () => {
      const carrier = 70;
      const packagePool = normalizeAdminPoolShares({
        superPercent: 40,
        statePercent: 40,
        localPercent: 20,
      });
      expect(packagePool.cloxSuperPercent + packagePool.cloxStatePercent + packagePool.cloxLocalPercent).toBe(
        100,
      );
      const parts = allocateTwoStage(10000, carrier, packagePool);
      expect(parts.grossPercents.carrierPercent).toBe(70);
      expect(parts.carrier).toBe(7000);
    });

    it('legacy absolute package 15/10/5 still allocates near historical gross shares', () => {
      const pool = normalizeAdminPoolShares({
        superPercent: 15,
        statePercent: 10,
        localPercent: 5,
      });
      const parts = allocateTwoStage(10000, 70, pool);
      expect(parts.carrier).toBe(7000);
      // 50/33/17 of 3000 → 1500 / 990 / 510
      expect(parts.superShare).toBe(1500);
      expect(parts.stateShare).toBe(990);
      expect(parts.localShare).toBe(510);
    });
  });
});
