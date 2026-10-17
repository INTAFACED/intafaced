/**
 * Operator reads for the founder P2P desk.
 *
 * `admin:compliance` only. Rows name accounts. They do not carry payment
 * instrument details, chat text, evidence, or any sealed snapshot.
 * Amounts stay exact decimal strings. A blank page size is refused.
 */
import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { P2pError } from '../p2p-service.js';

const OFFER_STATUSES = ['active', 'paused', 'closed'] as const;
const TRADE_STATUSES = ['created', 'escrowed', 'fiat_sent', 'released', 'cancelled', 'disputed'] as const;

export type OpsOfferStatus = (typeof OFFER_STATUSES)[number];
export type OpsTradeStatus = (typeof TRADE_STATUSES)[number];

const CREATED_EXACT = /^\d{20}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface OpsOfferRow {
  id: string;
  makerId: string;
  side: 'buy' | 'sell';
  asset: string;
  fiatCurrency: string;
  price: string;
  minAmount: string;
  maxAmount: string;
  totalAmount: string;
  remainingAmount: string;
  status: OpsOfferStatus;
  methodIds: string[];
  createdAt: string;
}

export interface OpsTradeRow {
  id: string;
  offerId: string;
  makerId: string;
  takerId: string;
  buyerId: string;
  sellerId: string;
  asset: string;
  fiatCurrency: string;
  amount: string;
  price: string;
  fiatAmount: string;
  method: string;
  feeBps: number;
  status: OpsTradeStatus;
  resolution: 'released' | 'refunded' | 'voided' | null;
  createdAt: string;
}

export interface OpsCounts {
  offers: Record<OpsOfferStatus, number>;
  trades: Record<OpsTradeStatus, number>;
}

export interface OpsDisputeRate {
  disputesOpened24h: number;
  tradesCreated24h: number;
  /** Exact `disputes/trades`. Null when no trade was created in the window. Never the number 0. */
  rate: string | null;
}

function assertPageLimit(limit: number | undefined, code: 'p2p.ops_offers_limit_unset' | 'p2p.ops_trades_limit_unset'): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new P2pError(`${code} — refusing rather than inventing a page size`, code);
  }
  const n = Math.floor(limit);
  if (n < 1) throw new P2pError(`${code} — refusing rather than inventing a page size`, code);
  return Math.min(200, n);
}

