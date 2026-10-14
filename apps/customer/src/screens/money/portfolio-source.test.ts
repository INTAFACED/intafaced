import { describe, expect, it } from 'vitest';
import { fromDerived, fromServer, summaryFetcher, SERVER_SUMMARY_MISSING, type ServerSummary } from './portfolio-source';
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
