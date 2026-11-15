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
import { createMemoryNotifyRepository } from './memory-repository.js';
import { sweepFillAlerts, type FillAnnouncement } from './sweep.js';

// AL-live-06, AL-alerts-01 (J-algo-dev-04 #5, #6, #7): channels, fill alerts and the server-side sweep that announces fills.
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
  const strategies = createMemoryStrategyRepository(quota.gate);
  const runs = createMemoryRunRepository(RUN_RESULT_MAX_BYTES, quota.gate);
  const notify = createMemoryNotifyRepository(() => Date.now() + offset);
  const app = createQuantRouter({
    wired: true,
    venueVaultSet: false,
    limits: { maxOps: 5_000, maxSource: 8_000 },
    strategies,
    runs,
    notify,
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
  const published: FillAnnouncement[] = [];
  let failNextMark = false;
  const sweep = (opts: { bus?: boolean } = {}) =>
    sweepFillAlerts({
      notify: {
        ...notify,
        markAnnounced: async (input) => {
          if (failNextMark) {
            failNextMark = false;
            throw new Error('TEST crash between publish and mark');
          }
          return notify.markAnnounced(input);
        },
      },
      runs,
      strategies,
      history: history(),
      fees,
      now: () => Date.now() + offset,
      sink: async () => (opts.bus === false ? null : async (fill) => void published.push(fill)),
    });
  return {
    published,
    sweep,
    crashBeforeMark: () => {
      failNextMark = true;
    },
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
    name: 'TEST trend',
    blocks: [],
    modules: RULES,
    risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
    cash: '1000',
    environment: 'paper',
    clientStrategyId: 'client-notify',
    idempotencyKey: 'save-notify',
  });
}

const start = (strategyId: string, ordinal: number) => ({
  strategyId,
  strategyVersion: 1,
  cash: '1000',
  holdings: [],
  feed: 'own_venue',
  costs: { feeRole: 'taker', slippageBps: '5', delayBars: '0' },
  ordinal,
});

const TEMPLATE = '{strategy} v{version}: {side} {qty} {symbol} at {price} ({time})';

