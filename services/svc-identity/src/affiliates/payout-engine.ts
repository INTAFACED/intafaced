/**
 * AFFILIATE / IB PAYOUT ENGINE — Slice C (TRK-ops.affiliates).
 *
 * The tree (referral-tree.ts), the attribution (commission.ts) and the durable
 * accrual rows (accrual-store.ts) already exist. This is the half that moves
 * value: durable accrual rows → ledger postings, fanned out across the tree.
 *
 * IT IS REFUSE-CLOSED ON THE RATE, AND THAT IS THE DELIVERABLE.
 *
 * DIRECTION §8 item 10 reserves `leader_share_bps` "and every other fee-share
 * rate"; item 6 reserves fee and revenue recipes. Affiliate commission tiers
 * are both. So this engine is complete in every part except the number it is
 * not allowed to choose, and it names that gap with a stable code rather than
 * seeding a rate. A seeded rate in source is indistinguishable from a decided
 * one three months later — see the deleted DEFAULT_ACCRUAL_TIERS (10/5/2%) in
 * commission.ts, which is exactly how an invented bps became platform default.
 *
 * §0.6 — NO VALUE MOVES OUTSIDE packages/ledger-client. This file assembles no
 * entries. It calls two existing recipes (`sweepFeesToRewards`, `rewardPay`)
 * and posts them. It adds no recipe and edits none: a new recipe is a
 * DIRECTION §3 owner carve-out.
 */

import {
  formatAmount,
  parseAmount,
  recipes,
  type Amount,
  type LedgerClient,
  type LedgerTx,
  type PostRequest,
} from '@intafaced/ledger-client';

import { AffiliatePayoutRefuseError, AFFILIATE_PAYOUT_RESIDUAL } from './admin-tree-read.js';
import type { AccrualTierLaw } from './commission-rate-law.js';
import { AFFILIATE_FEE_SOURCE_MODULE_RE, DEFAULT_AFFILIATE_FEE_SOURCE_MODULE, decimalMul, type CommissionRow } from './commission.js';
import { DEFAULT_MAX_REFERRAL_DEPTH } from './referral-tree.js';

/**
 * Multi-tier payout depth bound — THE BOUND IS A PARAMETER AND THIS IS ITS ONE
 * NAMED HOME. Not scattered across call sites, and not a magic number inline.
 *
 * Conservative default, aligned with the tree's own write-time depth cap
 * (DEFAULT_MAX_REFERRAL_DEPTH = 5) so payout can never fan out wider than the
 * tree is allowed to be deep. A deeper commissionable chain is a product
 * decision with a money consequence per extra hop, so it is OWNER-RULING
 * PENDING and reported as such on the tracker row — it is not a rate, but it
 * multiplies one.
 */
export const MAX_PAYOUT_TIER_DEPTH = DEFAULT_MAX_REFERRAL_DEPTH;

/**
 * Legacy plan-level default when a row has no sourceModule (pre-migration).
 *
 * Prefer `row.sourceModule` — durable accruals now carry the producer module
 * so a trade fee sweeps houseFees("trade"), not this identity default.
 * Unfunded pool still fails rather than inventing value.
 */
export const AFFILIATE_PAYOUT_SOURCE_MODULE = DEFAULT_AFFILIATE_FEE_SOURCE_MODULE;

/** Ledger `reason` on the beneficiary leg — greppable in reconciliation. */
export const AFFILIATE_PAYOUT_REASON = 'identity.affiliate.commission';

/** One accrual row, priced and keyed, ready to post. */
export type AffiliatePayoutLeg = {
  readonly beneficiaryId: string;
  readonly payerId: string;
  readonly hop: number;
  /** Decimal string — the wire shape. Never a number. */
  readonly commissionAmount: string;
  readonly asset: string;
  /** Fee pool → rewards engine, for exactly this row's amount. */
  readonly sweep: PostRequest;
  /** Rewards engine → beneficiary, for exactly this row's amount. */
  readonly payout: PostRequest;
};

export type AffiliatePayoutPlan = {
  readonly feeEventId: string;
  readonly asset: string;
  readonly legs: readonly AffiliatePayoutLeg[];
  /** Decimal string sum across legs. */
  readonly totalCommission: string;
  readonly beneficiaryCount: number;
  readonly maxTierDepth: number;
};

function refuse(message: string, code: Parameters<typeof buildRefusal>[1]): never {
  throw buildRefusal(message, code);
}

function buildRefusal(message: string, code: AffiliatePayoutRefuseError['code']): AffiliatePayoutRefuseError {
  return new AffiliatePayoutRefuseError(message, code, AFFILIATE_PAYOUT_RESIDUAL);
}

