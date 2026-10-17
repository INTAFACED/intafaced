import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { durableMarginCallNotifier, memoryMarginCallStore, presentMarginCallWire } from './margin-call-transport.js';
import {
  memoryLiquidationAttemptStore,
  runLiquidationTick,
  type LiquidationPositionRow,
  type QuotedMarkSource,
} from './liquidation-tick.js';
import { memoryAcceptedMarkStore } from './accepted-mark.js';
import type { FuturesLadderPolicy } from './maintenance-ladder.js';
import type { LedgerClient, PostRequest } from '@intafaced/ledger-client';

const HERE = dirname(fileURLToPath(import.meta.url));
const USER = '11111111-1111-4111-8111-111111111111';
const AT = new Date('2026-08-12T12:00:00.000Z');
const amt = (s: string) => parseAmount(s);

const POLICY: FuturesLadderPolicy = {
  tiers: [{ uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 500 }],
  marginCallBps: 12_000,
  targetBps: 15_000,
  maxTrancheBps: 2_500,
};

function marginCallLong(): LiquidationPositionRow {
  return {
    positionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: USER,
    side: 'long',
    size: amt('10'),
    entryPrice: amt('100'),
    margin: amt('100'),
    marginAsset: 'USDT',
    marketId: 'm1',
    symbol: 'BTC/USDT-PERP',
  };
}

function quotedAt(price: string): QuotedMarkSource {
  return {
    async markPrice() {
      return price;
    },
    async quote({ marketId, symbol }) {
      return { marketId, symbol, price: amt(price), asOf: AT, quality: 'mid' };
    },
  };
}

function recordingLedger(): { ledger: Pick<LedgerClient, 'post' | 'balance'>; posts: PostRequest[] } {
  const posts: PostRequest[] = [];
  return {
    posts,
    ledger: {
      async post(req) {
        posts.push(req);
        return { id: 'tx' } as never;
      },
      async balance() {
        // Ample, so the tick plans against the row's own margin (the ledger-pot divergence guard takes min(row, pot)).
        return { account: {} as never, accountId: 'x', amount: 1_000_000n * 10n ** 18n };
      },
    },
  };
}

describe('durableMarginCallNotifier + memory store', () => {
  it('records a call and reports delivered', async () => {
    const store = memoryMarginCallStore();
    const notifier = durableMarginCallNotifier(store);
    const delivery = await notifier.notifyMarginCall({
      positionId: 'pos-1',
      userId: USER,
      marketId: 'm1',
      healthBps: 10_500,
      at: AT,
    });
    expect(delivery).toEqual({ delivered: true });
    const row = await store.getOpenForPosition('pos-1');
    expect(row).toMatchObject({
      positionId: 'pos-1',
      userId: USER,
      sequence: 1,
      healthBps: 10_500,
      deliveredAt: AT,
      clearedAt: null,
    });
    expect(presentMarginCallWire(row!).delivered).toBe(true);
  });

  it('re-tick refreshes health without minting a second open sequence', async () => {
    const store = memoryMarginCallStore();
    const notifier = durableMarginCallNotifier(store);
    await notifier.notifyMarginCall({
      positionId: 'pos-1',
      userId: USER,
      marketId: 'm1',
      healthBps: 10_500,
      at: AT,
    });
    const later = new Date('2026-08-12T12:01:00.000Z');
    await notifier.notifyMarginCall({
      positionId: 'pos-1',
      userId: USER,
      marketId: 'm1',
      healthBps: 10_200,
      at: later,
    });
    const row = await store.getOpenForPosition('pos-1');
    expect(row!.sequence).toBe(1);
    expect(row!.healthBps).toBe(10_200);
    expect(row!.calledAt).toEqual(AT);
    expect(row!.deliveredAt).toEqual(later);
    expect((await store.listOpenForUser(USER)).length).toBe(1);
  });
});

describe('D26-P1-T1b — tick delivers into durable store', () => {
  it('margin-call rung: fires, delivered=true, store observable, no money move', async () => {
    const { ledger, posts } = recordingLedger();
    const store = memoryMarginCallStore();
    const closed: string[] = [];

    const result = await runLiquidationTick({
      marks: quotedAt('95'),
      positions: {
        async listOpen() {
          return [marginCallLong()];
        },
      },
      closer: {
        async markLiquidated(id) {
          closed.push(id);
        },
      },
      attempts: memoryLiquidationAttemptStore(),
      acceptedMarks: memoryAcceptedMarkStore(),
      ledger,
      now: () => AT,
      notifyMarginCall: durableMarginCallNotifier(store),
      ladder: {
        depth: {
          async depthNotional() {
            return amt('1000000');
          },
        },
        reducer: {
          async reduce() {
            throw new Error('must not reduce on margin-call');
          },
        },
        policy: POLICY,
      },
    });

    expect(result.items[0]!.outcome).toBe('margin_call');
    expect(result.items[0]!.delivered).toBe(true);
    expect(result.marginCalls).toBe(1);
    expect(result.liquidated).toBe(0);
    expect(posts).toEqual([]);
    expect(closed).toEqual([]);

    const row = await store.getOpenForPosition(marginCallLong().positionId);
    expect(row).not.toBeNull();
    expect(row!.userId).toBe(USER);
    expect(row!.deliveredAt).toEqual(AT);
    expect(row!.healthBps).toBeGreaterThan(0);
  });
});

describe('D26-P1-T1b — jobs wire (source pin)', () => {
  it('futures-jobs assembles durable notifier into the liquidation tick', () => {
    const src = readFileSync(join(HERE, 'futures-jobs.ts'), 'utf8');
    expect(src).toContain('durableMarginCallNotifier');
    expect(src).toContain('sqlMarginCallStore');
    expect(src).toContain('notifyMarginCall');
  });
});
