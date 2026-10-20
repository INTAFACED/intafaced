import './position-mode.js';
import { PositionService } from '../controls/test-admission.js';
/**
 * Futures desk doors: partial close, flatten, reduce-only, margin summary,
 * position mode, and clientOpenId lookup. H8a PG-hard.
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
  add,
  formatAmount,
  parseAmount as amt,
  recipes,
  userAvailable,
  type Amount,
  futuresLossSink,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { MemoryEventBus } from '@intafaced/events';
import { FuturesError } from './position-service.js';
import { memoryMarkBook } from './mark-source.js';
import { formatAccountRef, profitSourceFromConfig, recipeProfitFundingAccount } from './profit-source.js';
import { TEST_MAX_LEVERAGE_AMOUNT } from './initial-margin.test-harness.js';
import { readTradePlanes } from './plane-capabilities.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer(H8A_IMAGE)
    .withDatabase('intafaced_h8a_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-08-06T12:00:00.000Z');

/** A trader who is not asserted on anywhere: the loser whose realised loss fills the clearing pot. */
const POT_LOSER = '99999999-9999-4999-8999-999999999999';

/**
 * Fund the clearing pot (`futuresLossSink`, the account losers pay into and
 * winners are paid from) the way it fills in production: a loser's deposit,
 * margin lock and realised loss.
 */
