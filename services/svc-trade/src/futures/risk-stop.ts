/**
 * Pre-liquidation stop (D-margin-04, `derivatives-margin-risk-021`; J-derivatives-06 #5).
 *
 * The trader sets a margin-ratio level (maintenance over equity, as a percent below 100) on one isolated position.
 * The service shows the mark at which the ratio reaches it, on the same ladder and depth as the liquidation price, and
 * the conditional-order tick closes the position through one reduce-only order in the book once the ratio gets there.
 * Blank means no stop: it is a convenience, and the platform's own liquidation still runs.
 *
 * Refusals: a level at or above 100% would act only after the liquidation (`trade.risk_stop_invalid`); a level the
 * ratio has already reached would close the position at once (`trade.risk_stop_reached`); a ratio the service cannot
 * work out now is not guessed (`trade.risk_stop_ratio_unknown`); with the trigger job off nothing would ever act on it
 * (`trade.conditional_trigger_off`).
 *
 * Crash safety: the tick claims a row (armed -> fired) on its generation before it places, and the close order's client
 * id is `risk-stop:<position>:<generation>`. A crash after the claim and before the order replays the same client id on
 * the next tick; a crash after the order finds the same order. A new level is a new generation, so a stop re-armed
 * after it fired never reuses the first close's id.
 */
import { SCALE, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { FuturesError, type RiskStopFigures } from './position-service.js';
import type { ConditionalOrderView } from './conditional-orders/service.js';

const ONE = SCALE;
/** A close order in one of these states will not change again. */
const CLOSE_FINAL = new Set(['filled', 'failed', 'cancelled']);
const HUNDRED = 100n;

export const RISK_STOP_INVALID = 'trade.risk_stop_invalid';
export const RISK_STOP_REACHED = 'trade.risk_stop_reached';
export const RISK_STOP_RATIO_UNKNOWN = 'trade.risk_stop_ratio_unknown';
export const RISK_STOP_CLOSING = 'trade.risk_stop_closing';
export const RISK_STOP_ISOLATED_ONLY = 'trade.risk_stop_isolated_only';
export const RISK_STOP_TRIGGER_OFF = 'trade.conditional_trigger_off';

export type RiskStopStatus = 'none' | 'armed' | 'fired' | 'ended';

export interface RiskStopView {
  readonly positionId: string;
  readonly status: RiskStopStatus;
  /** The level as a percent of margin ratio ("50" = close when maintenance is half of equity); null with no stop. */
  readonly level: string | null;
  /** The position's margin ratio now, as a percent, from the same figures as the positions list. */
  readonly marginRatio: string | null;
  readonly marginRatioReason: string | null;
  /** The mark at which the ratio reaches the level: where the close order is placed. */
  readonly triggerPrice: string | null;
  readonly triggerPriceReason: string | null;
  readonly liquidationPrice: string | null;
  /** The reduce-only order the stop placed, once it fired. */
  readonly closeOrder: { readonly clientOrderId: string; readonly status: string; readonly orderId: string | null } | null;
  readonly firedRatio: string | null;
  readonly firedAt: string | null;
  readonly updatedAt: string | null;
}

interface StopRow {
  position_id: string;
  user_id: string;
  level: string | null;
  /** `done`: the close order a fired stop placed has ended; shown as fired, no longer read by the tick. */
  status: 'armed' | 'fired' | 'done' | 'cleared' | 'ended';
  generation: number;
  client_request_id: string;
  close_client_order_id: string | null;
  fired_ratio: string | null;
  fired_at: Date | null;
  updated_at: Date;
}

export interface RiskStopDeps {
  readonly sql: Sql;
  /** True only while the conditional-order tick is scheduled and closes go through the book. */
  readonly triggerScheduled: boolean;
  figures(userId: string, positionId: string, level: Amount | null): Promise<RiskStopFigures>;
  fire(input: {
    userId: string;
    marketId: string;
    positionId: string;
    side: 'buy' | 'sell';
    quantity: Amount;
    mark: Amount | null;
    clientOrderId: string;
  }): Promise<ConditionalOrderView>;
  /** The close order a fired stop placed, by its client id; null when it was not written yet. */
  closeOrder(userId: string, clientOrderId: string): Promise<ConditionalOrderView | null>;
}

/** A percent as a ratio, exact to 18 places, or a typed refusal. Strictly between 0 and 100. */
export function levelFromPercent(raw: unknown): Amount {
  if (typeof raw !== 'string' || !/^\d+(\.\d+)?$/.test(raw.trim())) {
    throw new FuturesError('level must be a percent as a decimal string, for example "50"', RISK_STOP_INVALID, 400);
  }
  let pct: Amount;
  try {
    pct = parseAmount(raw.trim());
  } catch {
    throw new FuturesError('level must be a percent with at most 16 decimal places', RISK_STOP_INVALID, 400);
  }
  if (pct % HUNDRED !== 0n) throw new FuturesError('level must be a percent with at most 16 decimal places', RISK_STOP_INVALID, 400);
  const level = pct / HUNDRED;
  if (level <= 0n) throw new FuturesError('level must be above 0%', RISK_STOP_INVALID, 400);
  if (level >= ONE) {
    throw new FuturesError(
      'a stop at or above 100% would act only after the liquidation: set a margin ratio below 100%',
      RISK_STOP_INVALID,
      400,
    );
  }
  return level;
}

export function percentOf(ratio: Amount): string {
  return formatAmount(ratio * HUNDRED);
}

/** The ratio reached the level, or equity is gone (the position is past its liquidation level). */
export function riskStopReached(figures: Pick<RiskStopFigures, 'marginRatio' | 'ratioReason'>, level: Amount): boolean {
  if (figures.marginRatio === null) return figures.ratioReason === 'equity_not_positive';
  return figures.marginRatio >= level;
}

function closingSide(side: 'long' | 'short'): 'buy' | 'sell' {
  return side === 'long' ? 'sell' : 'buy';
}

function closeId(positionId: string, generation: number): string {
  return `risk-stop:${positionId}:${generation}`;
}

function requestId(raw: unknown): string {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id || id.length > 64) throw new FuturesError('clientRequestId is required (1–64 chars)', 'trade.idempotency_key_required', 400);
  return id;
}

