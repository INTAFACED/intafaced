/**
 * The caller's RFQ board (J-copy-bots-otc-24 #5): each request with every quote it collected, grouped by the request's
 * status with a count per group, the best quote first and equal prices going to the quote asked earlier.
 *
 * Read from the durable otc_desk_quotes table, like the RFQ history. The window and the limit (counted in requests)
 * are required: a blank one refuses rather than invent a page size.
 */

import type { Sql } from 'postgres';
import { requireScope, type Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { assertRfqListWindow, publishedRfqListLimit, type RfqListQuery } from './rfq-history.js';
import { rankRfqQuotes, type OtcSide } from './rfq.js';
import type { OtcQuoteLifecycle } from './quote-store.js';

/** A request's status: settled or accepted once one quote is; live while a quote is still open and unexpired. */
export type RfqBoardStatus = 'open' | 'accepted' | 'settled' | 'expired';

/** The board's groups, in the order the room shows them. Every group is always present, with its count. */
export const RFQ_BOARD_STATUSES: readonly RfqBoardStatus[] = ['open', 'accepted', 'settled', 'expired'];

export interface RfqBoardQuote {
  readonly quoteId: string;
  readonly makerId: string | null;
  readonly rfqSeq: number;
  readonly quotedPrice: string;
  readonly userNotional: string;
  readonly spreadBps: number;
  readonly lifecycle: OtcQuoteLifecycle;
  readonly test: boolean;
  /** 1 is the best quote of the request. */
  readonly rank: number;
  readonly best: boolean;
  readonly expiresAt: string;
}

export interface RfqBoardRequest {
  readonly rfqId: string;
  readonly status: RfqBoardStatus;
  readonly side: OtcSide;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly qty: string;
  readonly createdAt: string;
  readonly quotes: readonly RfqBoardQuote[];
}

export interface RfqBoard {
  readonly groups: readonly { readonly status: RfqBoardStatus; readonly count: number; readonly requests: readonly RfqBoardRequest[] }[];
  /** True when the window holds more requests than the limit: the counts are of the requests shown. */
  readonly more: boolean;
}

export interface RfqBoardRow {
  readonly rfq_id: string;
  readonly quote_id: string;
  readonly maker_id: string | null;
  readonly rfq_seq: number;
  readonly side: OtcSide;
  readonly base_asset: string;
  readonly quote_asset: string;
  readonly qty: string;
  readonly quoted_price: string;
  readonly user_notional: string;
  readonly spread_bps: number;
  readonly lifecycle: OtcQuoteLifecycle;
  readonly test: boolean;
  readonly created_at: Date | string;
  readonly expires_at: Date | string;
}

const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();

function statusOf(rows: readonly RfqBoardRow[], now: Date): RfqBoardStatus {
  if (rows.some((r) => r.lifecycle === 'settled')) return 'settled';
  if (rows.some((r) => r.lifecycle === 'bound')) return 'accepted';
  // An open quote read after its expiry is expired (as rfq.get reads it); nothing is written here.
  if (rows.some((r) => r.lifecycle === 'open' && now.getTime() <= Date.parse(iso(r.expires_at)))) return 'open';
  return 'expired';
}

/** Group rows of otc_desk_quotes into the board. Requests keep the order given (newest first from the query). */
export function buildRfqBoard(rows: readonly RfqBoardRow[], now: Date, more = false): RfqBoard {
  const byRfq = new Map<string, RfqBoardRow[]>();
  for (const row of rows) {
    const list = byRfq.get(row.rfq_id);
    if (list) list.push(row);
    else byRfq.set(row.rfq_id, [row]);
  }
  const requests: RfqBoardRequest[] = [];
  for (const [rfqId, quotes] of byRfq) {
    const first = quotes.reduce((a, b) => (b.rfq_seq < a.rfq_seq ? b : a));
    const ranked = rankRfqQuotes(
      quotes.map((row) => ({ row, side: row.side, quotedPrice: parseAmount(row.quoted_price) as Amount, rfqSeq: Number(row.rfq_seq) })),
    );
    requests.push({
      rfqId,
      status: statusOf(quotes, now),
      side: first.side,
      baseAsset: first.base_asset,
      quoteAsset: first.quote_asset,
      qty: formatAmount(parseAmount(first.qty)),
      createdAt: iso(first.created_at),
      quotes: ranked.map(({ row, quotedPrice, rfqSeq }, i) => ({
        quoteId: row.quote_id,
        makerId: row.maker_id,
        rfqSeq,
        quotedPrice: formatAmount(quotedPrice),
        userNotional: formatAmount(parseAmount(row.user_notional)),
        spreadBps: Number(row.spread_bps),
        lifecycle: row.lifecycle,
        test: row.test === true,
        rank: i + 1,
        best: i === 0,
        expiresAt: iso(row.expires_at),
      })),
    });
  }
  return {
    groups: RFQ_BOARD_STATUSES.map((status) => {
      const inGroup = requests.filter((r) => r.status === status);
      return { status, count: inGroup.length, requests: inGroup };
    }),
    more,
  };
}

/** `trade.rfq.board`: the caller's requests in the window, newest first, at most `limit` requests. */
export async function listRfqBoard(sql: Sql, principal: Principal, query: RfqListQuery, now: Date): Promise<RfqBoard> {
  requireScope(principal, 'trade:read');
  const window = assertRfqListWindow(query.from, query.to);
  const limit = publishedRfqListLimit(query.limit);
  // A quote saved before requests had ids is its own request.
  const rows = await sql<(RfqBoardRow & { page_rank: number })[]>`
    WITH requests AS (
      SELECT COALESCE(rfq_id, quote_id) AS rid, MIN(created_at) AS at
      FROM otc_desk_quotes
      WHERE user_id = ${principal.userId} AND created_at >= ${window.from} AND created_at <= ${window.to}
      GROUP BY COALESCE(rfq_id, quote_id)
      ORDER BY at DESC, rid DESC
      LIMIT ${limit + 1}
    ), ranked AS (
      SELECT rid, ROW_NUMBER() OVER (ORDER BY at DESC, rid DESC) AS page_rank FROM requests
    )
    SELECT ranked.rid AS rfq_id, q.quote_id, q.maker_id, q.rfq_seq, q.side, q.base_asset, q.quote_asset,
           q.qty::text AS qty, q.quoted_price::text AS quoted_price, q.user_notional::text AS user_notional,
           q.spread_bps, q.lifecycle, q.test, q.created_at, q.expires_at, ranked.page_rank
    FROM ranked
    JOIN otc_desk_quotes q ON COALESCE(q.rfq_id, q.quote_id) = ranked.rid AND q.user_id = ${principal.userId}
    ORDER BY ranked.page_rank, q.rfq_seq, q.quote_id
  `;
  const more = rows.some((r) => Number(r.page_rank) > limit);
  return buildRfqBoard(
    rows.filter((r) => Number(r.page_rank) <= limit),
    now,
    more,
  );
}
