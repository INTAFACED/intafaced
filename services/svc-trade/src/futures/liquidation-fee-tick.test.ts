/** D-margin-07: each new rung records its fee decision; nothing is charged. TEST figures only. Harness copied from liquidation-rung-machine.test.ts. */
/**
 * A LIQUIDATION RUNG IS A STATE MACHINE ON ONE POSITION ROW.
 *
 * Every test below is a reproduced money defect (or its neighbour) from the
 * review of the first stored-plan attempt. The harness models what the real
 * ledger will soon enforce: a reused idempotency key carrying a DIFFERENT body is
 * refused, so a rung that is re-planned at a new mark wedges instead of
 * silently double-booking.
 *
 * The memory rung store models the SQL store's lock semantic (each of `begin` /
 * `apply` is one atomic step), so interleaved ticks here meet the outcomes
 * Postgres produces; `liquidation-rung-store.pg.test.ts` runs the same laws
 * against a real database.
 */
import { describe, expect, it } from 'vitest';
import {
  formatAmount,
  InsufficientFundsError,
  parseAmount as amt,
  type AccountRef,
  type Amount,
  type PostRequest,
} from '@intafaced/ledger-client';
import { memoryAcceptedMarkStore } from './accepted-mark.js';
import {
  ABANDONED_PARKED,
  memoryLiquidationAttemptStore,
  runLiquidationTick,
  feeLeftoverCollateral,
  rungFeeDecision,
  type LiquidationPositionRow,
  type LiquidationTickDeps,
} from './liquidation-tick.js';
import { REALIZED_LOSS_REASON, reconcileRungsToLedger, type InsuranceCredit, type LedgerLossTx } from './liquidation-reconcile.js';
import { decodeRungPlan, encodeRungPlan, memoryLiquidationRungStore, type RungPlan, type RungRowBook } from './liquidation-rungs.js';

const USER = '11111111-1111-4111-8111-111111111111';
const AT = new Date('2026-08-12T14:00:00.000Z');
const WIDE_POLICY = {
  tiers: [
    { uptoDepthBps: 500, maintenanceBps: 500 },
    { uptoDepthBps: 5_000, maintenanceBps: 800 },
    { uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 1_500 },
  ],
  marginCallBps: 12_000,
  targetBps: 15_000,
  maxTrancheBps: 10_000,
};

const body = (req: PostRequest) => JSON.stringify(req, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));