export function createRiskStopService(deps: RiskStopDeps) {
  const { sql } = deps;

  async function rowOf(userId: string, positionId: string): Promise<StopRow | null> {
    const [row] = await sql<StopRow[]>`
      SELECT * FROM trade.futures_risk_stops WHERE position_id = ${positionId} AND user_id = ${userId}
    `;
    return row ?? null;
  }

  function levelOf(row: StopRow | null): Amount | null {
    return row && (row.status === 'armed' || row.status === 'fired' || row.status === 'done') && row.level != null
      ? parseAmount(row.level)
      : null;
  }

  async function view(userId: string, positionId: string, row: StopRow | null, known?: RiskStopFigures): Promise<RiskStopView> {
    const level = levelOf(row);
    const figures = known ?? (await deps.figures(userId, positionId, level));
    const close = row?.close_client_order_id ? await deps.closeOrder(userId, row.close_client_order_id) : null;
    const status: RiskStopStatus = !row || row.status === 'cleared' ? 'none' : row.status === 'done' ? 'fired' : row.status;
    return {
      positionId: figures.positionId,
      status,
      level: level === null ? null : percentOf(level),
      marginRatio: figures.marginRatio === null ? null : percentOf(figures.marginRatio),
      marginRatioReason: figures.marginRatio === null ? figures.ratioReason : null,
      triggerPrice: level === null || figures.stopPrice === null ? null : formatAmount(figures.stopPrice),
      triggerPriceReason: level === null ? null : figures.stopPriceReason,
      liquidationPrice: figures.liquidationPrice,
      closeOrder: row?.close_client_order_id
        ? { clientOrderId: row.close_client_order_id, status: close?.status ?? 'pending', orderId: close?.closeOrderId ?? null }
        : null,
      firedRatio: row?.fired_ratio == null ? null : percentOf(parseAmount(row.fired_ratio)),
      firedAt: row?.fired_at ? row.fired_at.toISOString() : null,
      updatedAt: row ? row.updated_at.toISOString() : null,
    };
  }

  async function get(userId: string, positionId: string): Promise<RiskStopView> {
    const id = positionId.trim();
    if (!id) throw new FuturesError('position id is required', 'trade.bad_request', 400);
    const row = await rowOf(userId, id);
    // The position read refuses a position that is not this user's (404), with or without a stop.
    return view(userId, id, row, await deps.figures(userId, id, levelOf(row)));
  }

  async function set(userId: string, positionId: string, input: { level: unknown; clientRequestId: unknown }): Promise<RiskStopView> {
    const id = positionId.trim();
    if (!id) throw new FuturesError('position id is required', 'trade.bad_request', 400);
    const clientRequestId = requestId(input.clientRequestId);
    const clearing = input.level === null;
    const level = clearing ? null : levelFromPercent(input.level);
    const existing = await rowOf(userId, id);
    // The same request again answers with the stop as it stands, and arms nothing twice.
    if (existing && existing.client_request_id === clientRequestId) return view(userId, id, existing);
    if (!clearing && !deps.triggerScheduled) {
      throw new FuturesError(
        'a pre-liquidation stop cannot be armed: the trigger job is off, so nothing would close the position',
        RISK_STOP_TRIGGER_OFF,
        503,
      );
    }
    const figures = await deps.figures(userId, id, level);
    if (figures.status !== 'open') throw new FuturesError('position is not open', 'trade.position_not_open', 409);
    if (existing?.status === 'fired') {
      const close = existing.close_client_order_id ? await deps.closeOrder(userId, existing.close_client_order_id) : null;
      if (!close || !CLOSE_FINAL.has(close.status)) {
        throw new FuturesError('the stop is closing this position now', RISK_STOP_CLOSING, 409);
      }
    }
    // Every write below is on the row exactly as read here: a tick that claimed it meanwhile wins, and this set refuses.
    const seenGeneration = existing?.generation ?? 0;
    const seenStatus = existing?.status ?? null;
    const raced = () =>
      new FuturesError('the stop changed while it was being set (it may have fired): read it again', RISK_STOP_CLOSING, 409);
    if (clearing) {
      if (!existing) return view(userId, id, null, figures);
      const [row] = await sql<StopRow[]>`
        UPDATE trade.futures_risk_stops
        SET status = 'cleared', level = NULL, client_request_id = ${clientRequestId}, updated_at = now()
        WHERE position_id = ${id} AND user_id = ${userId} AND generation = ${seenGeneration} AND status = ${seenStatus}
        RETURNING *
      `;
      if (!row) throw raced();
      return view(userId, id, row, figures);
    }
    if (figures.marginMode !== 'isolated') {
      throw new FuturesError('a pre-liquidation stop is set on an isolated position', RISK_STOP_ISOLATED_ONLY, 400);
    }
    if (figures.marginRatio === null) {
      throw new FuturesError(
        `the margin ratio cannot be worked out now (${figures.ratioReason ?? 'missing_input'}), so the stop is not set`,
        RISK_STOP_RATIO_UNKNOWN,
        409,
      );
    }
    if (riskStopReached(figures, level!)) {
      throw new FuturesError(
        `the margin ratio is already ${percentOf(figures.marginRatio)}%, at or past ${percentOf(level!)}%: the stop would close the position at once`,
        RISK_STOP_REACHED,
        400,
      );
    }
    const [row] = await sql<StopRow[]>`
      INSERT INTO trade.futures_risk_stops (position_id, user_id, level, status, generation, client_request_id)
      VALUES (${id}, ${userId}, ${formatAmount(level!)}, 'armed', 1, ${clientRequestId})
      ON CONFLICT (position_id) DO UPDATE
        SET level = EXCLUDED.level,
            status = 'armed',
            generation = trade.futures_risk_stops.generation + 1,
            client_request_id = EXCLUDED.client_request_id,
            close_client_order_id = NULL,
            fired_ratio = NULL,
            fired_at = NULL,
            updated_at = now()
        WHERE trade.futures_risk_stops.user_id = EXCLUDED.user_id
          AND trade.futures_risk_stops.generation = ${seenGeneration}
          AND trade.futures_risk_stops.status = ${seenStatus}
      RETURNING *
    `;
    if (!row) throw raced();
    return view(userId, id, row, figures);
  }

  /**
   * One tick: every armed stop whose ratio reached its level is claimed and closes its position; a stop claimed before
   * a crash places its close again under the same client id. One row's error never stops the others; the first is
   * thrown at the end for the job to report.
   */
  async function evaluate(input: { enabled: boolean }): Promise<{ fired: number }> {
    if (input.enabled !== true) return { fired: 0 };
    let failure: unknown = null;
    let fired = 0;
    const rows = await sql<(StopRow & { position_status: string })[]>`
      SELECT s.*, p.status AS position_status
      FROM trade.futures_risk_stops s
      JOIN trade.positions p ON p.id = s.position_id
      WHERE s.status IN ('armed', 'fired')
      ORDER BY s.updated_at, s.position_id
    `;
    for (const row of rows) {
      try {
        if (row.position_status !== 'open' && row.status === 'armed') {
          // A position that closed or was liquidated: an armed stop has nothing left to act on.
          await sql`
            UPDATE trade.futures_risk_stops SET status = 'ended', updated_at = now()
            WHERE position_id = ${row.position_id} AND status = 'armed' AND generation = ${row.generation}
          `;
          continue;
        }
        if (row.status === 'fired') {
          // Claimed on an earlier tick. Its close order may not have been written before a crash: write it now. Once it
          // has ended, the stop is done and no later tick reads it.
          const close = row.close_client_order_id ? await deps.closeOrder(row.user_id, row.close_client_order_id) : null;
          if (close && CLOSE_FINAL.has(close.status)) {
            await sql`
              UPDATE trade.futures_risk_stops SET status = 'done', updated_at = now()
              WHERE position_id = ${row.position_id} AND status = 'fired' AND generation = ${row.generation}
            `;
          } else if (!close && row.close_client_order_id) {
            const figures = await deps.figures(row.user_id, row.position_id, null);
            await deps.fire({
              userId: row.user_id,
              marketId: figures.marketId,
              positionId: row.position_id,
              side: closingSide(figures.side),
              quantity: figures.size,
              mark: figures.markPrice == null ? null : parseAmount(figures.markPrice),
              clientOrderId: row.close_client_order_id,
            });
          }
          continue;
        }
        const level = parseAmount(row.level!);
        const figures = await deps.figures(row.user_id, row.position_id, null);
        if (!riskStopReached(figures, level)) continue;
        const clientOrderId = closeId(row.position_id, row.generation);
        const claimed = await sql<{ position_id: string }[]>`
          UPDATE trade.futures_risk_stops
          SET status = 'fired',
              close_client_order_id = ${clientOrderId},
              fired_ratio = ${figures.marginRatio === null ? null : formatAmount(figures.marginRatio)},
              fired_at = now(),
              updated_at = now()
          WHERE position_id = ${row.position_id} AND status = 'armed' AND generation = ${row.generation}
          RETURNING position_id
        `;
        if (claimed.length === 0) continue;
        fired += 1;
        await deps.fire({
          userId: row.user_id,
          marketId: figures.marketId,
          positionId: row.position_id,
          side: closingSide(figures.side),
          quantity: figures.size,
          mark: figures.markPrice == null ? null : parseAmount(figures.markPrice),
          clientOrderId,
        });
      } catch (err) {
        failure ??= err;
      }
    }
    if (failure != null) throw failure;
    return { fired };
  }

  return { get, set, evaluate };
}

export type RiskStopService = ReturnType<typeof createRiskStopService>;
