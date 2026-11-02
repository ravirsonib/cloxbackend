export const REVENUE_SPLIT_POLICY_KEY = 'revenue_split.v1' as const;

export const CARRIER_PERCENT_DEFAULT = 70;
/** @deprecated Use CARRIER_PERCENT_DEFAULT or dynamic carrierPercent from policy. Kept for backward compatibility. */
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
  carrierPercent?: number;
}): void {
  const { superPercent, statePercent, localPercent, carrierPercent } = percents;
  if (
    ![superPercent, statePercent, localPercent].every(
      (n) => Number.isInteger(n) && n >= 0 && n <= 100,
    )
  ) {
    throw new Error('Admin share percents must be integers between 0 and 100');
  }
  const expectedPool = carrierPercent != null ? 100 - carrierPercent : PLATFORM_PERCENT_FIXED;
  if (superPercent + statePercent + localPercent !== expectedPool) {
    throw new Error(
      `Admin shares must sum to ${expectedPool} (got ${superPercent + statePercent + localPercent})`,
    );
  }
}

export function assertNationalPayload(payload: Partial<RevenueSplitPolicyPayload>): RevenueSplitPercents {
  const carrierPercent = payload.carrierPercent ?? CARRIER_PERCENT_DEFAULT;
  const superPercent = payload.superPercent ?? 0;
  const statePercent = payload.statePercent ?? 0;
  const localPercent = payload.localPercent ?? 0;

  if (
    ![carrierPercent, superPercent, statePercent, localPercent].every(
      (n) => Number.isInteger(n) && n >= 0 && n <= 100,
    )
  ) {
    throw new Error('All revenue split percents must be integers between 0 and 100');
  }

  if (carrierPercent <= 0) {
    throw new Error('carrierPercent must be greater than 0');
  }

  const total = carrierPercent + superPercent + statePercent + localPercent;
  if (total !== 100) {
    throw new Error(
      `Total revenue split must equal 100% (carrier ${carrierPercent} + super ${superPercent} + state ${statePercent} + local ${localPercent} = ${total}%)`,
    );
  }

  return {
    carrierPercent,
    superPercent,
    statePercent,
    localPercent,
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
