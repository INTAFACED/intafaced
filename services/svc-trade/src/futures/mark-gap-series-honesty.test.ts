/**
 * D26-P1-T1e / DIRECTION §1 MVP item 5 — Gap price series proof.
 *
 * Done bar: Proven on a **gapping** series, not a smooth ramp.
 *
 * What this proves that `ladder-gap-series.test.ts` does not:
 *   · Marks are minted by `markSourceFromDepth` from EngineDepth books whose
 *     mid actually gaps — not `markAt(string)` that bypasses the depth mid
 *     path. A regression that invents mids, smooths the book, or skips the
 *     relative size floor cannot green here while the injected-price suite
 *     stays green.
 *   · Depth for the ladder is the SAME book via `depthNotionalSourceFromDepth`
 *     (production adapter), not a constant `depthNotional()` stub.
 *   · A smooth ramp covering the same start→end bankrupts earlier with a
 *     different insurance shortfall — so a ramp-only suite cannot stand in
 *     for the gap proof.
 *
 * No invent marks: every price is mid-of-book from resting levels. Ladder
 * tier numbers reuse the flat harness from the gap-series file (readable by
 * hand; depth tiers have their own tests).
 */
import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount as amt, type AccountRef, type Amount, type Balance, type PostRequest } from '@intafaced/ledger-client';
import { memoryAcceptedMarkStore } from './accepted-mark.js';
import { depthNotionalSourceFromDepth, markSourceFromDepth } from './mark-from-depth.js';
import type { EngineDepth } from '../spot/matching-client.js';
import type { FuturesLadderPolicy } from './maintenance-ladder.js';
import {
  memoryLiquidationAttemptStore,
  runLiquidationTick,
  type LiquidationPositionRow,
  type PositionReducer,
} from './liquidation-tick.js';
import { midFromBook } from './mark-source.js';

const USER = '11111111-1111-4111-8111-111111111111';

/** Flat mm 500 bps — same readable harness as ladder-gap-series.test.ts. */
const POLICY: FuturesLadderPolicy = {
  tiers: [{ uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 500 }],
  marginCallBps: 12_000,
  targetBps: 15_000,
  maxTrancheBps: 2_500,
};

/**
 * Two-sided book whose mid is exactly `mid` (bid = mid-1, ask = mid+1).
 * Size clears absolute + relative dust floors for a 10-contract position and
 * supplies deep close-into depth for the ladder.
 */
function bookAtMid(mid: number, sequence: number, observedAt: Date): EngineDepth & { observedAt: Date } {
  const bid = String(mid - 1);
  const ask = String(mid + 1);
  return {
    bids: [
      [bid, '10000'],
      [String(mid - 2), '2000'],
    ],
    asks: [
      [ask, '10000'],
      [String(mid + 2), '2000'],
    ],
    sequence,
    observedAt,
  };
}

function livePosition() {
  const row: LiquidationPositionRow = {
    positionId: 'pos-mark-gap',
    userId: USER,
    side: 'long',
    size: amt('10'),
    entryPrice: amt('100'),
    margin: amt('100'),
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
        // A position's collateral pot is ample, so the tick plans against the row's own margin (divergence guard: min(row, pot)).
        const amount =
          ref.ownerType === 'house' && ref.ownerId === 'insurance-fund'
            ? insuranceAvailable
            : ref.kind === 'collateral'
              ? 1_000_000n * 10n ** 18n
              : 0n;
        return { account: ref, accountId: `${ref.ownerType}:${ref.ownerId}`, amount };
      },
    },
  };
}

function lossLegs(req: PostRequest): { fromMargin: Amount; fromInsurance: Amount } {
  const meta = req.meta as { fromMargin?: string; fromInsurance?: string } | undefined;
  return {
    fromMargin: BigInt(meta?.fromMargin ?? '0'),
    fromInsurance: BigInt(meta?.fromInsurance ?? '0'),
  };
}

