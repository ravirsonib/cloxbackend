export const REVENUE_SPLIT_POLICY_KEY = 'revenue_split.v1' as const;

export const CARRIER_PERCENT_FIXED = 70;
export const PLATFORM_PERCENT_FIXED = 30;

export type RevenueSplitPercents = {
  carrierPercent: number;
  superPercent: number;
  statePercent: number;
  localPercent: number;
};

export type RevenueSplitPolicyPayload = RevenueSplitPercents & {
  effectiveFrom?: string;
  notes?: string;
};

export type ResolvedSettlementBucket = {
  recipientType: 'CARRIER' | 'SUPER_ADMIN' | 'STATE_MASTER' | 'LOCAL_BDE' | 'HQ_HOLDING';
  sharePercent: number;
  amountCents: number;
  regionId: string | null;
  territoryId: string | null;
  adminUserId: string | null;
  /** Original admin bucket before vacant→HQ remap (for audits). */
  bucket: 'CARRIER' | 'SUPER' | 'STATE' | 'LOCAL';
};

export type ResolvedRevenueSplit = {
  percents: RevenueSplitPercents;
  policyVersionId: string | null;
  /** Legacy seat override id (historical accruals only). */
  overrideId: string | null;
  /** Per-admin package used for this accrual (null = national default). */
  adminPackageId: string | null;
  /** Sender onboarder when package/local payee attributed to referrer. */
  referredByAdminUserId: string | null;
  lines: ResolvedSettlementBucket[];
};

export function assertAdminPool(percents: {
  superPercent: number;
  statePercent: number;
  localPercent: number;
}): void {
  const { superPercent, statePercent, localPercent } = percents;
  if (
    ![superPercent, statePercent, localPercent].every(
      (n) => Number.isInteger(n) && n >= 0 && n <= 30,
    )
  ) {
    throw new Error('Admin share percents must be integers between 0 and 30');
  }
  if (superPercent + statePercent + localPercent !== PLATFORM_PERCENT_FIXED) {
    throw new Error(
      `Admin shares must sum to ${PLATFORM_PERCENT_FIXED} (got ${superPercent + statePercent + localPercent})`,
    );
  }
}

export function assertNationalPayload(payload: RevenueSplitPolicyPayload): RevenueSplitPercents {
  if (payload.carrierPercent !== CARRIER_PERCENT_FIXED) {
    throw new Error(`carrierPercent must be ${CARRIER_PERCENT_FIXED}`);
  }
  assertAdminPool(payload);
  return {
    carrierPercent: CARRIER_PERCENT_FIXED,
    superPercent: payload.superPercent,
    statePercent: payload.statePercent,
    localPercent: payload.localPercent,
  };
}

/** Split gross cents; last line absorbs remainder so sum(amounts) === gross. */
export function allocateCents(
  grossIncGstCents: number,
  percents: RevenueSplitPercents,
): { carrier: number; superShare: number; stateShare: number; localShare: number } {
  const carrier = Math.round((grossIncGstCents * percents.carrierPercent) / 100);
  const superShare = Math.round((grossIncGstCents * percents.superPercent) / 100);
  const stateShare = Math.round((grossIncGstCents * percents.statePercent) / 100);
  const localShare = grossIncGstCents - carrier - superShare - stateShare;
  return { carrier, superShare, stateShare, localShare };
}
