/**
 * Futures position open/close + positionUpdated fan-out (trade.futures F3–F4).
 *
 * STATE in trade.positions; MARGIN only via ledger recipes (Doctrine §0.6).
 * Publishes `positionUpdated` so svc-ws private positions channel is not silent
 * after real opens.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO PRICE IN THIS FILE COMES FROM THE CALLER
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `docs/adr/2026-08-05-futures-risk-and-mark-law.md`: **a price that moves money
 * is never supplied by the party it pays.**
 *
 * `open()` used to take `entryPrice` and `close()` used to take `exitPrice`,
 * both straight off the request. Entry price sizes the margin lock; exit price
 * is the entire realised PnL. A caller who named their own exit price named
 * their own profit, and `futuresRealizeProfit` paid it out of a house pot. The
 * service was careful everywhere else — `funding-tick.ts` tells its own oracle
 * "implementations MUST NOT invent a placeholder rate" — but the guard was on
 * the source and not on the caller, and a rule that stops the engine inventing a
 * price while the API accepts one from whoever is being paid protects nothing.
 *
 * Both prices now come from the injected `MarkSource`, which reads the venue
 * fabric or the matching book. Neither is anything a request body can set, and
 * both arrive labelled so `mark-policy.ts` can refuse them.
 *
 * The refusal shape matters as much as the source: a request that carries a
 * price is REFUSED at the REST edge rather than silently re-priced, so a caller
 * learns instead of getting different behaviour than they asked for.
 */
import type { Sql, TransactionSql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { TradingControlError, canonicalPayload, type TradingAdmissionPort } from '../controls/trading-controls.js';
import { businessPayload } from '../controls/business-payload.js';
import { positionIdFor } from './ids.js';
import { formatAmount, parseAmount, recipes, userAvailable, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import type { Position } from '@intafaced/exchange-contract';
import type { EventBus } from '@intafaced/events';
import { checkLeverage, initialMargin, LEVERAGE_CAP_UNSET } from './initial-margin.js';
import { checkCollateralClassForMargin, checkMarginModeForFuturesOpen } from './margin-mode.js';
import { planClose } from './close-planner.js';
import { planLiquidation } from './liquidation-planner.js';
import type { MarkRequest, MarkSource } from './liquidation-tick.js';
import {
  DEFAULT_FUTURES_MARK_POLICY,
  acceptableForEntry,
  acceptableForLiquidation,
  acceptableForMarking,
  markMissing,
  type FuturesQuotedMark,
  type MarkPolicy,
} from './mark-policy.js';
import { PROFIT_SOURCE_UNCONFIGURED, checkProfitBound, type ProfitSource } from './profit-source.js';
import { INSURANCE_UNDERFUNDED, checkInsuranceBound } from './insurance-bound.js';
import { breakerBasis, readAcceptedMark, type PreviousMark } from './accepted-mark.js';
import { TradeError } from '../spot/types.js';
import { assertDatedFuturesTradable } from './dated-futures.js';

/**
 * How long one close waits for another close of the SAME position.
 *
 * `close()` holds a row lock across a mark read and the ledger posts, which is
 * the point of it — but an unbounded wait would let one wedged ledger call pin
 * a pooled connection per queued attempt and starve every other request in the
 * service. Three seconds is far longer than an honest close and short enough
 * that a pile-up drains instead of accumulating. Timing out is not the lock
 * failing, it is the lock working: the answer is "somebody is closing this
 * right now", and that is true.
 */
const CLOSE_LOCK_TIMEOUT_MS = 3_000;

/** Postgres `lock_timeout` expiry. Anything else from the driver is a real error. */
const PG_LOCK_NOT_AVAILABLE = '55P03';

function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === PG_LOCK_NOT_AVAILABLE;
}

/**
 * THE IDEMPOTENCY ROOT OF A VOLUNTARY CLOSE.
 *
 * One position closes once, so the key is the position and nothing else — no
 * clock, no random tail. `close-planner.ts` derives `:profit` and `:loss` from
 * it, `futuresMarginRelease` already keys on `positionId:sequence`, and the
 * result is that a close is a single settlement the ledger can recognise on
 * sight however many times it is asked to perform it.
 *
 * Exported because a test that asserts "paid once" should be able to name the
 * key it means, rather than re-deriving the format and drifting from it.
 */
export function closeIdFor(positionId: string): string {
  return `close:${positionId}`;
}

export class FuturesError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'FuturesError';
  }
}

export interface OpenPositionInput {
  userId: string;
  /** Market symbol, e.g. BTC/USDT-PERP — must be kind=futures and active. */
  symbol: string;
  side: 'long' | 'short';
  size: Amount;
  leverage: Amount;
  /**
   * Isolated only. `DIRECTION` §1, and the futures ADR's done bar item 8: *no
   * cross-margin path exists, even disabled*. `'cross'` is not a value this
   * type admits — the REST edge refuses it, and `open()` refuses it again for
   * callers TypeScript is not watching.
   */
  marginMode?: 'isolated';
  /**
   * Posted IM class. Omitted → cash (settled available quote). Yield-bearing,
   * staked, or lending-idle refuse — they are a separate product (PTX-M08-R11).
   */
  collateralClass?: string;
  /**
   * Caller-supplied open intent key (required). Position id and margin lock key
   * are derived from (user, market, clientOpenId) the same way spot derives
   * order ids from clientOrderId. A timeout + retry finds the original open
   * instead of locking a second pot under a random id.
   */
  clientOpenId: string;
}

export interface SetLeverageInput {
  userId: string;
  /** Market symbol — must match the open isolated position. */
  symbol: string;
  leverage: Amount;
  /** When omitted, the unique open position on `symbol` is used. */
  positionId?: string;
  /** Durable caller idempotency key. Mandatory at the REST boundary. */
  clientAdjustmentId?: string;
}

export interface AddIsolatedMarginInput {
  userId: string;
  /** Market symbol — must match the open isolated position. */
  symbol: string;
  /** Extra isolated collateral. Decimal string on the wire; scaled bigint here. */
  amount: Amount;
  /** When omitted, the unique open position on `symbol` is used. */
  positionId?: string;
  /** Durable caller idempotency key. Mandatory at the REST boundary. */
  clientAdjustmentId?: string;
  /** Posted IM class. Omitted → cash. Yield/staked/lending-idle refuse. */
  collateralClass?: string;
}

export type ReduceIsolatedMarginInput = AddIsolatedMarginInput;

/** New isolated IM would leave equity ≤ 0 at the current mark. */
export const LEVERAGE_WOULD_LIQUIDATE = 'trade.leverage_would_liquidate';
/** Decreasing leverage needs a lock the available balance cannot fund. */
export const LEVERAGE_INSUFFICIENT_MARGIN = 'trade.insufficient_margin';
/** Isolated reduce would pull collateral below initial margin. */
export const MARGIN_BELOW_INITIAL = 'trade.margin_below_initial';
/** Isolated reduce would leave equity ≤ 0 at the current mark. */
export const MARGIN_WOULD_LIQUIDATE = 'trade.margin_would_liquidate';
/** A previous ledger-backed adjustment must finish before a different one starts. */
export const MARGIN_ADJUSTMENT_IN_PROGRESS = 'trade.margin_adjustment_in_progress';

/** Blank / non-integer / out of 1..500 listClosed limit refuse. Never invent 100. */
export const TRADE_LIST_CLOSED_LIMIT_UNSET = 'trade.list_closed_limit_unset' as const;
export const LIST_CLOSED_LIMIT_MAX = 500;

export class ListClosedLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof TRADE_LIST_CLOSED_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'ListClosedLimitUnsetError';
  }
}

/** Owner-published closed-positions window. Missing / null / non-int / out of 1..max refuses. Never invent 100. */
export function publishedListClosedLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > LIST_CLOSED_LIMIT_MAX) {
    throw new ListClosedLimitUnsetError('listClosed limit is unset — refuse to invent 100', TRADE_LIST_CLOSED_LIMIT_UNSET);
  }
  return value;
}

export interface PositionServiceDeps {
  accountAdmission?: TradingAdmissionPort;
  /**
   * Where prices come from. Required, and required to be a port the caller
   * cannot reach: making this optional would put the old defect one missing
   * argument away.
   */
  marks: MarkSource;
  /**
   * The account realised profit is paid from, and the ceiling on it.
   *
   * `null` when the owner has not named one. That is a deliberate inhabitant
   * rather than an oversight: this used to be mandatory and enforced by
   * throwing at module scope in `index.ts`, which meant an unmade decision
   * about a futures pot crash-looped spot, ticker, orderbook, balances and the
   * websocket feeds too. Futures is one feature; a missing futures decision
   * disables FUTURES.
   *
   * With `null`, `open()` refuses outright and `close()` refuses any close that
   * would realise a PROFIT — losing and flat closes still work, because a
   * control that traps a trader in a position is not a safety control. Nothing
   * is ever paid from an account nobody chose, which is the whole of the ADR's
   * requirement.
   */
  profitSource: ProfitSource | null;
  /** Optional: tests may omit; production passes JetStream bus. */
  bus?: EventBus | null;
  markPolicy?: MarkPolicy;
  /**
   * THE LEVERAGE CEILING FOR THIS DEPLOYMENT.
   *
   * Null/omitted means the owner/listing did not name a cap: opens and live
   * re-leverage refuse before ledger mutation. No production default exists.
   */
  maxLeverage?: Amount | null;
  now?: () => Date;
  /**
   * DIRECTION:34 — ADL disclosure gate. When set (production), `open()` refuses
   * until the trader has ack'd in-product disclosure. Omitted in hermetic unit
   * tests that are not proving the public door; public-door + index always wire it.
   */
  assertAdlDisclosureAcked?: (userId: string) => Promise<void>;
  /** Test-only crash seam after the external ledger accepts, before DB finalize. */
  afterMarginLedgerPost?: (request: string) => Promise<void>;
}

