import { describe, expect, it } from 'vitest';
import {
  fromDerived,
  fromServer,
  pickMoneyView,
  summaryFetcher,
  toHomePortfolio,
  SERVER_SUMMARY_MISSING,
  type ServerSummary,
} from './portfolio-source';
import { valuePortfolio } from '../../data/derive';
import type { DataEnv } from '../../data/queries';

const summary = (over: Partial<ServerSummary> = {}): ServerSummary => ({
  totalUsd: '12481.91',
  change24hUsd: '206.26',
  cashUsd: '4100.00',
  cryptoUsd: '8381.91',
  priced: [
    { asset: 'USDT', amount: '4100.00', priceUsd: '1', valueUsd: '4100', change24hUsd: '0', pair: null },
    { asset: 'BTC', amount: '0.1', priceUsd: '67812.40', valueUsd: '6781.24', change24hUsd: '181.24', pair: 'BTC/USDT' },
    { asset: 'DOGE', amount: '5', priceUsd: '0.12345', valueUsd: '0.61725', change24hUsd: '-0.0321', pair: 'DOGE/USDT' },
  ],
  unpriced: [{ asset: 'ZED', amount: '12', reason: 'no_market' }],
  asOf: 1,
  windowStart: null,
  ...over,
});

describe('fromServer', () => {
  it("orders priced coins by value, unpriced last, and keeps the bank's own headline figures", () => {
    const view = fromServer(summary());
    expect(view.rows.map((row) => row.asset)).toEqual(['BTC', 'USDT', 'DOGE', 'ZED']);
    expect(view.totalUsd).toBe('12481.91');
    expect(view.cashUsd).toBe('4100.00');
    expect(view.unpriced).toEqual(['ZED']);
    expect(view.source).toBe('server');
  });

  it("derives class, share, today's move and the pair from the rows (decimal strings, no floats)", () => {
    const view = fromServer(summary());
    const btc = view.rows.find((row) => row.asset === 'BTC')!;
    expect(btc.class).toBe('crypto');
    expect(btc.priceSymbol).toBe('BTC-USDT');
    expect(btc.amount).toBe('0.1');
    expect(btc.share?.startsWith('0.623')).toBe(true);
    expect(btc.changeRatio?.startsWith('0.0274')).toBe(true); // 181.24 / (6781.24 - 181.24)
    expect(view.rows.find((row) => row.asset === 'USDT')!.class).toBe('cash');
    expect(view.rows.find((row) => row.asset === 'ZED')).toMatchObject({ usdValue: null, share: null, changeRatio: null });
  });

  it("gives today's percent over what the counted coins were worth a day ago", () => {
    const view = fromServer(summary());
    // prior = 4100 + 6600 + 0.64935 = 10700.64935; 206.26 / that = 1.927...%
    expect(view.change24hPct?.startsWith('0.01927')).toBe(true);
  });

  it('has no percent when the bank sends no change', () => {
    expect(fromServer(summary({ change24hUsd: null })).change24hPct).toBeNull();
  });
});

describe('fromDerived', () => {
  it("maps the data layer's holdings to the same shape", () => {
    const derived = valuePortfolio({
      balances: { USDT: { free: '100', used: '0', total: '100' } },
      markets: [],
      tickers: {},
      nowMs: 1,
    });
    const view = fromDerived(derived);
    expect(view.source).toBe('derived');
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ asset: 'USDT', class: 'cash', amount: '100', usdValue: '100' });
  });
});

describe('pickMoneyView', () => {
  const retry = () => {};
  const emptyDerived = { status: 'ready' as const, data: valuePortfolio({ balances: {}, markets: [], tickers: {}, nowMs: 1 }), asOf: 1 };
  it('shows the bank error, not an invented zero, when the fallback has no rows', () => {
    const view = pickMoneyView(true, { status: 'error', retry }, emptyDerived);
    expect(view).toEqual({ status: 'error', retry });
  });
  it('shows the labelled fallback when it has rows', () => {
    const derived = {
      status: 'ready' as const,
      data: valuePortfolio({ balances: { USDT: { free: '5', used: '0', total: '5' } }, markets: [], tickers: {}, nowMs: 1 }),
      asOf: 1,
    };
    const view = pickMoneyView(true, { status: 'error', retry }, derived);
    expect(view.status).toBe('ready');
    if (view.status === 'ready') expect(view.data.source).toBe('derived');
  });
  it("uses the bank's summary when it answered", () => {
    expect(pickMoneyView(false, { status: 'ready', data: summary(), asOf: 1 }, { status: 'loading' }).status).toBe('ready');
  });
});

