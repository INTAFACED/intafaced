/**
 * Engine ↔ ledger scheduled reconcile caller (A10 / CX handoff).
 *
 * Matching already exposes pure `POST /reconcile` over the engine books.
 * Until this module existed, svc-trade had only per-order `reconcileOrder`
 * (destructive cancel probe, no schedule). Stranded money stayed silent
 * unless a human POSTed.
 *
 * ── What this does ──────────────────────────────────────────────────────────
 *
 * 1. Load open/pending rows from `trade.orders`.
 * 2. Read each order's real ledger hold (`holdAccountOf`) — never the
 *    row's remembered `hold_amount`.
 * 3. Map to `CounterpartOrder[]` and POST matching `/reconcile`.
 * 4. **Refuse findings write nothing** — log / metrics / alert only.
 * 5. **Auto-delete only** `counterpart_unfunded_engine_missing` when the row
 *    is still `pending` and `updated_at` is at least
 *    `HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS` old. A younger row may still
 *    have an `order.hold` post in flight; deleting it strands the hold
 *    when that post commits.
 * 6. **Market-id drift alarm** (handoff §4.5): compare `trade.markets` ids to
 *    engine `GET /markets`. Symmetric diff is log/alert only — never invents
 *    a listing, never deletes a market, never moves value.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────
 *
 * - Call `reconcileOrder` (operator single-order tool: engine-miss refunds
 *   only when `trade.fills` prove empty; unknown is fail-closed, hold stays).
 * - Release holds, invent holds, cancel live books, or pick a winner on any
 *   `refuse` case. A lost fill looks like funded-missing-from-engine; auto-
 *   release would pay the user money owed to a taker.
 * - Heal market-id drift by writing either side.
 *
 * Job host: `engine-ledger-reconcile-jobs.ts` · default OFF.
 */
import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import { holdAccountOf } from './buyback-order.js';
import type { CounterpartOrder, EngineMarketList, ReconcileFinding, ReconcileReport } from './matching-client.js';
import { HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS } from './hold-outcome.js';
import type { OrderStatus } from './types.js';

/** Wire state for matching — three values, not trade's six-status enum. */
export function mapOrderStatusToCounterpartState(status: OrderStatus): CounterpartOrder['state'] {
  if (status === 'pending') return 'pending';
  if (status === 'open' || status === 'recovery_required' || status === 'hold_unknown') return 'open';
  return 'terminal';
}

/**
 * One trade-side claim before it becomes a CounterpartOrder.
 * `holdAmount` is the live ledger balance, not the order row snapshot.
 */
export interface TradeOrderClaim {
  readonly orderId: string;
  readonly marketId: string;
  readonly status: OrderStatus;
  /** Working qty still expected (qty − filledQty), decimal string. */
  readonly remaining: string;
  readonly userId: string;
  readonly holdAsset: string;
  /** Live hold balance as scaled bigint. */
  readonly holdAmount: Amount;
}

/** Build the engine-facing claim. `funded` is hold > 0 only. */
export function toCounterpartOrder(claim: TradeOrderClaim): CounterpartOrder {
  const funded = claim.holdAmount > 0n;
  const detail = funded
    ? `hold=${formatAmount(claim.holdAmount)} ${claim.holdAsset} status=${claim.status}`
    : `hold=0 ${claim.holdAsset} status=${claim.status}`;
  return {
    orderId: claim.orderId,
    marketId: claim.marketId,
    state: mapOrderStatusToCounterpartState(claim.status),
    remaining: claim.remaining,
    funded,
    detail,
  };
}

/** Cap matches matching's body max (10k). Page later if needed. */
export const RECONCILE_ORDER_PAGE_LIMIT = 10_000;

export interface LocalReconcilePlan {
  /**
   * Order ids safe to DELETE as unfunded pending intents.
   * Never includes a funded row; never implies a ledger write.
   */
  readonly deleteUnfundedPendingIds: readonly string[];
  /** Every refuse finding — alert surface; zero writes. */
  readonly refusals: readonly ReconcileFinding[];
  /** Auto findings that are not pending-delete (e.g. open+unfunded) — alert only. */
  readonly autoNonDelete: readonly ReconcileFinding[];
}

/**
 * Translate an engine report into local actions.
 *
 * Refuse → never write. Auto unfunded + still pending in our claim map → delete.
 * Open+unfunded may be marked auto by the engine; we still refuse to delete
 * open rows here (unit: auto-delete only unfunded **pending**).
 */
export function planLocalActions(report: ReconcileReport, claimsById: ReadonlyMap<string, TradeOrderClaim>): LocalReconcilePlan {
  const deleteUnfundedPendingIds: string[] = [];
  const refusals: ReconcileFinding[] = [];
  const autoNonDelete: ReconcileFinding[] = [];

  for (const finding of report.findings) {
    if (finding.verdict === 'refuse') {
      refusals.push(finding);
      continue;
    }
    if (finding.verdict !== 'auto') continue;

    if (finding.case !== 'counterpart_unfunded_engine_missing') {
      autoNonDelete.push(finding);
      continue;
    }

    const claim = claimsById.get(finding.orderId);
    if (claim && claim.status === 'pending' && claim.holdAmount === 0n) {
      deleteUnfundedPendingIds.push(finding.orderId);
    } else {
      autoNonDelete.push(finding);
    }
  }

  return { deleteUnfundedPendingIds, refusals, autoNonDelete };
}

/**
 * Symmetric market-id set drift (handoff §4.5).
 * `drifted` is true when either side has an id the other lacks.
 * Pure compare — no writes, no invent.
 */
