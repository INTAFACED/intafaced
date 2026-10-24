import { PositionService, TradeService, readyTestAdmission } from '../controls/test-admission.js';
import { toCcxtError } from '../ccxt-errors.js';
import { PositionService as ProductionPositionService } from './position-service.js';
import { TradeService as ProductionTradeService } from '../spot/trade-service.js';
/**
 * Owner pre-trade limits (#4725) — PG-hard money proof.
 *
 * TRADE_MAX_ORDER / TRADE_MAX_POSITION / TRADE_MAX_LOSS are compared at the
 * admission seam of every order door: spot placeOrder (limit, market buy,
 * market sell, copy mirror), convert accept, and futures open. Boundary values
 * (limit-1 tick, limit, limit+1 tick) at each door; the exact 1e-18 boundary is
 * in `pretrade-limits.test.ts`. Closes are never refused.
 *
 * Owner integers below are TEST FIXTURES only — never product law.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_MAX_LEVERAGE_AMOUNT } from './initial-margin.test-harness.js';
import { memoryMarkBook } from './mark-source.js';
import { FuturesError, type OpenPositionInput } from './position-service.js';
import { formatAccountRef, profitSourceFromConfig, recipeProfitFundingAccount } from './profit-source.js';
import { LIMIT_MAX_LOSS, LIMIT_MAX_ORDER, LIMIT_MAX_POSITION, MAX_ORDER_UNSET } from './pretrade-limits.js';
import { installPreTradeCredit } from './pretrade-credit.js';
import { installNativeQtyUpAmend } from '../spot/qty-up-amend.js';
import type { Market } from '../spot/types.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from '../spot/testing.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const IMAGE = 'postgres:16-alpine';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer(IMAGE)
      .withDatabase('intafaced_limits_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    throw new Error(
      `svc-trade pretrade-limits is PG-hard (no skip-green). TEST_DATABASE_URL unset and Testcontainers could not start ${IMAGE}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-03T00:00:00.000Z');
const BTC_PERP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ETH_PERP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROFIT_SOURCE = formatAccountRef(recipeProfitFundingAccount('USDT'));
const KEYS = ['TRADE_MAX_ORDER', 'TRADE_MAX_POSITION', 'TRADE_MAX_LOSS'] as const;
const BIG = '1000000000';

function setLimits(dims: { order?: string; position?: string; loss?: string }): void {
  for (const key of KEYS) delete process.env[key];
  if (dims.order !== undefined) process.env.TRADE_MAX_ORDER = dims.order;
  if (dims.position !== undefined) process.env.TRADE_MAX_POSITION = dims.position;
  if (dims.loss !== undefined) process.env.TRADE_MAX_LOSS = dims.loss;
}

/** Only the order limit under test is tight; the other two are far out of the way. */
const onlyOrder = (n: string) => setLimits({ order: n, position: BIG, loss: BIG });
const onlyPosition = (n: string) => setLimits({ order: BIG, position: n, loss: BIG });
const onlyLoss = (n: string) => setLimits({ order: BIG, position: BIG, loss: n });

installPreTradeCredit();
installNativeQtyUpAmend(TradeService);

