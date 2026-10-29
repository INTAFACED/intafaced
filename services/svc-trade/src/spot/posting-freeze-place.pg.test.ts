/**
 * The platform posting freeze (svc-ledger) on the order door (PG-hard, never skipped; DV-errors-02, J-developer-04 #6).
 *
 * While the ledger refuses every post `ledger.frozen`, a new order is refused before it reaches the engine: the
 * pending row is gone, no hold is booked, the balance is untouched, and the API names the reason `posting_frozen`.
 * After the freeze lifts, the same client order id places once. Amounts are TEST FIXTURES, never product law.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { LedgerError, MemoryLedger, parseAmount as amt, recipes, type LedgerTx, type PostRequest } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POSTING_FROZEN, toCcxtError } from '../ccxt-errors.js';
import { TradeService } from '../controls/test-admission.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from './testing.js';
import type { Market } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';

/** svc-ledger's freeze: every post refuses `ledger.frozen` before any balance is read; reads still answer. */
class FreezableLedger extends MemoryLedger {
  frozen = false;
  override async post(request: PostRequest): Promise<LedgerTx> {
    if (this.frozen) throw new LedgerError('Ledger posting is frozen: TEST freeze', 'ledger.frozen');
    return super.post(request);
  }
}

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_posting_freeze_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('the order door under the platform posting freeze (PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let trade: TradeService;
  let matching: StubMatching;
  let ledger: FreezableLedger;
  let btc: Market;
  const alice = principalFor(ALICE, ['trade:read', 'trade:write']);

  const place = (key: string) =>
    trade.placeOrder(alice, {
      marketId: btc.id,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('50'),
      clientOrderId: key,
    } as never);
  const holds = () => ledger.journal().filter((tx) => tx.reason === 'order.hold').length;
  const usdt = async () => (await ledger.balances('user', ALICE)).filter((b) => b.account.assetId === 'USDT');

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 30_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    ledger = new FreezableLedger();
    matching = new StubMatching();
    matching.asks = [['100', '5']];
    matching.bids = [['99', '5']];
    trade = new TradeService(db.sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 200,
    });
    btc = await trade.listMarket({
      symbol: 'BTC/USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      tickSize: amt('0.01'),
      lotSize: amt('0.0001'),
      minQty: amt('0.0001'),
      maxQty: amt('1000'),
      minNotional: amt('1'),
      makerBps: 10,
      takerBps: 20,
    });
    await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: `${ALICE}:u` }));
  });

  it('refuses posting_frozen with nothing held, no row left and nothing sent to the engine; the read still answers', async () => {
    const before = await usdt();
    ledger.frozen = true;
    let caught: unknown;
    try {
      await place('freeze-1');
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ name: 'LedgerError', code: 'ledger.frozen' });
    expect(toCcxtError(caught)).toMatchObject({ status: 503, body: { code: 'OnMaintenance', intafacedCode: POSTING_FROZEN } });
    expect(holds()).toBe(0);
    // Whose funds are stranded if it stops here? Nobody's: no hold, and no pending row waits for one.
    expect(await db.sql`SELECT id FROM trade.orders WHERE client_order_id = 'freeze-1'`).toHaveLength(0);
    expect(matching.submitted).toHaveLength(0);
    // A read during the freeze answers, and shows the balance unchanged.
    expect(await usdt()).toEqual(before);
  });

  it('after the freeze lifts, the same client order id places once with one hold', async () => {
    ledger.frozen = true;
    await expect(place('freeze-2')).rejects.toMatchObject({ code: 'ledger.frozen' });
    ledger.frozen = false;
    const placed = await place('freeze-2');
    expect(placed.clientOrderId).toBe('freeze-2');
    const again = await place('freeze-2');
    expect(again.id).toBe(placed.id);
    expect(holds()).toBe(1);
    expect(await db.sql`SELECT id FROM trade.orders WHERE client_order_id = 'freeze-2'`).toHaveLength(1);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });
});
