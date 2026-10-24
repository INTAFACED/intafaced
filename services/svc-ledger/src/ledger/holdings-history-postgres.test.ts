import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { LEDGER_HOLDINGS_HISTORY_WINDOW_INVALID } from '@intafaced/contracts';
import { formatAmount, parseAmount as amt, recipes, type Amount } from '@intafaced/ledger-client';
import { PostgresLedger } from './postgres-ledger.js';
import { parseHoldingsHistoryInput, serializeHoldingsHistory, type HoldingsHistory } from './holdings-history.js';

/**
 * `holdingsHistory` answers what one owner holds now and the signed net of how it moved since `from`, per asset,
 * reason and bucket, in one snapshot. The invariant it exists for: holdings minus every movement since `from` is what
 * the owner held at `from` (here: nothing, as the history starts inside the window).
 * PG-hard like `history-page-postgres.test.ts`: TEST_DATABASE_URL in CI, Testcontainers locally.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

const TAKER = '91111111-1111-4111-8111-111111111111';
const MAKER = '92222222-2222-4222-8222-222222222222';
const TAKER_ORDER = 'e1111111-1111-4111-8111-e11111111111';
const MAKER_ORDER = 'e2222222-2222-4222-8222-e22222222222';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('intafaced_holdings_history_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    throw new Error(
      `holdingsHistory is PG-hard (no skip-green). TEST_DATABASE_URL unset and Testcontainers could not start: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** The start of the day before now, on the UTC day boundary: every movement in this test is after it. */
const dayBefore = (): string => new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 - 86_400_000).toISOString();

const netOf = (read: HoldingsHistory, assetId: string): Amount =>
  read.movements.filter((m) => m.assetId === assetId).reduce((sum, m) => sum + m.net, 0n);
const heldOf = (read: HoldingsHistory, assetId: string): Amount => read.holdings.find((h) => h.assetId === assetId)?.amount ?? 0n;

