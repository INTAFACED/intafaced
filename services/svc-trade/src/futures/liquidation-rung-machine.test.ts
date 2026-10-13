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
import { formatAmount, parseAmount as amt, type AccountRef, type Amount, type PostRequest } from '@intafaced/ledger-client';
import { memoryAcceptedMarkStore } from './accepted-mark.js';
import {
  memoryLiquidationAttemptStore,
  runLiquidationTick,
  type LiquidationPositionRow,
  type LiquidationTickDeps,
} from './liquidation-tick.js';
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

function harness(opts: { insurance?: Amount } = {}) {
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
  const posts: PostRequest[] = [];
  const booked = new Map<string, PostRequest>();
  const reduces: { sizeClosed: string; marginRemaining: string }[] = [];
  const announced: string[] = [];
  const hooks: { beforePost?: (req: PostRequest) => void | Promise<void> } = {};

  const book: RungRowBook = {
    read: (id) => (id === row.positionId ? { status: row.status, size: row.size, margin: row.margin } : null),
    reduce: (_id, closed, remaining) => {
      reduces.push({ sizeClosed: formatAmount(closed), marginRemaining: formatAmount(remaining) });
      row.size -= closed;
      row.margin = remaining;
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
        const amount = ref.ownerType === 'house' && ref.ownerId === 'insurance-fund' ? insurance.available : amt('1000000');
        return { account: ref, accountId: 'x', amount };
      },
      async getTxByKey(key: string) {
        return booked.has(key) ? ({ id: `tx:${key}`, idempotencyKey: key } as never) : null;
      },
    },
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
  return { deps, row, price, posts, booked, reduces, announced, hooks, rungs, attempts, marginTaken, lossKeys, snapshot, insurance };
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
  it('the row changed between the post and the apply: rung abandoned, outcome errored with the distinct code, not counted partial', async () => {
    const h = harness();
    h.hooks.beforePost = () => {
      // The trader's own change lands while the loss is being booked.
      h.row.size = amt('9');
    };
    const t = await runLiquidationTick(h.deps);
    expect(t.items[0]).toMatchObject({ outcome: 'errored', reason: 'trade.liquidation_row_changed_after_post' });
    expect(t.errored).toBe(1);
    expect(t.partial).toBe(0);
    expect(h.reduces).toHaveLength(0);
    expect(h.rungs.all().map((r) => r.state)).toEqual(['abandoned']);
    expect(h.row.size).toBe(amt('9')); // the rung did not touch a row it was not planned against
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
    expect(t.items[0]).toMatchObject({ outcome: 'errored', reason: 'trade.liquidation_tick_error' });
    expect(h.row.status).toBe('liquidated');
    expect(await h.attempts.isDone('liq:pos-1')).toBe(true);
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

    h.insurance.available = 0n;
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
    reason: 'ladder_partial',
    fromInsurance: 0n,
    marginAsset: 'USDT',
  });

  it('a second begin on a position with a live rung gets the first rung back, whatever the row looks like', async () => {
    const h = harness();
    const input = { positionId: 'pos-1', kind: 'partial' as const, fromSize: amt('10'), fromMargin: amt('100'), plan: plan() };
    const a = await h.rungs.begin({ ...input, rungId: 'r-a' });
    const b = await h.rungs.begin({ ...input, rungId: 'r-b' });
    expect(a.status).toBe('created');
    expect(b).toMatchObject({ status: 'live', rung: { rungId: 'r-a' } });
  });

  it('begin refuses a snapshot that is not the row, a closed row, and a missing row', async () => {
    const h = harness();
    const input = { rungId: 'r-1', kind: 'partial' as const, fromSize: amt('10'), fromMargin: amt('100'), plan: plan() };
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
