/**
 * Futures desk reads. Every figure is a stored row or a sum of stored rows.
 * A missing figure is null with a typed reason. Nothing here invents a mark,
 * a rank, a fee, or a 24h change.
 */
import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { FuturesError } from './position-service.js';
import type { MarketRow } from '../spot/rows.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const MARK_HISTORY_UNAVAILABLE = 'mark_history_unavailable' as const;
export const FUNDING_RATE_NOT_RECORDED = 'funding_rate_not_recorded' as const;
export const FUNDING_CURSOR_INVALID = 'trade.funding_cursor_invalid' as const;
export const ADL_RANK_NOT_PUBLISHED = 'adl_rank_not_published' as const;
export const LIQUIDATION_PRICE_NOT_RECORDED = 'liquidation_price_not_recorded' as const;
export const LIQUIDATION_FEE_NOT_RECORDED = 'liquidation_fee_not_recorded' as const;
export const LIQUIDATION_SIZE_NOT_RECORDED = 'liquidation_size_not_recorded' as const;

const MARKET_COLUMNS = `
  id, symbol, base_asset, quote_asset, kind, tick_size, lot_size,
  min_qty, max_qty, min_notional, status, maker_bps, taker_bps, listed_at,
  asset_class, schedule, paper, display_name, "test", test_fixture,
  futures_contract_style, futures_expiry_at, futures_settlement_fixing
`;

/** A TEST listing is on the public board only when the seed flag is on. */
export function visibleOnPublicBoard(market: { test?: boolean }, seedEnabled: boolean): boolean {
  return market.test !== true || seedEnabled === true;
}

export async function loadListedMarketRows(sql: Sql, limit: number, seedEnabled: boolean): Promise<MarketRow[]> {
  if (seedEnabled) {
    return sql<MarketRow[]>`
      SELECT ${sql.unsafe(MARKET_COLUMNS)}
        FROM trade.markets
       ORDER BY symbol ASC
       LIMIT ${limit}
    `;
  }
  return sql<MarketRow[]>`
    SELECT ${sql.unsafe(MARKET_COLUMNS)}
      FROM trade.markets
     WHERE "test" = false
     ORDER BY symbol ASC
     LIMIT ${limit}
  `;
}

