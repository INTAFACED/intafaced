/**
 * A funding tick that is refused for an out-of-bound rate must not freeze anything.
 *
 * The period membership snapshot is the set of positions a period charges. If a
 * refused tick still freezes it, a later accepted tick (rate corrected) plans from
 * the stale snapshot taken at the refused moment, not from the positions open when
 * the rate was finally accepted.
 */
import { describe, expect, it } from 'vitest';
import { parseAmount as amt, type PostRequest } from '@intafaced/ledger-client';
import { memoryFundingMarginApplier, memoryFundingPeriodStore, runFundingTick, type FundingRateSource } from './funding-tick.js';
import type { FundingOpenPosition } from './funding-settlement.js';

/** Test-only magnitude bound, not product law. */
const FIXTURE_MAX = '0.01';
const PERIOD = 'm1:bound-before-freeze';

const pos = (id: string, user: string, side: 'long' | 'short'): FundingOpenPosition => ({
  positionId: id,
  userId: user,
  side,
  size: amt('1'),
  entryPrice: amt('50000'),
  marginAsset: 'USDT',
});

describe('runFundingTick bound check precedes any freeze', () => {
  it('an over-bound first quote freezes neither the rate nor the membership', async () => {
    const base = memoryFundingPeriodStore();
    const frozenMembership: string[] = [];
    const periods = {
      ...base,
      async freezeMembership(periodId: string, candidates: readonly FundingOpenPosition[]) {
        frozenMembership.push(periodId);
        return base.freezeMembership(periodId, candidates);
      },
    };
    let rate = '5';
    const rates: FundingRateSource = {
      async quote({ marketId }) {
        return { rate, periodId: PERIOD, marketId };
      },
    };
    const posts: PostRequest[] = [];
    const ledger = {
      async post(req: PostRequest) {
        posts.push(req);
        return { id: `tx-${posts.length}`, idempotencyKey: req.idempotencyKey } as never;
      },
    };
    let open = [pos('p1', '11111111-1111-4111-8111-111111111111', 'long'), pos('p2', '22222222-2222-4222-8222-222222222222', 'short')];
    const deps = {
      rates,
      positions: { listOpenForMarket: async () => open },
      periods,
      margins: memoryFundingMarginApplier(),
      maxAbsRate: FIXTURE_MAX,
      ledger,
    };

    await expect(runFundingTick(deps, 'm1')).rejects.toMatchObject({ code: 'trade.funding_rate_exceeds_max' });
    expect(posts).toHaveLength(0);
    expect(frozenMembership).toEqual([]);

    // The publisher corrects the rate; a third position has opened meanwhile.
    rate = '0.0001';
    open = [...open, pos('p3', '33333333-3333-4333-8333-333333333333', 'long')];
    const result = await runFundingTick(deps, 'm1');
    expect(result.status).toBe('settled');
    const members = await periods.freezeMembership(PERIOD, []);
    expect(members.map((m) => m.positionId).sort()).toEqual(['p1', 'p2', 'p3']);
  });
});
