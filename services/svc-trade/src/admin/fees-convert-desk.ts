/**
 * The finance reads behind the console's Fees and convert room (J-cex-spot-17 #4, #7, #8). Read only: nothing here
 * writes a row or moves money. Fee versions themselves are `admin.fees.get` / `.set` (service.ts).
 *
 *   snapshotRuns    every finished fee tier snapshot run, newest first, with the figures it used (#4)
 *   convertSettings Convert's state and its owner values: spread, quote hold time, the per-asset maximum and the desk-price
 *                   size ranges; a blank value is null, never a default (#7)
 *   convertQuotes   the convert quotes customers were given on one side, newest first, with their exact amounts (#8)
 *
 * Amounts leave as decimal strings from `formatAmount`, the same strings the customer's own reads give.
 */
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { ConvertPairs } from '../convert/pairs.js';
import type { OtcConvertBounds, OtcConvertFlow } from '../otc/otc-convert-bounds.js';
import { requireOperator, TradeOpsError } from './common.js';

/** At most this many rows in one read: the room shows recent history, not an export. */
export const FEES_DESK_LIST_MAX = 100;

export interface SnapshotRunRow {
  readonly instant: string;
  readonly scheduleVersion: string;
  /** Accounts the run wrote a row for. */
  readonly accounts: number;
  /** Of those, the accounts the run put above the regular tier. */
  readonly aboveRegular: number;
  /** The sum of the counted 30-day volume over those rows, a decimal string. */
  readonly countedVolume: string;
  readonly completedAt: string;
}

export interface ConvertSettingsView {
  /** The Convert kill-switch is off: every quote and accept refuses `trade.convert_disabled`. */
  readonly paused: boolean;
  readonly assets: ConvertPairs['assets'];
  readonly restricted: readonly string[];
  /** TRADE_CONVERT_SPREAD_BPS as a whole-number string, or null when blank. */
  readonly spreadBps: string | null;
  /** TRADE_CONVERT_QUOTE_TTL_MS as a whole-number string, or null when blank. */
  readonly quoteTtlMs: string | null;
  /** TRADE_OTC_CONVERT_BOUNDS per flow, or null for a flow with none published. */
  readonly deskBounds: Readonly<Record<OtcConvertFlow, { readonly minQty: string; readonly maxQty: string } | null>>;
}

export interface ConvertQuoteRow {
  readonly quoteId: string;
  readonly userId: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly inAsset: string;
  readonly inAmount: string;
  readonly outAsset: string;
  readonly outAmount: string;
  readonly avgPrice: string;
  readonly bookNotional: string;
  readonly userNotional: string;
  /** What the spread kept, in the quote asset: |book notional − customer notional|, exact. */
  readonly spreadAmount: string;
  readonly spreadAsset: string;
  readonly spreadBps: number;
  readonly lifecycle: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ConvertOwnerValues {
  /** What Convert offers now (TradeService.convertPairs), with the per-asset maximum or null where blank. */
  readonly pairs: () => Promise<ConvertPairs>;
  readonly spreadBps: number | null;
  readonly quoteTtlMs: number | null;
  readonly deskBounds: OtcConvertBounds;
}

export interface FeesConvertDeskDeps {
  readonly sql: Sql;
  /** Absent: the convert read refuses `trade.convert_settings_unwired` rather than show blanks it never read. */
  readonly convert?: ConvertOwnerValues;
}

function limitOf(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > FEES_DESK_LIST_MAX) {
    throw new TradeOpsError('fees_desk_limit_unset', `limit is required (1-${FEES_DESK_LIST_MAX}); this read does not invent a page size`);
  }
  return limit;
}

const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
const decimal = (value: string): string => formatAmount(parseAmount(value));
const whole = (value: number | null): string | null => (value === null || !Number.isSafeInteger(value) || value < 0 ? null : String(value));

export class FeesConvertDesk {
  constructor(private readonly deps: FeesConvertDeskDeps) {}

