/**
 * CARD B8 money proof — liquidation waterfall refuses unset ADL.
 *
 * Hitch: insurance underfunded (full-close and ladder bankrupt) calls
 * runAdlLastResort with owner policy or null. Unset maxReduceBps stays
 * trade.adl_unconfigured; reducer never runs; no socialized-loss recipe.
 * Empty EngineDepth never seizes. planLiquidation fromInsurance > 0 still
 * goes through checkInsuranceBound.
 *
 * Dedicated file so the Postgres gate is postgresAvailable (CI-red without DB).
 * MemoryLedger is enough for the bound (balance read); createTestDatabase
 * hosts trade.adl_action_disclosures so the refuse path is proven not to write.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, afterAll } from 'vitest';
import { parseAmount as amt, type AccountRef, type Amount, type Balance, type PostRequest } from '@intafaced/ledger-client';
import { memoryAcceptedMarkStore } from './accepted-mark.js';
import { ADL_UNCONFIGURED, sqlAdlDisclosureEventStore } from './adl-last-resort.js';
import { depthNotionalSourceFromDepth } from './mark-from-depth.js';
import { planLiquidation } from './liquidation-planner.js';
import { DEFAULT_FUTURES_LADDER_POLICY } from './ladder-policy.test-harness.js';
import {
  memoryLiquidationAttemptStore,
  runLiquidationTick,
  type LiquidationPositionRow,
  type QuotedMarkSource,
} from './liquidation-tick.js';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const USER = '11111111-1111-4111-8111-111111111111';
const AT = new Date('2026-09-02T20:00:00.000Z');

function underwaterLong(): LiquidationPositionRow {
  // entry 100, size 1, margin 10 → mark 80: uPnL=-20, equity=-10, fromInsurance 10
  return {
    positionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
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
        const amount = ref.ownerType === 'house' && ref.ownerId === 'insurance-fund' ? insuranceAvailable : 0n;
        return { account: ref, accountId: `${ref.ownerType}:${ref.ownerId}`, amount };
      },
    },
  };
}

function quotedAt(price: string): QuotedMarkSource {
  return {
    async markPrice() {
      return price;
    },
    async quote({ marketId, symbol, at }) {
      return { marketId, symbol, price: amt(price), asOf: at, quality: 'mid' };
    },
  };
}

describe('liquidation waterfall hitch (source)', () => {
  it('adl-last-resort.ts does not default maxReduceBps', () => {
    const src = readFileSync(join(here, 'adl-last-resort.ts'), 'utf8');
    expect(src).not.toMatch(/maxReduceBps\s*=/);
  });

  it('router.ts has no liquidation recut', () => {
    const routerSrc = readFileSync(join(here, '..', 'router.ts'), 'utf8');
    expect(routerSrc).not.toMatch(/runLiquidationTick/);
    expect(routerSrc).not.toMatch(/liquidation-tick/);
    expect(routerSrc).not.toMatch(/liquidation-planner/);
    expect(routerSrc).not.toMatch(/adl-last-resort/);
  });

  it('live jobs omit ADL policy and do not copy test ladder bps', () => {
    const jobs = readFileSync(join(here, 'futures-jobs.ts'), 'utf8');
    const index = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    expect(jobs).not.toMatch(/WIDE_POLICY/);
    expect(jobs).not.toMatch(/maxReduceBps\s*:/);
    expect(jobs).not.toMatch(/startFuturesJobs[\s\S]{0,400}adl:/);
    expect(index).not.toMatch(/WIDE_POLICY/);
    expect(index).not.toMatch(/maxReduceBps/);
    expect(index).not.toMatch(/startFuturesJobs\([\s\S]{0,1500}adl:/);
  });

  it('tick insurance-underfunded paths call the ADL gate (full-close and ladder)', () => {
    const tick = readFileSync(join(here, 'liquidation-tick.ts'), 'utf8');
    expect(tick).toMatch(/parkUnderfundedWithAdl/);
    const first = tick.indexOf('parkUnderfundedWithAdl');
    const second = tick.indexOf('parkUnderfundedWithAdl', first + 1);
    const third = tick.indexOf('parkUnderfundedWithAdl', second + 1);
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(tick).toMatch(/checkInsuranceBound/);
    const bound = tick.indexOf('checkInsuranceBound({');
    const park = tick.indexOf('parkUnderfundedWithAdl({');
    expect(bound).toBeGreaterThan(-1);
    expect(park).toBeGreaterThan(bound);
  });

  it('underfunded insurance + omitted/null ADL policy → adl_unconfigured, reducer idle, zero posts', async () => {
    const { ledger, posts } = recordingLedger({ insuranceAvailable: 0n });
    const reduces: string[] = [];
    const result = await runLiquidationTick({
      marks: quotedAt('80'),
      positions: {
        async listOpen() {
          return [underwaterLong()];
        },
      },
      closer: {
        async markLiquidated() {
          throw new Error('must not close when insurance is underfunded');
        },
      },
      attempts: memoryLiquidationAttemptStore(),
      acceptedMarks: memoryAcceptedMarkStore(),
      ledger,
      now: () => AT,
      adl: {
        policy: null,
        reducer: {
          async reduce(input) {
            reduces.push(input.positionId);
          },
        },
      },
    });
    expect(result.liquidated).toBe(0);
    expect(result.items[0]!.outcome).toBe('skipped_insurance_underfunded');
    expect(result.items[0]!.reason).toBe(ADL_UNCONFIGURED);
    expect(posts).toHaveLength(0);
    expect(reduces).toEqual([]);
  });

  it('empty EngineDepth → skipped_no_depth (never seizes)', async () => {
    const { ledger, posts } = recordingLedger({ insuranceAvailable: 0n });
    const reduced: string[] = [];
    const result = await runLiquidationTick({
      marks: quotedAt('80'),
      positions: {
        async listOpen() {
          return [underwaterLong()];
        },
      },
      closer: {
        async markLiquidated() {
          throw new Error('must not close without book depth');
        },
      },
      attempts: memoryLiquidationAttemptStore(),
      acceptedMarks: memoryAcceptedMarkStore(),
      ledger,
      now: () => AT,
      ladder: {
        depth: depthNotionalSourceFromDepth(async () => ({ bids: [], asks: [], sequence: 1 })),
        reducer: {
          async reduce(id) {
            reduced.push(id);
          },
        },
        // Test harness only — live jobs omit ladderPolicy (skipped_d3_unset).
        policy: DEFAULT_FUTURES_LADDER_POLICY,
      },
    });
    expect(result.items[0]!.outcome).toBe('skipped_no_depth');
    expect(posts).toHaveLength(0);
    expect(reduced).toEqual([]);
  });
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('liquidation waterfall B8 money (Postgres unavailable — start docker compose)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'trade', url: URL, migrations });
  const sql = db.sql;

  afterAll(async () => {
    await db.drop();
  });

  describe('liquidation waterfall B8 money', () => {
    it('underfunded insurance + adl policy null → adl_unconfigured, reducer not called, zero posts, no disclosure rows', async () => {
      const { ledger, posts } = recordingLedger({ insuranceAvailable: 0n });
      const row = underwaterLong();
      const plan = planLiquidation({ liquidationId: 'liq-b8', position: row, markPrice: '80' });
      expect(plan.liquidate).toBe(true);
      if (!plan.liquidate) throw new Error('expected liquidate');
      expect(plan.fromInsurance).toBeGreaterThan(0n);

      const reduces: string[] = [];
      const events = sqlAdlDisclosureEventStore(sql);
      const result = await runLiquidationTick({
        marks: quotedAt('80'),
        positions: {
          async listOpen() {
            return [row];
          },
        },
        closer: {
          async markLiquidated() {
            throw new Error('must not close when insurance is underfunded');
          },
        },
        attempts: memoryLiquidationAttemptStore(),
        acceptedMarks: memoryAcceptedMarkStore(),
        ledger,
        now: () => AT,
        adl: {
          policy: null,
          events,
          reducer: {
            async reduce(input) {
              reduces.push(input.positionId);
            },
          },
        },
      });

      expect(result.liquidated).toBe(0);
      expect(result.items[0]!.outcome).toBe('skipped_insurance_underfunded');
      expect(result.items[0]!.reason).toBe(ADL_UNCONFIGURED);
      expect(result.items[0]!.summary).toMatch(/refusing rather than overdrawing/);
      expect(posts).toHaveLength(0);
      expect(reduces).toEqual([]);
      const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM trade.adl_action_disclosures`;
      expect(rows[0]!.n).toBe('0');
    });

    it('empty EngineDepth → skipped_no_depth (never seizes)', async () => {
      const { ledger, posts } = recordingLedger({ insuranceAvailable: 0n });
      const reduced: string[] = [];
      const result = await runLiquidationTick({
        marks: quotedAt('80'),
        positions: {
          async listOpen() {
            return [underwaterLong()];
          },
        },
        closer: {
          async markLiquidated() {
            throw new Error('must not close without book depth');
          },
        },
        attempts: memoryLiquidationAttemptStore(),
        acceptedMarks: memoryAcceptedMarkStore(),
        ledger,
        now: () => AT,
        ladder: {
          depth: depthNotionalSourceFromDepth(async () => ({ bids: [], asks: [], sequence: 1 })),
          reducer: {
            async reduce(id) {
              reduced.push(id);
            },
          },
          // Test harness only — live jobs omit ladderPolicy (skipped_d3_unset).
          policy: DEFAULT_FUTURES_LADDER_POLICY,
        },
      });
      expect(result.items[0]!.outcome).toBe('skipped_no_depth');
      expect(posts).toHaveLength(0);
      expect(reduced).toEqual([]);
    });
  });
}
