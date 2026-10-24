import { describe, expect, it, vi } from 'vitest';
import { checkAccess } from '@intafaced/config';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  signPrincipalHeader,
  type QuantSignalRules,
} from '@intafaced/contracts';
import { createQuantRouter } from '../router.js';
import { reportOf } from './document.js';
import { RUN_RESULT_MAX_BYTES } from '../runs/limit.js';
import { createMemoryRunRepository } from '../runs/memory-repository.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';
import { tradeFeePort, tradeHistoryPort } from '../engine/ports.js';
import { createMemoryShareRepository } from '../share/memory-repository.js';
import type { ShareRepository } from '../share/repository.js';

const SECRET = 'a-quant-share-report-test-edge-secret-long-enough';
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

const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

const CLOSES = ['100', '100', '100', '110', '120', '130', '115', '100'];
function candleRows(): [number, string, string, string, string, string][] {
  return CLOSES.map((close, i) => {
    const open = i === 0 ? close : CLOSES[i - 1]!;
    const high = Number(open) > Number(close) ? open : close;
    const low = Number(open) < Number(close) ? open : close;
    return [T0 + i * HOUR, open, high, low, close, '1'];
  });
}

function fakeFetch(routes: Record<string, { status: number; body: unknown }>) {
  return async (url: string) => {
    const path = url.replace('http://trade.test', '').split('?')[0]!;
    const hit = routes[path];
    if (!hit) throw new Error(`no route ${url}`);
    return { ok: hit.status === 200, status: hit.status, json: async () => hit.body };
  };
}

const FEES = { status: 200, body: { version: 'local-test:v1', fees: { 'BTC/USDT': { makerBps: 8, takerBps: 10 } } } };

interface ShareOpts {
  readonly repository?: ShareRepository;
  readonly rate?: number | null;
  readonly windowSec?: number | null;
  readonly embedOrigins?: readonly string[] | null;
  readonly now?: () => number;
}

