/**
 * Where the Money screen's numbers come from.
 *
 * First choice is the server's own valuation, `bank.portfolio.summary` (one rule, written once, on the server). If the
 * bank is an older build that does not have it, or cannot be reached, the screen falls back to the data layer's
 * derivation (`usePortfolio()`: balances x tickers) so it still shows the same total. A typed refusal (the bank says
 * prices can't be read, or the account is paused) is shown as that refusal and never papered over by the fallback.
 * Each row of the result says which one it came from (`source`).
 */
import { useMemo } from 'react';
import { z } from 'zod';
import { classOf, useDataEnv, useSource, type Decimal, type Loadable, type PortfolioSummary } from '../../data';
import { dec, decOrNull, ratio, sub, sumOf, type Scaled } from '../../data/decimal';
import { portfolioSource, type DataEnv } from '../../data/queries';
import { constantSource, type Source } from '../../data/source';
import type { Fetcher, Outcome } from '../../data/poll';

export interface MoneyRow {
  asset: string;
  class: 'cash' | 'crypto';
  /** Everything held of this asset: what can be spent plus what is set aside for orders. */
  amount: Decimal;
  usdValue: Decimal | null;
  usdChange24h: Decimal | null;
  /** Today's move as a ratio of the value a day ago ("0.0275"); null when either is unknown. */
  changeRatio: Decimal | null;
  /** Share of the counted total as a ratio ("0.5912"); null for a coin with no price. */
  share: Decimal | null;
  /** The market that priced it ("BTC-USDT"); null for dollar coins and coins with no price. */
  priceSymbol: string | null;
}

export interface MoneyView {
  totalUsd: Decimal | null;
  change24hUsd: Decimal | null;
  change24hPct: Decimal | null;
  cashUsd: Decimal | null;
  cryptoUsd: Decimal | null;
  /** Priced coins by value, biggest first, then the coins with no price. */
  rows: MoneyRow[];
  /** Coins held but left out of the total (no USD price). */
  unpriced: string[];
  /** Epoch ms when today's change only covers part of a day; null for a full day. */
  windowStart: number | null;
  source: 'server' | 'derived';
  asOf: number;
}

// ── the server's answer ──────────────────────────────────────────────────────

const pricedSchema = z.object({
  asset: z.string(),
  amount: z.string(),
  priceUsd: z.string(),
  valueUsd: z.string(),
  change24hUsd: z.string().nullable(),
  pair: z.string().nullable(),
});
const unpricedSchema = z.object({ asset: z.string(), amount: z.string(), reason: z.string() });
export const summarySchema = z.object({
  totalUsd: z.string().nullable(),
  change24hUsd: z.string().nullable(),
  cashUsd: z.string().nullable(),
  cryptoUsd: z.string().nullable(),
  priced: z.array(pricedSchema),
  unpriced: z.array(unpricedSchema),
  asOf: z.number(),
  windowStart: z.number().nullable(),
});
export type ServerSummary = z.infer<typeof summarySchema>;

/** Coin amounts and dollar values in the order the screen shows them. */
function byValue(a: MoneyRow, b: MoneyRow): number {
  const x = dec(a.usdValue);
  const y = dec(b.usdValue);
  if (x === null && y === null) return a.asset.localeCompare(b.asset);
  if (x === null) return 1;
  if (y === null) return -1;
  return x === y ? a.asset.localeCompare(b.asset) : x > y ? -1 : 1;
}

function changeRatioOf(value: Scaled | null, change: Scaled | null): Decimal | null {
  if (value === null || change === null) return null;
  const before = sub(value, change);
  return before > 0n ? decOrNull(ratio(change, before)) : null;
}

export function fromServer(summary: ServerSummary): MoneyView {
  const values = summary.priced.map((row) => dec(row.valueUsd));
  const counted = sumOf(values.filter((value): value is Scaled => value !== null));
  const rows: MoneyRow[] = summary.priced.map((row, index) => {
    const value = values[index] ?? null;
    return {
      asset: row.asset,
      class: classOf(row.asset),
      amount: row.amount,
      usdValue: row.valueUsd,
      usdChange24h: row.change24hUsd,
      changeRatio: changeRatioOf(value, dec(row.change24hUsd)),
      share: value !== null && counted > 0n ? decOrNull(ratio(value, counted)) : null,
      priceSymbol: row.pair ? row.pair.replace('/', '-') : null,
    };
  });
  for (const row of summary.unpriced)
    rows.push({
      asset: row.asset,
      class: classOf(row.asset),
      amount: row.amount,
      usdValue: null,
      usdChange24h: null,
      changeRatio: null,
      share: null,
      priceSymbol: null,
    });
  rows.sort(byValue);

  // Today's percent: the change over what the counted coins were worth a day ago, from the full-precision rows.
  const changes = summary.priced.map((row) => dec(row.change24hUsd));
  const priorParts = values.map((value, index) => (value !== null && changes[index] != null ? sub(value, changes[index]!) : null));
  const totalChange = dec(summary.change24hUsd);
  const prior = priorParts.every((part) => part !== null) && priorParts.length > 0 ? sumOf(priorParts as Scaled[]) : null;
  const pct = totalChange !== null && prior !== null && prior > 0n ? decOrNull(ratio(totalChange, prior)) : null;

  return {
    totalUsd: summary.totalUsd,
    change24hUsd: summary.change24hUsd,
    change24hPct: pct,
    cashUsd: summary.cashUsd,
    cryptoUsd: summary.cryptoUsd,
    rows,
    unpriced: summary.unpriced.map((row) => row.asset),
    windowStart: summary.windowStart,
    source: 'server',
    asOf: summary.asOf,
  };
}

