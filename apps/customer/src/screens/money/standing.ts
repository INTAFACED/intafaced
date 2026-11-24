/**
 * Where a person stands on the launch model (J-home-ia-01 #1 #3, J-wallet-01): the one rule Home and Assets
 * both value holdings by, so the two rooms show the same figures to the digit.
 *
 * What a person holds sits in up to three places, each read from its own source with that source's as-of time: their
 * wallet (the chain), their venue account (the venue) and their partner account (the partner). INTAFACED holds none of
 * it. The total is a sum of what those sources report, each part named, never a balance of ours:
 *
 *   · a part whose source cannot be read is named in `unread` and left out of the total, never counted as zero;
 *   · an asset is valued only at a published price (svc-ops `valuation.prices`, the owner's source; a labelled TEST list
 *     on a test stack). An asset with none is named in `unpriced` and left out, never counted as zero;
 *   · with no price published at all, or nothing priced, there is no total (`totalUsd` null), only the parts;
 *   · the total in BTC needs a published BTC price; without one the total stays in dollars and `btc` says why.
 *
 * Money: decimal strings in, scaled bigints (18 places) inside, decimal strings out; no `number` touches an amount.
 * Every value keeps full precision until it is shown: the total is rounded once, half up, to cents (BTC: 8 places).
 */
import { SCALE, add, div, formatAmount, mul, parseAmount, sub, sum, type Amount } from '@intafaced/money-math';
import type { ValuationPrices } from '@intafaced/contracts/valuation-prices';
import type { MoneyRow, MoneyView } from './portfolio-source';

/**
 * A part's figure is stale once its source's own time is more than 30 s old: ten of the rooms' 3 s reads
 * (`standing-data.ts`), the limit the trade rooms hold prices to.
 */
export const STANDING_STALE_AFTER_MS = 30_000;

/** Stable coins counted at exactly $1 when valuation prices are published (J-portfolio-01 #2). */
export const PAR_ASSETS: ReadonlySet<string> = new Set(['USDT', 'USDC', 'USD']);

const DAY_MS = 86_400_000;
const ONE: Amount = SCALE;

export type PartId = 'wallet' | 'venue' | 'partner';

/** One asset's spot quote from the venue's own market data: last trade price and 24-hour open. */
export interface VenueQuote {
  /** The venue spot market symbol that prices this asset (e.g. "BTC-USDC"). */
  symbol: string;
  /** Last trade price in USD (exact decimal string > 0), or null when the market has no print yet. */
  last: string | null;
  /** 24-hour open price in USD (exact decimal string > 0), or null when no 24-hour open is known. */
  open: string | null;
  /** Epoch ms when today's window started if the venue has less than 24 h of prints; null for a full day. */
  windowStart: number | null;
}

/** Spot market quotes read from the venue (J-portfolio-01 #2 #7). */
export interface VenueMarketQuotes {
  venueName: string;
  test: boolean;
  asOf: string;
  /** By upper-case base asset: its listed USDT or USDC spot market and latest quote. */
  byAsset: ReadonlyMap<string, VenueQuote>;
}

function positiveDecimal(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = parseAmount(raw);
    return parsed > 0n ? formatAmount(parsed) : null;
  } catch {
    return null;
  }
}

/**
 * Works out a market's last trade price and 24-hour open from the venue's own hourly candles.
 * Empty candles -> no last price yet; prints all older than 24 h -> last price known, 24 h move unknown.
 */
export function quoteFromCandles(
  symbol: string,
  candles: ReadonlyArray<{ openAt: string; openPrice: string; closePrice: string }>,
  asOfIso: string,
): VenueQuote {
  if (candles.length === 0) return { symbol, last: null, open: null, windowStart: null };
  const ordered = [...candles].sort((a, b) => Date.parse(a.openAt) - Date.parse(b.openAt));
  const newest = ordered[ordered.length - 1]!;
  const last = positiveDecimal(newest.closePrice);
  if (last === null) return { symbol, last: null, open: null, windowStart: null };
  const nowMs = Date.parse(asOfIso);
  if (!Number.isFinite(nowMs)) return { symbol, last, open: null, windowStart: null };
  const sinceMs = nowMs - DAY_MS;
  const inWindow = ordered.filter((c) => Date.parse(c.openAt) >= sinceMs);
  if (inWindow.length === 0) return { symbol, last, open: null, windowStart: null };
  const prior = ordered.filter((c) => Date.parse(c.openAt) < sinceMs);
  if (prior.length > 0) {
    const open = positiveDecimal(prior[prior.length - 1]!.closePrice);
    return { symbol, last, open, windowStart: null };
  }
  const first = inWindow[0]!;
  const open = positiveDecimal(first.openPrice);
  const openAtMs = Date.parse(first.openAt);
  return { symbol, last, open, windowStart: Number.isFinite(openAtMs) ? openAtMs : null };
}

