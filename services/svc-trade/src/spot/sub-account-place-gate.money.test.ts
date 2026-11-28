import { TradeService, readyTestAdmission } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testPostgres } from '@intafaced/db/test-postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import type { SubAccountOwnership } from '@intafaced/contracts';

import type { Market } from './types.js';
import { TradeError } from './types.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from './testing.js';
import { parseFeeScheduleJson } from './fee-schedule.js';
import type { SubAccountOwnershipSource } from './sub-account-ownership.js';

/**
 * The sub-account ownership gate at placement (§4.1 sub_accounts), on Postgres and the ledger. placeOrder may label an
 * order with a sub-account only after identity says the caller is its parent and it is live: a stranger's book, a
 * missing id, a revoked one, or identity being down refuses the order before any row is stored or any hold is taken.
 * The owner's own live book is stored on the order. Moved here from svc-identity's money-routing gate, which read this
 * service's source to check the same thing. Fee rates are TEST values.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
/** Alice's live sub-account, her retired one, and an id identity has never heard of. */
const SUB = '44444444-4444-4444-8444-444444444444';
const RETIRED = '55555555-5555-4555-8555-555555555555';
const GHOST = '66666666-6666-4666-8666-666666666666';

const FEES = parseFeeScheduleJson(
  JSON.stringify({
    published: true,
    version: 'test-sub-account-gate',
    defaultPairGroup: 'all-others',
    rows: [{ pairGroup: 'all-others', tierId: 'regular', zeroFee: false, makerBps: '3', takerBps: '7', minFee: null }],
  }),
);

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await testPostgres('postgres:16-alpine')
    .withDatabase('intafaced_sub_account_gate_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('svc-trade placeOrder sub-account ownership gate', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let btcusdt: Market;
  /** Every id the gate asked identity about, in order. */
  let asked: string[];
  let identityDown: boolean;

  const owned: Record<string, SubAccountOwnership> = {
    [SUB]: { id: SUB, parentUserId: ALICE, revoked: false },
    [RETIRED]: { id: RETIRED, parentUserId: ALICE, revoked: true },
  };
  const subAccounts: SubAccountOwnershipSource = {
    get: async (id: string) => {
      asked.push(id);
      if (identityDown) throw new TradeError('sub-account ownership unavailable (503)', 'trade.sub_account_unavailable');
      return owned[id] ?? null;
    },
  };

  const service = () =>
    new TradeService(sql, ledger, new StubMatching(), new StubPerks(), new MemoryEventBus('svc-trade'), {
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      feeSchedule: FEES,
      subAccounts,
      accountAdmission: readyTestAdmission(),
    });

  const place = (userId: string, clientOrderId: string, subAccountId: string) =>
    service().placeOrder(principalFor(userId), {
      marketId: btcusdt.id,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('100'),
      clientOrderId,
      subAccountId,
    });
  const orders = async () =>
    sql<Array<{ user_id: string; sub_account_id: string | null; client_order_id: string }>>`
      SELECT user_id, sub_account_id, client_order_id FROM trade.orders ORDER BY created_at`;
  const available = async (userId: string) => formatAmount((await ledger.balance(userAvailable(userId, 'USDT'))).amount);

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
    await sql`TRUNCATE trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    asked = [];
    identityDown = false;
    btcusdt = await service().listMarket({
      symbol: 'BTC/USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      minNotional: amt('1'),
      tickSize: amt('0.01'),
      lotSize: amt('0.0001'),
      minQty: amt('0.0001'),
      maxQty: amt('1000'),
      makerBps: 10,
      takerBps: 20,
    });
    for (const userId of [ALICE, BOB]) {
      await ledger.post(recipes.deposit({ userId, assetId: 'USDT', amount: amt('10000'), rail: 'test', railRef: `sub-gate:${userId}` }));
    }
  });

  it('refuses a stranger’s, a missing, a revoked or an unconfirmable sub-account before storing the label or holding funds', async () => {
    const refusals: Array<[string, string, string, () => void]> = [
      ['bob labels alice’s book', BOB, SUB, () => undefined],
      ['alice labels an unknown id', ALICE, GHOST, () => undefined],
      ['alice labels her retired book', ALICE, RETIRED, () => undefined],
      ['identity is down', ALICE, SUB, () => void (identityDown = true)],
    ];
    const codes: string[] = [];
    for (const [why, userId, subAccountId, arrange] of refusals) {
      arrange();
      const err = await place(userId, `refused-${codes.length}`, subAccountId).catch((e: unknown) => e);
      expect(err, why).toBeInstanceOf(TradeError);
      codes.push((err as TradeError).code);
      identityDown = false;
    }
    expect(codes).toEqual([
      'trade.sub_account_denied',
      'trade.sub_account_denied',
      'trade.sub_account_revoked',
      'trade.sub_account_unavailable',
    ]);
    // Identity was asked each time, about the id the order named.
    expect(asked).toEqual([SUB, GHOST, RETIRED, SUB]);
    // Nothing was stored and nothing was held.
    expect(await orders()).toEqual([]);
    expect([await available(ALICE), await available(BOB)]).toEqual(['10000', '10000']);
  });

  it('stores the owner’s own live sub-account on the order', async () => {
    const order = await place(ALICE, 'alice-sub', SUB);
    expect(asked).toEqual([SUB]);
    expect(await orders()).toEqual([{ user_id: ALICE, sub_account_id: SUB, client_order_id: 'alice-sub' }]);
    expect(order.id).toBeDefined();
    // The funds are held on the parent, as for any order: the label is not a second book.
    expect(await available(ALICE)).not.toBe('10000');
  });
});
