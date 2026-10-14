/**
 * THE GAP-SERIES PROOF.
 *
 * `DIRECTION-2026-07-31.md` §1, "what MVP done means for futures", item 5:
 *
 *   "Proven against a price series **that actually gaps** — not a smooth ramp. A
 *    liquidation engine that has only seen continuous prices is untested."
 *
 * and item 4:
 *
 *   "A gap that exceeds the position's margin drives the shortfall into the
 *    **insurance fund**, and the fund's balance moves by exactly the shortfall."
 *
 * The tracker row named this proof as unrun on 2026-08-08. This file runs it,
 * against the real `runLiquidationTick` rather than the planner alone, so the
 * mark gates, the deviation breaker, the position reducer and the ledger posts are
 * all in the path — every one of which can and does change the answer.
 *
 * WHAT IT DOES NOT PROVE, stated so nobody reads more into a green test than is
 * there: item 4 says the FUND'S BALANCE moves. This asserts the insurance LEG of
 * the posted recipe is exactly the shortfall. The balance-move proof is
 * `insurance-shortfall-balance.test.ts` (D26-P1-T1d) against MemoryLedger —
 * recipe unit alone cannot catch a tick that skips the post.
 */
import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount as amt, type AccountRef, type Amount, type Balance, type PostRequest } from '@intafaced/ledger-client';
import {
  memoryLiquidationAttemptStore,
  runLiquidationTick,
  type LiquidationPositionRow,
  type PositionReducer,
  type QuotedMarkSource,
} from './liquidation-tick.js';
import { memoryAcceptedMarkStore } from './accepted-mark.js';
import { sideDepthNotional } from './mark-from-depth.js';
import type { FuturesLadderPolicy } from './maintenance-ladder.js';
import { INSURANCE_UNDERFUNDED } from './insurance-bound.js';

const USER = '11111111-1111-4111-8111-111111111111';

/**
 * mm 500 bps flat, tranche ceiling at 25%. Flat so the series below is readable
 * by hand — the depth tiers have their own tests and would only make the walk
 * harder to check without testing anything this file is about.
 */
const POLICY: FuturesLadderPolicy = {
  tiers: [{ uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 500 }],
  marginCallBps: 12_000,
  targetBps: 15_000,
  maxTrancheBps: 2_500,
};

/** A mutable position row, so a partial rung actually shrinks something. */
function livePosition() {
  const row: LiquidationPositionRow = {
    positionId: 'pos-gap',
    userId: USER,
    side: 'long',
    size: amt('10'),
    entryPrice: amt('100'),
    margin: amt('100'), // 10× on a notional of 1 000
    marginAsset: 'USDT',
    marketId: 'm1',
    symbol: 'BTC/USDT-PERP',
  };
  let closed: { reason: string } | null = null;

  const reducer: PositionReducer = {
    async reduce(positionId, input) {
      expect(positionId).toBe(row.positionId);
      expect(input.sizeClosed).toBeLessThan(row.size);
      row.size -= input.sizeClosed;
      row.margin = input.marginRemaining;
    },
  };

  return {
    row,
    reducer,
    closer: {
      async markLiquidated(_id: string, meta: { liquidationId: string; reason: string }) {
        closed = { reason: meta.reason };
      },
    },
    positions: {
      async listOpen() {
        return closed ? [] : [row];
      },
    },
    get closed() {
      return closed;
    },
  };
}

function recordingLedger(opts?: { insuranceAvailable?: Amount }) {
  const posts: PostRequest[] = [];
  const insuranceAvailable = opts?.insuranceAvailable ?? amt('1000000');
  return {
    posts,
    ledger: {
      async post(req: PostRequest) {
        posts.push(req);
        return { id: `tx-${posts.length}`, idempotencyKey: req.idempotencyKey } as never;
      },
      async balance(ref: AccountRef): Promise<Balance> {
        // A position's collateral pot: ample, so the tick plans against the row's own margin (the ledger-pot
        // divergence guard takes min(row, pot)). The guard itself is proven in liquidation-rung-machine.test.ts ("divergence guard: the plan is taken against min(row margin, ledger pot)").
        const amount =
          ref.ownerType === 'house' && ref.ownerId === 'insurance-fund'
            ? insuranceAvailable
            : ref.kind === 'collateral'
              ? amt('1000000')
              : 0n;
        return { account: ref, accountId: `${ref.ownerType}:${ref.ownerId}`, amount };
      },
    },
  };
}

function markAt(price: string): QuotedMarkSource {
  return {
    async markPrice() {
      return price;
    },
    async quote({ marketId, at }) {
      return { marketId, price: amt(price), asOf: at, quality: 'mid' as const };
    },
  };
}

const deepBook = {
  async depthNotional() {
    return amt('1000000');
  },
};

