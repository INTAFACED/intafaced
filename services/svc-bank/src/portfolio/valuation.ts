import { DECIMALS, LOCK_KINDS, formatAmount, mul, type Amount, type Balance } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';

/**
 * THE TOTAL-VALUE RULE (UI-SPEC §1.2), written once, here.
 *
 * Home and Money show one number: "Est. total value, in USD". This file is the
 * only place that number is computed. The customer app has a client-side
 * stand-in (`valuePortfolio` in apps/customer/src/data/derive.ts) that follows
 * the same rule until it switches to `bank.portfolio.summary`; if the two ever
 * disagree, this file is right and that one is the bug.
 *
 * The rule:
 *   · USDT, USDC and USD count as exactly 1 USD. They are "cash". Everything
 *     else that is counted is "crypto".
 *   · Any other asset is priced at the LAST price of its asset/USDT market, else
 *     its asset/USDC market. No price (no such market, or it has never traded)
 *     means the asset is listed in `unpriced` and NOT counted. Never guessed,
 *     never valued at zero, never converted through a third market. Other fiat
 *     codes (EUR, ...) land in `unpriced` too: this platform has no FX source.
 *   · svc-trade leaves a market out of `/tickers` when it cannot read its book.
 *     If markets are listed but the ticker answer carries NONE of them, svc-matching
 *     is down and the whole call refuses `bank.prices_unavailable`. If only some
 *     are missing (a new listing with no book), a coin whose candidate markets are
 *     all missing or never traded is `unpriced` with reason `no_price_yet`; a coin
 *     with no USDT/USDC market at all (or another fiat) is `no_market`.
 *   · Holdings are everything the user owns: the main balance plus every Space
 *     (named Spaces sit under the `subaccount` owner type), total = free + used.
 *   · `change24hUsd` = Σ holding × (last − open24h) over the priced assets. It is
 *     "price move on current holdings, NOT profit and loss": trades, deposits and
 *     transfers made today are not in it. It is null if ANY priced non-stable
 *     asset lacks an open24h, never a partial sum.
 *
 * Money: scaled bigints (10^18) in memory, decimal strings on the wire. No
 * `number` touches an amount. Per-asset values keep full precision; the five
 * headline figures are rounded once, half away from zero, to 2 decimals from
 * the full-precision sums (so Cash + Crypto can differ from Total by one cent).
 */

/** The sentence a user may read when the total cannot be shown. */
export const PRICES_UNAVAILABLE_COPY = "Prices can't be loaded right now, so your total can't be shown. Try again in a minute.";

/** Counted as exactly 1 USD. */
export const PAR_ASSETS: ReadonlySet<string> = new Set(['USDT', 'USDC', 'USD']);

/** Quote markets tried in order. */
export const PRICE_QUOTES = ['USDT', 'USDC'] as const;

const DAY_MS = 24 * 3_600_000;
const CENT_UNIT: Amount = 10n ** BigInt(DECIMALS - 2);

/** One holding: what the ledger says the user owns of one asset. */
export interface Holding {
  readonly assetId: string;
  /** Spendable (`available` accounts). */
  readonly free: Amount;
  /** Locked (hold, escrow, stake, collateral). */
  readonly used: Amount;
  /** The part of `used` in the bank's earn positions (`stake` accounts whose purpose is `bank:earn:<id>`). Absent = none. */
  readonly earn?: Amount;
  /** free + used. */
  readonly total: Amount;
}

/** What the valuation needs from one svc-trade ticker. Anything unknown is null. */
export interface TickerQuote {
  readonly last: Amount | null;
  /** First trade price of the rolling 24 h window (svc-trade PR #4642). Null on older svc-trade. */
  readonly open: Amount | null;
  /** Epoch ms the stats really start at. Earlier than now - 24 h never appears; later means a young market. */
  readonly windowStart: number | null;
}

/** Keyed by unified symbol, e.g. "BTC/USDT". */
export type TickerMap = ReadonlyMap<string, TickerQuote>;