export async function loadMarketBySymbol(sql: Sql, symbol: string, seedEnabled: boolean): Promise<MarketRow | null> {
  const rows = await sql<MarketRow[]>`
    SELECT ${sql.unsafe(MARKET_COLUMNS)}
      FROM trade.markets
     WHERE symbol = ${symbol}
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  if (!visibleOnPublicBoard({ test: row.test === true }, seedEnabled)) return null;
  return row;
}

export interface FundingPaymentRow {
  time: string;
  rate: string | null;
  rateReason: string | null;
  amount: string;
  direction: 'paid' | 'received';
}

export interface FundingPaymentPage {
  payments: FundingPaymentRow[];
  nextCursor: string | null;
}

interface AppliedRow {
  applied_at: Date;
  period_id: string;
  paid: string;
  rate: string | null;
}

export function encodeFundingCursor(appliedAt: Date, periodId: string): string {
  return Buffer.from(JSON.stringify({ t: appliedAt.toISOString(), p: periodId }), 'utf8').toString('base64url');
}

export function decodeFundingCursor(cursor: string): { appliedAt: Date; periodId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new FuturesError('funding cursor is not a cursor this door issued', FUNDING_CURSOR_INVALID, 400);
  }
  if (parsed == null || typeof parsed !== 'object') {
    throw new FuturesError('funding cursor is not a cursor this door issued', FUNDING_CURSOR_INVALID, 400);
  }
  const t = (parsed as { t?: unknown }).t;
  const p = (parsed as { p?: unknown }).p;
  if (typeof t !== 'string' || typeof p !== 'string' || p.length === 0) {
    throw new FuturesError('funding cursor is not a cursor this door issued', FUNDING_CURSOR_INVALID, 400);
  }
  const appliedAt = new Date(t);
  if (Number.isNaN(appliedAt.getTime())) {
    throw new FuturesError('funding cursor is not a cursor this door issued', FUNDING_CURSOR_INVALID, 400);
  }
  return { appliedAt, periodId: p };
}

function canonicalRate(raw: string | null): { rate: string | null; rateReason: string | null } {
  if (raw == null || raw.trim() === '') return { rate: null, rateReason: FUNDING_RATE_NOT_RECORDED };
  try {
    return { rate: formatAmount(parseAmount(raw)), rateReason: null };
  } catch {
    return { rate: null, rateReason: FUNDING_RATE_NOT_RECORDED };
  }
}

function paymentFromRow(row: AppliedRow): FundingPaymentRow {
  const paid = parseAmount(row.paid);
  if (paid === 0n) {
    throw new FuturesError('a funding posting of zero has no direction', 'trade.funding_amount_unset', 500);
  }
  const amount = formatAmount(paid < 0n ? -paid : paid);
  const rate = canonicalRate(row.rate);
  return {
    time: row.applied_at.toISOString(),
    rate: rate.rate,
    rateReason: rate.rateReason,
    amount,
    direction: paid > 0n ? 'paid' : 'received',
  };
}

/**
 * Funding settlement rows for one position the caller owns, open or closed.
 * Amounts are the signed postings in `position_funding_applied` (the record of
 * what the ledger was asked to move). An empty page is "no funding yet".
 */
export async function listFundingPayments(
  sql: Sql,
  userId: string,
  positionId: string,
  cursor: string | undefined,
): Promise<FundingPaymentPage> {
  const bound = cursor == null || cursor.trim() === '' ? null : decodeFundingCursor(cursor.trim());
  let owned: { id: string }[];
  try {
    owned = await sql<{ id: string }[]>`
      SELECT id::text AS id FROM trade.positions WHERE id = ${positionId}::uuid AND user_id = ${userId} LIMIT 1
    `;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '22P02') throw new FuturesError('position not found', 'trade.position_not_found', 404);
    throw err;
  }
  if (owned.length === 0) throw new FuturesError('position not found', 'trade.position_not_found', 404);

  const rows = bound
    ? await sql<AppliedRow[]>`
        SELECT a.applied_at, a.period_id, a.paid::text AS paid, r.rate
          FROM trade.position_funding_applied a
          JOIN trade.positions p ON p.id = a.position_id
          LEFT JOIN trade.funding_period_rates r ON r.period_id = a.period_id
         WHERE p.id = ${positionId}::uuid
           AND p.user_id = ${userId}
           AND (a.applied_at, a.period_id) > (${bound.appliedAt}, ${bound.periodId})
         ORDER BY a.applied_at ASC, a.period_id ASC
      `
    : await sql<AppliedRow[]>`
        SELECT a.applied_at, a.period_id, a.paid::text AS paid, r.rate
          FROM trade.position_funding_applied a
          JOIN trade.positions p ON p.id = a.position_id
          LEFT JOIN trade.funding_period_rates r ON r.period_id = a.period_id
         WHERE p.id = ${positionId}::uuid
           AND p.user_id = ${userId}
         ORDER BY a.applied_at ASC, a.period_id ASC
      `;

  const payments = rows.filter((row) => parseAmount(row.paid) !== 0n).map(paymentFromRow);
  // The page is the whole remainder. A page size would be an invented limit.
  // `cursor` still drops rows the caller has already seen. nextCursor stays
  // null so a client does not walk off the end into a second empty page.
  return { payments, nextCursor: null };
}

export interface LiquidationRungWire {
  rungId: string;
  kind: string;
  time: string;
  price: string | null;
  priceReason: string | null;
  size: string | null;
  sizeReason: string | null;
  fee: string | null;
  feeReason: string | null;
}

export interface LiquidationEventWire {
  liquidationId: string;
  positionId: string;
  adlRank: null;
  adlRankReason: typeof ADL_RANK_NOT_PUBLISHED;
  rungs: LiquidationRungWire[];
}

interface RungRow {
  rung_id: string;
  position_id: string;
  liquidation_id: string;
  kind: string;
  plan: unknown;
  created_at: Date;
}

function scaledDecimal(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw.trim())) return null;
  try {
    return formatAmount(BigInt(raw.trim()));
  } catch {
    return null;
  }
}

function recorded(plan: unknown, key: string, missing: string): { value: string | null; reason: string | null } {
  if (plan == null || typeof plan !== 'object') return { value: null, reason: missing };
  const value = scaledDecimal((plan as Record<string, unknown>)[key]);
  return value == null ? { value: null, reason: missing } : { value, reason: null };
}

/** No module computes an ADL queue rank. The field stays null with its reason. */
export function publishedAdlRank(): { adlRank: null; adlRankReason: typeof ADL_RANK_NOT_PUBLISHED } {
  return { adlRank: null, adlRankReason: ADL_RANK_NOT_PUBLISHED };
}

export function presentLiquidationRung(row: RungRow): LiquidationRungWire {
  const price = recorded(row.plan, 'markPrice', LIQUIDATION_PRICE_NOT_RECORDED);
  const size = recorded(row.plan, 'sizeClosed', LIQUIDATION_SIZE_NOT_RECORDED);
  const fee = recorded(row.plan, 'fee', LIQUIDATION_FEE_NOT_RECORDED);
  return {
    rungId: row.rung_id,
    kind: row.kind,
    time: row.created_at.toISOString(),
    price: price.value,
    priceReason: price.reason,
    size: size.value,
    sizeReason: size.reason,
    fee: fee.value,
    feeReason: fee.reason,
  };
}

/** The caller's own applied liquidation rungs. Another account's rows are not selected. */
export async function listCallerLiquidations(sql: Sql, userId: string): Promise<{ events: LiquidationEventWire[] }> {
  const rows = await sql<RungRow[]>`
    SELECT r.rung_id::text AS rung_id, r.position_id, r.liquidation_id, r.kind, r.plan, r.created_at
      FROM trade.liquidation_rungs r
      JOIN trade.positions p ON p.id::text = r.position_id
     WHERE p.user_id = ${userId}
       AND r.state IN ('applied', 'abandoned', 'resolved')
     ORDER BY r.created_at ASC, r.rung_id ASC
  `;
  const rank = publishedAdlRank();
  const byId = new Map<string, LiquidationEventWire>();
  for (const row of rows) {
    let event = byId.get(row.liquidation_id);
    if (!event) {
      event = {
        liquidationId: row.liquidation_id,
        positionId: row.position_id,
        adlRank: rank.adlRank,
        adlRankReason: rank.adlRankReason,
        rungs: [],
      };
      byId.set(row.liquidation_id, event);
    }
    event.rungs.push(presentLiquidationRung(row));
  }
  return { events: [...byId.values()] };
}

export interface FuturesTickerFacts {
  openInterest: string;
  volume24h: string;
  change24h: string | null;
  changeReason: typeof MARK_HISTORY_UNAVAILABLE | null;
}

function decimalSum(raw: string | null): string {
  return formatAmount(parseAmount(raw == null || raw.trim() === '' ? '0' : raw));
}

/**
 * Open interest is the sum of open position sizes on the market.
 * Volume is the sum of taker fill quantities in the last 24 hours.
 * Change is the latest stored mark minus the latest stored mark at or before
 * now−24h. Neither query selects an account id.
 */
export async function readFuturesTickerFacts(sql: Sql, marketId: string, now: Date): Promise<FuturesTickerFacts> {
  const since = new Date(now.getTime() - DAY_MS);
  const [interest] = await sql<{ open_interest: string }[]>`
    SELECT COALESCE(SUM(size), 0)::text AS open_interest
      FROM trade.positions
     WHERE market_id = ${marketId}::uuid
       AND status = 'open'
  `;
  const [volume] = await sql<{ volume: string }[]>`
    SELECT COALESCE(SUM(f.qty), 0)::text AS volume
      FROM trade.fills f
      JOIN trade.markets m ON m.id = f.market_id
     WHERE f.market_id = ${marketId}::uuid
       AND m.kind = 'futures'
       AND f.liquidity = 'taker'
       AND f.ts >= ${since}
       AND f.ts <= ${now}
  `;
  const [baseline] = await sql<{ price: string }[]>`
    SELECT price::text AS price
      FROM trade.futures_mark_samples
     WHERE market_id = ${marketId}::uuid
       AND observed_at <= ${since}
     ORDER BY observed_at DESC
     LIMIT 1
  `;
  const [current] = await sql<{ price: string }[]>`
    SELECT price::text AS price
      FROM trade.futures_mark_samples
     WHERE market_id = ${marketId}::uuid
       AND observed_at <= ${now}
     ORDER BY observed_at DESC
     LIMIT 1
  `;
  let change24h: string | null = null;
  let changeReason: FuturesTickerFacts['changeReason'] = MARK_HISTORY_UNAVAILABLE;
  if (baseline?.price != null && current?.price != null) {
    const delta = (parseAmount(current.price) - parseAmount(baseline.price)) as Amount;
    change24h = formatAmount(delta);
    changeReason = null;
  }
  return {
    openInterest: decimalSum(interest?.open_interest ?? null),
    volume24h: decimalSum(volume?.volume ?? null),
    change24h,
    changeReason,
  };
}
