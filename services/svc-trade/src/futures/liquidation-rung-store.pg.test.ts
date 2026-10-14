/**
 * THE RUNG STATE MACHINE AGAINST REAL POSTGRES.
 *
 * `liquidation-rung-machine.test.ts` proves the laws against a memory model of
 * the store. This file proves the model is honest: the row lock, the one-live-rung
 * unique index and the single transaction that moves the row AND the rung are
 * Postgres facts, and a mock can only assert that statements were issued.
 *
 * H8a PG-hard: never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run `createTestDatabase`). Local without that env starts
 * Testcontainers `postgres:16-alpine`; Docker/PG down is a failed suite.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { formatAmount, InsufficientFundsError, parseAmount as amt, type AccountRef, type PostRequest } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryAcceptedMarkStore } from './accepted-mark.js';
import { ABANDONED_PARKED, runLiquidationTick, type LiquidationTickDeps } from './liquidation-tick.js';
import { sqlLiquidationPositionLoader } from './position-loaders.js';
import type { RungPlan } from './liquidation-rungs.js';
import { sqlLiquidationAttemptStore, sqlLiquidationRungStore, sqlPositionCloser, sqlPositionReducer } from './tick-stores.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));
const H8A_IMAGE = 'postgres:16-alpine';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-trade liquidation-rung-store is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
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
const money = (v: string) => formatAmount(amt(v));

describe('src: this suite is not skip-green', () => {
  it('has no postgresAvailable / describe.skip / it.skip', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('liquidation rungs (Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let userSeq = 0;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    userSeq = 0;
    pot.amount = amt('1000000');
    await sql`TRUNCATE trade.positions, trade.fills, trade.orders, trade.markets, trade.liquidation_rungs, trade.liquidation_attempts RESTART IDENTITY CASCADE`;
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        ${MARKET}, 'BTC/USDT-PERP', 'BTC', 'USDT', 'futures',
        '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC Perpetual', now()
      )
    `;
  });

  /** One open long: size 10, entry 100, margin 100 — at mark 93 it is partially liquidated, at 60 it is closed. */
  async function openPosition(size = '10', margin = '100'): Promise<string> {
    const user = `11111111-1111-4111-8111-${String(++userSeq).padStart(12, '0')}`;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO trade.positions (
        user_id, market_id, side, status, margin_mode, size, entry_price, leverage,
        margin_initial, margin_current, margin_asset, funding_paid
      ) VALUES (${user}, ${MARKET}, 'long', 'open', 'isolated', ${size}, '100', '5', ${margin}, ${margin}, 'USDT', '0')
      RETURNING id
    `;
    return row!.id;
  }
  const readRow = async (id: string) => {
    const [r] = await sql<{ status: string; size: string; margin_current: string }[]>`
      SELECT status, size, margin_current FROM trade.positions WHERE id = ${id}
    `;
    return { status: r!.status, size: money(r!.size), margin: money(r!.margin_current) };
  };
  const rungStates = async (id: string) =>
    (
      await sql<
        { state: string; kind: string }[]
      >`SELECT state, kind FROM trade.liquidation_rungs WHERE position_id = ${id} ORDER BY created_at, rung_id`
    ).map((r) => `${r.kind}:${r.state}`);

  const pot = { amount: amt('1000000') };

  function fixture(opts: { price?: { current: string }; bus?: { published: unknown[] } } = {}) {
    const price = opts.price ?? { current: '93' };
    const posts: PostRequest[] = [];
    const booked = new Map<string, PostRequest>();
    const hooks: { beforePost?: (req: PostRequest) => void | Promise<void> } = {};
    const bus = opts.bus
      ? ({
          async publish(name: string, payload: unknown, o: unknown) {
            opts.bus!.published.push({ name, payload, o });
            return {} as never;
          },
        } as never)
      : null;
    const deps: LiquidationTickDeps = {
      marks: {
        async markPrice() {
          return price.current;
        },
        async quote({ marketId, symbol, at }) {
          return { marketId, symbol, price: amt(price.current), asOf: at, quality: 'mid' };
        },
      },
      positions: sqlLiquidationPositionLoader(sql),
      closer: sqlPositionCloser(sql, bus),
      attempts: sqlLiquidationAttemptStore(sql),
      rungs: sqlLiquidationRungStore(sql),
      acceptedMarks: memoryAcceptedMarkStore(),
      ledger: {
        async post(req) {
          await hooks.beforePost?.(req);
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
            throw Object.assign(new Error(`key ${req.idempotencyKey} reused with a different body`), {
              code: 'ledger.idempotency_conflict',
            });
          }
          booked.set(req.idempotencyKey, req);
          return { id: `tx:${req.idempotencyKey}`, idempotencyKey: req.idempotencyKey } as never;
        },
        async balance(ref: AccountRef) {
          return { account: ref, accountId: 'x', amount: ref.kind === 'collateral' ? pot.amount : amt('1000000') };
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
        reducer: sqlPositionReducer(sql),
      },
    };
    const lossKeys = () => [...booked.keys()].filter((k) => k.startsWith('futures.loss:'));
    const marginTaken = () =>
      [...booked.values()]
        .filter((p) => p.reason === 'futures.loss.realized')
        .reduce(
          (sum, p) =>
            sum + p.entries.filter((e) => e.direction === 'credit' && e.account.ownerType === 'user').reduce((s, e) => s + e.amount, 0n),
          0n,
        );
    return { deps, price, posts, booked, hooks, lossKeys, marginTaken };
  }

  it('happy path: the loss key carries the rung id, the row and the rung move together', async () => {
    const id = await openPosition();
    const f = fixture();
    const t = await runLiquidationTick(f.deps);
    expect(t.items.map((i) => i.outcome)).toEqual(['partially_liquidated']);
    const [rung] = await sql<{ rung_id: string; from_size: string; from_margin: string }[]>`
      SELECT rung_id, from_size, from_margin FROM trade.liquidation_rungs WHERE position_id = ${id}
    `;
    expect(f.lossKeys()).toEqual([`futures.loss:liq:${id}:rung:${rung!.rung_id}:loss`]);
    expect(money(rung!.from_size)).toBe(money('10'));
    expect(await rungStates(id)).toEqual(['partial:applied']);
    const after = await readRow(id);
    expect(after.size).not.toBe(money('10'));
    expect(amt(after.size)).toBeLessThan(amt('10'));
    expect(amt('100') - amt(after.margin)).toBe(f.marginTaken());
  });

  it('two ticks racing on one position book exactly one loss and one reduction (20 positions, 2 workers each)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await openPosition());
    const fa = fixture();
    const fb = fixture();
    // One shared ledger: a second book would hide a double post.
    fb.deps.ledger = fa.deps.ledger;
    const [a, b] = await Promise.all([runLiquidationTick(fa.deps), runLiquidationTick(fb.deps)]);
    expect(a.errored + b.errored).toBe(0);
    expect(fa.lossKeys()).toHaveLength(20);
    for (const id of ids) {
      expect(await rungStates(id)).toEqual(['partial:applied']);
    }
    // One reduction per position, and the ledger took exactly what the rows lost.
    let rowLoss = 0n;
    for (const id of ids) rowLoss += amt('100') - amt((await readRow(id)).margin);
    expect(fa.marginTaken()).toBe(rowLoss);
    const sizes = new Set<string>();
    for (const id of ids) sizes.add((await readRow(id)).size);
    expect(sizes.size).toBe(1);
  });

  it('a worker with a stale listOpen snapshot refuses (skipped_changed) and books nothing', async () => {
    const id = await openPosition();
    const stale = await sqlLiquidationPositionLoader(sql).listOpen();
    const f = fixture();
    await runLiquidationTick(f.deps);
    const keys = f.lossKeys();
    const taken = f.marginTaken();

    f.price.current = '92.5';
    const t = await runLiquidationTick({
      ...f.deps,
      positions: {
        async listOpen() {
          return stale;
        },
      },
    });
    expect(t.items.map((i) => i.outcome)).toEqual(['skipped_changed']);
    expect(f.lossKeys()).toEqual(keys);
    expect(f.marginTaken()).toBe(taken);
    expect(await rungStates(id)).toEqual(['partial:applied']);
    expect(amt('100') - amt((await readRow(id)).margin)).toBe(taken);
  });

  it('a position the trader closed between the read and the lock is skipped_changed', async () => {
    const id = await openPosition();
    const stale = await sqlLiquidationPositionLoader(sql).listOpen();
    await sql`UPDATE trade.positions SET status = 'closed', closed_at = now() WHERE id = ${id}`;
    const f = fixture();
    const t = await runLiquidationTick({
      ...f.deps,
      positions: {
        async listOpen() {
          return stale;
        },
      },
    });
    expect(t.items.map((i) => i.outcome)).toEqual(['skipped_changed']);
    expect(f.posts).toHaveLength(0);
    expect(await rungStates(id)).toEqual([]);
  });

  it('regrow to the same size at the same mark: a different rung id, a different key, its own loss', async () => {
    const id = await openPosition();
    const f = fixture();
    await runLiquidationTick(f.deps);
    await sql`UPDATE trade.positions SET size = '10', margin_current = '100' WHERE id = ${id}`;
    const t2 = await runLiquidationTick(f.deps);
    expect(t2.items.map((i) => i.outcome)).toEqual(['partially_liquidated']);
    expect(new Set(f.lossKeys()).size).toBe(2);
    expect(await rungStates(id)).toEqual(['partial:applied', 'partial:applied']);
    expect(f.marginTaken()).toBe(2n * (amt('100') - amt((await readRow(id)).margin)));
  });

  it('F: the trader adds 50 margin while the loss is being booked: applied as a delta, ledger and row agree, loss booked once', async () => {
    const id = await openPosition();
    const f = fixture();
    let once = true;
    f.hooks.beforePost = async () => {
      if (once) {
        once = false;
        await sql`UPDATE trade.positions SET margin_current = margin_current + 50 WHERE id = ${id}`;
      }
    };
    const t = await runLiquidationTick(f.deps);
    expect(t.items.map((i) => i.outcome)).toEqual(['partially_liquidated']);
    expect(await rungStates(id)).toEqual(['partial:applied']);
    expect(amt((await readRow(id)).margin)).toBe(amt('150') - f.marginTaken());
    expect(f.lossKeys()).toHaveLength(1);
  });

  it('H: crash after the post, funding takes 1 before the restart: the replay applies the delta, loss booked once', async () => {
    const id = await openPosition();
    const f = fixture();
    const realApply = f.deps.rungs!.apply;
    let crash = true;
    f.deps.rungs!.apply = async (...args) => {
      if (crash) {
        crash = false;
        throw new Error('died before apply');
      }
      return realApply(...args);
    };
    await runLiquidationTick(f.deps);
    await sql`UPDATE trade.positions SET margin_current = GREATEST(margin_current - 1, 0) WHERE id = ${id}`; // funding
    const t2 = await runLiquidationTick(f.deps);
    expect(t2.items.map((i) => i.outcome)).toEqual(['partially_liquidated']);
    expect(f.lossKeys()).toHaveLength(1);
    expect(await rungStates(id)).toEqual(['partial:applied']);
    expect(amt((await readRow(id)).margin) + f.marginTaken()).toBe(amt('99'));
  });

  it('a row that cannot be reconciled (no larger than the tranche): abandoned in the table, errored, and the position is parked', async () => {
    const id = await openPosition();
    const f = fixture();
    f.hooks.beforePost = async () => {
      await sql`UPDATE trade.positions SET size = '0.1' WHERE id = ${id}`;
    };
    const t = await runLiquidationTick(f.deps);
    expect(t.items[0]).toMatchObject({ outcome: 'errored', reason: 'trade.liquidation_row_changed_after_post' });
    expect(t.partial).toBe(0);
    expect(await rungStates(id)).toEqual(['partial:abandoned']);
    expect(await readRow(id)).toEqual({ status: 'open', size: money('0.1'), margin: money('100') });

    f.hooks.beforePost = undefined;
    const posts = f.posts.length;
    for (let i = 0; i < 2; i++) {
      const t2 = await runLiquidationTick(f.deps);
      expect(t2.items[0]).toMatchObject({ outcome: 'skipped_already', reason: ABANDONED_PARKED });
      expect(t2.parked).toBe(1);
    }
    expect(f.posts.length).toBe(posts);
    expect(await rungStates(id)).toEqual(['partial:abandoned']);

    // An operator reconciles by hand and releases the park.
    await sql`UPDATE trade.liquidation_rungs SET state = 'resolved' WHERE position_id = ${id}`;
    await sql`UPDATE trade.positions SET size = '10', margin_current = '100' WHERE id = ${id}`;
    const t3 = await runLiquidationTick(f.deps);
    expect(t3.items.map((i) => i.outcome)).toEqual(['partially_liquidated']);
  });

  it('I: the trader adds 50 margin while a closing rung posts: the row still closes, drift +50 is stored and alerted', async () => {
    const id = await openPosition();
    const f = fixture({ price: { current: '60' } });
    let once = true;
    f.hooks.beforePost = async () => {
      if (once) {
        once = false;
        await sql`UPDATE trade.positions SET margin_current = margin_current + 50 WHERE id = ${id}`;
      }
    };
    const t = await runLiquidationTick(f.deps);
    expect(t.items[0]).toMatchObject({ outcome: 'liquidated', alert: { code: 'trade.liquidation_margin_drift', amount: '50' } });
    expect((await readRow(id)).status).toBe('liquidated');
    expect(await rungStates(id)).toEqual(['closing:applied']);
    const [r] = await sql<{ margin_drift: string }[]>`SELECT margin_drift FROM trade.liquidation_rungs WHERE position_id = ${id}`;
    expect(money(r!.margin_drift)).toBe(money('50'));
  });

  it('funding takes 1 between a closing rung post and apply: the row closes, drift -1', async () => {
    const id = await openPosition();
    const f = fixture({ price: { current: '60' } });
    const realApply = f.deps.rungs!.apply;
    let crash = true;
    f.deps.rungs!.apply = async (...args) => {
      if (crash) {
        crash = false;
        throw new Error('died before apply');
      }
      return realApply(...args);
    };
    await runLiquidationTick(f.deps);
    await sql`UPDATE trade.positions SET margin_current = margin_current - 1 WHERE id = ${id}`;
    const t2 = await runLiquidationTick(f.deps);
    expect(t2.items[0]).toMatchObject({ outcome: 'liquidated', alert: { code: 'trade.liquidation_margin_drift', amount: '-1' } });
    expect((await readRow(id)).status).toBe('liquidated');
  });

  it('a closing rung whose SIZE changed is abandoned and parks the position', async () => {
    const id = await openPosition();
    const f = fixture({ price: { current: '60' } });
    const realApply = f.deps.rungs!.apply;
    let crash = true;
    f.deps.rungs!.apply = async (...args) => {
      if (crash) {
        crash = false;
        throw new Error('died before apply');
      }
      return realApply(...args);
    };
    await runLiquidationTick(f.deps);
    await sql`UPDATE trade.positions SET size = '9' WHERE id = ${id}`;
    const t2 = await runLiquidationTick(f.deps);
    expect(t2.items[0]).toMatchObject({ outcome: 'errored', reason: 'trade.liquidation_row_changed_after_post' });
    expect((await readRow(id)).status).toBe('open');
    const t3 = await runLiquidationTick(f.deps);
    expect(t3.items[0]).toMatchObject({ outcome: 'skipped_already', reason: ABANDONED_PARKED });
  });

  it('K: funding took 70 before a partial rung applied: it applies, floors at 0 and stores/alerts the shortfall', async () => {
    const id = await openPosition();
    const f = fixture();
    const realApply = f.deps.rungs!.apply;
    let crash = true;
    f.deps.rungs!.apply = async (...args) => {
      if (crash) {
        crash = false;
        throw new Error('died before apply');
      }
      return realApply(...args);
    };
    await runLiquidationTick(f.deps);
    await sql`UPDATE trade.positions SET margin_current = margin_current - 70 WHERE id = ${id}`;
    const t2 = await runLiquidationTick(f.deps);
    const shortfall = amt('30') - f.marginTaken();
    expect(t2.items[0]).toMatchObject({
      outcome: 'partially_liquidated',
      alert: { code: 'trade.liquidation_margin_clipped', amount: formatAmount(shortfall) },
    });
    expect((await readRow(id)).margin).toBe(money('0'));
    const [r] = await sql<{ margin_drift: string }[]>`SELECT margin_drift FROM trade.liquidation_rungs WHERE position_id = ${id}`;
    expect(amt(r!.margin_drift)).toBe(shortfall);
  });

  describe('probe L: a short margin release is amended, never left open', () => {
    const potOf = (user: string, id: string) =>
      ({ ownerType: 'user', ownerId: user, assetId: 'USDT', kind: 'collateral', purpose: `position:${id}` }) as unknown as AccountRef;
    const avail = (user: string) => ({ ownerType: 'user', ownerId: user, assetId: 'USDT', kind: 'available' }) as unknown as AccountRef;
    const fees = { ownerType: 'house', ownerId: 'fees:trade', assetId: 'USDT', kind: 'available' } as unknown as AccountRef;

    async function storedClosingRung(id: string) {
      const user_id = (await sql<{ user_id: string }[]>`SELECT user_id FROM trade.positions WHERE id = ${id}`)[0]!.user_id;
      const loss: PostRequest = {
        idempotencyKey: `futures.loss:liq:${id}:rung:r1:loss`,
        module: 'trade',
        reason: 'futures.loss.realized',
        entries: [
          { account: potOf(user_id, id), direction: 'credit', amount: amt('70') },
          { account: fees, direction: 'debit', amount: amt('70') },
        ],
      };
      const release: PostRequest = {
        idempotencyKey: `futures.margin.release:${id}:rung:r1`,
        module: 'trade',
        reason: 'futures.margin.release',
        entries: [
          { account: potOf(user_id, id), direction: 'credit', amount: amt('30') },
          { account: avail(user_id), direction: 'debit', amount: amt('30') },
        ],
      };
      const store = sqlLiquidationRungStore(sql);
      const r = await store.begin({
        rungId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        positionId: id,
        liquidationId: `liq:${id}`,
        kind: 'closing',
        fromSize: amt('10'),
        fromMargin: amt('100'),
        plan: {
          recipes: [loss, release],
          sizeClosed: amt('10'),
          marginRemaining: 0n,
          marginTaken: amt('70'),
          releaseShort: 0n,
          lossShort: 0n,
          reason: 'ladder_full_close',
          fromInsurance: 0n,
          marginAsset: 'USDT',
        },
      });
      expect(r.status).toBe('created');
    }

    it('funding took 5 before the release posted: amended to the pot, row closed, shortfall persisted in the plan and alerted', async () => {
      const id = await openPosition();
      await storedClosingRung(id);
      await sql`UPDATE trade.positions SET margin_current = margin_current - 5 WHERE id = ${id}`;
      pot.amount = amt('95');
      const f = fixture();
      const t = await runLiquidationTick(f.deps);
      expect(t.items[0]).toMatchObject({ outcome: 'liquidated', releaseShort: { code: 'trade.liquidation_release_short', amount: '5' } });
      expect((await readRow(id)).status).toBe('liquidated');
      expect(await rungStates(id)).toEqual(['closing:applied']);
      const release = [...f.booked.values()].find((p) => p.reason === 'futures.margin.release')!;
      expect(release.entries.map((e) => e.amount)).toEqual([amt('25'), amt('25')]);
      const [r] = await sql<{ plan: { releaseShort: string }; margin_drift: string }[]>`
        SELECT plan, margin_drift FROM trade.liquidation_rungs WHERE position_id = ${id}`;
      expect(r!.plan.releaseShort).toBe(amt('5').toString());
      expect(money(r!.margin_drift)).toBe(money('-5'));
    });

    it('crash after the amendment is persisted: the replay posts the amended body byte for byte', async () => {
      const id = await openPosition();
      await storedClosingRung(id);
      pot.amount = amt('95');
      const f = fixture();
      let crash = true;
      const real = f.deps.ledger.post;
      f.deps.ledger.post = async (req) => {
        if (crash && req.reason === 'futures.margin.release' && req.entries[0]!.amount === amt('25')) {
          crash = false;
          throw new Error('died right after amending');
        }
        return real(req);
      };
      const t1 = await runLiquidationTick(f.deps);
      expect(t1.items[0]!.outcome).toBe('errored');
      const [stored] = await sql<{ plan: { recipes: { reason: string; entries: { amount: string }[] }[] } }[]>`
        SELECT plan FROM trade.liquidation_rungs WHERE position_id = ${id}`;
      expect(stored!.plan.recipes.find((r) => r.reason === 'futures.margin.release')!.entries[0]!.amount).toBe(amt('25').toString());
      expect(await rungStates(id)).toEqual(['closing:planned']);

      const t2 = await runLiquidationTick(f.deps);
      expect(t2.items[0]).toMatchObject({ outcome: 'liquidated', releaseShort: { amount: '5' } });
      expect((await readRow(id)).status).toBe('liquidated');
      const release = [...f.booked.values()].find((p) => p.reason === 'futures.margin.release')!;
      expect(release.entries[0]!.amount).toBe(amt('25'));
    });

    it('an empty pot: the release is skipped and the row still closes', async () => {
      const id = await openPosition();
      await storedClosingRung(id);
      pot.amount = amt('70');
      const f = fixture();
      const t = await runLiquidationTick(f.deps);
      expect(t.items[0]).toMatchObject({ outcome: 'liquidated', releaseShort: { amount: '30' } });
      expect((await readRow(id)).status).toBe('liquidated');
      expect([...f.booked.values()].some((p) => p.reason === 'futures.margin.release')).toBe(false);
    });

    it('M: bankrupt closing rung, funding left the pot at 99: the loss is re-split 99 + 61 insurance and the position closes', async () => {
      const id = await openPosition();
      const user_id = (await sql<{ user_id: string }[]>`SELECT user_id FROM trade.positions WHERE id = ${id}`)[0]!.user_id;
      const loss: PostRequest = {
        idempotencyKey: `futures.loss:liq:${id}:rung:r1:loss`,
        module: 'trade',
        reason: 'futures.loss.realized',
        entries: [
          { account: potOf(user_id, id), direction: 'credit', amount: amt('100') },
          {
            account: { ownerType: 'house', ownerId: 'insurance-fund', assetId: 'USDT', kind: 'available' } as unknown as AccountRef,
            direction: 'credit',
            amount: amt('60'),
          },
          { account: fees, direction: 'debit', amount: amt('160') },
        ],
      };
      const begun = await sqlLiquidationRungStore(sql).begin({
        rungId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        positionId: id,
        liquidationId: `liq:${id}`,
        kind: 'closing',
        fromSize: amt('10'),
        fromMargin: amt('100'),
        plan: {
          recipes: [loss],
          sizeClosed: amt('10'),
          marginRemaining: 0n,
          marginTaken: amt('100'),
          releaseShort: 0n,
          lossShort: 0n,
          reason: 'bankrupt_full_close',
          fromInsurance: amt('60'),
          marginAsset: 'USDT',
        },
      });
      await sql`UPDATE trade.positions SET margin_current = 99 WHERE id = ${id}`; // funding, after the rung was stored
      expect(begun.status).toBe('created');
      pot.amount = amt('99');
      const f = fixture();
      const t = await runLiquidationTick(f.deps);
      expect(t.items[0]).toMatchObject({ outcome: 'liquidated' });
      expect((await readRow(id)).status).toBe('liquidated');
      const booked = [...f.booked.values()][0]!;
      expect(booked.entries.map((e) => `${e.direction}:${e.account.kind}:${formatAmount(e.amount)}`)).toEqual([
        'credit:collateral:99',
        'credit:available:61',
        'debit:available:160',
      ]);
      const [r] = await sql<{ plan: { fromInsurance: string }; plan_version: number }[]>`
        SELECT plan, plan_version FROM trade.liquidation_rungs WHERE position_id = ${id}`;
      expect(r!.plan.fromInsurance).toBe(amt('61').toString());
      expect(r!.plan_version).toBe(1);
    });

    it('a PARTIAL rung whose pot shrank books the loss for what the pot holds and records lossShort', async () => {
      const id = await openPosition();
      const user_id = (await sql<{ user_id: string }[]>`SELECT user_id FROM trade.positions WHERE id = ${id}`)[0]!.user_id;
      await sql`UPDATE trade.positions SET margin_current = 30 WHERE id = ${id}`;
      const loss: PostRequest = {
        idempotencyKey: `futures.loss:liq:${id}:rung:r1:loss`,
        module: 'trade',
        reason: 'futures.loss.realized',
        entries: [
          { account: potOf(user_id, id), direction: 'credit', amount: amt('40') },
          { account: fees, direction: 'debit', amount: amt('40') },
        ],
      };
      await sqlLiquidationRungStore(sql).begin({
        rungId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        positionId: id,
        liquidationId: `liq:${id}`,
        kind: 'partial',
        fromSize: amt('10'),
        fromMargin: amt('30'),
        plan: {
          recipes: [loss],
          sizeClosed: amt('4'),
          marginRemaining: 0n,
          marginTaken: amt('40'),
          releaseShort: 0n,
          lossShort: 0n,
          reason: 'ladder_partial',
          fromInsurance: 0n,
          marginAsset: 'USDT',
        },
      });
      pot.amount = amt('30');
      const f = fixture();
      const t = await runLiquidationTick(f.deps);
      expect(t.items[0]).toMatchObject({
        outcome: 'partially_liquidated',
        lossShort: { code: 'trade.liquidation_loss_short', amount: '10' },
      });
      expect(await readRow(id)).toEqual({ status: 'open', size: money('6'), margin: money('0') });
    });

    it("amendPlan is a compare-and-set: a stale version loses, and the winner's plan stands", async () => {
      const id = await openPosition();
      await storedClosingRung(id);
      const store = sqlLiquidationRungStore(sql);
      const live = (await store.findLive(id))!;
      expect(live.planVersion).toBe(0);
      const [a, b] = await Promise.all([
        store.amendPlan(live.rungId, { ...live.plan, releaseShort: amt('5') }, 0),
        store.amendPlan(live.rungId, { ...live.plan, releaseShort: amt('9') }, 0),
      ]);
      expect([a, b].filter((v) => v === 1)).toHaveLength(1);
      expect([a, b].filter((v) => v === null)).toHaveLength(1);
      const after = (await store.findLive(id))!;
      expect(after.planVersion).toBe(1);
      expect([amt('5'), amt('9')]).toContain(after.plan.releaseShort);
    });

    it('amendPlan only writes to a rung that is still planned', async () => {
      const id = await openPosition();
      await storedClosingRung(id);
      const store = sqlLiquidationRungStore(sql);
      const live = (await store.findLive(id))!;
      expect(await store.amendPlan(live.rungId, { ...live.plan, releaseShort: amt('1') }, 0)).toBe(1);
      await store.markPosted(live.rungId);
      expect(await store.amendPlan(live.rungId, { ...live.plan, releaseShort: amt('2') }, 1)).toBeNull();
      expect((await store.findLive(id))!.plan.releaseShort).toBe(amt('1'));
    });
  });

  it('G: with a ledger that cannot look keys up, a bankrupt closing rung that crashes before its first post completes on replay', async () => {
    const id = await openPosition();
    const f = fixture({ price: { current: '84' } });
    let crash = true;
    f.hooks.beforePost = () => {
      if (crash) {
        crash = false;
        throw new Error('process died');
      }
    };
    const t1 = await runLiquidationTick(f.deps);
    expect(t1.items[0]).toMatchObject({ outcome: 'errored', reason: 'trade.liquidation_tick_error' });
    expect(await rungStates(id)).toEqual(['closing:planned']);
    const t2 = await runLiquidationTick(f.deps);
    expect(t2.items.map((i) => i.outcome)).toEqual(['liquidated']);
    expect((await readRow(id)).status).toBe('liquidated');
    expect(f.lossKeys()).toHaveLength(1);
  });

  it('the close announcement is at-least-once: a failed publish is retried by the next tick and then recorded', async () => {
    const id = await openPosition();
    const published: unknown[] = [];
    const f = fixture({ price: { current: '60' }, bus: { published } });
    const realPublish = (f.deps.closer.announceLiquidated as NonNullable<typeof f.deps.closer.announceLiquidated>).bind(f.deps.closer);
    let fail = true;
    f.deps.closer.announceLiquidated = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error('bus down');
      }
      return realPublish(...args);
    };
    const announcedAt = async () =>
      (await sql<{ announced_at: Date | null }[]>`SELECT announced_at FROM trade.liquidation_rungs WHERE position_id = ${id}`)[0]!
        .announced_at;

    const t1 = await runLiquidationTick(f.deps);
    expect(t1.items.map((i) => i.outcome)).toEqual(['liquidated', 'errored']);
    expect((await readRow(id)).status).toBe('liquidated');
    expect(published).toHaveLength(0);
    expect(await announcedAt()).toBeNull();

    const t2 = await runLiquidationTick(f.deps);
    expect(t2.errored).toBe(0);
    expect(published).toHaveLength(1);
    expect(await announcedAt()).not.toBeNull();
    await runLiquidationTick(f.deps);
    expect(published).toHaveLength(1);
  });

  it('sqlPositionReducer reports false when no row moved, true when one did', async () => {
    const id = await openPosition();
    const reducer = sqlPositionReducer(sql);
    const input = { liquidationId: 'x', sizeClosed: amt('1'), marginRemaining: amt('90'), reason: 'ladder_partial' };
    expect(await reducer.reduce(id, { ...input, sizeClosed: amt('10') })).toBe(false); // would take it to zero
    expect(await reducer.reduce(id, { ...input, sizeClosed: 0n })).toBe(false);
    await sql`UPDATE trade.positions SET status = 'closed' WHERE id = ${id}`;
    expect(await reducer.reduce(id, input)).toBe(false);
    await sql`UPDATE trade.positions SET status = 'open' WHERE id = ${id}`;
    expect(await reducer.reduce(id, input)).toBe(true);
    expect((await readRow(id)).size).toBe(money('9'));
  });

  it('a closing rung that throws after its post is replayed next tick and completes (no park)', async () => {
    const id = await openPosition();
    const published: unknown[] = [];
    const f = fixture({ price: { current: '60' }, bus: { published } });
    const realApply = f.deps.rungs!.apply;
    let crash = true;
    f.deps.rungs!.apply = async (...args) => {
      if (crash) {
        crash = false;
        throw new Error('db blip');
      }
      return realApply(...args);
    };
    const t1 = await runLiquidationTick(f.deps);
    expect(t1.items[0]!.outcome).toBe('errored');
    expect(await rungStates(id)).toEqual(['closing:posted']);
    expect((await readRow(id)).status).toBe('open');

    const t2 = await runLiquidationTick(f.deps);
    expect(t2.items.map((i) => i.outcome)).toEqual(['liquidated']);
    expect(await rungStates(id)).toEqual(['closing:applied']);
    expect((await readRow(id)).status).toBe('liquidated');
    expect(f.lossKeys()).toHaveLength(1);
    const claims = await sql`SELECT 1 FROM trade.liquidation_attempts WHERE liquidation_id = ${`liq:${id}`}`;
    expect(claims).toHaveLength(1);
    expect(published).toHaveLength(1); // fanned out once, after the commit
  });

  it('a claim left by the old code on an open position keeps the old behaviour: parked, nothing posted', async () => {
    const id = await openPosition();
    await sql`INSERT INTO trade.liquidation_attempts (liquidation_id) VALUES (${`liq:${id}`})`;
    const f = fixture({ price: { current: '60' } });
    const t = await runLiquidationTick(f.deps);
    expect(t.items[0]).toMatchObject({ outcome: 'skipped_already' });
    expect(t.parked).toBe(1);
    expect(f.posts).toHaveLength(0);
    expect(await rungStates(id)).toEqual([]);
  });

  describe('the store itself', () => {
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

    it('two concurrent begins: one created, one handed the winner (the row lock + the unique index)', async () => {
      const id = await openPosition();
      const store = sqlLiquidationRungStore(sql);
      const mk = (rungId: string) => ({
        rungId,
        positionId: id,
        liquidationId: `liq:${id}`,
        kind: 'partial' as const,
        fromSize: amt('10'),
        fromMargin: amt('100'),
        plan: plan(),
      });
      const [a, b] = await Promise.all([
        store.begin(mk('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')),
        store.begin(mk('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1')),
      ]);
      expect([a.status, b.status].sort()).toEqual(['created', 'live']);
      const winner = a.status === 'created' ? a.rung : (b as { rung: { rungId: string } }).rung;
      const loser = a.status === 'live' ? a.rung : (b as { rung: { rungId: string } }).rung;
      expect(loser.rungId).toBe(winner.rungId);
      expect(await sql`SELECT 1 FROM trade.liquidation_rungs WHERE position_id = ${id}`).toHaveLength(1);
    });

    it('the database refuses a second live rung for a position, and an unknown kind or state', async () => {
      const id = await openPosition();
      const ins = (rung: string, kind: string, state: string) => sql`
        INSERT INTO trade.liquidation_rungs (rung_id, position_id, liquidation_id, kind, from_size, from_margin, plan, state)
        VALUES (${rung}, ${id}, 'liq:x', ${kind}, '10', '100', ${sql.json({} as never)}, ${state})
      `;
      await ins('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'partial', 'planned');
      await expect(ins('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'partial', 'posted')).rejects.toMatchObject({ code: '23505' });
      // A finished rung does not count as live.
      await ins('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'closing', 'applied');
      await ins('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'closing', 'abandoned');
      await expect(ins('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'sideways', 'applied')).rejects.toMatchObject({ code: '23514' });
      await expect(ins('ffffffff-ffff-4fff-8fff-ffffffffffff', 'partial', 'maybe')).rejects.toMatchObject({ code: '23514' });
    });

    it('amounts beyond 2^53 survive the jsonb round trip, recipes included', async () => {
      const id = await openPosition('12345678.123456789012345678', '98765432.123456789012345678');
      const store = sqlLiquidationRungStore(sql);
      const big = 2n ** 53n + 1n;
      const huge = 123456789012345678901234567890n;
      const p: RungPlan = {
        recipes: [
          {
            idempotencyKey: 'futures.loss:liq:x:rung:r:loss',
            module: 'trade',
            reason: 'futures.loss.realized',
            entries: [
              {
                account: { ownerType: 'user', ownerId: 'u', assetId: 'USDT', kind: 'available' } as never,
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
      const created = await store.begin({
        rungId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        positionId: id,
        liquidationId: `liq:${id}`,
        kind: 'partial',
        fromSize: amt('12345678.123456789012345678'),
        fromMargin: amt('98765432.123456789012345678'),
        plan: p,
      });
      expect(created.status).toBe('created');
      const live = await store.findLive(id);
      expect(live!.plan).toEqual(p);
      expect(live!.fromSize).toBe(amt('12345678.123456789012345678'));
      expect(live!.fromMargin).toBe(amt('98765432.123456789012345678'));
    });

    it('apply twice moves the row once (second call: already_applied)', async () => {
      const id = await openPosition();
      const store = sqlLiquidationRungStore(sql);
      await store.begin({
        rungId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        positionId: id,
        liquidationId: `liq:${id}`,
        kind: 'partial',
        fromSize: amt('10'),
        fromMargin: amt('100'),
        plan: plan(),
      });
      const [a, b] = await Promise.all([
        store.apply(id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
        store.apply(id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      ]);
      expect([a.status, b.status].sort()).toEqual(['already_applied', 'applied']);
      expect(await readRow(id)).toEqual({ status: 'open', size: money('9'), margin: money('90') });
    });
  });
});