describe('strategy notification channels (AL-live-06)', () => {
  it('starts in-app only; keeps email; refuses a webhook as unavailable and saves nothing', async () => {
    const t = setup();
    await t.plan();
    const s = await saved(t.a);
    expect(await t.a.notify.get({ strategyId: s.id })).toMatchObject({ channels: ['inapp'], updatedAt: null });
    expect((await t.a.notify.set({ strategyId: s.id, channels: ['email'] })).channels).toEqual(['inapp', 'email']);
    await expect(t.a.notify.set({ strategyId: s.id, channels: ['email', 'webhook'] })).rejects.toThrow(
      /^quant\.notify_channel_unavailable — webhook — no outbound sender/,
    );
    await expect(t.a.notify.set({ strategyId: s.id, channels: ['pager'] })).rejects.toThrow(/^quant\.params_invalid/);
    expect((await t.a.notify.get({ strategyId: s.id })).channels).toEqual(['inapp', 'email']);
    await expect(t.b.notify.get({ strategyId: s.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(t.b.notify.set({ strategyId: s.id, channels: [] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('fill alerts (AL-alerts-01)', () => {
  it('refuses an unknown field, a stray brace and a blank template; a retry reads the same alert', async () => {
    const t = setup();
    await t.plan();
    const s = await saved(t.a);
    const make = (template: string, ordinal = 0) => t.a.alert.create({ strategyId: s.id, strategyVersion: 1, template, ordinal });
    await expect(make('{strategy} made {profit}')).rejects.toThrow(/^alert\.template_invalid — template — \{profit\} is not a field/);
    await expect(make('{side')).rejects.toThrow(/^alert\.template_invalid — template — a brace is not closed/);
    await expect(make('  ')).rejects.toThrow(/^alert\.template_invalid/);
    await expect(make('{process.exit()}')).rejects.toThrow(/^alert\.template_invalid/);
    const first = await make(TEMPLATE);
    expect((await make(TEMPLATE)).alertId).toBe(first.alertId);
    expect((await t.a.alert.list({ strategyId: s.id })).alerts).toHaveLength(1);
    await expect(t.b.alert.create({ strategyId: s.id, strategyVersion: 1, template: TEMPLATE, ordinal: 0 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'quant.studio_not_found — strategy not found',
    });
    await expect(t.b.alert.list({ strategyId: s.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a parameter change makes a new version and leaves the existing alert as it was', async () => {
    const t = setup();
    await t.plan();
    const s = await saved(t.a);
    const alert = await t.a.alert.create({ strategyId: s.id, strategyVersion: 1, template: TEMPLATE, ordinal: 0 });
    const updated = await t.a.studio.update({
      id: s.id,
      name: 'TEST trend',
      blocks: [],
      modules: { ...RULES, signal: { ...RULES.signal, slow: '3' } },
      risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
      cash: '1000',
      environment: 'paper',
      idempotencyKey: 'update-notify',
    });
    expect(updated.version).toBe(2);
    expect((await t.a.alert.list({ strategyId: s.id })).alerts).toEqual([alert]);
  });

  it('announces each fill made after the alert once, from the server, with the fields filled; a crash re-sends the same id', async () => {
    const t = setup();
    await t.plan();
    const s = await saved(t.a);
    await t.a.notify.set({ strategyId: s.id, channels: ['email'] });
    const run = await t.a.paper.start(start(s.id, 0));
    const alert = await t.a.alert.create({ strategyId: s.id, strategyVersion: 1, template: TEMPLATE, ordinal: 0 });
    // Nothing has filled yet, and no bus answers: nothing goes out and nothing is marked.
    expect(await t.sweep()).toBe(0);
    t.later(30);
    expect(await t.sweep({ bus: false })).toBe(0);
    const view = await t.a.paper.get({ runId: run.runId });
    expect(view.trades.length).toBeGreaterThan(1);

    // The first fill is published but the process dies before marking it.
    t.crashBeforeMark();
    await expect(t.sweep()).resolves.toBe(0);
    expect(t.published).toHaveLength(1);
    const count = await t.sweep();
    expect(count).toBe(view.trades.length);
    // The re-sent fill carries the same event id as the first send.
    expect(t.published[1]!.eventId).toBe(t.published[0]!.eventId);
    const ids = new Set(t.published.map((fill) => fill.eventId));
    expect(ids.size).toBe(view.trades.length);
    const first = t.published[0]!;
    const trade = view.trades[0]!;
    expect(first).toMatchObject({
      eventId: `quant.fill:${alert.alertId}:${run.runId}:0`,
      userId: ACCOUNT_A,
      strategyId: s.id,
      strategyVersion: 1,
      runId: run.runId,
      mode: 'paper',
      side: trade.side,
      qty: trade.qty,
      price: trade.price,
      filledAt: trade.ts,
      channels: ['email'],
      message: `TEST trend v1: ${trade.side} ${trade.qty} BTC/USDT at ${trade.price} (${trade.ts})`,
    });
    // A later sweep finds nothing new; a sweep after more bars announces only the new fills, each under a new id.
    expect(await t.sweep()).toBe(0);
    t.later(60);
    const more = await t.a.paper.get({ runId: run.runId });
    expect(more.trades.length).toBeGreaterThan(view.trades.length);
    const before = t.published.length;
    expect(await t.sweep()).toBe(more.trades.length - view.trades.length);
    const fresh = t.published.slice(before).map((fill) => fill.eventId);
    expect(fresh).toEqual(
      more.trades.slice(view.trades.length).map((_, n) => `quant.fill:${alert.alertId}:${run.runId}:${view.trades.length + n}`),
    );
    await t.a.paper.stop({ runId: run.runId });
    expect(await t.sweep()).toBe(0);
  });

  it('announces no fill made before the alert existed, and none for another version', async () => {
    const t = setup();
    await t.plan();
    const s = await saved(t.a);
    await t.a.paper.start(start(s.id, 0));
    t.later(12);
    await t.a.alert.create({ strategyId: s.id, strategyVersion: 1, template: TEMPLATE, ordinal: 0 });
    expect(await t.sweep()).toBe(0);
    expect(t.published).toEqual([]);
  });
});
