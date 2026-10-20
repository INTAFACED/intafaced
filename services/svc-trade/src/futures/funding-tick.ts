/**
 * Funding settlement tick (trade.futures residual).
 *
 * JOB SHAPE (not a wall-clock cron): one callable tick that:
 *  1. asks an external FundingRateSource for the period rate (never invents)
 *  2. loads open positions for the market
 *  3. plans legs via planFundingSettlement (rate frozen per periodId on first sight)
 *  4. posts ledger recipes + records period settled (idempotent)
 *
 * Out of scope: rate oracle, 8h scheduler host, mark price, insurance.
 * Wire a real rate source + setInterval/cron in ops when ready — this file
 * only proves the tick cannot invent money.
 */
import type { Amount, LedgerClient, PostRequest } from '@intafaced/ledger-client';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { planFundingSettlement, summarizeFundingPlan, type FundingOpenPosition, type FundingLeg } from './funding-settlement.js';
import { assertFundingRateWithinBound } from './funding-rate-bound.js';

/**
 * Wire shape stored in `funding_period_membership.member_snapshots`.
 * Amounts are decimal strings — never JSON numbers (18 dp).
 */
export interface FundingMemberSnapshot {
  readonly positionId: string;
  readonly userId: string;
  readonly side: 'long' | 'short';
  readonly size: string;
  readonly entryPrice: string;
  readonly marginAsset: string;
}

export function snapshotFundingMembers(positions: readonly FundingOpenPosition[]): FundingMemberSnapshot[] {
  return positions.map((p) => ({
    positionId: p.positionId,
    userId: p.userId,
    side: p.side,
    size: formatAmount(p.size),
    entryPrice: formatAmount(p.entryPrice),
    marginAsset: p.marginAsset,
  }));
}

export function positionsFromFundingSnapshots(snaps: readonly FundingMemberSnapshot[]): FundingOpenPosition[] {
  return snaps.map((s) => ({
    positionId: s.positionId,
    userId: s.userId,
    side: s.side,
    size: parseAmount(s.size),
    entryPrice: parseAmount(s.entryPrice),
    marginAsset: s.marginAsset,
  }));
}

/** External period rate. Null / refuse → tick skips; never synthesize a rate. */
export interface FundingRateQuote {
  /** Absolute period rate as decimal string (e.g. "0.0001"). */
  rate: string;
  /** Unique period id, e.g. marketId + ISO period start. */
  periodId: string;
  marketId: string;
}

export interface FundingRateSource {
  /**
   * Return the rate for this market/period window, or null if no rate is
   * available (oracle down, market not funding-enabled, period already unknown).
   * Implementations MUST NOT invent a placeholder rate.
   */
  quote(input: { marketId: string; at: Date }): Promise<FundingRateQuote | null>;
}

export interface FundingPositionLoader {
  /** Open futures positions for one market (any user). */
  listOpenForMarket(marketId: string): Promise<readonly FundingOpenPosition[]>;
}

/**
 * Period ledger — prevents double-settling the same periodId.
 *
 * ADR done bar §5: skips are **recorded** and distinguishable from zero-rate
 * periods. Zero-rate / one-sided books use `markSettled` with `legCount: 0`
 * (period blocked). Oracle-down / empty book use `recordSkip` (audit only —
 * does not block a later settle when a rate appears).
 */
export type FundingSkipReason = 'no_rate' | 'no_positions';

export interface FundingPeriodStore {
  isSettled(periodId: string): Promise<boolean>;
  markSettled(periodId: string, meta: { legCount: number; totalPosted: number }): Promise<void>;
  /**
   * Freeze period membership + size/notional on first plan for `periodId`.
   *
   * First call stores the candidate **snapshots** (id, side, size, entry, user,
   * margin asset) as the only plan inputs for this period. Later calls return
   * that frozen set and ignore new candidates and live size changes.
   *
   * Required: without id freeze, a mid-gap opener mints a new ledger key (C14).
   * Without size freeze, a partial close re-plans different amounts under the
   * same keys — ledger first-wins vs margin re-net (W6/W7 residual).
   */
  freezeMembership(periodId: string, candidates: readonly FundingOpenPosition[]): Promise<readonly FundingOpenPosition[]>;
  /**
   * Freeze the period RATE on first sight of `periodId`; ALWAYS return the first
   * stored rate, ignoring `rate` on every later call (decimal string, never number).
   *
   * Required for the same reason as membership: leg recipe keys are
   * (period, payer, payee) but their amounts depend on the rate. A replay that
   * re-asks the oracle after it republished the period (or after a restart lost
   * its rate book) re-posts leg 1 under the same key with a different amount —
   * the ledger either keeps r1 while later legs book r2, or refuses the reused
   * key and the period can never settle.
   */
  freezeRate(periodId: string, rate: string): Promise<string>;
  /** The rate already frozen for this period, or null when none has been. Read only; never freezes. */
  peekRate(periodId: string): Promise<string | null>;
  /**
   * Record a skip that is NOT a settled zero-leg period.
   * Optional on older stores — tick still returns skipped; production wires it.
   */
  recordSkip?(periodId: string, meta: { marketId: string; reason: FundingSkipReason }): Promise<void>;
  /** Latest skip for a period, if any. Distinguishes skip audit from settled_no_legs. */
  lastSkip?(periodId: string): Promise<{ reason: FundingSkipReason; marketId: string } | null>;
  /** Settled leg_count when period is settled; null if not settled. */
  settledLegCount?(periodId: string): Promise<number | null>;
}

