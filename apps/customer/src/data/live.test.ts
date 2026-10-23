/**
 * Live check against the local stack (skipped unless INTAFACED_LIVE=1).
 *
 *   INTAFACED_LIVE=1 npx vitest run src/data/live.test.ts
 *
 * Signs in as the local test friend (credentials read from
 * ~/.intafaced/local-test-stack/world-accounts.json at run time, never printed),
 * runs the real data layer through the real client against the edge, prints the
 * derived portfolio and the 24 h tickers, and cross-checks the total against an
 * independent sum computed from the very same raw responses.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAmount, formatAmount, mul } from '@intafaced/money-math';
import { z } from 'zod';
import { createApiClient } from '../shared/api';
import { fmtAmount, fmtPct, fmtPrice, fmtUsd, fmtUsdChange } from './format';
import { createPoller } from './poll';
import { allMarketsSource, moversSource, portfolioSource, sparklinesSource, tickersSource, type DataEnv } from './queries';
import type { Loadable } from './types';
import type { Source } from './source';

const EDGE = process.env.INTAFACED_EDGE ?? 'http://127.0.0.1:14500';
const sessionSchema = z.object({ accessToken: z.string(), userId: z.string() }).passthrough();

async function settled<T>(source: Source<T>, label: string, ms = 30_000): Promise<Extract<Loadable<T>, { status: 'ready' }>> {
  const stop = source.subscribe(() => undefined);
  const started = Date.now();
  while (source.getSnapshot().status === 'loading' && Date.now() - started < ms) await new Promise((r) => setTimeout(r, 50));
  const snap = source.getSnapshot();
  stop();
  if (snap.status !== 'ready') throw new Error(`${label}: ${JSON.stringify({ ...snap, retry: undefined })}`);
  return snap;
}

describe.skipIf(!process.env.INTAFACED_LIVE)('live local stack', () => {
  it('derives the portfolio and 24 h tickers from the real endpoints', async () => {
    const accounts = JSON.parse(readFileSync(join(homedir(), '.intafaced/local-test-stack/world-accounts.json'), 'utf8')) as {
      friend: { email: string; password: string };
    };
    const bodies = new Map<string, string>();
    let token: string | undefined;
    const api = createApiClient({
      token: () => token,
      fetch: (async (url: string, init?: RequestInit) => {
        const response = await fetch(`${EDGE}${url}`, init);
        if (/^\/api\/v1\/(account\/balance|tickers)\?|^\/api\/v1\/account\/balance$/.test(url))
          bodies.set(url.split('?')[0]!, await response.clone().text());
        return response;
      }) as typeof fetch,
    });
    const login = await api.mutate(
      'identity',
      'auth.login',
      { identifier: accounts.friend.email, password: accounts.friend.password },
      sessionSchema,
    );
    if (!login.ok) throw new Error(`sign-in failed (${login.reason}${login.code ? ` ${login.code}` : ''})`);
    token = login.data.accessToken;

    const poller = createPoller();
    const env: DataEnv = { poller, api, userId: login.data.userId };

    const markets = await settled(allMarketsSource(env), 'markets');
    const tickers = await settled(tickersSource(env), 'tickers');
    const portfolio = await settled(portfolioSource(env), 'portfolio');
    const sparks = await settled(sparklinesSource(env, Object.keys(tickers.data)), 'sparklines');
    const movers = await settled(moversSource(env, 6), 'movers');
    const tickOf = (symbol: string) => markets.data.find((m) => m.symbol === symbol)?.tickSize ?? null;

    const lines: string[] = [];
    const p = portfolio.data;
    lines.push(
      `PORTFOLIO (source ${p.source}): total ${fmtUsd(p.totalUsd)}  today ${fmtUsdChange(p.change24hUsd)} (${fmtPct(p.change24hPct)})  cash ${fmtUsd(p.cashUsd)}  crypto ${fmtUsd(p.cryptoUsd)}  unpriced [${p.unpriced.join(',')}]`,
    );
    for (const h of p.holdings)
      lines.push(
        `  ${h.asset.padEnd(5)} ${h.class.padEnd(6)} ${fmtAmount(h.total).padStart(12)}  value ${fmtUsd(h.usdValue).padStart(14)}  share ${fmtPct(h.share, { signed: false }).padStart(7)}  via ${h.priceSymbol ?? 'par'}`,
      );
    lines.push('TICKERS (24 h):');
    for (const [symbol, t] of Object.entries(tickers.data).sort()) {
      const since =
        t.windowStart !== null && t.windowStart > Date.now() - 86_400_000
          ? ` since ${new Date(t.windowStart).toISOString().slice(11, 16)}Z`
          : '';
      lines.push(
        `  ${symbol.padEnd(9)} last ${fmtPrice(t.last, tickOf(symbol)).padStart(10)}  chg ${fmtPct(t.changePct24h).padStart(8)}  hi ${fmtPrice(t.high24h, tickOf(symbol)).padStart(10)}  lo ${fmtPrice(t.low24h, tickOf(symbol)).padStart(10)}  vol ${fmtAmount(t.baseVolume24h, { places: 4 }).padStart(9)}  ${t.source}${since}  spark ${sparks.data[symbol]?.length ?? 0} pts`,
      );
    }
    lines.push(
      `MOVERS up [${movers.data.gainers.map((r) => `${r.symbol} ${fmtPct(r.changePct24h)}`).join(', ')}] down [${movers.data.losers.map((r) => `${r.symbol} ${fmtPct(r.changePct24h)}`).join(', ')}]`,
    );

    // Independent check: sum the raw balance x raw last price, from the same responses the data layer received.
    const rawBalance = JSON.parse(bodies.get('/api/v1/account/balance') ?? '{}') as { balances: Record<string, { total: string }> };
    const rawTickers = JSON.parse(bodies.get('/api/v1/tickers') ?? '{}') as Record<string, { last: string | null }>;
    let independent = 0n;
    for (const [asset, entry] of Object.entries(rawBalance.balances)) {
      const total = parseAmount(entry.total);
      if (asset === 'USDT' || asset === 'USDC') independent += total;
      else {
        const last = rawTickers[`${asset}/USDT`]?.last ?? rawTickers[`${asset}/USDC`]?.last;
        if (last) independent += mul(total, parseAmount(last));
      }
    }
    lines.push(
      `CROSS-CHECK: data layer ${p.totalUsd} vs independent sum of the same responses ${formatAmount(independent)} -> ${p.totalUsd === formatAmount(independent) ? 'MATCH' : 'DIFFERENT (prices moved between polls?)'}`,
    );
    console.log(`\n${lines.join('\n')}\n`);
    poller.dispose();

    expect(p.totalUsd).not.toBeNull();
    expect(Object.keys(tickers.data).length).toBeGreaterThan(0);
  }, 90_000);
});
