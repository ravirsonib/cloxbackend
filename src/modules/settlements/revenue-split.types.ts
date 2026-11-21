export const REVENUE_SPLIT_POLICY_KEY = 'revenue_split.v1' as const;

export const CARRIER_PERCENT_DEFAULT = 70;
/** @deprecated Use CARRIER_PERCENT_DEFAULT or dynamic carrierPercent from policy. Kept for backward compatibility. */
export const CARRIER_PERCENT_FIXED = 70;
export const PLATFORM_PERCENT_FIXED = 30;
export const MIN_PLATFORM_PERCENT_DEFAULT = 10;
/** Default CLOX internal mix (of platform pool). At carrier 70 → gross ≈ 15 / 9 / 6. */
export const DEFAULT_CLOX_POOL: CloxPoolPercents = {
  cloxSuperPercent: 50,
  cloxStatePercent: 30,
  cloxLocalPercent: 20,
};

export type SenderPlatformFeeMode = 'EXCLUSIVE' | 'INCLUSIVE';

export type CloxPoolPercents = {
  cloxSuperPercent: number;
  cloxStatePercent: number;
  cloxLocalPercent: number;
};

/** Gross-share percents (carrier + admin legs of gross = 100). */
export type RevenueSplitPercents = {
  carrierPercent: number;
  superPercent: number;
  statePercent: number;
  localPercent: number;
};

export type RevenueSplitPolicyPayload = RevenueSplitPercents &
  Partial<CloxPoolPercents> & {
    effectiveFrom?: string;
    notes?: string;
  };

export type SenderFeeApplyResult = {
  baseIncGstCents: number;
  feeIncGstCents: number;
  chargeIncGstCents: number;
  feePercent: number;
  mode: SenderPlatformFeeMode;
};

export type TwoStageAllocateResult = {
  carrier: number;
  superShare: number;
  stateShare: number;
  localShare: number;
  /** Gross-share percents implied by amounts (for SettlementLine.sharePercent). */
  grossPercents: RevenueSplitPercents;
  cloxPool: CloxPoolPercents;
  cloxPoolPercent: number;
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
  cloxPool: CloxPoolPercents;
  cloxPoolPercent: number;
  policyVersionId: string | null;
  /** Legacy seat override id (historical accruals only). */
  overrideId: string | null;
  /** Per-admin package used for this accrual (null = national default). */
  adminPackageId: string | null;
  carrierUpliftId: string | null;
  carrierBonusPercent: number;
  /** Sender onboarder when package/local payee attributed to referrer. */
  referredByAdminUserId: string | null;
  lines: ResolvedSettlementBucket[];
};

export function assertCloxPool(pool: CloxPoolPercents): CloxPoolPercents {
  const { cloxSuperPercent, cloxStatePercent, cloxLocalPercent } = pool;
  if (
    ![cloxSuperPercent, cloxStatePercent, cloxLocalPercent].every(
      (n) => Number.isInteger(n) && n >= 0 && n <= 100,
    )
  ) {
    throw new Error('CLOX pool percents must be integers between 0 and 100');
  }
  const total = cloxSuperPercent + cloxStatePercent + cloxLocalPercent;
  if (total !== 100) {
    throw new Error(
      `CLOX pool shares must sum to 100 (got ${cloxSuperPercent}+${cloxStatePercent}+${cloxLocalPercent}=${total})`,
    );
  }
  return pool;
}

/** Convert absolute % of gross admin shares into % of CLOX pool (sum 100). */
export function absoluteAdminToCloxPool(input: {
  superPercent: number;
  statePercent: number;
  localPercent: number;
}): CloxPoolPercents {
  const sum = input.superPercent + input.statePercent + input.localPercent;
  if (sum === 100) {
    return assertCloxPool({
      cloxSuperPercent: input.superPercent,
      cloxStatePercent: input.statePercent,
      cloxLocalPercent: input.localPercent,
    });
  }
  if (sum <= 0) {
    return { ...DEFAULT_CLOX_POOL };
  }
  const cloxSuperPercent = Math.round((input.superPercent * 100) / sum);
  const cloxStatePercent = Math.round((input.statePercent * 100) / sum);
  const cloxLocalPercent = 100 - cloxSuperPercent - cloxStatePercent;
  return assertCloxPool({ cloxSuperPercent, cloxStatePercent, cloxLocalPercent });
}

