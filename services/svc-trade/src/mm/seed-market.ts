/**
 * Market-maker seeder (trade.mm-bot residual).
 *
 * Orchestrates: external mid → assertTradable → planSeedQuotes →
 * ledger marketMakerOrderHold → matching submit (post-only GTC limits)
 * under house MM identity.
 *
 * TRADABILITY (handoff §7 / house-desk fairness settled rule 2): house is an
 * ordinary participant until the owner rules. Seed uses the SAME
 * `assertTradable` as user placeOrder — no second gate, no isHouse bypass.
 * Halted / futures-with-flag-off / unsupported kind refuse before any hold
 * or matching.submit.
 *
 * Cancel/reseed: cancelSeedMarket cancels known seed order ids for a prior run.
 * A true engine cancel releases the remaining MM hold from the ledger balance
 * (never invent the amount). A matching answer that did not cancel leaves a
 * positive hold on the order account for the fill. A new seed cycle MUST use
 * a new runId — hold keys are idempotent per order id.
 *
 * Does NOT invent mid, market list, or inventory. Fund the pot first via
 * marketMakerSeedFund. Seed uses post-only so orders rest or reject, never take.
 * House maker fill: recipes.marketMakerMakerFill + settleFill branch when
 * makerAccountId is house:market-maker (no trade.orders row required).
 *
 * Default: call site / ops enables. This module is pure orchestration with
 * injected ports — no wall-clock job here.
 */
import {
  formatAmount,
  marketMakerOrderHoldAccount,
  mul,
  parseAmount,
  recipes,
  type Amount,
  type LedgerClient,
} from '@intafaced/ledger-client';
import type { EngineSubmitResult, MatchingClient } from '../spot/matching-client.js';
import { mmSeedOrderIdFor } from '../spot/ids.js';
import { assertTradable } from '../spot/risk.js';
import { TradeError, type Market } from '../spot/types.js';
import { classifySeedSubmitResult, MM_SEED_ORDER_SEEDED, seedSubmitShape } from './seed-honesty.js';
import { MM_MATCHING_ACCOUNT_ID } from './fill-account.js';
import { planSeedQuotes, type SeedLevelIntent, type SeedPlanInput } from './seed-planner.js';
import type { MarketLifecyclePort } from '../market-lifecycle.js';
import { createLifecycleAdmissionProof, type LifecycleAdmissionProof } from '../lifecycle-proof.js';

export { MM_MATCHING_ACCOUNT_ID };

export function isHouseMmAccount(accountId: string): boolean {
  return accountId === MM_MATCHING_ACCOUNT_ID;
}

/** Fields assertTradable reads — same surface as placeOrder's market row. */
export type SeedTradableMarket = Pick<Market, 'symbol' | 'kind' | 'status' | 'assetClass'>;

export interface SeedMarketSpec extends SeedPlanInput {
  marketId: string;
  baseAsset: string;
  quoteAsset: string;
  /**
   * Stable id for this seed run — used in order ids + hold keys so retries
   * are idempotent. Never random per intent without a run id.
   */
  runId: string;
}

export interface SeedMarketDeps {
  ledger: Pick<LedgerClient, 'post'>;
  matching: Pick<MatchingClient, 'submit'>;
  /**
   * Catalog row for assertTradable (kind / status / symbol). Required —
   * never invent active/spot to skip the gate.
   */
  market: SeedTradableMarket;
  /** Real catalog market used by PX-S01; absent authority refuses before hold. */
  lifecycleMarket?: Market;
  marketLifecycle?: MarketLifecyclePort;
  /** Clock used to bind the proof to the authority snapshot in tests and jobs. */
  now?: () => Date;
  /**
   * Mirrors TRADE_FUTURES_ENABLED. Defaults false inside assertTradable
   * when omitted — same refusal as placeOrder with the flag off.
   */
  futuresEnabled?: boolean;
  /** Override order id generation (tests). */
  orderIdFor?: (intent: SeedLevelIntent, index: number) => string;
  /**
   * Durable SD-2 flag: persist resting seed orders as `seeded: true` so public
   * volume / tape can exclude them before any fill (trade.mm-bot coordinate).
   * Optional — fill-time stub still sets seeded when this port is absent.
   */
  recordSeededOrder?: (row: SeededOrderRecord) => Promise<void>;
}

