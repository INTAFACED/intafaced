import './position-mode.js';
import { PositionService } from '../controls/test-admission.js';
/**
 * Items 16–21. Position fields the service computes, replay-safe close,
 * rolled-back mark refusals, and the liquidation rung on add-margin.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryLedger,
  formatAmount,
  parseAmount as amt,
  recipes,
  userAvailable,
  type Amount,
  futuresLossSink,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { MemoryEventBus } from '@intafaced/events';
import { memoryMarkBook } from './mark-source.js';
import { formatAccountRef, profitSourceFromConfig, recipeProfitFundingAccount } from './profit-source.js';
import { TEST_MAX_LEVERAGE_AMOUNT } from './initial-margin.test-harness.js';
import { planLadderRung } from './maintenance-ladder.js';
import { unrealizedPnl } from './liquidation-planner.js';
import { DEFAULT_FUTURES_LADDER_POLICY } from './ladder-policy.test-harness.js';
import { positionPercentage } from './position-service.js';
import { resolveOpenPositionMode } from './account-mode.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
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
const DEPTH = amt('1000000');

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

describe('futures position fields', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let positions: PositionService;
  let marks: ReturnType<typeof memoryMarkBook>;

  const PROFIT_SOURCE = formatAccountRef(recipeProfitFundingAccount('USDT'));

  function feed(price: string, quality: 'mid' | 'last' = 'mid') {
    marks.set({ marketId: MARKET, price, quality, asOfMs: NOW.getTime() });
  }

  async function available(): Promise<string> {
    return formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount);
  }

  async function fundProfitSource(amount: string) {
    const seedId = `pot-seed-${randomUUID()}`;
    await fundClearingPot(ledger, { loserUserId: POT_LOSER, assetId: 'USDT', amount: amt(amount), seedId: seedId });
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
        trade.futures_open_requests, trade.account_position_modes,
        trade.position_closed_at_backfill
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
      ladder: {
        policy: DEFAULT_FUTURES_LADDER_POLICY,
        depth: {
          async depthNotional() {
            return DEPTH;
          },
        },
      },
    });
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        ${MARKET}, 'BTC/USDT-PERP', 'BTC', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC/USDT-PERP', now()
      )
    `;
    feed('50000');
    await ledger.post(
      recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('100000'), rail: 'test', railRef: `fund-${randomUUID()}` }),
    );
  });

  async function openSide(clientOpenId: string, side: 'long' | 'short') {
    return positions.open({
      clientOpenId,
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side,
      size: amt('1'),
      leverage: amt('10'),
      positionMode: 'one_way',
    });
  }

  function postedAmount(reason: string, positionId: string): string | undefined {
    const tx = ledger.journal().find((row) => row.reason === reason && row.idempotencyKey.includes(positionId));
    const entry = tx?.entries.find((item) => item.direction === 'debit' || item.direction === 'credit');
    return entry ? formatAmount(entry.amount as Amount) : undefined;
  }

  it('a plain open on a one-way account stores one_way, and hedge is a typed refusal when the book cannot key two sides', async () => {
    await positions.writeAccountMode(ALICE, { mode: 'one_way', clientModeId: 'mode-alice' });
    const opened = await positions.open({
      clientOpenId: 'plain',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    expect(opened.status).toBe('open');
    expect(await positions.readAccountMode(ALICE)).toMatchObject({ mode: 'one_way', source: 'stored' });
    expect(resolveOpenPositionMode({ requested: 'hedge', stored: 'one_way' }, false)).toMatchObject({
      ok: false,
      code: 'trade.position_mode_hedge_unsupported',
    });
  });

  it('fills mark, maintenance, pnl and percentage for a long and a short, and nulls them when the mark is missing', async () => {
    const long = await openSide('long-1', 'long');
    feed('51000');
    const longRow = await positions.get(ALICE, long.id!);
    const longMaint = planLadderRung({
      position: {
        positionId: long.id!,
        userId: ALICE,
        side: 'long',
        size: amt('1'),
        entryPrice: amt('50000'),
        margin: amt(longRow.collateral!),
        marginAsset: 'USDT',
      },
      markPrice: amt('51000'),
      depthNotional: DEPTH,
      policy: DEFAULT_FUTURES_LADDER_POLICY,
    });
    expect(longRow.markPrice).toBe('51000');
    expect(longRow.initialMargin).toBe('5000');
    expect(longRow.unrealizedPnl).toBe('1000');
    expect(longRow.percentage).toBe(formatAmount(positionPercentage(amt('1000'), amt('5000'))));
    expect(longRow.percentage).toBe('20');
    expect(longRow.maintenanceMargin).toBe(formatAmount(longMaint.maintenanceRequired));
    expect(longRow.maintenanceMargin).toBe('510');
    expect(longRow.contractSize).toBeNull();
    expect(longRow.fieldReasons?.contractSize).toBe('contract_size_not_recorded');
    expect(longRow.fieldReasons?.markPrice).toBeUndefined();

    feed('50000');
    const short = await openSide('short-1', 'short');
    feed('49000');
    const shortRow = (await positions.listOpen(ALICE)).find((row) => row.id === short.id);
    const shortMaint = planLadderRung({
      position: {
        positionId: short.id!,
        userId: ALICE,
        side: 'short',
        size: amt('1'),
        entryPrice: amt('50000'),
        margin: amt(shortRow!.collateral!),
        marginAsset: 'USDT',
      },
      markPrice: amt('49000'),
      depthNotional: DEPTH,
      policy: DEFAULT_FUTURES_LADDER_POLICY,
    });
    expect(shortRow!.unrealizedPnl).toBe(formatAmount(unrealizedPnl('short', amt('1'), amt('50000'), amt('49000'))));
    expect(shortRow!.unrealizedPnl).toBe('1000');
    expect(shortRow!.percentage).toBe('20');
    expect(shortRow!.maintenanceMargin).toBe(formatAmount(shortMaint.maintenanceRequired));
    expect(shortRow!.maintenanceMargin).toBe('245');

    marks.clear(MARKET);
    const dark = await positions.get(ALICE, long.id!);
    expect(dark.markPrice).toBeNull();
    expect(dark.unrealizedPnl).toBeNull();
    expect(dark.percentage).toBeNull();
    expect(dark.maintenanceMargin).toBeNull();
    expect(dark.markPrice).not.toBe('0');
    expect(dark.unrealizedPnl).not.toBe('0');
    expect(dark.percentage).not.toBe('0');
    expect(dark.maintenanceMargin).not.toBe('0');
    expect(dark.fieldReasons).toMatchObject({
      markPrice: 'mark_missing',
      unrealizedPnl: 'mark_missing',
      percentage: 'mark_missing',
      maintenanceMargin: 'mark_missing',
    });

    await sql`UPDATE trade.markets SET contract_size = '0.01' WHERE id = ${MARKET}`;
    feed('51000');
    expect((await positions.get(ALICE, long.id!)).contractSize).toBe('0.01');
  });

  it('percentage is CCXT percent points, half-up when unrealised over initial margin does not terminate', () => {
    expect(formatAmount(positionPercentage(amt('1'), amt('3')))).toBe('33.333333333333333333');
  });

  it('a closed row reports the posted realised pnl, closedAt, and a legacy null with a reason', async () => {
    await fundProfitSource('10000');
    const pos = await openSide('close-pnl', 'long');
    const openedAt = pos.timestamp;
    feed('51000');
    const closed = await positions.close(ALICE, pos.id!);
    expect(closed.realizedPnl).toBe('1000');
    expect(closed.unrealizedPnl).toBeNull();
    expect(closed.percentage).toBeNull();
    expect(closed.maintenanceMargin).toBeNull();
    expect(closed.fieldReasons).toMatchObject({
      unrealizedPnl: 'position_closed',
      percentage: 'position_closed',
      maintenanceMargin: 'position_closed',
    });
    expect(postedAmount('futures.profit.realized', pos.id!)).toBe('1000');
    expect(closed.closedAt).toBeTruthy();
    expect(closed.timestamp).toBe(openedAt);
    expect(closed.updatedAt).toBeTruthy();

    const listed = await positions.listClosed(ALICE, { limit: 10 });
    expect(listed[0]!.realizedPnl).toBe(closed.realizedPnl);
    expect(listed[0]!.closedAt).toBe(closed.closedAt);
    expect(listed[0]!.timestamp).toBe(openedAt);

    await sql`UPDATE trade.positions SET closed_at = NULL, updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ${pos.id}`;
    const legacy = await positions.get(ALICE, pos.id!);
    expect(legacy.closedAt).toBeNull();
    expect(legacy.fieldReasons?.closedAt).toBe('closed_at_not_recorded');
    expect(legacy.timestamp).toBe(openedAt);
    expect(legacy.updatedAt).not.toBe(legacy.closedAt);

    const migration = readFileSync(join(drizzle, '0059_futures_position_fields.sql'), 'utf8');
    const down = readFileSync(join(drizzle, '0059_futures_position_fields.down.sql'), 'utf8');
    expect(migration).not.toMatch(/closed_at\s*=\s*(p\.)?updated_at/i);
    expect(down).toMatch(/contract_size/);
    await sql`INSERT INTO trade.position_close_intents (user_id, client_close_id, position_id, quantity, result, created_at)
      VALUES (${ALICE}, 'legacy-close', ${pos.id}, '1', '{}'::jsonb, '2024-06-01T00:00:00.000Z')`;
    await sql.unsafe(migration);
    const [backfilled] = await sql<{ closed_at: Date }[]>`SELECT closed_at FROM trade.positions WHERE id = ${pos.id}`;
    expect(backfilled!.closed_at.toISOString()).toBe('2024-06-01T00:00:00.000Z');
  });

  it('a closed row keeps realised pnl and drops live unrealised, percentage and maintenance after the mark moves', async () => {
    await fundProfitSource('10000');
    const pos = await openSide('close-settled', 'long');
    feed('51000');
    const closed = await positions.close(ALICE, pos.id!);
    expect(closed.realizedPnl).toBe('1000');
    expect(closed.unrealizedPnl).toBeNull();
    expect(closed.percentage).toBeNull();
    expect(closed.maintenanceMargin).toBeNull();
    expect(closed.fieldReasons).toMatchObject({
      unrealizedPnl: 'position_closed',
      percentage: 'position_closed',
      maintenanceMargin: 'position_closed',
    });

    feed('60000');
    const got = await positions.get(ALICE, pos.id!);
    expect(got.markPrice).toBe('60000');
    expect(got.realizedPnl).toBe('1000');
    expect(got.unrealizedPnl).toBeNull();
    expect(got.percentage).toBeNull();
    expect(got.maintenanceMargin).toBeNull();
    expect(got.fieldReasons).toMatchObject({
      unrealizedPnl: 'position_closed',
      percentage: 'position_closed',
      maintenanceMargin: 'position_closed',
    });
    const listed = await positions.listClosed(ALICE, { limit: 10 });
    expect(listed[0]!.id).toBe(pos.id);
    expect(listed[0]!.realizedPnl).toBe('1000');
    expect(listed[0]!.unrealizedPnl).toBeNull();
    expect(listed[0]!.percentage).toBeNull();
    expect(listed[0]!.maintenanceMargin).toBeNull();
    expect(listed[0]!.fieldReasons).toMatchObject({
      unrealizedPnl: 'position_closed',
      percentage: 'position_closed',
      maintenanceMargin: 'position_closed',
    });
  });

  it('a liquidated row does not synthesise realised pnl from the tick mark', async () => {
    const pos = await openSide('liq-no-pnl', 'long');
    feed('45600');
    await sql`
      UPDATE trade.positions
      SET status = 'liquidated', closed_at = now(), updated_at = now(), accepted_mark = '45600'
      WHERE id = ${pos.id}
    `;
    const got = await positions.get(ALICE, pos.id!);
    expect(got.status).toBe('liquidated');
    expect(got.realizedPnl).toBeNull();
    expect(got.unrealizedPnl).toBeNull();
    expect(got.percentage).toBeNull();
    expect(got.maintenanceMargin).toBeNull();
    expect(got.fieldReasons).toMatchObject({
      realizedPnl: 'realized_pnl_not_recorded',
      unrealizedPnl: 'position_closed',
      percentage: 'position_closed',
      maintenanceMargin: 'position_closed',
    });
    const listed = await positions.listClosed(ALICE, { limit: 10 });
    const row = listed.find((item) => item.id === pos.id);
    expect(row?.realizedPnl).toBeNull();
    expect(row?.unrealizedPnl).toBeNull();
    expect(row?.percentage).toBeNull();
    expect(row?.maintenanceMargin).toBeNull();
    expect(row?.fieldReasons).toMatchObject({
      realizedPnl: 'realized_pnl_not_recorded',
      unrealizedPnl: 'position_closed',
      percentage: 'position_closed',
      maintenanceMargin: 'position_closed',
    });
  });

  it('closing twice posts once and returns the same closed row; another account is not found; a rolled-back close can run', async () => {
    await fundProfitSource('10000');
    const pos = await openSide('replay-close', 'long');
    feed('51000');
    const journalBefore = ledger.journal().length;
    const first = await positions.close(ALICE, pos.id!);
    const journalAfter = ledger.journal().length;
    expect(journalAfter).toBeGreaterThan(journalBefore);
    const second = await positions.close(ALICE, pos.id!);
    expect(ledger.journal().length).toBe(journalAfter);
    expect(second.replayed).toBe(true);
    const { replayed: _replayed, ...again } = second;
    expect(again).toEqual(first);
    await expect(positions.close(BOB, pos.id!)).rejects.toMatchObject({ code: 'trade.position_not_found', status: 404 });

    feed('50000');
    const other = await openSide('rollback-close', 'long');
    feed('51000');
    const original = ledger.post.bind(ledger);
    ledger.post = async () => {
      throw new Error('ledger down');
    };
    await expect(positions.close(ALICE, other.id!)).rejects.toThrow('ledger down');
    ledger.post = original;
    const [rolled] = await sql<{ status: string }[]>`SELECT status FROM trade.positions WHERE id = ${other.id}`;
    expect(rolled!.status).toBe('open');
    const recovered = await positions.close(ALICE, other.id!);
    expect(recovered.status).toBe('closed');
    expect(recovered.realizedPnl).toBe('1000');
    expect(recovered.replayed).toBeUndefined();
  });

  it('a missing mark on open leaves no hold, and the same client id succeeds once the mark returns', async () => {
    marks.clear(MARKET);
    const before = await available();
    const posts = ledger.journal().length;
    await expect(
      positions.open({
        clientOpenId: 'no-mark',
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        side: 'long',
        size: amt('1'),
        leverage: amt('10'),
        positionMode: 'one_way',
      }),
    ).rejects.toMatchObject({ code: 'trade.mark_missing' });
    expect(await sql`SELECT id FROM trade.positions WHERE user_id = ${ALICE}`).toHaveLength(0);
    expect(await available()).toBe(before);
    expect(ledger.journal().length).toBe(posts);
    feed('50000');
    const opened = await positions.open({
      clientOpenId: 'no-mark',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
      positionMode: 'one_way',
    });
    expect(opened.status).toBe('open');
    expect(await sql`SELECT id FROM trade.positions WHERE user_id = ${ALICE}`).toHaveLength(1);
  });

  it('a profitable close on an unusable mark rolls back, and the same close succeeds once the mark is usable', async () => {
    await fundProfitSource('10000');
    const pos = await openSide('payout-mark', 'long');
    const availableAfterOpen = await available();
    const posts = ledger.journal().length;
    feed('51000', 'last');
    await expect(positions.close(ALICE, pos.id!)).rejects.toMatchObject({ code: 'trade.mark_unusable' });
    const [still] = await sql<{ status: string }[]>`SELECT status FROM trade.positions WHERE id = ${pos.id}`;
    expect(still!.status).toBe('open');
    expect(await available()).toBe(availableAfterOpen);
    expect(ledger.journal().length).toBe(posts);
    feed('51000', 'mid');
    const closed = await positions.close(ALICE, pos.id!);
    expect(closed.status).toBe('closed');
    expect(closed.realizedPnl).toBe('1000');
  });
});