/**
 * The owner-published rate for one hop, or null.
 *
 * Numeric comparison, not string equality: "0.10" and "0.1" are the same rate,
 * and refusing a payout over trailing-zero formatting would be a false refuse
 * that an operator would "fix" by editing the rate — which is how a formatting
 * bug turns into a rate change nobody reviewed.
 */
export function publishedTierRateForHop(law: AccrualTierLaw, hop: number): Amount | null {
  if (!law.published) return null;
  for (const tier of law.tiers) {
    if (tier.hop === hop) return parseAmount(tier.rate);
  }
  return null;
}

/**
 * RATE PROVENANCE — the hole this closes is not obvious, and it is the one that
 * would actually leak money.
 *
 * `resolveAccrualTiers` (commission-rate-law.ts) accepts per-call `requestTiers`
 * from an operator as an explicit alternative to the owner-published env law.
 * That is defensible at ACCRUAL, which writes a claim and moves nothing. It is
 * not defensible at PAYOUT: a durable row carries whatever rate it was accrued
 * under, so paying "the rate on the row" would let an operator-supplied tier
 * become real money the owner never published — an invented rate laundered
 * through a durable row.
 *
 * So payout does not trust `row.rate`. Every row must match the owner-published
 * tier for its hop, or the whole plan refuses.
 */
/**
 * ACCRUAL ROW ARITHMETIC — rate provenance alone is not enough.
 *
 * A durable row can carry the owner-published rate while `commission_amount`
 * was edited after accrual (SQL restore, manual fix, bug). Paying "the amount on
 * the row" would move value the tree never earned at that rate. Recompute
 * fee×rate with the same decimalMul accrual uses; refuse on mismatch.
 */
export function assertAccrualRowCommissionMath(
  row: Pick<CommissionRow, 'beneficiaryId' | 'hop' | 'feeAmount' | 'rate' | 'commissionAmount'>,
): void {
  const expected = decimalMul(row.feeAmount, row.rate);
  if (parseAmount(row.commissionAmount) !== parseAmount(expected)) {
    refuse(
      `Accrual row for ${row.beneficiaryId} at hop ${row.hop} claims commission ${row.commissionAmount} but fee×rate is ${expected} — refusing to pay a tampered amount`,
      'affiliate.payout.commission_mismatch',
    );
  }
}

export function assertPayoutRateProvenance(rows: readonly CommissionRow[], law: AccrualTierLaw): void {
  if (!law.published) {
    refuse(
      'Affiliate payout is refuse-closed until the owner publishes DIRECTION §8 fee-share / IB tier rates',
      'affiliate.payout.rates_unset',
    );
  }

  for (const row of rows) {
    const published = publishedTierRateForHop(law, row.hop);
    if (published === null) {
      refuse(
        `Accrual row at hop ${row.hop} has no owner-published tier rate — refusing to pay a hop the owner never priced`,
        'affiliate.payout.rate_unpublished',
      );
    }
    if (parseAmount(row.rate) !== published) {
      refuse(
        `Accrual row at hop ${row.hop} was accrued at a rate the owner has not published — refusing to pay an operator-supplied rate`,
        'affiliate.payout.rate_unpublished',
      );
    }
  }
}

/**
 * Business idempotency key material for one accrual row.
 *
 * `(feeEventId, beneficiaryId, hop)` IS the accrual table's unique constraint
 * (drizzle/0007_commission_accruals.sql), so one accrual row maps to exactly
 * one payout forever.
 *
 * NO CLOCK AND NO UUID. This repo has paid twice for that bug three times: a
 * key containing `randomUUID()` or `new Date().toISOString()` is a fresh key
 * per attempt, so a retry is a second payment. `close:${positionId}` survived;
 * `close:${id}:${randomUUID()}` drained a pot.
 */
export function affiliatePayoutRowKey(row: Pick<CommissionRow, 'feeEventId' | 'beneficiaryId' | 'hop'>): string {
  return `affiliate:${row.feeEventId}:${row.beneficiaryId}:h${row.hop}`;
}

