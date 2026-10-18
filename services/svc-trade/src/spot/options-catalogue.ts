import type { Sql } from 'postgres';
import { requireScope, type Principal } from '@intafaced/auth';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { DeskError } from '../desk/errors.js';
import { OPTIONS_SETTLEMENT_LAW_UNSET } from './options-policy.js';

export const OPTIONS_CATALOGUE_LIMIT_MAX = 500;
export const TRADE_OPTIONS_CATALOGUE_LIMIT_UNSET = 'trade.options_catalogue_limit_unset' as const;
export const TRADE_OPTIONS_CATALOGUE_CURSOR_INVALID = 'trade.options_catalogue_cursor_invalid' as const;

/** Quote fields stay null until a feed exists. Never a synthesised bid, ask, IV, or size. */
export const OPTIONS_NO_QUOTE_FEED = 'no_quote_feed' as const;

export interface OptionsCatalogueQuery {
  readonly underlying?: string | null;
  readonly expiry?: string | null;
  readonly limit?: number | null;
  readonly cursor?: string | null;
}

export interface OptionsCatalogueRow {
  readonly marketId: string;
  readonly symbol: string;
  readonly underlying: string;
  readonly expiry: string;
  readonly strike: string;
  readonly type: 'call' | 'put';
  readonly style: string;
  /** Opaque settlement_fixing stamp stored at list time. Not a settlement price. */
  readonly settlement: string;
  readonly bid: null;
  readonly ask: null;
  readonly iv: null;
  readonly openInterest: null;
  readonly volume: null;
  readonly quoteReason: typeof OPTIONS_NO_QUOTE_FEED;
}

export interface OptionsCataloguePage {
  readonly rows: OptionsCatalogueRow[];
  readonly nextCursor: string | null;
  readonly reason: typeof OPTIONS_SETTLEMENT_LAW_UNSET | null;
  readonly quoteReason: typeof OPTIONS_NO_QUOTE_FEED;
}

interface MarketRow {
  id: string;
  symbol: string;
  base_asset: string;
  option_expiry_at: Date;
  option_strike: string;
  option_type: 'call' | 'put';
  option_style: string;
  settlement_fixing: string;
}

export function publishedOptionsCatalogueLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > OPTIONS_CATALOGUE_LIMIT_MAX) {
    throw new DeskError('options catalogue limit is unset — refuse to invent 50', TRADE_OPTIONS_CATALOGUE_LIMIT_UNSET);
  }
  return value;
}

