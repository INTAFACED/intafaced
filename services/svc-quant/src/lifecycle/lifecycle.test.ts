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
import { NO_JUDGEMENT } from '../engine/run.js';
import { createQuantRouter } from '../router.js';
import { RUN_RESULT_MAX_BYTES } from '../runs/limit.js';
import { createMemoryRunRepository } from '../runs/memory-repository.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';
import { createMemoryLifecycleRepository } from './memory-repository.js';

// AL-lifecycle-01 (J-algo-dev-06 #1 #2): the promotion gate reads stored runs and the owner's stored criteria only; a
// blank criterion refuses by name and writes nothing; an approval is one stage row and one decision row, once.
const SECRET = 'a-quant-lifecycle-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const HOUR = 3_600_000;
const MINUTE = 60_000;
const T0 = Date.parse('2026-10-20T00:00:00.000Z');

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

const CLOSES = ['100', '110', '120', '130', '115', '100', '90', '95', '105', '120'];
const history: HistoryPort = {
  wired: true,
  async bars({ fromMs, toMs }) {
    const bars: Bar[] = [];
    for (let t = Math.ceil(fromMs / HOUR) * HOUR; t + HOUR <= toMs; t += HOUR) {
      const i = Math.round((t - T0) / HOUR);
      const close = CLOSES[((i % CLOSES.length) + CLOSES.length) % CLOSES.length]!;
      const open = CLOSES[(((i - 1) % CLOSES.length) + CLOSES.length) % CLOSES.length]!;
      bars.push({
        openTimeMs: t,
        open: parseAmount(open),
        high: parseAmount(Number(close) > Number(open) ? close : open),
        low: parseAmount(Number(close) < Number(open) ? close : open),
        close: parseAmount(close),
      });
    }
    return bars;
  },
};
const fees = { wired: true, fee: async () => ({ version: 'local-test:v1', makerBps: 8, takerBps: 10 }) } as unknown as FeePort;

function setup() {
  // The run store stamps a paper start with the wall clock, so the router's clock starts there too.
  let clock = Date.now();
  const lifecycle = createMemoryLifecycleRepository(() => new Date(clock));
  const app = createQuantRouter({
    wired: true,
    venueVaultSet: false,
    limits: { maxOps: 5_000, maxSource: 8_000 },
    strategies: createMemoryStrategyRepository(),
    runs: createMemoryRunRepository(RUN_RESULT_MAX_BYTES),
    lifecycle,
    history,
    fees,
    now: () => clock,
    // The boot values leave the shortfall blank, as the test stack does: no run can pass until an operator sets it.
    judgement: {
      ...NO_JUDGEMENT,
      criteria: { minTrades: '0', minReturnPercent: '-100', maxDrawdownPercent: '100', maxShortfallPercent: null },
    },
  });
  const writer = app.createCaller(signed(OPERATOR, ['admin:write']));
  let n = 0;
  return {
    a: app.createCaller(signed(ACCOUNT_A)),
    b: app.createCaller(signed(ACCOUNT_B)),
    reader: app.createCaller(signed(OPERATOR, ['admin:read'])),
    later: (ms: number) => {
      clock += ms;
    },
    set: (name: Parameters<typeof writer.ops.criteria.set>[0]['name'], value: string | null, toBoot = false) =>
      writer.ops.criteria.set({ name, value, toBoot, reason: 'LOCAL TEST', idempotencyKey: `criteria:${name}:${(n += 1)}` }),
  };
}

type T = ReturnType<typeof setup>;

async function saved(a: T['a'], risk = { maxDrawdown: '500', maxNotional: '10000', kill: '100' }) {
  return a.studio.save({
    name: 'TEST gate',
    blocks: [],
    modules: RULES,
    risk,
    cash: '1000',
    environment: 'paper',
    clientStrategyId: `client-gate-${risk.kill}`,
    idempotencyKey: `save-gate-${risk.kill}`,
  });
}

