/**
 * Unit card — liquidation without published ladder refuses (no silent flatten)
 *
 * 1. Promise: omitted deps.ladder does not run planLiquidation full close.
 * 2. Break: `if (deps.ladder) { runLadderRung; continue }` then planLiquidation.
 * 3. Done bar: omitted ladder → skipped_d3_unset / trade.ladder_unset, zero posts,
 *    closer idle. Source has no planLiquidation call.
 * 4. Class N
 * 5. Paths: futures/liquidation-tick.ts
 * 6. RED: underwater position without ladder posts a full close
 */
import { describe, expect, it } from 'vitest';
import { parseAmount as amt, type AccountRef, type Amount, type Balance, type PostRequest } from '@intafaced/ledger-client';
import { memoryLiquidationAttemptStore, runLiquidationTick, type LiquidationPositionRow } from './liquidation-tick.js';
import { memoryAcceptedMarkStore } from './accepted-mark.js';

const USER = '11111111-1111-4111-8111-111111111111';

function underwaterLong(): LiquidationPositionRow {
  return {
    positionId: 'pos-1',
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

describe('liquidation tick without published ladder refuses', () => {
  it('omitted ladder skips an underwater position — no post, no close', async () => {
    const posts: PostRequest[] = [];
    const closed: string[] = [];
    const result = await runLiquidationTick({
      marks: {
        async markPrice() {
          return '80';
        },
        async quote({ marketId, symbol, at }) {
          return { marketId, symbol, price: amt('80'), asOf: at, quality: 'mid' };
        },
      },
      positions: {
        async listOpen() {
          return [underwaterLong()];
        },
      },
      closer: {
        async markLiquidated(id) {
          closed.push(id);
        },
      },
      attempts: memoryLiquidationAttemptStore(),
      acceptedMarks: memoryAcceptedMarkStore(),
      ledger: {
        async post(req: PostRequest) {
          posts.push(req);
          return { id: `tx-${posts.length}`, idempotencyKey: req.idempotencyKey } as never;
        },
        async balance(ref: AccountRef): Promise<Balance> {
          return { account: ref, accountId: `${ref.ownerType}:${ref.ownerId}`, amount: 0n as Amount };
        },
      },
    });
    expect(result.liquidated).toBe(0);
    expect(result.partial).toBe(0);
    expect(result.items[0]!.outcome).toBe('skipped_d3_unset');
    expect(result.items[0]!.reason).toBe('trade.ladder_unset');
    expect(result.items[0]!.summary).toMatch(/will not flatten/);
    expect(posts).toHaveLength(0);
    expect(closed).toHaveLength(0);
  });
});