function harness(opts: { insurance?: Amount; pot?: Amount } = {}) {
  const row = {
    positionId: 'pos-1',
    userId: USER,
    side: 'long' as const,
    size: amt('10'),
    entryPrice: amt('100'),
    margin: amt('100'),
    marginAsset: 'USDT',
    marketId: 'm1',
    symbol: 'BTC/USDT-PERP',
    status: 'open' as 'open' | 'liquidated',
  };
  const price = { current: '93' };
  const insurance = { available: opts.insurance ?? amt('1000000') };
  /** The position's collateral pot, as the ledger sees it. */
  const pot = { amount: opts.pot ?? amt('1000000') };
  const posts: PostRequest[] = [];
  const booked = new Map<string, PostRequest>();
  const reduces: { sizeClosed: string; marginRemaining: string }[] = [];
  const announced: string[] = [];
  const hooks: { beforePost?: (req: PostRequest) => void | Promise<void>; balance?: (ref: AccountRef) => Amount | undefined } = {};

  const book: RungRowBook = {
    read: (id) => (id === row.positionId ? { status: row.status, size: row.size, margin: row.margin } : null),
    reduce: (_id, closed, newMargin) => {
      reduces.push({ sizeClosed: formatAmount(closed), marginRemaining: formatAmount(newMargin) });
      row.size -= closed;
      row.margin = newMargin;
    },
    close: () => {
      row.status = 'liquidated';
    },
  };
  const rungs = memoryLiquidationRungStore(book);
  const attempts = memoryLiquidationAttemptStore();
  let n = 0;

  const snapshot = (): LiquidationPositionRow => {
    const { status: _s, ...rest } = row;
    return { ...rest };
  };
  const deps: LiquidationTickDeps = {
    marks: {
      async markPrice() {
        return price.current;
      },
      async quote({ marketId, symbol, at }) {
        return { marketId, symbol, price: amt(price.current), asOf: at, quality: 'mid' };
      },
    },
    positions: {
      async listOpen() {
        return row.status === 'open' ? [snapshot()] : [];
      },
    },
    closer: {
      async markLiquidated() {
        throw new Error('the rung path closes the row inside apply, never through markLiquidated');
      },
      async announceLiquidated(id) {
        announced.push(id);
      },
    },
    attempts,
    rungs,
    newRungId: () => `rung-${++n}`,
    acceptedMarks: memoryAcceptedMarkStore(),
    ledger: {
      async post(req) {
        await hooks.beforePost?.(req);
        // The real ledger refuses an insurance leg the fund cannot cover.
        const insuranceLeg = req.entries.find(
          (e) => e.direction === 'credit' && e.account.ownerType === 'house' && e.account.ownerId === 'insurance-fund',
        );
        if (insuranceLeg && !booked.has(req.idempotencyKey) && insuranceLeg.amount > insurance.available) {
          throw new InsufficientFundsError(
            'house:insurance-fund',
            'USDT',
            formatAmount(insuranceLeg.amount),
            formatAmount(insurance.available),
          );
        }
        // A recipe can only take out of the pot what the pot holds (the real ledger's non-negative CHECK).
        const potTake = req.entries
          .filter((e) => e.direction === 'credit' && e.account.kind === 'collateral')
          .reduce((sum, e) => sum + e.amount, 0n);
        const firstTime = !booked.has(req.idempotencyKey);
        if (potTake > 0n && firstTime && potTake > pot.amount) {
          throw new InsufficientFundsError('user:position-pot', 'USDT', formatAmount(potTake), formatAmount(pot.amount));
        }
        if (firstTime) pot.amount -= potTake;
        posts.push(req);
        const old = booked.get(req.idempotencyKey);
        if (old && body(old) !== body(req)) {
          throw Object.assign(new Error(`idempotency key ${req.idempotencyKey} reused with a different body`), {
            code: 'ledger.idempotency_conflict',
          });
        }
        booked.set(req.idempotencyKey, req);
        return { id: `tx:${req.idempotencyKey}`, idempotencyKey: req.idempotencyKey } as never;
      },
      async balance(ref: AccountRef) {
        const override = hooks.balance?.(ref);
        if (override !== undefined) return { account: ref, accountId: 'x', amount: override };
        const amount =
          ref.ownerType === 'house' && ref.ownerId === 'insurance-fund'
            ? insurance.available
            : ref.kind === 'collateral'
              ? pot.amount
              : amt('1000000');
        return { account: ref, accountId: 'x', amount };
      },
      // The production client cannot answer this (services/svc-trade/src/ledger-client.ts). Nothing may ask.
      async getTxByKey() {
        throw new Error('getTxByKey is not exposed over the internal ledger API — query svc-ledger directly');
      },
    } as LiquidationTickDeps['ledger'],
    now: () => AT,
    ladder: {
      depth: {
        async depthNotional() {
          return amt('1114000');
        },
      },
      policy: WIDE_POLICY,
      reducer: {
        async reduce() {
          throw new Error('the rung path reduces the row inside apply, never through the reducer port');
        },
      },
    },
  };
  /** Total margin the ledger took out of the position's collateral pot. */
  const marginTaken = () =>
    [...booked.values()]
      .filter((p) => p.reason === 'futures.loss.realized')
      .reduce(
        (sum, p) =>
          sum + p.entries.filter((e) => e.direction === 'credit' && e.account.ownerType === 'user').reduce((s, e) => s + e.amount, 0n),
        0n,
      );
  const lossKeys = () => [...booked.keys()].filter((k) => k.startsWith('futures.loss:'));
  return { deps, row, price, posts, booked, reduces, announced, hooks, rungs, attempts, marginTaken, lossKeys, snapshot, insurance, pot };
}