async function backtest(a: T['a'], strategyId: string) {
  return a.backtest.start({
    strategyId,
    strategyVersion: 1,
    cash: '1000',
    from: new Date(T0).toISOString(),
    to: new Date(T0 + 10 * HOUR).toISOString(),
    fillTiming: 'next_open',
    costs: { feeRole: 'taker', slippageBps: '0', delayBars: '0' },
    split: { preset: '1/3' },
  });
}

async function paper(a: T['a'], strategyId: string) {
  return a.paper.start({
    strategyId,
    strategyVersion: 1,
    cash: '1000',
    holdings: [],
    feed: 'own_venue',
    costs: { feeRole: 'taker', slippageBps: '0', delayBars: '0' },
    ordinal: 0,
  });
}

/** A version that holds every piece of evidence: a passing out-of-sample verdict and a paper run of 90 minutes. */
async function ready(t: T) {
  await t.set('oos.maxShortfallPercent', '1000');
  const s = await saved(t.a);
  const run = await backtest(t.a, s.id);
  expect(run.verdict.status).toBe('passed');
  const p = await paper(t.a, s.id);
  t.later(90 * MINUTE);
  return { s, run, p };
}

describe('promotion gate (AL-lifecycle-01)', () => {
  it('judges a new backtest by the operator’s stored out-of-sample criteria; blank clears an override back to not set', async () => {
    const t = setup();
    const s = await saved(t.a);
    expect((await backtest(t.a, s.id)).verdict).toMatchObject({ status: 'inconclusive', unset: ['maxShortfallPercent'] });
    await t.set('oos.maxShortfallPercent', '1000');
    // A new window is a new run: judged by the criteria as they stand now, and the stored older run keeps its verdict.
    const passed = await t.a.backtest.start({
      strategyId: s.id,
      strategyVersion: 1,
      cash: '1000',
      from: new Date(T0 + HOUR).toISOString(),
      to: new Date(T0 + 10 * HOUR).toISOString(),
      fillTiming: 'next_open',
      costs: { feeRole: 'taker', slippageBps: '0', delayBars: '0' },
      split: { preset: '1/3' },
    });
    expect(passed.verdict.status).toBe('passed');
    const read = await t.reader.ops.criteria.get();
    expect(read.criteria.find((row) => row.name === 'oos.maxShortfallPercent')).toEqual({
      name: 'oos.maxShortfallPercent',
      value: '1000',
      source: 'operator',
    });
    expect(read.criteria.find((row) => row.name === 'oos.minTrades')).toEqual({ name: 'oos.minTrades', value: '0', source: 'boot' });
    await t.set('oos.minTrades', null);
    expect((await t.reader.ops.criteria.get()).criteria.find((row) => row.name === 'oos.minTrades')).toEqual({
      name: 'oos.minTrades',
      value: null,
      source: 'operator',
    });
    // Back to the boot value: the operator's row is gone and the boot value stands again.
    await t.set('oos.minTrades', null, true);
    await t.set('oos.maxShortfallPercent', null, true);
    const back = (await t.reader.ops.criteria.get()).criteria;
    expect(back.find((row) => row.name === 'oos.minTrades')).toEqual({ name: 'oos.minTrades', value: '0', source: 'boot' });
    expect(back.find((row) => row.name === 'oos.maxShortfallPercent')).toEqual({
      name: 'oos.maxShortfallPercent',
      value: null,
      source: 'boot',
    });
    await expect(t.a.ops.criteria.get()).rejects.toThrow();
    await expect(t.set('gate.paperMinutes', '1.5')).rejects.toThrow(/quant\.params_invalid/);
    await expect(t.a.ops.criteria.set({ name: 'gate.paperMinutes', value: '1', reason: 'x', idempotencyKey: 'k' })).rejects.toThrow();
  });

  it('refuses Promote with a blank criterion, naming it, and writes nothing', async () => {
    const t = setup();
    const { s, run, p } = await ready(t);
    await t.set('gate.maxDrawdownPercent', '100');
    const before = await t.a.lifecycle.get({ strategyId: s.id, strategyVersion: 1 });
    expect(before.stage).toBe('paper');
    expect(before.gate.unset).toEqual(['paperMinutes']);
    expect(before.gate.checks.find((c) => c.check === 'paperDuration')).toMatchObject({
      status: 'not_set',
      runId: p.runId,
      observed: expect.stringMatching(/^(89|90)$/),
    });
    expect(before.gate.checks.find((c) => c.check === 'outOfSample')).toMatchObject({ status: 'met', runId: run.runId });
    await expect(t.a.lifecycle.promote({ strategyId: s.id, strategyVersion: 1, seq: 0 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/^quant\.gate_criteria_unset — paperMinutes — /),
    });
    const after = await t.a.lifecycle.get({ strategyId: s.id, strategyVersion: 1 });
    expect(after.stages).toEqual([]);
    expect(after.decisions).toEqual([]);
  });

  it('approves once the criteria are set: one stage row and one decision, and a second press moves nothing', async () => {
    const t = setup();
    const { s, run, p } = await ready(t);
    await t.set('gate.maxDrawdownPercent', '100');
    await t.set('gate.paperMinutes', '60');
    const first = await t.a.lifecycle.promote({ strategyId: s.id, strategyVersion: 1, seq: 0 });
    expect(first.decision).toMatchObject({ decision: 'approved', runIds: [run.runId, p.runId] });
    expect(first.decision.criteria).toEqual([
      { name: 'paperMinutes', value: '60' },
      { name: 'maxDrawdownPercent', value: '100' },
    ]);
    expect(first.stage).toMatchObject({ from: 'paper', to: 'candidate' });
    expect(first.lifecycle.stage).toBe('candidate');
    // The same press again (a lost reply): the first answer, nothing new.
    const again = await t.a.lifecycle.promote({ strategyId: s.id, strategyVersion: 1, seq: 0 });
    expect(again.decision).toEqual(first.decision);
    // A press from a fresh read of the page: refused, the stage already moved.
    await expect(t.a.lifecycle.promote({ strategyId: s.id, strategyVersion: 1, seq: 1 })).rejects.toThrow(
      /^quant\.stage_transition_invalid/,
    );
    const read = await t.a.lifecycle.get({ strategyId: s.id, strategyVersion: 1 });
    expect(read.stages).toHaveLength(1);
    expect(read.decisions).toHaveLength(1);
    // Another account sees no such strategy.
    await expect(t.b.lifecycle.get({ strategyId: s.id, strategyVersion: 1 })).rejects.toThrow(/quant\.studio_not_found/);
  });

  it('rejects, with a decision row and no stage row, when a set criterion is not met', async () => {
    const t = setup();
    const { s } = await ready(t);
    await t.set('gate.maxDrawdownPercent', '100');
    await t.set('gate.paperMinutes', '600');
    const out = await t.a.lifecycle.promote({ strategyId: s.id, strategyVersion: 1, seq: 0 });
    expect(out.decision.decision).toBe('rejected');
    expect(out.stage).toBeNull();
    expect(out.lifecycle.gate.checks.find((c) => c.check === 'paperDuration')?.status).toBe('not_met');
    expect(out.lifecycle.stage).toBe('paper');
    expect(out.lifecycle.decisions).toHaveLength(1);
    expect(out.lifecycle.stages).toEqual([]);
  });

  it('counts no inconclusive verdict and no paper run of another version, and names blank risk limits', async () => {
    const t = setup();
    await t.set('gate.maxDrawdownPercent', '100');
    await t.set('gate.paperMinutes', '1');
    const s = await saved(t.a);
    await backtest(t.a, s.id);
    const read = await t.a.lifecycle.get({ strategyId: s.id, strategyVersion: 1 });
    expect(read.stage).toBe('backtested');
    expect(read.gate.checks.find((c) => c.check === 'outOfSample')).toMatchObject({ status: 'not_met', observed: 'inconclusive' });
    expect(read.gate.checks.find((c) => c.check === 'paperDuration')).toMatchObject({ status: 'not_met', runId: null });
    expect(read.gate.approved).toBe(false);
    const out = await t.a.lifecycle.promote({ strategyId: s.id, strategyVersion: 1, seq: 0 });
    expect(out.decision.decision).toBe('rejected');
  });
});
