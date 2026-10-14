import { PositionService } from '../controls/test-admission.js';
/**
 * A TRADER MAY NOT MOVE THE MONEY A LIQUIDATION IS MOVING.
 *
 * `close`, `reduceIsolatedMargin`, `setLeverage` and `addIsolatedMargin` each read
 * `trade.liquidation_rungs` under their existing position row lock and refuse with a typed 409 while a
 * rung is live (or the position is parked). Proven against real Postgres + MemoryLedger, because the
 * row lock and the rung table are Postgres facts. H8a PG-hard: never skip-green.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryLedger,
  formatAmount,
  parseAmount as amt,
  positionCollateralAccount,
  recipes,
  userAvailable,
} from '@intafaced/ledger-client';
import { MemoryEventBus } from '@intafaced/events';
import { memoryMarkBook } from './mark-source.js';
import { formatAccountRef, profitSourceFromConfig, recipeProfitFundingAccount } from './profit-source.js';
import { TEST_MAX_LEVERAGE_AMOUNT } from './initial-margin.test-harness.js';
import { LIQUIDATION_IN_PROGRESS, POSITION_UNDER_REVIEW } from './position-service.js';
import { sqlLiquidationRungStore } from './tick-stores.js';
import { sqlDatedSettlementPositionLoader } from './position-loaders.js';
import type { FuturesLadderPolicy } from './maintenance-ladder.js';

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
      `H8a: svc-trade position-service liquidation hold is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-08-06T12:00:00.000Z');
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SYMBOL = 'BTC/USDT-PERP';

describe('src: this suite is not skip-green', () => {
  it('has no postgresAvailable / describe.skip / it.skip', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('position-service: liquidation hold (Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let marks: ReturnType<typeof memoryMarkBook>;
  let positions: PositionService;

  const PROFIT_SOURCE = formatAccountRef(recipeProfitFundingAccount('USDT'));
  const feed = (price: string) => marks.set({ marketId: MARKET, price, quality: 'mid', asOfMs: NOW.getTime() });
  const build = (ladder?: ConstructorParameters<typeof PositionService>[2]['ladder']) =>
    new PositionService(sql, ledger, {
      marks: marks.source(),
      profitSource: profitSourceFromConfig(PROFIT_SOURCE),
      maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
      bus: new MemoryEventBus('svc-trade'),
      now: () => NOW,
      ...(ladder ? { ladder } : {}),
    });

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
    await sql`TRUNCATE trade.positions, trade.fills, trade.orders, trade.markets, trade.liquidation_rungs, trade.liquidation_attempts RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    marks = memoryMarkBook();
    positions = build();
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (${MARKET}, ${SYMBOL}, 'BTC', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC perpetual', now())
    `;
    await ledger.post(
      recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('100000'), rail: 'test', railRef: `fund-${Math.random()}` }),
    );
    // A profit pot, so a flat close is never refused for want of one.
    const seed = `pot-seed-${randomUUID()}`;
    await ledger.post(recipes.deposit({ userId: BOB, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: `pot-${randomUUID()}` }));
    await ledger.post(recipes.futuresMarginLock({ positionId: seed, userId: BOB, assetId: 'USDT', amount: amt('1000') }));
    await ledger.post(
      recipes.futuresRealizeLoss({
        positionId: seed,
        userId: BOB,
        assetId: 'USDT',
        fromMargin: amt('1000'),
        fromInsurance: 0n,
        lossId: seed,
      }),
    );
    feed('50000');
  });

  /** Who owns each position: one open position per (user, market), so extra positions get their own user. */
  const owner = new Map<string, string>();
  let userSeq = 0;
  /** One open long: 1 BTC at 50000, 10x → margin 5000, plus 2500 added so there is room to withdraw. */
  async function openPosition(who: 'alice' | 'new' = 'alice') {
    const userId = who === 'alice' ? ALICE : `33333333-3333-4333-8333-${String(++userSeq).padStart(12, '0')}`;
    if (who === 'new') {
      await ledger.post(recipes.deposit({ userId, assetId: 'USDT', amount: amt('100000'), rail: 'test', railRef: `fund-${userId}` }));
    }
    const pos = await positions.open({
      clientOpenId: `open-${randomUUID()}`,
      userId,
      symbol: SYMBOL,
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    await positions.addIsolatedMargin({
      userId,
      symbol: SYMBOL,
      positionId: pos.id!,
      amount: amt('2500'),
      clientAdjustmentId: `seed-${pos.id}`,
    });
    owner.set(pos.id!, userId);
    return pos.id!;
  }

  let rungSeq = 0;
  /** A rung row exactly as the tick's store would leave it, in any state (the guard reads only kind and state). */
  async function putRung(positionId: string, kind: 'partial' | 'closing', state: string, createdAt?: string) {
    const rungId = randomUUID();
    await sql`
      INSERT INTO trade.liquidation_rungs (rung_id, position_id, liquidation_id, kind, from_size, from_margin, plan, state, created_at)
      VALUES (${rungId}, ${positionId}, ${`liq:${positionId}`}, ${kind}, '1', '7500', ${sql.json({} as never)}, ${state},
              ${createdAt ?? new Date(NOW.getTime() + ++rungSeq * 1000).toISOString()})
    `;
    return rungId;
  }
  const setState = (rungId: string, state: string) => sql`UPDATE trade.liquidation_rungs SET state = ${state} WHERE rung_id = ${rungId}`;

  const ownerOf = (id: string) => owner.get(id) ?? ALICE;
  const pot = async (id: string) => formatAmount((await ledger.balance(positionCollateralAccount(ownerOf(id), 'USDT', id))).amount);
  const available = async () => formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount);
  const rowMargin = async (id: string) => {
    const [r] = await sql<{ margin_current: string }[]>`SELECT margin_current FROM trade.positions WHERE id = ${id}`;
    return formatAmount(amt(r!.margin_current));
  };
  const common = (id: string) => ({ userId: ownerOf(id), symbol: SYMBOL, positionId: id });
  const reduce = (id: string, clientAdjustmentId?: string) =>
    positions.reduceIsolatedMargin({ ...common(id), amount: amt('100'), ...(clientAdjustmentId ? { clientAdjustmentId } : {}) });
  const add = (id: string, clientAdjustmentId?: string) =>
    positions.addIsolatedMargin({ ...common(id), amount: amt('100'), ...(clientAdjustmentId ? { clientAdjustmentId } : {}) });
  const lever = (id: string) => positions.setLeverage({ ...common(id), leverage: amt('8') });
  const refused = (code: string) => ({ code, status: 409 });

  describe('a LIVE rung', () => {
    for (const state of ['planned', 'posted'] as const) {
      it(`${state} PARTIAL rung: close, reduce and setLeverage are refused 409 liquidation_in_progress, nothing posts; add-margin still works`, async () => {
        const id = await openPosition();
        const rung = await putRung(id, 'partial', state);
        const potBefore = await pot(id);
        const availableBefore = await available();

        await expect(positions.close(ownerOf(id), id)).rejects.toMatchObject(refused(LIQUIDATION_IN_PROGRESS));
        await expect(reduce(id)).rejects.toMatchObject(refused(LIQUIDATION_IN_PROGRESS));
        await expect(lever(id)).rejects.toMatchObject(refused(LIQUIDATION_IN_PROGRESS));
        expect(await pot(id)).toBe(potBefore);
        expect(await available()).toBe(availableBefore);
        const [row] = await sql<{ status: string; margin_adjust_request: string | null }[]>`
          SELECT status, margin_adjust_request FROM trade.positions WHERE id = ${id}`;
        expect(row).toMatchObject({ status: 'open', margin_adjust_request: null }); // no pending adjustment is left behind

        // A partial rung applies a DELTA to the row, so margin added meanwhile survives it.
        const added = await add(id);
        expect(added.collateral).toBe('7600');

        // Once the rung has applied, the same operations go through.
        await setState(rung, 'applied');
        expect((await reduce(id)).collateral).toBe('7500');
        expect((await lever(id)).leverage).toBe('8');
        expect((await positions.close(ownerOf(id), id)).status).toBe('closed');
      });
    }

    it('a CLOSING rung also refuses add-margin: it would strand the added margin in the pot', async () => {
      const id = await openPosition();
      const rung = await putRung(id, 'closing', 'posted');
      await expect(add(id)).rejects.toMatchObject(refused(LIQUIDATION_IN_PROGRESS));
      await expect(reduce(id)).rejects.toMatchObject(refused(LIQUIDATION_IN_PROGRESS));
      await expect(positions.close(ownerOf(id), id)).rejects.toMatchObject(refused(LIQUIDATION_IN_PROGRESS));
      expect(await pot(id)).toBe('7500');
      await setState(rung, 'applied');
      expect((await add(id)).collateral).toBe('7600');
    });

    it('a refused mutation does not poison its own retry: the same clientAdjustmentId works once the rung is applied', async () => {
      const id = await openPosition();
      const rung = await putRung(id, 'closing', 'planned');
      await expect(reduce(id, 'retry-me')).rejects.toMatchObject(refused(LIQUIDATION_IN_PROGRESS));
      await setState(rung, 'applied');
      expect((await reduce(id, 'retry-me')).collateral).toBe('7400');
      expect(await pot(id)).toBe('7400');
    });

    it('a rung on ANOTHER position does not block this one', async () => {
      const id = await openPosition();
      const other = await openPosition('new');
      await putRung(other, 'closing', 'planned');
      expect((await reduce(id)).collateral).toBe('7400');
    });
  });

  describe('a PARKED position', () => {
    it('latest rung abandoned: close, reduce and setLeverage are refused 409 position_under_review; add-margin is allowed', async () => {
      const id = await openPosition();
      const rung = await putRung(id, 'closing', 'abandoned');
      await expect(positions.close(ownerOf(id), id)).rejects.toMatchObject(refused(POSITION_UNDER_REVIEW));
      await expect(reduce(id)).rejects.toMatchObject(refused(POSITION_UNDER_REVIEW));
      await expect(lever(id)).rejects.toMatchObject(refused(POSITION_UNDER_REVIEW));
      expect(await pot(id)).toBe('7500');
      expect((await add(id)).collateral).toBe('7600');
      expect(await rowMargin(id)).toBe('7600');

      // The operator resolves it (runbook section 2): the position is the trader's again.
      await setState(rung, 'resolved');
      expect((await reduce(id)).collateral).toBe('7500');
      expect((await positions.close(ownerOf(id), id)).status).toBe('closed');
    });

    it('"latest" decides: an abandoned rung followed by a newer applied one is not parked', async () => {
      const id = await openPosition();
      await putRung(id, 'closing', 'abandoned', '2026-08-06T10:00:00.000Z');
      await putRung(id, 'partial', 'applied', '2026-08-06T11:00:00.000Z');
      expect((await reduce(id)).collateral).toBe('7400');
    });

    it('a newer abandoned rung over an older applied one IS parked', async () => {
      const id = await openPosition();
      await putRung(id, 'partial', 'applied', '2026-08-06T10:00:00.000Z');
      await putRung(id, 'partial', 'abandoned', '2026-08-06T11:00:00.000Z');
      await expect(positions.close(ownerOf(id), id)).rejects.toMatchObject(refused(POSITION_UNDER_REVIEW));
    });

    it('an old-style claim row (liquidation_attempts) on a still-open position parks it the same way', async () => {
      const id = await openPosition();
      await sql`INSERT INTO trade.liquidation_attempts (liquidation_id, position_id) VALUES (${`liq:${id}`}, ${id})`;
      await expect(positions.close(ownerOf(id), id)).rejects.toMatchObject(refused(POSITION_UNDER_REVIEW));
      await expect(reduce(id)).rejects.toMatchObject(refused(POSITION_UNDER_REVIEW));
      expect((await add(id)).collateral).toBe('7600');
      await sql`DELETE FROM trade.liquidation_attempts WHERE liquidation_id = ${`liq:${id}`}`;
      expect((await positions.close(ownerOf(id), id)).status).toBe('closed');
    });
  });

  describe('dated settlement does not meet a rung', () => {
    it('the settlement position loader hands over neither a live nor a parked position', async () => {
      const clean = await openPosition();
      const live = await openPosition('new');
      const parked = await openPosition('new');
      const claimed = await openPosition('new');
      await putRung(live, 'closing', 'planned');
      await putRung(parked, 'partial', 'abandoned');
      await sql`INSERT INTO trade.liquidation_attempts (liquidation_id, position_id) VALUES (${`liq:${claimed}`}, ${claimed})`;
      const listed = (await sqlDatedSettlementPositionLoader(sql).listOpenForMarket(MARKET)).map((p) => p.positionId);
      expect(listed).toEqual([clean]);
    });

    it('once the rung has applied, the position is settled like any other', async () => {
      const id = await openPosition();
      const rung = await putRung(id, 'partial', 'posted');
      expect(await sqlDatedSettlementPositionLoader(sql).listOpenForMarket(MARKET)).toHaveLength(0);
      await setState(rung, 'applied');
      expect((await sqlDatedSettlementPositionLoader(sql).listOpenForMarket(MARKET)).map((p) => p.positionId)).toEqual([id]);
    });
  });

  describe('exactly one of "a trader mutation" and "a rung beginning" wins (the shared row lock)', () => {
    it('begin racing reduceIsolatedMargin: the pot and the row agree, and never both succeed', async () => {
      const store = sqlLiquidationRungStore(sql);
      let rungWon = 0;
      let reduceWon = 0;
      for (let i = 0; i < 6; i++) {
        const id = await openPosition('new');
        const [r, reduced] = await Promise.allSettled([
          store.begin({
            rungId: randomUUID(),
            positionId: id,
            liquidationId: `liq:${id}`,
            kind: 'partial',
            fromSize: amt('1'),
            fromMargin: amt('7500'),
            plan: {
              recipes: [],
              sizeClosed: amt('0.1'),
              marginRemaining: amt('7000'),
              marginTaken: amt('500'),
              releaseShort: 0n,
              lossShort: 0n,
              reason: 'ladder_partial',
              fromInsurance: 0n,
              marginAsset: 'USDT',
            },
          }),
          reduce(id),
        ]);
        expect(r.status).toBe('fulfilled');
        const begun = (r as PromiseFulfilledResult<Awaited<ReturnType<typeof store.begin>>>).value;
        if (begun.status === 'created') {
          rungWon += 1;
          expect(reduced.status).toBe('rejected');
          expect((reduced as PromiseRejectedResult).reason).toMatchObject({ code: LIQUIDATION_IN_PROGRESS, status: 409 });
          expect(await pot(id)).toBe('7500');
        } else {
          reduceWon += 1;
          expect(begun.status).toBe('changed'); // the row moved under the plan: nothing was planned
          expect(reduced.status).toBe('fulfilled');
          expect(await pot(id)).toBe('7400');
        }
        expect(await rowMargin(id)).toBe(await pot(id)); // ledger pot == row margin whoever won
      }
      expect(rungWon + reduceWon).toBe(6);
    });
  });

  describe('the withdrawal gate follows the ladder when a policy is published', () => {
    // 20% maintenance on a 10x position: the 7500 held is above the 5000 initial margin, but a
    // withdrawal of 100 leaves 7400 against a 10_000 requirement - the ladder would liquidate it.
    const STRICT: FuturesLadderPolicy = {
      tiers: [{ uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 2_000 }],
      marginCallBps: 12_000,
      targetBps: 15_000,
      maxTrancheBps: 10_000,
    };
    const LAX: FuturesLadderPolicy = { ...STRICT, tiers: [{ uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 500 }] };
    const depth = (n: bigint | null) => ({
      async depthNotional() {
        return n;
      },
    });

    it('equity-only gate (no policy): the withdrawal is allowed, as before', async () => {
      const id = await openPosition();
      expect((await reduce(id)).collateral).toBe('7400');
    });

    it('a policy that would liquidate what is left refuses the withdrawal and posts nothing', async () => {
      const id = await openPosition();
      const gated = build({ depth: depth(amt('1000000')), policy: STRICT });
      await expect(gated.reduceIsolatedMargin({ ...common(id), amount: amt('100') })).rejects.toMatchObject({
        code: 'trade.margin_would_liquidate',
      });
      expect(await pot(id)).toBe('7500');
    });

    it('a policy the position meets comfortably allows it', async () => {
      const id = await openPosition();
      const gated = build({ depth: depth(amt('1000000')), policy: LAX });
      expect((await gated.reduceIsolatedMargin({ ...common(id), amount: amt('100') })).collateral).toBe('7400');
    });

    it('a policy with no readable book refuses to release margin blind (503 depth_unknown)', async () => {
      const id = await openPosition();
      const gated = build({ depth: depth(null), policy: LAX });
      await expect(gated.reduceIsolatedMargin({ ...common(id), amount: amt('100') })).rejects.toMatchObject({
        code: 'trade.depth_unknown',
        status: 503,
      });
      expect(await pot(id)).toBe('7500');
    });

    it('a ladder with NO policy (owner D3 unset, production today) keeps the equity-only gate', async () => {
      const id = await openPosition();
      const gated = build({ depth: depth(null) });
      expect((await gated.reduceIsolatedMargin({ ...common(id), amount: amt('100') })).collateral).toBe('7400');
    });
  });
});
