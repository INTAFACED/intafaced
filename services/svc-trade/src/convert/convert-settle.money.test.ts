import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Market } from '../spot/types.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from '../spot/testing.js';
import { DROP_COPY_SOURCE_RFQ, type DropCopyFillWire } from '../spot/drop-copy-ingest.js';
import { acceptConvertQuote, buildFirmConvertQuote, estimateConvert } from './quote.js';
import { planConvertSettle } from './settle.js';
import { convertSettleIdsFor } from './ids.js';
import { SqlConvertQuoteStore } from './quote-store.js';

/**
 * CARD B7 money proof — convert settle binds quoted in/out.
 *
 * H8a PG-hard: never describe.skip; CI uses TEST_DATABASE_URL; local starts Testcontainers postgres:16-alpine.
 * Fresh acceptance refuses after quote expiry. Already bound immutable effects
 * recover using their original acceptedAt, including legacy persisted bindings.
 * The standalone planner still checks its supplied/default time. No spread invent.
 */

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
      `H8a: svc-trade convert-settle is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const ALICE = '11111111-1111-4111-8111-111111111111';
/** Owner-published convert spread fixture — not listing 10, never invented. */
const OWNER_CONVERT_SPREAD_BPS = 25;
const SCOPES = ['trade:read', 'trade:write'] as const;

describe('convert settle B7 hitch (source)', () => {
  it('trade-service.ts contains convertExecute + planConvertSettle + postConvertSettle', () => {
    const src = readFileSync(join(here, '..', 'spot', 'trade-service.ts'), 'utf8');
    expect(src).toMatch(/async convertExecute\(/);
    expect(src).toMatch(/planConvertSettle\(\{ bound, \.\.\.ids, now: new Date\(bound.acceptedAt\) \}\)/);
    expect(src).toMatch(/await postConvertSettle\(this\.ledger, plan\)/);
    expect(src).toMatch(/requireConvertSpreadBps\(this\.convertSpreadBps\)/);
    expect(src).toMatch(/requireConvertQuoteTtlMs\(this\.convertQuoteTtlMs\)/);
    expect(src).not.toMatch(/convertSpreadBps:\s*10\b/);
    expect(src).not.toMatch(/convertSpreadBps \?\? 10/);
    expect(src).not.toMatch(/convertQuoteTtlMs \?\? 15_000/);
    expect(src).not.toMatch(/convertQuoteTtlMs \?\? 15000/);
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

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-trade convert-settle (H8a PG-hard)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];

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

  describe('svc-trade convert settle B7 money', () => {
    let ledger: MemoryLedger;
    let bus: MemoryEventBus;
    let matching: StubMatching;
    let perks: StubPerks;
    let trade: TradeService;
    let btcusdt: Market;
    let nowFn: () => Date;
    let dropCopySeen: DropCopyFillWire[];

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
      dropCopySeen = [];
      trade = new TradeService(sql, ledger, matching, perks, bus, {
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        convertEnabled: true,
        convertSpreadBps: OWNER_CONVERT_SPREAD_BPS,
        convertQuoteTtlMs: 60_000,
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        now: () => nowFn(),
        dropCopyIngest: {
          postFill: async (fill) => {
            dropCopySeen.push(fill);
          },
        },
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
      expect(dropCopySeen).toHaveLength(1);
      expect(dropCopySeen[0]!.source).toBe(DROP_COPY_SOURCE_RFQ);
      expect(dropCopySeen[0]!.source).not.toBe('ui');
      expect(dropCopySeen[0]!.fillId).toBe(settled.fillId);
      expect(typeof dropCopySeen[0]!.price).toBe('string');
      expect(typeof dropCopySeen[0]!.qty).toBe('string');
      expect(typeof dropCopySeen[0]!.quoteAmount).toBe('string');
      expect(typeof dropCopySeen[0]!.feeAmount).toBe('string');
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
      expect(dropCopySeen).toHaveLength(1);
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

    it('already bound legacy Convert recovers after expiry using its immutable acceptedAt exactly once', async () => {
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

      const first = await trade.convertExecute(principal, { quoteId: quote.quoteId });
      expect(fillPosts()).toHaveLength(1);
      expect(amt(await avail('USDT'))).toBeLessThan(amt(usdt));
      expect(amt(await avail('BTC'))).toBe(amt(btc) + amt('1'));
      expect((await trade.convertExecute(principal, { quoteId: quote.quoteId })).fillId).toBe(first.fillId);
      expect(fillPosts()).toHaveLength(1);
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
});