/** Bookkeeping row for a resting house MM seed order (SD-2). */
export interface SeededOrderRecord {
  orderId: string;
  marketId: string;
  side: 'buy' | 'sell';
  price: string;
  qty: string;
  holdAsset: string;
  holdAmount: string;
  /** Always true — seed liquidity is never user volume (SD-2/SD-3). */
  seeded: true;
  lifecycleProof: LifecycleAdmissionProof;
}

export type SeedPlacementStatus =
  | 'resting'
  | 'rejected'
  | 'hold_failed'
  | 'submit_indeterminate'
  | 'released_after_reject'
  /** Engine returned fills on a PO seed submit — SD-5 refuse. */
  | 'manufactured_cross';

export interface SeedPlacement {
  orderId: string;
  intent: SeedLevelIntent;
  holdAsset: string;
  holdAmount: string;
  status: SeedPlacementStatus;
  /** SD-2: every seed placement is flagged seeded (API/placement claim). */
  seeded: true;
  rejectCode?: string;
  rejectMessage?: string;
}

export type SeedMarketResult =
  { ok: false; reason: string; placements: SeedPlacement[] } | { ok: true; mid: string; placements: SeedPlacement[] };

function holdForSeed(
  side: 'buy' | 'sell',
  price: Amount,
  qty: Amount,
  baseAsset: string,
  quoteAsset: string,
): { assetId: string; amount: Amount } {
  // Quote for buys (ceil notional), base for sells — same rule as holdFor.
  return side === 'buy' ? { assetId: quoteAsset, amount: mul(price, qty, 'ceil') } : { assetId: baseAsset, amount: qty };
}

function defaultOrderId(runId: string, marketId: string, intent: SeedLevelIntent): string {
  // Deterministic UUID: fills table + hold keys need uuid shape.
  return mmSeedOrderIdFor(runId, marketId, intent.side, intent.level);
}

/**
 * Seed one market's book from an external mid.
 * Empty mid / bad params / not tradable → ok:false, no posts.
 *
 * assertTradable runs before any ledger hold or matching.submit so house
 * cannot rest depth users cannot trade (halted / futures flag off / kind).
 */