/**
 * After ledger posts, move the position row with the money.
 *
 * Payers: margin_current -= paid, funding_paid += paid.
 * Payees: funding_paid -= received (receipt goes to available, not re-margin).
 *
 * `periodId` is not decoration. This runs between an idempotent ledger post and
 * the settle marker that stops the tick re-running, so a restart in that gap
 * replays it — and a decrement replayed is a trader's margin charged twice for
 * one funding period. The implementation must be idempotent on
 * (position, period), which is why it is given the period. See 0014.
 */
export interface FundingMarginApplier {
  applyFundingNets(nets: readonly { positionId: string; paid: Amount }[], periodId: string): Promise<void>;
}

export interface FundingTickDeps {
  rates: FundingRateSource;
  positions: FundingPositionLoader;
  periods: FundingPeriodStore;
  ledger: Pick<LedgerClient, 'post'>;
  /**
   * REQUIRED, and the requirement is the fix.
   *
   * This was `margins?`, with `if (deps.margins)` at the call site. #1047 made
   * the applier idempotent on `(position, period)` and closed the double-debit —
   * but only for a wire that passes one. A wire that omits it skipped the step
   * entirely and silently: `margin_current` never moved with funding, so close
   * and liquidation read open-time margin and over-release collateral. That is
   * the Tier-1 defect #1034 existed to close, reachable again through an
   * omission the compiler was happy with and nothing logged at boot.
   *
   * A runtime throw was the other option and is worse: it fails at the first
   * funding tick, which may be hours after the deploy that caused it, on a
   * market that then stops settling. Required in the type fails at build.
   *
   * What the type still cannot state: the applier must be IDEMPOTENT on
   * (position, period), because this call sits between an idempotent ledger post
   * and the settle marker written after it. `sqlFundingMarginApplier` gets that
   * from 0014's claim table; a hand-rolled applier that decrements twice is
   * still a double-debit, so the interface says so above and the memory helper
   * below models it.
   */
  margins: FundingMarginApplier;
  /**
   * Absolute max |period rate| (TRADE_FUTURES_FUNDING_MAX_ABS_RATE).
   * REQUIRED on the deps object (may be null = unconfigured).
   * Null refuses settlement before any ledger post — unpublished bound is not
   * a silent free pass. No product default invented here (owner residual D2).
   */
  maxAbsRate: string | null;
  /** Optional clock for tests. */
  now?: () => Date;
}

export type FundingTickResult =
  | { status: 'skipped'; reason: 'no_rate' | 'already_settled' | 'no_positions' | 'no_legs'; periodId?: string }
  | {
      status: 'settled';
      periodId: string;
      marketId: string;
      rate: string;
      legCount: number;
      summary: string;
    };

/**
 * Run one funding settlement tick for a market.
 * Idempotent on periodId via FundingPeriodStore + ledger recipe keys.
 */
