import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TradeService } from '../spot/trade-service.js';
import type { Market } from '../spot/types.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from '../spot/testing.js';
import { acceptConvertQuote, buildFirmConvertQuote, estimateConvert } from './quote.js';
import { planConvertSettle } from './settle.js';
import { convertSettleIdsFor } from './ids.js';
import { SqlConvertQuoteStore } from './quote-store.js';

/**
 * CARD B7 money proof — convert settle binds quoted in/out.
 *
 * Dedicated file so the Postgres gate is `postgresAvailable` (CI-red without DB).
 * convertExecute hitch (bound-then-expire still posts) is closed IN settle.ts:
 * planConvertSettle refuses when now > quote.expiresAt (default now = new Date()).
 * Does not recut trade-service.ts or router.ts. Never invents convert spread 10.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
/** Owner-published convert spread fixture — not listing 10, never invented. */
const OWNER_CONVERT_SPREAD_BPS = 25;
const SCOPES = ['trade:read', 'trade:write'] as const;

describe('convert settle B7 hitch (source)', () => {
  it('trade-service.ts contains convertExecute + planConvertSettle + postConvertSettle', () => {
    const src = readFileSync(join(here, '..', 'spot', 'trade-service.ts'), 'utf8');
    expect(src).toMatch(/async convertExecute\(/);
    expect(src).toMatch(/planConvertSettle\(\{ bound, \.\.\.ids \}\)/);
    expect(src).toMatch(/await postConvertSettle\(this\.ledger, plan\)/);
    expect(src).toMatch(/requireConvertSpreadBps\(this\.convertSpreadBps\)/);
    expect(src).not.toMatch(/convertSpreadBps:\s*10\b/);
    expect(src).not.toMatch(/convertSpreadBps \?\? 10/);
  });

  it('router.ts has no convert/settle recut', () => {
    const routerSrc = readFileSync(join(here, '..', 'router.ts'), 'utf8');
    expect(routerSrc).not.toMatch(/convert\/settle/);
    expect(routerSrc).not.toMatch(/planConvertSettle/);
    expect(routerSrc).not.toMatch(/postConvertSettle/);
  });

  it('never lists/invents 10 as convert spread in convert/', () => {
    const quoteSrc = readFileSync(join(here, 'quote.ts'), 'utf8');
    const settleSrc = readFileSync(join(here, 'settle.ts'), 'utf8');
    expect(quoteSrc).toMatch(/requireConvertSpreadBps/);
    expect(quoteSrc).toMatch(/never invent 10/);
    expect(settleSrc).not.toMatch(/convertSpreadBps:\s*10\b/);
    expect(settleSrc).not.toMatch(/\?\? 10/);
    expect(settleSrc).toMatch(/makerFeeBps: 0/);
    expect(settleSrc).toMatch(/takerFeeBps: 0/);
  });

  it('planConvertSettle with now past expiresAt refuses even if bound', () => {
    const now = new Date('2026-09-02T10:00:00.000Z');
    const estimate = estimateConvert({
      side: 'buy',
      qty: amt('1'),
      levels: [['100', '5']],
      convertSpreadBps: OWNER_CONVERT_SPREAD_BPS,
      tickSize: amt('0.01'),
    });
    const quote = buildFirmConvertQuote({
      quoteId: 'q-b7-bound-expire',
      userId: ALICE,
      symbol: 'BTC/USDT',
      marketId: 'm-b7',
      side: 'buy',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      requestedQty: amt('1'),
      estimate,
      convertSpreadBps: OWNER_CONVERT_SPREAD_BPS,
      source: { kind: 'book', symbol: 'BTC/USDT', asOf: now.toISOString() },
      now,
      quoteTtlMs: 15_000,
    });
    const bound = acceptConvertQuote({ quote, now: new Date(now.getTime() + 1_000) });
    expect(bound.fillNotional).toBe(quote.userNotional);
    expect(bound.fillPrice).toBe(quote.avgPrice);
    const ids = convertSettleIdsFor(quote.quoteId);
    try {
      planConvertSettle({ bound, ...ids, now: new Date(now.getTime() + 16_000) });
      throw new Error('should have refused expired bound quote');
    } catch (err) {
      expect((err as { code: string }).code).toBe('trade.convert_quote_expired');
    }
  });
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('svc-trade convert settle B7 money (Postgres unavailable — start docker compose)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'trade', url: URL, migrations });
  const sql = db.sql;

  describe('svc-trade convert settle B7 money', () => {
    let ledger: MemoryLedger;
    let bus: MemoryEventBus;
    let matching: StubMatching;
    let perks: StubPerks;
    let trade: TradeService;
    let btcusdt: Market;
    let nowFn: () => Date;

    const principal = principalFor(ALICE, [...SCOPES]);
    const avail = async (assetId: string) => formatAmount((await ledger.balance(userAvailable(ALICE, assetId))).amount);
    const fillPosts = () => ledger.journal().filter((tx) => tx.reason === 'trade.fill.mm_maker');

    async function fundUser(assetId: string, amount: string) {
      await ledger.post(
        recipes.deposit({
          userId: ALICE,
          assetId,
          amount: amt(amount),
          rail: 'test',
          railRef: `${ALICE}:${assetId}:${amount}:${Math.random()}`,
        }),
      );
    }

    beforeEach(async () => {
      await sql`TRUNCATE trade.convert_quotes, trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
      ledger = new MemoryLedger();
      bus = new MemoryEventBus('svc-trade');
      matching = new StubMatching();
      perks = new StubPerks();
      nowFn = () => new Date();
      trade = new TradeService(sql, ledger, matching, perks, bus, {
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        convertEnabled: true,
        convertSpreadBps: OWNER_CONVERT_SPREAD_BPS,
        convertQuoteTtlMs: 60_000,
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        now: () => nowFn(),
      });
      matching.asks = [['100', '5']];
      matching.bids = [['99', '5']];
      btcusdt = await trade.listMarket({
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
      await fundUser('USDT', '1000');
      await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('10'), seedId: `cvt-btc-${Math.random()}` }));
    });

    afterAll(async () => {
      await db.drop();
    }, 30_000);

    it('convertQuote then convertExecute binds exact in/out; one fill post; balances move', async () => {
      const quoted = await trade.convertQuote(principal, { symbol: btcusdt.symbol, side: 'buy', qty: amt('1') });
      expect(quoted.convertSpreadBps).toBe(OWNER_CONVERT_SPREAD_BPS);
      expect(quoted.convertSpreadBps).not.toBe(10);
      expect(quoted.inAsset).toBe('USDT');
      expect(quoted.outAsset).toBe('BTC');
      expect(quoted.inAmount).not.toBe('0');
      expect(quoted.outAmount).toBe('1');

      const settled = await trade.convertExecute(principal, { quoteId: quoted.quoteId });
      expect(settled.inAmount).toBe(quoted.inAmount);
      expect(settled.outAmount).toBe(quoted.outAmount);
      expect(settled.fillNotional).toBe(quoted.userNotional);
      expect(settled.fillPrice).toBe(quoted.avgPrice);
      expect(settled.convertSpreadBps).toBe(OWNER_CONVERT_SPREAD_BPS);
      expect(settled.convertSpreadBps).not.toBe(10);

      expect(fillPosts()).toHaveLength(1);
      expect(settled.fillId).toBe(convertSettleIdsFor(quoted.quoteId).fillId);
      expect(ledger.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(1);
      expect(ledger.journal().filter((tx) => tx.reason === 'order.hold.mm')).toHaveLength(1);
      expect(matching.submitted).toHaveLength(0);
      expect(await avail('USDT')).toBe(formatAmount(amt('1000') - amt(quoted.inAmount)));
      expect(await avail('BTC')).toBe(quoted.outAmount);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('second convertExecute same quoteId is idempotent — same fillId, no second fill post', async () => {
      const quoted = await trade.convertQuote(principal, { symbol: btcusdt.symbol, side: 'buy', qty: amt('1') });
      const first = await trade.convertExecute(principal, { quoteId: quoted.quoteId });
      const usdt = await avail('USDT');
      const btc = await avail('BTC');
      expect(fillPosts()).toHaveLength(1);

      const retry = await trade.convertExecute(principal, { quoteId: quoted.quoteId });
      expect(retry.fillId).toBe(first.fillId);
      expect(retry.inAmount).toBe(first.inAmount);
      expect(retry.outAmount).toBe(first.outAmount);
      expect(fillPosts()).toHaveLength(1);
      expect(await avail('USDT')).toBe(usdt);
      expect(await avail('BTC')).toBe(btc);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('expired OPEN quote convertExecute refuses trade.convert_quote_expired and posts nothing', async () => {
      const quoted = await trade.convertQuote(principal, { symbol: btcusdt.symbol, side: 'buy', qty: amt('1') });
      const usdt = await avail('USDT');
      const btc = await avail('BTC');
      nowFn = () => new Date(Date.parse(quoted.expiresAt) + 1);

      await expect(trade.convertExecute(principal, { quoteId: quoted.quoteId })).rejects.toMatchObject({
        code: 'trade.convert_quote_expired',
      });
      expect(fillPosts()).toHaveLength(0);
      expect(await avail('USDT')).toBe(usdt);
      expect(await avail('BTC')).toBe(btc);
    });

    it('bound-then-expire convertExecute hitch: planConvertSettle wall clock refuses, posts nothing', async () => {
      const created = new Date(Date.now() - 20_000);
      const estimate = estimateConvert({
        side: 'buy',
        qty: amt('1'),
        levels: [['100', '5']],
        convertSpreadBps: OWNER_CONVERT_SPREAD_BPS,
        tickSize: amt('0.01'),
      });
      const quote = buildFirmConvertQuote({
        quoteId: crypto.randomUUID(),
        userId: ALICE,
        symbol: btcusdt.symbol,
        marketId: btcusdt.id,
        side: 'buy',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        requestedQty: amt('1'),
        estimate,
        convertSpreadBps: OWNER_CONVERT_SPREAD_BPS,
        source: { kind: 'book', symbol: btcusdt.symbol, asOf: created.toISOString() },
        now: created,
        quoteTtlMs: 15_000,
      });
      const bound = acceptConvertQuote({ quote, now: new Date(created.getTime() + 1_000) });
      await new SqlConvertQuoteStore(sql).saveBound(quote, bound);
      const usdt = await avail('USDT');
      const btc = await avail('BTC');

      await expect(trade.convertExecute(principal, { quoteId: quote.quoteId })).rejects.toMatchObject({
        code: 'trade.convert_quote_expired',
      });
      expect(fillPosts()).toHaveLength(0);
      expect(await avail('USDT')).toBe(usdt);
      expect(await avail('BTC')).toBe(btc);
    });

    it('settled quote after expiry still returns the first settle — no second fill', async () => {
      const quoted = await trade.convertQuote(principal, { symbol: btcusdt.symbol, side: 'buy', qty: amt('1') });
      const first = await trade.convertExecute(principal, { quoteId: quoted.quoteId });
      expect(fillPosts()).toHaveLength(1);
      const usdt = await avail('USDT');
      const btc = await avail('BTC');

      nowFn = () => new Date(Date.parse(quoted.expiresAt) + 60_000);
      const retry = await trade.convertExecute(principal, { quoteId: quoted.quoteId });
      expect(retry.fillId).toBe(first.fillId);
      expect(retry.inAmount).toBe(first.inAmount);
      expect(retry.outAmount).toBe(first.outAmount);
      expect(fillPosts()).toHaveLength(1);
      expect(await avail('USDT')).toBe(usdt);
      expect(await avail('BTC')).toBe(btc);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });
}