/** One holding as its source reports it. */
export interface SourceRow {
  asset: string;
  amount: string;
  /** A row a source holds apart from its plain balance of `asset` (a venue vault position, `vault:<address>`). */
  key?: string;
}

/** What one source answered: still reading, could not be read, or its rows as of its own time. */
export type PartRead = { state: 'reading' } | { state: 'unread' } | { state: 'read'; asOf: string; rows: SourceRow[] };

export interface PartInput {
  id: PartId;
  /** Who reports it, as a person reads it: the network, the venue's or the partner's own name. */
  label: string;
  read: PartRead;
  /** The source's figures are TEST figures. */
  test?: boolean;
}

export interface ValuedRow extends SourceRow {
  /** The published USD price the row is valued at, as published, or null when the asset has none. */
  priceUsd: string | null;
  /** Full-precision USD value, or null when the asset has no published price. */
  valueUsd: string | null;
  /** The row's share of the total, in percent to 2 places (rounded half up), or null when it or the total is not valued. */
  share: string | null;
}

export interface ValuedPart {
  id: PartId;
  label: string;
  test: boolean;
  state: PartRead['state'];
  asOf: string | null;
  rows: ValuedRow[];
  /** Full-precision USD sum of this part's priced rows; null when none of it is priced or it was not read. */
  valueUsd: string | null;
}

export interface Standing {
  parts: ValuedPart[];
  /** Parts whose source did not answer: named, left out of the total. */
  unread: PartId[];
  /** True while any source is still answering its first read. */
  reading: boolean;
  /** Assets held with no published price, in the order first met: named, left out of the total. */
  unpriced: string[];
  /** The total in USD rounded to cents, or null when nothing is priced. */
  totalUsd: string | null;
  /** The total in BTC (8 places) when the unit is BTC and BTC has a published price; else why it is in dollars. */
  btc: { total: string } | { total: null; reason: 'no_btc_price' | 'nothing_priced' } | null;
  /** The price source: who states the prices, when, and whether they are TEST. Null when none is published. */
  prices: { source: string; asOf: string; test: boolean } | null;
  /** Per-asset valuation view (same prices as the total), feeding ValuationNote and Movers; null when prices are unpublished. */
  valuation: MoneyView | null;
}

const CENT: Amount = 10n ** 16n;
const HUNDRED: Amount = 100n * 10n ** 18n;
const SATOSHI: Amount = 10n ** 10n;

/** Rounds a scaled amount half up to a step (10^16 is a cent, 10^10 is 8 places). Amounts here are never negative. */
function roundTo(value: Amount, step: Amount): Amount {
  return ((value + step / 2n) / step) * step;
}

/** A scaled amount as a decimal string with exactly `places` places. */
function fixed(value: Amount, places: number): string {
  const [whole, fraction = ''] = formatAmount(value).split('.');
  return places === 0 ? whole! : `${whole}.${fraction.padEnd(places, '0').slice(0, places)}`;
}

const isZero = (decimal: string) => !/[1-9]/.test(decimal);

function signedRatio(change: Amount, prior: Amount): string | null {
  if (prior <= 0n) return null;
  return formatAmount((change * SCALE) / prior);
}

interface ResolvedPrice {
  price: Amount;
  cash: boolean;
  priceSymbol: string | null;
  open: Amount | null;
  windowStart: number | null;
}

