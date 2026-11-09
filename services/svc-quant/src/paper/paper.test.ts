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
import type { FeePort, HistoryPort } from '../engine/ports.js';
import { createMemoryQuota } from '../quota/memory.js';
import { createQuantRouter } from '../router.js';
import { RUN_RESULT_MAX_BYTES } from '../runs/limit.js';
import { createMemoryRunRepository } from '../runs/memory-repository.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';

// AL-live-01: paper runs on the exchange's own closed candles, derived on read; J-algo-dev-03 #6's concurrent-run quota.
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

/** Hourly closed bars, rising then falling, at every hour the read asks for: the exchange's own tape, as svc-trade gives it. */
const CLOSES = ['100', '110', '120', '130', '115', '100', '90', '95', '105', '120'];
function history(read: { fromMs: number; toMs: number }[] = []): HistoryPort {
  return {
    wired: true,
    async bars({ fromMs, toMs }) {
      read.push({ fromMs, toMs });
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
    },
  };
}
const fees: FeePort = { wired: true, fee: async () => ({ version: 'local-test:v1', makerBps: 8, takerBps: 10 }) } as unknown as FeePort;

function setup(options: { concurrent?: string } = {}) {
  let offset = 0;
  const quota = createMemoryQuota({ defaultProfile: 'TEST default' });
  const app = createQuantRouter({
    wired: true,
    venueVaultSet: false,
    limits: { maxOps: 5_000, maxSource: 8_000 },
    strategies: createMemoryStrategyRepository(quota.gate),
    runs: createMemoryRunRepository(RUN_RESULT_MAX_BYTES, quota.gate),
    quota: quota.repository,
    history: history(),
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
