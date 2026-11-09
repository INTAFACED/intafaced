import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { P2pService } from './p2p-service.js';
import { parseRankWeights, rankOrder, type RankingPolicy } from './ranking.js';
import { parsePairLimits } from './take-limits.js';

/**
 * J-p2p-05 #6 (P-ads-merchant-10): the board's ranking policy. Blank weights rank by price, then creation, then id;
 * with the weight set, a maker with a higher 30-day completion rate ranks above at an equal price; paging a ranked
 * board neither repeats nor skips an ad.
 */

describe('svc-p2p ranking weights parsing', () => {
  it('reads blank as rule off, a full known table as active, and anything else as invalid', () => {
    expect(parseRankWeights(undefined)).toEqual({ status: 'off', weights: null });
    expect(parseRankWeights('  ')).toEqual({ status: 'off', weights: null });
    expect(parseRankWeights('{"completionRate30d":"1"}')).toEqual({ status: 'active', weights: { completionRate30d: '1' } });
    expect(parseRankWeights('{"completionRate30d":"0.5"}').status).toBe('active');
    for (const bad of [
      '{"completionRate30d":1}',
      '{"completionRate30d":"0"}',
      '{"tier":"1"}',
      '{}',
      '[]',
      'nope',
      '{"completionRate30d":"1","tier":"1"}',
    ]) {
      expect(parseRankWeights(bad)).toEqual({ status: 'invalid', weights: null });
    }
    expect(rankOrder(parseRankWeights('{"completionRate30d":"1"}'))).toEqual(['price', 'completionRate30d', 'createdAt', 'id']);
    expect(rankOrder(parseRankWeights(''))).toEqual(['price', 'createdAt', 'id']);
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const QUIET = '11111111-1111-4111-8111-111111111111';
const BUSY = '33333333-3333-4333-8333-333333333333';
const TAKER = '22222222-2222-4222-8222-222222222222';
const ASSET = 'USDT';
const PAIRS = parsePairLimits('{"USDT/EUR":{"min":"1","max":"100"}}');

describe('svc-p2p ranked board (J-p2p-05 #6)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger!: MemoryLedger;
  let instruments!: InstrumentService;

  const service = (ranking: RankingPolicy) =>
    new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), {
      instruments,
      feeBps: 0,
      deadlines: {
        escrowSeconds: 120,
        paymentSeconds: 900,
        releaseSeconds: 1800,
        disputeSeconds: 604_800,
        escalationRecheckSeconds: 3_600,
      },
      takeLimits: { activeOrderCap: 20, pairLimits: PAIRS, buyerCancels: { limit: 100, windowHours: 24 } },
      ranking,
    });

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    instruments = new InstrumentService(sql);
    await instruments.registerMethodSchema({
      methodId: 'sepa',
      country: ANY_COUNTRY,
      label: 'Test rail',
      fields: [{ key: 'account_reference', label: 'Account reference', required: true }],
    });
    for (const maker of [QUIET, BUSY]) {
      await instruments.createInstrument({
        ownerId: maker,
        methodId: 'sepa',
        country: 'DE',
        fiatCurrency: 'EUR',
        label: 'sepa',
        details: { account_reference: `ref-${maker.slice(0, 4)}` },
        instrumentId: crypto.randomUUID(),
      });
      await ledger.post(
        recipes.deposit({ userId: maker, assetId: ASSET, amount: parseAmount('500'), rail: 'test', railRef: `${maker}:fund` }),
      );
    }
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  const sellAd = (p2p: P2pService, makerId: string, price = '0.81') =>
    p2p.createOffer({
      makerId,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'EUR',
      priceType: 'fixed',
      price: parseAmount(price),
      minAmt: parseAmount('10'),
      maxAmt: parseAmount('20'),
      totalAmt: parseAmount('100'),
      methods: ['sepa'],
      terms: 'TEST terms',
    });

  /** The quiet maker posts first; the busy one completes one order. */
  async function board(p2p: P2pService) {
    const quiet = await sellAd(p2p, QUIET);
    const busy = await sellAd(p2p, BUSY);
    const trade = await p2p.takeOffer({
      tradeId: crypto.randomUUID(),
      offerId: busy.id,
      takerId: TAKER,
      amount: parseAmount('15'),
      method: 'sepa',
      tier: 'basic',
    });
    await p2p.markFiatSent(trade.id, TAKER);
    expect((await p2p.confirmFiatReceived(trade.id, BUSY)).status).toBe('released');
    return { quiet, busy };
  }

  const ids = async (p2p: P2pService, sort: 'price_asc' | 'rank') =>
    (await p2p.listOfferBoard({ asset: ASSET, fiatCurrency: 'EUR', side: 'sell', sort, limit: 50 })).offers.map((o) => o.id);

  it('with blank weights the ranked board is the price order: price, then creation, then id', async () => {
    const p2p = service(parseRankWeights(undefined));
    const { quiet, busy } = await board(p2p);
    expect(p2p.rankingPolicy()).toEqual({ status: 'off', weights: null, order: ['price', 'createdAt', 'id'] });
    expect(await ids(p2p, 'price_asc')).toEqual([quiet.id, busy.id]);
    expect(await ids(p2p, 'rank')).toEqual([quiet.id, busy.id]);
  });

  it('with the weight set a higher-completion maker ranks above at an equal price; a cheaper ad still comes first', async () => {
    const p2p = service(parseRankWeights('{"completionRate30d":"1"}'));
    const { quiet, busy } = await board(p2p);
    expect(p2p.rankingPolicy().order).toEqual(['price', 'completionRate30d', 'createdAt', 'id']);
    expect(await ids(p2p, 'price_asc')).toEqual([quiet.id, busy.id]);
    expect(await ids(p2p, 'rank')).toEqual([busy.id, quiet.id]);
    // Price comes before the rate: the quiet maker's cheaper ad is first.
    const cheaper = await sellAd(p2p, QUIET, '0.80');
    expect(await ids(p2p, 'rank')).toEqual([cheaper.id, busy.id, quiet.id]);
  });

  it('pages a ranked board one ad at a time with no repeat and no gap, and a price cursor is not a rank cursor', async () => {
    const p2p = service(parseRankWeights('{"completionRate30d":"1"}'));
    const { quiet, busy } = await board(p2p);
    const cheaper = await sellAd(p2p, QUIET, '0.80');
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<P2pService['listOfferBoard']>> = await p2p.listOfferBoard({
        asset: ASSET,
        fiatCurrency: 'EUR',
        side: 'sell',
        sort: 'rank',
        limit: 1,
        cursor,
      });
      seen.push(...page.offers.map((o) => o.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([cheaper.id, busy.id, quiet.id]);
    const priced = await p2p.listOfferBoard({ asset: ASSET, fiatCurrency: 'EUR', side: 'sell', sort: 'price_asc', limit: 1 });
    await expect(
      p2p.listOfferBoard({ asset: ASSET, fiatCurrency: 'EUR', side: 'sell', sort: 'rank', limit: 1, cursor: priced.nextCursor }),
    ).rejects.toMatchObject({ code: 'p2p.offer_cursor_invalid' });
  });
});