describe('owner pre-trade limits (#4725, PG-hard)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    for (const key of KEYS) delete process.env[key];
    await db?.drop();
    await adminStop();
  }, 30_000);

  let ledger: MemoryLedger;
  let bus: MemoryEventBus;
  let matching: StubMatching;
  let trade: TradeService;
  let positions: PositionService;
  let marks: ReturnType<typeof memoryMarkBook>;
  let spot: Market;

  const principal = principalFor(ALICE);
  const holdPosts = () => ledger.journal().filter((tx) => tx.reason === 'order.hold');
  const lockPosts = () => ledger.journal().filter((tx) => tx.reason === 'futures.margin.lock');
  const avail = async (asset = 'USDT') => formatAmount((await ledger.balance(userAvailable(ALICE, asset))).amount);

  function feed(marketId: string, price: string) {
    marks.set({ marketId, price, quality: 'mid', asOfMs: NOW.getTime() });
  }

  const limitBuy = (price: string, qty: string, id: string) =>
    trade.placeOrder(principal, {
      marketId: spot.id,
      side: 'buy',
      type: 'limit',
      qty: amt(qty),
      price: amt(price),
      clientOrderId: id,
    });

  async function insertFutures(id: string, symbol: string, base: string) {
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (${id}, ${symbol}, ${base}, 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', ${symbol}, now())
    `;
  }

  async function open(size: string, side: 'long' | 'short', clientOpenId: string, symbol = 'BTC/USDT-PERP', extra: object = {}) {
    return positions.open({
      clientOpenId,
      userId: ALICE,
      symbol,
      side,
      size: amt(size),
      leverage: amt('10'),
      ...extra,
    } as OpenPositionInput);
  }

  beforeEach(async () => {
    setLimits({});
    await sql`TRUNCATE trade.positions, trade.fills, trade.orders, trade.convert_quotes, trade.order_replace_requests, trade.markets RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    bus = new MemoryEventBus('svc-trade');
    matching = new StubMatching();
    marks = memoryMarkBook();
    trade = new TradeService(sql, ledger, matching, new StubPerks(), bus, {
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 150,
      convertEnabled: true,
      convertSpreadBps: 25,
      convertQuoteTtlMs: 60_000,
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
    });
    positions = new PositionService(sql, ledger, {
      marks: marks.source(),
      profitSource: profitSourceFromConfig(PROFIT_SOURCE),
      maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
      bus,
      now: () => NOW,
    });
    matching.asks = [['100', '5']];
    matching.bids = [['99', '5']];
    spot = await trade.listMarket({
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
    await insertFutures(BTC_PERP, 'BTC/USDT-PERP', 'BTC');
    await insertFutures(ETH_PERP, 'ETH/USDT-PERP', 'ETH');
    feed(BTC_PERP, '50000');
    feed(ETH_PERP, '3000');
    await ledger.post(
      recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('1000000'), rail: 'test', railRef: `l-${Math.random()}` }),
    );
    await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'BTC', amount: amt('10'), rail: 'test', railRef: `lb-${Math.random()}` }));
  });

  describe('TRADE_MAX_ORDER on spot placeOrder', () => {
    it('boot wrappers: a spot limit above TRADE_MAX_ORDER is trade.limit_max_order (422) with no hold, and the exact cap is allowed', async () => {
      const place = ProductionTradeService.prototype.placeOrder;
      const open = ProductionPositionService.prototype.open;
      await import('../ledger-client.js');
      try {
        onlyOrder('3');
        const holdsBefore = holdPosts().length;
        let caught: unknown;
        try {
          await limitBuy('2', '2', 'boot-over');
        } catch (err) {
          caught = err;
        }
        expect(caught).toMatchObject({ name: 'TradeError', code: LIMIT_MAX_ORDER });
        expect(toCcxtError(caught)?.status).toBe(422);
        expect(holdPosts()).toHaveLength(holdsBefore);
        const exact = await limitBuy('1', '3', 'boot-exact');
        expect(exact.clientOrderId).toBe('boot-exact');
        expect(holdPosts().length).toBeGreaterThan(holdsBefore);
      } finally {
        ProductionTradeService.prototype.placeOrder = place;
        ProductionPositionService.prototype.open = open;
      }
    });

    it('limit order: limit-1 tick and exactly the limit pass, limit+1 tick refuses before any hold', async () => {
      onlyOrder('200'); // qty 2, tick 0.01 => notional moves in 0.02 steps
      await limitBuy('99.99', '2', 'o-under'); // 199.98
      await limitBuy('100', '2', 'o-exact'); // 200
      const holdsBefore = holdPosts().length;
      const balanceBefore = await avail();
      await expect(limitBuy('100.01', '2', 'o-over')).rejects.toMatchObject({ name: 'TradeError', code: LIMIT_MAX_ORDER });
      await expect(limitBuy('100.01', '2', 'o-over-2')).rejects.toThrow(/200\.02 USDT exceeds the max-order limit of 200 USDT/);
      expect(holdPosts()).toHaveLength(holdsBefore);
      expect(await avail()).toBe(balanceBefore);
      expect(await sql`SELECT id FROM trade.orders WHERE client_order_id IN ('o-over','o-over-2')`).toHaveLength(0);
      expect(matching.submitted).toHaveLength(2);
    });

    it('a retry of an order that already exists is not newly refused', async () => {
      onlyOrder('200');
      const first = await limitBuy('100', '2', 'o-retry');
      onlyOrder('1');
      const again = await limitBuy('100', '2', 'o-retry');
      expect(again.id).toBe(first.id);
    });

    it('market buy is valued at its protection price (the most it can pay)', async () => {
      // best ask 100, 150 bps cap => protection 101.5; qty 2 => 203
      onlyOrder('203');
      const input = { marketId: spot.id, side: 'buy' as const, type: 'market' as const, qty: amt('2') };
      await trade.placeOrder(principal, { ...input, clientOrderId: 'mb-exact' });
      onlyOrder('202');
      await expect(trade.placeOrder(principal, { ...input, clientOrderId: 'mb-over' })).rejects.toMatchObject({ code: LIMIT_MAX_ORDER });
    });

    it('market sell is valued at the best bid; with no bid it refuses', async () => {
      // bid 99 × qty 2 = 198. A sell IOC can fill at the bid, so 198 admits
      // and 197 refuses. The slippage floor is not the limit reference.
      onlyOrder('198');
      const input = { marketId: spot.id, side: 'sell' as const, type: 'market' as const, qty: amt('2') };
      await trade.placeOrder(principal, { ...input, clientOrderId: 'ms-exact' });
      onlyOrder('197');
      await expect(trade.placeOrder(principal, { ...input, clientOrderId: 'ms-over' })).rejects.toMatchObject({ code: LIMIT_MAX_ORDER });
      matching.bids = [];
      onlyOrder(BIG);
      await expect(trade.placeOrder(principal, { ...input, clientOrderId: 'ms-nobid' })).rejects.toMatchObject({
        code: 'trade.no_reference_price',
      });
    });

    it('copy mirror is the same door: refused at the limit before any authority is consulted', async () => {
      onlyOrder('199');
      await expect(
        trade.placeCopyMirror(
          principal,
          { marketId: spot.id, side: 'buy', type: 'limit', qty: amt('2'), price: amt('100'), clientOrderId: 'cm-over' },
          'follow-1',
        ),
      ).rejects.toMatchObject({ code: LIMIT_MAX_ORDER });
      expect(holdPosts()).toHaveLength(0);
    });

    it('fail closed: an unset limit still refuses on every door once the mill is installed (copy mirror skips the wrapper)', async () => {
      setLimits({});
      await expect(
        trade.placeCopyMirror(
          principal,
          { marketId: spot.id, side: 'buy', type: 'limit', qty: amt('1'), price: amt('100'), clientOrderId: 'cm-unset' },
          'follow-1',
        ),
      ).rejects.toMatchObject({ code: MAX_ORDER_UNSET });
    });

    it('cancel is never blocked, even with a published limit of 0', async () => {
      onlyOrder('200');
      const order = await limitBuy('100', '2', 'o-cancel');
      onlyOrder('0');
      const cancelled = await trade.cancelOrder(principal, order.id);
      expect(cancelled.status).toBe('cancelled');
      await expect(limitBuy('100', '2', 'o-after-zero')).rejects.toMatchObject({ code: LIMIT_MAX_ORDER });
    });

    it('algo children and replacements reach the same door (source pin)', () => {
      const src = readFileSync(join(here, '..', 'spot', 'trade-service.ts'), 'utf8');
      expect(src).toMatch(/placeChild:[\s\S]{0,1800}this\.placeOrderInner\(/);
      expect(src).toMatch(/const replacement = await this\.placeOrder\(/);
      expect(src).toMatch(/assertOwnerOrderLimit\(market, input\.qty, fundingPrice/);
      expect(src).toMatch(/reduceOnly\?: boolean \}\)\.reduceOnly !== true/);
    });
  });

  describe('reduce-only, replace and native qty-up', () => {
    it('a reduce-only order above TRADE_MAX_ORDER is never refused', async () => {
      onlyOrder('100');
      const input = {
        marketId: spot.id,
        side: 'sell' as const,
        type: 'limit' as const,
        qty: amt('2'),
        price: amt('100'),
      };
      // The flag rides on the input the way reduce-only-place.ts binds it.
      const placed = await trade.placeOrder(principal, { ...input, reduceOnly: true, clientOrderId: 'ro-big' } as typeof input & {
        clientOrderId: string;
      });
      expect(placed.status).not.toBe('rejected');
      // The same order without the flag is refused.
      await expect(trade.placeOrder(principal, { ...input, clientOrderId: 'ro-plain' })).rejects.toMatchObject({
        code: LIMIT_MAX_ORDER,
      });
    });

    it('a refused replacement leaves the original order open (checked before the cancel)', async () => {
      onlyOrder('200');
      const original = await limitBuy('100', '2', 'rp-orig');
      const holdsBefore = holdPosts().length;
      const outcome = await trade.replaceOrder(principal, original.id, {
        marketId: spot.id,
        side: 'buy',
        type: 'limit',
        qty: amt('2'),
        price: amt('100.01'),
        clientOrderId: 'rp-new',
      });
      expect(outcome).toMatchObject({ accepted: false, code: 'LIMIT_REFUSED', reasonCode: LIMIT_MAX_ORDER, replacement: null });
      expect(outcome.original.status).toBe('open');
      expect((await trade.findOrder(original.id))?.status).toBe('open');
      expect(holdPosts()).toHaveLength(holdsBefore);
      expect(matching.cancelledOrders).toHaveLength(0);
      // A replacement inside the limit still goes through.
      const ok = await trade.replaceOrder(principal, original.id, {
        marketId: spot.id,
        side: 'buy',
        type: 'limit',
        qty: amt('2'),
        price: amt('100'),
        clientOrderId: 'rp-ok',
      });
      expect(ok.code).toBe('REPLACED');
    });

    it('native amend refuses a larger quantity with trade.amend_qty_up before any new hold', async () => {
      onlyOrder('300');
      const original = await limitBuy('100', '2', 'qu-orig');
      onlyOrder('1');
      const refused = await trade.amendOrder(principal, original.id, { qty: amt('3') });
      expect(refused).toMatchObject({ accepted: false, code: 'NOT_AMENDABLE', reasonCode: 'trade.amend_qty_up' });
      expect(matching.amended).toHaveLength(0);
      expect(refused.order.qty).toBe(amt('2'));
    });
  });

  describe('TRADE_MAX_ORDER on convert accept', () => {
    it('a fresh accept over the limit refuses and posts nothing; under the limit it settles', async () => {
      await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('10'), seedId: `lim-btc-${Math.random()}` }));
      const convertPrincipal = principalFor(ALICE, ['trade:read', 'trade:write']);
      const quoted = await trade.convertQuote(convertPrincipal, { symbol: spot.symbol, side: 'buy', qty: amt('1') });
      onlyOrder('50');
      const before = ledger.journal().length;
      await expect(trade.convertExecute(convertPrincipal, { quoteId: quoted.quoteId })).rejects.toMatchObject({ code: LIMIT_MAX_ORDER });
      expect(ledger.journal()).toHaveLength(before);
      onlyOrder(BIG);
      const settled = await trade.convertExecute(convertPrincipal, { quoteId: quoted.quoteId });
      expect(settled.fillNotional).toBe(quoted.userNotional);
    });
  });

  describe('TRADE_MAX_ORDER on futures open', () => {
    it('size boundary at 50,000 notional: 0.9999 and 1 pass, 1.0001 refuses (HTTP 422) with zero lock posts', async () => {
      onlyOrder('50000');
      await open('0.9999', 'long', 'fo-under');
      await sql`DELETE FROM trade.positions`;
      await open('1', 'long', 'fo-exact');
      const locks = lockPosts().length;
      await sql`DELETE FROM trade.positions`;
      await expect(open('1.0001', 'long', 'fo-over')).rejects.toMatchObject({
        name: 'FuturesError',
        code: LIMIT_MAX_ORDER,
        status: 422,
      });
      expect(lockPosts()).toHaveLength(locks);
      await expect(open('1.0001', 'long', 'fo-over-2')).rejects.toThrow(/50005 USDT exceeds the max-order limit of 50000 USDT/);
    });
  });

  describe('open-interest limits on the at-mark open (D-margin-05)', () => {
    it('the share refuses with the room left and nothing locked; a blank limit refuses every open', async () => {
      setLimits({ order: BIG, position: BIG, loss: BIG });
      // TEST fixture values: 10 BTC of open interest, 10% (1 BTC) per account.
      let oi: { limit: bigint; shareBps: number } | null = { limit: amt('10'), shareBps: 1_000 };
      positions = new PositionService(sql, ledger, {
        marks: marks.source(),
        profitSource: profitSourceFromConfig(PROFIT_SOURCE),
        maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
        bus,
        now: () => NOW,
        matchedOrders: {
          matching: null,
          enabled: false,
          priceBand: null,
          lifecycleProof: null,
          openInterestLimits: async () => oi as never,
        },
      });
      await open('0.6', 'long', 'oi-first');
      const locks = lockPosts().length;
      await expect(open('0.5', 'long', 'oi-over')).rejects.toMatchObject({
        name: 'FuturesError',
        code: 'trade.oi_share_limit',
        status: 422,
      });
      await expect(open('0.5', 'long', 'oi-over-2')).rejects.toThrow(/room left 0\.4 BTC$/);
      expect(lockPosts()).toHaveLength(locks);
      oi = null;
      await expect(open('0.1', 'short', 'oi-unset', 'ETH/USDT-PERP')).rejects.toMatchObject({ code: 'trade.oi_limit_unset', status: 503 });
      expect(lockPosts()).toHaveLength(locks);
    });
  });

  describe('TRADE_MAX_POSITION on futures open', () => {
    it('resulting position boundary: exactly the limit passes, one tick over refuses', async () => {
      onlyPosition('50000');
      await open('1', 'long', 'fp-exact');
      await sql`DELETE FROM trade.positions`;
      await expect(open('1.0001', 'long', 'fp-over')).rejects.toMatchObject({ code: LIMIT_MAX_POSITION, status: 422 });
    });

    it('one_way: a crossing open is counted on the resulting net; a reducing open is never refused', async () => {
      onlyPosition('100000'); // 2 BTC at 50,000
      await open('2', 'long', 'fx-long');
      // Short 4 => net -2 (|net| 2 == 2): not growth, allowed even though it is a 4 BTC order.
      await open('4', 'short', 'fx-short-cross');
      await sql`DELETE FROM trade.positions`;
      await open('2', 'long', 'fx-long-2');
      // Short 5 => net -3 > 2 and over the cap: refused.
      await expect(open('5', 'short', 'fx-short-over')).rejects.toMatchObject({ code: LIMIT_MAX_POSITION });
    });

    it('a position already over a LOWERED limit can be reduced (a same-side row can never grow: one open row per side)', async () => {
      onlyPosition(BIG);
      await open('3', 'long', 'fl-big');
      onlyPosition('50000'); // owner lowered it: 3 BTC is now over
      await open('1', 'short', 'fl-reduce'); // net 3 -> 2: reduces
      await expect(open('1', 'short', 'fl-same-side-again')).rejects.toBeInstanceOf(Error); // unique side row, never a growth
    });

    it('hedge: each side is its own position', async () => {
      onlyPosition('100000');
      await open('2', 'long', 'fh-long', 'BTC/USDT-PERP', { positionMode: 'hedge', positionSide: 'long' });
      await open('2', 'short', 'fh-short', 'BTC/USDT-PERP', { positionMode: 'hedge', positionSide: 'short' });
      await sql`DELETE FROM trade.positions`;
      await open('2', 'long', 'fh-long-2', 'BTC/USDT-PERP', { positionMode: 'hedge', positionSide: 'long' });
      await expect(
        open('2.0001', 'short', 'fh-short-over', 'BTC/USDT-PERP', { positionMode: 'hedge', positionSide: 'short' }),
      ).rejects.toMatchObject({ code: LIMIT_MAX_POSITION });
    });

    it('two concurrent opens cannot stack one side past the limit: one row, one margin lock', async () => {
      onlyPosition('150000'); // 3 BTC
      const results = await Promise.allSettled([open('3', 'long', 'fc-a'), open('3', 'long', 'fc-b')]);
      const rows = await sql`SELECT id, size FROM trade.positions WHERE status IN ('open', 'closing')`;
      expect(rows).toHaveLength(1);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      // 3 BTC x 50,000 / 10x leverage = 15,000 locked once; the loser's margin came back.
      expect(await avail()).toBe(formatAmount(amt('1000000') - amt('15000')));
    });
  });

  describe('TRADE_MAX_LOSS on futures open (current unrealised loss, losing rows only)', () => {
    it('same-market loss: exactly the limit passes, one cent worse refuses', async () => {
      onlyLoss('100');
      await open('1', 'long', 'fl-1');
      feed(BTC_PERP, '49900'); // loss 100.00 == limit
      await open('0.0001', 'short', 'fl-2');
      await sql`DELETE FROM trade.positions WHERE side = 'short'`;
      feed(BTC_PERP, '49899.99'); // loss 100.01
      await expect(open('0.0001', 'short', 'fl-3')).rejects.toMatchObject({ code: LIMIT_MAX_LOSS, status: 422 });
    });

    it("another market's loss is valued at that market's own mark", async () => {
      onlyLoss('100');
      await open('10', 'long', 'fe-1', 'ETH/USDT-PERP'); // 10 ETH at 3,000
      feed(ETH_PERP, '2990'); // loss 100 == limit
      await open('0.0001', 'long', 'fe-2');
      await sql`DELETE FROM trade.positions WHERE market_id = ${BTC_PERP}`;
      feed(ETH_PERP, '2989.99'); // loss 100.1
      await expect(open('0.0001', 'long', 'fe-3')).rejects.toMatchObject({ code: LIMIT_MAX_LOSS });
    });

    it('a position in profit has no loss, so even a published 0 does not refuse', async () => {
      onlyLoss('0');
      await open('1', 'long', 'fw-1'); // opened at 50,000
      feed(BTC_PERP, '51000'); // in profit
      await open('0.0001', 'short', 'fw-2'); // loss 0 <= 0
    });

    it('close is never refused: exempt even with every limit at 0 and a loss on the book', async () => {
      onlyLoss('1000000');
      const pos = await open('1', 'long', 'fz-1');
      feed(BTC_PERP, '46000'); // loss 4,000 (inside the 5,000 margin)
      setLimits({ order: '0', position: '0', loss: '0' });
      const closed = await positions.close(ALICE, pos.id!);
      expect(closed.status).toBe('closed');
      await expect(open('1', 'long', 'fz-2')).rejects.toBeInstanceOf(FuturesError);
    });
  });
});