export async function runFundingTick(deps: FundingTickDeps, marketId: string): Promise<FundingTickResult> {
  const at = (deps.now ?? (() => new Date()))();
  const quote = await deps.rates.quote({ marketId, at });
  if (!quote) {
    // No rate from oracle — record skip (does not invent a rate, does not block
    // a later period id when the oracle returns). Synthetic period id so the
    // audit row is queryable by market+clock.
    const skipId = `${marketId}:no_rate:${at.toISOString()}`;
    await deps.periods.recordSkip?.(skipId, { marketId, reason: 'no_rate' });
    return { status: 'skipped', reason: 'no_rate', periodId: skipId };
  }
  if (quote.marketId !== marketId) {
    // Misconfigured source — refuse rather than settle under the wrong market.
    const skipId = `${marketId}:no_rate:${at.toISOString()}`;
    await deps.periods.recordSkip?.(skipId, { marketId, reason: 'no_rate' });
    return { status: 'skipped', reason: 'no_rate', periodId: skipId };
  }

  if (await deps.periods.isSettled(quote.periodId)) {
    return { status: 'skipped', reason: 'already_settled', periodId: quote.periodId };
  }

  const open = await deps.positions.listOpenForMarket(marketId);
  if (open.length === 0) {
    await deps.periods.recordSkip?.(quote.periodId, { marketId, reason: 'no_positions' });
    return { status: 'skipped', reason: 'no_positions', periodId: quote.periodId };
  }

  // The bound is asserted on the QUOTE before anything is frozen: a refused tick posts nothing, so it must also
  // lock nothing. Freezing the membership first pinned the positions open at the refused moment, and the period
  // then settled from that stale snapshot once the publisher corrected the rate.
  // When a rate is already frozen the quote is irrelevant (the frozen one is what posts), so a later over-bound
  // republish cannot block a period whose legs are already in the ledger at a valid rate.
  const prior = await deps.periods.peekRate(quote.periodId);
  if (prior === null) assertFundingRateWithinBound(quote.rate, deps.maxAbsRate);

  // Membership + size/notional frozen on the first plan for this periodId.
  // Replays plan from that snapshot only — never open-now size, never a mid-gap
  // opener (C14 + W8 notional freeze residual).
  const members = await deps.periods.freezeMembership(quote.periodId, open);
  if (members.length === 0) {
    await deps.periods.markSettled(quote.periodId, { legCount: 0, totalPosted: 0 });
    return { status: 'skipped', reason: 'no_legs', periodId: quote.periodId };
  }

  // Rate frozen with the membership, once per periodId. A replay plans from the
  // first rate seen even if the oracle now quotes a different one for the same
  // period — otherwise leg 1 re-posts under the same key with a new amount.
  //
  // The quote was bound-checked above, before the membership froze, so only a rate that would actually be posted
  // is frozen here.
  const rate = prior ?? (await deps.periods.freezeRate(quote.periodId, quote.rate));

  // Bound check before plan so an absurd rate never reaches leg construction
  // or postLegs. assert is also inside planFundingSettlement (belt); this is
  // the explicit money-path gate with the tick's configured max. It runs on the
  // FROZEN rate: that is the one that will be posted.
  assertFundingRateWithinBound(rate, deps.maxAbsRate);

  const legs = planFundingSettlement({
    periodId: quote.periodId,
    marketId: quote.marketId,
    rate,
    maxAbsRate: deps.maxAbsRate,
    positions: members,
  });

  if (legs.length === 0) {
    // Zero rate or one-sided book — period BLOCKED as settled_no_legs (legCount 0).
    // This is deliberately NOT recordSkip: zero-rate is a completed period outcome.
    await deps.periods.markSettled(quote.periodId, { legCount: 0, totalPosted: 0 });
    return { status: 'skipped', reason: 'no_legs', periodId: quote.periodId };
  }

  await postLegs(deps.ledger, legs);

  // Ledger first, then row. The ledger dedupes on its own key, and the applier
  // is idempotent on (position, period) — both matter, because markSettled below
  // is written last, so a restart in this gap replays everything above it.
  // Without this step at all, close/liquidation read open-time margin and
  // over-release; without its idempotency, a replay charges margin twice.
  //
  // No longer guarded by `if (deps.margins)`. The guard read as caution and
  // acted as an opt-out from the margin move: a wire that forgot the dep settled
  // funding in the ledger and left every position's margin untouched, with no
  // error anywhere. `margins` is required, so this always runs.
  //
  // D26-P1-T1f / MVP-6: long/short funding is a pure transfer. Refuse before
  // margin apply if nets do not conserve (sum ≠ 0) — never mint or burn.
  const nets = netFundingPaid(legs);
  assertFundingNetsZero(nets);
  await deps.margins.applyFundingNets(nets, quote.periodId);

  await deps.periods.markSettled(quote.periodId, {
    legCount: legs.length,
    totalPosted: legs.length,
  });

  return {
    status: 'settled',
    periodId: quote.periodId,
    marketId: quote.marketId,
    rate,
    legCount: legs.length,
    summary: summarizeFundingPlan(legs),
  };
}

async function postLegs(ledger: Pick<LedgerClient, 'post'>, legs: readonly FundingLeg[]): Promise<void> {
  for (const leg of legs) {
    await ledger.post(leg.recipe as PostRequest);
  }
}