/** Why a position is frozen waiting for a mark — futures-namespaced refuse codes. */
export type ClosingReason = 'trade.mark_missing' | 'trade.mark_unusable';

export interface PositionRow {
  id: string;
  user_id: string;
  market_id: string;
  side: 'long' | 'short';
  /**
   * `closing` = trader asked to leave while the feed was dark
   * (`docs/adr/2026-08-07-futures-exit-when-the-feed-is-dark.md`).
   */
  status: 'open' | 'closing' | 'closed' | 'liquidated';
  margin_mode: 'cross' | 'isolated';
  size: string;
  entry_price: string;
  leverage: string;
  margin_initial: string;
  /** Residual after funding; close/liq release from this, not margin_initial. */
  margin_current: string;
  margin_asset: string;
  funding_paid: string;
  liq_price: string | null;
  opened_at: Date;
  closed_at: Date | null;
  symbol: string;
  /**
   * The last mark this position was accepted against — the deviation breaker's
   * basis, written by this service and reachable by nobody else. NULL only for
   * rows written before `0007_position_accepted_mark.sql`; `open()` fills it in
   * with the entry mark from the moment a position exists.
   */
  accepted_mark: string | null;
  accepted_mark_at: Date | null;
  /** Non-null only while status=closing. */
  closing_reason: string | null;
  /** Last posted futuresMarginAdd/Release sequence; close residual uses 1. */
  margin_adjust_seq: number;
  margin_adjust_request: string | null;
}