/** Gross admin shares from carrier % + CLOX pool mix. */
export function cloxPoolToGrossAdmin(
  carrierPercent: number,
  pool: CloxPoolPercents,
): Pick<RevenueSplitPercents, 'superPercent' | 'statePercent' | 'localPercent'> {
  const clox = 100 - carrierPercent;
  const superPercent = Math.round((clox * pool.cloxSuperPercent) / 100);
  const statePercent = Math.round((clox * pool.cloxStatePercent) / 100);
  const localPercent = clox - superPercent - statePercent;
  return { superPercent, statePercent, localPercent };
}

/**
 * Normalize package/override shares to CLOX pool %.
 * - sum 100 → already pool-relative
 * - otherwise treat as legacy absolute % of gross
 */
export function normalizeAdminPoolShares(input: {
  superPercent: number;
  statePercent: number;
  localPercent: number;
}): CloxPoolPercents {
  return absoluteAdminToCloxPool(input);
}

/**
 * @deprecated Prefer assertCloxPool + carrierPercent. Kept for legacy absolute admin pool checks.
 * When carrierPercent omitted, expects admin legs to sum to PLATFORM_PERCENT_FIXED (30).
 */
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
  const sum = superPercent + statePercent + localPercent;
  // New shape: pool-relative sum 100
  if (sum === 100) return;
  const expectedPool = carrierPercent != null ? 100 - carrierPercent : PLATFORM_PERCENT_FIXED;
  if (sum !== expectedPool) {
    throw new Error(`Admin shares must sum to ${expectedPool} (got ${sum})`);
  }
}

export function assertNationalPayload(
  payload: Partial<RevenueSplitPolicyPayload>,
): RevenueSplitPercents & CloxPoolPercents {
  const carrierPercent = payload.carrierPercent ?? CARRIER_PERCENT_DEFAULT;

  if (!Number.isInteger(carrierPercent) || carrierPercent <= 0 || carrierPercent >= 100) {
    throw new Error('carrierPercent must be an integer between 1 and 99');
  }

  let pool: CloxPoolPercents;
  if (
    payload.cloxSuperPercent != null &&
    payload.cloxStatePercent != null &&
    payload.cloxLocalPercent != null
  ) {
    pool = assertCloxPool({
      cloxSuperPercent: payload.cloxSuperPercent,
      cloxStatePercent: payload.cloxStatePercent,
      cloxLocalPercent: payload.cloxLocalPercent,
    });
  } else if (
    payload.superPercent != null &&
    payload.statePercent != null &&
    payload.localPercent != null
  ) {
    const total =
      carrierPercent + payload.superPercent + payload.statePercent + payload.localPercent;
    if (total !== 100) {
      throw new Error(
        `Total revenue split must equal 100% (carrier ${carrierPercent} + super ${payload.superPercent} + state ${payload.statePercent} + local ${payload.localPercent} = ${total}%)`,
      );
    }
    pool = absoluteAdminToCloxPool({
      superPercent: payload.superPercent,
      statePercent: payload.statePercent,
      localPercent: payload.localPercent,
    });
  } else {
    pool = { ...DEFAULT_CLOX_POOL };
  }

  const grossAdmin = cloxPoolToGrossAdmin(carrierPercent, pool);
  return {
    carrierPercent,
    ...grossAdmin,
    ...pool,
  };
}