  async snapshotRuns(principal: Principal, limit: number): Promise<SnapshotRunRow[]> {
    requireOperator(principal);
    const rows = await this.deps.sql<
      Array<{ instant: Date; schedule_version: string; accounts: number; above: number; volume: string; completed_at: Date }>
    >`
      SELECT r.instant, r.schedule_version, r.accounts, r.completed_at,
             count(s.key) FILTER (WHERE s.tier_id <> 'regular')::int AS above,
             coalesce(sum(s.volume_30d), 0)::text AS volume
        FROM trade.fee_tier_snapshot_runs r
        LEFT JOIN trade.fee_tier_snapshots s ON s.instant = r.instant
       GROUP BY r.instant, r.schedule_version, r.accounts, r.completed_at
       ORDER BY r.instant DESC
       LIMIT ${limitOf(limit)}`;
    return rows.map((row) => ({
      instant: iso(row.instant),
      scheduleVersion: row.schedule_version,
      accounts: row.accounts,
      aboveRegular: row.above,
      countedVolume: decimal(row.volume),
      completedAt: iso(row.completed_at),
    }));
  }

  async convertSettings(principal: Principal): Promise<ConvertSettingsView> {
    requireOperator(principal);
    const convert = this.deps.convert;
    if (!convert) throw new TradeOpsError('trade.convert_settings_unwired', 'this service was started without the convert settings read');
    const pairs = await convert.pairs();
    const flow = (name: OtcConvertFlow) => {
      const bounds = convert.deskBounds[name];
      return bounds ? { minQty: formatAmount(bounds.minQty), maxQty: formatAmount(bounds.maxQty) } : null;
    };
    return {
      paused: pairs.paused,
      assets: pairs.assets,
      restricted: pairs.restricted,
      spreadBps: whole(convert.spreadBps),
      quoteTtlMs: whole(convert.quoteTtlMs),
      deskBounds: { convert: flow('convert'), oneClickBuy: flow('oneClickBuy') },
    };
  }

  async convertQuotes(principal: Principal, input: { side: 'buy' | 'sell'; limit: number }): Promise<ConvertQuoteRow[]> {
    requireOperator(principal);
    if (input.side !== 'buy' && input.side !== 'sell') throw new TradeOpsError('fees_desk_side_unset', 'side must be buy or sell');
    const rows = await this.deps.sql<
      Array<{
        quote_id: string;
        user_id: string;
        symbol: string;
        side: 'buy' | 'sell';
        quote_asset: string;
        in_asset: string;
        in_amount: string;
        out_asset: string;
        out_amount: string;
        avg_price: string;
        book_notional: string;
        user_notional: string;
        convert_spread_bps: number;
        lifecycle: string;
        created_at: Date;
        expires_at: Date;
      }>
    >`
      SELECT quote_id, user_id, symbol, side, quote_asset, in_asset, in_amount::text, out_asset, out_amount::text,
             avg_price::text, book_notional::text, user_notional::text, convert_spread_bps, lifecycle::text,
             created_at, expires_at
        FROM trade.convert_quotes
       WHERE side = ${input.side}
       ORDER BY created_at DESC, quote_id
       LIMIT ${limitOf(input.limit)}`;
    return rows.map((row) => {
      const book = parseAmount(row.book_notional);
      const customer = parseAmount(row.user_notional);
      return {
        quoteId: row.quote_id,
        userId: row.user_id,
        symbol: row.symbol,
        side: row.side,
        inAsset: row.in_asset,
        inAmount: decimal(row.in_amount),
        outAsset: row.out_asset,
        outAmount: decimal(row.out_amount),
        avgPrice: decimal(row.avg_price),
        bookNotional: formatAmount(book),
        userNotional: formatAmount(customer),
        spreadAmount: formatAmount(book > customer ? book - customer : customer - book),
        spreadAsset: row.quote_asset,
        spreadBps: Number(row.convert_spread_bps),
        lifecycle: row.lifecycle,
        createdAt: iso(row.created_at),
        expiresAt: iso(row.expires_at),
      };
    });
  }
}
