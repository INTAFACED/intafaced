import { describe, expect, it } from 'vitest';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  signPrincipalHeader,
  type QuantSignalRules,
} from '@intafaced/contracts';
import { createQuantRouter } from '../router.js';
import { createMemoryRunRepository } from '../runs/memory-repository.js';
import { trackRun } from '../runs/track.js';
import { RUN_RESULT_MAX_BYTES } from '../runs/limit.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';
import { HISTORY_BARS_BACK, tradeFeePort, tradeHistoryPort, type FeePort, type HistoryPort } from './ports.js';
import { NO_JUDGEMENT, prepareBacktest, runOnBars, type Judgement } from './run.js';
import { parseAmount } from '@intafaced/ledger-client/money';

const SECRET = 'a-quant-bar-backtest-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const limits = { maxOps: 5_000, maxSource: 8_000 };
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-20T00:00:00.000Z');
const NOW = T0 + 48 * HOUR;

const RULES: QuantSignalRules = {
  symbol: 'BTC/USDT',
  barSize: '1h',
  signal: { kind: 'ma_cross', average: 'sma', fast: '1', slow: '2' },
  sizing: { kind: 'quantity', value: '1' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
};

function signed(userId: string) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read'],
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
    id: `req-${userId}`,
  });
}

/** Candle rows as svc-trade's ohlcv route answers them: [openTimeMs, open, high, low, close, volume]. */
const CLOSES = ['100', '100', '100', '110', '120', '130', '115', '100'];
function candleRows(): [number, string, string, string, string, string][] {
  return CLOSES.map((close, i) => {
    const open = i === 0 ? close : CLOSES[i - 1]!;
    const high = Number(open) > Number(close) ? open : close;
    const low = Number(open) < Number(close) ? open : close;
    return [T0 + i * HOUR, open, high, low, close, '1'];
  });
}

function fakeFetch(routes: Record<string, { status: number; body: unknown }>, seen: string[] = []) {
  return async (url: string) => {
    seen.push(url);
    const path = url.replace('http://trade.test', '').split('?')[0]!;
    const hit = routes[path];
    if (!hit) throw new Error(`no route ${path}`);
    return { ok: hit.status === 200, status: hit.status, json: async () => hit.body };
  };
}

const FEES = { status: 200, body: { version: 'local-test:v1', fees: { 'BTC/USDT': { makerBps: 8, takerBps: 10 } } } };

type Stores = { runs: ReturnType<typeof createMemoryRunRepository>; strategies: ReturnType<typeof createMemoryStrategyRepository> };

function setup(options: { history?: HistoryPort; fees?: FeePort; seen?: string[]; judgement?: Judgement; stores?: Stores } = {}) {
  const seen = options.seen ?? [];
  const fetch = fakeFetch({ '/api/v1/ohlcv/BTC%2FUSDT': { status: 200, body: candleRows() }, '/api/v1/fees/published': FEES }, seen);
  const runs = options.stores?.runs ?? createMemoryRunRepository(RUN_RESULT_MAX_BYTES);
  const strategies = options.stores?.strategies ?? createMemoryStrategyRepository();
  const appRouter = createQuantRouter({
    wired: true,
    venueVaultSet: false,
    limits,
    strategies,
    runs,
    history: options.history ?? tradeHistoryPort({ tradeUrl: 'http://trade.test', now: () => NOW, fetch }),
    fees: options.fees ?? tradeFeePort({ tradeUrl: 'http://trade.test', fetch }),
    now: () => NOW,
    judgement: options.judgement,
  });
  return { a: appRouter.createCaller(signed(ACCOUNT_A)), b: appRouter.createCaller(signed(ACCOUNT_B)), runs, strategies, seen };
}

