/**
 * A LIQUIDATION RUNG POSTS WHAT IT PLANNED, EVEN ON A REPLAY.
 *
 * The recipe keys of a rung do not carry its amounts, and the amounts come from
 * the live mark. A rung that posted and then crashed before the position row
 * moved was re-planned on the next tick at a new mark: the same ledger key with
 * different money (the ledger refuses that now; before, it silently returned the
 * old tx and the row moved by the NEW margin). The plan is stored before the
 * first post so the replay re-posts it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatAmount, parseAmount as amt, type AccountRef, type Amount, type Balance, type PostRequest } from '@intafaced/ledger-client';
import { memoryAcceptedMarkStore } from './accepted-mark.js';
import {
  decodeRungPlan,
  encodeRungPlan,
  memoryLiquidationAttemptStore,
  runLiquidationTick,
  type LiquidationAttemptStore,
  type LiquidationPositionRow,
  type QuotedMarkSource,
  type StoredRungPlan,
} from './liquidation-tick.js';
import type { FuturesLadderPolicy } from './maintenance-ladder.js';
import { sqlLiquidationAttemptStore, sqlPositionReducer } from './tick-stores.js';

const USER = '11111111-1111-4111-8111-111111111111';
const AT = new Date('2026-08-12T14:00:00.000Z');

/** Test-harness ladder (not D3 numbers) so an uncapped partial is reachable. */
const WIDE_POLICY: FuturesLadderPolicy = {
  tiers: [
    { uptoDepthBps: 500, maintenanceBps: 500 },
    { uptoDepthBps: 5_000, maintenanceBps: 800 },
    { uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 1_500 },
  ],
  marginCallBps: 12_000,
  targetBps: 15_000,
  maxTrancheBps: 10_000,
};

function samplePlan(overrides: Partial<StoredRungPlan> = {}): StoredRungPlan {
  const user: AccountRef = { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'position_collateral', subId: 'pos-1' } as AccountRef;
  const house: AccountRef = { ownerType: 'house', ownerId: 'fees:trade', assetId: 'USDT', kind: 'available' } as AccountRef;
  // 1.23e29 scaled units: far beyond 2^53, inside numeric(38,18).
  const big = 123456789012345678901234567890n;
  return {
    recipes: [
      {
        idempotencyKey: 'futures.loss:liq:pos-1:loss:partial:5:10',
        module: 'trade',
        reason: 'futures.loss.realized',
        meta: { positionId: 'pos-1', fromMargin: big.toString() },
        entries: [
          { account: user, direction: 'credit', amount: big },
          { account: house, direction: 'debit', amount: big },
        ],
      },
    ],
    sizeClosed: amt('5.698924731182795699'),
    marginRemaining: amt('60.107526881720430107'),
    reason: 'ladder_partial',
    closesPosition: false,
    ...overrides,
  };
}