describe('PostgresLedger.holdingsHistory', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_holdings_history', url: admin.url, migrations });
    engine = new PostgresLedger(db.sql);

    await engine.post(recipes.deposit({ userId: TAKER, assetId: 'USDT', amount: amt('1000'), rail: 'crypto-native', railRef: 'hh-usdt' }));
    await engine.post(recipes.deposit({ userId: MAKER, assetId: 'BTC', amount: amt('1'), rail: 'crypto-native', railRef: 'hh-btc' }));
    // The taker buys 0.01 BTC for 600 USDT (an order hold of 700, the rest released); the taker fee is taken in BTC.
    await engine.post(recipes.orderHold({ orderId: TAKER_ORDER, userId: TAKER, assetId: 'USDT', amount: amt('700') }));
    await engine.post(recipes.orderHold({ orderId: MAKER_ORDER, userId: MAKER, assetId: 'BTC', amount: amt('0.01') }));
    await engine.post(
      recipes.tradeFill({
        fillId: 'hh-fill-1',
        makerId: MAKER,
        takerId: TAKER,
        makerOrderId: MAKER_ORDER,
        takerOrderId: TAKER_ORDER,
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        qty: amt('0.01'),
        quoteAmount: amt('600'),
        takerSide: 'buy',
        makerFeeBps: 10,
        takerFeeBps: 20,
      }),
    );
    await engine.post(recipes.orderHoldRelease({ orderId: TAKER_ORDER, userId: TAKER, assetId: 'USDT', amount: amt('100') }));
    // One withdrawal settles (value leaves), one is put on hold and reversed (nothing leaves), one is still on hold.
    const w = (withdrawalId: string, amount: string) => ({
      userId: TAKER,
      assetId: 'BTC',
      amount: amt(amount),
      rail: 'crypto-native',
      withdrawalId,
    });
    await engine.post(recipes.withdrawHold(w('hh-w-settled', '0.003')));
    await engine.post(recipes.withdrawSettle(w('hh-w-settled', '0.003')));
    await engine.post(recipes.withdrawHold(w('hh-w-reversed', '0.002')));
    await engine.post(recipes.withdrawReverse(w('hh-w-reversed', '0.002')));
    await engine.post(recipes.withdrawHold(w('hh-w-open', '0.001')));
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  const read = (ownerId: string, over: Record<string, unknown> = {}) =>
    engine.holdingsHistory(parseHoldingsHistoryInput({ ownerType: 'user', ownerId, from: dayBefore(), bucketSeconds: 60, ...over }));

  it('holds what every account of the owner holds, locks included', async () => {
    const got = await read(TAKER);
    const balances = await engine.balances('user', TAKER);
    for (const assetId of ['USDT', 'BTC']) {
      const sum = balances.filter((b) => b.account.assetId === assetId).reduce((s, b) => s + b.amount, 0n);
      expect(heldOf(got, assetId), assetId).toBe(sum);
    }
    // 0.01 BTC less the 20 bps taker fee, less the settled 0.003; the open withdrawal's 0.001 is still the owner's.
    expect(formatAmount(heldOf(got, 'BTC'))).toBe('0.00698');
    expect(formatAmount(heldOf(got, 'USDT'))).toBe('400');
  });

  it('replays to nothing: holdings minus every movement since before the first one is zero', async () => {
    const got = await read(TAKER);
    for (const assetId of ['USDT', 'BTC']) expect(heldOf(got, assetId) - netOf(got, assetId), assetId).toBe(0n);
  });

  it('leaves out moves between the owner own accounts and keeps what crossed its edge', async () => {
    const got = await read(TAKER);
    const reasons = got.movements.map((m) => `${m.assetId} ${m.reason}`);
    expect(reasons).not.toContain('USDT order.hold');
    expect(reasons).not.toContain('USDT order.hold.released');
    expect(reasons).not.toContain('BTC withdraw.held');
    expect(reasons).not.toContain('BTC withdraw.reversed');
    const row = (assetId: string, reason: string) => got.movements.filter((m) => m.assetId === assetId && m.reason === reason);
    const deposit = got.movements.find((m) => m.assetId === 'USDT' && m.net > 0n);
    expect(deposit && formatAmount(deposit.net)).toBe('1000');
    expect(row('USDT', 'trade.fill').map((m) => formatAmount(m.net))).toEqual(['-600']);
    expect(row('BTC', 'trade.fill').map((m) => [formatAmount(m.net), formatAmount(m.fee)])).toEqual([['0.00998', '0.00002']]);
    expect(row('BTC', 'withdraw.settled').map((m) => formatAmount(m.net))).toEqual(['-0.003']);
  });

  it('names the fee only on the receiving line: the paid side carries 0', async () => {
    const got = await read(TAKER);
    for (const m of got.movements)
      if (!(m.assetId === 'BTC' && m.reason === 'trade.fill')) expect(m.fee, `${m.assetId} ${m.reason}`).toBe(0n);
  });

  it('never answers with another owner: the maker side of the same fill stays out', async () => {
    const taker = await read(TAKER);
    const maker = await read(MAKER);
    expect(taker.holdings.map((h) => h.assetId).sort()).toEqual(['BTC', 'USDT']);
    expect(formatAmount(netOf(maker, 'BTC'))).toBe('0.99');
    expect(formatAmount(heldOf(maker, 'USDT'))).toBe('599.4');
    expect(maker.movements.find((m) => m.assetId === 'BTC' && m.reason === 'trade.fill')?.fee).toBe(0n);
  });

  it('buckets on the UTC grid it was asked for', async () => {
    const got = await read(TAKER, { bucketSeconds: 86_400 });
    for (const m of got.movements) expect(m.bucketStart % 86_400).toBe(0);
    const minute = await read(TAKER);
    for (const m of minute.movements) expect(m.bucketStart % 60).toBe(0);
    for (const assetId of ['USDT', 'BTC']) expect(netOf(got, assetId)).toBe(netOf(minute, assetId));
  });

  it('answers a start after every movement with the holdings and no movements', async () => {
    const nextMinute = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 60_000);
    // A start in the next minute is in the future: refused. The start of this minute may still hold movements.
    expect(() =>
      parseHoldingsHistoryInput({ ownerType: 'user', ownerId: TAKER, from: nextMinute.toISOString(), bucketSeconds: 60 }),
    ).toThrow(expect.objectContaining({ code: LEDGER_HOLDINGS_HISTORY_WINDOW_INVALID }));
    const nobody = await read('93333333-3333-4333-8333-333333333333');
    expect(nobody).toMatchObject({ holdings: [], movements: [] });
  });

  it('refuses a start off its bucket boundary, so no bucket is cut', () => {
    expect(() => parseHoldingsHistoryInput({ ownerType: 'user', ownerId: TAKER, from: '2026-10-01T00:00:30Z', bucketSeconds: 60 })).toThrow(
      expect.objectContaining({ code: LEDGER_HOLDINGS_HISTORY_WINDOW_INVALID }),
    );
    expect(() =>
      parseHoldingsHistoryInput({ ownerType: 'user', ownerId: TAKER, from: '2026-10-01T01:00:00Z', bucketSeconds: 86_400 }),
    ).toThrow(expect.objectContaining({ code: LEDGER_HOLDINGS_HISTORY_WINDOW_INVALID }));
  });

  it('serializes as decimal strings with ISO bucket starts', async () => {
    const input = parseHoldingsHistoryInput({ ownerType: 'user', ownerId: TAKER, from: dayBefore(), bucketSeconds: 60 });
    const wire = serializeHoldingsHistory(input, await engine.holdingsHistory(input));
    expect(wire.from).toBe(dayBefore());
    expect(wire.bucketSeconds).toBe(60);
    expect(wire.movements.every((m) => /^-?\d+(\.\d+)?$/.test(m.net) && /^\d+(\.\d+)?$/.test(m.fee))).toBe(true);
    expect(wire.movements.every((m) => m.bucketStart.endsWith(':00.000Z'))).toBe(true);
  });
});