function resolvePrice(
  asset: string,
  priceOf: ReadonlyMap<string, Amount>,
  venueQuotes: VenueMarketQuotes | null,
): { priced: ResolvedPrice } | { unpriced: 'no_market' | 'no_price_yet' } {
  const code = asset.toUpperCase();
  const listed = priceOf.get(code);
  if (listed !== undefined) {
    return {
      priced: {
        price: listed,
        cash: PAR_ASSETS.has(code) && listed === ONE,
        priceSymbol: null,
        open: null,
        windowStart: null,
      },
    };
  }
  if (PAR_ASSETS.has(code)) {
    return {
      priced: {
        price: ONE,
        cash: true,
        priceSymbol: null,
        open: null,
        windowStart: null,
      },
    };
  }
  const quote = venueQuotes?.byAsset.get(code);
  if (quote?.last) {
    return {
      priced: {
        price: parseAmount(quote.last),
        cash: false,
        priceSymbol: quote.symbol,
        open: quote.open ? parseAmount(quote.open) : null,
        windowStart: quote.windowStart,
      },
    };
  }
  return { unpriced: quote ? 'no_price_yet' : 'no_market' };
}

function byMoneyRowValue(a: MoneyRow, b: MoneyRow): number {
  const x = a.usdValue !== null ? parseAmount(a.usdValue) : null;
  const y = b.usdValue !== null ? parseAmount(b.usdValue) : null;
  if (x === null && y === null) return a.asset.localeCompare(b.asset);
  if (x === null) return 1;
  if (y === null) return -1;
  return x === y ? a.asset.localeCompare(b.asset) : x > y ? -1 : 1;
}