export class PositionService {
  private readonly bus: EventBus | null;
  private readonly markPolicy: MarkPolicy;
  private readonly maxLeverage: Amount | null;
  private readonly afterMarginLedgerPost: ((request: string) => Promise<void>) | null;
  private readonly now: () => Date;

  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    private readonly deps: PositionServiceDeps,
  ) {
    this.bus = deps.bus ?? null;
    this.markPolicy = deps.markPolicy ?? DEFAULT_FUTURES_MARK_POLICY;
    this.maxLeverage = deps.maxLeverage ?? null;
    this.afterMarginLedgerPost = deps.afterMarginLedgerPost ?? null;
    this.now = deps.now ?? (() => new Date());
  }

  private requireLeverageCap(): Amount {
    if (this.maxLeverage == null || this.maxLeverage <= 0n) {
      throw new FuturesError('listing leverage cap is unset — refusing to invent a production leverage limit', LEVERAGE_CAP_UNSET, 503);
    }
    return this.maxLeverage;
  }

  /**
   * Commit the semantic request before touching the external ledger. A retry of
   * the exact request resumes; a different request cannot inherit its sequence.
   */
  private async claimMarginAdjustment(
    input: { userId: string; symbol: string; positionId?: string },
    adjustmentId: string,
    request: string,
  ): Promise<Position | null> {
    return this.sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL lock_timeout = ${CLOSE_LOCK_TIMEOUT_MS}`);
      const rows = input.positionId
        ? await tx<PositionRow[]>`
            SELECT p.*, m.symbol FROM trade.positions p
            JOIN trade.markets m ON m.id = p.market_id
            WHERE p.id = ${input.positionId} AND p.user_id = ${input.userId}
            LIMIT 1 FOR UPDATE OF p
          `
        : await tx<PositionRow[]>`
            SELECT p.*, m.symbol FROM trade.positions p
            JOIN trade.markets m ON m.id = p.market_id
            WHERE p.user_id = ${input.userId} AND m.symbol = ${input.symbol} AND p.status = 'open'
            FOR UPDATE OF p
          `;
      if (rows.length === 0) throw new FuturesError('position not found', 'trade.position_not_found', 404);
      if (rows.length > 1)
        throw new FuturesError(`more than one open position on ${input.symbol} — pass position id`, 'trade.position_ambiguous', 400);
      const row = rows[0]!;
      if (row.symbol !== input.symbol)
        throw new FuturesError(`position is on ${row.symbol}, not ${input.symbol}`, 'trade.symbol_mismatch', 400);
      const [existing] = await tx<
        { request_fingerprint: string; status: 'pending' | 'completed'; result: Position | null }[]
      >`SELECT request_fingerprint, status, result FROM trade.position_margin_adjustments
          WHERE position_id = ${row.id} AND client_adjustment_id = ${adjustmentId}`;
      if (existing) {
        if (existing.request_fingerprint !== request) {
          throw new FuturesError('clientAdjustmentId was already used for a different request', 'trade.idempotency_conflict', 409);
        }
        return existing.status === 'completed' ? existing.result : null;
      }
      if (row.status !== 'open') throw new FuturesError(`position is ${row.status}`, 'trade.position_not_open', 400);
      if (row.margin_mode !== 'isolated')
        throw new FuturesError('live margin adjustment is isolated-only', 'trade.cross_margin_unsupported', 400);
      if (row.margin_adjust_request !== null) {
        throw new FuturesError('a previous margin adjustment must finish before a different request', MARGIN_ADJUSTMENT_IN_PROGRESS, 409);
      }
      const sequence = Number(row.margin_adjust_seq) + 1;
      await tx`INSERT INTO trade.position_margin_adjustments
        (position_id, client_adjustment_id, request_fingerprint, sequence)
        VALUES (${row.id}, ${adjustmentId}, ${request}, ${sequence})`;
      await tx`UPDATE trade.positions SET margin_adjust_request = ${adjustmentId}, updated_at = now() WHERE id = ${row.id}`;
      return null;
    });
  }

  private async abandonMarginAdjustment(
    input: { userId: string; symbol: string; positionId?: string },
    adjustmentId: string,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      if (input.positionId) {
        await tx`DELETE FROM trade.position_margin_adjustments
          WHERE position_id = ${input.positionId} AND client_adjustment_id = ${adjustmentId} AND status = 'pending'`;
        await tx`UPDATE trade.positions SET margin_adjust_request = NULL, updated_at = now()
          WHERE id = ${input.positionId} AND user_id = ${input.userId} AND margin_adjust_request = ${adjustmentId}`;
      } else {
        await tx`DELETE FROM trade.position_margin_adjustments a USING trade.positions p, trade.markets m
          WHERE a.position_id = p.id AND m.id = p.market_id AND p.user_id = ${input.userId}
            AND m.symbol = ${input.symbol} AND a.client_adjustment_id = ${adjustmentId} AND a.status = 'pending'`;
        await tx`UPDATE trade.positions p SET margin_adjust_request = NULL, updated_at = now()
          FROM trade.markets m WHERE m.id = p.market_id AND p.user_id = ${input.userId}
            AND m.symbol = ${input.symbol} AND p.status = 'open' AND p.margin_adjust_request = ${adjustmentId}`;
      }
    });
  }

  private async completedMarginAdjustment(
    tx: TransactionSql,
    positionId: string,
    adjustmentId: string,
    request: string,
  ): Promise<Position | null> {
    const [record] = await tx<{ request_fingerprint: string; status: 'pending' | 'completed'; result: Position | null }[]>`
      SELECT request_fingerprint, status, result FROM trade.position_margin_adjustments
      WHERE position_id = ${positionId} AND client_adjustment_id = ${adjustmentId}
      FOR UPDATE
    `;
    if (!record || record.request_fingerprint !== request) {
      throw new FuturesError('margin adjustment intent is missing or changed', 'trade.idempotency_conflict', 409);
    }
    return record.status === 'completed' ? record.result : null;
  }

  /**
   * Ask the mark port for a labelled price usable for valuation, or name why not.
   *
   * Two darkness outcomes (never a zero mark):
   *   · no quote at all → `trade.mark_missing`
   *   · a quote the valuation gate rejects (stale, non-positive, future-dated)
   *     → `trade.mark_unusable`
   *
   * `open()` throws on either. `close()` freezes to `closing` instead — see
   * `docs/adr/2026-08-07-futures-exit-when-the-feed-is-dark.md`. A quote good
   * enough to value but not to PAY on is a later gate (`requirePayoutGrade`).
   *
   * ── `authorisesSize` IS NOT A HINT, IT IS THE STAKE ─────────────────────────
   *
   * The size, in base units, of the position this mark is about to price. A
   * depth-backed source uses it to require that the book standing behind the
   * best level is deep enough to stand behind THAT MUCH MONEY, instead of
   * clearing a fixed 100-unit floor that had no relationship to the payout at
   * all — the defect measured at 190,000 USDT
   * (`mark-from-depth.ts`, "AN ABSOLUTE FLOOR CANNOT GATE AN UNBOUNDED PAYOUT").
   *
   * IT IS A REQUIRED PARAMETER WITH NO DEFAULT. Every caller states the stake or
   * states `null`, because a defaulted `null` here is exactly the size-blind
   * behaviour being removed, arrived at by forgetting rather than by deciding.
   * On the close path it comes off the row held under `FOR UPDATE`; it is never
   * anything a request body can reach.
   */
  private async tryMarkForMarking(
    marketId: string,
    symbol: string,
    at: Date,
    authorisesSize: Amount | null,
  ): Promise<{ ok: true; mark: FuturesQuotedMark } | { ok: false; reason: ClosingReason; detail: string }> {
    const request: MarkRequest = { marketId, symbol, at, ...(authorisesSize != null ? { authorisesSize } : {}) };
    /**
     * Money paths require a LABELLED quote. An unlabelled `markPrice` string
     * must not be stamped `quality: 'mid'` (Denon handoff §6) — that invents a
     * liquidation/payout quality and disarms staleness. Missing `quote()` is
     * darkness, not a mid.
     */
    if (!this.deps.marks.quote) {
      return {
        ok: false,
        reason: 'trade.mark_missing',
        detail: `${marketId}: mark source has no labelled quote() — refuse inventing quality from bare markPrice`,
      };
    }
    const quoted = await this.deps.marks.quote(request);

    if (!quoted) {
      return { ok: false, reason: 'trade.mark_missing', detail: markMissing(marketId).reason! };
    }
    const check = acceptableForMarking(quoted, at, this.markPolicy);
    if (!check.ok) {
      return {
        ok: false,
        reason: check.code === 'trade.mark_missing' ? 'trade.mark_missing' : 'trade.mark_unusable',
        detail: check.reason ?? 'mark unusable',
      };
    }
    return { ok: true, mark: quoted };
  }

  /**
   * Open path: darkness refuses, and so does last-trade (DIRECTION MVP-1).
   * Close path uses `tryMarkForMarking` + freeze — losing exits may still mark
   * on `last`; entry may not.
   */
  private async markFor(marketId: string, symbol: string, at: Date, authorisesSize: Amount | null): Promise<FuturesQuotedMark> {
    const got = await this.tryMarkForMarking(marketId, symbol, at, authorisesSize);
    if (!got.ok) {
      throw new FuturesError(
        got.reason === 'trade.mark_missing' ? got.detail : `Refusing to value this position — ${got.detail}`,
        got.reason,
        503,
      );
    }
    const entry = acceptableForEntry(got.mark, at, this.markPolicy);
    if (!entry.ok) {
      throw new FuturesError(
        entry.code === 'trade.mark_missing' ? (entry.reason ?? 'mark missing') : `Refusing to value this position — ${entry.reason}`,
        entry.code ?? 'trade.mark_unusable',
        503,
      );
    }
    return got.mark;
  }

  /**
   * A mark good enough to SHOW is not automatically good enough to PAY ON.
   *
   * `prices.ts`'s asymmetry, pointed the other way: a warning on a questionable
   * mark costs a notification, a payout on one costs real money that leaves the
   * platform. So a close that realises PROFIT must clear the same bar a
   * liquidation does — quality, the tighter staleness limit, the deviation
   * breaker — and `last` therefore cannot fund a payout.
   *
   * A losing or flat close is deliberately NOT held to that bar once a usable
   * marking-grade quote exists — it returns the trader their own margin and
   * pays out nothing. When NO usable mark exists at all, this method is not
   * reached: `close()` freezes the row to `closing` first
   * (`docs/adr/2026-08-07-futures-exit-when-the-feed-is-dark.md`). An older
   * comment here claimed the losing-close exemption alone prevented trapping;
   * that was false while `markFor` threw before this gate — do not restore
   * that lie.
   *
   * ── `previous` is the half of this that used to be missing ──────────────────
   *
   * This method passed a literal `null` here, and `null` is the branch
   * `acceptableForLiquidation` uses to SKIP the deviation breaker. Every other
   * clause was live and that one was dead, so a feed that jumped 100x cleared
   * this gate and the house paid 4,950,000 USDT on it — measured, not
   * hypothesised (`position-service.test.ts`). The basis now comes from the
   * position row the caller cannot write, read inside the same lock as the
   * close that is about to use it.
   */
  private requirePayoutGrade(mark: FuturesQuotedMark, previous: PreviousMark, at: Date): void {
    const check = acceptableForLiquidation(mark, breakerBasis(previous), at, this.markPolicy);
    if (!check.ok) {
      throw new FuturesError(`Refusing to pay realised profit on this mark — ${check.reason}`, check.code ?? 'trade.mark_unusable', 503);
    }
  }

  /**
   * Active positions: `open` and `closing`. A frozen exit must remain visible
   * and must never render as a normal open (ADR 2026-08-07 done bar 7).
   */
  async listOpen(userId: string, symbol?: string): Promise<Position[]> {
    const rows = symbol
      ? await this.sql<PositionRow[]>`
          SELECT p.*, m.symbol
          FROM trade.positions p
          JOIN trade.markets m ON m.id = p.market_id
          WHERE p.user_id = ${userId}
            AND p.status IN ('open', 'closing')
            AND m.symbol = ${symbol}
          ORDER BY p.opened_at DESC
        `
      : await this.sql<PositionRow[]>`
          SELECT p.*, m.symbol
          FROM trade.positions p
          JOIN trade.markets m ON m.id = p.market_id
          WHERE p.user_id = ${userId}
            AND p.status IN ('open', 'closing')
          ORDER BY p.opened_at DESC
        `;
    // List is not a valuation: no mark source, no invented 0. Close attaches extras.
    return rows.map((row) => presentPosition(row));
  }

  /**
   * Settled history: `closed` and `liquidated`. Empty [] when none — never
   * invents a mark. Open/closing rows stay on listOpen. Optional since is SQL
   * on COALESCE(closed_at, opened_at). Limit is required — missing / non-int /
   * out of 1..500 refuses (never invent 100). Owner/query may pass 100.
   */
  async listClosed(userId: string, input: { symbol?: string; limit: number; sinceMs?: number }): Promise<Position[]> {
    const limit = publishedListClosedLimit(input?.limit);
    const sinceDate = input.sinceMs !== undefined ? new Date(input.sinceMs) : undefined;
    const symbol = input.symbol?.trim() || undefined;
    const rows =
      symbol && sinceDate
        ? await this.sql<PositionRow[]>`
            SELECT p.*, m.symbol
            FROM trade.positions p
            JOIN trade.markets m ON m.id = p.market_id
            WHERE p.user_id = ${userId}
              AND p.status IN ('closed', 'liquidated')
              AND m.symbol = ${symbol}
              AND COALESCE(p.closed_at, p.opened_at) >= ${sinceDate}
            ORDER BY COALESCE(p.closed_at, p.opened_at) DESC
            LIMIT ${limit}
          `
        : symbol
          ? await this.sql<PositionRow[]>`
              SELECT p.*, m.symbol
              FROM trade.positions p
              JOIN trade.markets m ON m.id = p.market_id
              WHERE p.user_id = ${userId}
                AND p.status IN ('closed', 'liquidated')
                AND m.symbol = ${symbol}
              ORDER BY COALESCE(p.closed_at, p.opened_at) DESC
              LIMIT ${limit}
            `
          : sinceDate
            ? await this.sql<PositionRow[]>`
                SELECT p.*, m.symbol
                FROM trade.positions p
                JOIN trade.markets m ON m.id = p.market_id
                WHERE p.user_id = ${userId}
                  AND p.status IN ('closed', 'liquidated')
                  AND COALESCE(p.closed_at, p.opened_at) >= ${sinceDate}
                ORDER BY COALESCE(p.closed_at, p.opened_at) DESC
                LIMIT ${limit}
              `
            : await this.sql<PositionRow[]>`
                SELECT p.*, m.symbol
                FROM trade.positions p
                JOIN trade.markets m ON m.id = p.market_id
                WHERE p.user_id = ${userId}
                  AND p.status IN ('closed', 'liquidated')
                ORDER BY COALESCE(p.closed_at, p.opened_at) DESC
                LIMIT ${limit}
              `;
    return rows.map((row) => presentPosition(row));
  }

  /**
   * One position owned by this user. Closed rows are returned as closed — not
   * hidden, and not revalued. Missing / not theirs is 404 (same answer).
   */
  async get(userId: string, positionId: string): Promise<Position> {
    const id = positionId.trim();
    if (!id) {
      throw new FuturesError('position id is required', 'trade.bad_request', 400);
    }
    const [row] = await this.sql<PositionRow[]>`
      SELECT p.*, m.symbol
      FROM trade.positions p
      JOIN trade.markets m ON m.id = p.market_id
      WHERE p.id = ${id} AND p.user_id = ${userId}
      LIMIT 1
    `;
    if (!row) throw new FuturesError('position not found', 'trade.position_not_found', 404);
    return presentPosition(row);
  }

  async open(input: OpenPositionInput, principal?: Principal): Promise<Position> {
    /**
     * NO POT, NO NEW POSITIONS.
     *
     * Refused before the market lookup and long before any margin is locked. A
     * deployment that has not named a profit source cannot honour a winning
     * position, so letting someone open one would be selling a promise the
     * platform has not funded. Losing and flat CLOSES of positions opened while
     * a pot was configured stay available — see `close()`.
     */
    if (this.deps.profitSource == null) {
      throw new FuturesError(`Futures is not open on this deployment — ${PROFIT_SOURCE_UNCONFIGURED}`, 'trade.futures_unconfigured', 403);
    }

    /**
     * DIRECTION:34 — disclosure before open. Wired in production via
     * `assertAdlDisclosureAcked`; missing ack is a named 403, not a silent open.
     */
    if (this.deps.assertAdlDisclosureAcked) {
      await this.deps.assertAdlDisclosureAcked(input.userId);
    }

    /**
     * IDEMPOTENT OPEN KEY (required) — refuse before mark/ledger.
     * Same clientOpenId → same lock key → ledger no-ops on retry.
     * Parity with spot clientOrderId — omit no longer mints randomUUID (double margin).
     */
    const clientOpenId = input.clientOpenId?.trim() ?? '';
    if (clientOpenId.length === 0 || clientOpenId.length > 64) {
      throw new FuturesError(
        'clientOpenId is required (1–64 chars) — omit would double-lock margin on retry',
        'trade.client_open_id_required',
        400,
      );
    }

    const market = await this.sql<
      {
        id: string;
        symbol: string;
        kind: string;
        status: string;
        quote_asset: string;
        futures_contract_style: 'perpetual' | 'dated' | null;
        futures_expiry_at: Date | null;
        futures_settlement_fixing: string | null;
      }[]
    >`
      SELECT id, symbol, kind, status, quote_asset,
             futures_contract_style, futures_expiry_at, futures_settlement_fixing
      FROM trade.markets
      WHERE symbol = ${input.symbol}
      LIMIT 1
    `;
    const m = market[0];
    if (!m) throw new FuturesError(`unknown market ${input.symbol}`, 'trade.market_not_found', 404);
    const positionId = positionIdFor(input.userId, m.id, clientOpenId);
    const businessId = `position:${positionId}`;
    const original = await this.deps.accountAdmission?.original(input.userId, businessId);
    if (original) {
      const evidence = original.payload as Record<string, unknown>;
      if (canonicalPayload(evidence.request) !== canonicalPayload(businessPayload(input)))
        throw new TradingControlError('operation.conflict');
      if (!principal || principal.userId !== input.userId || !this.deps.accountAdmission)
        throw new TradingControlError('auth.credential_denied');
      await this.deps.accountAdmission.admit(principal, 'order.place', businessId, evidence);
      return this.executeAdmittedPosition(input, evidence);
    }

    if (m.kind !== 'futures') {
      throw new FuturesError(`market ${input.symbol} is ${m.kind}, not futures`, 'trade.not_futures_market', 400);
    }
    if (m.status !== 'active') {
      throw new FuturesError(`market ${input.symbol} is ${m.status}`, 'trade.market_not_tradable', 400);
    }
    try {
      assertDatedFuturesTradable(
        {
          kind: 'futures',
          symbol: m.symbol,
          futuresContractStyle: m.futures_contract_style,
          futuresExpiryAt: m.futures_expiry_at,
          futuresSettlementFixing: m.futures_settlement_fixing,
        },
        { now: new Date() },
      );
    } catch (err) {
      if (err instanceof TradeError) {
        throw new FuturesError(err.message, err.code, err.code === 'trade.dated_futures_expired' ? 403 : 400);
      }
      throw err;
    }

    /**
     * LEVERAGE IS REFUSED BEFORE ANYTHING IS READ, LOCKED OR WRITTEN.
     *
     * First, because it is the cheapest refusal available and needs no mark, no
     * ledger post and no row. Second, and the reason it is here rather than
     * further down: `positions.leverage` is `numeric(8, 2)`, so a leverage of
     * `1000000` used to reach the INSERT and raise Postgres `22003`. The
     * compensating `futuresMarginRelease` fired and no money was stranded, but
     * the caller got a **500** for a request that was simply out of range, and a
     * 500 is the platform saying it broke when in fact it was asked for
     * something it does not offer. Validating here makes it a named 400 that
     * never locked anything, so there is nothing to compensate.
     *
     * The cap is DIRECTION §1 10× unless the host tightened it.
     */
    const leverageCheck = checkLeverage(input.leverage, this.requireLeverageCap());
    if (!leverageCheck.ok) {
      throw new FuturesError(leverageCheck.reason ?? 'leverage refused', leverageCheck.code ?? 'trade.leverage_invalid', 400);
    }

    /**
     * THE SIZE MUST ALSO BE A SIZE. Non-positive size reached `initialMargin`,
     * which threw a bare `Error` and surfaced as a 500 for the same reason
     * leverage did. It is also the denominator of the depth requirement below.
     */
    if (input.size <= 0n) {
      throw new FuturesError(`size must be greater than zero, got ${formatAmount(input.size)}`, 'trade.size_invalid', 400);
    }

    /**
     * THE ENTRY PRICE IS READ, NOT RECEIVED. It sizes the margin lock and it is
     * the basis of every later PnL, so it is a price that moves money.
     *
     * AND IT IS READ AGAINST THIS POSITION'S SIZE. The book behind the mark must
     * be deep enough for the position the mark is about to open, not merely
     * non-dust — `mark-from-depth.ts` argues the relationship. There is no
     * stored row to read the size from yet, and using the caller's is safe in
     * the only direction that matters: the requirement rises with it, and the
     * same number is written verbatim into the row four statements below. A
     * caller who understates it to slip past the gate opens the smaller position
     * they claimed, which is not an attack, it is a smaller trade.
     */
    const at = this.now();
    const mark = await this.markFor(m.id, m.symbol, at, input.size);
    const entryPrice = mark.price;

    // Second door. Named modes refuse here too: the row is what liquidation
    // later reads to decide whose money is at stake. Isolated-only storage stays.
    const modeCheck = checkMarginModeForFuturesOpen(input.marginMode);
    if (!modeCheck.ok) {
      throw new FuturesError(modeCheck.reason, modeCheck.code, 400);
    }
    const collateralCheck = checkCollateralClassForMargin(input.collateralClass);
    if (!collateralCheck.ok) {
      throw new FuturesError(collateralCheck.reason, collateralCheck.code, 400);
    }

    const leverage = input.leverage;
    const marginMode = input.marginMode ?? 'isolated';
    const margin = initialMargin({
      size: input.size,
      entryPrice,
      leverage,
    });
    if (!principal || principal.userId !== input.userId) throw new TradingControlError('auth.credential_denied');
    if (!this.deps.accountAdmission) throw new TradingControlError('authority.unavailable');
    const evidence = businessPayload({
      request: input,
      market: { id: m.id, symbol: m.symbol, quote_asset: m.quote_asset },
      positionId,
      entryPrice,
      leverage,
      marginMode,
      margin,
      at,
    });
    await this.deps.accountAdmission.admit(principal, 'order.place', businessId, evidence);
    return this.executeAdmittedPosition(input, evidence);
  }

  private async executeAdmittedPosition(input: OpenPositionInput, evidence: Record<string, unknown>): Promise<Position> {
    const m = evidence.market as { id: string; symbol: string; quote_asset: string };
    const positionId = String(evidence.positionId);
    const entryPrice = parseAmount(String(evidence.entryPrice));
    const leverage = parseAmount(String(evidence.leverage));
    const marginMode = String(evidence.marginMode);
    const margin = parseAmount(String(evidence.margin));
    const at = new Date(String(evidence.at));
    const [existing] = await this.sql<PositionRow[]>`SELECT p.*, m.symbol FROM trade.positions p
      JOIN trade.markets m ON m.id = p.market_id WHERE p.id = ${positionId} AND p.user_id = ${input.userId}`;
    if (existing) return presentPosition(existing);
    // Money first — never a position row without a ledger claim.
    await this.ledger.post(
      recipes.futuresMarginLock({
        positionId,
        userId: input.userId,
        assetId: m.quote_asset,
        amount: margin,
      }),
    );

    try {
      /**
       * THE BREAKER IS ARMED FROM BIRTH.
       *
       * `accepted_mark` is seeded with the entry mark, because the entry mark is
       * a price this platform read and acted on: it sized the margin lock. So a
       * position's very first close already has something to be measured
       * against, and the legitimately-unarmed `first_valuation` case narrows to
       * rows that predate `0007_position_accepted_mark.sql`.
       *
       * Seeding it here is safe in the direction that matters. An attacker who
       * pumps the feed BEFORE opening buys in at the pumped price and has
       * nothing to realise; the only way to profit from a jump is to make it
       * after entry, and that is precisely what this number now catches.
       */
      await this.sql`
        INSERT INTO trade.positions (
          id, user_id, market_id, side, status, margin_mode,
          size, entry_price, leverage, margin_initial, margin_current, margin_asset, funding_paid,
          accepted_mark, accepted_mark_at
        ) VALUES (
          ${positionId},
          ${input.userId},
          ${m.id},
          ${input.side},
          'open',
          ${marginMode},
          ${formatAmount(input.size)},
          ${formatAmount(entryPrice)},
          ${formatAmount(leverage)},
          ${formatAmount(margin)},
          ${formatAmount(margin)},
          ${m.quote_asset},
          '0',
          ${formatAmount(entryPrice)},
          ${at}
        )
      `;
    } catch (err) {
      /**
       * RETRY PATH. Same clientOpenId already wrote this row (or a concurrent
       * open with the same key won the race). Do not release the lock we just
       * no-op'd on — the original position still owns it. Re-read and return.
       * Other failures still release (unique open on a *different* id, etc.).
       */
      {
        const existing = await this.sql<PositionRow[]>`
          SELECT p.*, m.symbol
          FROM trade.positions p
          JOIN trade.markets m ON m.id = p.market_id
          WHERE p.id = ${positionId}
          LIMIT 1
        `;
        if (existing[0]) {
          return presentPosition(existing[0]);
        }
      }
      // Roll margin back if the row failed (unique open, etc.).
      await this.ledger.post(
        recipes.futuresMarginRelease({
          positionId,
          userId: input.userId,
          assetId: m.quote_asset,
          amount: margin,
          sequence: 1,
        }),
      );
      throw err;
    }

    const [row] = await this.sql<PositionRow[]>`
      SELECT p.*, m.symbol
      FROM trade.positions p
      JOIN trade.markets m ON m.id = p.market_id
      WHERE p.id = ${positionId}
    `;
    await this.publishPositionUpdated(row!);
    return presentPosition(row!);
  }

  /** Owned recovery hook, independent of live credentials; no public receipt is accepted. */
  async recoverAdmittedPosition(userId: string, positionId: string): Promise<Position | null> {
    if (!this.deps.accountAdmission) throw new TradingControlError('authority.unavailable');
    const original = await this.deps.accountAdmission.resolve(userId, `position:${positionId}`);
    if (!original) return null;
    const evidence = original.payload as Record<string, unknown>;
    const wire = evidence.request as Record<string, unknown>;
    if (wire.userId !== userId || evidence.positionId !== positionId) throw new TradingControlError('operation.conflict');
    const input = {
      ...wire,
      size: parseAmount(String(wire.size)),
      leverage: parseAmount(String(wire.leverage)),
    } as unknown as OpenPositionInput;
    return this.executeAdmittedPosition(input, evidence);
  }

  /**
   * Live isolated re-leverage within the explicit owner/listing cap.
   *
   * Extra IM is `futuresMarginAdd`; excess is `futuresMarginRelease`. Open lock
   * keys once per position, so a second `futuresMarginLock` would no-op.
   * Close residual release already uses sequence 1 — adjusts start at 2.
   *
   * Refuses without posting when the new IM would leave equity ≤ 0 at the
   * current mark (D3 maintenance unset — equity only) or when the extra lock
   * cannot be funded. Does not invent funding, a liq-price, or a profit source.
   */
  async setLeverage(input: SetLeverageInput, principal?: Principal): Promise<Position> {
    const leverageCheck = checkLeverage(input.leverage, this.requireLeverageCap());
    if (!leverageCheck.ok) {
      throw new FuturesError(leverageCheck.reason ?? 'leverage refused', leverageCheck.code ?? 'trade.leverage_invalid', 400);
    }

    const symbol = input.symbol.trim();
    if (!symbol) {
      throw new FuturesError('symbol is required', 'trade.bad_request', 400);
    }

    const request = `leverage:${formatAmount(input.leverage)}`;
    const adjustmentId = input.clientAdjustmentId?.trim() || request;
    const claimed = { ...input, symbol };
    const completed = await this.claimMarginAdjustment(claimed, adjustmentId, request);
    if (completed) return completed;
    let ledgerAttempted = false;
    try {
      const row = await this.sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL lock_timeout = ${CLOSE_LOCK_TIMEOUT_MS}`);

        const locked = input.positionId
          ? await tx<PositionRow[]>`
              SELECT p.*, m.symbol
              FROM trade.positions p
              JOIN trade.markets m ON m.id = p.market_id
              WHERE p.id = ${input.positionId} AND p.user_id = ${input.userId}
              LIMIT 1
              FOR UPDATE OF p
            `
          : await tx<PositionRow[]>`
              SELECT p.*, m.symbol
              FROM trade.positions p
              JOIN trade.markets m ON m.id = p.market_id
              WHERE p.user_id = ${input.userId}
                AND m.symbol = ${symbol}
                AND p.status = 'open'
              FOR UPDATE OF p
            `;

        if (input.positionId) {
          if (!locked[0]) throw new FuturesError('position not found', 'trade.position_not_found', 404);
        } else if (locked.length === 0) {
          throw new FuturesError(`no open position on ${symbol}`, 'trade.position_not_found', 404);
        } else if (locked.length > 1) {
          throw new FuturesError(`more than one open position on ${symbol} — pass position id`, 'trade.position_ambiguous', 400);
        }

        const row = locked[0]!;
        if (row.symbol !== symbol) {
          throw new FuturesError(`position is on ${row.symbol}, not ${symbol}`, 'trade.symbol_mismatch', 400);
        }
        if (row.status !== 'open') {
          throw new FuturesError(`position is ${row.status}`, 'trade.position_not_open', 400);
        }
        if (row.margin_mode !== 'isolated') {
          throw new FuturesError('live re-leverage is isolated-only — margin mode is set at open', 'trade.cross_margin_unsupported', 400);
        }
        const replay = await this.completedMarginAdjustment(tx, row.id, adjustmentId, request);
        if (replay) return replay;

        const currentLeverage = parseAmount(row.leverage);
        if (currentLeverage === input.leverage) {
          await tx`UPDATE trade.positions SET margin_adjust_request = NULL, updated_at = now()
            WHERE id = ${row.id} AND margin_adjust_request = ${adjustmentId}`;
          const result = presentPosition(row);
          await tx`UPDATE trade.position_margin_adjustments
            SET status = 'completed', result = ${tx.json(result)}, completed_at = now()
            WHERE position_id = ${row.id} AND client_adjustment_id = ${adjustmentId} AND status = 'pending'`;
          return row;
        }

        const size = parseAmount(row.size);
        const entryPrice = parseAmount(row.entry_price);
        const currentMargin = parseAmount(row.margin_current ?? row.margin_initial);
        const target = initialMargin({ size, entryPrice, leverage: input.leverage });

        const at = this.now();
        const mark = await this.markFor(row.market_id, row.symbol, at, size);
        const wouldLiq = planLiquidation({
          liquidationId: `re-leverage-gate:${row.id}`,
          position: {
            positionId: row.id,
            userId: input.userId,
            side: row.side,
            size,
            entryPrice,
            margin: target,
            marginAsset: row.margin_asset,
          },
          markPrice: formatAmount(mark.price),
        });
        if (wouldLiq.liquidate) {
          throw new FuturesError(
            `refusing leverage ${formatAmount(input.leverage)}x — new isolated margin would already be in liquidation at the current mark`,
            LEVERAGE_WOULD_LIQUIDATE,
            400,
          );
        }

        if (input.leverage > currentLeverage) {
          if (!principal || principal.userId !== input.userId) throw new TradingControlError('auth.credential_denied');
          if (!this.deps.accountAdmission) throw new TradingControlError('authority.unavailable');
          await this.deps.accountAdmission.admit(
            principal,
            'order.increase',
            `position.leverage:${row.id}:${adjustmentId}`,
            businessPayload({
              positionId: row.id,
              adjustmentId,
              size,
              entryPrice,
              currentMargin,
              target,
              leverage: input.leverage,
              assetId: row.margin_asset,
            }),
          );
        }

        const delta = target - currentMargin;
        const prevSeq = Number(row.margin_adjust_seq);
        const seq = (Number.isFinite(prevSeq) && prevSeq >= 1 ? prevSeq : 1) + 1;

        if (delta > 0n) {
          const available = await this.ledger.balance(userAvailable(input.userId, row.margin_asset));
          if (available.amount < delta) {
            throw new FuturesError(
              `need ${formatAmount(delta)} ${row.margin_asset} extra isolated margin, have ${formatAmount(available.amount)}`,
              LEVERAGE_INSUFFICIENT_MARGIN,
              400,
            );
          }
          ledgerAttempted = true;
          await this.ledger.post(
            recipes.futuresMarginAdd({
              positionId: row.id,
              userId: input.userId,
              assetId: row.margin_asset,
              amount: delta,
              sequence: seq,
            }),
          );
        } else if (delta < 0n) {
          ledgerAttempted = true;
          await this.ledger.post(
            recipes.futuresMarginRelease({
              positionId: row.id,
              userId: input.userId,
              assetId: row.margin_asset,
              amount: -delta,
              sequence: seq,
            }),
          );
        }
        if (ledgerAttempted) await this.afterMarginLedgerPost?.(request);

        const [updated] = await tx<PositionRow[]>`
          UPDATE trade.positions p
          SET leverage = ${formatAmount(input.leverage)},
              margin_initial = ${formatAmount(target)},
              margin_current = ${formatAmount(target)},
              margin_adjust_seq = ${seq},
              margin_adjust_request = NULL,
              updated_at = now()
          FROM trade.markets m
          WHERE p.id = ${row.id}
            AND p.user_id = ${input.userId}
            AND p.status = 'open'
            AND m.id = p.market_id
          RETURNING p.*, m.symbol
        `;
        if (!updated) {
          throw new FuturesError('position changed underneath this leverage update', 'trade.position_not_open', 409);
        }
        const result = presentPosition(updated);
        await tx`UPDATE trade.position_margin_adjustments
          SET status = 'completed', result = ${tx.json(result)}, completed_at = now()
          WHERE position_id = ${row.id} AND client_adjustment_id = ${adjustmentId} AND status = 'pending'`;
        return updated;
      });

      if (!('user_id' in row)) return row;
      await this.publishPositionUpdated(row);
      return presentPosition(row);
    } catch (err) {
      if (!ledgerAttempted) await this.abandonMarginAdjustment(claimed, adjustmentId);
      if (isLockTimeout(err)) {
        throw new FuturesError(
          'another mutation of this position is already in flight — retry in a moment',
          'trade.close_in_progress',
          409,
        );
      }
      throw err;
    }
  }

  /**
   * Isolated extra collateral — `futuresMarginAdd` only. Does not change
   * leverage or IM, and does not flip margin mode. Add-only: amount must be > 0.
   */
  async addIsolatedMargin(input: AddIsolatedMarginInput): Promise<Position> {
    const collateralCheck = checkCollateralClassForMargin(input.collateralClass);
    if (!collateralCheck.ok) {
      throw new FuturesError(collateralCheck.reason, collateralCheck.code, 400);
    }
    if (input.amount <= 0n) {
      throw new FuturesError('isolated margin add must be a positive decimal amount', 'trade.bad_request', 400);
    }

    const symbol = input.symbol.trim();
    if (!symbol) {
      throw new FuturesError('symbol is required', 'trade.bad_request', 400);
    }

    const request = `add:${formatAmount(input.amount)}`;
    const adjustmentId = input.clientAdjustmentId?.trim() || request;
    const claimed = { ...input, symbol };
    const completed = await this.claimMarginAdjustment(claimed, adjustmentId, request);
    if (completed) return completed;
    let ledgerAttempted = false;
    try {
      const row = await this.sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL lock_timeout = ${CLOSE_LOCK_TIMEOUT_MS}`);

        const locked = input.positionId
          ? await tx<PositionRow[]>`
              SELECT p.*, m.symbol
              FROM trade.positions p
              JOIN trade.markets m ON m.id = p.market_id
              WHERE p.id = ${input.positionId} AND p.user_id = ${input.userId}
              LIMIT 1
              FOR UPDATE OF p
            `
          : await tx<PositionRow[]>`
              SELECT p.*, m.symbol
              FROM trade.positions p
              JOIN trade.markets m ON m.id = p.market_id
              WHERE p.user_id = ${input.userId}
                AND m.symbol = ${symbol}
                AND p.status = 'open'
              FOR UPDATE OF p
            `;

        if (input.positionId) {
          if (!locked[0]) throw new FuturesError('position not found', 'trade.position_not_found', 404);
        } else if (locked.length === 0) {
          throw new FuturesError(`no open position on ${symbol}`, 'trade.position_not_found', 404);
        } else if (locked.length > 1) {
          throw new FuturesError(`more than one open position on ${symbol} — pass position id`, 'trade.position_ambiguous', 400);
        }

        const row = locked[0]!;
        if (row.symbol !== symbol) {
          throw new FuturesError(`position is on ${row.symbol}, not ${symbol}`, 'trade.symbol_mismatch', 400);
        }
        if (row.status !== 'open') {
          throw new FuturesError(`position is ${row.status}`, 'trade.position_not_open', 400);
        }
        if (row.margin_mode !== 'isolated') {
          throw new FuturesError('live margin add is isolated-only — margin mode is set at open', 'trade.cross_margin_unsupported', 400);
        }
        const replay = await this.completedMarginAdjustment(tx, row.id, adjustmentId, request);
        if (replay) return replay;

        const currentMargin = parseAmount(row.margin_current ?? row.margin_initial);
        const nextMargin = currentMargin + input.amount;
        const prevSeq = Number(row.margin_adjust_seq);
        const seq = (Number.isFinite(prevSeq) && prevSeq >= 1 ? prevSeq : 1) + 1;

        const available = await this.ledger.balance(userAvailable(input.userId, row.margin_asset));
        if (available.amount < input.amount) {
          throw new FuturesError(
            `need ${formatAmount(input.amount)} ${row.margin_asset} extra isolated margin, have ${formatAmount(available.amount)}`,
            LEVERAGE_INSUFFICIENT_MARGIN,
            400,
          );
        }

        ledgerAttempted = true;
        await this.ledger.post(
          recipes.futuresMarginAdd({
            positionId: row.id,
            userId: input.userId,
            assetId: row.margin_asset,
            amount: input.amount,
            sequence: seq,
          }),
        );
        await this.afterMarginLedgerPost?.(request);

        const [updated] = await tx<PositionRow[]>`
          UPDATE trade.positions p
          SET margin_current = ${formatAmount(nextMargin)},
              margin_adjust_seq = ${seq},
              margin_adjust_request = NULL,
              updated_at = now()
          FROM trade.markets m
          WHERE p.id = ${row.id}
            AND p.user_id = ${input.userId}
            AND p.status = 'open'
            AND m.id = p.market_id
          RETURNING p.*, m.symbol
        `;
        if (!updated) {
          throw new FuturesError('position changed underneath this margin add', 'trade.position_not_open', 409);
        }
        const result = presentPosition(updated);
        await tx`UPDATE trade.position_margin_adjustments
          SET status = 'completed', result = ${tx.json(result)}, completed_at = now()
          WHERE position_id = ${row.id} AND client_adjustment_id = ${adjustmentId} AND status = 'pending'`;
        return updated;
      });

      if (!('user_id' in row)) return row;
      await this.publishPositionUpdated(row);
      return presentPosition(row);
    } catch (err) {
      if (!ledgerAttempted) await this.abandonMarginAdjustment(claimed, adjustmentId);
      if (isLockTimeout(err)) {
        throw new FuturesError(
          'another mutation of this position is already in flight — retry in a moment',
          'trade.close_in_progress',
          409,
        );
      }
      throw err;
    }
  }

  /**
   * Isolated excess collateral out — `futuresMarginRelease` only. Does not
   * change leverage or IM. Cannot pull below `margin_initial`. Refuses without
   * posting when the remaining isolated margin would already be in liquidation
   * at the current mark.
   */
  async reduceIsolatedMargin(input: ReduceIsolatedMarginInput): Promise<Position> {
    if (input.amount <= 0n) {
      throw new FuturesError('isolated margin reduce must be a positive decimal amount', 'trade.bad_request', 400);
    }

    const symbol = input.symbol.trim();
    if (!symbol) {
      throw new FuturesError('symbol is required', 'trade.bad_request', 400);
    }

    const request = `release:${formatAmount(input.amount)}`;
    const adjustmentId = input.clientAdjustmentId?.trim() || request;
    const claimed = { ...input, symbol };
    const completed = await this.claimMarginAdjustment(claimed, adjustmentId, request);
    if (completed) return completed;
    let ledgerAttempted = false;
    try {
      const row = await this.sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL lock_timeout = ${CLOSE_LOCK_TIMEOUT_MS}`);

        const locked = input.positionId
          ? await tx<PositionRow[]>`
              SELECT p.*, m.symbol
              FROM trade.positions p
              JOIN trade.markets m ON m.id = p.market_id
              WHERE p.id = ${input.positionId} AND p.user_id = ${input.userId}
              LIMIT 1
              FOR UPDATE OF p
            `
          : await tx<PositionRow[]>`
              SELECT p.*, m.symbol
              FROM trade.positions p
              JOIN trade.markets m ON m.id = p.market_id
              WHERE p.user_id = ${input.userId}
                AND m.symbol = ${symbol}
                AND p.status = 'open'
              FOR UPDATE OF p
            `;

        if (input.positionId) {
          if (!locked[0]) throw new FuturesError('position not found', 'trade.position_not_found', 404);
        } else if (locked.length === 0) {
          throw new FuturesError(`no open position on ${symbol}`, 'trade.position_not_found', 404);
        } else if (locked.length > 1) {
          throw new FuturesError(`more than one open position on ${symbol} — pass position id`, 'trade.position_ambiguous', 400);
        }

        const row = locked[0]!;
        if (row.symbol !== symbol) {
          throw new FuturesError(`position is on ${row.symbol}, not ${symbol}`, 'trade.symbol_mismatch', 400);
        }
        if (row.status !== 'open') {
          throw new FuturesError(`position is ${row.status}`, 'trade.position_not_open', 400);
        }
        if (row.margin_mode !== 'isolated') {
          throw new FuturesError('live margin reduce is isolated-only — margin mode is set at open', 'trade.cross_margin_unsupported', 400);
        }
        const replay = await this.completedMarginAdjustment(tx, row.id, adjustmentId, request);
        if (replay) return replay;

        const currentMargin = parseAmount(row.margin_current ?? row.margin_initial);
        const initial = parseAmount(row.margin_initial);
        const nextMargin = currentMargin - input.amount;
        if (nextMargin < initial) {
          throw new FuturesError(
            `refusing to pull isolated margin below initial ${formatAmount(initial)} ${row.margin_asset}`,
            MARGIN_BELOW_INITIAL,
            400,
          );
        }

        const size = parseAmount(row.size);
        const entryPrice = parseAmount(row.entry_price);
        const at = this.now();
        const mark = await this.markFor(row.market_id, row.symbol, at, size);
        const wouldLiq = planLiquidation({
          liquidationId: `margin-reduce-gate:${row.id}`,
          position: {
            positionId: row.id,
            userId: input.userId,
            side: row.side,
            size,
            entryPrice,
            margin: nextMargin,
            marginAsset: row.margin_asset,
          },
          markPrice: formatAmount(mark.price),
        });
        if (wouldLiq.liquidate) {
          throw new FuturesError(
            `refusing isolated margin reduce — remaining collateral would already be in liquidation at the current mark`,
            MARGIN_WOULD_LIQUIDATE,
            400,
          );
        }

        const prevSeq = Number(row.margin_adjust_seq);
        const seq = (Number.isFinite(prevSeq) && prevSeq >= 1 ? prevSeq : 1) + 1;

        ledgerAttempted = true;
        await this.ledger.post(
          recipes.futuresMarginRelease({
            positionId: row.id,
            userId: input.userId,
            assetId: row.margin_asset,
            amount: input.amount,
            sequence: seq,
          }),
        );
        await this.afterMarginLedgerPost?.(request);

        const [updated] = await tx<PositionRow[]>`
          UPDATE trade.positions p
          SET margin_current = ${formatAmount(nextMargin)},
              margin_adjust_seq = ${seq},
              margin_adjust_request = NULL,
              updated_at = now()
          FROM trade.markets m
          WHERE p.id = ${row.id}
            AND p.user_id = ${input.userId}
            AND p.status = 'open'
            AND m.id = p.market_id
          RETURNING p.*, m.symbol
        `;
        if (!updated) {
          throw new FuturesError('position changed underneath this margin reduce', 'trade.position_not_open', 409);
        }
        const result = presentPosition(updated);
        await tx`UPDATE trade.position_margin_adjustments
          SET status = 'completed', result = ${tx.json(result)}, completed_at = now()
          WHERE position_id = ${row.id} AND client_adjustment_id = ${adjustmentId} AND status = 'pending'`;
        return updated;
      });

      if (!('user_id' in row)) return row;
      await this.publishPositionUpdated(row);
      return presentPosition(row);
    } catch (err) {
      if (!ledgerAttempted) await this.abandonMarginAdjustment(claimed, adjustmentId);
      if (isLockTimeout(err)) {
        throw new FuturesError(
          'another mutation of this position is already in flight — retry in a moment',
          'trade.close_in_progress',
          409,
        );
      }
      throw err;
    }
  }

  /**
   * Close an open position at the CURRENT MARK — read from the mark port, never
   * supplied by the trader being paid.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * WHY THIS IS A TRANSACTION AND NOT A SEQUENCE OF STATEMENTS
   * ───────────────────────────────────────────────────────────────────────────
   *
   * It used to be: `SELECT … status='open'` → read the mark → check the bound →
   * `ledger.post` × N → `UPDATE … status='closed'`. Every one of those steps was
   * correct on its own and the whole was a money drain, because there was no
   * lock, no transaction, and the idempotency key was minted per ATTEMPT:
   *
   *     closeId: `close:${row.id}:${randomUUID()}`
   *
   * `futuresRealizeProfit` keys on `futures.profit:${profitId}`, so a fresh UUID
   * per attempt meant the ledger had no way to recognise a duplicate and every
   * concurrent DELETE was a genuinely new payout. `futuresMarginRelease` keys on
   * `positionId:sequence`, so the margin release WAS deduped — which is why only
   * the profit multiplied, and why counting successful responses would have
   * shown nothing wrong.
   *
   * Eight concurrent closes of one position paid 5000 of honest PnL eight times.
   * The payout bound did not save it: each attempt read the pot's balance before
   * any of them had drained it, so the ceiling landed on the pot's whole balance
   * instead of on the honest PnL. That is the ADR's sentence failing again in a
   * new costume — *a price that moves money is never supplied by the party it
   * pays* — because the party being paid still chose the amount, this time
   * through N rather than through `exitPrice`.
   *
   * The window needs a yield between reading the row and writing it, and
   * production always has one: `markFor()` is an HTTP round trip.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * TWO MECHANISMS, AND BOTH ARE LOAD-BEARING
   * ───────────────────────────────────────────────────────────────────────────
   *
   * **`SELECT … FOR UPDATE` inside a transaction that spans the posts and the
   * status write.** Concurrent closes of one position serialise on the row: the
   * first commits, the rest are released, re-read the row they were waiting on,
   * find it `closed` and refuse — before they post anything. This works across
   * replicas, which an in-process mutex would not, and the lock is on ONE row so
   * closes of other positions are unaffected.
   *
   * **An idempotency key derived from the position, not from the attempt.**
   * `closeId` is now `close:${row.id}` — stable. A lock only orders attempts
   * that overlap in time, and the sequential form of this bug does not: put the
   * row back to `open` by a replay, a restore or an operator's UPDATE and a
   * second close races nothing at all. The stable key is what stops that one,
   * and it is also what covers the gap the transaction cannot close by itself —
   * the ledger is a different system, so a commit that fails after the posts
   * succeeded leaves the row open with the money already moved, and the retry
   * must not pay again. It does not: the ledger returns the original
   * transaction.
   *
   * Neither mechanism subsumes the other, so reverting either one is caught by
   * `position-close-concurrency.test.ts`.
   *
   * Nothing posts until every refusal has been cleared, and a refusal rolls the
   * transaction back: a close that is going to be refused leaves the books and
   * the row exactly as it found them.
   */
  async close(userId: string, positionId: string): Promise<Position> {
    const outcome = await this.closeAtomically(userId, positionId);
    await this.publishPositionUpdated(outcome.row, outcome.extras);
    return presentPosition(outcome.row, outcome.extras);
  }

  private async closeAtomically(
    userId: string,
    positionId: string,
  ): Promise<{ row: PositionRow; extras: { markPrice: string | null; realizedPnl: string | null } }> {
    try {
      return await this.sql.begin(async (tx) => {
        // Bounded, so a wedged ledger call cannot pin one pooled connection per
        // queued attempt for as long as it likes. LOCAL — it dies with the
        // transaction and never leaks onto the next borrower of this connection.
        // `unsafe` because SET does not take a bind parameter. The interpolated
        // value is a module constant integer — no caller input reaches this.
        await tx.unsafe(`SET LOCAL lock_timeout = ${CLOSE_LOCK_TIMEOUT_MS}`);

        /**
         * `FOR UPDATE OF p` — the POSITION row only. Locking the joined market
         * row as well would serialise every close on that market against every
         * other, which is a throughput bug wearing a correctness costume.
         *
         * Under READ COMMITTED a waiter re-reads the row after the lock frees,
         * so it sees `status = 'closed'` written by the transaction it was
         * queued behind, not the stale `open` it originally matched.
         */
        const [row] = await tx<PositionRow[]>`
          SELECT p.*, m.symbol
          FROM trade.positions p
          JOIN trade.markets m ON m.id = p.market_id
          WHERE p.id = ${positionId} AND p.user_id = ${userId}
          LIMIT 1
          FOR UPDATE OF p
        `;
        if (!row) throw new FuturesError('position not found', 'trade.position_not_found', 404);
        if (row.status !== 'open' && row.status !== 'closing') {
          throw new FuturesError(`position is ${row.status}`, 'trade.position_not_open', 400);
        }

        /**
         * THE STAKE, TAKEN OFF THE LOCKED ROW.
         *
         * `row.size` — the position as the platform wrote it, read inside the
         * same `FOR UPDATE` as the close it is about to gate. Not the request:
         * the DELETE that reaches this method carries a position id and nothing
         * else, and `docs/adr/2026-08-05-futures-risk-and-mark-law.md` would
         * forbid it if it did. *A price that moves money is never supplied by
         * the party it pays* — and the size that decides which prices are
         * ACCEPTED is part of that price.
         *
         * This is the number the depth requirement is a fraction of. A close of
         * 500 contracts must find a book that can absorb a defined slice of 500
         * contracts, not a book that clears a fixed floor set for a book that
         * might have been pricing anything at all.
         */
        const at = this.now();
        const authorisesSize = parseAmount(row.size);
        const markOrDark = await this.tryMarkForMarking(row.market_id, row.symbol, at, authorisesSize);

        /**
         * EXIT WHEN THE FEED IS DARK.
         *
         * Valuing is something the platform does TO a trader — refuse without a
         * mark. Releasing is something the trader asks for — without a mark the
         * platform may not price the exit, but it also may not keep them in the
         * trade. Freeze: no funding, no liquidation, settle later.
         * ADR: `docs/adr/2026-08-07-futures-exit-when-the-feed-is-dark.md`.
         */
        if (!markOrDark.ok) {
          if (row.status === 'closing') {
            // Idempotent retry while still dark — same row, not an error.
            return { row, extras: { markPrice: null, realizedPnl: null } };
          }
          const [frozen] = await tx<PositionRow[]>`
            UPDATE trade.positions p
            SET status = 'closing',
                closing_reason = ${markOrDark.reason},
                updated_at = now()
            FROM trade.markets m
            WHERE p.id = ${positionId}
              AND p.user_id = ${userId}
              AND p.status = 'open'
              AND m.id = p.market_id
            RETURNING p.*, m.symbol
          `;
          if (!frozen) {
            throw new FuturesError('position changed underneath this close', 'trade.position_not_open', 409);
          }
          return { row: frozen, extras: { markPrice: null, realizedPnl: null } };
        }

        const mark = markOrDark.mark;

        /**
         * The breaker's basis, read off the row this transaction already holds
         * under `FOR UPDATE`. Not a second query: it has to be the same row, the
         * same lock and the same snapshot as the close it is judging, or two
         * concurrent closes could each be measured against a basis the other one
         * had already moved.
         */
        const previous = readAcceptedMark(row);

        /**
         * CLOSING SETTLES AT FREEZE-TIME `accepted_mark` (Denon handoff 2026-08-09
         * §§3–4; ADR 2026-08-07 property 2).
         *
         * A `closing` row means the trader already asked to leave while the feed
         * was dark. Charging (or paying) the move that happened during our outage
         * is mark-driven loss/gain after exit. The current mark only *triggers*
         * settlement (feed is usable again); the exit price is the last basis we
         * already accepted on this position. Fail closed if that basis is missing
         * (pre-0007 rows) rather than inventing a price from the fresh mark.
         */
        const settlingFromClosing = row.status === 'closing';
        let exitPrice: string;
        if (settlingFromClosing) {
          if (row.accepted_mark == null || row.accepted_mark.trim() === '') {
            throw new FuturesError(
              'closing position has no accepted_mark to settle at — refuse invent from current mark',
              'trade.closing_basis_missing',
              503,
            );
          }
          exitPrice = formatAmount(parseAmount(row.accepted_mark));
        } else {
          exitPrice = formatAmount(mark.price);
        }

        const plan = planClose({
          // STABLE, not per attempt. See the header — this is half the fix.
          closeId: closeIdFor(row.id),
          position: {
            positionId: row.id,
            userId,
            side: row.side,
            size: parseAmount(row.size),
            entryPrice: parseAmount(row.entry_price),
            margin: parseAmount(row.margin_current ?? row.margin_initial),
            marginAsset: row.margin_asset,
          },
          exitPrice,
        });
        if (!plan.close) {
          throw new FuturesError(`cannot close: ${plan.reason}`, 'trade.close_refused', 400);
        }

        if (plan.profit > 0n) {
          // Money is about to leave the platform on the strength of this mark, so it
          // has to be a mark we would seize on — except when settling from
          // `closing` at freeze-time accepted_mark: that basis was already gated
          // when stored, and the current mid-gap mark must not re-price the exit
          // (breaker trap / dark-period charge — Denon §§3–4).
          if (!settlingFromClosing) {
            this.requirePayoutGrade(mark, previous, at);
          }

          /**
           * NO NAMED POT, NO PAYOUT. The deployment never chose an account for
           * realised profit, so there is nothing to pay from and nothing to
           * bound — and paying from an unnamed one is exactly what the ADR
           * forbids. The trader is not trapped: a losing or flat close is
           * untouched by this branch and still returns their margin.
           */
          const source = this.deps.profitSource;
          if (source == null) {
            throw new FuturesError(
              `Cannot realise ${formatAmount(plan.profit)} ${row.margin_asset} of profit — ${PROFIT_SOURCE_UNCONFIGURED}`,
              'trade.profit_source_unconfigured',
              403,
            );
          }

          /**
           * THE PAYOUT BOUND. `bank.pool_underfunded`'s shape: an under-funded
           * profit source is an operator problem at the moment of the trade, not an
           * accounting surprise later. Checked before the first post, so a refusal
           * cannot leave the margin released and the position half closed.
           *
           * Read inside the row lock now, which is also what makes it mean what
           * it says: concurrent closes of one position used to read this balance
           * before any of them had spent it.
           */
          const bound = await checkProfitBound({
            source,
            assetId: row.margin_asset,
            amount: plan.profit,
            balance: (ref) => this.ledger.balance(ref),
          });
          if (!bound.ok) {
            throw new FuturesError(
              `Cannot realise ${formatAmount(plan.profit)} ${row.margin_asset} of profit — ${bound.reason}`,
              'trade.profit_source_underfunded',
              409,
            );
          }
        }

        /**
         * INSURANCE SHORTFALL BOUND (voluntary close). Same law as the
         * liquidation tick: a loss past margin is not cover the house invents.
         * Checked before the first post so a refusal cannot leave margin moved
         * and the position half-closed.
         */
        if (plan.fromInsurance > 0n) {
          const insurance = await checkInsuranceBound({
            assetId: row.margin_asset,
            fromInsurance: plan.fromInsurance,
            balance: (ref) => this.ledger.balance(ref),
          });
          if (!insurance.ok) {
            throw new FuturesError(`Cannot close through insurance shortfall — ${insurance.reason}`, INSURANCE_UNDERFUNDED, 409);
          }
        }

        for (const recipe of plan.recipes) {
          await this.ledger.post(recipe);
        }

        /**
         * `accepted_mark` moves here and nowhere else on this path — INSIDE the
         * transaction, after every refusal has been cleared. That is what makes
         * the breaker unratchetable: a close that is refused rolls this write
         * back with the rest of the transaction, so a caller cannot walk the
         * basis upward in sub-breaker steps by making attempts that fail. The
         * basis only ever moves to a mark the platform actually settled on.
         *
         * Settling from `closing` clears `closing_reason` with the status write.
         * `accepted_mark` records the exit we actually settled at (freeze basis
         * when closing; current mark on ordinary open→closed).
         */
        const [closed] = await tx<PositionRow[]>`
          UPDATE trade.positions p
          SET status = 'closed',
              closed_at = now(),
              updated_at = now(),
              closing_reason = NULL,
              accepted_mark = ${exitPrice},
              accepted_mark_at = ${at}
          FROM trade.markets m
          WHERE p.id = ${positionId}
            AND p.user_id = ${userId}
            AND p.status IN ('open', 'closing')
            AND m.id = p.market_id
          RETURNING p.*, m.symbol
        `;
        /**
         * Unreachable while the lock holds — and asserted rather than assumed,
         * because if it ever became reachable the money would already have moved
         * and the row would still say `open`/`closing`. Throwing rolls the status
         * write back; the ledger posts stand, and the stable close key means the
         * retry that follows settles them once, not twice.
         */
        if (!closed) {
          throw new FuturesError('position changed underneath this close', 'trade.position_not_open', 409);
        }

        return {
          row: closed,
          extras: {
            markPrice: formatAmount(plan.exitPrice),
            realizedPnl: formatAmount(plan.realizedPnl),
          },
        };
      });
    } catch (err) {
      if (isLockTimeout(err)) {
        throw new FuturesError('another close of this position is already in flight — retry in a moment', 'trade.close_in_progress', 409);
      }
      throw err;
    }
  }

  /** Fan-out for private WS — honest nulls for mark/PnL until known. */
  private async publishPositionUpdated(
    row: PositionRow,
    extras?: { markPrice?: string | null; realizedPnl?: string | null },
  ): Promise<void> {
    if (!this.bus) return;
    const size = parseAmount(row.size);
    const entry = parseAmount(row.entry_price);
    const SCALE = 10n ** 18n;
    const notional = (size * entry) / SCALE;
    const ts = new Date().toISOString();
    await this.bus.publish(
      'positionUpdated',
      {
        positionId: row.id,
        userId: row.user_id,
        marketId: row.market_id,
        symbol: row.symbol,
        status: row.status,
        side: row.side,
        contracts: formatAmount(size),
        entryPrice: formatAmount(entry),
        markPrice: extras?.markPrice ?? null,
        notional: formatAmount(notional),
        leverage: formatAmount(parseAmount(row.leverage)),
        collateral: formatAmount(parseAmount(row.margin_current ?? row.margin_initial)),
        unrealizedPnl: null,
        realizedPnl: extras?.realizedPnl ?? null,
        liquidationPrice: row.liq_price != null ? formatAmount(parseAmount(row.liq_price)) : null,
        marginMode: row.margin_mode,
        fundingPaid: formatAmount(parseAmount(row.funding_paid ?? '0')),
        closingReason: row.status === 'closing' ? (row.closing_reason ?? null) : null,
        ts,
      },
      { idempotencyKey: `trade.position.updated:${row.id}:${row.status}:${ts}` },
    );
  }
}