function encodeCursor(status: string, createdAtExact: string, id: string): string {
  return Buffer.from(`${status}\n${createdAtExact}\n${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, status: string): { createdAtExact: string; id: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new P2pError('p2p.ops_cursor_invalid', 'p2p.ops_cursor_invalid');
  }
  const [cursorStatus, createdAtExact, id] = raw.split('\n');
  if (cursorStatus !== status || !createdAtExact || !CREATED_EXACT.test(createdAtExact) || !id || !UUID_RE.test(id)) {
    throw new P2pError('p2p.ops_cursor_invalid', 'p2p.ops_cursor_invalid');
  }
  return { createdAtExact, id };
}

function methodIds(methods: unknown): string[] {
  if (!Array.isArray(methods)) return [];
  const out: string[] = [];
  for (const item of methods) {
    if (typeof item === 'string') out.push(item);
    else if (item && typeof item === 'object' && 'id' in item && typeof (item as { id: unknown }).id === 'string') {
      out.push((item as { id: string }).id);
    }
  }
  return out;
}

function money(value: string): string {
  return formatAmount(parseAmount(value));
}

function countMap<T extends string>(statuses: readonly T[], rows: Array<{ status: string; n: string }>): Record<T, number> {
  const out = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<T, number>;
  for (const row of rows) {
    if ((statuses as readonly string[]).includes(row.status)) {
      if (!/^\d+$/.test(row.n)) throw new P2pError('p2p.ops_count_invalid', 'p2p.ops_count_invalid');
      out[row.status as T] = Number(row.n);
    }
  }
  return out;
}

export class OpsReads {
  constructor(private readonly sql: Sql) {}

  async offers(input: { status: OpsOfferStatus; limit?: number; cursor?: string | null }): Promise<{
    offers: OpsOfferRow[];
    nextCursor: string | null;
  }> {
    const limit = assertPageLimit(input.limit, 'p2p.ops_offers_limit_unset');
    const after = input.cursor ? decodeCursor(input.cursor, input.status) : null;
    const rows = await this.sql<
      Array<{
        id: string;
        maker_id: string;
        side: 'buy' | 'sell';
        asset: string;
        fiat_currency: string;
        price: string;
        min_amt: string;
        max_amt: string;
        total_amt: string;
        remaining_amt: string;
        status: OpsOfferStatus;
        methods: unknown;
        created_at: Date;
        created_at_exact: string;
      }>
    >`
      SELECT id, maker_id, side, asset, fiat_currency, price, min_amt, max_amt, total_amt, remaining_amt,
             status, methods, created_at,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') AS created_at_exact
        FROM p2p.offers
       WHERE status = ${input.status}
         AND (
           ${after?.createdAtExact ?? null}::text IS NULL
           OR (to_char(created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS'), id)
              < (${after?.createdAtExact ?? null}, ${after?.id ?? null}::uuid)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit}
    `;
    const offers = rows.map((row) => ({
      id: row.id,
      makerId: row.maker_id,
      side: row.side,
      asset: row.asset,
      fiatCurrency: row.fiat_currency,
      price: money(row.price),
      minAmount: money(row.min_amt),
      maxAmount: money(row.max_amt),
      totalAmount: money(row.total_amt),
      remainingAmount: money(row.remaining_amt),
      status: row.status,
      methodIds: methodIds(row.methods),
      createdAt: row.created_at.toISOString(),
    }));
    const last = rows[rows.length - 1];
    const nextCursor = rows.length === limit && last ? encodeCursor(input.status, last.created_at_exact, last.id) : null;
    return { offers, nextCursor };
  }

  async trades(input: { status: OpsTradeStatus; limit?: number; cursor?: string | null }): Promise<{
    trades: OpsTradeRow[];
    nextCursor: string | null;
  }> {
    const limit = assertPageLimit(input.limit, 'p2p.ops_trades_limit_unset');
    const after = input.cursor ? decodeCursor(input.cursor, input.status) : null;
    const rows = await this.sql<
      Array<{
        id: string;
        offer_id: string;
        maker_id: string;
        taker_id: string;
        buyer_id: string;
        seller_id: string;
        asset: string;
        fiat_currency: string;
        amount: string;
        price: string;
        fiat_amount: string;
        method: string;
        fee_bps: string;
        status: OpsTradeStatus;
        resolution: 'released' | 'refunded' | 'voided' | null;
        created_at: Date;
        created_at_exact: string;
      }>
    >`
      SELECT id, offer_id, maker_id, taker_id, buyer_id, seller_id, asset, fiat_currency,
             amount, price, fiat_amount, method, fee_bps, status, resolution, created_at,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') AS created_at_exact
        FROM p2p.p2p_trades
       WHERE status = ${input.status}
         AND (
           ${after?.createdAtExact ?? null}::text IS NULL
           OR (to_char(created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS'), id)
              < (${after?.createdAtExact ?? null}, ${after?.id ?? null}::uuid)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit}
    `;
    const trades = rows.map((row) => ({
      id: row.id,
      offerId: row.offer_id,
      makerId: row.maker_id,
      takerId: row.taker_id,
      buyerId: row.buyer_id,
      sellerId: row.seller_id,
      asset: row.asset,
      fiatCurrency: row.fiat_currency,
      amount: money(row.amount),
      price: money(row.price),
      fiatAmount: money(row.fiat_amount),
      method: row.method,
      feeBps: Number(row.fee_bps),
      status: row.status,
      resolution: row.resolution,
      createdAt: row.created_at.toISOString(),
    }));
    const last = rows[rows.length - 1];
    const nextCursor = rows.length === limit && last ? encodeCursor(input.status, last.created_at_exact, last.id) : null;
    return { trades, nextCursor };
  }

  async counts(): Promise<OpsCounts> {
    const [offers, trades] = await Promise.all([
      this.sql<Array<{ status: string; n: string }>>`SELECT status::text AS status, count(*)::text AS n FROM p2p.offers GROUP BY status`,
      this.sql<Array<{ status: string; n: string }>>`
        SELECT status::text AS status, count(*)::text AS n FROM p2p.p2p_trades GROUP BY status
      `,
    ]);
    return { offers: countMap(OFFER_STATUSES, offers), trades: countMap(TRADE_STATUSES, trades) };
  }

  async disputeRate24h(): Promise<OpsDisputeRate> {
    const rows = await this.sql<Array<{ disputes: string; trades: string }>>`
      SELECT
        (SELECT count(*)::text FROM p2p.p2p_disputes WHERE opened_at >= now() - interval '24 hours') AS disputes,
        (SELECT count(*)::text FROM p2p.p2p_trades WHERE created_at >= now() - interval '24 hours') AS trades
    `;
    const row = rows[0];
    if (!row || !/^\d+$/.test(row.disputes) || !/^\d+$/.test(row.trades)) {
      throw new P2pError('p2p.ops_count_invalid', 'p2p.ops_count_invalid');
    }
    const disputesOpened24h = Number(row.disputes);
    const tradesCreated24h = Number(row.trades);
    return {
      disputesOpened24h,
      tradesCreated24h,
      rate: tradesCreated24h === 0 ? null : `${disputesOpened24h}/${tradesCreated24h}`,
    };
  }
}