async function saved(a: ReturnType<typeof setup>['a'], modules: QuantSignalRules | null = RULES) {
  return a.studio.save({
    name: 'cross',
    blocks: modules ? [] : [{ side: 'buy', symbol: 'BTC/USDT', qty: '1' }],
    modules,
    risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
    cash: '1000',
    environment: 'paper',
    clientStrategyId: modules ? 'client-rules' : 'client-blocks',
    idempotencyKey: modules ? 'studio.save:client-rules' : 'studio.save:client-blocks',
  });
}

const request = (strategyId: string) => ({
  strategyId,
  strategyVersion: 1,
  cash: '1000',
  from: new Date(T0).toISOString(),
  to: new Date(T0 + CLOSES.length * HOUR).toISOString(),
  fillTiming: 'next_open',
  costs: { feeRole: 'taker', slippageBps: '0', delayBars: '0' },
});

describe('bar backtest', () => {
  it('refuses each blank cost by name before anything runs or is stored', async () => {
    const { a, runs } = setup();
    const strategy = await saved(a);
    const base = request(strategy.id);
    await expect(a.backtest.start({ ...base, costs: { ...base.costs, slippageBps: '' } })).rejects.toThrow(/quant\.cost_unset — slippage/);
    await expect(a.backtest.start({ ...base, costs: { ...base.costs, delayBars: ' ' } })).rejects.toThrow(/quant\.cost_unset — delay/);
    await expect(a.backtest.start({ ...base, costs: { ...base.costs, feeRole: '' } })).rejects.toThrow(/quant\.cost_unset — fees/);
    await expect(a.backtest.start({ ...base, fillTiming: '' })).rejects.toThrow(/quant\.fill_timing_unset/);
    await expect(a.backtest.start({ ...base, cash: '' })).rejects.toThrow(/quant\.cash_unset/);
    await expect(a.backtest.start({ ...base, to: new Date(NOW + HOUR).toISOString() })).rejects.toThrow(/quant\.backtest_window_open/);
    await expect(a.backtest.start({ ...base, from: '2026-10-20T00:00' })).rejects.toThrow(/quant\.backtest_window_invalid/);
    // Date.parse would read 31 September as 1 October; the service refuses a day that does not exist.
    await expect(a.backtest.start({ ...base, from: '2026-09-31T00:00Z' })).rejects.toThrow(/quant\.backtest_window_invalid — from/);
    await expect(a.backtest.start({ ...base, fillTiming: 'bar_close' })).rejects.toThrow(/quant\.fill_timing_unset/);
    const blocks = await saved(a, null);
    await expect(a.backtest.start(request(blocks.id))).rejects.toThrow(/quant\.backtest_rules_required/);
    expect((await runs.list({ from: null, to: null, kind: null, userId: ACCOUNT_A, limit: 10, cursor: null })).runs).toEqual([]);
  });

  it('runs on the closed bars with the published fee, stores one run, and reads it back for the same inputs', async () => {
    const { a, b, runs } = setup();
    const strategy = await saved(a);
    const first = await a.backtest.start(request(strategy.id));
    expect(first.trades.map((t) => t.side)).toEqual(['buy', 'sell']);
    expect(first.costs).toEqual({ feeScheduleVersion: 'local-test:v1', feeRole: 'taker', feeBps: 10, slippageBps: '0', delayBars: 0 });
    expect(first.totals).toMatchObject({ gross: '5', fees: '0.225', net: '4.775' });
    expect(first.coverage).toMatchObject({ bars: 8, expected: 8, gaps: [] });
    expect(first.runKey).toMatch(new RegExp(`^algo:bt:${strategy.id}:v1:[0-9a-f]{12}:[0-9a-f]{12}:[0-9a-f]{12}$`));

    const again = await a.backtest.start(request(strategy.id));
    expect(again).toEqual(first);
    const changed = await a.backtest.start({ ...request(strategy.id), costs: { feeRole: 'maker', slippageBps: '0', delayBars: '0' } });
    expect(changed.runId).not.toBe(first.runId);
    expect(changed.costs.feeBps).toBe(8);
    expect((await runs.list({ from: null, to: null, kind: 'backtest', userId: ACCOUNT_A, limit: 10, cursor: null })).runs).toHaveLength(2);

    expect(await a.backtest.result({ runId: first.runId })).toEqual(first);
    await expect(b.backtest.result({ runId: first.runId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(b.backtest.start(request(strategy.id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses an unwired or failing history read and an empty window, storing no row, so the same inputs can run later', async () => {
    const down = setup({
      history: tradeHistoryPort({
        tradeUrl: 'http://trade.test',
        now: () => NOW,
        fetch: fakeFetch({ '/api/v1/ohlcv/BTC%2FUSDT': { status: 503, body: { intafacedCode: 'trade.unavailable' } } }),
      }),
    });
    const strategy = await saved(down.a);
    await expect(down.a.backtest.start(request(strategy.id))).rejects.toThrow(
      /quant\.backtest_lake_missing — the history read answered 503/,
    );
    const empty = setup({
      history: tradeHistoryPort({
        tradeUrl: 'http://trade.test',
        now: () => NOW,
        fetch: fakeFetch({ '/api/v1/ohlcv/BTC%2FUSDT': { status: 200, body: [] } }),
      }),
    });
    const other = await saved(empty.a);
    await expect(empty.a.backtest.start(request(other.id))).rejects.toThrow(/quant\.backtest_fills_missing/);
    const unwired = createQuantRouter({
      wired: true,
      venueVaultSet: false,
      limits,
      strategies: createMemoryStrategyRepository(),
    }).createCaller(signed(ACCOUNT_A));
    const third = await saved(unwired);
    await expect(unwired.backtest.start(request(third.id))).rejects.toThrow(/quant\.cost_unset — fees/);
    for (const { runs } of [down, empty]) {
      expect((await runs.list({ from: null, to: null, kind: null, userId: ACCOUNT_A, limit: 10, cursor: null })).runs).toEqual([]);
    }
  });

  it('reads the published fee for a symbol, and refuses a symbol the schedule leaves out', async () => {
    const { a } = setup();
    expect(await a.backtest.fee({ symbol: 'BTC/USDT' })).toEqual({
      symbol: 'BTC/USDT',
      version: 'local-test:v1',
      makerBps: 8,
      takerBps: 10,
    });
    await expect(a.backtest.fee({ symbol: 'DOGE/USDT' })).rejects.toThrow(
      /quant\.cost_unset — fees — the published schedule has no rate for DOGE\/USDT/,
    );
  });
});

describe('bar backtest disclosures and races', () => {
  it('says the version sets risk limits the backtest does not apply, and lists the modelling choices', async () => {
    const { a } = setup();
    const strategy = await saved(a);
    const result = await a.backtest.start(request(strategy.id));
    expect(result.fillTiming).toBe('next_open');
    expect(result.assumptions).toEqual(['long_only', 'averages_over_traded_bars', 'risk_limits_not_simulated']);
    // The report comes from the run's own trades: one round trip, 115 - 0.115 fee - (110 + 0.11 fee).
    expect(result.metrics.roundTrips.map((trip) => trip.profit)).toEqual(['4.775']);
    expect(result.metrics.trades.winRate).toEqual({ value: '100', reason: null });
    expect(result.metrics.returns.sharpe).toEqual({ value: null, reason: 'quant.risk_free_unset' });
    // A stored run read back carries the same report, derived again from what was stored.
    expect((await a.backtest.result({ runId: result.runId })).metrics).toEqual(result.metrics);
  });

  it('answers two presses under one key with the one stored run', async () => {
    const { a } = setup();
    const strategy = await saved(a);
    const [one, two] = await Promise.all([a.backtest.start(request(strategy.id)), a.backtest.start(request(strategy.id))]);
    expect(two.runId).toBe(one.runId);
    expect(two).toEqual(one);
  });

  it('a run that finishes second under a key answers the first one stored instead of failing', async () => {
    const runs = createMemoryRunRepository(RUN_RESULT_MAX_BYTES);
    const begin = { userId: ACCOUNT_A, idempotencyKey: 'algo:bt:race', kind: 'backtest' as const, strategyId: null, strategyVersion: null };
    const stored = (value: { n: number } | null) => ({ detail: null, response: value });
    const answer = await trackRun(
      runs,
      begin,
      async () => {
        // The other press finishes the same row while this one is still running.
        const row = await runs.replay(ACCOUNT_A, begin.idempotencyKey);
        await runs.finish({ id: row!.id, userId: ACCOUNT_A, outcome: 'ok', stored: stored({ n: 1 }) });
        return { n: 2 };
      },
      (value) => stored(value),
    );
    expect(answer).toEqual({ n: 1 });
  });
});

describe('run history, labels and the log', () => {
  it('lists own runs newest first; a label never changes the stored result; another account cannot see or rename them', async () => {
    const { a, b } = setup();
    const strategy = await saved(a);
    const first = await a.backtest.start(request(strategy.id));
    // Runs are stamped to the millisecond: wait one, so "newest first" is decided by time, not by a tie.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await a.backtest.start({ ...request(strategy.id), costs: { feeRole: 'maker', slippageBps: '2', delayBars: '0' } });
    const page = await a.backtest.history({ limit: 10 });
    expect(page.runs.map((row) => row.runId)).toEqual([second.runId, first.runId]);
    expect(page.runs[0]).toMatchObject({ strategyId: strategy.id, strategyVersion: 1, outcome: 'ok', label: null });

    expect(await a.backtest.rename({ runId: first.runId, label: '  hourly cross  ' })).toEqual({
      runId: first.runId,
      label: 'hourly cross',
    });
    expect((await a.backtest.history({ limit: 10 })).runs[1]!.label).toBe('hourly cross');
    expect(await a.backtest.result({ runId: first.runId })).toEqual(first);

    await expect(a.backtest.rename({ runId: first.runId, label: ' ' })).rejects.toThrow(/quant\.params_invalid — label/);
    await expect(b.backtest.rename({ runId: first.runId, label: 'mine' })).rejects.toThrow(/quant\.run_not_found/);
    expect((await b.backtest.history({ limit: 10 })).runs).toEqual([]);
    // One page at a time, still newest first.
    const one = await a.backtest.history({ limit: 1 });
    expect(one.runs.map((row) => row.runId)).toEqual([second.runId]);
    expect((await a.backtest.history({ limit: 1, cursor: one.nextCursor })).runs.map((row) => row.runId)).toEqual([first.runId]);
    // A strategy's own page lists only its runs.
    const copy = await a.studio.clone({
      strategyId: strategy.id,
      clientStrategyId: 'history-copy',
      idempotencyKey: 'studio.clone:history-copy',
    });
    const third = await a.backtest.start(request(copy.id));
    expect((await a.backtest.history({ limit: 10, strategyId: copy.id })).runs.map((row) => row.runId)).toEqual([third.runId]);
    expect((await a.backtest.history({ limit: 10, strategyId: strategy.id })).runs.map((row) => row.runId)).toEqual([
      second.runId,
      first.runId,
    ]);
    expect((await b.backtest.history({ limit: 10, strategyId: strategy.id })).runs).toEqual([]);
  });

  it('leaves out a fills-language backtest, which has no bar result to open, and refuses to rename it', async () => {
    const { a, runs } = setup();
    const strategy = await saved(a);
    const bar = await a.backtest.start(request(strategy.id));
    const fills = await runs.begin({
      userId: ACCOUNT_A,
      idempotencyKey: 'backtest.run:client-key',
      kind: 'backtest',
      strategyId: strategy.id,
      strategyVersion: 1,
    });
    await runs.finish({ id: fills.id, userId: ACCOUNT_A, outcome: 'ok', stored: { detail: null, response: { simulated: true } } });
    expect((await a.backtest.history({ limit: 10 })).runs.map((row) => row.runId)).toEqual([bar.runId]);
    await expect(a.backtest.rename({ runId: fills.id, label: 'old' })).rejects.toThrow(/quant\.run_not_found/);
  });

  it('logs what was read, each fill and, as warnings, each gap and the choices that shaped the result', async () => {
    const { a } = setup();
    const strategy = await saved(a);
    const result = await a.backtest.start(request(strategy.id));
    expect(result.log[0]).toMatchObject({ level: 'info', code: 'bars_read', values: { bars: '8', expected: '8' } });
    expect(result.log.filter((line) => line.code === 'fill')).toHaveLength(result.trades.length);
    const warnings = result.log.filter((line) => line.level === 'warn');
    expect(warnings).toEqual([{ level: 'warn', code: 'assumption', ts: null, values: { name: 'risk_limits_not_simulated' } }]);
    expect(result.log[result.log.length - 1]).toMatchObject({ code: 'finished', values: { net: result.totals.net } });
  });
});

describe('history read', () => {
  it('asks for closed bars from the window start and keeps only whole bars inside it', async () => {
    const seen: string[] = [];
    const port = tradeHistoryPort({
      tradeUrl: 'http://trade.test/',
      now: () => T0 + 5 * HOUR + 1,
      fetch: fakeFetch({ '/api/v1/ohlcv/BTC%2FUSDT': { status: 200, body: candleRows() } }, seen),
    });
    const bars = await port.bars({ symbol: 'BTC/USDT', barSize: '1h', fromMs: T0 + HOUR, toMs: T0 + 10 * HOUR });
    // Bars 1..4 have closed by now; bar 5 is still open and bar 0 starts before the window.
    expect(bars.map((bar) => (bar.openTimeMs - T0) / HOUR)).toEqual([1, 2, 3, 4]);
    expect(seen).toEqual([`http://trade.test/api/v1/ohlcv/BTC%2FUSDT?timeframe=1h&since=${T0 + HOUR}&limit=${HISTORY_BARS_BACK}`]);
  });

  it('refuses a window that starts before the history read reaches, and rows that are not candles', async () => {
    const port = tradeHistoryPort({ tradeUrl: 'http://trade.test', now: () => NOW, fetch: fakeFetch({}) });
    await expect(port.bars({ symbol: 'BTC/USDT', barSize: '1h', fromMs: NOW - (HISTORY_BARS_BACK + 1) * HOUR, toMs: NOW })).rejects.toThrow(
      /quant\.backtest_history_range/,
    );
    const bad = tradeHistoryPort({
      tradeUrl: 'http://trade.test',
      now: () => NOW,
      fetch: fakeFetch({ '/api/v1/ohlcv/BTC%2FUSDT': { status: 200, body: [[T0, 100, 100, 100, 100, 1]] } }),
    });
    await expect(bad.bars({ symbol: 'BTC/USDT', barSize: '1h', fromMs: T0, toMs: NOW })).rejects.toThrow(/not candles/);
    const notPrices = tradeHistoryPort({
      tradeUrl: 'http://trade.test',
      now: () => NOW,
      fetch: fakeFetch({ '/api/v1/ohlcv/BTC%2FUSDT': { status: 200, body: [[T0, '1e3', '100', '100', '100', '1']] } }),
    });
    await expect(notPrices.bars({ symbol: 'BTC/USDT', barSize: '1h', fromMs: T0, toMs: NOW })).rejects.toThrow(
      /quant\.backtest_lake_missing.*not candles/,
    );
    const twice = tradeHistoryPort({
      tradeUrl: 'http://trade.test',
      now: () => NOW,
      fetch: fakeFetch({ '/api/v1/ohlcv/BTC%2FUSDT': { status: 200, body: [candleRows()[0], candleRows()[0]] } }),
    });
    await expect(twice.bars({ symbol: 'BTC/USDT', barSize: '1h', fromMs: T0, toMs: NOW })).rejects.toThrow(/two candles for one interval/);
    // The oldest start the read accepts is one bar short of the route's cap, so the route never counts one over it.
    await expect(port.bars({ symbol: 'BTC/USDT', barSize: '1h', fromMs: NOW - HISTORY_BARS_BACK * HOUR, toMs: NOW })).rejects.toThrow(
      /quant\.backtest_history_range/,
    );
  });
});

describe('honest results: split, computed verdict, variant count (AL-backtest-04)', () => {
  const CRITERIA = { minTrades: '0', minReturnPercent: '-100', maxDrawdownPercent: '100', maxShortfallPercent: null };

  it('splits off the latest third, computes the verdict, names the blank criterion, and ignores a typed verdict', async () => {
    const { a } = setup({ judgement: { ...NO_JUDGEMENT, criteria: CRITERIA } });
    const strategy = await saved(a);
    const result = await a.backtest.start({ ...request(strategy.id), split: { preset: '1/3' }, outOfSampleStatus: 'passed' });
    // Eight hours: the latest third starts 2h40m before the end, moved up to the next bar open at 06:00.
    expect(result.split).toEqual({ preset: '1/3', outOfSampleFrom: new Date(T0 + 6 * HOUR).toISOString() });
    expect(result.sections?.inSample).toMatchObject({ from: new Date(T0).toISOString(), to: new Date(T0 + 6 * HOUR).toISOString() });
    expect(result.verdict).toMatchObject({ status: 'inconclusive', reasons: ['criteria_unset'], unset: ['maxShortfallPercent'] });
    expect(result.ignoredInputs).toEqual(['outOfSampleStatus']);
    expect(result.holdout).toEqual({ enforced: false, from: null });

    const judged = setup({ judgement: { ...NO_JUDGEMENT, criteria: { ...CRITERIA, maxShortfallPercent: '100' } } });
    const other = await saved(judged.a);
    const computed = await judged.a.backtest.start({ ...request(other.id), split: { preset: '1/3' }, outOfSampleStatus: 'failed' });
    expect(computed.verdict.status).toBe('passed');
    expect(computed.ignoredInputs).toEqual(['outOfSampleStatus']);
    // Read back later, the stored run carries the verdict the service computed, not anything a request sent.
    expect((await judged.a.backtest.result({ runId: computed.runId })).verdict).toEqual(computed.verdict);
  });

  it('counts each distinct run of the strategy on its symbol and bar size; a replay is the same variant', async () => {
    const { a, b } = setup();
    const strategy = await saved(a);
    const counts: (number | null)[] = [];
    for (const slippageBps of ['0', '1', '2', '3', '4']) {
      counts.push(
        (await a.backtest.start({ ...request(strategy.id), costs: { feeRole: 'taker', slippageBps, delayBars: '0' } })).variantCount,
      );
    }
    expect(counts).toEqual([1, 2, 3, 4, 5]);
    expect((await a.backtest.start({ ...request(strategy.id), strategyVariantCount: 1 })).variantCount).toBe(1);
    const theirs = await saved(b);
    expect((await b.backtest.start(request(theirs.id))).variantCount).toBe(1);
  });

  it('keeps the in-sample part clear of the owner holdout when asked, and refuses when the owner has not set it', async () => {
    const blank = setup();
    const strategy = await saved(blank.a);
    const asked = { ...request(strategy.id), split: { preset: '1/3' }, enforceHoldout: true };
    await expect(blank.a.backtest.start(asked)).rejects.toThrow(/quant\.holdout_date_unset/);
    // The holdout begins 44 hours before now, at 04:00: the in-sample part runs to 06:00 and reaches into it.
    const close = setup({ judgement: { ...NO_JUDGEMENT, holdoutStart: 'PT44H' } });
    const near = await saved(close.a);
    await expect(close.a.backtest.start({ ...asked, strategyId: near.id })).rejects.toThrow(/quant\.holdout_overlap/);
    const clear = setup({ judgement: { ...NO_JUDGEMENT, holdoutStart: 'PT40H' } });
    const far = await saved(clear.a);
    const result = await clear.a.backtest.start({ ...asked, strategyId: far.id });
    expect(result.holdout).toEqual({ enforced: true, from: new Date(T0 + 8 * HOUR).toISOString() });
    // The owner moves the holdout earlier: the stored run reads back as it ran, and nothing new runs into the holdout.
    const moved = setup({ judgement: { ...NO_JUDGEMENT, holdoutStart: 'PT44H' }, stores: clear });
    const replay = await moved.a.backtest.start({ ...asked, strategyId: far.id });
    expect(replay).toEqual(result);
    await expect(moved.a.backtest.start({ ...asked, strategyId: far.id, cash: '2000' })).rejects.toThrow(/quant\.holdout_overlap/);
    await expect(clear.a.backtest.start({ ...asked, strategyId: far.id, split: { preset: 'thirds' } })).rejects.toThrow(
      /quant\.backtest_window_invalid — split/,
    );
  });

  it('carries every check with its evidence, from the owner thresholds as they stood when it ran, the same on every read', async () => {
    const thresholds = { maxSampleGapPercent: '1000', maxVariants: '1', maxOffsetShiftPercent: null };
    const { a } = setup({ judgement: { ...NO_JUDGEMENT, checks: thresholds } });
    const strategy = await saved(a);
    const first = await a.backtest.start({ ...request(strategy.id), split: { preset: '1/3' } });
    // The sensitivity run starts at the window's second bar.
    expect(first.offsetRun).toMatchObject({ from: new Date(T0 + HOUR).toISOString() });
    const checks = Object.fromEntries(first.checks.map((check) => [check.name, check]));
    expect(first.checks).toHaveLength(6);
    expect(checks.sample_gap).toMatchObject({ status: 'clear', threshold: '1000' });
    expect(checks.variant_count).toMatchObject({ status: 'clear', evidence: { variants: '1' } });
    expect(checks.bar_offset).toMatchObject({ status: 'not_set', threshold: null });
    expect(checks.look_ahead!.status).toBe('by_construction');
    const second = await a.backtest.start({
      ...request(strategy.id),
      split: { preset: '1/3' },
      costs: { feeRole: 'taker', slippageBps: '9', delayBars: '0' },
    });
    expect(second.checks.find((check) => check.name === 'variant_count')).toMatchObject({ status: 'warning', evidence: { variants: '2' } });
    expect((await a.backtest.result({ runId: second.runId })).checks).toEqual(second.checks);
  });

  it('starts the one-bar-later run at the second traded bar, also when the window opens in a gap', async () => {
    const fees: FeePort = { wired: true, fee: async () => ({ version: 'TEST-1', makerBps: 5, takerBps: 10 }) };
    const strategy = { id: 'strategy-1', version: 1, modules: RULES, risk: { maxDrawdown: '', maxNotional: '', kill: '' } };
    const prepared = await prepareBacktest(request(strategy.id), strategy, fees, NOW, NO_JUDGEMENT);
    // No trade in the first three hours: the first bar opens at 03:00, the second at 04:00.
    const bars = candleRows()
      .slice(3)
      .map(([openTimeMs, open, high, low, close]) => ({
        openTimeMs,
        open: parseAmount(open),
        high: parseAmount(high),
        low: parseAmount(low),
        close: parseAmount(close),
      }));
    const ran = runOnBars(prepared, bars);
    expect(ran.offsetRun?.from).toBe(new Date(T0 + 4 * HOUR).toISOString());
    expect(runOnBars(prepared, bars.slice(0, 2)).offsetRun).toBeNull();
  });

  it('keeps the run key when the owner changes a criterion or a threshold, so the same inputs stay one variant', async () => {
    const fees: FeePort = { wired: true, fee: async () => ({ version: 'TEST-1', makerBps: 5, takerBps: 10 }) };
    const strategy = { id: 'strategy-1', version: 1, modules: RULES, risk: { maxDrawdown: '', maxNotional: '', kill: '' } };
    const input = { ...request(strategy.id), split: { preset: '1/3' } };
    const before = await prepareBacktest(input, strategy, fees, NOW, NO_JUDGEMENT);
    const after = await prepareBacktest(input, strategy, fees, NOW, {
      ...NO_JUDGEMENT,
      criteria: { minTrades: '1', minReturnPercent: '0', maxDrawdownPercent: '10', maxShortfallPercent: '5' },
      checks: { maxSampleGapPercent: '5', maxVariants: '3', maxOffsetShiftPercent: '1' },
    });
    expect(after.key).toBe(before.key);
    expect(after.checks.maxVariants).toBe('3');
  });

  it('refuses a replay whose stored result no longer reads, and runs nothing again', async () => {
    const { a, runs, seen } = setup();
    const strategy = await saved(a);
    await a.backtest.start(request(strategy.id));
    const replay = runs.replay;
    runs.replay = async (userId, key) => {
      const row = await replay(userId, key);
      return row ? { ...row, response: { symbol: 'BTC/USDT' } } : row;
    };
    const bars = () => seen.filter((url) => url.includes('/ohlcv/')).length;
    const reads = bars();
    await expect(a.backtest.start(request(strategy.id))).rejects.toThrow(/quant\.run_immutable — run — its stored result cannot be read/);
    expect(bars()).toBe(reads);
  });
});

describe('simulated margin account (AL-backtest-02)', () => {
  const RULES_SET = { mode: 'netting' as const, maxLeverage: '20', marginCallPercent: '80', stopOutPercent: '50' };

  it('refuses a blank leverage, any blank owner rule by name, and a leverage over the maximum, storing nothing', async () => {
    const { a, runs } = setup({ judgement: { ...NO_JUDGEMENT, account: RULES_SET } });
    const strategy = await saved(a);
    const margin = (leverage: string) => ({ ...request(strategy.id), simulatedAccount: { leverage } });
    await expect(a.backtest.start(margin(' '))).rejects.toThrow(/quant\.account_rule_unset — leverage — fill in the leverage/);
    await expect(a.backtest.start(margin('21'))).rejects.toThrow(/leverage — must be from 1 up to the published maximum of 20/);
    await expect(a.backtest.start(margin('0.5'))).rejects.toThrow(/quant\.account_rule_unset — leverage/);
    for (const [rule, name] of [
      ['maxLeverage', 'maximum leverage'],
      ['marginCallPercent', 'margin call level'],
      ['stopOutPercent', 'stop-out level'],
    ] as const) {
      const blank = setup({ judgement: { ...NO_JUDGEMENT, account: { ...RULES_SET, [rule]: null } } });
      const theirs = await saved(blank.a);
      await expect(blank.a.backtest.start({ ...request(theirs.id), simulatedAccount: { leverage: '5' } })).rejects.toThrow(
        new RegExp(`quant\\.account_rule_unset — ${name} — the owner has not published it`),
      );
    }
    expect((await runs.history({ userId: ACCOUNT_A, kind: 'backtest', keyPrefix: 'algo:bt:', limit: 10, cursor: null })).runs).toEqual([]);
    expect(await a.backtest.accountRules()).toEqual(RULES_SET);
  });

  it('runs on margin under its own key, with the account and its events on the result; a cash run keeps its key', async () => {
    const { a } = setup({ judgement: { ...NO_JUDGEMENT, account: RULES_SET } });
    const strategy = await saved(a);
    const cash = await a.backtest.start(request(strategy.id));
    expect(cash.account).toBeNull();
    expect(cash.marginEvents).toEqual([]);
    const margin = await a.backtest.start({ ...request(strategy.id), simulatedAccount: { leverage: '5' } });
    expect(margin.runKey).not.toBe(cash.runKey);
    expect(margin.account).toEqual({ ...RULES_SET, leverage: '5' });
    expect(Array.isArray(margin.marginEvents)).toBe(true);
    expect(margin.equity.some((point) => point.marginLevelPercent !== undefined)).toBe(true);
    expect(await a.backtest.result({ runId: margin.runId })).toEqual(margin);
  });
});
