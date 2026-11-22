import { describe, expect, it } from 'vitest';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  signPrincipalHeader,
  type QuantSignalRules,
} from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { Bar } from '../engine/bars.js';
import { tradeVenuePricePort, type FeePort, type HistoryPort, type VenuePricePort } from '../engine/ports.js';
import { createMemoryQuota } from '../quota/memory.js';
import { createQuantRouter } from '../router.js';
import { RUN_RESULT_MAX_BYTES } from '../runs/limit.js';
import { createMemoryRunRepository } from '../runs/memory-repository.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';

// AL-live-01: paper runs on the venue's own closed candles, derived on read (J-algo-dev-04 #2); J-algo-dev-03 #6's
// concurrent-run quota.
const SECRET = 'a-quant-paper-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const HOUR = 3_600_000;

const RULES: QuantSignalRules = {
  symbol: 'BTC/USDT',
  barSize: '1h',
  signal: { kind: 'ma_cross', average: 'sma', fast: '1', slow: '2' },
  sizing: { kind: 'quantity', value: '1' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
};

function signed(userId: string, scopes: string[] = ['trade:read']) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'basic' as const,
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return edgeContext({
    headers: {
      'x-intafaced-region': 'DE',
      [EDGE_PRINCIPAL_HEADER]: raw,
      [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, SECRET, 'DE'),
    },
    id: `req-${userId}-${scopes.join(',')}`,
  });
}

/** Hourly closed bars, rising then falling, at every hour the read asks for: the venue's own prints, as svc-trade gives them. */
const CLOSES = ['100', '110', '120', '130', '115', '100', '90', '95', '105', '120'];
function hourly(fromMs: number, toMs: number): Bar[] {
  const bars: Bar[] = [];
  for (let t = Math.ceil(fromMs / HOUR) * HOUR, i = 0; t + HOUR <= toMs; t += HOUR, i += 1) {
    const close = CLOSES[i % CLOSES.length]!;
    const open = i === 0 ? close : CLOSES[(i - 1) % CLOSES.length]!;
    bars.push({
      openTimeMs: t,
      open: parseAmount(open),
      high: parseAmount(close > open ? close : open),
      low: parseAmount(close < open ? close : open),
      close: parseAmount(close),
    });
  }
  return bars;
}
/** The venue's candle read: BTC-USDC's prints on a TEST venue, or a read that does not answer. */
function venue(read: { fromMs: number; toMs: number }[] = [], answer: 'up' | 'down' = 'up'): VenuePricePort {
  return {
    wired: true,
    async bars({ fromMs, toMs }) {
      read.push({ fromMs, toMs });
      if (answer === 'down') return { unavailable: "the venue's price read answered 404 (trade.user_venue_off)" };
      return { venueMarket: 'BTC-USDC', test: true, bars: hourly(fromMs, toMs) };
    },
  };
}
/** Our own exchange's tape: a paper run never reads it. */
const ownTape: HistoryPort = {
  wired: true,
  bars: async () => {
    throw new Error('a paper run read our own tape');
  },
};
const fees: FeePort = { wired: true, fee: async () => ({ version: 'local-test:v1', makerBps: 8, takerBps: 10 }) } as FeePort;

function setup(options: { concurrent?: string; venue?: 'up' | 'down' } = {}) {
  let offset = 0;
  const quota = createMemoryQuota({ defaultProfile: 'TEST default' });
  const app = createQuantRouter({
    wired: true,
    venueVaultSet: false,
    limits: { maxOps: 5_000, maxSource: 8_000 },
    strategies: createMemoryStrategyRepository(quota.gate),
    runs: createMemoryRunRepository(RUN_RESULT_MAX_BYTES, quota.gate),
    quota: quota.repository,
    history: ownTape,
    venuePrices: venue([], options.venue ?? 'up'),
    fees,
    now: () => Date.now() + offset,
  });
  const writer = app.createCaller(signed(OPERATOR, ['admin:write']));
  const limits = {
    strategies: '10',
    versions: '10',
    concurrent_runs: options.concurrent ?? '10',
    paper_runs: '10',
    runs: '10',
    storage: '10000000',
  };
  return {
    a: app.createCaller(signed(ACCOUNT_A)),
    b: app.createCaller(signed(ACCOUNT_B)),
    later: (hours: number) => {
      offset = hours * HOUR;
    },
    async plan() {
      for (const [resource, limit] of Object.entries(limits)) {
        await writer.ops.quota.set({
          profile: 'TEST default',
          resource: resource as 'runs',
          limit,
          reason: 'LOCAL TEST',
          idempotencyKey: `quota:${resource}:${limit}`,
        });
      }
    },
  };
}