/**
 * Plan a payout for every durable accrual row of one fee event.
 *
 * WHY ONE SWEEP PER LEG RATHER THAN ONE SWEEP FOR THE EVENT:
 * `sweepFeesToRewards` keys on `token.fee.sweep:<windowId>:<module>:<asset>` —
 * the AMOUNT IS NOT IN THE KEY. One sweep per fee event would dedupe against
 * itself if the row set ever grew (a second accrual adding a hop), sweeping the
 * old smaller amount while paying the new larger fan-out — and the extra would
 * be silently borrowed from whatever else the rewards engine happens to hold.
 * Keying each sweep to its own row makes the pot movement and the beneficiary
 * movement exactly equal and independently replay-safe.
 *
 * ATOMICITY, STATED HONESTLY: `LedgerClient` has no batch/transaction API, and
 * a single all-legs PostRequest would need a new multi-beneficiary recipe —
 * a DIRECTION §3 owner carve-out this task may not write. So the fan-out is
 * replay-safe by key rather than one transaction: a crash mid-fan-out leaves
 * the tree partially paid, and re-running the same plan completes it while
 * paying nobody twice, because every key is derived from the business event.
 */
export function planAffiliatePayout(input: {
  readonly feeEventId: string;
  readonly rows: readonly CommissionRow[];
  readonly law: AccrualTierLaw;
  /**
   * Who is frozen. Required at the call. An explicit empty set means the
   * caller checked and nobody is frozen. Omitting the set is not that check:
   * the planner refuses and pays nobody, so a freeze applied after accrual
   * cannot be skipped by silence.
   */
  readonly frozenBeneficiaryIds?: ReadonlySet<string>;
  readonly maxTierDepth?: number;
  /**
   * Plan-level override only. Prefer each row's sourceModule (producer pool).
   * Kept for tests that fund a single pool without stamping every row.
   */
  readonly sourceModule?: string;
}): AffiliatePayoutPlan {
  const feeEventId = input.feeEventId.trim();
  const maxTierDepth = input.maxTierDepth ?? MAX_PAYOUT_TIER_DEPTH;
  const planDefaultModule = input.sourceModule ?? AFFILIATE_PAYOUT_SOURCE_MODULE;

  // Rate first, before anything else can look like progress. An operator who
  // asks to pay before the owner has published a rate gets the rate refusal —
  // not a validation complaint about some other field.
  assertPayoutRateProvenance(input.rows, input.law);

  if (!feeEventId) {
    refuse('feeEventId is required — a payout key must be derived from the business event, never a clock', 'affiliate.payout.invalid');
  }
  if (input.rows.length === 0) {
    refuse(
      `No durable accrual rows for fee event ${feeEventId} — refusing to post an empty payout rather than reporting a paid zero`,
      'affiliate.payout.nothing_accrued',
    );
  }

  const asset = input.rows[0]!.asset;
  // A freeze applied after accrual must stop the money. Defaulting a missing
  // roster to an empty set would pay every accrual row. An explicit empty set
  // is the caller saying they checked and nobody is frozen.
  if (input.frozenBeneficiaryIds === undefined) {
    refuse(
      `Fee event ${feeEventId} has no freeze roster — refusing to pay accruals when the caller did not say who is frozen`,
      'affiliate.payout.freeze_roster_required',
    );
  }
  const frozen = input.frozenBeneficiaryIds;
  const legs: AffiliatePayoutLeg[] = [];
  const seen = new Set<string>();
  const beneficiaries = new Set<string>();
  let total: Amount = 0n;
  /** First resolved fee pool for this fee event — mixed pools refuse (mirrors mixed asset). */
  let feeEventSourceModule: string | null = null;
  /** One fee event → one fee notional. Mixed feeAmount is corruption, not a feature. */
  let feeEventFeeAmount: string | null = null;

  for (const row of input.rows) {
    if (row.feeEventId !== feeEventId) {
      refuse(
        `Accrual row belongs to fee event ${row.feeEventId}, not ${feeEventId} — refusing to pay a fan-out assembled from mixed events`,
        'affiliate.payout.invalid',
      );
    }
    // Sum-to-zero is per asset. A mixed-asset fan-out is corruption, not a
    // multi-asset feature: FeeEvent carries exactly one asset.
    if (row.asset !== asset) {
      refuse(
        `Fee event ${feeEventId} has accrual rows in both ${asset} and ${row.asset} — refusing a mixed-asset fan-out`,
        'affiliate.payout.mixed_asset',
      );
    }
    if (feeEventFeeAmount === null) {
      feeEventFeeAmount = row.feeAmount;
    } else if (parseAmount(row.feeAmount) !== parseAmount(feeEventFeeAmount)) {
      refuse(
        `Fee event ${feeEventId} has accrual rows with fee ${feeEventFeeAmount} and ${row.feeAmount} — refusing a mixed-fee fan-out`,
        'affiliate.payout.fee_mismatch',
      );
    }
    assertAccrualRowCommissionMath(row);
    // The bound is enforced where the money moves, not only where the edge was
    // written: rows accrued under a looser cap must not pay past this one.
    if (row.hop >= maxTierDepth) {
      refuse(
        `Accrual row at hop ${row.hop} exceeds the payout tier depth bound of ${maxTierDepth} — refusing to pay past the bound`,
        'affiliate.payout.depth_exceeded',
      );
    }
    // Self-referral is the shortest cycle. Refused at write time in the tree;
    // refused again here, because a row that predates that fix must not pay.
    if (row.beneficiaryId === row.payerId) {
      refuse(
        `Accrual row pays ${row.beneficiaryId} commission on their own fee — refusing self-referral payout`,
        'affiliate.payout.self_referral',
      );
    }
    // A frozen beneficiary is skipped at accrual, but a freeze applied AFTER
    // accrual must still stop the money. Refuse the plan rather than silently
    // paying a partial tree.
    if (frozen.has(row.beneficiaryId)) {
      refuse(`Beneficiary ${row.beneficiaryId} is frozen — refusing to pay a frozen node`, 'affiliate.payout.beneficiary_frozen');
    }

    const key = affiliatePayoutRowKey(row);
    if (seen.has(key)) {
      refuse(`Duplicate accrual row for ${key} — refusing a fan-out that would pay one row twice`, 'affiliate.payout.invalid');
    }
    seen.add(key);

    // Decimal string on the wire → scaled bigint in memory. Never a number.
    const amount = parseAmount(row.commissionAmount);
    if (amount <= 0n) {
      refuse(
        `Accrual row for ${row.beneficiaryId} at hop ${row.hop} has non-positive commission — refusing to post a movement of nothing`,
        'affiliate.payout.invalid',
      );
    }

    // Sweep the pool the fee actually landed in — row wins over plan default.
    const sourceModule = (row.sourceModule ?? planDefaultModule).trim();
    if (!sourceModule || !AFFILIATE_FEE_SOURCE_MODULE_RE.test(sourceModule)) {
      refuse(
        `Accrual row at hop ${row.hop} has invalid sourceModule ${JSON.stringify(row.sourceModule)} — refusing to guess a fee pool`,
        'affiliate.payout.invalid',
      );
    }
    // One fee event → one houseFees module. A hand-assembled / corrupt row set
    // that names both trade and pay would debit two pools for one event —
    // refuse before any post, same class as mixed_asset.
    if (feeEventSourceModule === null) {
      feeEventSourceModule = sourceModule;
    } else if (sourceModule !== feeEventSourceModule) {
      refuse(
        `Fee event ${feeEventId} has accrual rows naming both ${feeEventSourceModule} and ${sourceModule} fee pools — refusing a mixed-pool fan-out`,
        'affiliate.payout.mixed_source_module',
      );
    }

    beneficiaries.add(row.beneficiaryId);
    total += amount;

    legs.push({
      beneficiaryId: row.beneficiaryId,
      payerId: row.payerId,
      hop: row.hop,
      commissionAmount: formatAmount(amount),
      asset: row.asset,
      sweep: recipes.sweepFeesToRewards({ windowId: key, sourceModule, assetId: row.asset, amount }),
      payout: recipes.rewardPay({
        rewardId: key,
        userId: row.beneficiaryId,
        assetId: row.asset,
        amount,
        reason: AFFILIATE_PAYOUT_REASON,
      }),
    });
  }

  const plan: AffiliatePayoutPlan = {
    feeEventId,
    asset,
    legs,
    totalCommission: formatAmount(total),
    beneficiaryCount: beneficiaries.size,
    maxTierDepth,
  };

  assertPayoutPlanBalanced(plan);
  return plan;
}

