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
import { createMemoryStrategyRepository } from './memory-repository.js';

const SECRET = 'a-quant-persist-router-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const limits = { maxOps: 5_000, maxSource: 8_000 };
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const walkForward = {
  inSampleFrom: '2026-01-01T00:00:00.000Z',
  inSampleTo: '2026-04-01T00:00:00.000Z',
  outOfSampleFrom: '2026-04-01T00:00:00.000Z',
  outOfSampleTo: '2026-07-01T00:00:00.000Z',
};
const costModel = {
  fees: { kind: 'venue-schedule', source: 'fixture:fees' },
  slippage: { kind: 'order-book-replay', source: 'fixture:depth' },
  latency: { kind: 'measured-distribution', source: 'fixture:latency' },
};
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

function signed(userId: string, scopes: string[] = ['trade:read']) {
  const principal = {
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'basic' as const,
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } satisfies Parameters<typeof encodePrincipal>[0];
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-region': 'DE',
      [EDGE_PRINCIPAL_HEADER]: raw,
      [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, SECRET, 'DE'),
    },
    id: `req-${userId}`,
  });
}

describe('backtest records the owned version', () => {
  it('refuses a missing, foreign, or deleted strategy and keeps the version it ran', async () => {
    const strategies = createMemoryStrategyRepository();
    const app = createQuantRouter({ wired: true, venueVaultSet: false, limits, strategies, lake });
    const a = app.createCaller(signed(ACCOUNT_A));
    const b = app.createCaller(signed(ACCOUNT_B));
    const saved = await a.studio.save({ ...body, clientStrategyId: 'client-alpha', idempotencyKey: 'idem-create' });
    const revised = await a.studio.update({ ...body, id: saved.id, name: 'beta', idempotencyKey: 'idem-revise' });
    expect(revised.version).toBe(2);
    expect(revised.versions[0]?.name).toBe('alpha');

    const ran = await a.backtest.run({
      strategyId: saved.id,
      strategyVersion: 1,
      symbol: 'BTC-USD',
      walkForward,
      outOfSampleStatus: 'passed',
      costModel,
      strategyVariantCount: 1,
      environment: 'backtest',
      idempotencyKey: 'idem-backtest',
    });
    expect(ran.strategyVersion).toBe(1);
    expect(ran.runId).toBe(`bt_${saved.id}_v1`);

    const replay = await a.backtest.run({
      strategyId: saved.id,
      strategyVersion: 2,
      symbol: 'BTC-USD',
      walkForward,
      outOfSampleStatus: 'passed',
      costModel,
      strategyVariantCount: 1,
      environment: 'backtest',
      idempotencyKey: 'idem-backtest',
    });
    expect(replay.strategyVersion).toBe(1);
    expect(replay.runId).toBe(ran.runId);

    const missingId = 'studio_00000000-0000-4000-8000-000000000099';
    const foreign = await b.backtest
      .run({
        strategyId: saved.id,
        symbol: 'BTC-USD',
        walkForward,
        outOfSampleStatus: 'passed',
        costModel,
        strategyVariantCount: 1,
        environment: 'backtest',
        idempotencyKey: 'idem-foreign',
      })
      .then(
        () => null,
        (err: { code?: string; message?: string }) => err,
      );
    const missing = await b.backtest
      .run({
        strategyId: missingId,
        symbol: 'BTC-USD',
        walkForward,
        outOfSampleStatus: 'passed',
        costModel,
        strategyVariantCount: 1,
        environment: 'backtest',
        idempotencyKey: 'idem-missing',
      })
      .then(
        () => null,
        (err: { code?: string; message?: string }) => err,
      );
    expect(foreign).toMatchObject({ code: 'NOT_FOUND' });
    expect(foreign?.message).toBe(missing?.message);

    await a.studio.delete({ id: saved.id, idempotencyKey: 'idem-delete' });
    await expect(
      a.backtest.run({
        strategyId: saved.id,
        symbol: 'BTC-USD',
        walkForward,
        outOfSampleStatus: 'passed',
        costModel,
        strategyVariantCount: 1,
        environment: 'backtest',
        idempotencyKey: 'idem-deleted',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await a.studio.list({ limit: 50 })).strategies).toEqual([]);
    expect((await strategies.versions({ accountId: ACCOUNT_A, id: saved.id }))?.map((row) => row.version)).toEqual([1, 2]);

    await expect(a.studio.operatorList({ limit: 50 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