/** Net paid per position: positive = paid out of collateral, negative = received to available. */
export function netFundingPaid(legs: readonly FundingLeg[]): { positionId: string; paid: Amount }[] {
  const byId = new Map<string, Amount>();
  for (const leg of legs) {
    byId.set(leg.payerPositionId, (byId.get(leg.payerPositionId) ?? 0n) + leg.amount);
    byId.set(leg.payeePositionId, (byId.get(leg.payeePositionId) ?? 0n) - leg.amount);
  }
  return [...byId.entries()].map(([positionId, paid]) => ({ positionId, paid }));
}

/**
 * D26-P1-T1f done bar: funding is a zero-sum transfer between longs and shorts.
 * Sum of per-position nets MUST be 0 — otherwise the tick would mint or burn
 * collateral. Called on the real tick path before margin apply.
 */
export function assertFundingNetsZero(nets: readonly { positionId: string; paid: Amount }[]): void {
  let sum = 0n;
  for (const n of nets) sum += n.paid;
  if (sum !== 0n) {
    throw new Error(`funding nets must sum to zero (long/short conservation); got sum=${sum} across ${nets.length} position(s)`);
  }
}

/** Sum of paid nets — 0n when the book conserves (MVP-6). */
export function sumFundingNets(nets: readonly { positionId: string; paid: Amount }[]): Amount {
  let sum = 0n;
  for (const n of nets) sum += n.paid;
  return sum;
}

/** In-memory period store for unit tests and single-process dev. */
/**
 * In-memory margin applier, with the production idempotency rule modelled.
 *
 * Exists because `margins` is now required, and the honest way to satisfy a
 * required money dependency in a test is a working one, not `{ async
 * applyFundingNets() {} }`. A no-op stub would let a test pass while asserting
 * the opposite of production: it is exactly the shape of the `if (deps.margins)`
 * skip this change removes.
 *
 * Claims `(positionId, periodId)` before applying, the same key and the same
 * order as 0014's claim table, so a replay is a no-op here for the same reason it
 * is a no-op against Postgres. `paidByPosition` lets a test read the effect
 * without a database.
 */
export function memoryFundingMarginApplier(): FundingMarginApplier & {
  paidByPosition(positionId: string): Amount;
  applied(): ReadonlyArray<{ positionId: string; periodId: string }>;
} {
  const claimed = new Set<string>();
  const paid = new Map<string, Amount>();
  const log: Array<{ positionId: string; periodId: string }> = [];

  return {
    async applyFundingNets(nets, periodId) {
      for (const net of nets) {
        const key = `${net.positionId}:${periodId}`;
        if (claimed.has(key)) continue;
        claimed.add(key);
        paid.set(net.positionId, (paid.get(net.positionId) ?? 0n) + net.paid);
        log.push({ positionId: net.positionId, periodId });
      }
    },
    paidByPosition(positionId) {
      return paid.get(positionId) ?? 0n;
    },
    applied() {
      return log;
    },
  };
}

export function memoryFundingPeriodStore(): FundingPeriodStore {
  const settled = new Map<string, number>();
  const skips = new Map<string, { reason: FundingSkipReason; marketId: string }>();
  const membership = new Map<string, readonly FundingOpenPosition[]>();
  const rates = new Map<string, string>();
  return {
    async isSettled(periodId) {
      return settled.has(periodId);
    },
    async markSettled(periodId, meta) {
      settled.set(periodId, meta.legCount);
    },
    async freezeMembership(periodId, candidates) {
      if (!membership.has(periodId)) {
        // Deep-copy amounts so later mutation of caller arrays cannot resize the freeze.
        membership.set(
          periodId,
          candidates.map((p) => ({
            positionId: p.positionId,
            userId: p.userId,
            side: p.side,
            size: p.size,
            entryPrice: p.entryPrice,
            marginAsset: p.marginAsset,
          })),
        );
      }
      return membership.get(periodId)!;
    },
    async freezeRate(periodId, rate) {
      if (!rates.has(periodId)) rates.set(periodId, rate);
      return rates.get(periodId)!;
    },
    async peekRate(periodId) {
      return rates.get(periodId) ?? null;
    },
    async recordSkip(periodId, meta) {
      skips.set(periodId, { reason: meta.reason, marketId: meta.marketId });
    },
    async lastSkip(periodId) {
      return skips.get(periodId) ?? null;
    },
    async settledLegCount(periodId) {
      return settled.has(periodId) ? (settled.get(periodId) ?? 0) : null;
    },
  };
}