export async function seedMarket(spec: SeedMarketSpec, deps: SeedMarketDeps): Promise<SeedMarketResult> {
  // Same gate as user placeOrder — before plan work that is cheap, and before
  // any hold/submit that is money. Catch so jobs get a soft skip, not a crash.
  // Cast: assertTradable's param is full Market; seed path supplies symbol/kind/status/assetClass.
  try {
    assertTradable(deps.market as Market, { futuresEnabled: deps.futuresEnabled });
  } catch (err) {
    if (err instanceof TradeError) {
      return { ok: false, reason: err.code, placements: [] };
    }
    throw err;
  }

  const plan = planSeedQuotes({
    midPrice: spec.midPrice,
    halfSpreadBps: spec.halfSpreadBps,
    stepBps: spec.stepBps,
    levels: spec.levels,
    qtyPerLevel: spec.qtyPerLevel,
  });

  if (!plan.ok) {
    return { ok: false, reason: plan.reason, placements: [] };
  }

  if (!spec.marketId.trim() || !spec.baseAsset.trim() || !spec.quoteAsset.trim()) {
    return { ok: false, reason: 'invalid_market', placements: [] };
  }
  if (!spec.runId.trim()) {
    return { ok: false, reason: 'missing_run_id', placements: [] };
  }

  // Lifecycle authority is required only after the cheap, side-effect-free
  // seed plan has validated. This preserves specific empty-mid/parameter
  // refusals while still refusing every placement before the first hold.
  if (!deps.marketLifecycle || !deps.lifecycleMarket) {
    return { ok: false, reason: 'trade.lifecycle_authority_unavailable', placements: [] };
  }
  if (!deps.now) {
    return { ok: false, reason: 'trade.lifecycle_clock_unavailable', placements: [] };
  }
  let lifecycleProof: LifecycleAdmissionProof;
  try {
    const checkedAt = deps.now().toISOString();
    const snapshot = await deps.marketLifecycle.snapshot(deps.lifecycleMarket, { now: checkedAt });
    const decision = deps.marketLifecycle.admit(snapshot, 'PLACE_POST_ONLY');
    if (decision.decision !== 'ELIGIBLE' || decision.action !== 'PLACE_POST_ONLY') {
      return { ok: false, reason: decision.reasonCode ?? 'trade.lifecycle_proof_mismatch', placements: [] };
    }
    lifecycleProof = createLifecycleAdmissionProof(snapshot, decision, 'PLACE_POST_ONLY');
  } catch {
    return { ok: false, reason: 'trade.lifecycle_proof_mismatch', placements: [] };
  }

  const placements: SeedPlacement[] = [];

  for (let i = 0; i < plan.intents.length; i++) {
    const intent = plan.intents[i]!;
    const orderId = deps.orderIdFor?.(intent, i) ?? defaultOrderId(spec.runId, spec.marketId, intent);
    const price = parseAmount(intent.price);
    const qty = parseAmount(intent.qty);
    const hold = holdForSeed(intent.side, price, qty, spec.baseAsset, spec.quoteAsset);

    try {
      await deps.ledger.post(
        recipes.marketMakerOrderHold({
          orderId,
          assetId: hold.assetId,
          amount: hold.amount,
        }),
      );
    } catch {
      placements.push({
        orderId,
        intent,
        holdAsset: hold.assetId,
        holdAmount: formatAmount(hold.amount),
        status: 'hold_failed',
        seeded: MM_SEED_ORDER_SEEDED,
      });
      continue;
    }

    let result: EngineSubmitResult;
    try {
      result = await deps.matching.submit(
        spec.marketId,
        seedSubmitShape({
          orderId,
          accountId: MM_MATCHING_ACCOUNT_ID,
          side: intent.side,
          qty: intent.qty,
          price: intent.price,
          lifecycleProof,
        }),
      );
    } catch {
      // Indeterminate: engine may hold the order. Keep MM hold; cancel path later.
      placements.push({
        orderId,
        intent,
        holdAsset: hold.assetId,
        holdAmount: formatAmount(hold.amount),
        status: 'submit_indeterminate',
        seeded: MM_SEED_ORDER_SEEDED,
      });
      continue;
    }

    const honesty = classifySeedSubmitResult(result);
    if (!honesty.ok) {
      try {
        await deps.ledger.post(
          recipes.marketMakerOrderHoldRelease({
            orderId,
            assetId: hold.assetId,
            amount: hold.amount,
          }),
        );
        placements.push({
          orderId,
          intent,
          holdAsset: hold.assetId,
          holdAmount: formatAmount(hold.amount),
          status: honesty.kind === 'manufactured_cross' ? 'manufactured_cross' : 'released_after_reject',
          seeded: MM_SEED_ORDER_SEEDED,
          rejectCode: result.rejected?.code ?? honesty.reason,
          rejectMessage: result.rejected?.message ?? honesty.reason,
        });
      } catch {
        placements.push({
          orderId,
          intent,
          holdAsset: hold.assetId,
          holdAmount: formatAmount(hold.amount),
          status: honesty.kind === 'manufactured_cross' ? 'manufactured_cross' : 'rejected',
          seeded: MM_SEED_ORDER_SEEDED,
          rejectCode: result.rejected?.code ?? honesty.reason,
          rejectMessage: result.rejected?.message ?? honesty.reason,
        });
      }
      continue;
    }

    if (deps.recordSeededOrder) {
      try {
        await deps.recordSeededOrder({
          orderId,
          marketId: spec.marketId,
          side: intent.side,
          price: intent.price,
          qty: intent.qty,
          holdAsset: hold.assetId,
          holdAmount: formatAmount(hold.amount),
          seeded: MM_SEED_ORDER_SEEDED,
          lifecycleProof,
        });
      } catch {
        // Hold is live on the book; keep resting status — fill stub still sets
        // seeded on first match. Recorder failure must not invent a cancel.
      }
    }

    placements.push({
      orderId,
      intent,
      holdAsset: hold.assetId,
      holdAmount: formatAmount(hold.amount),
      status: 'resting',
      seeded: MM_SEED_ORDER_SEEDED,
    });
  }

  const anyResting = placements.some((p) => p.status === 'resting');
  if (!anyResting) {
    return { ok: false, reason: 'no_resting_orders', placements };
  }

  return { ok: true, mid: formatAmount(plan.mid), placements };
}

