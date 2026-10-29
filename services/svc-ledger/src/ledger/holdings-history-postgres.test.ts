import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import {
  LEDGER_HOLDINGS_HISTORY_TOO_LARGE,
  LEDGER_HOLDINGS_HISTORY_WINDOW_INVALID,
  ledgerHoldingsHistorySchema,
} from '@intafaced/contracts';
import { formatAmount, parseAmount as amt, recipes, type Amount } from '@intafaced/ledger-client';
import { PostgresLedger } from './postgres-ledger.js';
import { historyPageInputSchema } from './history.js';
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
const BB_PAYER = '95555555-5555-4555-8555-555555555555';
const BB_MAKER = '94444444-4444-4444-8444-444444444444';
const BB_ASK = 'e3333333-3333-4333-8333-e33333333333';

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

/** The start of the day before now, on the UTC day boundary: every movement in this test is after it. Read once. */
const FROM = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 - 86_400_000).toISOString();

const netOf = (read: HoldingsHistory, assetId: string): Amount =>
  read.movements.filter((m) => m.assetId === assetId).reduce((sum, m) => sum + m.inflow - m.outflow, 0n);
const heldOf = (read: HoldingsHistory, assetId: string): Amount => read.holdings.find((h) => h.assetId === assetId)?.amount ?? 0n;
const userAvailable = (ownerId: string, assetId: string) => ({ ownerType: 'user' as const, ownerId, assetId, kind: 'available' as const });

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
    // 50 USDT comes in from the maker and goes straight back, under one reason: money in and money out, not nothing.
    const send = (transferId: string, from: string, to: string) =>
      recipes.bankTransfer({
        transferId,
        occurrence: 0,
        kind: 'manual',
        keySpace: 'p2p',
        from: userAvailable(from, 'USDT'),
        to: userAvailable(to, 'USDT'),
        amount: amt('50'),
      });
    await engine.post(send('hh-t-in', MAKER, TAKER));
    await engine.post(send('hh-t-back', TAKER, MAKER));
    // The token buyback buys 0.5 BTC for 300 USDT from BB_MAKER's ask at a 10 bps maker fee (TEST amounts).
    await engine.post(
      recipes.deposit({ userId: BB_PAYER, assetId: 'USDT', amount: amt('300'), rail: 'crypto-native', railRef: 'hh-bb-fee' }),
    );
    await engine.post(
      recipes.feeCharge({ chargeId: 'hh-bb-fee', userId: BB_PAYER, module: 'trade', mode: 'asset', assetId: 'USDT', amount: amt('300') }),
    );
    await engine.post(
      recipes.sweepFeesToRewards({ windowId: 'buyback:hh-bb', sourceModule: 'trade', assetId: 'USDT', amount: amt('300') }),
    );
    await engine.post(recipes.buybackOrderHold({ orderId: 'hh-bb-order', quoteAsset: 'USDT', amount: amt('300') }));
    await engine.post(recipes.deposit({ userId: BB_MAKER, assetId: 'BTC', amount: amt('1'), rail: 'crypto-native', railRef: 'hh-bb-btc' }));
    await engine.post(recipes.orderHold({ orderId: BB_ASK, userId: BB_MAKER, assetId: 'BTC', amount: amt('0.5') }));
    await engine.post(
      recipes.buybackTakerFill({
        fillId: 'hh-bb-fill',
        makerId: BB_MAKER,
        makerOrderId: BB_ASK,
        takerOrderId: 'hh-bb-order',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        qty: amt('0.5'),
        quoteAmount: amt('300'),
        makerFeeBps: 10,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  const ask = (ownerId: string, over: Record<string, unknown> = {}) =>
    parseHoldingsHistoryInput({ ownerType: 'user', ownerId, from: FROM, bucketSeconds: 60, ...over });
  const read = (ownerId: string, over: Record<string, unknown> = {}) => engine.holdingsHistory(ask(ownerId, over));
  const rowsOf = (got: HoldingsHistory, assetId: string, reason: string) =>
    got.movements.filter((m) => m.assetId === assetId && m.reason === reason);

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

  it('replays to nothing: holdings less every movement since before the first one is zero', async () => {
    const got = await read(TAKER);
    for (const assetId of ['USDT', 'BTC']) expect(heldOf(got, assetId) - netOf(got, assetId), assetId).toBe(0n);
    const maker = await read(MAKER);
    for (const assetId of ['USDT', 'BTC']) expect(heldOf(maker, assetId) - netOf(maker, assetId), assetId).toBe(0n);
  });

  it('leaves out moves between the owner own accounts and keeps what crossed its edge', async () => {
    const got = await read(TAKER);
    const reasons = got.movements.map((m) => `${m.assetId} ${m.reason}`);
    for (const internal of ['USDT order.hold', 'USDT order.hold.released', 'BTC withdraw.held', 'BTC withdraw.reversed']) {
      expect(reasons).not.toContain(internal);
    }
    const flows = (assetId: string, reason: string) =>
      rowsOf(got, assetId, reason).map((m) => [formatAmount(m.inflow), formatAmount(m.outflow), formatAmount(m.fee)]);
    const deposit = got.movements.filter((m) => m.assetId === 'USDT' && m.module !== 'trade' && m.inflow > 0n && m.outflow === 0n);
    expect(deposit.map((m) => formatAmount(m.inflow))).toEqual(['1000']);
    expect(flows('USDT', 'trade.fill')).toEqual([['0', '600', '0']]);
    expect(flows('BTC', 'trade.fill')).toEqual([['0.00998', '0', '0.00002']]);
    expect(flows('BTC', 'withdraw.settled')).toEqual([['0', '0.003', '0']]);
  });

  it('keeps money in and money out under one reason in one bucket apart', async () => {
    const got = await read(TAKER);
    expect(rowsOf(got, 'USDT', 'bank.transfer.manual').map((m) => [formatAmount(m.inflow), formatAmount(m.outflow)])).toEqual([
      ['50', '50'],
    ]);
  });

  it('names the same fee as historyPage for the same fill', async () => {
    const got = await read(TAKER);
    const page = await engine.historyPage(
      historyPageInputSchema.parse({ ownerType: 'user', ownerId: TAKER, kind: 'available', assetId: 'BTC', limit: 200 }),
    );
    const fillLine = page.entries.find((e) => e.reason === 'trade.fill' && e.direction === 'debit');
    expect(fillLine?.fee).not.toBeNull();
    expect(rowsOf(got, 'BTC', 'trade.fill')[0]?.fee).toBe(fillLine!.fee);
  });

  it('names the fee only on the receiving line: the paid side carries 0', async () => {
    const got = await read(TAKER);
    for (const m of got.movements)
      if (!(m.assetId === 'BTC' && m.reason === 'trade.fill')) expect(m.fee, `${m.assetId} ${m.reason}`).toBe(0n);
  });

  it('a buyback fill against a customer ask: the maker sold base and received quote less the maker fee', async () => {
    const got = await read(BB_MAKER);
    const flows = (assetId: string) =>
      rowsOf(got, assetId, 'trade.fill.buyback').map((m) => [formatAmount(m.inflow), formatAmount(m.outflow), formatAmount(m.fee)]);
    expect(flows('USDT')).toEqual([['299.7', '0', '0.3']]);
    expect(flows('BTC')).toEqual([['0', '0.5', '0']]);
    for (const assetId of ['USDT', 'BTC']) expect(heldOf(got, assetId) - netOf(got, assetId), assetId).toBe(0n);
  });

  it('never answers with another owner: the maker side of the same fill stays out', async () => {
    const taker = await read(TAKER);
    const maker = await read(MAKER);
    expect(taker.holdings.map((h) => h.assetId).sort()).toEqual(['BTC', 'USDT']);
    expect(formatAmount(netOf(maker, 'BTC'))).toBe('0.99');
    expect(formatAmount(heldOf(maker, 'USDT'))).toBe('599.4');
    expect(rowsOf(maker, 'BTC', 'trade.fill').map((m) => m.fee)).toEqual([0n]);
  });

  it('buckets on the UTC grid it was asked for, with the same totals at every size', async () => {
    const day = await read(TAKER, { bucketSeconds: 86_400 });
    for (const m of day.movements) expect(m.bucketStart.getTime() % 86_400_000).toBe(0);
    const minute = await read(TAKER);
    for (const m of minute.movements) expect(m.bucketStart.getTime() % 60_000).toBe(0);
    for (const assetId of ['USDT', 'BTC']) expect(netOf(day, assetId)).toBe(netOf(minute, assetId));
  });

  it('answers the same holdings whatever the start: a later start only has fewer movements', async () => {
    const all = await read(TAKER);
    const thisMinute = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
    const late = await read(TAKER, { from: thisMinute });
    expect(late.holdings).toEqual(all.holdings);
    expect(late.movements.length).toBeLessThanOrEqual(all.movements.length);
    const nobody = await read('93333333-3333-4333-8333-333333333333');
    expect(nobody).toMatchObject({ holdings: [], movements: [] });
  });

  it('refuses more rows than it may carry instead of answering short', async () => {
    const count = (await read(TAKER)).movements.length;
    await expect(engine.holdingsHistory(ask(TAKER), count)).resolves.toMatchObject({ movements: expect.any(Array) });
    await expect(engine.holdingsHistory(ask(TAKER), count - 1)).rejects.toMatchObject({ code: LEDGER_HOLDINGS_HISTORY_TOO_LARGE });
  });

  it('refuses a start in the future or off its bucket boundary, so no bucket is cut', () => {
    const nextMinute = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 60_000).toISOString();
    const refused = { code: LEDGER_HOLDINGS_HISTORY_WINDOW_INVALID };
    expect(() => ask(TAKER, { from: nextMinute })).toThrow(expect.objectContaining(refused));
    expect(() => ask(TAKER, { from: '2026-10-01T00:00:30Z' })).toThrow(expect.objectContaining(refused));
    expect(() => ask(TAKER, { from: '2026-10-01T01:00:00Z', bucketSeconds: 86_400 })).toThrow(expect.objectContaining(refused));
  });

  it('serializes as decimal strings with ISO bucket starts that pass the contract', async () => {
    const input = ask(TAKER);
    const wire = serializeHoldingsHistory(input, await engine.holdingsHistory(input));
    expect(wire.from).toBe(FROM);
    expect(ledgerHoldingsHistorySchema.parse(wire)).toEqual(wire);
    expect(wire.movements.every((m) => m.bucketStart.endsWith(':00.000Z'))).toBe(true);
  });
});
