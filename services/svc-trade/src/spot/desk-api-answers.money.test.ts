import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import {
  formatAmount,
  LedgerError,
  MemoryLedger,
  parseAmount as amt,
  recipes,
  type LedgerTx,
  type PostRequest,
} from '@intafaced/ledger-client';

import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import type { Market } from './types.js';

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
      `H8a: svc-trade desk-api answers are PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const ALICE = '11111111-1111-4111-8111-111111111111';

/** The second order.hold (the replacement) is a frozen book. The first hold posts. */
class FreezeOnSecondHold extends MemoryLedger {
  private holds = 0;

  override async post(request: PostRequest): Promise<LedgerTx> {
    if (request.reason === 'order.hold') {
      this.holds += 1;
      if (this.holds > 1) throw new LedgerError('book is frozen', 'ledger.frozen');
    }
    return super.post(request);
  }
}

describe('desk API money answers (H8a PG-hard)', () => {
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

  describe('market sell floor and replace hold failure', () => {
    let ledger: MemoryLedger;
    let matching: StubMatching;
    let trade: TradeService;
    let btcusdt: Market;

    async function fund(assetId: string, amount: string) {
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

    function service(book: MemoryLedger, cap: number | null): TradeService {
      return new TradeService(sql, book, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        ...(cap === null ? {} : { marketSlippageCapBps: cap }),
      });
    }

    beforeEach(async () => {
      await sql`TRUNCATE trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
      ledger = new MemoryLedger();
      matching = new StubMatching();
      trade = service(ledger, 200);
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
    });

    it('refuses a market sell with trade.protection_unset and posts no hold when the floor is unpublished', async () => {
      await fund('BTC', '2');
      matching.bids = [['100', '5']];
      const bare = service(ledger, null);
      await expect(
        bare.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'sell',
          type: 'market',
          qty: amt('1'),
          clientOrderId: 'sell-unset',
        }),
      ).rejects.toMatchObject({ code: 'trade.protection_unset' });
      const rows = await sql`SELECT id FROM trade.orders`;
      expect(rows).toHaveLength(0);
      expect(ledger.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(0);
    });

    it('places a market sell as an IOC limit at the owner floor', async () => {
      await fund('BTC', '2');
      matching.bids = [['100', '5']];
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'sell',
        type: 'market',
        qty: amt('1'),
        clientOrderId: 'sell-floor',
      });
      expect(formatAmount(order.protectionPrice ?? 0n)).toBe('98');
      expect(matching.submitted[0]?.request).toMatchObject({
        type: 'limit',
        side: 'sell',
        price: '98',
        tif: 'IOC',
      });
    });

    it('refuses a market sell with trade.no_reference_price when the cap is set and the book has no bid', async () => {
      await fund('BTC', '2');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'sell',
          type: 'market',
          qty: amt('1'),
          clientOrderId: 'sell-nobid',
        }),
      ).rejects.toMatchObject({ code: 'trade.no_reference_price' });
    });

    it('returns REPLACEMENT_NOT_SUBMITTED, named posting_frozen, with the cancelled original when the new hold is ledger.frozen', async () => {
      const frozen = new FreezeOnSecondHold();
      const local = service(frozen, 200);
      await frozen.post(
        recipes.deposit({
          userId: ALICE,
          assetId: 'USDT',
          amount: amt('1000'),
          rail: 'test',
          railRef: `frozen:${Math.random()}`,
        }),
      );
      const original = await local.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('2'),
        price: amt('100'),
        clientOrderId: 'orig-frozen',
      });
      const outcome = await local.replaceOrder(principalFor(ALICE), original.id, {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('90'),
        clientOrderId: 'repl-frozen',
      });
      expect(outcome).toMatchObject({
        accepted: false,
        code: 'REPLACEMENT_NOT_SUBMITTED',
        reasonCode: 'posting_frozen',
        replacement: null,
      });
      expect(outcome.original.id).toBe(original.id);
      expect(outcome.original.status).toBe('cancelled');
    });
  });
});