describe('rung fee decision (D-margin-07)', () => {
  it('fraction unset → the rung stores fee_unset; no fee recipe posts; the loss posts as before', async () => {
    const h = harness();
    const t = await runLiquidationTick({ ...h.deps, liquidationFeeFraction: null });
    expect(t.items.map((i) => i.outcome)).toEqual(['partially_liquidated']);
    const plan = h.rungs.all()[0]!.plan;
    expect(plan.feeState).toBe('fee_unset');
    expect(plan.plannedFee).toBeUndefined();
    expect(plan.fee).toBeUndefined();
    expect([...h.booked.keys()].some((k) => k.includes(':fee'))).toBe(false);
  });

  it('fraction set (TEST) → the rung stores ledger_job_pending with the planned fee; still nothing is charged', async () => {
    const h = harness();
    const t = await runLiquidationTick({ ...h.deps, liquidationFeeFraction: amt('0.001') });
    expect(t.items.map((i) => i.outcome)).toEqual(['partially_liquidated']);
    const plan = h.rungs.all()[0]!.plan;
    expect(plan.feeState).toBe('ledger_job_pending');
    expect(plan.plannedFee).toBeGreaterThan(0n);
    expect(plan.plannedFee! <= plan.marginRemaining).toBe(true);
    expect(plan.fee).toBeUndefined();
    expect([...h.booked.keys()].some((k) => k.includes(':fee'))).toBe(false);
  });

  it('the same posts happen with and without a fee decision (the plan recipes are unchanged)', async () => {
    const a = harness();
    await runLiquidationTick(a.deps);
    const b = harness();
    await runLiquidationTick({ ...b.deps, liquidationFeeFraction: amt('0.001') });
    expect([...b.booked.keys()]).toEqual([...a.booked.keys()]);
    expect(a.rungs.all()[0]!.plan.feeState).toBeUndefined();
  });

  it('a CLOSING rung decision (marginRemaining 0, leftover in residualRelease) plans a non-zero fee from that leftover (TEST)', () => {
    // The shared harness ladder never produces a solvent full close, so this drives the exact composition the
    // tick uses (rungFeeDecision over feeLeftoverCollateral) with a closing-shaped decision.
    const closing = { marginRemaining: 0n, residualRelease: amt('40') };
    expect(rungFeeDecision(amt('0.001'), 'rung-1', amt('10'), amt('94'), feeLeftoverCollateral(closing))).toEqual({
      feeState: 'ledger_job_pending',
      plannedFee: amt('0.94'),
    });
    // Before the fix the tick passed marginRemaining alone: the fee was capped to zero on every closing rung.
    expect(rungFeeDecision(amt('0.001'), 'rung-1', amt('10'), amt('94'), closing.marginRemaining)).toEqual({
      feeState: 'ledger_job_pending',
      plannedFee: 0n,
    });
  });

  it('a SOLVENT closing rung from a real tick plans min(fraction × notional, leftover) from the residual release (TEST)', async () => {
    // Full maintenance and a target so high no partial keep (not even one attounit) restores it on this tiny
    // equity: largestRestoringKeep returns 0 on a SOLVENT position, so the ladder closes in full with margin
    // left over (TEST policy, not a production table).
    const h = harness();
    h.row.margin = amt('100.00001');
    h.deps.ladder!.policy = {
      tiers: [{ uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 10_000 }],
      marginCallBps: 20_000,
      targetBps: 9_000_000_000_000_000,
      maxTrancheBps: 10_000,
    };
    h.price.current = '90';
    const t = await runLiquidationTick({ ...h.deps, liquidationFeeFraction: amt('0.001') });
    const r = h.rungs.all()[0]!;
    expect(t.items.map((i) => i.outcome)).toEqual(['liquidated']);
    expect(r.kind).toBe('closing');
    // 10 × 90 = 900 notional; fraction 0.001 → 0.9, above the 0.00001 left after the 100 loss, so the fee is
    // min(0.9, residualRelease) = 0.00001 — non-zero. With the old marginRemaining-only input this was 0n.
    expect(r.plan).toMatchObject({ feeState: 'ledger_job_pending', plannedFee: amt('0.00001') });
  });

  it('a bankrupt closing rung from the tick (no leftover) plans a zero fee, never negative', async () => {
    const h = harness();
    h.price.current = '60';
    const t = await runLiquidationTick({ ...h.deps, liquidationFeeFraction: amt('0.001') });
    expect(t.items.map((i) => i.outcome)).toEqual(['liquidated']);
    const r = h.rungs.all()[0]!;
    expect(r.kind).toBe('closing');
    expect(r.plan).toMatchObject({ feeState: 'ledger_job_pending', plannedFee: 0n });
  });

  it('feeLeftoverCollateral: closing uses residualRelease, partial uses marginRemaining', () => {
    expect(feeLeftoverCollateral({ marginRemaining: 0n, residualRelease: amt('40') })).toBe(amt('40'));
    expect(feeLeftoverCollateral({ marginRemaining: amt('60'), residualRelease: 0n })).toBe(amt('60'));
  });

  it('rungFeeDecision: planned fee is capped at leftover collateral, and omitted fraction records nothing', () => {
    expect(rungFeeDecision(undefined, 'r', amt('1'), amt('100'), amt('5'))).toEqual({});
    expect(rungFeeDecision(null, 'r', amt('1'), amt('100'), amt('5'))).toEqual({ feeState: 'fee_unset' });
    expect(rungFeeDecision(amt('0.5'), 'r', amt('1'), amt('100'), amt('5'))).toEqual({
      feeState: 'ledger_job_pending',
      plannedFee: amt('5'),
    });
    expect(rungFeeDecision(amt('0.01'), 'r', amt('1'), amt('100'), amt('5'))).toEqual({
      feeState: 'ledger_job_pending',
      plannedFee: amt('1'),
    });
  });
});