describe('rung plan encoding', () => {
  it('round-trips amounts beyond 2^53 through JSON without losing a unit', () => {
    const plan = samplePlan();
    const wire = JSON.parse(JSON.stringify(encodeRungPlan(plan)));
    expect(typeof wire.recipes[0].entries[0].amount).toBe('string');
    expect(typeof wire.sizeClosed).toBe('string');
    const back = decodeRungPlan(wire);
    expect(back).toEqual(plan);
    expect(back.recipes[0]!.entries[0]!.amount).toBe(123456789012345678901234567890n);
    expect(back.recipes[0]!.entries[0]!.amount > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});

describe('memoryLiquidationAttemptStore plans', () => {
  it('savePlan keeps an unfinished plan, replaces a completed one, and loadPlan hides completed plans', async () => {
    const store = memoryLiquidationAttemptStore();
    const first = samplePlan();
    const second = samplePlan({ sizeClosed: amt('7') });
    expect(await store.savePlan!('k', first)).toEqual(first);
    expect(await store.savePlan!('k', second)).toEqual(first);
    await store.completePlan!('k');
    expect(await store.loadPlan!('k')).toBeNull();
    expect(await store.savePlan!('k', second)).toEqual(second);
    expect(await store.loadPlan!('k')).toEqual(second);
  });

  it('loadPlan is null until saved; two racing savePlan calls both return the winner', async () => {
    const store = memoryLiquidationAttemptStore();
    expect(await store.loadPlan!('liq:p:partial:10')).toBeNull();
    const first = samplePlan();
    const second = samplePlan({ sizeClosed: amt('7'), marginRemaining: amt('1') });
    const [a, b] = await Promise.all([store.savePlan!('liq:p:partial:10', first), store.savePlan!('liq:p:partial:10', second)]);
    expect(a).toEqual(first);
    expect(b).toEqual(first);
    expect(await store.loadPlan!('liq:p:partial:10')).toEqual(first);
  });
});

// ── crash-replay through the tick ────────────────────────────────────────────

function underwaterLong(): LiquidationPositionRow {
  return {
    positionId: 'pos-1',
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

function quotedAt(price: { current: string }): QuotedMarkSource {
  return {
    async markPrice() {
      return price.current;
    },
    async quote({ marketId, symbol, at }) {
      return { marketId, symbol, price: amt(price.current), asOf: at, quality: 'mid' };
    },
  };
}

function recordingLedger() {
  const posts: PostRequest[] = [];
  return {
    posts,
    ledger: {
      async post(req: PostRequest) {
        posts.push(req);
        return { id: `tx-${posts.length}`, idempotencyKey: req.idempotencyKey } as never;
      },
      async balance(ref: AccountRef): Promise<Balance> {
        const amount: Amount = ref.ownerType === 'house' && ref.ownerId === 'insurance-fund' ? amt('1000000') : 0n;
        return { account: ref, accountId: `${ref.ownerType}:${ref.ownerId}`, amount };
      },
    },
  };
}

/** A position row the reducer really moves, which crashes on its first reduce when asked to. */
function crashyBook(attempts: LiquidationAttemptStore) {
  const row = underwaterLong();
  const reduced: { sizeClosed: Amount; marginRemaining: Amount; reason: string }[] = [];
  let crashNext = true;
  const price = { current: '93' };
  const { ledger, posts } = recordingLedger();
  const deps = {
    marks: quotedAt(price),
    positions: {
      async listOpen() {
        return [{ ...row }];
      },
    },
    closer: { async markLiquidated() {} },
    attempts,
    acceptedMarks: memoryAcceptedMarkStore(),
    ledger,
    now: () => AT,
    ladder: {
      depth: {
        async depthNotional() {
          return amt('1114000');
        },
      },
      reducer: {
        async reduce(_id: string, input: { sizeClosed: Amount; marginRemaining: Amount; reason: string }) {
          if (crashNext) {
            crashNext = false;
            throw new Error('process died before the row moved');
          }
          reduced.push({ sizeClosed: input.sizeClosed, marginRemaining: input.marginRemaining, reason: input.reason });
          row.size -= input.sizeClosed;
          row.margin = input.marginRemaining;
        },
      },
      policy: WIDE_POLICY,
    },
  };
  return { deps, posts, reduced, price, row };
}

describe('a crashed partial rung is replayed from its stored plan', () => {
  it('tick 2, at a different mark, re-posts tick 1 recipes and reduces by tick 1 amounts', async () => {
    const book = crashyBook(memoryLiquidationAttemptStore());

    const t1 = await runLiquidationTick(book.deps);
    expect(t1.errored).toBe(1);
    expect(t1.items[0]).toMatchObject({ outcome: 'errored', summary: 'process died before the row moved' });
    expect(book.posts).toHaveLength(1);
    expect(book.reduced).toHaveLength(0);

    book.price.current = '92.5';
    const t2 = await runLiquidationTick(book.deps);
    expect(t2.partial).toBe(1);

    // Same key AND same body — the ledger sees one fact, not a conflict.
    expect(book.posts).toHaveLength(2);
    expect(book.posts[1]).toEqual(book.posts[0]);
    // The row moved by what was booked at 93, not by a re-plan at 92.5.
    expect(book.reduced).toHaveLength(1);
    expect(book.reduced[0]!.sizeClosed).toBe(amt('5.698924731182795699'));
    expect(book.reduced[0]!.marginRemaining).toBe(amt('60.107526881720430107'));
    expect(formatAmount(book.row.size)).toBe('4.301075268817204301');
  });

  it('without the plan methods the replay re-plans at the new mark (the defect)', async () => {
    const { loadPlan: _l, savePlan: _s, completePlan: _c, ...legacy } = memoryLiquidationAttemptStore();
    const book = crashyBook(legacy);
    await runLiquidationTick(book.deps);
    book.price.current = '92.5';
    await runLiquidationTick(book.deps);
    expect(book.posts[1]).not.toEqual(book.posts[0]);
    expect(book.reduced[0]!.marginRemaining).not.toBe(amt('60.107526881720430107'));
  });

  it('the next rung on the shrunken row is a new plan, not the finished one', async () => {
    const book = crashyBook(memoryLiquidationAttemptStore());
    await runLiquidationTick(book.deps); // crash
    await runLiquidationTick(book.deps); // replay completes
    const sizeAfterFirst = book.row.size;
    book.price.current = '89';
    await runLiquidationTick(book.deps);
    expect(book.row.size).toBeLessThan(sizeAfterFirst);
    expect(book.posts[2]!.idempotencyKey).not.toBe(book.posts[0]!.idempotencyKey);
  });
});

describe('an unfinished plan is finished before anything is re-decided', () => {
  it('mark recovers between crash and replay: the replay still posts the plan and moves the row', async () => {
    const book = crashyBook(memoryLiquidationAttemptStore());
    await runLiquidationTick(book.deps); // posts at 93, then dies before the row moves
    expect(book.posts).toHaveLength(1);

    book.price.current = '95'; // no longer liquidatable at this mark (a re-plan would skip)
    const t2 = await runLiquidationTick(book.deps);

    expect(t2.items[0]).toMatchObject({ outcome: 'partially_liquidated', reason: 'ladder_partial' });
    expect(book.posts).toHaveLength(2);
    expect(book.posts[1]).toEqual(book.posts[0]);
    expect(book.reduced).toEqual([
      { sizeClosed: amt('5.698924731182795699'), marginRemaining: amt('60.107526881720430107'), reason: 'ladder_partial' },
    ]);
    expect(formatAmount(book.row.size)).toBe('4.301075268817204301');
  });

  it('without the plan methods a recovered mark leaves the booked loss unreflected (the defect)', async () => {
    const { loadPlan: _l, savePlan: _s, completePlan: _c, ...legacy } = memoryLiquidationAttemptStore();
    const book = crashyBook(legacy);
    await runLiquidationTick(book.deps);
    book.price.current = '95';
    await runLiquidationTick(book.deps);
    expect(book.reduced).toHaveLength(0);
    expect(book.row.size).toBe(amt('10'));
  });

  it('a completed plan is not re-executed when the row regrows to the same size', async () => {
    const book = crashyBook(memoryLiquidationAttemptStore());
    await runLiquidationTick(book.deps); // crash
    await runLiquidationTick(book.deps); // replay completes the rung
    expect(book.reduced).toHaveLength(1);
    expect(book.posts).toHaveLength(2);

    // The trader adds size back: the row is again size 10 / margin 100 — the size the finished plan was keyed on.
    book.row.size = amt('10');
    book.row.margin = amt('100');
    book.price.current = '95';
    const t3 = await runLiquidationTick(book.deps);

    expect(t3.items[0]!.outcome).not.toBe('partially_liquidated');
    expect(book.posts).toHaveLength(2);
    expect(book.reduced).toHaveLength(1);
  });

  it('a row that regrows to an earlier size is planned afresh, at the mark of the day', async () => {
    const book = crashyBook(memoryLiquidationAttemptStore());
    await runLiquidationTick(book.deps); // crash
    await runLiquidationTick(book.deps); // completes at 93
    book.row.size = amt('10');
    book.row.margin = amt('100');
    book.price.current = '92.5';
    const t3 = await runLiquidationTick(book.deps);

    expect(t3.items[0]!.outcome).toBe('partially_liquidated');
    expect(book.reduced).toHaveLength(2);
    expect(book.reduced[1]!.sizeClosed).toBe(amt('6.396396396396396397'));
  });

  it('an unfinished closing plan parks as skipped_already, as a failed claim does', async () => {
    const attempts = memoryLiquidationAttemptStore();
    await attempts.savePlan!('liq:pos-1', samplePlan({ closesPosition: true }));
    const book = crashyBook(attempts);
    const t = await runLiquidationTick(book.deps);
    expect(t.items[0]).toMatchObject({ outcome: 'skipped_already', reason: 'already_done' });
    expect(book.posts).toHaveLength(0);
  });
});

// ── sql store against a fake sql (same style as tick-stores.test.ts) ─────────

describe('sqlLiquidationAttemptStore plans (fake sql)', () => {
  /** Models the three cases of the one statement; the SQL itself is proven on real Postgres below. */
  function planSql() {
    const rows = new Map<string, { plan: unknown; completed: boolean }>();
    const calls: { text: string; values: unknown[] }[] = [];
    const fn = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join('?').toLowerCase();
        calls.push({ text, values });
        if (text.includes('insert into trade.liquidation_rung_plans')) {
          const [key, plan] = values as [string, unknown];
          const existing = rows.get(key);
          if (!existing || existing.completed) rows.set(key, { plan, completed: false });
          return Promise.resolve([{ plan: rows.get(key)!.plan }]);
        }
        if (text.includes('update trade.liquidation_rung_plans')) {
          const existing = rows.get(values[0] as string);
          if (existing) existing.completed = true;
          return Promise.resolve([]);
        }
        if (text.includes('from trade.liquidation_rung_plans')) {
          const existing = rows.get(values[0] as string);
          return Promise.resolve(existing && !existing.completed ? [{ plan: existing.plan }] : []);
        }
        return Promise.resolve([]);
      },
      { json: (v: unknown) => JSON.parse(JSON.stringify(v)) },
    );
    return { sql: fn as unknown as import('postgres').Sql, calls };
  }

  it('completePlan retires a plan; savePlan then replaces it, but keeps an unfinished one', async () => {
    const { sql } = planSql();
    const store = sqlLiquidationAttemptStore(sql);
    const first = samplePlan();
    const second = samplePlan({ sizeClosed: amt('7') });
    expect(await store.savePlan!('k', first)).toEqual(first);
    expect(await store.savePlan!('k', second)).toEqual(first);
    await store.completePlan!('k');
    expect(await store.loadPlan!('k')).toBeNull();
    expect(await store.savePlan!('k', second)).toEqual(second);
  });

  it('savePlan stores the amounts as strings and loadPlan hands back bigints', async () => {
    const { sql, calls } = planSql();
    const store = sqlLiquidationAttemptStore(sql);
    expect(await store.loadPlan!('k')).toBeNull();
    const plan = samplePlan();
    expect(await store.savePlan!('k', plan)).toEqual(plan);
    const written = calls.find((c) => c.text.includes('insert into trade.liquidation_rung_plans'))!.values[1] as ReturnType<
      typeof encodeRungPlan
    >;
    expect(written.recipes[0]!.entries[0]!.amount).toBe(formatAmount(123456789012345678901234567890n));
    expect(await store.loadPlan!('k')).toEqual(plan);
  });

  it('two racing savePlan calls return the same row', async () => {
    const { sql, calls } = planSql();
    const store = sqlLiquidationAttemptStore(sql);
    const first = samplePlan();
    const second = samplePlan({ marginRemaining: amt('1') });
    const [a, b] = await Promise.all([store.savePlan!('k', first), store.savePlan!('k', second)]);
    expect(a).toEqual(first);
    expect(b).toEqual(first);
    expect(calls.find((c) => c.text.includes('insert into trade.liquidation_rung_plans'))!.text).toContain('on conflict (rung_key)');
  });
});

// ── real Postgres ────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

describe('sqlLiquidationAttemptStore plans (real Postgres, migration 0050)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;

  beforeAll(async () => {
    const envUrl = process.env.TEST_DATABASE_URL?.trim();
    let url = envUrl;
    if (!url) {
      const container = await new PostgreSqlContainer('postgres:16-alpine').start();
      url = container.getConnectionUri();
      stop = async () => {
        await container.stop();
      };
    }
    db = await createTestDatabase({ service: 'trade', url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 30_000);

  it('round-trips a plan with a bigint past 2^53 and returns the winner of a real race', async () => {
    const store = sqlLiquidationAttemptStore(db!.sql);
    expect(await store.loadPlan!('liq:real:partial:10')).toBeNull();
    const first = samplePlan();
    const second = samplePlan({ sizeClosed: amt('7') });
    const [a, b] = await Promise.all([store.savePlan!('liq:real:partial:10', first), store.savePlan!('liq:real:partial:10', second)]);
    expect(a).toEqual(b);
    expect([first, second]).toContainEqual(a);
    const loaded = await store.loadPlan!('liq:real:partial:10');
    expect(loaded).toEqual(a);
    expect(loaded!.recipes[0]!.entries[0]!.amount).toBe(123456789012345678901234567890n);
  });

  it('savePlan keeps an unfinished plan and replaces a completed one; loadPlan returns only unfinished', async () => {
    const store = sqlLiquidationAttemptStore(db!.sql);
    const key = 'liq:real:lifecycle';
    const first = samplePlan();
    const second = samplePlan({ sizeClosed: amt('7'), marginRemaining: amt('1') });
    expect(await store.savePlan!(key, first)).toEqual(first);
    expect(await store.savePlan!(key, second)).toEqual(first); // unfinished wins
    await store.completePlan!(key);
    expect(await store.loadPlan!(key)).toBeNull();
    const [completedRow] = await db!.sql`SELECT completed_at FROM trade.liquidation_rung_plans WHERE rung_key = ${key}`;
    expect(completedRow!.completed_at).not.toBeNull();
    expect(await store.savePlan!(key, second)).toEqual(second); // completed is replaced and reopened
    expect(await store.loadPlan!(key)).toEqual(second);
    const [reopened] = await db!.sql`SELECT completed_at FROM trade.liquidation_rung_plans WHERE rung_key = ${key}`;
    expect(reopened!.completed_at).toBeNull();
    // Completing is idempotent and a second plan after it still wins cleanly.
    await store.completePlan!(key);
    await store.completePlan!(key);
    expect(await store.loadPlan!(key)).toBeNull();
  });
  it('the reducer shrinks a row once when two workers replay one plan (expectedSize guard)', async () => {
    const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
    const USER = '11111111-1111-4111-8111-111111111112';
    const sql = db!.sql;
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        ${MARKET}, 'RED/USDT-PERP', 'RED', 'USDT', 'futures',
        '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'RED Perpetual', now()
      )
    `;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO trade.positions (user_id, market_id, side, status, margin_mode, size, entry_price, leverage,
        margin_initial, margin_current, margin_asset, funding_paid)
      VALUES (${USER}, ${MARKET}, 'long', 'open', 'isolated', '10', '100', '5', '200', '200', 'USDT', '0')
      RETURNING id
    `;
    const reducer = sqlPositionReducer(sql);
    const input = { liquidationId: 'liq:x', sizeClosed: amt('4'), marginRemaining: amt('120'), reason: 'ladder', expectedSize: amt('10') };
    await Promise.all([reducer.reduce(row!.id, input), reducer.reduce(row!.id, input)]);
    const [after] = await sql<{ size: string }[]>`SELECT size FROM trade.positions WHERE id = ${row!.id}`;
    expect(Number(after!.size)).toBe(6);
  });
});
