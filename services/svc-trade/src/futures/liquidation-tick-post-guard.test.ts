/**
 * The liquidation tick posts every recipe through the sub-account loss gate (TRD-0289): each post is a recipe the
 * gate was asked about first, and a recipe the gate refuses is never posted.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseAmount as amt, type AccountRef, type Amount, type Balance, type PostRequest } from '@intafaced/ledger-client';
import { memoryAcceptedMarkStore } from './accepted-mark.js';
import { deepFullCloseLadder } from './ladder-policy.test-harness.js';
import {
  memoryLiquidationAttemptStore,
  runLiquidationTick,
  type LiquidationPositionRow,
  type QuotedMarkSource,
} from './liquidation-tick.js';

const gate = vi.hoisted(() => ({ asked: [] as unknown[], refuse: false }));

vi.mock('./sub-account-loss.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sub-account-loss.js')>();
  return {
    ...actual,
    gateLiquidationRecipe: (row: Parameters<typeof actual.gateLiquidationRecipe>[0], recipe: PostRequest) => {
      gate.asked.push(recipe);
      if (gate.refuse) return { ok: false as const, code: actual.SIBLING_SUB_ACCOUNT_LOSS, reason: 'refused in test' };
      return actual.gateLiquidationRecipe(row, recipe);
    },
  };
});

const USER = '11111111-1111-4111-8111-111111111111';
const AT = new Date('2026-09-02T20:00:00.000Z');

function underwaterLong(): LiquidationPositionRow {
  // entry 100, size 1, margin 10 → mark 80: equity -10, insurance covers 10.
  return {
    positionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: USER,
    side: 'long',
    size: amt('1'),
    entryPrice: amt('100'),
    margin: amt('10'),
    marginAsset: 'USDT',
    marketId: 'm1',
    symbol: 'BTC/USDT-PERP',
  };
}

const marks: QuotedMarkSource = {
  async markPrice() {
    return '80';
  },
  async quote({ marketId, symbol, at }) {
    return { marketId, symbol, price: amt('80'), asOf: at, quality: 'mid' };
  },
};

async function tick() {
  const posts: PostRequest[] = [];
  const insurance: Amount = amt('1000000');
  const result = await runLiquidationTick({
    marks,
    positions: { listOpen: async () => [underwaterLong()] },
    closer: { markLiquidated: async () => undefined },
    attempts: memoryLiquidationAttemptStore(),
    acceptedMarks: memoryAcceptedMarkStore(),
    ledger: {
      async post(req: PostRequest) {
        posts.push(req);
        return { id: `tx-${posts.length}`, idempotencyKey: req.idempotencyKey } as never;
      },
      async balance(ref: AccountRef): Promise<Balance> {
        const amount = ref.ownerType === 'house' && ref.ownerId === 'insurance-fund' ? insurance : 0n;
        return { account: ref, accountId: `${ref.ownerType}:${ref.ownerId}`, amount };
      },
    },
    now: () => AT,
    ladder: deepFullCloseLadder(),
  });
  return { result, posts };
}

describe('liquidation tick posts only through the sub-account loss gate', () => {
  it('every posted recipe was gated first', async () => {
    gate.asked = [];
    gate.refuse = false;
    const { posts } = await tick();
    expect(posts.length).toBeGreaterThan(0);
    expect(gate.asked).toEqual(posts);
  });

  it('a recipe the gate refuses is never posted', async () => {
    gate.asked = [];
    gate.refuse = true;
    const { posts, result } = await tick();
    expect(gate.asked.length).toBeGreaterThan(0);
    expect(posts).toEqual([]);
    expect(result.liquidated).toBe(0);
  });
});