function assertBalanced(req: PostRequest): void {
  let credits = 0n;
  let debits = 0n;
  for (const entry of req.entries) {
    if (entry.direction === 'credit') credits += entry.amount;
    else debits += entry.amount;
  }
  expect(formatAmount(credits)).toBe(formatAmount(debits));
}

/** Deviation in bps between two positive decimal mid strings (integer, round half up). */
function deviationBps(from: string, to: string): number {
  const a = amt(from);
  const b = amt(to);
  const diff = b > a ? b - a : a - b;
  return Number((diff * 10_000n + a / 2n) / a);
}

async function walkSeries(mids: number[], hour: number) {
  const live = livePosition();
  const { ledger, posts } = recordingLedger();
  const attempts = memoryLiquidationAttemptStore();
  const acceptedMarks = memoryAcceptedMarkStore();
  let book = bookAtMid(mids[0]!, 1, new Date(Date.UTC(2026, 7, 12, hour, 0)));
  const readDepth = async () => book;
  const marks = markSourceFromDepth(readDepth);
  const depth = depthNotionalSourceFromDepth(readDepth);
  const outcomes: string[] = [];
  const observedMids: string[] = [];

  for (const [index, mid] of mids.entries()) {
    const at = new Date(Date.UTC(2026, 7, 12, hour, index));
    book = bookAtMid(mid, index + 1, at);
    const minted = midFromBook(book.bids[0]![0], book.asks[0]![0]);
    expect(minted).toBe(String(mid));
    observedMids.push(minted!);
    const result = await runLiquidationTick({
      marks,
      positions: live.positions,
      closer: live.closer,
      attempts,
      acceptedMarks,
      ledger,
      now: () => at,
      ladder: { depth, reducer: live.reducer, policy: POLICY },
    });
    outcomes.push(result.items[0]?.outcome ?? 'none-open');
  }

  return { live, posts, outcomes, observedMids };
}