export function standing(
  parts: PartInput[],
  prices: ValuationPrices | null,
  unit: 'USD' | 'BTC',
  venueQuotes: VenueMarketQuotes | null = null,
): Standing {
  const published = prices?.published ? prices : null;
  const priceOf = new Map((published?.prices ?? []).map((row) => [row.asset.toUpperCase(), parseAmount(row.usd)]));
  const activeQuotes = published ? venueQuotes : null;
  const unpriced: string[] = [];
  const priced: Amount[] = [];
  const heldByAsset = new Map<string, { asset: string; amount: Amount }>();
  const valued = parts.map((part): ValuedPart => {
    const base = { id: part.id, label: part.label, test: part.test ?? false, state: part.read.state };
    if (part.read.state !== 'read') return { ...base, asOf: null, rows: [], valueUsd: null };
    const values: Amount[] = [];
    const rows = part.read.rows
      .filter((row) => !isZero(row.amount))
      .map((row): ValuedRow => {
        const amount = parseAmount(row.amount);
        const code = row.asset.toUpperCase();
        const prev = heldByAsset.get(code);
        heldByAsset.set(code, { asset: prev?.asset ?? row.asset, amount: prev ? add(prev.amount, amount) : amount });
        if (!published) {
          if (!unpriced.includes(row.asset)) unpriced.push(row.asset);
          return { ...row, priceUsd: null, valueUsd: null, share: null };
        }
        const resolved = resolvePrice(row.asset, priceOf, activeQuotes);
        if ('unpriced' in resolved) {
          if (!unpriced.includes(row.asset)) unpriced.push(row.asset);
          return { ...row, priceUsd: null, valueUsd: null, share: null };
        }
        const value = mul(amount, resolved.priced.price);
        values.push(value);
        return { ...row, priceUsd: formatAmount(resolved.priced.price), valueUsd: formatAmount(value), share: null };
      });
    priced.push(...values);
    return { ...base, asOf: part.read.asOf, rows, valueUsd: values.length > 0 ? formatAmount(sum(values)) : null };
  });
  const total = priced.length > 0 ? sum(priced) : null;
  // Each valued row's share of the total, from full-precision figures: value × 100 / total, rounded once to 0.01.
  if (total !== null && total > 0n)
    for (const part of valued)
      for (const row of part.rows)
        if (row.valueUsd !== null) row.share = fixed(roundTo(div(mul(parseAmount(row.valueUsd), HUNDRED), total, 'floor'), CENT), 2);
  const btcQuote = activeQuotes?.byAsset.get('BTC')?.last;
  const btcPrice = priceOf.get('BTC') ?? (btcQuote ? parseAmount(btcQuote) : undefined);
  const btc =
    unit !== 'BTC'
      ? null
      : total === null
        ? ({ total: null, reason: 'nothing_priced' } as const)
        : btcPrice === undefined
          ? ({ total: null, reason: 'no_btc_price' } as const)
          : { total: fixed(roundTo(div(total, btcPrice), SATOSHI), 8) };

  let valuation: MoneyView | null = null;
  if (published) {
    const valuationRows: MoneyRow[] = [];
    const unpricedReasons: Record<string, 'no_market' | 'no_price_yet'> = {};
    let cashTotal: Amount = 0n;
    let cryptoTotal: Amount = 0n;
    let changeTotal: Amount | null = 0n;
    let priorTotal: Amount | null = 0n;
    let windowStart: number | null = null;
    for (const { asset, amount } of heldByAsset.values()) {
      const resolved = resolvePrice(asset, priceOf, activeQuotes);
      if ('unpriced' in resolved) {
        unpricedReasons[asset] = resolved.unpriced;
        valuationRows.push({
          asset,
          class: 'crypto',
          amount: formatAmount(amount),
          usdValue: null,
          usdChange24h: null,
          changeRatio: null,
          share: null,
          priceSymbol: null,
          priceUsd: null,
        });
        continue;
      }
      const p = resolved.priced;
      const value = mul(amount, p.price);
      if (p.cash) cashTotal = add(cashTotal, value);
      else cryptoTotal = add(cryptoTotal, value);
      let change: Amount | null = null;
      let ratioText: string | null = null;
      if (p.cash) {
        change = 0n;
        if (priorTotal !== null) priorTotal = add(priorTotal, value);
      } else if (p.open !== null && p.open > 0n) {
        const prior = mul(amount, p.open);
        change = sub(value, prior);
        ratioText = signedRatio(change, prior);
        if (changeTotal !== null) changeTotal = add(changeTotal, change);
        if (priorTotal !== null) priorTotal = add(priorTotal, prior);
        if (p.windowStart !== null && (windowStart === null || p.windowStart > windowStart)) windowStart = p.windowStart;
      } else {
        changeTotal = null;
        priorTotal = null;
      }
      valuationRows.push({
        asset,
        class: p.cash ? 'cash' : 'crypto',
        amount: formatAmount(amount),
        usdValue: formatAmount(value),
        usdChange24h: change === null ? null : formatAmount(change),
        changeRatio: ratioText,
        share: total !== null && total > 0n ? formatAmount(div(value, total, 'floor')) : null,
        priceSymbol: p.priceSymbol,
        priceUsd: formatAmount(p.price),
      });
    }
    valuationRows.sort(byMoneyRowValue);
    const pricesMs = Date.parse(published.asOf);
    const venueMs = activeQuotes ? Date.parse(activeQuotes.asOf) : NaN;
    const asOfMs = Number.isFinite(venueMs) && (!Number.isFinite(pricesMs) || venueMs > pricesMs) ? venueMs : pricesMs;
    valuation = {
      totalUsd: total === null ? null : fixed(roundTo(total, CENT), 2),
      change24hUsd: total === null || changeTotal === null ? null : formatAmount(changeTotal),
      change24hPct:
        total === null || changeTotal === null || priorTotal === null || priorTotal <= 0n ? null : signedRatio(changeTotal, priorTotal),
      cashUsd: total === null ? null : formatAmount(cashTotal),
      cryptoUsd: total === null ? null : formatAmount(cryptoTotal),
      rows: valuationRows,
      unpriced: [...unpriced],
      unpricedReasons,
      windowStart,
      source: 'server',
      asOf: Number.isFinite(asOfMs) ? asOfMs : Date.now(),
      btc: null,
    };
  }

  return {
    parts: valued,
    unread: valued.filter((part) => part.state === 'unread').map((part) => part.id),
    reading: valued.some((part) => part.state === 'reading'),
    unpriced,
    totalUsd: total === null ? null : fixed(roundTo(total, CENT), 2),
    btc,
    prices: published ? { source: published.source, asOf: published.asOf, test: published.test } : null,
    valuation,
  };
}

/** A part's or a row's full-precision USD value as shown: rounded half up to cents. */
export function shownUsd(value: string): string {
  return fixed(roundTo(parseAmount(value), CENT), 2);
}