/**
 * Every leg's pot movement must equal its beneficiary movement, and the legs
 * must sum to the reported total.
 *
 * The ledger enforces sum-to-zero per transaction on its own. What it cannot
 * see is this engine reporting a total that does not match what it is about to
 * post — which is how a fan-out under-pays a tree while the receipt looks right.
 */
function creditAmountOf(post: PostRequest): Amount {
  let credit = 0n;
  for (const entry of post.entries) {
    if (entry.direction === 'credit') credit += entry.amount;
  }
  return credit;
}

export function assertPayoutPlanBalanced(plan: AffiliatePayoutPlan): void {
  let summed: Amount = 0n;
  for (const leg of plan.legs) {
    const amount = parseAmount(leg.commissionAmount);
    summed += amount;
    if (leg.asset !== plan.asset) {
      refuse(`Leg for ${leg.beneficiaryId} is in ${leg.asset}, plan is in ${plan.asset}`, 'affiliate.payout.mixed_asset');
    }
    const sweepAmount = creditAmountOf(leg.sweep);
    const payoutAmount = creditAmountOf(leg.payout);
    if (sweepAmount !== amount || payoutAmount !== amount) {
      refuse(
        `Payout leg for ${leg.beneficiaryId} at hop ${leg.hop} wires sweep=${formatAmount(sweepAmount)} payout=${formatAmount(payoutAmount)} but the leg claims ${leg.commissionAmount} — refusing an unbalanced fan-out`,
        'affiliate.payout.plan_unbalanced',
      );
    }
  }
  if (summed !== parseAmount(plan.totalCommission)) {
    refuse(
      `Payout plan legs sum to ${formatAmount(summed)} but the plan reports ${plan.totalCommission} — refusing an unbalanced fan-out`,
      'affiliate.payout.plan_unbalanced',
    );
  }
}