async function fundClearingPot(
  ledger: Pick<LedgerClient, 'post'>,
  input: { loserUserId: string; assetId: string; amount: bigint; seedId: string },
): Promise<void> {
  const positionId = `loser-${input.seedId}`;
  const { loserUserId: userId, assetId, amount } = input;
  await ledger.post(recipes.deposit({ userId, assetId, amount, rail: 'test', railRef: `clearing-pot-${input.seedId}` }));
  await ledger.post(recipes.futuresMarginLock({ positionId, userId, assetId, amount }));
  await ledger.post(
    recipes.futuresRealizeLoss({
      positionId,
      userId,
      assetId,
      fromMargin: amount,
      fromInsurance: 0n,
      lossId: `clearing-pot-${input.seedId}`,
    }),
  );
}

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('futures desk money', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let positions: PositionService;
  let marks: ReturnType<typeof memoryMarkBook>;

  const PROFIT_SOURCE = formatAccountRef(recipeProfitFundingAccount('USDT'));

  function feed(price: string, marketId: string = MARKET) {
    marks.set({ marketId, price, quality: 'mid', asOfMs: NOW.getTime() });
  }

  async function fundProfitSource(amount: string) {
    const seedId = `pot-seed-${randomUUID()}`;
    await fundClearingPot(ledger, { loserUserId: POT_LOSER, assetId: 'USDT', amount: amt(amount), seedId: seedId });
  }

  async function insertMarket(id: string, symbol: string) {
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        ${id}, ${symbol}, 'BTC', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', ${symbol}, now()
      )
    `;
    feed('50000', id);
  }

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE trade.positions, trade.fills, trade.orders, trade.markets,
        trade.position_close_intents, trade.position_close_batches,
        trade.futures_open_requests, trade.account_position_modes
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    marks = memoryMarkBook();
    positions = new PositionService(sql, ledger, {
      marks: marks.source(),
      profitSource: profitSourceFromConfig(PROFIT_SOURCE),
      maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
      bus: new MemoryEventBus('svc-trade'),
      now: () => NOW,
    });
    await insertMarket(MARKET, 'BTC/USDT-PERP');
    await ledger.post(
      recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('100000'), rail: 'test', railRef: `fund-${randomUUID()}` }),
    );
  });

  async function openAlice(clientOpenId: string, extra?: { symbol?: string; side?: 'long' | 'short'; size?: Amount }) {
    return positions.open({
      clientOpenId,
      userId: ALICE,
      symbol: extra?.symbol ?? 'BTC/USDT-PERP',
      side: extra?.side ?? 'long',
      size: extra?.size ?? amt('1'),
      leverage: amt('10'),
      positionMode: 'one_way',
    });
  }

  it('closes 40 percent and the split P&L sums to the full close', async () => {
    await fundProfitSource('10000');
    feed('50000');
    const pos = await openAlice('desk-partial');
    feed('51000');
    const first = await positions.closeQuantity(ALICE, pos.id!, { quantity: amt('0.4'), clientCloseId: 'desk-partial-a' });
    expect(first.realizedPnl).toBe('400');
    expect(first.contracts).toBe('0.6');
    expect(first.initialMargin).toBe('3000');
    const second = await positions.closeQuantity(ALICE, pos.id!, { quantity: amt('0.6'), clientCloseId: 'desk-partial-b' });
    expect(formatAmount(add(amt(first.realizedPnl!), amt(second.realizedPnl!)))).toBe('1000');

    feed('50000');
    const other = await openAlice('desk-full');
    feed('51000');
    const full = await positions.close(ALICE, other.id!);
    expect(full.realizedPnl).toBe('1000');
  });

  it('replays a clientCloseId without a second post, and a failed ledger post rolls the row back', async () => {
    feed('50000');
    const pos = await openAlice('desk-replay');
    const original = ledger.post.bind(ledger);
    ledger.post = async () => {
      throw new Error('ledger down');
    };
    await expect(positions.closeQuantity(ALICE, pos.id!, { quantity: amt('0.4'), clientCloseId: 'will-fail' })).rejects.toThrow(
      'ledger down',
    );
    ledger.post = original;
    const [rolled] = await sql<{ status: string; size: string }[]>`SELECT status, size::text FROM trade.positions WHERE id = ${pos.id}`;
    expect(rolled?.status).toBe('open');
    expect(amt(rolled!.size)).toBe(amt('1'));

    const closed = await positions.closeQuantity(ALICE, pos.id!, { quantity: amt('0.4'), clientCloseId: 'same-close' });
    const available = formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount);
    const again = await positions.closeQuantity(ALICE, pos.id!, { quantity: amt('0.4'), clientCloseId: 'same-close' });
    expect(again.id).toBe(closed.id);
    expect(again.realizedPnl).toBe(closed.realizedPnl);
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe(available);
  });

  it('refuses a bad quantity and another account', async () => {
    feed('50000');
    const pos = await openAlice('desk-refuse');
    await expect(positions.closeQuantity(ALICE, pos.id!, { quantity: amt('2'), clientCloseId: 'too-big' })).rejects.toMatchObject({
      code: 'trade.close_quantity_exceeds_size',
    });
    await expect(positions.closeQuantity(ALICE, pos.id!, { quantity: 0n, clientCloseId: 'zero' })).rejects.toMatchObject({
      code: 'trade.close_quantity_invalid',
    });
    await expect(positions.closeQuantity(ALICE, pos.id!, { quantity: amt('0.00015'), clientCloseId: 'off-step' })).rejects.toMatchObject({
      code: 'trade.close_quantity_lot_step',
    });
    await expect(positions.closeQuantity(BOB, pos.id!, { quantity: amt('0.4'), clientCloseId: 'not-yours' })).rejects.toMatchObject({
      code: 'trade.position_not_found',
    });
  });

  async function availableUsdt(): Promise<string> {
    return formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount);
  }

  async function freezeExit(positionId: string, acceptedMark: string | null): Promise<void> {
    await sql`
      UPDATE trade.positions
      SET status = 'closing', closing_reason = 'mark_missing', accepted_mark = ${acceptedMark}
      WHERE id = ${positionId}
    `;
  }

  it('settles a closing position at the frozen mark and returns the full margin', async () => {
    feed('50000');
    const pos = await openAlice('freeze-full');
    const [locked] = await sql<{ margin: string }[]>`
      SELECT margin_current::text AS margin FROM trade.positions WHERE id = ${pos.id}
    `;
    expect(amt(locked!.margin)).toBe(amt('5000'));
    await freezeExit(pos.id!, '50000');
    const before = await availableUsdt();
    feed('49000');
    const closed = await positions.closeQuantity(ALICE, pos.id!, { quantity: amt('1'), clientCloseId: 'freeze-full-close' });
    expect(closed.realizedPnl).toBe('0');
    expect(await availableUsdt()).toBe(formatAmount(add(amt(before), amt('5000'))));
  });

  it('refuses a partial close while the position is waiting on its frozen mark', async () => {
    feed('50000');
    const pos = await openAlice('freeze-partial');
    await freezeExit(pos.id!, '50000');
    const before = await availableUsdt();
    feed('49000');
    await expect(
      positions.closeQuantity(ALICE, pos.id!, { quantity: amt('0.4'), clientCloseId: 'freeze-partial-close' }),
    ).rejects.toMatchObject({
      code: 'trade.position_closing_full_only',
    });
    const [row] = await sql<{ status: string; size: string; accepted_mark: string }[]>`
      SELECT status, size::text, accepted_mark::text FROM trade.positions WHERE id = ${pos.id}
    `;
    expect(row?.status).toBe('closing');
    expect(amt(row!.size)).toBe(amt('1'));
    expect(amt(row!.accepted_mark)).toBe(amt('50000'));
    expect(await availableUsdt()).toBe(before);
  });

  it('flattens a closing position at the frozen mark', async () => {
    feed('50000');
    const pos = await openAlice('freeze-all');
    await freezeExit(pos.id!, '50000');
    feed('49000');
    const batch = await positions.closeAll(ALICE, { clientBatchId: 'freeze-batch' });
    expect(batch.results).toEqual([expect.objectContaining({ positionId: pos.id, status: 'closed', realizedPnl: '0' })]);
  });

  it('refuses to settle a closing position when the frozen mark is missing', async () => {
    feed('50000');
    const pos = await openAlice('freeze-blank');
    await freezeExit(pos.id!, null);
    const before = await availableUsdt();
    feed('49000');
    await expect(
      positions.closeQuantity(ALICE, pos.id!, { quantity: amt('1'), clientCloseId: 'freeze-blank-close' }),
    ).rejects.toMatchObject({
      code: 'trade.closing_basis_missing',
    });
    const [row] = await sql<{ status: string; accepted_mark: string | null }[]>`
      SELECT status, accepted_mark::text FROM trade.positions WHERE id = ${pos.id}
    `;
    expect(row?.status).toBe('closing');
    expect(row?.accepted_mark).toBeNull();
    expect(await availableUsdt()).toBe(before);
  });

  it('flatten closes around a mark refusal and a replay posts nothing', async () => {
    const aaa = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const mmm = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const zzz = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await insertMarket(aaa, 'AAA/USDT-PERP');
    await insertMarket(mmm, 'MMM/USDT-PERP');
    await insertMarket(zzz, 'ZZZ/USDT-PERP');
    const a = await openAlice('flat-a', { symbol: 'AAA/USDT-PERP' });
    const m = await openAlice('flat-m', { symbol: 'MMM/USDT-PERP' });
    const z = await openAlice('flat-z', { symbol: 'ZZZ/USDT-PERP' });
    marks.clear(mmm);
    const batch = await positions.closeAll(ALICE, { clientBatchId: 'batch-1' });
    expect(batch.results.map((item) => item.status)).toEqual(['closed', 'refused', 'closed']);
    expect(batch.results[1]?.positionId).toBe(m.id);
    const [untouched] = await sql<{ status: string; size: string; closing_reason: string | null }[]>`
      SELECT status, size::text, closing_reason FROM trade.positions WHERE id = ${m.id}
    `;
    expect(untouched?.status).toBe('open');
    expect(untouched?.closing_reason).toBeNull();
    expect(amt(untouched!.size)).toBe(amt('1'));
    const available = formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount);
    const replay = await positions.closeAll(ALICE, { clientBatchId: 'batch-1' });
    expect(replay).toEqual(batch);
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe(available);

    feed('50000', aaa);
    const only = await positions.closeAll(ALICE, { clientBatchId: 'batch-aaa', market: 'AAA/USDT-PERP' });
    expect(only.results).toHaveLength(0);
    const filtered = await positions.closeAll(BOB, { clientBatchId: 'bob-empty' });
    expect(filtered).toEqual({ results: [] });
    expect(a.id).toBeTruthy();
    expect(z.id).toBeTruthy();
  });

  it('a market filter closes only that market', async () => {
    const aaa = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
    const zzz = 'dddddddd-dddd-4ddd-8ddd-dddddddddddb';
    await insertMarket(aaa, 'AAA2/USDT-PERP');
    await insertMarket(zzz, 'ZZZ2/USDT-PERP');
    await openAlice('filt-a', { symbol: 'AAA2/USDT-PERP' });
    const z = await openAlice('filt-z', { symbol: 'ZZZ2/USDT-PERP' });
    const batch = await positions.closeAll(ALICE, { clientBatchId: 'only-aaa', market: 'AAA2/USDT-PERP' });
    expect(batch.results).toHaveLength(1);
    expect(batch.results[0]?.status).toBe('closed');
    const [still] = await sql<{ status: string }[]>`SELECT status FROM trade.positions WHERE id = ${z.id}`;
    expect(still?.status).toBe('open');
  });

  it('reduce-only refuses an empty market, caps at the opposite size, and stores the flag', async () => {
    await expect(
      positions.open({
        clientOpenId: 'reduce-empty',
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        side: 'short',
        size: amt('1'),
        leverage: amt('10'),
        reduceOnly: true,
      }),
    ).rejects.toMatchObject({ code: 'trade.reduce_only_would_increase' });
    const [flag] = await sql<{ reduce_only: boolean }[]>`
      SELECT reduce_only FROM trade.futures_open_requests WHERE user_id = ${ALICE} AND client_open_id = 'reduce-empty'
    `;
    expect(flag?.reduce_only).toBe(true);
    await expect(
      positions.open({
        clientOpenId: 'reduce-empty',
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        side: 'short',
        size: amt('1'),
        leverage: amt('10'),
        reduceOnly: true,
      }),
    ).rejects.toMatchObject({ code: 'trade.reduce_only_would_increase' });

    feed('50000');
    await openAlice('reduce-base');
    const reduced = await positions.open({
      clientOpenId: 'reduce-hit',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'short',
      size: amt('2'),
      leverage: amt('10'),
      reduceOnly: true,
    });
    expect(reduced.status).toBe('closed');
    const left = await positions.listOpen(ALICE, 'BTC/USDT-PERP');
    expect(left).toHaveLength(0);
    const [stored] = await sql<{ reduce_only: boolean }[]>`
      SELECT reduce_only FROM trade.futures_open_requests WHERE user_id = ${ALICE} AND client_open_id = 'reduce-hit'
    `;
    expect(stored?.reduce_only).toBe(true);
  });

  it('finds a position by clientOpenId, hides another account, and leaves legacy leverage null', async () => {
    feed('50000');
    const pos = await openAlice('lookup-1');
    const again = await openAlice('lookup-1');
    expect(again.id).toBe(pos.id);
    const found = await positions.listOpen(ALICE, undefined, 'lookup-1');
    expect(found.map((row) => row.id)).toEqual([pos.id]);
    expect(found[0]?.clientOpenId).toBe('lookup-1');
    expect(found[0]?.openedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(found[0]?.leverage).toBe('10');
    expect(await positions.listOpen(BOB, undefined, 'lookup-1')).toEqual([]);

    await sql`
      INSERT INTO trade.positions (
        id, user_id, market_id, side, status, margin_mode,
        size, entry_price, leverage, margin_initial, margin_current, margin_asset, funding_paid, client_open_id
      ) VALUES (
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', ${ALICE}, ${MARKET}, 'short', 'open', 'isolated',
        '1', '50000', NULL, '5000', '5000', 'USDT', '0', 'legacy-open'
      )
    `;
    const legacy = await positions.listOpen(ALICE, undefined, 'legacy-open');
    expect(legacy[0]?.leverage).toBeNull();
    expect(legacy[0]?.leverageReason).toBe('leverage_not_recorded');
  });

  it('margin summary sums only the caller and nulls the ratio when maintenance is unknown', async () => {
    feed('50000');
    await openAlice('sum-a');
    const eth = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await insertMarket(eth, 'ETH/USDT-PERP');
    await openAlice('sum-b', { symbol: 'ETH/USDT-PERP', size: amt('2') });
    const summary = await positions.marginSummary(ALICE);
    expect(summary.totalInitialMargin).toBe('15000');
    expect(summary.totalMaintenanceMargin).toBeNull();
    expect(summary.marginRatio).toBeNull();
    expect(summary.missing).toContainEqual({ field: 'maintenanceMargin', code: 'missing_input' });
    const bob = await positions.marginSummary(BOB);
    expect(bob.totalInitialMargin).toBe('0');
    expect(bob.totalMaintenanceMargin).toBe('0');
    expect(bob.marginRatio).toBeNull();

    const none = await positions.marginSummary('33333333-3333-4333-8333-333333333333');
    expect(none.totalInitialMargin).toBe('0');
    expect(none.marginRatio).toBeNull();
  });

  it('position mode stores hedge while flat and refuses a change with an open position', async () => {
    expect(await positions.readAccountMode(ALICE)).toMatchObject({ mode: null, source: 'unset', code: 'trade.position_mode_unset' });
    const stored = await positions.writeAccountMode(ALICE, { mode: 'hedge', clientModeId: 'mode-1' });
    expect(stored).toMatchObject({ mode: 'hedge', source: 'stored' });
    feed('50000');
    await openAlice('mode-open');
    await expect(positions.writeAccountMode(ALICE, { mode: 'one_way', clientModeId: 'mode-2' })).rejects.toMatchObject({
      code: 'trade.position_mode_migration_blocked',
    });
  });

  it('a futures write uses the same disabled reason as the capabilities read', async () => {
    const previous = process.env.TRADE_FUTURES_ENABLED;
    process.env.TRADE_FUTURES_ENABLED = 'false';
    try {
      await expect(openAlice('flag-off')).rejects.toMatchObject({ code: readTradePlanes().futures.reason });
      process.env.TRADE_FUTURES_ENABLED = 'true';
      feed('50000');
      const pos = await openAlice('flag-on');
      expect(pos.id).toBeTruthy();
      expect(readTradePlanes().futures.enabled).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.TRADE_FUTURES_ENABLED;
      else process.env.TRADE_FUTURES_ENABLED = previous;
    }
  });
});