/** What the price source answers: the tickers, and which spot markets are listed (active) at all. */
export interface PriceBook {
  readonly tickers: TickerMap;
  readonly listed: ReadonlySet<string>;
}

export interface PricedRow {
  readonly asset: string;
  readonly amount: string;
  readonly priceUsd: string;
  readonly valueUsd: string;
  readonly change24hUsd: string | null;
  /** The market that priced it, e.g. "BTC/USDT". Null for USDT, USDC and USD (par). */
  readonly pair: string | null;
}

export type UnpricedReason = 'no_market' | 'no_price_yet';

export interface UnpricedRow {
  readonly asset: string;
  readonly amount: string;
  /** `no_market`: no USDT/USDC market exists (or another fiat). `no_price_yet`: a market exists but has no readable price. */
  readonly reason: UnpricedReason;
}

export interface PortfolioSummary {
  /** 2-decimal USD. Null only when something is held but none of it can be priced. */
  readonly totalUsd: string | null;
  /** Price move on current holdings, NOT profit and loss. Null when any priced non-stable asset has no open24h. */
  readonly change24hUsd: string | null;
  readonly cashUsd: string | null;
  readonly cryptoUsd: string | null;
  readonly priced: PricedRow[];
  readonly unpriced: UnpricedRow[];
  /** Epoch ms the valuation was taken. */
  readonly asOf: number;
  /** Epoch ms the 24 h figures really start at when a priced market is younger than a day. Null for a full window. */
  readonly windowStart: number | null;
}

/**
 * Ledger rows -> holdings. The same projection svc-trade serves on
 * `GET /api/v1/account/balance` (`presentCcxtBalances`): free = `available`,
 * used = hold + escrow + stake + collateral, total = free + used. svc-bank may
 * not import svc-trade, so the rule is restated here from the ledger-client's
 * own lock-kind list. Zero and negative totals are dropped (no invented rows).
 */
/** The purpose prefix of an earn position's stake account (`earnStakeAccount` in ledger-client). */
const EARN_PURPOSE = 'bank:earn:';

export function holdingsFromBalances(rows: readonly Balance[]): Holding[] {
  const free = new Map<string, Amount>();
  const used = new Map<string, Amount>();
  const earn = new Map<string, Amount>();
  for (const row of rows) {
    const asset = row.account.assetId;
    if (row.account.kind === 'available') free.set(asset, (free.get(asset) ?? 0n) + row.amount);
    else if (LOCK_KINDS.has(row.account.kind)) {
      used.set(asset, (used.get(asset) ?? 0n) + row.amount);
      // Only the bank's earn positions: a token stake (`token:stake:<id>`) is locked but pays nothing here.
      if (row.account.kind === 'stake' && (row.account.purpose ?? '').startsWith(EARN_PURPOSE))
        earn.set(asset, (earn.get(asset) ?? 0n) + row.amount);
    }
  }
  const assets = [...new Set([...free.keys(), ...used.keys()])].sort();
  const out: Holding[] = [];
  for (const assetId of assets) {
    const f = free.get(assetId) ?? 0n;
    const u = used.get(assetId) ?? 0n;
    const e = earn.get(assetId) ?? 0n;
    if (f + u > 0n) out.push({ assetId, free: f, used: u, total: f + u, ...(e > 0n ? { earn: e } : {}) });
  }
  return out;
}

/** True when a held asset needs a market price (so the caller must fetch tickers). */
export function needsPrices(holdings: readonly Holding[]): boolean {
  return holdings.some((h) => !PAR_ASSETS.has(h.assetId.toUpperCase()));
}

/** Scaled 10^18 -> 2-decimal string, half away from zero. */
export function formatUsd2(value: Amount): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  let cents = abs / CENT_UNIT;
  if ((abs % CENT_UNIT) * 2n >= CENT_UNIT) cents += 1n;
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, '0');
  return `${negative && cents !== 0n ? '-' : ''}${whole}.${frac}`;
}