function presentPosition(row: PositionRow, extras?: { markPrice?: string | null; realizedPnl?: string | null }): Position {
  const size = parseAmount(row.size);
  const entry = parseAmount(row.entry_price);
  const leverage = parseAmount(row.leverage);
  // W4 R6: collateral = residual margin; initialMargin stays the open stake.
  // After funding debits, margin_current drops while margin_initial does not —
  // reporting both as residual lied to every client risk view.
  const marginCurrent = parseAmount(row.margin_current ?? row.margin_initial);
  const marginInitial = parseAmount(row.margin_initial);
  const SCALE = 10n ** 18n;
  const notional = (size * entry) / SCALE;
  const opened = row.opened_at instanceof Date ? row.opened_at : new Date(row.opened_at);
  const liq = row.liq_price != null ? formatAmount(parseAmount(row.liq_price)) : null;
  return {
    id: row.id,
    symbol: row.symbol,
    timestamp: opened.getTime(),
    datetime: opened.toISOString(),
    side: row.side,
    status: row.status,
    closingReason: row.status === 'closing' ? (row.closing_reason ?? null) : null,
    contracts: formatAmount(size),
    contractSize: null,
    entryPrice: formatAmount(entry),
    markPrice: extras?.markPrice ?? null,
    notional: formatAmount(notional),
    leverage: formatAmount(leverage),
    collateral: formatAmount(marginCurrent),
    initialMargin: formatAmount(marginInitial),
    maintenanceMargin: null,
    unrealizedPnl: null,
    realizedPnl: extras?.realizedPnl ?? null,
    liquidationPrice: liq,
    marginMode: row.margin_mode,
    percentage: null,
  };
}
