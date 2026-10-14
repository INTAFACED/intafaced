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
      // The production client CAN answer this now (the shared client chains txByKey to txById), but the rung machine must
      // not ask: a replay is settled by the stored plan and the idempotent post keys, and a lookup is an extra ledger round
      // trip inside the tick. This stub keeps that pinned.
      async getTxByKey() {
        throw new Error('the liquidation rung machine must not call getTxByKey: replays rely on the stored plan and the post keys');
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

const show = (t: { items: { outcome: string; reason: string }[] }) => t.items.map((i) => `${i.outcome}/${i.reason}`).join(',');

describe('rung state machine: one tick, happy path', () => {
  it('a partial rung posts keys that carry the rung id, then reduces the row and applies the rung', async () => {
    const h = harness();
    const t = await runLiquidationTick(h.deps);
    expect(t.items.map((i) => i.outcome)).toEqual(['partially_liquidated']);
    expect(t.partial).toBe(1);
    expect(h.lossKeys()).toEqual(['futures.loss:liq:pos-1:rung:rung-1:loss']);
    expect(h.reduces).toHaveLength(1);
    expect(h.rungs.all().map((r) => r.state)).toEqual(['applied']);
    expect(await h.attempts.isDone('liq:pos-1')).toBe(false); // a partial never claims the lifecycle id
  });

  it('a closing rung carries the rung id in BOTH keys, closes inside apply, then marks done and announces', async () => {
    const h = harness();
    h.price.current = '60';
    const t = await runLiquidationTick(h.deps);
    expect(t.items.map((i) => i.outcome)).toEqual(['liquidated']);
    expect([...h.booked.keys()].sort()).toEqual([
      'futures.loss:liq:pos-1:rung:rung-1:loss',
      ...(h.booked.has('futures.margin.release:pos-1:rung:rung-1') ? ['futures.margin.release:pos-1:rung:rung-1'] : []),
    ]);
    expect(h.row.status).toBe('liquidated');
    expect(await h.attempts.isDone('liq:pos-1')).toBe(true);
    expect(h.announced).toEqual(['pos-1']);
  });
});

describe('probe A: a stale unfinished plan must never cut a healthy position', () => {
  it('crash AFTER the row moved (apply committed, tick died): regrow to the same size, healthy mark → untouched, nothing posted', async () => {
    const h = harness();
    const realApply = h.rungs.apply;
    let crash = true;
    h.rungs.apply = async (...args) => {
      const r = await realApply(...args);
      if (crash) {
        crash = false;
        throw new Error('died after the apply commit, before the tick returned');
      }
      return r;
    };
    const t1 = await runLiquidationTick(h.deps);
    expect(show(t1)).toBe('errored/trade.liquidation_tick_error');
    expect(h.reduces).toHaveLength(1);
    const postsAfterT1 = h.posts.length;

    // The trader tops the position back up to 10 and the mark recovers.
    h.row.size = amt('10');
    h.row.margin = amt('100');
    h.price.current = '97';
    const t2 = await runLiquidationTick(h.deps);
    expect(t2.items.map((i) => i.outcome)).toEqual(['skipped_healthy']);
    expect(h.posts.length).toBe(postsAfterT1);
    expect(h.reduces).toHaveLength(1);
    expect(h.row.size).toBe(amt('10'));
  });

  it('crash AFTER posting, BEFORE the row moved, then the mark recovers: the booked loss is still owed, and the row catches up by it', async () => {
    const h = harness();
    const realApply = h.rungs.apply;
    let crash = true;
    h.rungs.apply = async (...args) => {
      if (crash) {
        crash = false;
        throw new Error('died after the posts, before apply');
      }
      return realApply(...args);
    };
    await runLiquidationTick(h.deps);
    const firstBodies = h.posts.map(body);
    expect(h.reduces).toHaveLength(0);
    expect(h.row.size).toBe(amt('10')); // the ledger took margin; the row has not moved

    h.price.current = '120'; // healthy now — a re-decision would skip and leave the books disagreeing
    const t2 = await runLiquidationTick(h.deps);
    expect(t2.items.map((i) => i.outcome)).toEqual(['partially_liquidated']);
    expect(h.reduces).toHaveLength(1);
    expect(h.marginTaken()).toBe(amt('100') - h.row.margin); // ledger and row agree
    expect(h.lossKeys()).toHaveLength(1);
    // Nothing re-posted (state was already 'posted'), and in any case never a different body.
    expect(h.posts.map(body)).toEqual(firstBodies);
  });

  it('crash after the posts but before the rung is marked posted, replay at a DIFFERENT mark: the stored bodies post again, byte for byte (no idempotency conflict)', async () => {
    const h = harness();
    const realMarkPosted = h.rungs.markPosted;
    let crash = true;
    h.rungs.markPosted = async (id) => {
      if (crash) {
        crash = false;
        throw new Error('died between the last post and markPosted');
      }
      return realMarkPosted(id);
    };
    await runLiquidationTick(h.deps);
    expect((await h.rungs.findLive('pos-1'))!.state).toBe('planned');
    const first = h.posts.map(body);
    h.price.current = '91'; // a plan made fresh at this mark would carry different amounts
    const t2 = await runLiquidationTick(h.deps);
    expect(t2.items[0]!.outcome).toBe('partially_liquidated');
    expect(h.posts.map(body).slice(0, first.length)).toEqual(first);
    expect(h.posts.length).toBeGreaterThan(first.length); // it did post again, and the ledger accepted it
    expect(h.lossKeys()).toHaveLength(1);
    expect(h.reduces).toHaveLength(1);
  });

  it('a rung that crashed before anything booked (planned) posts its STORED bodies at a different mark, not a re-plan', async () => {
    const h = harness();
    h.price.current = '60';
    h.hooks.beforePost = () => {
      throw new Error('died before the first post landed');
    };
    const t1 = await runLiquidationTick(h.deps);
    expect(show(t1)).toBe('errored/trade.liquidation_tick_error');
    const planned = (await h.rungs.findLive('pos-1'))!;
    expect(planned.state).toBe('planned');

    h.hooks.beforePost = undefined;
    h.price.current = '55'; // a re-plan would change fromInsurance; the stored plan must win
    const t2 = await runLiquidationTick(h.deps);
    expect(t2.items.map((i) => i.outcome)).toEqual(['liquidated']);
    expect(h.row.status).toBe('liquidated');
    expect([...h.booked.values()].map(body)).toEqual(planned.plan.recipes.map(body));
    expect(h.lossKeys()).toHaveLength(1);
  });
});

describe('probe B: a reduction that moved no row is never success', () => {
  it('a row that cannot be reconciled (no larger than the tranche) abandons the rung, errors loudly, and PARKS the position', async () => {
    const h = harness();
    h.hooks.beforePost = () => {
      // The trader's own partial close lands while the loss is being booked: what is left is smaller than the tranche.
      h.row.size = amt('0.1');
    };
    const t = await runLiquidationTick(h.deps);
    expect(t.items[0]).toMatchObject({ outcome: 'errored', reason: 'trade.liquidation_row_changed_after_post' });
    expect(t.errored).toBe(1);
    expect(t.partial).toBe(0);
    expect(h.reduces).toHaveLength(0);
    expect(h.rungs.all().map((r) => r.state)).toEqual(['abandoned']);
    expect(h.row.size).toBe(amt('0.1')); // the rung did not touch a row it could not reconcile with

    // The next ticks do not plan the same tranche again: parked, counted, same code every tick.
    h.hooks.beforePost = undefined;
    h.price.current = '91';
    const postsBefore = h.posts.length;
    for (let i = 0; i < 2; i++) {
      const t2 = await runLiquidationTick(h.deps);
      expect(t2.items[0]).toMatchObject({ outcome: 'skipped_already', reason: ABANDONED_PARKED });
      expect(t2.parked).toBe(1);
    }
    expect(h.posts.length).toBe(postsBefore);
    expect(h.rungs.all()).toHaveLength(1);
  });

  it('the claim-based path (no rung store) treats a reducer that reports false as errored, not success', async () => {
    const h = harness();
    const deps: LiquidationTickDeps = {
      ...h.deps,
      rungs: undefined,
      ladder: {
        ...h.deps.ladder!,
        reducer: {
          async reduce() {
            return false;
          },
        },
      },
    };
    const t = await runLiquidationTick(deps);
    expect(t.items[0]).toMatchObject({ outcome: 'errored', reason: 'trade.liquidation_row_changed_after_post' });
    expect(t.partial).toBe(0);
  });
});

describe('probe C / E: a stale snapshot and a second replica', () => {
  it('a worker whose listOpen snapshot predates a finished rung refuses (skipped_changed) and books nothing', async () => {
    const h = harness();
    const stale = h.snapshot();
    await runLiquidationTick(h.deps);
    const keysAfterA = h.lossKeys();
    const marginDrop = amt('100') - h.row.margin;

    h.price.current = '92.5'; // a different mark: a fresh plan would carry different amounts and a different key
    const depsB: LiquidationTickDeps = {
      ...h.deps,
      positions: {
        async listOpen() {
          return [stale];
        },
      },
    };
    const t = await runLiquidationTick(depsB);
    expect(t.items[0]).toMatchObject({ outcome: 'skipped_changed' });
    expect(h.lossKeys()).toEqual(keysAfterA);
    expect(h.marginTaken()).toBe(marginDrop); // the ledger took exactly what the row lost
    expect(h.reduces).toHaveLength(1);
  });

  it('two ticks racing on one position (Promise.all): one loss booked, one reduction, both agree', async () => {
    const h = harness();
    const [a, b] = await Promise.all([runLiquidationTick(h.deps), runLiquidationTick(h.deps)]);
    expect(h.lossKeys()).toHaveLength(1);
    expect(h.reduces).toHaveLength(1);
    expect(h.marginTaken()).toBe(amt('100') - h.row.margin);
    expect(h.rungs.all()).toHaveLength(1);
    expect(h.rungs.all()[0]!.state).toBe('applied');
    // Neither replica reported a failure.
    expect(a.errored + b.errored).toBe(0);
  });

  it('regrow to the SAME size at the SAME mark: a new rung, a new ledger key, its own loss, its own reduction', async () => {
    const h = harness();
    await runLiquidationTick(h.deps);
    expect(h.reduces).toHaveLength(1);
    h.row.size = amt('10');
    h.row.margin = amt('100');
    const t2 = await runLiquidationTick(h.deps);
    expect(t2.items.map((i) => i.outcome)).toEqual(['partially_liquidated']);
    expect(h.lossKeys()).toEqual(['futures.loss:liq:pos-1:rung:rung-1:loss', 'futures.loss:liq:pos-1:rung:rung-2:loss']);
    expect(h.reduces).toHaveLength(2);
    // The ledger took margin for BOTH rungs, and the row lost the same twice.
    expect(h.marginTaken()).toBe(2n * (amt('100') - h.row.margin));
  });
});

describe('probe D: a failed closing rung is replayed, not parked', () => {
  it('a throw after the first post leaves a live rung; the next tick finishes the close', async () => {
    const h = harness();
    h.price.current = '60';
    const realApply = h.rungs.apply;
    let crash = true;
    h.rungs.apply = async (...args) => {
      if (crash) {
        crash = false;
        throw new Error('ledger.frozen or db blip');
      }
      return realApply(...args);
    };
    const t1 = await runLiquidationTick(h.deps);
    expect(t1.items[0]!.outcome).toBe('errored');
    expect(await h.attempts.isDone('liq:pos-1')).toBe(false); // no claim to park behind

    const t2 = await runLiquidationTick(h.deps);
    expect(t2.items.map((i) => i.outcome)).toEqual(['liquidated']);
    expect(h.row.status).toBe('liquidated');
    expect(h.announced).toEqual(['pos-1']);
    expect(h.lossKeys()).toHaveLength(1);
    expect(await h.attempts.isDone('liq:pos-1')).toBe(true);
  });

  it('a throw in the bus fan-out does not undo the close; the claim is still written for the old readers', async () => {
    const h = harness();
    h.price.current = '60';
    h.deps.closer.announceLiquidated = async () => {
      throw new Error('bus down');
    };
    const t = await runLiquidationTick(h.deps);
    expect(t.items.map((i) => i.outcome)).toEqual(['liquidated', 'errored']);
    expect(t.items[1]).toMatchObject({ reason: 'trade.liquidation_announce_failed' });
    expect(h.row.status).toBe('liquidated');
    expect(await h.attempts.isDone('liq:pos-1')).toBe(true);
  });
});

describe('probe F / H: ordinary writers move the row after the loss is booked', () => {
  it('F: the trader adds 50 margin while the loss posts: the rung applies as a delta, ledger and row agree, loss booked once', async () => {
    const h = harness();
    let once = true;
    h.hooks.beforePost = () => {
      if (once) {
        once = false;
        h.row.margin += amt('50');
      }
    };
    const t1 = await runLiquidationTick(h.deps);
    expect(t1.items.map((i) => i.outcome)).toEqual(['partially_liquidated']);
    expect(h.rungs.all().map((r) => r.state)).toEqual(['applied']);
    const taken = h.marginTaken();
    expect(h.row.margin).toBe(amt('150') - taken); // the 50 the trader added is theirs
    expect(h.row.size).toBeLessThan(amt('10'));
    expect(h.lossKeys()).toEqual(['futures.loss:liq:pos-1:rung:rung-1:loss']);
  });

  it('H: crash after the post, funding takes 1 before the restart: the replay reduces by the delta, loss booked once, ledger and row agree', async () => {
    const h = harness();
    const realApply = h.rungs.apply;
    let crash = true;
    h.rungs.apply = async (...args) => {
      if (crash) {
        crash = false;
        throw new Error('died before apply');
      }
      return realApply(...args);
    };
    await runLiquidationTick(h.deps);
    h.row.margin -= amt('1'); // funding
    const t2 = await runLiquidationTick(h.deps);
    expect(t2.items.map((i) => i.outcome)).toEqual(['partially_liquidated']);
    expect(h.lossKeys()).toHaveLength(1);
    expect(h.rungs.all().map((r) => r.state)).toEqual(['applied']);
    expect(h.marginTaken() + h.row.margin).toBe(amt('99'));
  });

  const crashFirstApply = (h: ReturnType<typeof harness>) => {
    const realApply = h.rungs.apply;
    let crash = true;
    h.rungs.apply = async (...args) => {
      if (crash) {
        crash = false;
        throw new Error('died before apply');
      }
      return realApply(...args);
    };
  };

  it('I: the trader adds 50 margin while a closing rung posts: the row STILL closes, the stranded 50 is recorded and alerted', async () => {
    const h = harness();
    h.price.current = '60';
    let once = true;
    h.hooks.beforePost = () => {
      if (once) {
        once = false;
        h.row.margin += amt('50');
      }
    };
    const t = await runLiquidationTick(h.deps);
    expect(t.items[0]).toMatchObject({
      outcome: 'liquidated',
      alert: { code: 'trade.liquidation_margin_drift', rungId: 'rung-1', amount: '50' },
    });
    expect(h.row.status).toBe('liquidated'); // never left open and tradable after the full loss is booked
    expect(h.rungs.all().map((r) => [r.state, r.marginDrift])).toEqual([['applied', amt('50')]]);
    expect(await h.rungs.isParked('pos-1')).toBe(false);
  });

  it('funding takes 1 from a closing rung between its post and its apply: the row closes, drift -1 is alerted, nothing else to post', async () => {
    const h = harness();
    h.price.current = '60';
    crashFirstApply(h);
    await runLiquidationTick(h.deps);
    const posts = h.posts.length;
    h.row.margin -= amt('1'); // funding (its own ledger legs are the funding writer's business)
    const t2 = await runLiquidationTick(h.deps);
    expect(t2.items[0]).toMatchObject({ outcome: 'liquidated', alert: { code: 'trade.liquidation_margin_drift', amount: '-1' } });
    expect(h.row.status).toBe('liquidated');
    expect(h.posts.length).toBe(posts);
    expect(h.rungs.all().map((r) => r.marginDrift)).toEqual([-amt('1')]);
  });

  it('a closing rung whose SIZE changed is abandoned and parks the position', async () => {
    const h = harness();
    h.price.current = '60';
    crashFirstApply(h);
    await runLiquidationTick(h.deps);
    h.row.size = amt('9'); // the trader closed part of it
    const t2 = await runLiquidationTick(h.deps);
    expect(t2.items[0]).toMatchObject({ outcome: 'errored', reason: 'trade.liquidation_row_changed_after_post' });
    expect(h.row.status).toBe('open');
    const t3 = await runLiquidationTick(h.deps);
    expect(t3.items[0]).toMatchObject({ outcome: 'skipped_already', reason: ABANDONED_PARKED });
  });

  it('K: funding took 70 of a 100 margin before a partial rung (loss ~39.89) applied: it still applies, floors at 0, and alerts the shortfall', async () => {
    const h = harness();
    crashFirstApply(h);
    await runLiquidationTick(h.deps);
    h.row.margin -= amt('70');
    const t2 = await runLiquidationTick(h.deps);
    const taken = h.marginTaken();
    expect(t2.items[0]).toMatchObject({
      outcome: 'partially_liquidated',
      alert: { code: 'trade.liquidation_margin_clipped', amount: formatAmount(amt('30') - taken) },
    });
    expect(h.row.margin).toBe(0n);
    expect(h.row.size).toBeLessThan(amt('10'));
    expect(h.rungs.all().map((r) => r.marginDrift)).toEqual([amt('30') - taken]);
  });
});

describe('probe L: the margin release comes up short (the position must never stay open after its loss is booked)', () => {
  const potAccount = {
    ownerType: 'user',
    ownerId: USER,
    assetId: 'USDT',
    kind: 'collateral',
    purpose: 'position:pos-1',
  } as unknown as AccountRef;
  const avail = { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'available' } as unknown as AccountRef;
  const fees = { ownerType: 'house', ownerId: 'fees:trade', assetId: 'USDT', kind: 'available' } as unknown as AccountRef;

  /** A stored closing rung: loss 70 from a 100 margin, release 30 — as the planner would have written it. */
  async function storedRung(h: ReturnType<typeof harness>) {
    const loss: PostRequest = {
      idempotencyKey: 'futures.loss:liq:pos-1:rung:r1:loss',
      module: 'trade',
      reason: 'futures.loss.realized',
      entries: [
        { account: potAccount, direction: 'credit', amount: amt('70') },
        { account: fees, direction: 'debit', amount: amt('70') },
      ],
    };
    const release: PostRequest = {
      idempotencyKey: 'futures.margin.release:pos-1:rung:r1',
      module: 'trade',
      reason: 'futures.margin.release',
      entries: [
        { account: potAccount, direction: 'credit', amount: amt('30') },
        { account: avail, direction: 'debit', amount: amt('30') },
      ],
    };
    const plan: RungPlan = {
      recipes: [loss, release],
      sizeClosed: amt('10'),
      marginRemaining: 0n,
      marginTaken: amt('70'),
      releaseShort: 0n,
      lossShort: 0n,
      reason: 'ladder_full_close',
      fromInsurance: 0n,
      marginAsset: 'USDT',
    };
    const r = await h.rungs.begin({
      rungId: 'r1',
      positionId: 'pos-1',
      liquidationId: 'liq:pos-1',
      kind: 'closing',
      fromSize: amt('10'),
      fromMargin: amt('100'),
      plan,
    });
    expect(r.status).toBe('created');
  }
  const releaseOf = (h: ReturnType<typeof harness>) => h.booked.get('futures.margin.release:pos-1:rung:r1');

  it('funding took 5 before the release posted: the release is amended to the pot, the row closes, the shortfall is alerted', async () => {
    const h = harness({ pot: amt('95') });
    await storedRung(h);
    h.row.margin -= amt('5'); // funding took it from the row and the pot
    const t = await runLiquidationTick(h.deps);
    expect(t.items[0]).toMatchObject({
      outcome: 'liquidated',
      releaseShort: { code: 'trade.liquidation_release_short', rungId: 'r1', amount: '5' },
    });
    expect(h.row.status).toBe('liquidated');
    expect(releaseOf(h)!.entries.map((e) => e.amount)).toEqual([amt('25'), amt('25')]);
    expect(h.booked.get('futures.loss:liq:pos-1:rung:r1:loss')!.entries[0]!.amount).toBe(amt('70'));
    expect(h.rungs.all().map((r) => [r.state, r.plan.releaseShort, r.marginDrift])).toEqual([['applied', amt('5'), -amt('5')]]);
    expect(h.announced).toEqual(['pos-1']);
  });

  it('a margin withdrawal of 10 (pot and row) before the release posted: same, amended to 20', async () => {
    const h = harness({ pot: amt('90') });
    await storedRung(h);
    h.row.margin -= amt('10');
    const t = await runLiquidationTick(h.deps);
    expect(t.items[0]).toMatchObject({ outcome: 'liquidated', releaseShort: { amount: '10' } });
    expect(h.row.status).toBe('liquidated');
    expect(releaseOf(h)!.entries[0]!.amount).toBe(amt('20'));
  });

  it('crash after the amendment is persisted but before it posts: the replay posts the AMENDED body, byte for byte', async () => {
    const h = harness({ pot: amt('95') });
    await storedRung(h);
    h.row.margin -= amt('5');
    let crash = true;
    const real = h.deps.ledger.post;
    h.deps.ledger.post = async (req) => {
      // The amended release is the second attempt at this key; the first (stored) one was refused.
      if (crash && req.idempotencyKey.includes('margin.release') && req.entries[0]!.amount === amt('25')) {
        crash = false;
        throw new Error('died right after amending');
      }
      return real(req);
    };
    const t1 = await runLiquidationTick(h.deps);
    expect(t1.items[0]).toMatchObject({ outcome: 'errored', reason: 'trade.liquidation_tick_error' });
    const live = (await h.rungs.findLive('pos-1'))!;
    expect(live.state).toBe('planned');
    expect(live.plan.releaseShort).toBe(amt('5'));
    const amended = live.plan.recipes.find((r) => r.reason === 'futures.margin.release')!;
    expect(amended.entries[0]!.amount).toBe(amt('25'));
    expect(h.row.status).toBe('open');

    const t2 = await runLiquidationTick(h.deps);
    expect(t2.items[0]).toMatchObject({ outcome: 'liquidated', releaseShort: { amount: '5' } });
    expect(body(releaseOf(h)!)).toBe(body(amended));
    expect(h.row.status).toBe('liquidated');
  });

  it('an empty pot: the release is skipped, the row still closes, the whole release is the shortfall', async () => {
    const h = harness({ pot: amt('70') });
    await storedRung(h);
    h.row.margin = 0n;
    const t = await runLiquidationTick(h.deps);
    expect(t.items[0]).toMatchObject({
      outcome: 'liquidated',
      releaseShort: { amount: '30' },
    });
    expect(h.row.status).toBe('liquidated');
    expect(releaseOf(h)).toBeUndefined();
    expect((await h.rungs.all())[0]!.plan.recipes).toHaveLength(1);
  });

  it('a refusal that is NOT a short pot (the pot holds enough) is not amended: it errors and the rung stays live', async () => {
    const h = harness({ pot: amt('1000') });
    await storedRung(h);
    h.hooks.beforePost = (req) => {
      if (req.idempotencyKey.includes('margin.release')) {
        throw new InsufficientFundsError('user:available', 'USDT', '30', '0');
      }
    };
    const t = await runLiquidationTick(h.deps);
    expect(t.items[0]).toMatchObject({ outcome: 'errored' });
    expect(h.row.status).toBe('open');
    expect((await h.rungs.findLive('pos-1'))!.plan.releaseShort).toBe(0n);
  });
});

describe('probes M / N: the pot shrank after planning and the LOSS is refused', () => {
  const potAccount = {
    ownerType: 'user',
    ownerId: USER,
    assetId: 'USDT',
    kind: 'collateral',
    purpose: 'position:pos-1',
  } as unknown as AccountRef;
  const fees = { ownerType: 'house', ownerId: 'fees:trade', assetId: 'USDT', kind: 'available' } as unknown as AccountRef;
  const insAcct = { ownerType: 'house', ownerId: 'insurance-fund', assetId: 'USDT', kind: 'available' } as unknown as AccountRef;
  const avail = { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'available' } as unknown as AccountRef;

  async function store(
    h: ReturnType<typeof harness>,
    o: { kind: 'closing' | 'partial'; potLeg: string; insLeg?: string; release?: string; sizeClosed?: string },
  ) {
    const ins = amt(o.insLeg ?? '0');
    const entries: PostRequest['entries'] = [
      { account: potAccount, direction: 'credit', amount: amt(o.potLeg) },
      ...(ins > 0n ? [{ account: insAcct, direction: 'credit' as const, amount: ins }] : []),
      { account: fees, direction: 'debit', amount: amt(o.potLeg) + ins },
    ];
    const recipes: PostRequest[] = [
      { idempotencyKey: 'futures.loss:liq:pos-1:rung:r1:loss', module: 'trade', reason: 'futures.loss.realized', entries },
      ...(o.release
        ? [
            {
              idempotencyKey: 'futures.margin.release:pos-1:rung:r1',
              module: 'trade',
              reason: 'futures.margin.release',
              entries: [
                { account: potAccount, direction: 'credit' as const, amount: amt(o.release) },
                { account: avail, direction: 'debit' as const, amount: amt(o.release) },
              ],
            },
          ]
        : []),
    ];
    const r = await h.rungs.begin({
      rungId: 'r1',
      positionId: 'pos-1',
      liquidationId: 'liq:pos-1',
      kind: o.kind,
      fromSize: amt('10'),
      fromMargin: amt('100'),
      plan: {
        recipes,
        sizeClosed: amt(o.sizeClosed ?? '10'),
        marginRemaining: 0n,
        marginTaken: amt(o.potLeg),
        releaseShort: 0n,
        lossShort: 0n,
        reason: o.kind === 'closing' ? 'ladder_full_close' : 'ladder_partial',
        fromInsurance: ins,
        marginAsset: 'USDT',
      },
    });
    expect(r.status).toBe('created');
  }
  const lossOf = (h: ReturnType<typeof harness>) => h.booked.get('futures.loss:liq:pos-1:rung:r1:loss')!;
  const legs = (req: PostRequest) => req.entries.map((e) => `${e.direction}:${e.account.kind}:${formatAmount(e.amount)}`);

  it('M: bankrupt closing rung (100 from the pot + 60 insurance), funding left the pot at 99: the loss is re-split 99 + 61, the position closes, insurance is not blamed', async () => {
    const h = harness({ pot: amt('99') });
    await store(h, { kind: 'closing', potLeg: '100', insLeg: '60' });
    h.row.margin = amt('99');
    const t = await runLiquidationTick(h.deps);
    expect(t.items[0]).toMatchObject({
      outcome: 'liquidated',
      // The fund paid 1 more than planned because the pot held less: never silent.
      insuranceGrown: { code: 'trade.liquidation_insurance_grown', rungId: 'r1', amount: '1' },
    });
    expect(t.items[0]!.reason).not.toBe('trade.liquidation_insurance_underfunded_on_replay');
    expect(h.row.status).toBe('liquidated');
    expect(legs(lossOf(h))).toEqual(['credit:collateral:99', 'credit:available:61', 'debit:available:160']);
    expect((await h.rungs.all())[0]).toMatchObject({ state: 'applied' });
    expect((await h.rungs.all())[0]!.plan.fromInsurance).toBe(amt('61'));
  });

  it('M2: when insurance genuinely cannot cover the grown leg, it IS the insurance branch (loud, row open, the ADL park path)', async () => {
    const h = harness({ pot: amt('99'), insurance: amt('60') });
    await store(h, { kind: 'closing', potLeg: '100', insLeg: '60' });
    const t = await runLiquidationTick(h.deps);
    expect(t.items[0]).toMatchObject({ outcome: 'errored', reason: 'trade.liquidation_insurance_underfunded_on_replay' });
    expect(h.row.status).toBe('open');
    expect(h.booked.size).toBe(0);
  });

  it('a loss refusal where the pot holds enough and insurance holds enough is neither: it errors as itself and is not amended', async () => {
    const h = harness({ pot: amt('1000') });
    await store(h, { kind: 'closing', potLeg: '100', insLeg: '60' });
    h.hooks.beforePost = () => {
      throw new InsufficientFundsError('user:other', 'USDT', '1', '0');
    };
    const t = await runLiquidationTick(h.deps);
    expect(t.items[0]).toMatchObject({ outcome: 'errored', reason: 'ledger.insufficient_funds' });
    expect((await h.rungs.findLive('pos-1'))!.plan.fromInsurance).toBe(amt('60'));
  });

  it('N: non-bankrupt closing rung (loss 70, release 30), pot drained to 60: loss 60 + 10 insurance, release skipped, position closes', async () => {
    const h = harness({ pot: amt('60') });
    await store(h, { kind: 'closing', potLeg: '70', release: '30' });
    h.row.margin = amt('60');
    const t = await runLiquidationTick(h.deps);
    expect(t.items[0]).toMatchObject({
      outcome: 'liquidated',
      releaseShort: { amount: '30' },
      insuranceGrown: { code: 'trade.liquidation_insurance_grown', amount: '10' },
    });
    expect(h.row.status).toBe('liquidated');
    expect(legs(lossOf(h))).toEqual(['credit:collateral:60', 'credit:available:10', 'debit:available:70']);
    expect(h.booked.has('futures.margin.release:pos-1:rung:r1')).toBe(false);
  });

  it('a PARTIAL rung whose pot shrank books the loss for what the pot holds, records the under-booking, and still reduces the row', async () => {
    const h = harness({ pot: amt('30') });
    await store(h, { kind: 'partial', potLeg: '40', sizeClosed: '4' });
    h.row.margin = amt('30'); // funding took 70
    const t = await runLiquidationTick(h.deps);
    expect(t.items[0]).toMatchObject({
      outcome: 'partially_liquidated',
      lossShort: { code: 'trade.liquidation_loss_short', rungId: 'r1', amount: '10' },
    });
    expect(legs(lossOf(h))).toEqual(['credit:collateral:30', 'debit:available:30']);
    expect(h.row.size).toBe(amt('6'));
    expect(h.row.margin).toBe(0n);
    expect((await h.rungs.all())[0]!.plan.lossShort).toBe(amt('10'));
    expect(t.items[0]).not.toHaveProperty('insuranceGrown'); // a partial rung never draws on the fund here
  });

  it('a closing rung whose pot did NOT shrink raises no insuranceGrown (the planned insurance leg is not "grown")', async () => {
    const h = harness();
    await store(h, { kind: 'closing', potLeg: '100', insLeg: '60' });
    const t = await runLiquidationTick(h.deps);
    expect(t.items[0]).toMatchObject({ outcome: 'liquidated' });
    expect(t.items[0]).not.toHaveProperty('insuranceGrown');
  });

  it('the amended loss is persisted before it posts: a crash right after, then the replay posts the SAME amended body', async () => {
    const h = harness({ pot: amt('99') });
    await store(h, { kind: 'closing', potLeg: '100', insLeg: '60' });
    let crash = true;
    const real = h.deps.ledger.post;
    h.deps.ledger.post = async (req) => {
      if (crash && req.reason === 'futures.loss.realized' && req.entries[0]!.amount === amt('99')) {
        crash = false;
        throw new Error('died right after amending the loss');
      }
      return real(req);
    };
    await runLiquidationTick(h.deps);
    const amended = (await h.rungs.findLive('pos-1'))!.plan.recipes[0]!;
    expect(legs(amended)).toEqual(['credit:collateral:99', 'credit:available:61', 'debit:available:160']);
    await runLiquidationTick(h.deps);
    expect(body(lossOf(h))).toBe(body(amended));
    expect(h.row.status).toBe('liquidated');
  });

  it('two workers amend the same rung at once with a moving pot: the compare-and-set lets one win, and only ONE amended body is ever posted', async () => {
    const h = harness({ pot: amt('95') });
    // Same stored rung as probe L: loss 70, release 30. After the loss the pot holds 25.
    await store(h, { kind: 'closing', potLeg: '70', release: '30' });
    h.row.margin = amt('95');
    const reads = [amt('25'), amt('20')]; // the pot "moves" between the two workers' reads
    h.hooks.balance = (ref) => (ref.kind === 'collateral' ? (reads.shift() ?? amt('25')) : undefined);
    const [a, b] = await Promise.all([runLiquidationTick(h.deps), runLiquidationTick(h.deps)]);
    expect(a.errored + b.errored).toBe(0);
    const releases = h.posts.filter((p) => p.reason === 'futures.margin.release');
    expect(new Set(releases.map(body)).size).toBe(1);
    expect(h.row.status).toBe('liquidated');
    expect(h.rungs.all()).toHaveLength(1);
    expect(h.rungs.all()[0]!.state).toBe('applied');
  });
});

describe('divergence guard: the plan is taken against min(row margin, ledger pot)', () => {
  const divergence = (t: { items: { divergence?: unknown }[] }) => t.items[0]!.divergence;

  it('row 100, pot 80: plans against 80, raises trade.liquidation_margin_divergence, and books a loss the pot can pay (no loss_short)', async () => {
    const h = harness({ pot: amt('80') });
    const t = await runLiquidationTick(h.deps);
    expect(divergence(t)).toEqual({ code: 'trade.liquidation_margin_divergence', row: '100', pot: '80' });
    const rung = h.rungs.all()[0]!;
    // Planned from 80, not 100: the tranche's margin can never exceed what the pot held.
    expect(rung.plan.marginTaken).toBeLessThanOrEqual(amt('80'));
    expect(rung.plan.marginRemaining).toBe(amt('80') - rung.plan.marginTaken);
    expect(rung.planVersion).toBe(0); // never needed an amendment: the first plan was already payable
    expect(h.marginTaken()).toBe(rung.plan.marginTaken);
    expect(h.pot.amount).toBe(amt('80') - rung.plan.marginTaken);
    expect(t.items[0]!.outcome).toBe('partially_liquidated');
    expect(t.items[0]).not.toHaveProperty('lossShort');
    // The rung's compare-and-set is still the ROW the tick read (100), so it begins and applies.
    expect(rung.fromMargin).toBe(amt('100'));
    expect(rung.state).toBe('applied');
  });

  it('the plan differs from the one the row alone would give (the phantom margin is gone)', async () => {
    const phantom = harness({ pot: amt('1000000') }); // pot above the row: planned from the row's 100
    await runLiquidationTick(phantom.deps);
    const guarded = harness({ pot: amt('80') });
    await runLiquidationTick(guarded.deps);
    expect(guarded.rungs.all()[0]!.plan.marginRemaining).toBeLessThan(phantom.rungs.all()[0]!.plan.marginRemaining);
  });

  it('a divergent position cannot loop: it terminates, no tick errors, and every rung applies', async () => {
    const h = harness({ pot: amt('80') });
    for (let i = 0; i < 6; i++) {
      const t = await runLiquidationTick(h.deps);
      expect(t.errored).toBe(0);
      expect(t.items.filter((x) => x.outcome === 'errored')).toEqual([]);
      if (h.row.status !== 'open') break;
    }
    expect(h.rungs.all().length).toBeLessThanOrEqual(6);
    expect(h.rungs.all().every((r) => r.state === 'applied')).toBe(true);
    expect(h.rungs.all().length).toBeGreaterThan(0);
  });

  it('a gap that leaves the position bankrupt on the pot: the closing rung draws insurance for what the POT cannot cover, and applies', async () => {
    const h = harness({ pot: amt('50') });
    h.price.current = '60'; // loss 400 on 10 units; row 100 / pot 50
    const t = await runLiquidationTick(h.deps);
    expect(divergence(t)).toEqual({ code: 'trade.liquidation_margin_divergence', row: '100', pot: '50' });
    expect(t.items[0]!.outcome).toBe('liquidated');
    const rung = h.rungs.all()[0]!;
    expect(rung.plan.marginTaken).toBe(amt('50')); // the pot, not the row's 100
    expect(rung.planVersion).toBe(0); // planned payable first time, not amended after a refusal
    expect(rung.plan.fromInsurance).toBeGreaterThan(amt('50')); // the rest of the 400 loss is the insurance leg
    expect(h.pot.amount).toBe(0n);
  });

  it('row BELOW pot (the other direction): planned against the row, still raised', async () => {
    const h = harness({ pot: amt('150') });
    const t = await runLiquidationTick(h.deps);
    expect(divergence(t)).toEqual({ code: 'trade.liquidation_margin_divergence', row: '100', pot: '150' });
    expect(h.rungs.all()[0]!.plan.marginTaken).toBeLessThanOrEqual(amt('100'));
  });

  it('row and pot agree: no divergence on the item', async () => {
    const h = harness({ pot: amt('100') });
    const t = await runLiquidationTick(h.deps);
    expect(t.items[0]).not.toHaveProperty('divergence');
  });

  it('a healthy position whose pot is short is still flagged (and a healthy one planned on the row stays healthy)', async () => {
    const h = harness({ pot: amt('90') });
    h.price.current = '99';
    const t = await runLiquidationTick(h.deps);
    expect(t.items[0]).toMatchObject({ outcome: 'skipped_healthy', divergence: { row: '100', pot: '90' } });
    expect(h.posts).toHaveLength(0);
  });

  it('no published policy: no ledger read per position (the cheap skip comes first)', async () => {
    const h = harness({ pot: amt('80') });
    let reads = 0;
    h.hooks.balance = () => {
      reads += 1;
      return undefined;
    };
    h.deps.ladder = { ...h.deps.ladder!, policy: undefined };
    const t = await runLiquidationTick(h.deps);
    expect(t.items[0]!.outcome).toBe('skipped_d3_unset');
    expect(reads).toBe(0);
  });
});

describe('refused insurance leg on replay (kind-specific): a PARTIAL rung re-amends to pot-only, a CLOSING rung stays live', () => {
  const potAccount = {
    ownerType: 'user',
    ownerId: USER,
    assetId: 'USDT',
    kind: 'collateral',
    purpose: 'position:pos-1',
  } as unknown as AccountRef;
  const fees = { ownerType: 'house', ownerId: 'fees:trade', assetId: 'USDT', kind: 'available' } as unknown as AccountRef;
  const insAcct = { ownerType: 'house', ownerId: 'insurance-fund', assetId: 'USDT', kind: 'available' } as unknown as AccountRef;

  /** A stored rung whose loss has a 20 pot leg and a 5 insurance leg. A partial rung has none of these today (equity > 0), so it is stored by hand. */
  async function storeRung(h: ReturnType<typeof harness>, kind: 'partial' | 'closing') {
    const r = await h.rungs.begin({
      rungId: 'r1',
      positionId: 'pos-1',
      liquidationId: 'liq:pos-1',
      kind,
      fromSize: amt('10'),
      fromMargin: amt('100'),
      plan: {
        recipes: [
          {
            idempotencyKey: 'futures.loss:liq:pos-1:rung:r1:loss',
            module: 'trade',
            reason: 'futures.loss.realized',
            meta: { fromMargin: amt('20').toString(), fromInsurance: amt('5').toString() },
            entries: [
              { account: potAccount, direction: 'credit', amount: amt('20') },
              { account: insAcct, direction: 'credit', amount: amt('5') },
              { account: fees, direction: 'debit', amount: amt('25') },
            ],
          },
        ],
        sizeClosed: kind === 'partial' ? amt('2') : amt('10'),
        marginRemaining: kind === 'partial' ? amt('80') : 0n,
        marginTaken: amt('20'),
        releaseShort: 0n,
        lossShort: 0n,
        reason: kind === 'partial' ? 'ladder_partial' : 'ladder_full_close',
        fromInsurance: amt('5'),
        marginAsset: 'USDT',
      },
    });
    expect(r.status).toBe('created');
  }
  const bookedLoss = (h: ReturnType<typeof harness>) => h.booked.get('futures.loss:liq:pos-1:rung:r1:loss')!;

  it('PARTIAL, across two ticks: tick 1 dies before posting; on tick 2 the fund refuses the leg, the loss re-amends to the pot leg, lossShort = the gap, no ADL, the rung applies', async () => {
    const h = harness();
    await storeRung(h, 'partial');
    h.hooks.beforePost = () => {
      throw new Error('died before anything booked');
    };
    const t1 = await runLiquidationTick(h.deps);
    expect(t1.items[0]).toMatchObject({ outcome: 'errored' });
    expect((await h.rungs.findLive('pos-1'))!.state).toBe('planned');

    h.hooks.beforePost = undefined;
    h.insurance.available = 0n; // the fund cannot cover the 5 any more
    const t2 = await runLiquidationTick(h.deps);
    expect(t2.items[0]).toMatchObject({
      outcome: 'partially_liquidated',
      lossShort: { code: 'trade.liquidation_loss_short', rungId: 'r1', amount: '5' },
    });
    expect(t2.items[0]!.reason).not.toBe('trade.liquidation_insurance_underfunded_on_replay');
    // What was booked is the pot leg only, under the same key.
    expect(bookedLoss(h).meta).toMatchObject({ fromMargin: amt('20').toString(), fromInsurance: '0' });
    expect(bookedLoss(h).entries.some((e) => e.account.ownerId === 'insurance-fund')).toBe(false);
    const rung = h.rungs.all()[0]!;
    expect(rung).toMatchObject({ state: 'applied' });
    expect(rung.plan).toMatchObject({ fromInsurance: 0n, lossShort: amt('5'), marginTaken: amt('20') });
    expect(h.row.size).toBe(amt('8'));
    expect(h.row.margin).toBe(amt('80'));
  });

  it('PARTIAL, the refusal is NOT the fund (it holds enough): not amended, errors as itself, plan untouched', async () => {
    const h = harness();
    await storeRung(h, 'partial');
    let once = true;
    h.hooks.beforePost = () => {
      if (once) {
        once = false;
        throw new InsufficientFundsError('house:insurance-fund', 'USDT', '5', '4');
      }
    };
    const t = await runLiquidationTick(h.deps); // the fund really holds 1_000_000
    expect(t.items[0]).toMatchObject({ outcome: 'errored', reason: 'ledger.insufficient_funds' });
    expect(h.rungs.all()[0]!.plan).toMatchObject({ fromInsurance: amt('5'), lossShort: 0n });
    expect((await h.rungs.findLive('pos-1'))!.state).toBe('planned');
  });

  it('CLOSING is unchanged: a refused insurance leg stays live and loud, nothing is amended, and it finishes once the fund is back', async () => {
    const h = harness();
    await storeRung(h, 'closing');
    h.insurance.available = 0n;
    const t = await runLiquidationTick(h.deps);
    expect(t.items[0]).toMatchObject({ outcome: 'errored', reason: 'trade.liquidation_insurance_underfunded_on_replay' });
    expect(h.rungs.all()[0]!.plan).toMatchObject({ fromInsurance: amt('5'), lossShort: 0n });
    expect(h.booked.size).toBe(0);
    expect(h.row.status).toBe('open');

    h.insurance.available = amt('1000000');
    const t2 = await runLiquidationTick(h.deps);
    expect(t2.items.map((i) => i.outcome)).toEqual(['liquidated']);
    expect(bookedLoss(h).meta).toMatchObject({ fromInsurance: amt('5').toString() });
  });
});

describe('reconciliation to the ledger: the rungs a tick booked agree with what the ledger holds', () => {
  /** What the operator queries (runbook 5.1) would return, read off the harness's booked transactions. */
  function ledgerView(h: ReturnType<typeof harness>) {
    const ledgerLossTxs: LedgerLossTx[] = [...h.booked.values()]
      .filter((p) => p.reason === REALIZED_LOSS_REASON)
      .map((p) => ({ idempotencyKey: p.idempotencyKey, meta: p.meta ?? null }));
    const insuranceCredits: InsuranceCredit[] = [...h.booked.values()].flatMap((p) =>
      p.entries
        .filter((e) => e.direction === 'credit' && e.account.ownerType === 'house' && e.account.ownerId === 'insurance-fund')
        .map((e) => ({ idempotencyKey: p.idempotencyKey, reason: p.reason, amount: e.amount })),
    );
    return { ledgerLossTxs, insuranceCredits };
  }

  it('a partial rung, then a bankrupt closing rung with an insurance leg: clean', async () => {
    const h = harness();
    await runLiquidationTick(h.deps); // partial at 93
    h.price.current = '76'; // a gap inside the breaker that leaves the remainder bankrupt
    await runLiquidationTick(h.deps);
    expect(h.row.status).toBe('liquidated');
    const out = reconcileRungsToLedger({ rungs: h.rungs.all(), ...ledgerView(h) });
    expect(out.checked).toBe(2);
    expect(out.mismatches).toEqual([]);
    expect(out.insurance.plans).toBeGreaterThan(0n);
    expect(out.clean).toBe(true);
  });

  it('a rung amended after the pot shrank (closing: 99 pot + 61 insurance) still reconciles: the amended plan is what the ledger booked', async () => {
    const h = harness({ pot: amt('99') });
    h.price.current = '40';
    await runLiquidationTick(h.deps);
    const out = reconcileRungsToLedger({ rungs: h.rungs.all(), ...ledgerView(h) });
    expect(out.clean).toBe(true);
  });

  it('a loss_short partial (pot shrank) books only the pot leg, and the plan says so: clean', async () => {
    const h = harness();
    h.hooks.beforePost = () => {
      h.pot.amount = amt('10'); // funding took most of the pot before the loss posted
      h.hooks.beforePost = undefined;
    };
    const t = await runLiquidationTick(h.deps);
    expect(t.items[0]).toHaveProperty('lossShort');
    expect(reconcileRungsToLedger({ rungs: h.rungs.all(), ...ledgerView(h) }).clean).toBe(true);
  });

  it('a ledger that booked a different amount than the rung planned is caught', async () => {
    const h = harness();
    await runLiquidationTick(h.deps);
    const view = ledgerView(h);
    const tampered = view.ledgerLossTxs.map((t) => ({ ...t, meta: { ...t.meta, fromMargin: '1' } }));
    const out = reconcileRungsToLedger({ rungs: h.rungs.all(), ...view, ledgerLossTxs: tampered });
    expect(out.clean).toBe(false);
    expect(out.mismatches.map((m) => m.kind)).toEqual(['from_margin']);
  });
});

describe('probe G: the production ledger client cannot look keys up', () => {
  it('a bankrupt closing rung (insurance leg) that crashes before its first post is replayed to completion', async () => {
    const h = harness();
    h.price.current = '84';
    let crash = true;
    h.hooks.beforePost = () => {
      if (crash) {
        crash = false;
        throw new Error('process died');
      }
    };
    const t1 = await runLiquidationTick(h.deps);
    expect(t1.items[0]).toMatchObject({ outcome: 'errored', reason: 'trade.liquidation_tick_error' });
    const planned = (await h.rungs.findLive('pos-1'))!;
    expect(planned.state).toBe('planned');
    expect(planned.plan.fromInsurance).toBeGreaterThan(0n);

    const t2 = await runLiquidationTick(h.deps);
    expect(t2.items.map((i) => i.outcome)).toEqual(['liquidated']);
    expect(h.row.status).toBe('liquidated');
    expect(h.lossKeys()).toHaveLength(1);
  });

  it("the race loser replays the winner's planned insurance rung without a key lookup", async () => {
    const h = harness();
    h.price.current = '84';
    const stale = h.snapshot();
    let crash = true;
    h.hooks.beforePost = () => {
      if (crash) {
        crash = false;
        throw new Error('winner died before posting');
      }
    };
    await runLiquidationTick(h.deps);
    const loser = {
      ...h.deps,
      positions: {
        async listOpen() {
          return [stale];
        },
      },
    };
    // The live rung is found before anything is decided, whatever the snapshot.
    const t = await runLiquidationTick(loser);
    expect(t.items.map((i) => i.outcome)).toEqual(['liquidated']);
  });
});

describe('the close announcement is at-least-once', () => {
  it('a crash after the close commits but before the bus publish: the next tick re-publishes once, then stops', async () => {
    const h = harness();
    h.price.current = '60';
    let fail = true;
    const published: string[] = [];
    h.deps.closer.announceLiquidated = async (id, meta) => {
      if (fail) {
        fail = false;
        throw new Error('bus down');
      }
      published.push(`${id}:${meta.liquidationId}`);
    };
    const t1 = await runLiquidationTick(h.deps);
    expect(t1.items.map((i) => i.outcome)).toEqual(['liquidated', 'errored']);
    expect(h.row.status).toBe('liquidated');
    expect(published).toEqual([]);

    const t2 = await runLiquidationTick(h.deps);
    expect(t2.errored).toBe(0);
    expect(published).toEqual(['pos-1:liq:pos-1']);
    await runLiquidationTick(h.deps);
    expect(published).toHaveLength(1); // recorded as announced
  });

  it('a bus that stays down is reported on its own item every tick', async () => {
    const h = harness();
    h.price.current = '60';
    h.deps.closer.announceLiquidated = async () => {
      throw new Error('bus down');
    };
    await runLiquidationTick(h.deps);
    const t2 = await runLiquidationTick(h.deps);
    expect(t2.items.at(-1)).toMatchObject({ outcome: 'errored', reason: 'trade.liquidation_announce_failed' });
  });

  it('a dead bus costs ONE publish attempt per tick however many closes are waiting', async () => {
    const h = harness();
    // Three applied-but-unannounced closes (the position id is reused by the harness).
    for (let i = 1; i <= 3; i++) {
      h.row.status = 'open';
      h.row.size = amt('10');
      h.row.margin = amt('100');
      const plan = {
        recipes: [],
        sizeClosed: amt('10'),
        marginRemaining: 0n,
        marginTaken: 0n,
        releaseShort: 0n,
        lossShort: 0n,
        reason: 'ladder_full_close',
        fromInsurance: 0n,
        marginAsset: 'USDT',
      };
      await h.rungs.begin({
        rungId: `old-${i}`,
        positionId: 'pos-1',
        liquidationId: 'liq:pos-1',
        kind: 'closing',
        fromSize: amt('10'),
        fromMargin: amt('100'),
        plan,
      });
      await h.rungs.markPosted(`old-${i}`);
      expect((await h.rungs.apply('pos-1', `old-${i}`)).status).toBe('applied');
    }
    let attempts = 0;
    h.deps.closer.announceLiquidated = async () => {
      attempts += 1;
      throw new Error('bus down');
    };
    const t1 = await runLiquidationTick(h.deps);
    expect(attempts).toBe(1); // not 3
    expect(t1.items.filter((i) => i.outcome === 'errored')).toHaveLength(1);
    await runLiquidationTick(h.deps);
    expect(attempts).toBe(2);
  });

  it('the announcement is attempted after the scan: a rung never waits on the bus', async () => {
    const h = harness();
    h.price.current = '60';
    const order: string[] = [];
    h.deps.closer.announceLiquidated = async () => {
      order.push('announce');
    };
    const realPost = h.deps.ledger.post;
    h.deps.ledger.post = async (req) => {
      order.push('post');
      return realPost(req);
    };
    await runLiquidationTick(h.deps);
    expect(order).toEqual(['post', 'announce']);
  });
});

describe('in-flight rungs from before rung ids', () => {
  it('an existing claim on a still-open position keeps the old behaviour: parked, nothing planned, nothing posted', async () => {
    const h = harness();
    h.price.current = '60';
    expect(await h.attempts.tryClaim('liq:pos-1')).toBe(true); // the old code claimed, then died
    const t = await runLiquidationTick(h.deps);
    expect(t.items[0]).toMatchObject({ outcome: 'skipped_already', reason: 'already_done' });
    expect(t.parked).toBe(1);
    expect(h.posts).toHaveLength(0);
    expect(h.rungs.all()).toHaveLength(0);
  });
});

describe('insurance on a replay', () => {
  it('a decision-time shortfall still parks (no rung is created)', async () => {
    const h = harness({ insurance: 0n });
    h.price.current = '60';
    const t = await runLiquidationTick(h.deps);
    expect(t.items[0]!.outcome).toBe('skipped_insurance_underfunded');
    expect(h.rungs.all()).toHaveLength(0);
    expect(h.posts).toHaveLength(0);
  });

  it('a planned rung whose fund has since drained is errored with the distinct code, loudly, and finishes once the fund is back', async () => {
    const h = harness();
    h.price.current = '60'; // closing, bankrupt: draws on insurance
    h.hooks.beforePost = () => {
      throw new Error('died before anything booked');
    };
    await runLiquidationTick(h.deps);
    const rung = (await h.rungs.findLive('pos-1'))!;
    expect(rung.state).toBe('planned');
    expect(rung.plan.fromInsurance).toBeGreaterThan(0n);
    h.hooks.beforePost = undefined;

    h.insurance.available = 0n; // the ledger now refuses the insurance leg
    const t2 = await runLiquidationTick(h.deps);
    expect(t2.items[0]).toMatchObject({ outcome: 'errored', reason: 'trade.liquidation_insurance_underfunded_on_replay' });
    expect(t2.errored).toBe(1);
    expect(h.posts).toHaveLength(0);
    expect(h.row.status).toBe('open'); // still live, retried every tick

    h.insurance.available = amt('1000000');
    const t3 = await runLiquidationTick(h.deps);
    expect(t3.items.map((i) => i.outcome)).toEqual(['liquidated']);
    expect(h.row.status).toBe('liquidated');
  });

  it('an already-posted rung is not blocked by a drained fund (its money is already out)', async () => {
    const h = harness();
    h.price.current = '60';
    const realApply = h.rungs.apply;
    let crash = true;
    h.rungs.apply = async (...args) => {
      if (crash) {
        crash = false;
        throw new Error('died after posts');
      }
      return realApply(...args);
    };
    await runLiquidationTick(h.deps);
    h.insurance.available = 0n;
    const t2 = await runLiquidationTick(h.deps);
    expect(t2.items.map((i) => i.outcome)).toEqual(['liquidated']);
  });
});

describe('the memory store models the lock and the one-live-rung rule', () => {
  const plan = (): RungPlan => ({
    recipes: [],
    sizeClosed: amt('1'),
    marginRemaining: amt('90'),
    marginTaken: amt('10'),
    releaseShort: 0n,
    lossShort: 0n,
    reason: 'ladder_partial',
    fromInsurance: 0n,
    marginAsset: 'USDT',
  });

  it('a second begin on a position with a live rung gets the first rung back, whatever the row looks like', async () => {
    const h = harness();
    const input = {
      positionId: 'pos-1',
      liquidationId: 'liq:pos-1',
      kind: 'partial' as const,
      fromSize: amt('10'),
      fromMargin: amt('100'),
      plan: plan(),
    };
    const a = await h.rungs.begin({ ...input, rungId: 'r-a' });
    const b = await h.rungs.begin({ ...input, rungId: 'r-b' });
    expect(a.status).toBe('created');
    expect(b).toMatchObject({ status: 'live', rung: { rungId: 'r-a' } });
  });

  it('begin refuses a snapshot that is not the row, a closed row, and a missing row', async () => {
    const h = harness();
    const input = {
      rungId: 'r-1',
      liquidationId: 'liq:pos-1',
      kind: 'partial' as const,
      fromSize: amt('10'),
      fromMargin: amt('100'),
      plan: plan(),
    };
    expect(await h.rungs.begin({ ...input, positionId: 'pos-1', fromSize: amt('9') })).toEqual({ status: 'changed' });
    expect(await h.rungs.begin({ ...input, positionId: 'pos-1', fromMargin: amt('99') })).toEqual({ status: 'changed' });
    expect(await h.rungs.begin({ ...input, positionId: 'nope' })).toEqual({ status: 'changed' });
    h.row.status = 'liquidated';
    expect(await h.rungs.begin({ ...input, positionId: 'pos-1' })).toEqual({ status: 'changed' });
  });
});

describe('plan codec', () => {
  it('amounts beyond 2^53 round-trip exactly through the jsonb shape', () => {
    const big = 2n ** 53n + 1n;
    const huge = 123456789012345678901234567890n;
    const plan: RungPlan = {
      recipes: [
        {
          idempotencyKey: 'futures.loss:liq:p:rung:r:loss',
          module: 'trade',
          reason: 'futures.loss.realized',
          meta: { fromMargin: big.toString() },
          entries: [
            {
              account: { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'available' } as never,
              direction: 'credit',
              amount: big,
            },
            {
              account: { ownerType: 'house', ownerId: 'fees', assetId: 'USDT', kind: 'available' } as never,
              direction: 'debit',
              amount: big,
            },
          ],
        },
      ],
      sizeClosed: huge,
      marginRemaining: big,
      marginTaken: huge,
      releaseShort: 0n,
      lossShort: 0n,
      reason: 'ladder_partial',
      fromInsurance: huge,
      marginAsset: 'USDT',
    };
    const viaJson = JSON.parse(JSON.stringify(encodeRungPlan(plan)));
    const back = decodeRungPlan(viaJson);
    expect(back).toEqual(plan);
    expect(back.recipes[0]!.entries[0]!.amount).toBe(big);
    expect(back.sizeClosed).toBe(huge);
  });
});