function encodeCursor(expiry: string, symbol: string): string {
  return Buffer.from(`${expiry}\n${symbol}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { expiry: string; symbol: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new DeskError('options catalogue cursor is invalid', TRADE_OPTIONS_CATALOGUE_CURSOR_INVALID);
  }
  const split = raw.indexOf('\n');
  if (split <= 0 || split === raw.length - 1) {
    throw new DeskError('options catalogue cursor is invalid', TRADE_OPTIONS_CATALOGUE_CURSOR_INVALID);
  }
  const expiry = raw.slice(0, split);
  const symbol = raw.slice(split + 1);
  if (!Number.isFinite(Date.parse(expiry)) || symbol.trim() === '' || symbol.includes('\n')) {
    throw new DeskError('options catalogue cursor is invalid', TRADE_OPTIONS_CATALOGUE_CURSOR_INVALID);
  }
  return { expiry, symbol };
}

function present(row: MarketRow): OptionsCatalogueRow {
  return {
    marketId: row.id,
    symbol: row.symbol,
    underlying: row.base_asset,
    expiry: row.option_expiry_at.toISOString(),
    strike: formatAmount(parseAmount(row.option_strike)),
    type: row.option_type,
    style: row.option_style,
    settlement: row.settlement_fixing,
    bid: null,
    ask: null,
    iv: null,
    openInterest: null,
    volume: null,
    quoteReason: OPTIONS_NO_QUOTE_FEED,
  };
}

/**
 * Listed options from trade.markets. While TRADE_OPTIONS_SETTLEMENT_ASSET_LAW is
 * blank the page is empty and names that key. Quote fields are always null.
 */
export async function listOptionsCatalogue(
  sql: Sql,
  principal: Principal,
  query: OptionsCatalogueQuery,
  settlementAssetLaw: string,
): Promise<OptionsCataloguePage> {
  requireScope(principal, 'trade:read');
  const limit = publishedOptionsCatalogueLimit(query.limit);
  if (settlementAssetLaw.trim().length === 0) {
    return { rows: [], nextCursor: null, reason: OPTIONS_SETTLEMENT_LAW_UNSET, quoteReason: OPTIONS_NO_QUOTE_FEED };
  }
  const underlying = query.underlying?.trim() ?? '';
  const expiry = query.expiry?.trim() ?? '';
  const expiryAt = expiry === '' ? null : new Date(expiry);
  if (expiry !== '' && (expiryAt === null || Number.isNaN(expiryAt.getTime()))) {
    throw new DeskError('options catalogue expiry is not a time', 'trade.options_catalogue_expiry_invalid');
  }
  const cursor = query.cursor == null || query.cursor.trim() === '' ? null : decodeCursor(query.cursor);
  const rows = await selectRows(sql, underlying, expiryAt, cursor, limit + 1);
  const page = rows.slice(0, limit).map(present);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor(last.expiry, last.symbol) : null;
  return { rows: page, nextCursor, reason: null, quoteReason: OPTIONS_NO_QUOTE_FEED };
}

async function selectRows(
  sql: Sql,
  underlying: string,
  expiryAt: Date | null,
  cursor: { expiry: string; symbol: string } | null,
  limit: number,
): Promise<MarketRow[]> {
  const cursorExpiry = cursor ? new Date(cursor.expiry) : null;
  const cursorSymbol = cursor?.symbol ?? null;
  if (underlying && expiryAt && cursorExpiry && cursorSymbol) {
    return sql<MarketRow[]>`
      SELECT id, symbol, base_asset, option_expiry_at, option_strike::text AS option_strike,
             option_type, option_style, settlement_fixing
      FROM trade.markets
      WHERE kind = 'options' AND base_asset = ${underlying} AND option_expiry_at = ${expiryAt}
        AND (option_expiry_at > ${cursorExpiry} OR (option_expiry_at = ${cursorExpiry} AND symbol > ${cursorSymbol}))
      ORDER BY option_expiry_at ASC, symbol ASC
      LIMIT ${limit}
    `;
  }
  if (underlying && expiryAt) {
    return sql<MarketRow[]>`
      SELECT id, symbol, base_asset, option_expiry_at, option_strike::text AS option_strike,
             option_type, option_style, settlement_fixing
      FROM trade.markets
      WHERE kind = 'options' AND base_asset = ${underlying} AND option_expiry_at = ${expiryAt}
      ORDER BY option_expiry_at ASC, symbol ASC
      LIMIT ${limit}
    `;
  }
  if (underlying && cursorExpiry && cursorSymbol) {
    return sql<MarketRow[]>`
      SELECT id, symbol, base_asset, option_expiry_at, option_strike::text AS option_strike,
             option_type, option_style, settlement_fixing
      FROM trade.markets
      WHERE kind = 'options' AND base_asset = ${underlying}
        AND (option_expiry_at > ${cursorExpiry} OR (option_expiry_at = ${cursorExpiry} AND symbol > ${cursorSymbol}))
      ORDER BY option_expiry_at ASC, symbol ASC
      LIMIT ${limit}
    `;
  }
  if (expiryAt && cursorExpiry && cursorSymbol) {
    return sql<MarketRow[]>`
      SELECT id, symbol, base_asset, option_expiry_at, option_strike::text AS option_strike,
             option_type, option_style, settlement_fixing
      FROM trade.markets
      WHERE kind = 'options' AND option_expiry_at = ${expiryAt}
        AND (option_expiry_at > ${cursorExpiry} OR (option_expiry_at = ${cursorExpiry} AND symbol > ${cursorSymbol}))
      ORDER BY option_expiry_at ASC, symbol ASC
      LIMIT ${limit}
    `;
  }
  if (underlying) {
    return sql<MarketRow[]>`
      SELECT id, symbol, base_asset, option_expiry_at, option_strike::text AS option_strike,
             option_type, option_style, settlement_fixing
      FROM trade.markets
      WHERE kind = 'options' AND base_asset = ${underlying}
      ORDER BY option_expiry_at ASC, symbol ASC
      LIMIT ${limit}
    `;
  }
  if (expiryAt) {
    return sql<MarketRow[]>`
      SELECT id, symbol, base_asset, option_expiry_at, option_strike::text AS option_strike,
             option_type, option_style, settlement_fixing
      FROM trade.markets
      WHERE kind = 'options' AND option_expiry_at = ${expiryAt}
      ORDER BY option_expiry_at ASC, symbol ASC
      LIMIT ${limit}
    `;
  }
  if (cursorExpiry && cursorSymbol) {
    return sql<MarketRow[]>`
      SELECT id, symbol, base_asset, option_expiry_at, option_strike::text AS option_strike,
             option_type, option_style, settlement_fixing
      FROM trade.markets
      WHERE kind = 'options'
        AND (option_expiry_at > ${cursorExpiry} OR (option_expiry_at = ${cursorExpiry} AND symbol > ${cursorSymbol}))
      ORDER BY option_expiry_at ASC, symbol ASC
      LIMIT ${limit}
    `;
  }
  return sql<MarketRow[]>`
    SELECT id, symbol, base_asset, option_expiry_at, option_strike::text AS option_strike,
           option_type, option_style, settlement_fixing
    FROM trade.markets
    WHERE kind = 'options'
    ORDER BY option_expiry_at ASC, symbol ASC
    LIMIT ${limit}
  `;
}