type Answer = { ok: true; data: unknown } | { ok: false; reason: string; message: string; status?: number; code?: string };
const envWith = (answer: Answer) => ({ api: { query: async () => answer } }) as unknown as DataEnv;
const signal = new AbortController().signal;

describe('summaryFetcher', () => {
  it('passes a good answer through', async () => {
    const out = await summaryFetcher(envWith({ ok: true, data: summary() }))(signal);
    expect(out.ok).toBe(true);
  });

  it('marks an older bank (404 or 501) so the screen can use the fallback', async () => {
    for (const reason of ['not_mounted', 'not_supported']) {
      const out = await summaryFetcher(envWith({ ok: false, reason, message: 'x', status: 404 }))(signal);
      expect(out).toMatchObject({ ok: false, code: SERVER_SUMMARY_MISSING, status: 404 });
    }
  });

  it('reads "prices unavailable" as a typed refusal even though it arrives as a 503', async () => {
    const byCode = await summaryFetcher(
      envWith({ ok: false, reason: 'unreachable', message: 'x', status: 503, code: 'bank.prices_unavailable' }),
    )(signal);
    const byMessage = await summaryFetcher(
      envWith({
        ok: false,
        reason: 'unreachable',
        message: 'Prices cannot be loaded. (bank.prices_unavailable)',
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
      }),
    )(signal);
    for (const out of [byCode, byMessage]) expect(out).toMatchObject({ ok: false, code: 'bank.prices_unavailable', status: 409 });
  });

  it('leaves any other failure alone', async () => {
    const out = await summaryFetcher(envWith({ ok: false, reason: 'unreachable', message: 'down', status: 502 }))(signal);
    expect(out).toMatchObject({ ok: false, status: 502 });
    expect((out as { code?: string }).code).toBeUndefined();
  });
});

describe('toHomePortfolio (Home shows the Money total)', () => {
  it("carries the bank's own total, which counts named spaces, unchanged", () => {
    // The bank's total (12481.91) is what Money shows; Home must show the same, not a sum it works out itself.
    const money = fromServer(summary());
    const home = toHomePortfolio(money);
    expect(home.totalUsd).toBe(money.totalUsd);
    expect(home.totalUsd).toBe('12481.91');
    expect([home.cashUsd, home.cryptoUsd, home.change24hUsd, home.change24hPct]).toEqual([
      money.cashUsd,
      money.cryptoUsd,
      money.change24hUsd,
      money.change24hPct,
    ]);
    expect(home.source).toBe('server');
    expect(home.unpriced).toEqual(['ZED']);
  });
  it('lists the same coins in the same order with exact amounts', () => {
    const home = toHomePortfolio(fromServer(summary()));
    expect(home.holdings.map((holding) => [holding.asset, holding.total])).toEqual([
      ['BTC', '0.1'],
      ['USDT', '4100.00'],
      ['DOGE', '5'],
      ['ZED', '12'],
    ]);
  });
  it('says so when it had to use the fallback', () => {
    const derived = valuePortfolio({
      balances: { USDT: { free: '100', used: '0', total: '100' } },
      markets: [],
      tickers: {},
      nowMs: 1,
    });
    expect(toHomePortfolio(fromDerived(derived)).source).toBe('derived');
  });
});

describe('display unit and account scope (PF-overview-03)', () => {
  const capture = () => {
    const calls: unknown[] = [];
    const env = {
      api: {
        query: async (_service: string, _procedure: string, input: unknown) => {
          calls.push(input);
          return { ok: true, data: summary() };
        },
      },
    } as unknown as DataEnv;
    return { calls, env };
  };

  it('asks for nothing special in the default view, so Home and Money share one request', async () => {
    const { calls, env } = capture();
    await summaryFetcher(env)(signal);
    expect(calls).toEqual([undefined]);
  });

  it('asks for BTC and for one account by the names the bank knows', async () => {
    const { calls, env } = capture();
    await summaryFetcher(env, 'space-1', 'BTC')(signal);
    await summaryFetcher(env, 'main', 'USD')(signal);
    expect(calls).toEqual([{ scope: 'space-1', displayCurrency: 'BTC' }, { scope: 'main' }]);
  });

  it("keeps the bank's BTC total verbatim, with the reason when there is no BTC price", () => {
    const withBtc = fromServer(summary({ btc: { total: '0.18406493', priceUsd: '67812.40', reason: null } }));
    expect(withBtc.btc).toEqual({ total: '0.18406493', priceUsd: '67812.40', reason: null });
    const noPrice = fromServer(summary({ btc: { total: null, priceUsd: null, reason: 'no_price_published' } }));
    expect(noPrice.btc).toEqual({ total: null, priceUsd: null, reason: 'no_price_published' });
    expect(fromServer(summary()).btc).toBeNull();
  });
});
