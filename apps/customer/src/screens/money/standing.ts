/**
 * Where a person stands on the launch model (OWNER 226; J-home-ia-01 #1 #3, J-wallet-01): the one rule Home and Assets
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
import { div, formatAmount, mul, parseAmount, sum, type Amount } from '@intafaced/money-math';
import type { ValuationPrices } from '@intafaced/contracts/valuation-prices';

export type PartId = 'wallet' | 'venue' | 'partner';

/** One holding as its source reports it. */
export interface SourceRow {
  asset: string;
  amount: string;
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
  /** Full-precision USD value, or null when the asset has no published price. */
  valueUsd: string | null;
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
}

const CENT: Amount = 10n ** 16n;
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

export function standing(parts: PartInput[], prices: ValuationPrices | null, unit: 'USD' | 'BTC'): Standing {
  const published = prices?.published ? prices : null;
  const priceOf = new Map((published?.prices ?? []).map((row) => [row.asset, parseAmount(row.usd)]));
  const unpriced: string[] = [];
  const priced: Amount[] = [];
  const valued = parts.map((part): ValuedPart => {
    const base = { id: part.id, label: part.label, test: part.test ?? false, state: part.read.state };
    if (part.read.state !== 'read') return { ...base, asOf: null, rows: [], valueUsd: null };
    const values: Amount[] = [];
    const rows = part.read.rows
      .filter((row) => !isZero(row.amount))
      .map((row): ValuedRow => {
        const price = priceOf.get(row.asset);
        if (price === undefined) {
          if (!unpriced.includes(row.asset)) unpriced.push(row.asset);
          return { ...row, valueUsd: null };
        }
        const value = mul(parseAmount(row.amount), price);
        values.push(value);
        return { ...row, valueUsd: formatAmount(value) };
      });
    priced.push(...values);
    return { ...base, asOf: part.read.asOf, rows, valueUsd: values.length > 0 ? formatAmount(sum(values)) : null };
  });
  const total = priced.length > 0 ? sum(priced) : null;
  const btcPrice = priceOf.get('BTC');
  const btc =
    unit !== 'BTC'
      ? null
      : total === null
        ? ({ total: null, reason: 'nothing_priced' } as const)
        : btcPrice === undefined
          ? ({ total: null, reason: 'no_btc_price' } as const)
          : { total: fixed(roundTo(div(total, btcPrice), SATOSHI), 8) };
  return {
    parts: valued,
    unread: valued.filter((part) => part.state === 'unread').map((part) => part.id),
    reading: valued.some((part) => part.state === 'reading'),
    unpriced,
    totalUsd: total === null ? null : fixed(roundTo(total, CENT), 2),
    btc,
    prices: published ? { source: published.source, asOf: published.asOf, test: published.test } : null,
  };
}

/** A part's or a row's full-precision USD value as shown: rounded half up to cents. */
export function shownUsd(value: string): string {
  return fixed(roundTo(parseAmount(value), CENT), 2);
}