async function saved(a: ReturnType<typeof setup>['a']) {
  return a.studio.save({
    name: 'TEST paper',
    blocks: [],
    modules: RULES,
    risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
    cash: '1000',
    environment: 'paper',
    clientStrategyId: 'client-paper',
    idempotencyKey: 'save-paper',
  });
}

const start = (strategyId: string, ordinal: number, over: Partial<{ cash: string; feed: string }> = {}) => ({
  strategyId,
  strategyVersion: 1,
  cash: over.cash ?? '1000',
  holdings: [],
  feed: over.feed ?? 'own_venue',
  costs: { feeRole: 'taker', slippageBps: '5', delayBars: '0' },
  ordinal,
});

describe('paper runs (AL-live-01)', () => {
  it('refuses a blank cash and an outside feed by name, and starts nothing', async () => {
    const t = setup();
    await t.plan();
    const s = await saved(t.a);
    await expect(t.a.paper.start(start(s.id, 0, { cash: ' ' }))).rejects.toThrow(/^quant\.paper_cash_unset/);
    await expect(t.a.paper.start(start(s.id, 0, { feed: 'outside_market' }))).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/^feed\.market — /),
    });
    expect((await t.a.paper.list({ strategyId: s.id, limit: 10 })).runs).toEqual([]);
    await expect(t.a.paper.list({ strategyId: s.id })).rejects.toThrow(/^quant\.paper_list_limit_unset/);
  });

  it('runs on the closed bars after its start only, reads the same run on a retry, and keeps its record when stopped', async () => {
    const t = setup();
    await t.plan();
    const s = await saved(t.a);
    const first = await t.a.paper.start(start(s.id, 0));
    expect(first).toMatchObject({ state: 'running', priced: false, trades: [], claimLabel: 'Paper — not live performance', live: false });
    // A lost reply, pressed again from the same dialog: the same run, not a second one.
    expect((await t.a.paper.start(start(s.id, 0))).runId).toBe(first.runId);
    expect((await t.a.paper.list({ strategyId: s.id, limit: 10 })).counts).toEqual([{ strategyVersion: 1, runs: 1 }]);

    t.later(12);
    const priced = await t.a.paper.get({ runId: first.runId });
    expect(priced.priced).toBe(true);
    // The prices are the venue's own, on its spot market on the strategy's asset: never our own tape (ownTape throws).
    expect(priced.prices).toEqual({ venueMarket: 'BTC-USDC', test: true, unavailable: null });
    expect(priced.trades.length).toBeGreaterThan(0);
    // No fill uses a price from before the start.
    for (const trade of priced.trades) expect(Date.parse(trade.ts)).toBeGreaterThan(Date.parse(first.startedAt));
    expect(priced.equity.length).toBeGreaterThan(0);

    const stopped = await t.a.paper.stop({ runId: first.runId });
    expect(stopped.state).toBe('stopped');
    expect(stopped.stoppedAt).not.toBeNull();
    // After the stop nothing more happens: a later read ends at the stop.
    t.later(30);
    const after = await t.a.paper.get({ runId: first.runId });
    expect(after.trades).toEqual(stopped.trades);
    expect(after.state).toBe('stopped');
    if (after.pricedThrough) expect(Date.parse(after.pricedThrough)).toBeLessThanOrEqual(Date.parse(after.stoppedAt ?? ''));
    // Stopping again changes nothing; another account can't read or stop it.
    expect((await t.a.paper.stop({ runId: first.runId })).stoppedAt).toBe(stopped.stoppedAt);
    await expect(t.b.paper.get({ runId: first.runId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(t.b.paper.stop({ runId: first.runId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('stays unpriced while the venue is not read, saying why: nothing fills and no bar is invented', async () => {
    const t = setup({ venue: 'down' });
    await t.plan();
    const s = await saved(t.a);
    const first = await t.a.paper.start(start(s.id, 0));
    t.later(12);
    const read = await t.a.paper.get({ runId: first.runId });
    expect(read).toMatchObject({
      priced: false,
      pricedThrough: null,
      trades: [],
      equity: [],
      position: { symbol: 'BTC/USDT', qty: '0' },
      totals: { startCash: '1000', fees: '0', net: '0', endEquity: '1000' },
      prices: { venueMarket: null, test: false, unavailable: "the venue's price read answered 404 (trade.user_venue_off)" },
    });
  });

  it("reads the venue's spot candles on the strategy's asset, keeps only whole closed bars, and names a read that fails", async () => {
    const now = Date.UTC(2026, 10, 22, 6, 30, 20);
    const asked: string[] = [];
    const answer = (status: number, body: unknown) => async (url: string) => {
      asked.push(url);
      return { ok: status === 200, status, json: async () => body };
    };
    const candles = {
      venueId: 'test-venue-sim',
      symbol: 'BTC-USDC',
      test: true,
      asOf: new Date(now).toISOString(),
      value: [
        // Before the window: left out.
        { openAt: '2026-11-22T06:26:00.000Z', openPrice: '1', highPrice: '1', lowPrice: '1', closePrice: '1', baseVolume: '1' },
        {
          openAt: '2026-11-22T06:28:00.000Z',
          openPrice: '60010',
          highPrice: '60010',
          lowPrice: '59990',
          closePrice: '59990',
          baseVolume: '0.002',
        },
        {
          openAt: '2026-11-22T06:29:00.000Z',
          openPrice: '59990',
          highPrice: '60010',
          lowPrice: '59990',
          closePrice: '60010',
          baseVolume: '0.002',
        },
        // Still open at now: never seen.
        {
          openAt: '2026-11-22T06:30:00.000Z',
          openPrice: '60010',
          highPrice: '60010',
          lowPrice: '60010',
          closePrice: '60010',
          baseVolume: '0.001',
        },
      ],
    };
    const window = { symbol: 'BTC/USDT', barSize: '1m' as const, fromMs: Date.UTC(2026, 10, 22, 6, 28), toMs: now };
    const port = tradeVenuePricePort({ tradeUrl: 'http://trade.test/', now: () => now, fetch: answer(200, candles) });
    const read = await port.bars(window);
    expect(asked).toEqual(['http://trade.test/api/v1/venue/spot-candles?base=BTC&interval=1m&limit=500']);
    expect(read).toEqual({
      venueMarket: 'BTC-USDC',
      test: true,
      bars: [
        {
          openTimeMs: Date.UTC(2026, 10, 22, 6, 28),
          open: parseAmount('60010'),
          high: parseAmount('60010'),
          low: parseAmount('59990'),
          close: parseAmount('59990'),
        },
        {
          openTimeMs: Date.UTC(2026, 10, 22, 6, 29),
          open: parseAmount('59990'),
          high: parseAmount('60010'),
          low: parseAmount('59990'),
          close: parseAmount('60010'),
        },
      ],
    });
    const off = tradeVenuePricePort({
      tradeUrl: 'http://trade.test',
      now: () => now,
      fetch: answer(404, { intafacedCode: 'trade.user_venue_off' }),
    });
    expect(await off.bars(window)).toEqual({ unavailable: "the venue's price read answered 404 (trade.user_venue_off)" });
    const garbled = tradeVenuePricePort({
      tradeUrl: 'http://trade.test',
      now: () => now,
      fetch: answer(200, { value: [{ openAt: 'x' }] }),
    });
    expect(await garbled.bars(window)).toEqual({ unavailable: "the venue's price read answered rows that are not candles" });
    const down = tradeVenuePricePort({
      tradeUrl: 'http://trade.test',
      now: () => now,
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(await down.bars(window)).toEqual({ unavailable: "the venue's price read did not answer" });
    // A run older than the venue's read reaches is refused by name, never read in part.
    await expect(port.bars({ ...window, fromMs: now - 500 * 60_000 })).rejects.toThrow(
      /^quant.backtest_history_range — the run started more than 500 bars of 1m ago/,
    );
  });

  it('counts running paper runs against the concurrent-run limit; a stopped run no longer counts', async () => {
    const t = setup({ concurrent: '1' });
    await t.plan();
    const s = await saved(t.a);
    const first = await t.a.paper.start(start(s.id, 0));
    await expect(t.a.paper.start(start(s.id, 1))).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'quant.quota_exceeded — concurrent_runs: 1 used of 1 allowed',
    });
    expect((await t.a.paper.list({ strategyId: s.id, limit: 10 })).runs).toHaveLength(1);
    await t.a.paper.stop({ runId: first.runId });
    expect((await t.a.paper.start(start(s.id, 1))).state).toBe('running');
  });
});