describe('D26-P1-T1e mark/liq honesty on a gapping depth series (MVP-5)', () => {
  it('mids the book — never invents — and a 14% gap bankrupts with insurance shortfall', async () => {
    /**
     * NOT A RAMP. 100 → 96 → 94 → 93 is a walk; 93 → 80 is a 14% GAP with no
     * tick in between (DIRECTION §1 item 5). Inside the 2 000 bps breaker on
     * purpose — over-breaker refusal is the next test.
     */
    const series = [100, 96, 94, 93, 80];
    const { live, posts, outcomes, observedMids } = await walkSeries(series, 0);

    expect(observedMids).toEqual(['100', '96', '94', '93', '80']);
    // The gap step itself: ≥ 1 000 bps so a ramp-only suite cannot claim this.
    expect(deviationBps('93', '80')).toBeGreaterThanOrEqual(1_000);

    expect(outcomes).toEqual(['skipped_healthy', 'skipped_healthy', 'partially_liquidated', 'partially_liquidated', 'liquidated']);
    expect(live.closed).toMatchObject({ reason: 'bankrupt_full_close' });

    const losses = posts.filter((p) => p.reason === 'futures.loss.realized');
    expect(losses).toHaveLength(3);
    for (const post of posts) assertBalanced(post);

    const legs = losses.map(lossLegs);
    expect(legs[0]!.fromInsurance).toBe(0n);
    expect(legs[1]!.fromInsurance).toBe(0n);
    expect(legs[2]!.fromInsurance).toBeGreaterThan(0n);

    const drawnFromMargin = legs.reduce((total, leg) => total + leg.fromMargin, 0n);
    expect(formatAmount(drawnFromMargin)).toBe('100');
    expect(formatAmount(legs[2]!.fromMargin)).toBe('71.875');
    expect(formatAmount(legs[2]!.fromInsurance)).toBe('40.625');
    expect(posts.filter((p) => p.reason === 'futures.margin.release')).toHaveLength(0);
  });

  it('a smooth ramp over the same start→end is NOT the gap proof — no gap step, no gap shortfall', async () => {
    /**
     * Same 100→80 span, one unit per tick. Consecutive steps stay well under
     * 1 000 bps. Partials along the way can shrink the long enough that equity
     * never crosses zero the way the 93→80 discontinuity does — so this ramp
     * never posts the gap-series insurance shortfall of 40.625. A suite that
     * only ran the ramp would not prove MVP-5.
     */
    const ramp: number[] = [];
    for (let m = 100; m >= 80; m -= 1) ramp.push(m);

    for (let i = 1; i < ramp.length; i++) {
      expect(deviationBps(String(ramp[i - 1]), String(ramp[i]))).toBeLessThan(500);
    }

    const { posts, outcomes, observedMids } = await walkSeries(ramp, 1);

    // No step on the ramp is a gap (≥ 1 000 bps) into a full liquidation.
    for (let i = 1; i < outcomes.length; i++) {
      if (outcomes[i] === 'liquidated') {
        expect(deviationBps(observedMids[i - 1]!, observedMids[i]!)).toBeLessThan(1_000);
      }
    }

    const losses = posts.filter((p) => p.reason === 'futures.loss.realized');
    const insuranceAmounts = losses.map(lossLegs).map((l) => formatAmount(l.fromInsurance));
    expect(insuranceAmounts).not.toContain('40.625');
  });

  it('a depth-derived gap PAST the deviation breaker is not traded through', async () => {
    const live = livePosition();
    const { ledger, posts } = recordingLedger();
    const attempts = memoryLiquidationAttemptStore();
    const acceptedMarks = memoryAcceptedMarkStore();
    let book = bookAtMid(100, 1, new Date(Date.UTC(2026, 7, 12, 2, 0)));
    const readDepth = async () => book;
    const marks = markSourceFromDepth(readDepth);
    const depth = depthNotionalSourceFromDepth(readDepth);

    for (const [index, mid] of [100, 60].entries()) {
      const at = new Date(Date.UTC(2026, 7, 12, 2, index));
      book = bookAtMid(mid, index + 1, at);
      expect(midFromBook(book.bids[0]![0], book.asks[0]![0])).toBe(String(mid));
      const result = await runLiquidationTick({
        marks,
        positions: live.positions,
        closer: live.closer,
        attempts,
        acceptedMarks,
        ledger,
        now: () => at,
        ladder: { depth, reducer: live.reducer, policy: POLICY },
      });
      if (index === 1) expect(result.items[0]?.outcome).toBe('skipped_mark_unusable');
    }

    expect(deviationBps('100', '60')).toBeGreaterThan(2_000);
    expect(posts).toHaveLength(0);
    expect(live.closed).toBeNull();
    expect(formatAmount(live.row.size)).toBe('10');
  });

  it('refuses to mint a mid from a one-sided or dust book rather than inventing through the gap', async () => {
    const live = livePosition();
    const { ledger, posts } = recordingLedger();
    const dust: EngineDepth = {
      bids: [['80', '0.000000000000000001']],
      asks: [['81', '0.000000000000000001']],
      sequence: 1,
    };
    const marks = markSourceFromDepth(async () => dust);
    const depth = depthNotionalSourceFromDepth(async () => dust);

    const result = await runLiquidationTick({
      marks,
      positions: live.positions,
      closer: live.closer,
      attempts: memoryLiquidationAttemptStore(),
      acceptedMarks: memoryAcceptedMarkStore(),
      ledger,
      now: () => new Date(Date.UTC(2026, 7, 12, 3, 0)),
      ladder: { depth, reducer: live.reducer, policy: POLICY },
    });

    expect(result.items[0]?.outcome).toBe('skipped_no_mark');
    expect(posts).toHaveLength(0);
    expect(live.closed).toBeNull();
  });
});
