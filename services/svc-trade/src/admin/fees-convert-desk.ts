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
import { describeOtcConvertBounds, type OtcConvertBounds, type OtcConvertFlow } from '../otc/otc-convert-bounds.js';
import { requireConvertQuoteTtlMs, requireConvertSpreadBps } from '../convert/quote.js';
import { REGULAR_FEE_TIER } from '../spot/fee-schedule.js';
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
  /** TRADE_CONVERT_SPREAD_BPS as Convert uses it, or null when blank or refused. */
  readonly spreadBps: string | null;
  /** Set but not a value Convert takes: the code every quote refuses with (`trade.convert_bad_spread`). */
  readonly spreadRefusal: string | null;
  /** TRADE_CONVERT_QUOTE_TTL_MS as Convert uses it, or null when blank or refused. */
  readonly quoteTtlMs: string | null;
  readonly quoteTtlRefusal: string | null;
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
  /**
   * The spread in the quote as it was given, in the quote asset: |book notional − customer notional|, exact. It is what
   * the quote priced in, not what was earned: an open or expired quote earned nothing, and a settled one filled at its own
   * fill price.
   */
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
/**
 * An owner value as Convert itself reads it: blank is null with no refusal ("not set"); a set value Convert refuses is null
 * with the code every quote refuses with, so the room never shows a number Convert would not use.
 */
function ownerValue(raw: number | null, check: (value: number) => number): { value: string | null; refusal: string | null } {
  if (raw === null) return { value: null, refusal: null };
  try {
    return { value: String(check(raw)), refusal: null };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { value: null, refusal: typeof code === 'string' ? code : 'trade.convert_settings_invalid' };
  }
}

export class FeesConvertDesk {
  constructor(private readonly deps: FeesConvertDeskDeps) {}

  async snapshotRuns(principal: Principal, limit: number): Promise<SnapshotRunRow[]> {
    requireOperator(principal);
    // The runs are cut to the page first, then each one's rows are summed through the index on `instant`.
    const rows = await this.deps.sql<
      Array<{ instant: Date; schedule_version: string; accounts: number; above: number; volume: string; completed_at: Date }>
    >`
      SELECT r.instant, r.schedule_version, r.accounts, r.completed_at, f.above, f.volume
        FROM (
          SELECT instant, schedule_version, accounts, completed_at
            FROM trade.fee_tier_snapshot_runs
           ORDER BY instant DESC
           LIMIT ${limitOf(limit)}
        ) r
        CROSS JOIN LATERAL (
          SELECT count(*) FILTER (WHERE s.tier_id <> ${REGULAR_FEE_TIER})::int AS above,
                 coalesce(sum(s.volume_30d), 0)::text AS volume
            FROM trade.fee_tier_snapshots s
           WHERE s.instant = r.instant
        ) f
       ORDER BY r.instant DESC`;
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
    const spread = ownerValue(convert.spreadBps, requireConvertSpreadBps);
    const ttl = ownerValue(convert.quoteTtlMs, requireConvertQuoteTtlMs);
    return {
      paused: pairs.paused,
      assets: pairs.assets,
      restricted: pairs.restricted,
      spreadBps: spread.value,
      spreadRefusal: spread.refusal,
      quoteTtlMs: ttl.value,
      quoteTtlRefusal: ttl.refusal,
      deskBounds: describeOtcConvertBounds(convert.deskBounds),
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