export function summarizeSeedMarket(result: SeedMarketResult): string {
  if (!result.ok) {
    return `seed skip (${result.reason}) placements=${result.placements.length}`;
  }
  const resting = result.placements.filter((p) => p.status === 'resting').length;
  return `seed ok mid=${result.mid} resting=${resting}/${result.placements.length}`;
}

// ── Cancel / reseed lifecycle ────────────────────────────────────────────────

export interface CancelSeedSpec {
  marketId: string;
  baseAsset: string;
  quoteAsset: string;
  /** Levels used in the prior seed run (defines order-id set). */
  levels: number;
  /** Prior run id — same ids seedMarket used. */
  runId: string;
}

export interface CancelSeedDeps {
  ledger: Pick<LedgerClient, 'post' | 'balance'>;
  matching: Pick<MatchingClient, 'cancel'>;
  /** Override order id generation (tests) — must match seed. */
  orderIdFor?: (side: 'buy' | 'sell', level: number) => string;
}

export type CancelSeedPlacementStatus =
  'cancelled_and_released' | 'not_live_hold_kept' | 'not_live_no_hold' | 'cancelled_no_hold' | 'cancel_indeterminate' | 'release_failed';

export interface CancelSeedPlacement {
  orderId: string;
  side: 'buy' | 'sell';
  level: number;
  status: CancelSeedPlacementStatus;
  /** Engine cancelled live order; null if cancel call threw. */
  engineCancelled: boolean | null;
  releasedAsset?: string;
  releasedAmount?: string;
}

export type CancelSeedResult =
  { ok: true; placements: CancelSeedPlacement[] } | { ok: false; reason: string; placements: CancelSeedPlacement[] };

export interface SeedOrderRef {
  orderId: string;
  side: 'buy' | 'sell';
  level: number;
}

/**
 * Deterministic seed order ids for a run (buy+sell × levels).
 * Never invents a market or run — caller supplies both.
 */
export function seedOrderIdsForRun(
  runId: string,
  marketId: string,
  levels: number,
  orderIdFor?: (side: 'buy' | 'sell', level: number) => string,
): SeedOrderRef[] {
  const out: SeedOrderRef[] = [];
  if (!Number.isInteger(levels) || levels < 1) return out;
  for (let level = 1; level <= levels; level++) {
    for (const side of ['buy', 'sell'] as const) {
      const orderId = orderIdFor?.(side, level) ?? mmSeedOrderIdFor(runId, marketId, side, level);
      out.push({ orderId, side, level });
    }
  }
  return out;
}

/**
 * Cancel house MM seed orders for a prior run.
 *
 * Engine cancel first. On transport failure → cancel_indeterminate and do NOT
 * release (order may still be live). When the engine cancels, release the
 * remaining hold from the ledger balance — never invent the amount. A zero
 * balance skips. When matching answers and the order was not cancelled, do
 * not release: a just-filled order is already off the book before
 * marketMakerMakerFill posts, and releasing would return that inventory to
 * the pot before the taker draw.
 */
