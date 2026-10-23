import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { MemoryTwapParentStore } from './parent-store.js';
import type { TwapParent } from './types.js';
import { assertParentHasNoMoneyFields } from './present.js';

function sampleParent(over: Partial<TwapParent> = {}): TwapParent {
  const now = new Date('2026-08-07T12:00:00.000Z');
  return {
    id: 'algo-test-1',
    userId: 'user-1',
    subAccountId: null,
    marketId: '11111111-1111-4111-8111-111111111111',
    symbol: 'BTC-USD',
    side: 'buy',
    kind: 'twap',
    totalQty: parseAmount('10'),
    durationMs: 60_000,
    sliceIntervalMs: 10_000,
    limitPrice: null,
    status: 'active',
    createdAt: now,
    startedAt: now,
    nextDueAt: now,
    projectedEndsAt: new Date(now.getTime() + 60_000),
    scheduleStretchReason: null,
    pausedAt: null,
    haltReason: null,
    lotSize: null,
    participationBps: null,
    slicesPlanned: 2,
    nextSliceIndex: 0,
    children: [],
    misses: [],
    ...over,
  };
}

describe('TwapParentStore (durable schedule residual)', () => {
  const previousJobs = process.env.TRADE_ALGO_JOBS_ENABLED;
  beforeEach(() => {
    process.env.TRADE_ALGO_JOBS_ENABLED = 'true';
  });
  afterEach(() => {
    if (previousJobs === undefined) delete process.env.TRADE_ALGO_JOBS_ENABLED;
    else process.env.TRADE_ALGO_JOBS_ENABLED = previousJobs;
  });

  it('round-trips parent + plan without inventing fill fields', async () => {
    const store = new MemoryTwapParentStore();
    const parent = sampleParent();
    assertParentHasNoMoneyFields(parent);
    const plan = [parseAmount('5'), parseAmount('5')];
    await store.save({ parent, plan });
    const loaded = await store.load(parent.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.parent.totalQty).toBe(parseAmount('10'));
    expect(loaded!.plan).toEqual(plan);
    expect(loaded!.parent.status).toBe('active');
    assertParentHasNoMoneyFields(loaded!.parent);
  });

  it('listActive excludes paused', async () => {
    const store = new MemoryTwapParentStore();
    await store.save({
      parent: sampleParent({ id: 'a1', status: 'active' }),
      plan: [parseAmount('1')],
    });
    await store.save({
      parent: sampleParent({ id: 'a2', status: 'paused', pausedAt: new Date() }),
      plan: [parseAmount('1')],
    });
    const active = await store.listActive();
    expect(active.map((r) => r.parent.id)).toEqual(['a1']);
  });

  it('listForUser scopes ownership', async () => {
    const store = new MemoryTwapParentStore();
    await store.save({ parent: sampleParent({ id: 'u1', userId: 'alice' }), plan: [parseAmount('1')] });
    await store.save({ parent: sampleParent({ id: 'u2', userId: 'bob' }), plan: [parseAmount('1')] });
    expect((await store.listForUser('alice')).map((p) => p.id)).toEqual(['u1']);
  });

  it('keeps the createTwap place grant across a later save that omits it', async () => {
    const store = new MemoryTwapParentStore();
    const parent = sampleParent();
    await store.save({
      parent,
      plan: [parseAmount('1')],
      grant: { scopes: ['trade:write'], sid: '33333333-3333-4333-8333-333333333333', tier: 'basic', mfa: false },
    });
    await store.save({ parent: sampleParent({ nextSliceIndex: 1 }), plan: [parseAmount('1')] });
    const loaded = await store.load(parent.id);
    expect(loaded!.grant?.scopes).toEqual(['trade:write']);
  });
});
