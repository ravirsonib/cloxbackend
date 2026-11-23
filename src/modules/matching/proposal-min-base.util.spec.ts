import { resolveProposalMinBaseCents } from './proposal-min-base.util';

describe('resolveProposalMinBaseCents', () => {
  it('uses max of global floor, class quote, and hard floor', () => {
    expect(
      resolveProposalMinBaseCents({
        globalFloorCents: 20_000,
        classQuoteIncGstCents: 1_894_320,
        hardFloorIncGstCents: 442_008,
        estimateIncGstCents: 1_894_320,
        rescueDiscountPercent: null,
      }),
    ).toBe(1_894_320);
  });

  it('raises to hard floor when quote is below floor', () => {
    expect(
      resolveProposalMinBaseCents({
        globalFloorCents: 20_000,
        classQuoteIncGstCents: 50_000,
        hardFloorIncGstCents: 80_000,
        estimateIncGstCents: 50_000,
        rescueDiscountPercent: 0,
      }),
    ).toBe(80_000);
  });

  it('rescue uses discounted estimate then hard floor', () => {
    expect(
      resolveProposalMinBaseCents({
        globalFloorCents: 20_000,
        classQuoteIncGstCents: 100_000,
        hardFloorIncGstCents: null,
        estimateIncGstCents: 10_000,
        rescueDiscountPercent: 10,
      }),
    ).toBe(9_000);

    expect(
      resolveProposalMinBaseCents({
        globalFloorCents: 20_000,
        classQuoteIncGstCents: 100_000,
        hardFloorIncGstCents: 12_000,
        estimateIncGstCents: 10_000,
        rescueDiscountPercent: 10,
      }),
    ).toBe(12_000);
  });
});