/** Every recipe must balance: credits and debits sum to the same figure. */
function assertBalanced(req: PostRequest): void {
  let credits = 0n;
  let debits = 0n;
  for (const entry of req.entries) {
    if (entry.direction === 'credit') credits += entry.amount;
    else debits += entry.amount;
  }
  expect(formatAmount(credits)).toBe(formatAmount(debits));
}

function lossLegs(req: PostRequest): { fromMargin: Amount; fromInsurance: Amount } {
  const meta = req.meta as { fromMargin?: string; fromInsurance?: string } | undefined;
  return {
    fromMargin: BigInt(meta?.fromMargin ?? '0'),
    fromInsurance: BigInt(meta?.fromInsurance ?? '0'),
  };
}

describe('gap-series liquidation proof (DIRECTION §1 MVP items 4 and 5)', () => {
  it('walks a long down, takes partial rungs, then a GAP takes it bankrupt and the shortfall goes to insurance', async () => {
    const live = livePosition();
    const { ledger, posts } = recordingLedger();
    const attempts = memoryLiquidationAttemptStore();
    const acceptedMarks = memoryAcceptedMarkStore();

    /**
     * NOT A RAMP. 100 → 96 → 94 → 93 is a walk; 93 → 80 is a 14% GAP with no
     * tick in between, which is the whole point of item 5. It sits INSIDE the
     * 2 000 bps deviation breaker on purpose — a wider gap is refused rather than
     * traded through, and that case is its own test below.
     */
    const series = ['100', '96', '94', '93', '80'];
    const outcomes: string[] = [];

    for (const [index, price] of series.entries()) {
      const at = new Date(Date.UTC(2026, 7, 8, 0, index));
      const result = await runLiquidationTick({
        marks: markAt(price),
        positions: live.positions,
        closer: live.closer,
        attempts,
        acceptedMarks,
        ledger,
        now: () => at,
        ladder: { depth: deepBook, reducer: live.reducer, policy: POLICY },
      });
      outcomes.push(result.items[0]?.outcome ?? 'none-open');
    }

    // 100: untouched. 96: still above the margin call. 94 and 93: partial rungs.
    // 80: the gap — equity is gone, so the whole remainder closes.
    expect(outcomes).toEqual(['skipped_healthy', 'skipped_healthy', 'partially_liquidated', 'partially_liquidated', 'liquidated']);
    expect(live.closed).toMatchObject({ reason: 'bankrupt_full_close' });

    // ── Item 4, exactly ──────────────────────────────────────────────────────
    const losses = posts.filter((p) => p.reason === 'futures.loss.realized');
    expect(losses).toHaveLength(3);
    for (const post of posts) assertBalanced(post);

    const legs = losses.map(lossLegs);
    // The two partial rungs are covered entirely by margin. Only the gap reaches
    // the fund, and it reaches it for the shortfall and not a unit more.
    expect(legs[0]!.fromInsurance).toBe(0n);
    expect(legs[1]!.fromInsurance).toBe(0n);
    expect(legs[2]!.fromInsurance).toBeGreaterThan(0n);

    // Margin is finite and the engine never draws past it.
    const drawnFromMargin = legs.reduce((total, leg) => total + leg.fromMargin, 0n);
    expect(formatAmount(drawnFromMargin)).toBe('100');

    // The shortfall IS the negative equity at the moment of the gap, to the unit:
    // margin 71.875 backing 5.625 contracts that are 20 underwater = 112.5 of
    // loss against 71.875 of margin.
    expect(formatAmount(legs[2]!.fromMargin)).toBe('71.875');
    expect(formatAmount(legs[2]!.fromInsurance)).toBe('40.625');

    // Nothing was released to the trader — every unit of margin went to the loss.
    expect(posts.filter((p) => p.reason === 'futures.margin.release')).toHaveLength(0);
  });

  it('a gap PAST the deviation breaker is not traded through — the position sits', async () => {
    const live = livePosition();
    const { ledger, posts } = recordingLedger();
    const attempts = memoryLiquidationAttemptStore();
    const acceptedMarks = memoryAcceptedMarkStore();

    // First tick establishes the basis at 100. Then a 40% gap.
    for (const [index, price] of ['100', '60'].entries()) {
      const at = new Date(Date.UTC(2026, 7, 8, 1, index));
      const result = await runLiquidationTick({
        marks: markAt(price),
        positions: live.positions,
        closer: live.closer,
        attempts,
        acceptedMarks,
        ledger,
        now: () => at,
        ladder: { depth: deepBook, reducer: live.reducer, policy: POLICY },
      });
      if (index === 1) expect(result.items[0]?.outcome).toBe('skipped_mark_unusable');
    }

    expect(posts).toHaveLength(0);
    expect(live.closed).toBeNull();
    expect(formatAmount(live.row.size)).toBe('10');
  });

  it('refuses to rate a position against a book it could not read, rather than assuming the worst tier', async () => {
    const live = livePosition();
    const { ledger, posts } = recordingLedger();
    const result = await runLiquidationTick({
      marks: markAt('94'),
      positions: live.positions,
      closer: live.closer,
      attempts: memoryLiquidationAttemptStore(),
      acceptedMarks: memoryAcceptedMarkStore(),
      ledger,
      ladder: {
        depth: {
          async depthNotional() {
            return null;
          },
        },
        reducer: live.reducer,
        policy: POLICY,
      },
    });

    expect(result.items[0]).toMatchObject({ outcome: 'skipped_no_depth', reason: 'trade.depth_unknown' });
    expect(posts).toHaveLength(0);
    expect(formatAmount(live.row.size)).toBe('10');
  });

  it('without a ladder, omitted maintenanceBps does not invent a 50% full-close', async () => {
    const live = livePosition();
    const { ledger, posts } = recordingLedger();
    const result = await runLiquidationTick({
      marks: markAt('94'),
      positions: live.positions,
      closer: live.closer,
      attempts: memoryLiquidationAttemptStore(),
      acceptedMarks: memoryAcceptedMarkStore(),
      ledger,
    });

    // Mark 94 / entry 100 / margin 100: equity is still positive. Missing
    // ladder must refuse — never flatten via the legacy full-close planner.
    expect(result.liquidated).toBe(0);
    expect(result.items[0]).toMatchObject({
      outcome: 'skipped_d3_unset',
      reason: 'trade.ladder_unset',
    });
    expect(live.closed).toBeNull();
    expect(posts).toHaveLength(0);
  });

  /**
   * UNIT 10 on the ladder path — bankrupt gap with empty insurance parks.
   * Walks partial rungs (no insurance) then the gap that would invent cover:
   * no insurance leg posts, position not falsely liquidated.
   */
  it('empty insurance fund parks the bankrupt gap — partial rungs still work, gap does not invent cover', async () => {
    const live = livePosition();
    const { ledger, posts } = recordingLedger({ insuranceAvailable: 0n });
    const attempts = memoryLiquidationAttemptStore();
    const acceptedMarks = memoryAcceptedMarkStore();
    const series = ['100', '96', '94', '93', '80'];
    const outcomes: string[] = [];

    for (const [index, price] of series.entries()) {
      const at = new Date(Date.UTC(2026, 7, 8, 2, index));
      const result = await runLiquidationTick({
        marks: markAt(price),
        positions: live.positions,
        closer: live.closer,
        attempts,
        acceptedMarks,
        ledger,
        now: () => at,
        ladder: { depth: deepBook, reducer: live.reducer, policy: POLICY },
      });
      outcomes.push(result.items[0]?.outcome ?? 'none-open');
    }

    expect(outcomes).toEqual([
      'skipped_healthy',
      'skipped_healthy',
      'partially_liquidated',
      'partially_liquidated',
      'skipped_insurance_underfunded',
    ]);
    expect(live.closed).toBeNull();
    expect(formatAmount(live.row.size)).not.toBe('0');

    const losses = posts.filter((p) => p.reason === 'futures.loss.realized');
    // Only the two partial (margin-only) rungs — never the insurance shortfall post.
    expect(losses).toHaveLength(2);
    for (const leg of losses.map(lossLegs)) {
      expect(leg.fromInsurance).toBe(0n);
    }
    expect(outcomes[4]).toBe('skipped_insurance_underfunded');
    // Silence unused import guard when test file only uses the constant in expect paths.
    expect(INSURANCE_UNDERFUNDED).toBe('trade.insurance_underfunded');
  });
});

describe('sideDepthNotional', () => {
  const book = {
    bids: [
      ['100', '5'],
      ['99', '10'],
    ] as ReadonlyArray<readonly [string, string]>,
    asks: [['101', '1']] as ReadonlyArray<readonly [string, string]>,
    sequence: 1,
  };

  it('reads the side a position must be CLOSED into, not a symmetric figure', () => {
    // A long sells into the bids: 100×5 + 99×10 = 1 490.
    expect(formatAmount(sideDepthNotional(book, 'long')!)).toBe('1490');
    // A short buys from the asks: 101×1 = 101.
    expect(formatAmount(sideDepthNotional(book, 'short')!)).toBe('101');
  });

  it('treats a side made of dust as absent, on the same floor that governs the mid', () => {
    const dust = { bids: [['100', '0.000000000000000001']] as ReadonlyArray<readonly [string, string]>, asks: [], sequence: 1 };
    expect(sideDepthNotional(dust, 'long')).toBeNull();
  });

  it('returns null rather than zero for an empty or missing book', () => {
    expect(sideDepthNotional(null, 'long')).toBeNull();
    expect(sideDepthNotional({ bids: [], asks: [], sequence: 0 }, 'short')).toBeNull();
  });
});
