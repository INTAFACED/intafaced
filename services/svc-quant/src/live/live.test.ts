import { describe, expect, it } from 'vitest';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  signPrincipalHeader,
  type QuantSignalRules,
} from '@intafaced/contracts';
import { NO_JUDGEMENT } from '../engine/run.js';
import { createMemoryLifecycleRepository } from '../lifecycle/memory-repository.js';
import { createQuantRouter } from '../router.js';
import { RUN_RESULT_MAX_BYTES } from '../runs/limit.js';
import { createMemoryRunRepository } from '../runs/memory-repository.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';
import { liveCheck } from './check.js';

// AL-live-02 (J-algo-dev-06 #6 #7): the deploy wizard's compile check names every order a live deploy can't place, and
// Deploy with the platform's live switch off refuses `quant.live_disabled` and writes nothing.
const SECRET = 'a-quant-live-deploy-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const RULES: QuantSignalRules = {
  symbol: 'BTC/USDT',
  barSize: '1h',
  signal: { kind: 'ma_cross', average: 'sma', fast: '1', slow: '2' },
  sizing: { kind: 'quantity', value: '1' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
};
const RISK = { maxDrawdown: '500', maxNotional: '10000', kill: '100' };

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

function setup() {
  const lifecycle = createMemoryLifecycleRepository();
  const runs = createMemoryRunRepository(RUN_RESULT_MAX_BYTES);
  const app = createQuantRouter({
    wired: true,
    venueVaultSet: false,
    limits: { maxOps: 5_000, maxSource: 8_000 },
    strategies: createMemoryStrategyRepository(),
    runs,
    lifecycle,
    judgement: NO_JUDGEMENT,
  });
  const writer = app.createCaller(signed(OPERATOR, ['admin:write']));
  let n = 0;
  return {
    a: app.createCaller(signed(ACCOUNT_A)),
    b: app.createCaller(signed(ACCOUNT_B)),
    lifecycle,
    runs,
    live: (value: string | null) =>
      writer.ops.criteria.set({ name: 'live.enabled', value, reason: 'LOCAL TEST', idempotencyKey: `live:${(n += 1)}` }),
  };
}

type T = ReturnType<typeof setup>;

async function save(
  a: T['a'],
  name: string,
  rules: { blocks?: { side: 'buy' | 'sell'; symbol: string; qty: string }[]; modules?: QuantSignalRules | null },
) {
  return a.studio.save({
    name,
    blocks: rules.blocks ?? [],
    modules: rules.modules ?? null,
    risk: RISK,
    cash: '1000',
    environment: 'paper',
    clientStrategyId: `client-${name}`,
    idempotencyKey: `save-${name}`,
  });
}

describe('live compile check (AL-live-02)', () => {
  it('passes order blocks as market orders and names signal rules, a stop loss and a take profit as refused', () => {
    expect(liveCheck({ blocks: [{ side: 'buy', symbol: 'BTC-PERP', qty: '0.001' }], modules: null })).toEqual({
      plan: 'blocks',
      compiles: true,
      orderTypes: [{ source: 'block', block: 1, type: 'market', percent: null, supported: true, code: null }],
    });
    const reading = liveCheck({ blocks: [], modules: { ...RULES, exit: { stopLossPercent: '2', takeProfitPercent: ' 5 ' } } });
    expect(reading.compiles).toBe(false);
    expect(reading.orderTypes).toEqual([
      { source: 'signal_entry', block: null, type: 'market', percent: null, supported: false, code: 'quant.live_plan_unsupported' },
      { source: 'stop_loss', block: null, type: 'stop', percent: '2', supported: false, code: 'trade.order_type_unsupported' },
      { source: 'take_profit', block: null, type: 'take_profit', percent: '5', supported: false, code: 'trade.order_type_unsupported' },
    ]);
    // A version with nothing to place does not compile.
    expect(liveCheck({ blocks: [], modules: null }).compiles).toBe(false);
  });

  it('reads the platform live switch as off until an operator stores on, and another account’s strategy as missing', async () => {
    const t = setup();
    const s = await save(t.a, 'TEST blocks', { blocks: [{ side: 'buy', symbol: 'BTC-PERP', qty: '0.001' }] });
    expect(await t.a.live.check({ strategyId: s.id, strategyVersion: 1 })).toMatchObject({
      compiles: true,
      liveEnabled: false,
      plan: 'blocks',
    });
    await t.live('on');
    expect((await t.a.live.check({ strategyId: s.id, strategyVersion: 1 })).liveEnabled).toBe(true);
    await t.live(null);
    expect((await t.a.live.check({ strategyId: s.id, strategyVersion: 1 })).liveEnabled).toBe(false);
    await expect(t.b.live.check({ strategyId: s.id, strategyVersion: 1 })).rejects.toThrow(/quant\.studio_not_found/);
    await expect(t.a.live.check({ strategyId: s.id, strategyVersion: 2 })).rejects.toThrow(/quant\.studio_not_found/);
  });

  it('refuses a value other than on for the live switch', async () => {
    const t = setup();
    await expect(t.live('yes')).rejects.toThrow(/quant\.params_invalid/);
  });

  it('a stop loss on a live deploy is refused at the check by name', async () => {
    const t = setup();
    const s = await save(t.a, 'TEST stop', { modules: { ...RULES, exit: { stopLossPercent: '2', takeProfitPercent: '' } } });
    const check = await t.a.live.check({ strategyId: s.id, strategyVersion: 1 });
    expect(check.orderTypes.find((row) => row.source === 'stop_loss')).toMatchObject({
      type: 'stop',
      supported: false,
      code: 'trade.order_type_unsupported',
    });
  });
});

describe('live deploy (AL-live-02)', () => {
  it('with live off refuses quant.live_disabled and writes nothing, even for a version that compiles', async () => {
    const t = setup();
    const s = await save(t.a, 'TEST blocks', { blocks: [{ side: 'buy', symbol: 'BTC-PERP', qty: '0.001' }] });
    const criteria = await t.lifecycle.criteria();
    const before = await t.a.studio.get({ id: s.id });
    await expect(t.a.live.deploy({ strategyId: s.id, strategyVersion: 1, amount: '100' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/^quant\.live_disabled — .*nothing was stored/),
    });
    expect(await t.lifecycle.criteria()).toEqual(criteria);
    expect(await t.a.studio.get({ id: s.id })).toEqual(before);
    const history = await t.runs.history({ userId: ACCOUNT_A, kind: 'backtest', keyPrefix: '', limit: 10, cursor: null, strategyId: s.id });
    expect(history.runs).toHaveLength(0);
  });

  it('with live on refuses a version the runner can not place by the check’s code, and a compiling one as not built yet', async () => {
    const t = setup();
    await t.live('on');
    const stop = await save(t.a, 'TEST stop', { modules: { ...RULES, exit: { stopLossPercent: '2', takeProfitPercent: '' } } });
    await expect(t.a.live.deploy({ strategyId: stop.id, strategyVersion: 1, amount: '100' })).rejects.toThrow(
      /^quant\.live_plan_unsupported — signal_entry/,
    );
    const blocks = await save(t.a, 'TEST blocks', { blocks: [{ side: 'buy', symbol: 'BTC-PERP', qty: '0.001' }] });
    await expect(t.a.live.deploy({ strategyId: blocks.id, strategyVersion: 1, amount: '100' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/^quant\.live_deploy_unavailable — .*nothing was stored/),
    });
    await expect(t.b.live.deploy({ strategyId: blocks.id, strategyVersion: 1, amount: '100' })).rejects.toThrow(/quant\.studio_not_found/);
  });
});