export function fromDerived(summary: PortfolioSummary): MoneyView {
  const rows: MoneyRow[] = summary.holdings.map((holding) => ({
    asset: holding.asset,
    class: holding.class,
    amount: holding.total,
    usdValue: holding.usdValue,
    usdChange24h: holding.usdChange24h,
    changeRatio: changeRatioOf(dec(holding.usdValue), dec(holding.usdChange24h)),
    share: holding.share,
    priceSymbol: holding.priceSymbol,
  }));
  rows.sort(byValue);
  return {
    totalUsd: summary.totalUsd,
    change24hUsd: summary.change24hUsd,
    change24hPct: summary.change24hPct,
    cashUsd: summary.cashUsd,
    cryptoUsd: summary.cryptoUsd,
    rows,
    unpriced: summary.unpriced,
    windowStart: summary.windowStart ?? null,
    source: 'derived',
    asOf: summary.asOf,
  };
}

// ── fetching ─────────────────────────────────────────────────────────────────

/** The refusal code a fetcher sets when this bank has no `portfolio.summary`, so the screen can use the fallback. */
export const SERVER_SUMMARY_MISSING = 'money.server_summary_missing';
const PRICES_DOWN = 'bank.prices_unavailable';
export const SERVER_SUMMARY_KEY = 'bank-portfolio-summary';
const SUMMARY_INTERVAL = 30_000;

export function summaryFetcher(env: DataEnv): Fetcher<ServerSummary> {
  return async (signal): Promise<Outcome<ServerSummary>> => {
    const result = await env.api.query('bank', 'portfolio.summary', undefined, summarySchema, { signal });
    if (result.ok) return result;
    // The bank says it cannot read prices: that is a typed refusal with words of its own (it arrives as a 503, which the
    // poller would otherwise read as a broken connection).
    if (result.code === PRICES_DOWN || result.message.includes(PRICES_DOWN))
      return { ok: false, reason: result.reason, code: PRICES_DOWN, status: 409 };
    // An older bank has no such call (404/501), or answers in a shape we do not know: use the fallback.
    if (result.reason === 'not_mounted' || result.reason === 'not_supported')
      return { ok: false, reason: result.reason, code: SERVER_SUMMARY_MISSING, status: 404 };
    return result;
  };
}

function serverSource(env: DataEnv): Source<ServerSummary> {
  if (!env.userId) return constantSource({ status: 'refused', code: 'auth.required' });
  return env.poller.source(`${SERVER_SUMMARY_KEY}:${env.userId}`, summaryFetcher(env), { intervalMs: SUMMARY_INTERVAL });
}

function mapLoadable<A>(snap: Loadable<A>, map: (value: A) => MoneyView): Loadable<MoneyView> {
  if (snap.status !== 'ready') return snap as Loadable<never>;
  const view = map(snap.data);
  return view.rows.length === 0 ? { status: 'empty' } : { status: 'ready', data: view, asOf: snap.asOf };
}

const WAITING: Loadable<PortfolioSummary> = { status: 'loading' };

/**
 * The Money screen's portfolio. Both hooks are cheap: the fallback only starts reading (and polling) once the server
 * summary has failed, and stops again if the server recovers.
 */
export function useMoneyPortfolio(): Loadable<MoneyView> {
  const env = useDataEnv();
  const server = useSource(useMemo(() => serverSource(env), [env]));
  const fallback = server.status === 'error' || (server.status === 'refused' && server.code === SERVER_SUMMARY_MISSING);
  const derived = useSource(useMemo(() => (fallback ? portfolioSource(env) : constantSource(WAITING)), [env, fallback]));
  return useMemo(() => (fallback ? mapLoadable(derived, fromDerived) : mapLoadable(server, fromServer)), [fallback, derived, server]);
}

// ── named accounts ("Spaces" on the server) ──────────────────────────────────

const spaceSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  kind: z.string(),
  name: z.string(),
  balance: z.string(),
});
export interface NamedAccount {
  id: string;
  name: string;
  asset: string;
  balance: Decimal;
}

function accountsFetcher(env: DataEnv): Fetcher<NamedAccount[]> {
  return async (signal) => {
    const result = await env.api.query('bank', 'spaces.list', { limit: 200 }, z.array(spaceSchema), { signal });
    if (!result.ok) return result;
    return {
      ok: true,
      data: result.data
        .filter((space) => space.kind === 'named')
        .map((space) => ({ id: space.id, name: space.name, asset: space.assetId, balance: space.balance })),
    };
  };
}

/** The person's named accounts, each with its balance. Empty when they have none; hidden by the screen when the bank will not say. */
export function useNamedAccounts(): Loadable<NamedAccount[]> {
  const env = useDataEnv();
  const source = useMemo(
    () =>
      env.userId
        ? env.poller.source(`bank-named-accounts:${env.userId}`, accountsFetcher(env), { intervalMs: 60_000 })
        : constantSource<NamedAccount[]>({ status: 'empty' }),
    [env],
  );
  const snap = useSource(source);
  return useMemo(() => (snap.status === 'ready' && snap.data.length === 0 ? { status: 'empty' } : snap), [snap]);
}