/** Build v2 policy payload (writes both gross legs and pool-relative for dual readers). */
export function toPolicyPayload(
  percents: RevenueSplitPercents & CloxPoolPercents,
  extra?: { effectiveFrom?: string; notes?: string },
): RevenueSplitPolicyPayload {
  return {
    carrierPercent: percents.carrierPercent,
    superPercent: percents.superPercent,
    statePercent: percents.statePercent,
    localPercent: percents.localPercent,
    cloxSuperPercent: percents.cloxSuperPercent,
    cloxStatePercent: percents.cloxStatePercent,
    cloxLocalPercent: percents.cloxLocalPercent,
    ...extra,
  };
}

/** Max bonus points allowed so effective carrier keeps CLOX ≥ minPlatformPercent. */
export function maxCarrierBonusPercent(input: {
  nationalCarrierPercent: number;
  minPlatformPercent?: number;
}): number {
  const minPlatform = Math.max(
    0,
    Math.min(99, input.minPlatformPercent ?? MIN_PLATFORM_PERCENT_DEFAULT),
  );
  const maxCarrier = 100 - minPlatform;
  return Math.max(0, maxCarrier - input.nationalCarrierPercent);
}

export function effectiveCarrierPercent(input: {
  nationalCarrierPercent: number;
  bonusPercent?: number;
  minPlatformPercent?: number;
}): number {
  const minPlatform = input.minPlatformPercent ?? MIN_PLATFORM_PERCENT_DEFAULT;
  const bonus = Math.max(0, input.bonusPercent ?? 0);
  const maxCarrier = 100 - Math.max(0, Math.min(99, minPlatform));
  return Math.min(maxCarrier, input.nationalCarrierPercent + bonus);
}

export function applySenderPlatformFee(input: {
  baseIncGstCents: number;
  feePercent: number;
  mode: SenderPlatformFeeMode;
}): SenderFeeApplyResult {
  const baseIncGstCents = Math.max(0, Math.trunc(input.baseIncGstCents));
  const feePercent = Math.max(0, Math.min(30, Math.trunc(input.feePercent)));
  const mode = input.mode === 'INCLUSIVE' ? 'INCLUSIVE' : 'EXCLUSIVE';

  if (feePercent === 0 || baseIncGstCents === 0) {
    return {
      baseIncGstCents,
      feeIncGstCents: 0,
      chargeIncGstCents: baseIncGstCents,
      feePercent,
      mode,
    };
  }

  if (mode === 'INCLUSIVE') {
    const feeIncGstCents = Math.round((baseIncGstCents * feePercent) / 100);
    return {
      baseIncGstCents,
      feeIncGstCents,
      chargeIncGstCents: baseIncGstCents,
      feePercent,
      mode,
    };
  }

  const feeIncGstCents = Math.round((baseIncGstCents * feePercent) / 100);
  return {
    baseIncGstCents,
    feeIncGstCents,
    chargeIncGstCents: baseIncGstCents + feeIncGstCents,
    feePercent,
    mode,
  };
}

function finiteInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

/** Same carrier line as {@link allocateTwoStage} — single formula for bid UX ↔ ledger. */
export function carrierShareOfSettlementGrossCents(
  settlementGrossIncGstCents: number,
  carrierPercent: number,
): number {
  const gross = Math.max(0, finiteInt(settlementGrossIncGstCents, 0));
  const pct = Math.max(1, Math.min(99, finiteInt(carrierPercent, 70)));
  return Math.round((gross * pct) / 100);
}

/**
 * Carrier take-home after sender fee is applied to the proposal base
 * (exclusive fee increases settlement gross; inclusive does not).
 */
export function expectedCarrierNetFromProposalBase(input: {
  baseIncGstCents: number;
  carrierPercent: number;
  feePercent: number;
  feeMode: SenderPlatformFeeMode;
}): number {
  const fee = applySenderPlatformFee({
    baseIncGstCents: Math.max(0, finiteInt(input.baseIncGstCents, 0)),
    feePercent: Math.max(0, Math.min(30, finiteInt(input.feePercent, 0))),
    mode: input.feeMode,
  });
  return carrierShareOfSettlementGrossCents(
    fee.chargeIncGstCents,
    finiteInt(input.carrierPercent, 70),
  );
}