interface Counted {
  readonly row: PricedRow;
  readonly value: Amount;
  readonly change: Amount | null;
  readonly cash: boolean;
}

export function valuePortfolio(input: {
  holdings: readonly Holding[];
  tickers: TickerMap;
  /** Listed spot markets. Defaults to "whatever the tickers carry" (no listing known). */
  listed?: ReadonlySet<string>;
  nowMs: number;
}): PortfolioSummary {
  const { holdings, tickers, nowMs } = input;
  const listed = input.listed ?? new Set<string>();
  // Listed markets and not one of them answered: svc-matching is down, not "some coin is new".
  if (listed.size > 0 && ![...listed].some((symbol) => tickers.has(symbol))) {
    throw new BankError(PRICES_UNAVAILABLE_COPY, 'bank.prices_unavailable');
  }
  const counted: Counted[] = [];
  const unpriced: UnpricedRow[] = [];
  const partialStarts: number[] = [];

  for (const h of holdings) {
    if (h.total <= 0n) continue;
    const asset = h.assetId;
    const code = asset.toUpperCase();

    if (PAR_ASSETS.has(code)) {
      counted.push({
        row: { asset, amount: formatAmount(h.total), priceUsd: '1', valueUsd: formatAmount(h.total), change24hUsd: '0', pair: null },
        value: h.total,
        change: 0n,
        cash: true,
      });
      continue;
    }

    let priced = false;
    let marketExists = false;
    for (const quote of PRICE_QUOTES) {
      const pair = `${code}/${quote}`;
      const t = tickers.get(pair);
      if (t || listed.has(pair)) marketExists = true;
      if (!t || t.last === null || t.last <= 0n) continue;
      const open = t.open !== null && t.open > 0n ? t.open : null;
      const value = mul(h.total, t.last, 'half-up');
      const change = open === null ? null : mul(h.total, t.last - open, 'half-up');
      if (t.windowStart !== null && t.windowStart > nowMs - DAY_MS) partialStarts.push(t.windowStart);
      counted.push({
        row: {
          asset,
          amount: formatAmount(h.total),
          priceUsd: formatAmount(t.last),
          valueUsd: formatAmount(value),
          change24hUsd: change === null ? null : formatAmount(change),
          pair,
        },
        value,
        change,
        cash: false,
      });
      priced = true;
      break;
    }
    if (!priced) unpriced.push({ asset, amount: formatAmount(h.total), reason: marketExists ? 'no_price_yet' : 'no_market' });
  }

  // Biggest first; ties by asset code, so the order is stable.
  counted.sort((a, b) => (a.value === b.value ? a.row.asset.localeCompare(b.row.asset) : a.value > b.value ? -1 : 1));
  unpriced.sort((a, b) => a.asset.localeCompare(b.asset));

  const nothingHeld = counted.length === 0 && unpriced.length === 0;
  const anyCounted = counted.length > 0;
  const sum = (xs: readonly Amount[]) => xs.reduce((s, x) => s + x, 0n);

  const knownChange = counted.every((c) => c.change !== null);
  const total = sum(counted.map((c) => c.value));

  return {
    totalUsd: anyCounted || nothingHeld ? formatUsd2(total) : null,
    change24hUsd: nothingHeld ? '0.00' : anyCounted && knownChange ? formatUsd2(sum(counted.map((c) => c.change as Amount))) : null,
    cashUsd: anyCounted || nothingHeld ? formatUsd2(sum(counted.filter((c) => c.cash).map((c) => c.value))) : null,
    cryptoUsd: anyCounted || nothingHeld ? formatUsd2(sum(counted.filter((c) => !c.cash).map((c) => c.value))) : null,
    priced: counted.map((c) => c.row),
    unpriced,
    asOf: nowMs,
    windowStart: partialStarts.length > 0 ? Math.max(...partialStarts) : null,
  };
}