export async function cancelSeedMarket(spec: CancelSeedSpec, deps: CancelSeedDeps): Promise<CancelSeedResult> {
  if (!spec.marketId.trim() || !spec.baseAsset.trim() || !spec.quoteAsset.trim()) {
    return { ok: false, reason: 'invalid_market', placements: [] };
  }
  if (!spec.runId.trim()) {
    return { ok: false, reason: 'missing_run_id', placements: [] };
  }
  if (!Number.isInteger(spec.levels) || spec.levels < 1 || spec.levels > 50) {
    return { ok: false, reason: 'invalid_levels', placements: [] };
  }

  const placements: CancelSeedPlacement[] = [];
  let anyIndeterminate = false;
  let anyReleaseFailed = false;

  for (const ref of seedOrderIdsForRun(spec.runId, spec.marketId, spec.levels, deps.orderIdFor)) {
    let engineCancelled: boolean | null = null;
    try {
      const cancelResult = await deps.matching.cancel(spec.marketId, ref.orderId);
      engineCancelled = cancelResult.cancelled;
    } catch {
      anyIndeterminate = true;
      placements.push({
        orderId: ref.orderId,
        side: ref.side,
        level: ref.level,
        status: 'cancel_indeterminate',
        engineCancelled: null,
      });
      continue;
    }

    // Buy holds quote, sell holds base — try primary then other (honest zero skip).
    const assets = ref.side === 'buy' ? [spec.quoteAsset, spec.baseAsset] : [spec.baseAsset, spec.quoteAsset];

    // Matching answered, but did not cancel. A just-filled seed is already off
    // the book while marketMakerMakerFill has not posted. Releasing the positive
    // hold would pay the pot before the taker settlement draws it.
    if (engineCancelled !== true) {
      let holdKept = false;
      for (const assetId of assets) {
        let amount: Amount;
        try {
          const bal = await deps.ledger.balance(marketMakerOrderHoldAccount(assetId, ref.orderId));
          amount = bal.amount;
        } catch {
          continue;
        }
        if (amount > 0n) {
          holdKept = true;
          break;
        }
      }
      placements.push({
        orderId: ref.orderId,
        side: ref.side,
        level: ref.level,
        status: holdKept ? 'not_live_hold_kept' : 'not_live_no_hold',
        engineCancelled,
      });
      continue;
    }

    let released: { asset: string; amount: string } | null = null;
    let releaseFailed = false;

    for (const assetId of assets) {
      let amount: Amount;
      try {
        const bal = await deps.ledger.balance(marketMakerOrderHoldAccount(assetId, ref.orderId));
        amount = bal.amount;
      } catch {
        continue;
      }
      if (amount <= 0n) continue;
      try {
        await deps.ledger.post(
          recipes.marketMakerOrderHoldRelease({
            orderId: ref.orderId,
            assetId,
            amount,
            sequence: 0,
          }),
        );
        released = { asset: assetId, amount: formatAmount(amount) };
        break;
      } catch {
        releaseFailed = true;
        break;
      }
    }

    if (releaseFailed) {
      anyReleaseFailed = true;
      placements.push({
        orderId: ref.orderId,
        side: ref.side,
        level: ref.level,
        status: 'release_failed',
        engineCancelled,
      });
      continue;
    }

    const status: CancelSeedPlacementStatus = released ? 'cancelled_and_released' : 'cancelled_no_hold';

    placements.push({
      orderId: ref.orderId,
      side: ref.side,
      level: ref.level,
      status,
      engineCancelled,
      releasedAsset: released?.asset,
      releasedAmount: released?.amount,
    });
  }

  if (anyIndeterminate) {
    return { ok: false, reason: 'cancel_indeterminate', placements };
  }
  if (anyReleaseFailed) {
    return { ok: false, reason: 'release_failed', placements };
  }
  return { ok: true, placements };
}

export function summarizeCancelSeed(result: CancelSeedResult): string {
  if (!result.ok) {
    return `cancel fail (${result.reason}) placements=${result.placements.length}`;
  }
  const released = result.placements.filter((p) => p.status === 'cancelled_and_released').length;
  return `cancel ok released=${released}/${result.placements.length}`;
}