function settlementGrossForTargetNet(targetNet: number, carrierPercent: number): number {
  const pct = Math.max(1, Math.min(99, finiteInt(carrierPercent, 70)));
  const net = Math.max(1, finiteInt(targetNet, 1));
  let gross = Math.round((net * 100) / pct);
  if (!Number.isFinite(gross) || gross < 1) gross = 1;
  // Guarantee ledger net >= target (never under-pay the typed take-home).
  let guard = 0;
  while (carrierShareOfSettlementGrossCents(gross, pct) < net && guard++ < 10_000) {
    gross += 1;
  }
  guard = 0;
  while (
    gross > 1 &&
    carrierShareOfSettlementGrossCents(gross - 1, pct) >= net &&
    guard++ < 10_000
  ) {
    gross -= 1;
  }
  return gross;
}

function proposalBaseForExclusiveCharge(
  targetChargeIncGstCents: number,
  feePercent: number,
): number {
  const fee = Math.max(0, Math.min(30, Math.trunc(feePercent)));
  if (fee <= 0) return targetChargeIncGstCents;
  let base = Math.round((targetChargeIncGstCents * 100) / (100 + fee));
  // Nudge so exclusive charge matches (or clears) the target settlement gross.
  let guard = 0;
  while (
    applySenderPlatformFee({
      baseIncGstCents: base,
      feePercent: fee,
      mode: 'EXCLUSIVE',
    }).chargeIncGstCents < targetChargeIncGstCents &&
    guard++ < 10_000
  ) {
    base += 1;
  }
  guard = 0;
  while (
    base > 1 &&
    applySenderPlatformFee({
      baseIncGstCents: base - 1,
      feePercent: fee,
      mode: 'EXCLUSIVE',
    }).chargeIncGstCents >= targetChargeIncGstCents &&
    guard++ < 10_000
  ) {
    base -= 1;
  }
  return base;
}

export type ProposalBaseFromCarrierNetResult = {
  /** Stored on Proposal.amountIncGstCents (freight base before exclusive top-up). */
  baseIncGstCents: number;
  settlementGrossIncGstCents: number;
  /** Ledger carrier share after fee — matches what the carrier typed when possible. */
  netIncGstCents: number;
  feePercent: number;
  feeMode: SenderPlatformFeeMode;
};

/**
 * Convert carrier typed take-home → proposal base so settlement (fee then split)
 * pays them that net. See P7 / exclusive fee examples in revenue-split plan.
 */
export function proposalBaseFromTargetCarrierNet(input: {
  targetNetIncGstCents: number;
  carrierPercent: number;
  feePercent: number;
  feeMode: SenderPlatformFeeMode;
}): ProposalBaseFromCarrierNetResult {
  const feePercent = Math.max(0, Math.min(30, finiteInt(input.feePercent, 0)));
  const feeMode: SenderPlatformFeeMode =
    input.feeMode === 'INCLUSIVE' ? 'INCLUSIVE' : 'EXCLUSIVE';
  const carrierPercent = Math.max(1, Math.min(99, finiteInt(input.carrierPercent, 70)));
  const rawTarget = finiteInt(input.targetNetIncGstCents, 0);
  if (rawTarget <= 0) {
    // NaN / 0 / negative — refuse to invent a phantom bid; caller must validate.
    return {
      baseIncGstCents: 0,
      settlementGrossIncGstCents: 0,
      netIncGstCents: 0,
      feePercent,
      feeMode,
    };
  }
  const targetNet = rawTarget;

  const settlementGross = settlementGrossForTargetNet(targetNet, carrierPercent);
  const baseIncGstCents =
    feeMode === 'EXCLUSIVE' && feePercent > 0
      ? proposalBaseForExclusiveCharge(settlementGross, feePercent)
      : settlementGross;

  // Final nudge on base so expected net >= target (cent rounding / fee invert).
  let base = Math.max(0, finiteInt(baseIncGstCents, 0));
  let guard = 0;
  while (
    expectedCarrierNetFromProposalBase({
      baseIncGstCents: base,
      carrierPercent,
      feePercent,
      feeMode,
    }) < targetNet &&
    guard++ < 10_000
  ) {
    base += 1;
  }

  const fee = applySenderPlatformFee({
    baseIncGstCents: base,
    feePercent,
    mode: feeMode,
  });
  return {
    baseIncGstCents: base,
    settlementGrossIncGstCents: fee.chargeIncGstCents,
    netIncGstCents: carrierShareOfSettlementGrossCents(
      fee.chargeIncGstCents,
      carrierPercent,
    ),
    feePercent,
    feeMode,
  };
}

