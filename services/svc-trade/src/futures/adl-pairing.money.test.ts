/**
 * ADL pairs both sides at the bankruptcy price (docs/adr/2026-10-20-futures-matched-traders.md section 6).
 *
 * Postgres-hard: every assertion is on ledger balances and position rows, never on a mock's call log.
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
  futuresLossSink,
  insuranceFund,
  parseAmount as amt,
  positionCollateralAccount,
  recipes,
  userAvailable,
  type Amount,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { ADL_DISCLOSURE_VERSION, memoryAdlDisclosureStore, type AdlDisclosureStore } from './adl-disclosure.js';
import { ADL_UNCONFIGURED, memoryAdlDisclosureEventStore } from './adl-last-resort.js';
import { TEST_ADL_RANKING, bankruptcyPrice, sqlAdlCandidates, sqlAdlPairReducer } from './adl-pairing.js';
import { listPayoutsForUser, pendingPayoutTotals } from './futures-payouts.js';
import { parkUnderfundedWithAdl } from './liquidation-adl-gate.js';
import { sqlFundingPositionLoader, sqlLiquidationPositionLoader } from './position-loaders.js';
import { PositionService } from '../controls/test-admission.js';
import { memoryMarkBook } from './mark-source.js';
import { formatAccountRef, profitSourceFromConfig, recipeProfitFundingAccount } from './profit-source.js';
import { TEST_MAX_LEVERAGE_AMOUNT } from './initial-margin.test-harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_adl_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = new Date('2026-10-20T12:00:00.000Z');

describe('ADL pairs at the bankruptcy price (PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let acks: AdlDisclosureStore;
  let eventSeq = 0;

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 30_000);

  beforeEach(async () => {
    await sql`TRUNCATE trade.positions, trade.markets, trade.futures_payouts, trade.futures_adl_pairs RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    acks = memoryAdlDisclosureStore();
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (${MARKET}, 'BTC/USDT-PERP', 'BTC', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC perpetual', now())
    `;
  });

  /** A position with its margin really locked in the ledger. */
  async function position(userId: string, side: 'long' | 'short', size: string, entry: string, margin: string): Promise<string> {
    const id = randomUUID();
    await ledger.post(recipes.deposit({ userId, assetId: 'USDT', amount: amt(margin), rail: 'test', railRef: `fund-${id}` }));
    await ledger.post(recipes.futuresMarginLock({ positionId: id, userId, assetId: 'USDT', amount: amt(margin) }));
    await sql`
      INSERT INTO trade.positions (id, user_id, market_id, side, status, size, entry_price, margin_initial, margin_current, margin_asset)
      VALUES (${id}, ${userId}, ${MARKET}, ${side}, 'open', ${size}, ${entry}, ${margin}, ${margin}, 'USDT')
    `;
    return id;
  }

  const bal = async (ref: Parameters<LedgerClient['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);
  const pot = () => bal(futuresLossSink('USDT'));
  const row = async (id: string) =>
    (
      await sql<{ status: string; size: string; margin_current: string }[]>`
      SELECT status, size::text, margin_current::text FROM trade.positions WHERE id = ${id}`
    )[0]!;

  function adlDeps(over: { ledger?: Pick<LedgerClient, 'post' | 'balance'>; ranking?: typeof TEST_ADL_RANKING | null } = {}) {
    const reducer = sqlAdlPairReducer(sql, over.ledger ?? ledger);
    return {
      reducer,
      deps: {
        policy: { maxReduceBps: 10_000 },
        ranking: over.ranking === undefined ? TEST_ADL_RANKING : over.ranking,
        candidates: sqlAdlCandidates(sql, TEST_ADL_RANKING),
        disclosureAcks: acks,
        events: memoryAdlDisclosureEventStore(),
        reducer,
        replayPlanned: reducer.replayPlanned,
        newEventId: () => `evt-${++eventSeq}`,
      },
    };
  }

  async function runAdl(bankruptId: string, size: Amount, deps: ReturnType<typeof adlDeps>['deps']) {
    return parkUnderfundedWithAdl({
      adl: deps,
      row: { positionId: bankruptId, userId: ALICE, marketId: MARKET, side: 'long', size },
      fromInsurance: amt('1'),
      insuranceReason: 'trade.insurance_underfunded',
      at: AT,
    });
  }

  /** The ledger, failing the first post of `reason` once. */
  function failOnce(reason: string): Pick<LedgerClient, 'post' | 'balance'> {
    let armed = true;
    return {
      balance: (ref) => ledger.balance(ref),
      post: async (req) => {
        if (req.reason === reason && armed) {
          armed = false;
          throw new Error('ledger timeout');
        }
        return ledger.post(req);
      },
    };
  }

  /** Alice bankrupt against Bob, with the pair planned and only its loss leg posted. */
  async function plannedPair(): Promise<{ alice: string; bob: string }> {
    const alice = await position(ALICE, 'long', '1', '50000', '5000');
    const bob = await position(BOB, 'short', '1', '50000', '5000');
    await acks.recordAck(BOB, ADL_DISCLOSURE_VERSION, AT);
    await expect(runAdl(alice, amt('1'), adlDeps({ ledger: failOnce('futures.margin.release') }).deps)).rejects.toThrow('ledger timeout');
    const [planned] = await sql<{ state: string }[]>`SELECT state FROM trade.futures_adl_pairs`;
    expect(planned?.state).toBe('planned');
    return { alice, bob };
  }

  const positionService = () =>
    new PositionService(sql, ledger, {
      marks: memoryMarkBook().source(),
      profitSource: profitSourceFromConfig(formatAccountRef(recipeProfitFundingAccount('USDT'))),
      maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
      bus: null,
      now: () => AT,
    });

  it('prices the bankruptcy where the loss equals the margin', () => {
    expect(formatAmount(bankruptcyPrice('long', amt('1'), amt('50000'), amt('5000'))!)).toBe('45000');
    expect(formatAmount(bankruptcyPrice('short', amt('2'), amt('50000'), amt('5000'))!)).toBe('52500');
    expect(bankruptcyPrice('long', amt('1'), amt('50000'), amt('50000'))).toBeNull();
  });

  it('closes both sides at the bankruptcy price: the bankrupt loses its margin, the insurance fund pays nothing', async () => {
    const alice = await position(ALICE, 'long', '1', '50000', '5000');
    const bob = await position(BOB, 'short', '1', '50000', '5000');
    await acks.recordAck(BOB, ADL_DISCLOSURE_VERSION, AT);
    const { deps } = adlDeps();

    const item = await runAdl(alice, amt('1'), deps);
    expect(item.reason).toBe('trade.adl_disclosure_before_action');

    expect((await row(alice)).status).toBe('closed');
    expect((await row(bob)).status).toBe('closed');
    expect(await bal(positionCollateralAccount(ALICE, 'USDT', alice))).toBe('0');
    expect(await bal(positionCollateralAccount(BOB, 'USDT', bob))).toBe('0');
    // Bob: 5000 margin back + 5000 profit (short from 50000, closed at 45000). Paid from what Alice paid in.
    expect(await bal(userAvailable(BOB, 'USDT'))).toBe('10000');
    expect(await bal(userAvailable(ALICE, 'USDT'))).toBe('0');
    expect(await pot()).toBe('0');
    expect(await bal(insuranceFund('USDT'))).toBe('0');
    expect(await listPayoutsForUser(sql, BOB)).toMatchObject([{ state: 'paid', amount: '5000' }]);
  });

  it('owes a candidate profit larger than the pot instead of failing the pair', async () => {
    const alice = await position(ALICE, 'long', '1', '50000', '5000');
    // Bob shorted higher: 7000 of profit at 45000 against the 5000 Alice pays in.
    const bob = await position(BOB, 'short', '1', '52000', '5000');
    await acks.recordAck(BOB, ADL_DISCLOSURE_VERSION, AT);

    await runAdl(alice, amt('1'), adlDeps().deps);

    expect((await row(alice)).status).toBe('closed');
    expect((await row(bob)).status).toBe('closed');
    expect(await bal(userAvailable(BOB, 'USDT'))).toBe('5000');
    expect(await pot()).toBe('5000');
    expect(await pendingPayoutTotals(sql)).toEqual([{ assetId: 'USDT', owed: '7000', count: 1 }]);
  });

  it('pairs only the candidate size and leaves the bankrupt remainder open with its share of margin', async () => {
    const alice = await position(ALICE, 'long', '1', '50000', '5000');
    const bob = await position(BOB, 'short', '0.4', '50000', '2000');
    await acks.recordAck(BOB, ADL_DISCLOSURE_VERSION, AT);

    await runAdl(alice, amt('1'), adlDeps().deps);

    expect(await row(alice)).toMatchObject({ status: 'open', size: '0.600000000000000000', margin_current: '3000.000000000000000000' });
    expect(await bal(positionCollateralAccount(ALICE, 'USDT', alice))).toBe('3000');
    expect((await row(bob)).status).toBe('closed');
    expect(await bal(userAvailable(BOB, 'USDT'))).toBe('4000');
    expect(await pot()).toBe('0');
  });

  it('ranks by the TEST formula and skips a candidate who never acknowledged the disclosure', async () => {
    const alice = await position(ALICE, 'long', '1', '50000', '5000');
    // Carol ranks highest (more leverage) but never acknowledged; Bob is next.
    const carol = await position(CAROL, 'short', '1', '50000', '1000');
    const bob = await position(BOB, 'short', '1', '50000', '5000');
    await acks.recordAck(BOB, ADL_DISCLOSURE_VERSION, AT);

    const ranked = await sqlAdlCandidates(
      sql,
      TEST_ADL_RANKING,
    )({ positionId: alice, userId: ALICE, marketId: MARKET, side: 'long', uncoveredShortfall: 1n });
    expect(ranked.map((c) => c.positionId)).toEqual([carol, bob]);

    await runAdl(alice, amt('1'), adlDeps().deps);
    expect((await row(carol)).status).toBe('open');
    expect((await row(bob)).status).toBe('closed');
  });

  it('refuses trade.adl_unconfigured without a ranking, and nothing moves', async () => {
    const alice = await position(ALICE, 'long', '1', '50000', '5000');
    const bob = await position(BOB, 'short', '1', '50000', '5000');
    await acks.recordAck(BOB, ADL_DISCLOSURE_VERSION, AT);

    const item = await runAdl(alice, amt('1'), adlDeps({ ranking: null }).deps);
    expect(item.reason).toBe(ADL_UNCONFIGURED);
    expect((await row(alice)).status).toBe('open');
    expect((await row(bob)).status).toBe('open');
    expect(await bal(positionCollateralAccount(ALICE, 'USDT', alice))).toBe('5000');
  });

  it('replays a pair whose legs posted before a crash, once, and holds both positions until then', async () => {
    const alice = await position(ALICE, 'long', '1', '50000', '5000');
    const bob = await position(BOB, 'short', '1', '50000', '5000');
    await acks.recordAck(BOB, ADL_DISCLOSURE_VERSION, AT);
    let failRelease = true;
    const flaky = new Proxy(ledger, {
      get(target, prop, receiver) {
        if (prop === 'post') {
          return async (req: Parameters<LedgerClient['post']>[0]) => {
            if (req.reason === 'futures.margin.release' && failRelease) {
              failRelease = false;
              throw new Error('ledger timeout');
            }
            return target.post(req);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(runAdl(alice, amt('1'), adlDeps({ ledger: flaky }).deps)).rejects.toThrow('ledger timeout');
    // The loss leg posted; the rows have not moved, and the pair is planned.
    expect(await pot()).toBe('5000');
    expect((await row(alice)).status).toBe('open');
    const [planned] = await sql<{ state: string }[]>`SELECT state FROM trade.futures_adl_pairs`;
    expect(planned?.state).toBe('planned');

    // Bob cannot close or take margin out from under it.
    const service = new PositionService(sql, ledger, {
      marks: memoryMarkBook().source(),
      profitSource: profitSourceFromConfig(formatAccountRef(recipeProfitFundingAccount('USDT'))),
      maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
      bus: null,
      now: () => AT,
    });
    await expect(service.close(BOB, bob)).rejects.toMatchObject({ code: 'trade.liquidation_in_progress' });

    // The next tick drives it from the stored plan, posting nothing twice.
    expect(await sqlAdlPairReducer(sql, ledger).replayPlanned(bob)).toBe(true);
    expect(await sqlAdlPairReducer(sql, ledger).replayPlanned(bob)).toBe(false);
    expect((await row(alice)).status).toBe('closed');
    expect((await row(bob)).status).toBe('closed');
    expect(await bal(userAvailable(BOB, 'USDT'))).toBe('10000');
    expect(await pot()).toBe('0');
    expect(ledger.reconcile().ok).toBe(true);
  });

  it('refuses a margin top-up on either side while a pair is planned, so no top-up is stranded in a closed position', async () => {
    const { alice, bob } = await plannedPair();
    await ledger.post(recipes.deposit({ userId: BOB, assetId: 'USDT', amount: amt('300'), rail: 'test', railRef: 'topup-bob' }));
    await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('300'), rail: 'test', railRef: 'topup-alice' }));
    const service = positionService();
    for (const [userId, positionId] of [
      [BOB, bob],
      [ALICE, alice],
    ] as const) {
      await expect(
        service.addIsolatedMargin({ userId, symbol: 'BTC/USDT-PERP', positionId, amount: amt('300'), clientAdjustmentId: `top-${userId}` }),
      ).rejects.toMatchObject({ code: 'trade.liquidation_in_progress', addMarginAllowed: false });
    }

    expect(await sqlAdlPairReducer(sql, ledger).replayPlanned(bob)).toBe(true);
    expect(await row(bob)).toMatchObject({ status: 'closed', margin_current: '5000.000000000000000000' });
    expect(await bal(positionCollateralAccount(BOB, 'USDT', bob))).toBe('0');
    expect(await bal(positionCollateralAccount(ALICE, 'USDT', alice))).toBe('0');
    expect(await bal(userAvailable(BOB, 'USDT'))).toBe('10300');
    expect(ledger.reconcile().ok).toBe(true);
  });

  it('keeps a planned pair on an expired dated contract in the liquidation scan, so the tick still drives it', async () => {
    const { alice, bob } = await plannedPair();
    await sql`
      UPDATE trade.markets SET futures_contract_style = 'dated', futures_expiry_at = now() - interval '1 hour',
             futures_settlement_fixing = 'test-fixing'
       WHERE id = ${MARKET}
    `;
    const listed = (await sqlLiquidationPositionLoader(sql).listOpen()).map((p) => p.positionId);
    expect(listed).toEqual(expect.arrayContaining([alice, bob]));

    expect(await sqlAdlPairReducer(sql, ledger).replayPlanned(alice)).toBe(true);
    expect((await row(bob)).status).toBe('closed');
    expect(await sqlLiquidationPositionLoader(sql).listOpen()).toEqual([]);
  });

  it('leaves a planned pair out of funding, so a charge cannot leave the bankrupt short of its stored loss leg', async () => {
    const { alice, bob } = await plannedPair();
    const other = await position(CAROL, 'short', '1', '50000', '5000');
    const funded = (await sqlFundingPositionLoader(sql).listOpenForMarket(MARKET)).map((p) => p.positionId);
    expect(funded).toEqual([other]);
    expect(funded).not.toContain(alice);
    expect(funded).not.toContain(bob);
  });

  it('sees a liquidation claim committed while the plan waited for the row lock, and plans nothing', async () => {
    const alice = await position(ALICE, 'long', '1', '50000', '5000');
    const bob = await position(BOB, 'short', '1', '50000', '5000');
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = sql.begin(async (tx) => {
      await tx`SELECT id FROM trade.positions WHERE id = ${alice} FOR UPDATE`;
      await tx`INSERT INTO trade.liquidation_attempts (liquidation_id, position_id) VALUES (${`liq:${alice}`}, ${alice})`;
      locked();
      await held;
    });
    await isLocked;
    const reduced = sqlAdlPairReducer(sql, ledger).reduce({
      positionId: bob,
      bankruptPositionId: alice,
      sizeClosed: amt('1'),
      reason: 'trade.adl_disclosure_before_action',
      disclosureEventId: 'evt-race',
    });
    // Let the reducer reach the lock wait, then commit the claim.
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await holder;

    expect(await reduced).toEqual({ sizeClosed: 0n });
    expect(await sql`SELECT 1 FROM trade.futures_adl_pairs`).toHaveLength(0);
    expect((await row(alice)).status).toBe('open');
    expect(await bal(positionCollateralAccount(ALICE, 'USDT', alice))).toBe('5000');
  });
});
