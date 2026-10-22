import { describe, expect, it } from 'vitest';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  signPrincipalHeader,
} from '@intafaced/contracts';
import type { BacktestLake } from '../backtest/lake.js';
import { createQuantRouter } from '../router.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';

const SECRET = 'a-quant-quickstart-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const limits = { maxOps: 5_000, maxSource: 8_000 };
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const lake: BacktestLake = {
  wired: true,
  fills: () => [
    { ts: '2026-02-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '0.01', price: '50000' },
    { ts: '2026-05-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '0.02', price: '51000' },
  ],
};
const body = {
  name: 'alpha',
  blocks: [{ side: 'buy' as const, symbol: 'BTC-USD', qty: '0.01' }],
  risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
  cash: '10000',
  environment: 'paper' as const,
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

describe('quick start', () => {
  it('ticks each step only from the account’s own stored strategy and runs', async () => {
    const app = createQuantRouter({ wired: true, venueVaultSet: false, limits, strategies: createMemoryStrategyRepository(), lake });
    const a = app.createCaller(signed(ACCOUNT_A));
    const b = app.createCaller(signed(ACCOUNT_B));
    expect(await a.quickStart()).toEqual({ strategy: false, backtest: false, paperRun: false });

    const saved = await a.studio.save({ ...body, clientStrategyId: 'client-alpha', idempotencyKey: 'idem-create' });
    expect(await a.quickStart()).toEqual({ strategy: true, backtest: false, paperRun: false });

    await a.backtest.run({
      strategyId: saved.id,
      symbol: 'BTC-USD',
      walkForward: {
        inSampleFrom: '2026-01-01T00:00:00.000Z',
        inSampleTo: '2026-04-01T00:00:00.000Z',
        outOfSampleFrom: '2026-04-01T00:00:00.000Z',
        outOfSampleTo: '2026-07-01T00:00:00.000Z',
      },
      outOfSampleStatus: 'passed',
      costModel: {
        fees: { kind: 'venue-schedule', source: 'fixture:fees' },
        slippage: { kind: 'order-book-replay', source: 'fixture:depth' },
        latency: { kind: 'measured-distribution', source: 'fixture:latency' },
      },
      strategyVariantCount: 1,
      environment: 'backtest',
      idempotencyKey: 'idem-backtest',
    });
    expect(await a.quickStart()).toEqual({ strategy: true, backtest: true, paperRun: false });

    // Another account's rows tick nothing for this one.
    expect(await b.quickStart()).toEqual({ strategy: false, backtest: false, paperRun: false });
  });

  it('a deleted strategy no longer ticks the first step', async () => {
    const app = createQuantRouter({ wired: true, venueVaultSet: false, limits, strategies: createMemoryStrategyRepository(), lake });
    const a = app.createCaller(signed(ACCOUNT_A));
    const saved = await a.studio.save({ ...body, clientStrategyId: 'client-gone', idempotencyKey: 'idem-gone' });
    await a.studio.delete({ id: saved.id, idempotencyKey: 'idem-delete' });
    expect((await a.quickStart()).strategy).toBe(false);
  });

  it('refuses a caller without a session', async () => {
    const app = createQuantRouter({ wired: true, venueVaultSet: false, limits, strategies: createMemoryStrategyRepository(), lake });
    const anonymous = app.createCaller(edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' }));
    await expect(anonymous.quickStart()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