/**
 * Smallest carrier take-home that still stores a proposal base ≥ minBase floor.
 * Prevents “UI shows min net, submit rejects” rounding conflicts.
 */
export function minCarrierNetClearingProposalBase(input: {
  minBaseIncGstCents: number;
  carrierPercent: number;
  feePercent: number;
  feeMode: SenderPlatformFeeMode;
}): number {
  const minBase = Math.max(0, finiteInt(input.minBaseIncGstCents, 0));
  if (minBase <= 0) return 1;
  let net = expectedCarrierNetFromProposalBase({
    baseIncGstCents: minBase,
    carrierPercent: finiteInt(input.carrierPercent, 70),
    feePercent: finiteInt(input.feePercent, 0),
    feeMode: input.feeMode,
  });
  if (!Number.isFinite(net) || net < 1) net = 1;
  let guard = 0;
  while (
    proposalBaseFromTargetCarrierNet({
      targetNetIncGstCents: net,
      carrierPercent: input.carrierPercent,
      feePercent: input.feePercent,
      feeMode: input.feeMode,
    }).baseIncGstCents < minBase &&
    guard++ < 10_000
  ) {
    net += 1;
  }
  return net;
}

/**
 * Two-stage allocate: Carrier | CLOX, then CLOX by pool %.
 * Local absorbs remainder inside the CLOX pool so sum(amounts) === gross.
 */
export function allocateTwoStage(
  grossIncGstCents: number,
  effectiveCarrier: number,
  pool: CloxPoolPercents,
): TwoStageAllocateResult {
  assertCloxPool(pool);
  const carrierPercent = Math.max(1, Math.min(99, Math.trunc(effectiveCarrier)));
  const cloxPoolPercent = 100 - carrierPercent;

  const carrier = Math.round((grossIncGstCents * carrierPercent) / 100);
  const cloxCents = grossIncGstCents - carrier;

  const superShare = Math.round((cloxCents * pool.cloxSuperPercent) / 100);
  const stateShare = Math.round((cloxCents * pool.cloxStatePercent) / 100);
  const localShare = cloxCents - superShare - stateShare;

  const grossAdmin = cloxPoolToGrossAdmin(carrierPercent, pool);

  return {
    carrier,
    superShare,
    stateShare,
    localShare,
    grossPercents: {
      carrierPercent,
      ...grossAdmin,
    },
    cloxPool: pool,
    cloxPoolPercent,
  };
}

/** Split gross cents using gross-share percents; last line absorbs remainder. */
export function allocateCents(
  grossIncGstCents: number,
  percents: RevenueSplitPercents,
): { carrier: number; superShare: number; stateShare: number; localShare: number } {
  const pool = absoluteAdminToCloxPool({
    superPercent: percents.superPercent,
    statePercent: percents.statePercent,
    localPercent: percents.localPercent,
  });
  const staged = allocateTwoStage(grossIncGstCents, percents.carrierPercent, pool);
  return {
    carrier: staged.carrier,
    superShare: staged.superShare,
    stateShare: staged.stateShare,
    localShare: staged.localShare,
  };
}