export type AffiliatePayoutReceipt = {
  readonly feeEventId: string;
  readonly asset: string;
  readonly totalCommission: string;
  readonly legCount: number;
  readonly beneficiaryCount: number;
  /** Every idempotency key posted, in order — sweep then payout per leg. */
  readonly idempotencyKeys: readonly string[];
  readonly txIds: readonly string[];
};

/**
 * Post a plan. Idempotent by construction — re-posting returns the original
 * transactions rather than doubling the money, and the keys prove it.
 *
 * Sweep before payout, per leg: the pot must hold the value before the
 * beneficiary leg draws on it, or the rewards engine would go negative (house
 * accounts are hard non-negative) and the leg would fail rather than borrow.
 */
export async function postAffiliatePayout(ledger: Pick<LedgerClient, 'post'>, plan: AffiliatePayoutPlan): Promise<AffiliatePayoutReceipt> {
  const idempotencyKeys: string[] = [];
  const txIds: string[] = [];

  for (const leg of plan.legs) {
    const sweepTx: LedgerTx = await ledger.post(leg.sweep);
    idempotencyKeys.push(leg.sweep.idempotencyKey);
    txIds.push(sweepTx.id);

    const payoutTx: LedgerTx = await ledger.post(leg.payout);
    idempotencyKeys.push(leg.payout.idempotencyKey);
    txIds.push(payoutTx.id);
  }

  return {
    feeEventId: plan.feeEventId,
    asset: plan.asset,
    totalCommission: plan.totalCommission,
    legCount: plan.legs.length,
    beneficiaryCount: plan.beneficiaryCount,
    idempotencyKeys,
    txIds,
  };
}

/** Ops board line for a plan. Money stays a decimal string. */
export function affiliatePayoutPlanStatusLine(plan: AffiliatePayoutPlan): string {
  return `legs=${plan.legs.length} beneficiaries=${plan.beneficiaryCount} total=${plan.totalCommission} asset=${plan.asset} depthCap=${plan.maxTierDepth}`;
}

/**
 * True when every key in a receipt is distinct.
 *
 * The honest assertion for idempotency is DISTINCT KEYS, not call counts: a
 * deduped post still returns a transaction, so counting calls proves nothing
 * about whether the money moved twice.
 */
export function payoutKeysAreDistinct(receipt: AffiliatePayoutReceipt): boolean {
  return new Set(receipt.idempotencyKeys).size === receipt.idempotencyKeys.length;
}

/**
 * True when no key carries a clock reading or a generated id.
 *
 * A guard, not decoration: this is the defect class that has been fixed three
 * times in this repo, and it always looked fine in review.
 *
 * THE INVARIANT IS A COUNT, and it is deliberately blunt. An affiliate payout
 * key contains EXACTLY ONE uuid — the beneficiary. A second uuid anywhere means
 * something generated one, and a `close:${id}:${randomUUID()}` tail is the exact
 * shape that drained a pot here before.
 *
 * The first version of this function tried to be clever — it allowed a uuid that
 * `endsWith` the key on the theory that a trailing id was "the business one".
 * That is precisely backwards: the trailing position is where a generated id
 * gets appended, so the guard waved through the one shape it existed to catch.
 * Counting cannot be fooled that way.
 */
export function payoutKeysAreBusinessDerived(receipt: AffiliatePayoutReceipt): boolean {
  const uuidish = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const isoish = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  /** `Date.now()` — 13 digits as its own segment. */
  const epochish = /(?:^|:)\d{13}(?::|$)/;
  return receipt.idempotencyKeys.every((k) => {
    if (isoish.test(k) || epochish.test(k)) return false;
    return (k.match(uuidish) ?? []).length === 1;
  });
}