function setup(options: ShareOpts = {}) {
  const fetch = fakeFetch({ '/api/v1/ohlcv/BTC%2FUSDT': { status: 200, body: candleRows() }, '/api/v1/fees/published': FEES });
  const share = {
    repository: options.repository ?? createMemoryShareRepository(),
    rate: options.rate === undefined ? 10 : options.rate,
    windowSec: options.windowSec === undefined ? 60 : options.windowSec,
    embedOrigins: options.embedOrigins === undefined ? null : options.embedOrigins,
    now: options.now,
  };
  const appRouter = createQuantRouter({
    wired: true,
    venueVaultSet: false,
    limits,
    strategies: createMemoryStrategyRepository(),
    runs: createMemoryRunRepository(RUN_RESULT_MAX_BYTES),
    history: tradeHistoryPort({ tradeUrl: 'http://trade.test', now: () => NOW, fetch }),
    fees: tradeFeePort({ tradeUrl: 'http://trade.test', fetch }),
    now: () => NOW,
    share,
  });
  return {
    app: appRouter,
    a: appRouter.createCaller(signed(ACCOUNT_A)),
    b: appRouter.createCaller(signed(ACCOUNT_B)),
    anon: appRouter.createCaller(anonymous()),
    share,
  };
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

async function finished() {
  const world = setup();
  const strategy = await world.a.studio.save({
    name: 'cross',
    blocks: [],
    modules: RULES,
    risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
    cash: '1000',
    environment: 'paper',
    clientStrategyId: 'client-rules',
    idempotencyKey: 'studio.save:client-rules',
  });
  const run = await world.a.backtest.start(request(strategy.id));
  return { ...world, run };
}

describe('backtest report and share link (AL-report-03)', () => {
  it('builds a print document whose sections are all filled, and hides another account', async () => {
    const { a, b, run } = await finished();
    const report = await a.backtest.report({ runId: run.runId });
    expect(report.claimLabel).toBe('Historical simulation — not a forecast');
    expect(report.simulated).toBe(true);
    expect(report.sections.map((section) => section.id)).toEqual(['parameters', 'statistics', 'charts', 'coverage', 'warnings', 'labels']);
    for (const section of report.sections) {
      expect(section.rows.length).toBeGreaterThan(0);
      for (const line of section.rows) expect(line.value.trim().length).toBeGreaterThan(0);
    }
    expect(report.sections[1]?.rows.find((line) => line.name === 'net')?.value).toBe(run.totals.net);
    expect(report.sections[5]?.rows.find((line) => line.name === 'claimLabel')?.value).toBe(report.claimLabel);
    const printed = report.sections.find((section) => section.id === 'warnings')?.rows ?? [];
    for (const line of run.log.filter((entry) => entry.level === 'warn')) {
      const hit = printed.find((row) => row.name === line.code && Object.values(line.values).every((value) => row.value.includes(value)));
      expect(hit, line.code).toBeDefined();
      expect(hit?.value).not.toBe('no time');
    }
    expect(printed.some((row) => row.name === 'assumption' && row.value.includes('risk_limits_not_simulated'))).toBe(true);
    const shaped = reportOf({
      ...run,
      checks: run.checks.map((check) => ({ ...check, status: 'clear' as const })),
      log: [
        { level: 'warn', code: 'assumption', ts: null, values: { name: 'open_position_marked_at_last_close' } },
        { level: 'warn', code: 'assumption', ts: null, values: { name: 'risk_limits_not_simulated' } },
        {
          level: 'warn',
          code: 'gap',
          ts: '2026-10-20T04:00:00.000Z',
          values: { from: '2026-10-20T04:00:00.000Z', to: '2026-10-20T06:00:00.000Z' },
        },
        {
          level: 'warn',
          code: 'margin_event',
          ts: '2026-10-20T07:00:00.000Z',
          values: { kind: 'stop_out', price: '100', level: '50' },
        },
        { level: 'warn', code: 'bare', ts: null, values: {} },
      ],
    });
    expect(shaped.sections[4].rows).toEqual([
      { name: 'assumption', value: 'name open_position_marked_at_last_close' },
      { name: 'assumption', value: 'name risk_limits_not_simulated' },
      { name: 'gap', value: 'from 2026-10-20T04:00:00.000Z, to 2026-10-20T06:00:00.000Z' },
      { name: 'margin_event', value: 'kind stop_out, price 100, level 50' },
      { name: 'bare', value: 'no time' },
    ]);
    await expect(b.backtest.report({ runId: run.runId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('keeps one active link, shows the token once, and answers a lost reply by the next seq', async () => {
    const { a, anon, run } = await finished();
    const [first, replay] = await Promise.all([
      a.result.share.create({ runId: run.runId, seq: 0 }),
      a.result.share.create({ runId: run.runId, seq: 0 }),
    ]);
    const tokens = [first.token, replay.token].filter((token): token is string => token !== null);
    expect(tokens).toHaveLength(1);
    expect(await a.result.share.get({ runId: run.runId })).toMatchObject({ links: 1, active: true, seq: 0 });
    const again = await a.result.share.create({ runId: run.runId, seq: 1 });
    expect(again.token).toBeNull();
    expect(again.links).toBe(1);
    expect(again.active).toBe(true);

    const token = tokens[0]!;
    const opened = await anon.result.share.public({ token });
    expect(opened.claimLabel).toBe('Historical simulation — not a forecast');
    expect(opened.simulated).toBe(true);
    expect(opened.live).toBe(false);
    expect(opened.coverage.bars).toBe(run.coverage.bars);
    expect(opened.checks.length).toBeGreaterThan(0);
    const body = JSON.stringify(opened);
    expect(body).not.toContain(ACCOUNT_A);
    expect(body).not.toContain(run.runKey);
    expect(body).not.toContain('"source"');

    await a.result.share.revoke({ runId: run.runId });
    const lost = await a.result.share.create({ runId: run.runId, seq: 1 });
    expect(lost.token).not.toBeNull();
    expect(lost.token).not.toBe(token);
    expect(lost.seq).toBe(1);
    expect(lost.path).toBe(`/quant/share/${lost.token}`);
    const revoked = await anon.result.share.public({ token }).then(
      () => null,
      (err: { message: string }) => err,
    );
    const unknown = await anon.result.share.public({ token: 'not-a-link' }).then(
      () => null,
      (err: { message: string }) => err,
    );
    expect(revoked?.message).toBe(unknown?.message);
    expect(revoked?.message).toContain('quant.share_not_found');
    expect((await anon.result.share.public({ token: lost.token! })).symbol).toBe(run.symbol);
    const stale = await a.result.share.create({ runId: run.runId, seq: 0 });
    expect(stale.token).toBeNull();
    expect(stale.active).toBe(false);
    expect(await a.result.share.get({ runId: run.runId })).toMatchObject({ links: 2, active: true, seq: 1 });
  });

  it('refuses a blank share rate or window, and a blank seq stores nothing', async () => {
    const bare = setup({ rate: null });
    const strategy = await bare.a.studio.save({
      name: 'cross',
      blocks: [],
      modules: RULES,
      risk: { maxDrawdown: '1', maxNotional: '1', kill: '1' },
      cash: '1000',
      environment: 'paper',
      clientStrategyId: 'client-rules',
      idempotencyKey: 'studio.save:client-rules',
    });
    const run = await bare.a.backtest.start(request(strategy.id));
    await expect(bare.a.result.share.create({ runId: run.runId, seq: 0 })).rejects.toThrow(/quant\.share_rate_unset/);
    await expect(bare.anon.result.share.public({ token: 'x' })).rejects.toThrow(/quant\.share_rate_unset/);
    const noWindow = setup({ rate: 5, windowSec: null });
    await expect(noWindow.anon.result.share.public({ token: 'x' })).rejects.toThrow(/quant\.share_window_unset/);
    const { a, b, run: stored } = await finished();
    await expect(a.result.share.create({ runId: stored.runId })).rejects.toThrow(/quant\.share_seq_unset/);
    await expect(a.result.share.create({ runId: stored.runId, seq: 2 })).rejects.toThrow(/quant\.share_seq_stale/);
    await expect(b.result.share.create({ runId: stored.runId, seq: 0 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await a.result.share.get({ runId: stored.runId })).toMatchObject({ links: 0, active: false });
  });

  it('refuses the embed snippet when the origin list is blank, and the link still opens', async () => {
    const { a, anon, run } = await finished();
    const created = await a.result.share.create({ runId: run.runId, seq: 0 });
    expect(created.token).not.toBeNull();
    expect(created.embed).toBeNull();
    expect(created.embedRefusal).toBe('quant.embed_origins_unset');
    await expect(a.result.share.embed({ runId: run.runId, token: created.token })).rejects.toThrow(/quant\.embed_origins_unset/);
    expect((await anon.result.share.public({ token: created.token! })).claimLabel).toBe(created.token ? run.claimLabel : '');
  });

  it('returns the embed snippet once the owner list is set, without issuing a second token', async () => {
    const world = setup({ embedOrigins: ['https://app.example'] });
    const strategy = await world.a.studio.save({
      name: 'cross',
      blocks: [],
      modules: RULES,
      risk: { maxDrawdown: '1', maxNotional: '1', kill: '1' },
      cash: '1000',
      environment: 'paper',
      clientStrategyId: 'client-rules',
      idempotencyKey: 'studio.save:client-rules',
    });
    const run = await world.a.backtest.start(request(strategy.id));
    const created = await world.a.result.share.create({ runId: run.runId, seq: 0 });
    expect(created.embed?.origins).toEqual(['https://app.example']);
    expect(created.embed?.snippet).toContain(`/quant/share/${created.token}`);
    expect(created.embedRefusal).toBeNull();
    const replay = await world.a.result.share.create({ runId: run.runId, seq: 0 });
    expect(replay.token).toBeNull();
    expect(replay.embed).toBeNull();
    const snippet = await world.a.result.share.embed({ runId: run.runId, token: created.token });
    expect(snippet.snippet).toContain(created.token!);
    await expect(world.a.result.share.embed({ runId: run.runId, token: '' })).rejects.toThrow(/quant\.share_token_unset/);
    await expect(world.a.result.share.embed({ runId: run.runId, token: 'wrong' })).rejects.toMatchObject({
      message: expect.stringContaining('quant.share_not_found'),
    });
  });

  it('stops public reads at the published rate and allows them again after the window', async () => {
    let clock = 1_700_000_000_000;
    const world = setup({ rate: 1, windowSec: 60, now: () => clock });
    const strategy = await world.a.studio.save({
      name: 'cross',
      blocks: [],
      modules: RULES,
      risk: { maxDrawdown: '1', maxNotional: '1', kill: '1' },
      cash: '1000',
      environment: 'paper',
      clientStrategyId: 'client-rules',
      idempotencyKey: 'studio.save:client-rules',
    });
    const run = await world.a.backtest.start(request(strategy.id));
    const created = await world.a.result.share.create({ runId: run.runId, seq: 0 });
    expect((await world.anon.result.share.public({ token: created.token! })).symbol).toBe('BTC/USDT');
    await expect(world.anon.result.share.public({ token: created.token! })).rejects.toThrow(/quant\.share_rate_limited/);
    clock += 61_000;
    expect((await world.anon.result.share.public({ token: created.token! })).symbol).toBe('BTC/USDT');
    const repository = createMemoryShareRepository();
    const seeded = await repository.create({
      accountId: ACCOUNT_A,
      runId: 'run_rate_zero',
      seq: 0,
      now: '2026-10-23T00:00:00.000Z',
    });
    const blocked = setup({ rate: 0, windowSec: 60, repository });
    await expect(blocked.anon.result.share.public({ token: 'anything' })).rejects.toThrow(/quant\.share_not_found/);
    await expect(blocked.anon.result.share.public({ token: seeded.token! })).rejects.toThrow(/quant\.share_rate_limited/);
  });

  it('returns not found for a revoked token after unknown reads have filled the rate', async () => {
    let clock = 1_700_000_000_000;
    const world = setup({ rate: 1, windowSec: 60, now: () => clock });
    const strategy = await world.a.studio.save({
      name: 'cross',
      blocks: [],
      modules: RULES,
      risk: { maxDrawdown: '1', maxNotional: '1', kill: '1' },
      cash: '1000',
      environment: 'paper',
      clientStrategyId: 'client-rules',
      idempotencyKey: 'studio.save:client-rules',
    });
    const run = await world.a.backtest.start(request(strategy.id));
    const created = await world.a.result.share.create({ runId: run.runId, seq: 0 });
    const unknown = await world.anon.result.share.public({ token: 'not-a-link' }).then(
      () => null,
      (err: { message: string }) => err,
    );
    await world.a.result.share.revoke({ runId: run.runId });
    const revoked = await world.anon.result.share.public({ token: created.token! }).then(
      () => null,
      (err: { message: string }) => err,
    );
    expect(unknown?.message).toContain('quant.share_not_found');
    expect(revoked?.message).toBe(unknown?.message);
    expect(revoked?.message).not.toContain('quant.share_rate_limited');
  });

  it('refuses a region checkAccess blocks and still opens the link signed out where quant is open', async () => {
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'AA:placeholder programme');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture-not-a-real-list');
    try {
      const blocked = checkAccess({ module: 'quant', plane: 'fiat', region: 'AA', kycTier: 'none' });
      const open = checkAccess({ module: 'quant', plane: 'fiat', region: 'DE', kycTier: 'none' });
      expect(blocked.allowed).toBe(false);
      expect(open.allowed).toBe(true);
      const { app, a, anon, run } = await finished();
      const created = await a.result.share.create({ runId: run.runId, seq: 0 });
      const closed = app.createCaller(edgeContext({ headers: { 'x-intafaced-region': 'AA' }, id: 'req-aa' }));
      await expect(closed.result.share.public({ token: created.token! })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: blocked.reason,
      });
      expect((await anon.result.share.public({ token: created.token! })).symbol).toBe(run.symbol);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
