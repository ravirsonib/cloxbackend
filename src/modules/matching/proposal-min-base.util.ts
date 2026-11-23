/**
 * Effective proposal-base floor (gross inc GST) for board + bid submit.
 * Matches submitProposal order: class/global quote (or rescue discount), then hard floor.
 */
export function resolveProposalMinBaseCents(params: {
  globalFloorCents: number;
  classQuoteIncGstCents: number;
  hardFloorIncGstCents: number | null | undefined;
  estimateIncGstCents: number | null | undefined;
  rescueDiscountPercent: number | null | undefined;
}): number {
  const globalFloor = Math.max(0, Math.trunc(params.globalFloorCents) || 0);
  const classQuote = Math.max(0, Math.trunc(params.classQuoteIncGstCents) || 0);
  let minBase = Math.max(globalFloor, classQuote);

  const discount = Math.max(0, Math.trunc(params.rescueDiscountPercent ?? 0) || 0);
  const estimate = params.estimateIncGstCents;
  if (
    discount > 0 &&
    estimate != null &&
    Number.isFinite(estimate) &&
    estimate > 0
  ) {
    minBase = Math.round((Math.trunc(estimate) * (100 - discount)) / 100);
  }

  const hardFloor = params.hardFloorIncGstCents;
  if (hardFloor != null && Number.isFinite(hardFloor) && hardFloor > 0) {
    minBase = Math.max(minBase, Math.trunc(hardFloor));
  }

  return minBase;
}