export interface MarketIdDriftReport {
  readonly tradeCount: number;
  readonly engineCount: number;
  /** Present in trade.markets, missing from engine GET /markets. */
  readonly onlyInTrade: readonly string[];
  /** Present on engine, missing from trade.markets. */
  readonly onlyInEngine: readonly string[];
  readonly drifted: boolean;
}

/** Pure set diff — sorted ids for stable logs/tests. Never invents members. */
export function diffMarketIds(tradeIds: readonly string[], engineIds: readonly string[]): MarketIdDriftReport {
  const trade = new Set(tradeIds);
  const engine = new Set(engineIds);
  const onlyInTrade = [...trade].filter((id) => !engine.has(id)).sort();
  const onlyInEngine = [...engine].filter((id) => !trade.has(id)).sort();
  return {
    tradeCount: trade.size,
    engineCount: engine.size,
    onlyInTrade,
    onlyInEngine,
    drifted: onlyInTrade.length > 0 || onlyInEngine.length > 0,
  };
}

export interface EngineLedgerReconcileTickResult {
  readonly counterpartCount: number;
  readonly report: ReconcileReport;
  readonly plan: LocalReconcilePlan;
  /** Rows actually deleted this tick (re-checked pending). */
  readonly deleted: readonly string[];
  /**
   * Always empty by design — reserved so tests can assert "no money writes".
   * Tick never posts to the ledger.
   */
  readonly ledgerPosts: readonly never[];
  /** Market-id set compare — alarm surface only. */
  readonly marketIdDrift: MarketIdDriftReport;
}

export interface EngineLedgerReconcileTickDeps {
  sql: Sql;
  ledger: Pick<LedgerClient, 'balance'>;
  matching: {
    reconcile(orders: readonly CounterpartOrder[]): Promise<ReconcileReport>;
    listMarkets(): Promise<EngineMarketList>;
  };
  /**
   * When true (default), perform the only auto write: DELETE pending unfunded.
   * Refuse path never writes regardless.
   */
  autoDeleteUnfundedPending?: boolean;
  /** Cap SELECT. Default RECONCILE_ORDER_PAGE_LIMIT. */
  limit?: number;
}

type OpenPendingRow = {
  id: string;
  user_id: string;
  market_id: string;
  status: OrderStatus;
  qty: string;
  filled_qty: string;
  hold_asset: string;
};

/**
 * Load open/pending orders and stamp each with its live hold balance.
 */
export async function loadTradeOrderClaims(
  sql: Sql,
  ledger: Pick<LedgerClient, 'balance'>,
  limit = RECONCILE_ORDER_PAGE_LIMIT,
): Promise<TradeOrderClaim[]> {
  const capped = Math.min(Math.max(Math.floor(limit), 1), RECONCILE_ORDER_PAGE_LIMIT);
  const rows = await sql<OpenPendingRow[]>`
    SELECT id, user_id, market_id, status, qty::text, filled_qty::text, hold_asset
      FROM trade.orders
     WHERE status IN ('pending', 'open', 'recovery_required')
     ORDER BY created_at ASC
     LIMIT ${capped}
  `;

  const claims: TradeOrderClaim[] = [];
  for (const row of rows) {
    // Remaining must be decimal-string math via scaled bigint — never float.
    const qty = parseAmount(row.qty);
    const filled = parseAmount(row.filled_qty);
    const remainingAmt = qty > filled ? qty - filled : 0n;
    const hold = (await ledger.balance(holdAccountOf({ id: row.id, userId: row.user_id, holdAsset: row.hold_asset }))).amount;

    claims.push({
      orderId: row.id,
      marketId: row.market_id,
      status: row.status,
      remaining: formatAmount(remainingAmt),
      userId: row.user_id,
      holdAsset: row.hold_asset,
      holdAmount: hold,
    });
  }
  return claims;
}

/**
 * Load every listed trade market id for the drift compare.
 * No join to orders — an empty trade book can still diverge from the engine.
 */
export async function loadTradeMarketIds(sql: Sql): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM trade.markets ORDER BY id ASC
  `;
  return rows.map((r) => r.id);
}

/**
 * One full sweep: market-id drift alarm → build counterpart view → POST reconcile
 * → local plan → optional deletes.
 * Never releases holds. Never invents money. Drift never writes either side.
 */
export async function runEngineLedgerReconcileTick(deps: EngineLedgerReconcileTickDeps): Promise<EngineLedgerReconcileTickResult> {
  const tradeMarketIds = await loadTradeMarketIds(deps.sql);
  const engineMarkets = await deps.matching.listMarkets();
  const marketIdDrift = diffMarketIds(tradeMarketIds, engineMarkets.markets);

  const claims = await loadTradeOrderClaims(deps.sql, deps.ledger, deps.limit);
  const claimsById = new Map(claims.map((c) => [c.orderId, c]));
  const counterpart = claims.map(toCounterpartOrder);

  const report = await deps.matching.reconcile(counterpart);
  const plan = planLocalActions(report, claimsById);

  const deleted: string[] = [];
  const doDelete = deps.autoDeleteUnfundedPending !== false;

  if (doDelete) {
    for (const orderId of plan.deleteUnfundedPendingIds) {
      // Re-check: still pending, and old enough that an in-flight hold post
      // (25s ledger timeout, 7 min trust window) can no longer commit.
      // A hold that lands after the plan read keeps a younger row.
      const rows = await deps.sql<{ id: string }[]>`
        DELETE FROM trade.orders
         WHERE id = ${orderId}
           AND status = 'pending'
           AND updated_at <= now() - make_interval(secs => ${HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS})
        RETURNING id
      `;
      if (rows.length > 0) deleted.push(orderId);
    }
  }

  return {
    counterpartCount: counterpart.length,
    report,
    plan,
    deleted,
    ledgerPosts: [],
    marketIdDrift,
  };
}
