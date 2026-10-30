import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount as amt, recipes, userAvailable, orderHoldAccount } from '@intafaced/ledger-client';
import './oco-place.js';
// The inner installers run after the bracket wrapper in production (index.ts), so they load first here.
import './post-only-place.js';
import './iceberg-place.js';
import './stop-limit-place.js';
import './bracket-place.js';
import './oco-cancel.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import { type Market } from './types.js';
import { carryPlacementBody } from './placement-extras.js';
import { readOrderLinks } from './order-links.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-trade bracket-exit is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

const tpOf = (id: string) => `${id}:tp`;
const slOf = (id: string) => `${id}:sl`;

describe('svc-trade bracket: entry, then one sell OCO for what was received (H8a PG-hard)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let matching: StubMatching;
  let trade: TradeService;
  let btcusdt: Market;

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

  async function fund(userId: string, assetId: string, amount: string) {
    await ledger.post(
      recipes.deposit({ userId, assetId, amount: amt(amount), rail: 'test', railRef: `${userId}:${assetId}:${amount}:${Math.random()}` }),
    );
  }
  const avail = async (userId: string, assetId: string) => formatAmount((await ledger.balance(userAvailable(userId, assetId))).amount);
  const heldFor = async (userId: string, assetId: string, orderId: string) =>
    formatAmount((await ledger.balance(orderHoldAccount(userId, assetId, orderId))).amount);

  beforeEach(async () => {
    await sql`TRUNCATE trade.order_bracket_intent, trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    matching = new StubMatching();
    trade = new TradeService(sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 200,
    });
    btcusdt = await trade.listMarket({
      symbol: 'BTC/USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      tickSize: amt('0.01'),
      lotSize: amt('0.0001'),
      minQty: amt('0.0001'),
      maxQty: amt('1000'),
      minNotional: amt('1'),
      makerBps: 0,
      takerBps: 0,
    });
  });

  /** Bob rests a sell of 1 BTC at 100; Alice has quote to buy it. */
  async function setup() {
    await fund(BOB, 'BTC', '1');
    await fund(ALICE, 'USDT', '1000');
    const bob = await trade.placeOrder(principalFor(BOB), {
      marketId: btcusdt.id,
      side: 'sell',
      type: 'limit',
      qty: amt('1'),
      price: amt('100'),
      clientOrderId: 'bob-sell-1',
    });
    return { bob };
  }

  const bracketReq = (extra: Record<string, unknown> = {}) =>
    ({
      marketId: btcusdt.id,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('100'),
      tif: 'IOC',
      clientOrderId: 'br-1',
      bracket: true,
      takeProfit: { stopPrice: '110' },
      stopLoss: { stopPrice: '90' },
      ...extra,
    }) as Parameters<TradeService['placeOrder']>[1];

  const exitSubmits = () => matching.submitted.filter((s) => (s.request as { oco?: boolean }).oco === true);

  it('places the sell OCO for the base actually received, once, after the entry fills', async () => {
    const { bob } = await setup();
    matching.scriptFills([{ makerOrderId: bob.id, makerAccountId: BOB, price: '100', qty: '1' }]);
    const entry = await trade.placeOrder(principalFor(ALICE), bracketReq());
    expect(entry.status).toBe('filled');
    const exits = exitSubmits();
    expect(exits).toHaveLength(1);
    const req = exits[0]!.request as { qty: string; takeProfit?: string; stopLoss?: string; side: string };
    expect(req.side).toBe('sell');
    expect(req.takeProfit).toBe('110');
    expect(req.stopLoss).toBe('90');
    // received = filled qty minus the base-side fee; never more than the account actually holds
    expect(Number(req.qty)).toBeLessThanOrEqual(1);
    expect(Number(req.qty)).toBeGreaterThan(0.99);
    const held = await sql<Array<{ id: string }>>`SELECT id FROM trade.orders WHERE user_id = ${ALICE} AND side = 'sell'`;
    expect(held).toHaveLength(1);
    expect(await heldFor(ALICE, 'BTC', held[0]!.id)).toBe(req.qty);
  });

  it('a retry of the same request completes nothing twice: one entry, one exit', async () => {
    const { bob } = await setup();
    matching.scriptFills([{ makerOrderId: bob.id, makerAccountId: BOB, price: '100', qty: '1' }]);
    await trade.placeOrder(principalFor(ALICE), bracketReq());
    await trade.placeOrder(principalFor(ALICE), bracketReq());
    expect(exitSubmits()).toHaveLength(1);
    const buys = await sql<Array<{ id: string }>>`SELECT id FROM trade.orders WHERE user_id = ${ALICE} AND side = 'buy'`;
    expect(buys).toHaveLength(1);
  });

  it('a partial fill sizes the exit to the received part only', async () => {
    const { bob } = await setup();
    matching.scriptFills([{ makerOrderId: bob.id, makerAccountId: BOB, price: '100', qty: '0.4' }], { cancelRemainder: '0.6' });
    await trade.placeOrder(principalFor(ALICE), bracketReq());
    const exits = exitSubmits();
    expect(exits).toHaveLength(1);
    expect(Number((exits[0]!.request as { qty: string }).qty)).toBeLessThanOrEqual(0.4);
    expect(Number((exits[0]!.request as { qty: string }).qty)).toBeGreaterThan(0.39);
  });

  it('an entry that fills nothing places no exit', async () => {
    await fund(ALICE, 'USDT', '1000');
    matching.script1((request, next) => ({
      accepted: true,
      sequence: next(),
      fills: [],
      resting: null,
      rejected: null,
      cancellations: [{ orderId: request.orderId, accountId: ALICE, remainingQty: '1', sequence: next(), reason: 'ioc_remainder' }],
      triggered: [],
    }));
    await trade.placeOrder(principalFor(ALICE), bracketReq());
    expect(exitSubmits()).toHaveLength(0);
    expect(await avail(ALICE, 'USDT')).toBe('1000');
  });

  /** Bob sells `qty` BTC into Alice's resting entry at 100: the engine prints the fill against her order id. */
  async function bobSellsInto(entryId: string, qty: string, clientOrderId: string) {
    await fund(BOB, 'BTC', '1');
    matching.script1((request, next) => {
      const sequence = next();
      return {
        accepted: true,
        sequence,
        fills: [
          {
            sequence: next(),
            makerOrderId: entryId,
            makerAccountId: ALICE,
            takerOrderId: request.orderId,
            takerAccountId: BOB,
            takerSide: 'sell',
            price: '100',
            qty,
          },
        ],
        resting: null,
        rejected: null,
        cancellations: [],
        triggered: [],
      };
    });
    await trade.placeOrder(principalFor(BOB), {
      marketId: btcusdt.id,
      side: 'sell',
      type: 'limit',
      qty: amt(qty),
      price: amt('100'),
      clientOrderId,
      tif: 'IOC',
    });
  }
  const grantRow = async (entryId: string) =>
    (
      await sql<Array<{ grant_claims: unknown; exit_order_id: string | null }>>`
        SELECT grant_claims, exit_order_id FROM trade.order_bracket_intent WHERE order_id = ${entryId}
      `
    )[0];
  const sweepable = (service: TradeService) =>
    service as unknown as { sweepBracketExits: (graceMs: number) => Promise<Record<string, number>> };
  /**
   * The next exit placement fails before any order exists (the ledger or the database refused it), so the fill that
   * ended the entry places nothing and the sweep must.
   */
  function failNextExitPlace() {
    const own = trade as unknown as { placeOrder: TradeService['placeOrder'] };
    const real = TradeService.prototype.placeOrder;
    own.placeOrder = async function (this: TradeService, principal, input) {
      if (/^(bracket:.+:exit|oto:.+:close)$/.test(input.clientOrderId ?? '')) {
        delete (own as { placeOrder?: unknown }).placeOrder;
        throw new Error('the ledger is unreachable');
      }
      return real.call(this, principal, input);
    };
  }
  /** The next exit submit fails (matching unreachable): the exit order exists, held, in its recovery state. */
  function failNextExitSubmit(isExit: (request: Record<string, unknown>) => boolean = (r) => r.oco === true) {
    const realSubmit = matching.submit.bind(matching);
    let armed = true;
    matching.submit = async (marketId, request) => {
      if (armed && isExit(request as unknown as Record<string, unknown>)) {
        armed = false;
        throw new Error('svc-matching is unreachable');
      }
      return realSubmit(marketId, request);
    };
  }

  it('accepts a resting entry on a stored place grant and places no exit while it rests', async () => {
    await fund(ALICE, 'USDT', '1000');
    const entry = await trade.placeOrder(principalFor(ALICE), bracketReq({ tif: 'GTC' }));
    expect(entry.status).toBe('open');
    const row = await grantRow(entry.id);
    expect(row?.grant_claims).toMatchObject({ scopes: ['trade:write'] });
    expect(row?.exit_order_id).toBeNull();
    expect(exitSubmits()).toHaveLength(0);
    // Far from lapsing: the sweep leaves it alone.
    const swept = await sweepable(trade).sweepBracketExits(1_000);
    expect(swept).toMatchObject({ placed: 0, cancelledEntries: 0 });
  });

  it('a resting entry that fills later gets its exit at once from the fill, sized to what was received; the sweep adds none', async () => {
    await fund(ALICE, 'USDT', '1000');
    const entry = await trade.placeOrder(principalFor(ALICE), bracketReq({ tif: 'GTC' }));
    await bobSellsInto(entry.id, '1', 'bob-into-entry');
    expect((await trade.findOrder(entry.id))?.status).toBe('filled');
    const exits = exitSubmits();
    expect(exits).toHaveLength(1);
    const req = exits[0]!.request as { qty: string; side: string };
    expect(req.side).toBe('sell');
    expect(Number(req.qty)).toBeGreaterThan(0.99);
    expect(Number(req.qty)).toBeLessThanOrEqual(1);

    expect(await sweepable(trade).sweepBracketExits(1_000)).toMatchObject({ placed: 0 });
    expect(exitSubmits()).toHaveLength(1);
  });

  it('when the fill cannot place the exit, the fill still settles and the sweep places the exit once', async () => {
    await fund(ALICE, 'USDT', '1000');
    const entry = await trade.placeOrder(principalFor(ALICE), bracketReq({ tif: 'GTC' }));
    failNextExitPlace();
    await bobSellsInto(entry.id, '1', 'bob-into-entry');
    expect((await trade.findOrder(entry.id))?.status).toBe('filled');
    expect(exitSubmits()).toHaveLength(0);
    expect(await sweepable(trade).sweepBracketExits(1_000)).toMatchObject({ placed: 1, failed: 0 });
    expect(exitSubmits()).toHaveLength(1);
    expect((await grantRow(entry.id))?.exit_order_id).not.toBeNull();
    expect(await sweepable(trade).sweepBracketExits(1_000)).toMatchObject({ placed: 0 });
    expect(exitSubmits()).toHaveLength(1);
  });

  it('an exit whose submit is unknown is never recorded as placed: the sweep counts it failed until it is live', async () => {
    await fund(ALICE, 'USDT', '1000');
    const entry = await trade.placeOrder(principalFor(ALICE), bracketReq({ tif: 'GTC' }));
    failNextExitSubmit();
    await bobSellsInto(entry.id, '1', 'bob-into-entry');
    expect((await trade.findOrder(entry.id))?.status).toBe('filled');
    expect((await grantRow(entry.id))?.exit_order_id).toBeNull();
    // The replay of the same key returns the order still in its recovery state: not on the book, so not placed.
    expect(await sweepable(trade).sweepBracketExits(1_000)).toMatchObject({ placed: 0, failed: 1 });
    expect((await grantRow(entry.id))?.exit_order_id).toBeNull();
  });

  it('many resting entries far from their lapse never crowd out a later entry that filled', async () => {
    await fund(ALICE, 'USDT', '100000');
    for (let i = 0; i < 3; i += 1) {
      await trade.placeOrder(principalFor(ALICE), bracketReq({ tif: 'GTC', clientOrderId: `br-rest-${i}`, qty: amt('0.1') }));
    }
    const entry = await trade.placeOrder(principalFor(ALICE), bracketReq({ tif: 'GTC', clientOrderId: 'br-filled' }));
    // The fill's own placement fails, so only the sweep can protect this entry.
    failNextExitPlace();
    await bobSellsInto(entry.id, '1', 'bob-into-entry');
    // A window of 2 rows: the three resting entries must not occupy it.
    const swept = await (
      trade as unknown as { sweepBracketExits: (g: number, l: number) => Promise<Record<string, number>> }
    ).sweepBracketExits(1_000, 2);
    expect(swept).toMatchObject({ placed: 1, cancelledEntries: 0 });
    expect(exitSubmits()).toHaveLength(1);
    expect((await grantRow(entry.id))?.exit_order_id).not.toBeNull();
  });

  it('cancels a resting entry before its grant lapses and protects only the part that filled', async () => {
    await fund(ALICE, 'USDT', '1000');
    const entry = await trade.placeOrder(principalFor(ALICE), bracketReq({ tif: 'GTC' }));
    await bobSellsInto(entry.id, '0.4', 'bob-into-entry');
    expect((await trade.findOrder(entry.id))?.status).toBe('open');

    // The credential lapses within the grace window (the test credential lives one hour).
    expect(await sweepable(trade).sweepBracketExits(2 * 3_600_000)).toMatchObject({ cancelledEntries: 1, placed: 1 });
    expect(matching.cancelledOrders).toContain(entry.id);
    expect((await trade.findOrder(entry.id))?.status).toBe('cancelled');
    const exits = exitSubmits();
    expect(exits).toHaveLength(1);
    expect(Number((exits[0]!.request as { qty: string }).qty)).toBeLessThanOrEqual(0.4);
    expect(Number((exits[0]!.request as { qty: string }).qty)).toBeGreaterThan(0.39);
  });

  it('a fill still settling when the sweep cancels the entry: no exit yet, and no entry counted as cancelled', async () => {
    await fund(ALICE, 'USDT', '1000');
    const entry = await trade.placeOrder(principalFor(ALICE), bracketReq({ tif: 'GTC' }));
    // The engine matched 0.4 a moment ago; the taker's settlement has not written that fill yet.
    matching.scriptLive(entry.id, entry.marketId, '0.6');
    expect(await sweepable(trade).sweepBracketExits(2 * 3_600_000)).toMatchObject({ cancelledEntries: 0, placed: 0 });
    expect(matching.cancelledOrders).toContain(entry.id);
    // The entry keeps its hold until the fill lands; an exit sized now would leave that 0.4 unprotected.
    expect((await trade.findOrder(entry.id))?.status).toBe('open');
    expect(exitSubmits()).toHaveLength(0);
  });

  it('never mints a principal when the stored grant has lapsed: a filled entry with no exit is surfaced, not covered', async () => {
    await fund(ALICE, 'USDT', '1000');
    const entry = await trade.placeOrder(principalFor(ALICE), bracketReq({ tif: 'GTC' }));
    await sql`UPDATE trade.order_bracket_intent SET grant_expires_at = now() - interval '1 minute' WHERE order_id = ${entry.id}`;
    // The fill finds no authority: it places nothing and leaves the row for the sweep to count.
    await bobSellsInto(entry.id, '1', 'bob-into-entry');
    expect(exitSubmits()).toHaveLength(0);
    expect(await sweepable(trade).sweepBracketExits(1_000)).toMatchObject({ placed: 0, unavailable: 1 });
    expect(exitSubmits()).toHaveLength(0);
    // Counted once, then no longer swept.
    expect(await sweepable(trade).sweepBracketExits(1_000)).toMatchObject({ unavailable: 0 });
  });

  it('refuses a resting entry from a credential with no known expiry: the grant could not be bounded', async () => {
    await fund(ALICE, 'USDT', '1000');
    const principal = { ...principalFor(ALICE), expiresAt: undefined } as never;
    await expect(trade.placeOrder(principal, bracketReq({ tif: 'GTC' }))).rejects.toMatchObject({ code: 'trade.order_type_unsupported' });
    expect(matching.submitted).toHaveLength(0);
    expect(await avail(ALICE, 'USDT')).toBe('1000');
  });

  it.each([
    ['a stop-limit entry', { type: 'stop_limit', stopPx: amt('90'), tif: 'IOC' }],
    ['an entry with a stop trigger', { stopPx: amt('90'), tif: 'IOC' }],
    ['an iceberg entry', { icebergQty: amt('0.1'), tif: 'IOC' }],
    ['a post-only entry', { postOnly: true, tif: 'IOC' }],
    ['a trailing-stop entry', { type: 'trailing_stop', tif: 'IOC' }],
  ])('refuses %s: it can sit dormant or rest, so its exit could not be placed on the fill', async (_name, extra) => {
    await fund(ALICE, 'USDT', '1000');
    await expect(trade.placeOrder(principalFor(ALICE), bracketReq(extra as Record<string, unknown>))).rejects.toMatchObject({
      code: 'trade.order_type_unsupported',
    });
    expect(matching.submitted).toHaveLength(0);
    expect(await avail(ALICE, 'USDT')).toBe('1000');
  });

  it.each([
    ['a stop trigger', { stopPx: '90' }],
    ['an iceberg', { iceberg: true, displayQty: '0.1' }],
    ['reduce-only', { reduceOnly: true }],
    ['a post-only flag', { postOnly: true }],
    ['an expiry', { expireAt: '2099-01-01T00:00:00Z' }],
  ])('refuses %s that only the request body carries: the inner installers would re-read it', async (_name, carried) => {
    await fund(ALICE, 'USDT', '1000');
    const input = carryPlacementBody(bracketReq() as never, { ...bracketReq(), ...carried }) as never;
    await expect(trade.placeOrder(principalFor(ALICE), input)).rejects.toMatchObject({
      code: 'trade.order_type_unsupported',
    });
    expect(matching.submitted).toHaveLength(0);
    expect(await avail(ALICE, 'USDT')).toBe('1000');
  });

  it("accepts the engine's own self-trade mode said out loud, on the input or in the body, as the desk sends it", async () => {
    const { bob } = await setup();
    matching.scriptFills([{ makerOrderId: bob.id, makerAccountId: BOB, price: '100', qty: '1' }]);
    const input = carryPlacementBody(bracketReq({ stpMode: 'cancel_maker' }) as never, {
      ...bracketReq(),
      stpMode: 'cancel_maker',
    }) as never;
    const entry = await trade.placeOrder(principalFor(ALICE), input);
    expect(entry.status).toBe('filled');
    expect(exitSubmits()).toHaveLength(1);
  });

  it('refuses any other self-trade mode on a bracket entry', async () => {
    await fund(ALICE, 'USDT', '1000');
    const input = carryPlacementBody(bracketReq() as never, { ...bracketReq(), stpMode: 'cancel_both' }) as never;
    await expect(trade.placeOrder(principalFor(ALICE), input)).rejects.toMatchObject({ code: 'trade.order_type_unsupported' });
    expect(matching.submitted).toHaveLength(0);
  });

  it('a carried tif alias cannot turn the entry into a resting post-only order', async () => {
    await fund(ALICE, 'USDT', '1000');
    const input = carryPlacementBody(bracketReq() as never, { ...bracketReq(), timeInForce: 'IOC', tif: 'PO' }) as never;
    await trade.placeOrder(principalFor(ALICE), input);
    expect(matching.submitted[0]?.request).toMatchObject({ tif: 'IOC' });
  });

  it('refuses a sell-side entry', async () => {
    await fund(ALICE, 'BTC', '1');
    await expect(trade.placeOrder(principalFor(ALICE), bracketReq({ side: 'sell' }))).rejects.toMatchObject({
      code: 'trade.order_type_unsupported',
    });
    expect(matching.submitted).toHaveLength(0);
  });

  it('a failed exit leaves the filled entry intact, a retry never opens a second exit, and an exit not on the book is never recorded', async () => {
    const { bob } = await setup();
    matching.scriptFills([{ makerOrderId: bob.id, makerAccountId: BOB, price: '100', qty: '1' }]);
    const realSubmit = matching.submit.bind(matching);
    let failExit = true;
    matching.submit = async (marketId, request) => {
      if ((request as { oco?: boolean }).oco === true && failExit) {
        failExit = false;
        throw new Error('svc-matching is unreachable');
      }
      return realSubmit(marketId, request);
    };
    await expect(trade.placeOrder(principalFor(ALICE), bracketReq())).rejects.toBeDefined();
    // The failed submit leaves the exit in the existing recovery state: the retry finds it by its key, opens no second
    // one, and says the exit is still not placed, since an order whose submit is unknown is not on the book.
    await expect(trade.placeOrder(principalFor(ALICE), bracketReq())).rejects.toMatchObject({ code: 'trade.bracket_exit_failed' });
    const sells = await sql<
      Array<{ id: string; status: string }>
    >`SELECT id, status FROM trade.orders WHERE user_id = ${ALICE} AND side = 'sell'`;
    expect(sells).toHaveLength(1);
    expect(sells[0]!.status).toBe('recovery_required');
    expect(await heldFor(ALICE, 'BTC', sells[0]!.id)).not.toBe('0');
    const intent = await sql<Array<{ exit_order_id: string | null }>>`SELECT exit_order_id FROM trade.order_bracket_intent`;
    expect(intent[0]?.exit_order_id).toBeNull();
    // Once the exit is proven live, the same retry records it.
    await sql`UPDATE trade.orders SET status = 'open' WHERE id = ${sells[0]!.id}`;
    const retried = await trade.placeOrder(principalFor(ALICE), bracketReq());
    expect(retried.status).toBe('filled');
    expect(
      (await sql<Array<{ exit_order_id: string | null }>>`SELECT exit_order_id FROM trade.order_bracket_intent`)[0]?.exit_order_id,
    ).toBe(sells[0]!.id);
    const buys = await sql<Array<{ id: string }>>`SELECT id FROM trade.orders WHERE user_id = ${ALICE} AND side = 'buy'`;
    expect(buys).toHaveLength(1);
  });

  it('the same client order id with different exit prices is refused', async () => {
    const { bob } = await setup();
    matching.scriptFills([{ makerOrderId: bob.id, makerAccountId: BOB, price: '100', qty: '1' }]);
    await trade.placeOrder(principalFor(ALICE), bracketReq());
    await expect(trade.placeOrder(principalFor(ALICE), bracketReq({ takeProfit: { stopPrice: '120' } }))).rejects.toBeDefined();
    expect(exitSubmits()).toHaveLength(1);
  });

  // ── OTO: one attached close (J-cex-spot-08 #10) ──────────────────────────────────────────────────────────────────
  const otoReq = (extra: Record<string, unknown> = {}) =>
    ({
      marketId: btcusdt.id,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('100'),
      tif: 'GTC',
      clientOrderId: 'oto-1',
      oto: true,
      close: { price: '110' },
      ...extra,
    }) as Parameters<TradeService['placeOrder']>[1];
  /** The engine never sees client ids: an OTO close is Alice's sell limit that is not an OCO pair. */
  const closeSubmits = () =>
    matching.submitted.filter(
      (s) =>
        s.request.accountId === ALICE &&
        s.request.side === 'sell' &&
        s.request.type === 'limit' &&
        (s.request as { oco?: boolean }).oco !== true,
    );
  const intentOf = async (entryId: string) =>
    (
      await sql<Array<{ kind: string; take_profit: string; stop_loss: string | null; exit_order_id: string | null }>>`
        SELECT kind, take_profit::text, stop_loss::text, exit_order_id FROM trade.order_bracket_intent WHERE order_id = ${entryId}
      `
    )[0];

  it('an OTO entry rests with its close stored, and the fill that ends it places the close at once, sized to what was received', async () => {
    await fund(ALICE, 'USDT', '1000');
    const entry = await trade.placeOrder(principalFor(ALICE), otoReq());
    expect(entry.status).toBe('open');
    expect(await intentOf(entry.id)).toMatchObject({ kind: 'oto', stop_loss: null, exit_order_id: null });
    expect(closeSubmits()).toHaveLength(0);
    expect(await readOrderLinks(sql, [entry.id])).toEqual(new Map([[entry.id, { role: 'entry', closePrice: '110', closeOrderId: null }]]));

    await bobSellsInto(entry.id, '1', 'bob-into-oto');
    expect((await trade.findOrder(entry.id))?.status).toBe('filled');
    const closes = closeSubmits();
    expect(closes).toHaveLength(1);
    const req = closes[0]!.request as { side: string; type?: string; price?: string; qty: string; oco?: boolean };
    expect(req).toMatchObject({ side: 'sell', price: '110' });
    expect(req.oco).not.toBe(true);
    expect(Number(req.qty)).toBeGreaterThan(0.99);
    expect(Number(req.qty)).toBeLessThanOrEqual(1);
    const close = await intentOf(entry.id);
    expect(close?.exit_order_id).not.toBeNull();
    expect(await heldFor(ALICE, 'BTC', close!.exit_order_id!)).toBe(req.qty);
    const links = await readOrderLinks(sql, [entry.id, close!.exit_order_id!]);
    expect(links.get(entry.id)).toEqual({ role: 'entry', closePrice: '110', closeOrderId: close!.exit_order_id });
    expect(links.get(close!.exit_order_id!)).toEqual({ role: 'close', entryOrderId: entry.id });
    // Nothing left for the sweep.
    expect(await sweepable(trade).sweepBracketExits(1_000)).toMatchObject({ placed: 0 });
    expect(closeSubmits()).toHaveLength(1);
  });

  it('cancelling an OTO entry before it fills cancels its close: none is ever placed and the quote comes back', async () => {
    await fund(ALICE, 'USDT', '1000');
    const entry = await trade.placeOrder(principalFor(ALICE), otoReq());
    await trade.cancelOrder(principalFor(ALICE), entry.id);
    expect((await trade.findOrder(entry.id))?.status).toBe('cancelled');
    expect(await sweepable(trade).sweepBracketExits(1_000)).toMatchObject({ placed: 0, failed: 0 });
    expect(closeSubmits()).toHaveLength(0);
    expect(await avail(ALICE, 'USDT')).toBe('1000');
    expect(await sweepable(trade).sweepBracketExits(1_000)).toMatchObject({ examined: 0 });
  });

  it('an OTO entry that fills inside the request places its close in the same request', async () => {
    const { bob } = await setup();
    matching.scriptFills([{ makerOrderId: bob.id, makerAccountId: BOB, price: '100', qty: '1' }]);
    const entry = await trade.placeOrder(principalFor(ALICE), otoReq({ tif: 'IOC' }));
    expect(entry.status).toBe('filled');
    expect(closeSubmits()).toHaveLength(1);
    expect((await intentOf(entry.id))?.exit_order_id).not.toBeNull();
  });

  it.each([
    ['no close price', { close: undefined }, 'trade.missing_price'],
    ['a close at the entry price', { close: { price: '100' } }, 'trade.invalid_price'],
    ['a close under the entry price', { close: { price: '99' } }, 'trade.invalid_price'],
    ['a sell entry', { side: 'sell' }, 'trade.order_type_unsupported'],
    ['a post-only entry', { postOnly: true }, 'trade.order_type_unsupported'],
    [
      'a market entry (no price to judge the close against)',
      { type: 'market', price: undefined, close: { price: '1' } },
      'trade.order_type_unsupported',
    ],
    ['a close off the price grid', { close: { price: '110.005' } }, 'trade.invalid_price'],
  ])('refuses an OTO with %s before any hold', async (_name, extra, code) => {
    await fund(ALICE, 'USDT', '1000');
    await fund(ALICE, 'BTC', '1');
    await expect(trade.placeOrder(principalFor(ALICE), otoReq(extra as Record<string, unknown>))).rejects.toMatchObject({ code });
    expect(matching.submitted).toHaveLength(0);
    expect(await avail(ALICE, 'USDT')).toBe('1000');
  });

  it('an OTO entry waiting for its fill is never replaced (the close would stay with the cancelled entry)', async () => {
    await fund(ALICE, 'USDT', '1000');
    const entry = await trade.placeOrder(principalFor(ALICE), otoReq());
    await expect(
      trade.replaceOrder(principalFor(ALICE), entry.id, {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('101'),
        tif: 'GTC',
        clientOrderId: 'oto-1-r',
      } as Parameters<TradeService['replaceOrder']>[2]),
    ).rejects.toMatchObject({ code: 'trade.order_type_unsupported' });
    expect((await trade.findOrder(entry.id))?.status).toBe('open');
    expect(await intentOf(entry.id)).toMatchObject({ kind: 'oto', exit_order_id: null });
  });

  it('the same client order id cannot be an OTO and then a bracket', async () => {
    await fund(ALICE, 'USDT', '1000');
    await trade.placeOrder(principalFor(ALICE), otoReq({ clientOrderId: 'same-key' }));
    await expect(trade.placeOrder(principalFor(ALICE), bracketReq({ tif: 'GTC', clientOrderId: 'same-key' }))).rejects.toMatchObject({
      code: 'trade.client_order_id_conflict',
    });
  });
});
