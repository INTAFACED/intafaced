import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { P2pError, P2pService } from './p2p-service.js';
import { parseActiveOrderCap, parseBuyerCancelLimit, parsePairLimits, pairLimitRefusal, type TakeLimits } from './take-limits.js';
import { parseVerificationLimits, type VerificationLimitConfig } from './verification-limits.js';

/**
 * P-trade-orders-03 and P-disputes-security-15: a take over the ongoing-order cap, outside the pair's bounds, or over
 * a verification-level allowance refuses before anything is reserved, and the refusal carries the figures a person
 * needs (the open orders and the soonest deadline, the bounds, what is left and when it starts again).
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const MAKER = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const ASSET = 'USDT';
const PAIRS = parsePairLimits('{"USDT/EUR":{"min":"9.5","max":"40"}}');

async function refusal(p: Promise<unknown>): Promise<P2pError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(P2pError);
  return err as P2pError;
}

describe('svc-p2p take limit parsing', () => {
  it('reads a whole cap of 1 or more and nothing else', () => {
    expect(parseActiveOrderCap(3)).toBe(3);
    expect(parseActiveOrderCap(null)).toBeNull();
    expect(parseActiveOrderCap(0)).toBeNull();
    expect(parseActiveOrderCap(-2)).toBeNull();
  });

  it('reads a cancel limit only when both the count and the window are whole numbers', () => {
    expect(parseBuyerCancelLimit(3, 24)).toEqual({ limit: 3, windowHours: 24 });
    expect(parseBuyerCancelLimit(3, null)).toEqual({ limit: null, windowHours: null });
    expect(parseBuyerCancelLimit(undefined, 24)).toEqual({ limit: null, windowHours: null });
    expect(parseBuyerCancelLimit(0, 24)).toEqual({ limit: null, windowHours: null });
  });

  it('reads a decimal-string pair table and refuses anything partial', () => {
    expect(parsePairLimits(undefined)).toEqual({ status: 'unset' });
    expect(parsePairLimits('  ')).toEqual({ status: 'unset' });
    expect(parsePairLimits('{"USDT/EUR":{"min":10,"max":"40"}}')).toEqual({ status: 'invalid' });
    expect(parsePairLimits('{"USDT/EUR":{"min":"50","max":"40"}}')).toEqual({ status: 'invalid' });
    expect(parsePairLimits('{"USDT/EUR":{"min":"1","max":"40","fee":"1"}}')).toEqual({ status: 'invalid' });
    expect(parsePairLimits('{"usdt-eur":{"min":"1","max":"40"}}')).toEqual({ status: 'invalid' });
    expect(parsePairLimits('{}')).toEqual({ status: 'invalid' });
    expect(parsePairLimits('not json')).toEqual({ status: 'invalid' });
    expect(pairLimitRefusal(PAIRS, { asset: 'usdt', fiat: 'eur', fiatAmount: parseAmount('9.5') })).toBeNull();
    expect(pairLimitRefusal(PAIRS, { asset: 'USDT', fiat: 'EUR', fiatAmount: parseAmount('40.01') })?.code).toBe('p2p.pair_limit_exceeded');
    expect(pairLimitRefusal(PAIRS, { asset: 'USDT', fiat: 'USD', fiatAmount: parseAmount('10') })).toEqual({
      code: 'p2p.config_unset',
      reason: 'pair_unlisted',
    });
  });
});

describe('svc-p2p take limits (P-trade-orders-03, P-disputes-security-15)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger!: MemoryLedger;
  let instruments!: InstrumentService;

  // A cancel limit far from every test but the ones about it.
  const ROOMY = { limit: 100, windowHours: 24 };
  const service = (
    takeLimits: (Omit<TakeLimits, 'buyerCancels'> & Partial<Pick<TakeLimits, 'buyerCancels'>>) | undefined,
    verificationLimits?: VerificationLimitConfig,
  ) =>
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
      ...(takeLimits ? { takeLimits: { buyerCancels: ROOMY, ...takeLimits } } : {}),
      ...(verificationLimits ? { verificationLimits } : {}),
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
    await instruments.createInstrument({
      ownerId: MAKER,
      methodId: 'sepa',
      country: 'DE',
      fiatCurrency: 'EUR',
      label: 'sepa',
      details: { account_reference: 'ref-maker' },
      instrumentId: crypto.randomUUID(),
    });
    await ledger.post(
      recipes.deposit({ userId: MAKER, assetId: ASSET, amount: parseAmount('500'), rail: 'test', railRef: `${MAKER}:fund` }),
    );
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  const sellOffer = (p2p: P2pService) =>
    p2p.createOffer({
      makerId: MAKER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'EUR',
      priceType: 'fixed',
      price: parseAmount('0.92'),
      minAmt: parseAmount('10'),
      maxAmt: parseAmount('50'),
      totalAmt: parseAmount('500'),
      methods: ['sepa'],
      terms: 'TEST terms',
    });

  const take = (p2p: P2pService, offerId: string, amount = '20', tradeId: string = crypto.randomUUID()) =>
    p2p.takeOffer({ tradeId, offerId, takerId: TAKER, amount: parseAmount(amount), method: 'sepa', tier: 'basic' });

  it('the cap refuses the next take with the open orders and the soonest deadline, and frees a place once one ends', async () => {
    const p2p = service({ activeOrderCap: 2, pairLimits: PAIRS });
    const offer = await sellOffer(p2p);
    const first = await take(p2p, offer.id);
    const second = await take(p2p, offer.id);
    const journal = ledger.journal().length;

    const quoted = await refusal(p2p.quoteTake({ offerId: offer.id, takerId: TAKER, method: 'sepa', amount: parseAmount('20') }));
    expect(quoted.code).toBe('p2p.active_order_cap');
    const refused = await refusal(take(p2p, offer.id));
    expect(refused.code).toBe('p2p.active_order_cap');
    const deadlines = [first, second].map((t) => t.deadlineAt?.toISOString()).sort();
    expect(refused.limit).toEqual({ until: deadlines[0], cap: '2', openTradeIds: expect.arrayContaining([first.id, second.id]) });
    expect(refused.limit?.openTradeIds).toHaveLength(2);
    // Nothing reserved for the refused take.
    expect(ledger.journal()).toHaveLength(journal);
    expect(await sql`SELECT id FROM p2p.p2p_trades`).toHaveLength(2);
    expect((await p2p.getOffer(offer.id)).remainingAmt).toBe(parseAmount('460'));

    // A retry of a take that already exists is that take, not a third order.
    expect((await refusal(take(p2p, offer.id, '20', second.id))).code).toBe('p2p.trade_exists');

    await p2p.cancelTrade(first.id, TAKER, 'TEST changed my mind');
    expect((await take(p2p, offer.id)).status).toBe('escrowed');
  });

  it('two takes at once on a cap of 1 place one order', async () => {
    const p2p = service({ activeOrderCap: 1, pairLimits: PAIRS });
    const offer = await sellOffer(p2p);
    const [a, b] = await Promise.allSettled([take(p2p, offer.id), take(p2p, offer.id)]);
    const placed = [a, b].filter((r) => r.status === 'fulfilled');
    const refused = [a, b].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(placed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0]!.reason as P2pError).code).toBe('p2p.active_order_cap');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a fiat amount outside the pair bounds refuses with the bounds and no end time', async () => {
    const p2p = service({ activeOrderCap: 5, pairLimits: PAIRS });
    const offer = await sellOffer(p2p);
    // 10 USDT at 0.92 is 9.20 EUR, under the 9.50 minimum; 45 USDT is 41.40 EUR, over the 40 maximum.
    for (const amount of ['10', '45']) {
      const refused = await refusal(take(p2p, offer.id, amount));
      expect(refused.code).toBe('p2p.pair_limit_exceeded');
      expect(refused.limit).toEqual({ until: null, min: '9.5', max: '40', currency: 'EUR' });
    }
    const quoted = await refusal(
      p2p.lockQuote({ quoteId: crypto.randomUUID(), offerId: offer.id, takerId: TAKER, method: 'sepa', fiatAmount: parseAmount('41') }),
    );
    expect(quoted.code).toBe('p2p.pair_limit_exceeded');
    expect(await sql`SELECT id FROM p2p.p2p_trades`).toHaveLength(0);
    expect(await sql`SELECT quote_id FROM p2p.take_quotes`).toHaveLength(0);
    expect((await take(p2p, offer.id, '20')).status).toBe('escrowed');
  });

  it('a blank cap, a blank table and a pair the table leaves out each refuse every take', async () => {
    for (const limits of [
      { activeOrderCap: null, pairLimits: PAIRS },
      { activeOrderCap: 5, pairLimits: parsePairLimits('') },
      { activeOrderCap: 5, pairLimits: parsePairLimits('{"USDT/USD":{"min":"1","max":"40"}}') },
    ]) {
      const p2p = service(limits);
      const offer = await sellOffer(p2p);
      expect((await refusal(take(p2p, offer.id))).code).toBe('p2p.config_unset');
    }
    expect(await sql`SELECT id FROM p2p.p2p_trades`).toHaveLength(0);
  });

  it('the daily verification allowance refuses with what is left and the next UTC day', async () => {
    const wide = { orderMin: '0', orderMax: '1000', dailyMax: '1000', lifetimeMax: '1000' };
    const limits = parseVerificationLimits({
      currency: 'EUR',
      tiers: { none: wide, basic: { orderMin: '1', orderMax: '30', dailyMax: '30', lifetimeMax: '1000' }, full: wide, institutional: wide },
    });
    const p2p = service({ activeOrderCap: 5, pairLimits: PAIRS }, limits);
    const offer = await sellOffer(p2p);
    await take(p2p, offer.id, '20'); // 18.40 EUR of the 30 EUR day.
    const refused = await refusal(take(p2p, offer.id, '20'));
    expect(refused.code).toBe('p2p.verification_daily_limit');
    const [day] = await sql<
      { next: Date }[]
    >`SELECT (date_trunc('day', timezone('UTC', now())) + interval '1 day') AT TIME ZONE 'UTC' AS next`;
    expect(refused.limit).toEqual({ until: day!.next.toISOString(), remaining: '11.6', currency: 'EUR' });
    expect(new Date(refused.limit!.until!).getUTCHours()).toBe(0);
  });

  it('a seller taking a buy ad is not shown the buyer’s allowance', async () => {
    const wide = { orderMin: '0', orderMax: '1000', dailyMax: '1000', lifetimeMax: '1000' };
    const limits = parseVerificationLimits({
      currency: 'EUR',
      tiers: { none: wide, basic: { orderMin: '1', orderMax: '30', dailyMax: '30', lifetimeMax: '1000' }, full: wide, institutional: wide },
    });
    const p2p = service({ activeOrderCap: 5, pairLimits: PAIRS }, limits);
    await instruments.createInstrument({
      ownerId: TAKER,
      methodId: 'sepa',
      country: 'DE',
      fiatCurrency: 'EUR',
      label: 'sepa',
      details: { account_reference: 'ref-taker' },
      instrumentId: crypto.randomUUID(),
    });
    await ledger.post(
      recipes.deposit({ userId: TAKER, assetId: ASSET, amount: parseAmount('100'), rail: 'test', railRef: `${TAKER}:fund` }),
    );
    const offer = await p2p.createOffer({
      makerId: MAKER,
      side: 'buy',
      asset: ASSET,
      fiatCurrency: 'EUR',
      priceType: 'fixed',
      price: parseAmount('0.92'),
      minAmt: parseAmount('10'),
      maxAmt: parseAmount('50'),
      totalAmt: parseAmount('100'),
      methods: ['sepa'],
      terms: 'TEST terms',
      makerTier: 'basic',
    });
    await take(p2p, offer.id, '20');
    const refused = await refusal(take(p2p, offer.id, '20'));
    expect(refused.code).toBe('p2p.verification_daily_limit');
    expect(refused.limit).toBeUndefined();
  });

  it('a paid order gives no end time, and a cap above 50 still counts every order', async () => {
    const p2p = service({ activeOrderCap: 51, pairLimits: parsePairLimits('{"USDT/EUR":{"min":"0.5","max":"40"}}') });
    const offer = await p2p.createOffer({
      makerId: MAKER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'EUR',
      priceType: 'fixed',
      price: parseAmount('0.92'),
      minAmt: parseAmount('1'),
      maxAmt: parseAmount('50'),
      totalAmt: parseAmount('100'),
      methods: ['sepa'],
      terms: 'TEST terms',
    });
    const placed = [];
    for (let i = 0; i < 51; i++) placed.push(await take(p2p, offer.id, '1'));
    for (const trade of placed) await p2p.markFiatSent(trade.id, TAKER);
    const refused = await refusal(take(p2p, offer.id, '1'));
    expect(refused.code).toBe('p2p.active_order_cap');
    expect(refused.limit?.cap).toBe('51');
    expect(refused.limit?.until).toBeNull();
    expect(refused.limit?.openTradeIds).toHaveLength(50);
  });

  /**
   * Moves a finished order's resolution as the clock or the sweeper would have written it. A terminal row is frozen
   * by trigger, so the test lifts it for this one write only.
   */
  const rewrite = async (tradeId: string, set: { hoursAgo?: number; reason?: string }) => {
    await sql.begin(async (tx) => {
      await tx`ALTER TABLE p2p.p2p_trades DISABLE TRIGGER p2p_trades_original_terms_frozen_trg`;
      if (set.hoursAgo !== undefined) {
        await tx`UPDATE p2p.p2p_trades SET resolved_at = now() - make_interval(hours => ${set.hoursAgo}) WHERE id = ${tradeId}`;
      }
      if (set.reason !== undefined) await tx`UPDATE p2p.p2p_trades SET resolution_reason = ${set.reason} WHERE id = ${tradeId}`;
      await tx`ALTER TABLE p2p.p2p_trades ENABLE TRIGGER p2p_trades_original_terms_frozen_trg`;
    });
  };

  it('cancelled orders pause buying until the oldest of them leaves the window; others’ cancels do not count', async () => {
    const p2p = service({ activeOrderCap: 5, pairLimits: PAIRS, buyerCancels: { limit: 2, windowHours: 24 } });
    const offer = await sellOffer(p2p);
    const placed = await take(p2p, offer.id);
    // The seller's cancel is not the buyer's; then the buyer cancels two, and an older cancel sits outside the window.
    await p2p.cancelTrade((await take(p2p, offer.id)).id, MAKER, 'TEST seller changed their mind');
    const old = await take(p2p, offer.id);
    await p2p.cancelTrade(old.id, TAKER, 'TEST');
    await rewrite(old.id, { hoursAgo: 30 });
    const first = await take(p2p, offer.id);
    await p2p.cancelTrade(first.id, TAKER, 'TEST');
    expect((await take(p2p, offer.id)).status).toBe('escrowed');
    // The payment window running out on the buyer counts as the buyer's.
    const lapsed = await take(p2p, offer.id);
    await p2p.cancelTrade(lapsed.id, TAKER, 'TEST');
    await rewrite(lapsed.id, { reason: 'timeout.payment_window_elapsed' });
    const journal = ledger.journal().length;

    const [oldest] = await sql<
      { until: Date }[]
    >`SELECT resolved_at + interval '24 hours' AS until FROM p2p.p2p_trades WHERE id = ${first.id}`;
    for (const attempt of [
      p2p.quoteTake({ offerId: offer.id, takerId: TAKER, method: 'sepa', amount: parseAmount('20') }),
      take(p2p, offer.id),
    ]) {
      const refused = await refusal(attempt);
      expect(refused.code).toBe('p2p.buying_restricted');
      expect(refused.limit).toEqual({ until: oldest!.until.toISOString(), cap: '2', windowHours: '24' });
    }
    expect(ledger.journal()).toHaveLength(journal);
    // A retry of a take placed before the pause is that take.
    expect((await refusal(take(p2p, offer.id, '20', placed.id))).code).toBe('p2p.trade_exists');

    // Once the oldest of the two leaves the window, buying is back.
    await rewrite(first.id, { hoursAgo: 25 });
    expect((await take(p2p, offer.id)).status).toBe('escrowed');
  });

  const takerSells = async () => {
    await instruments.createInstrument({
      ownerId: TAKER,
      methodId: 'sepa',
      country: 'DE',
      fiatCurrency: 'EUR',
      label: 'sepa',
      details: { account_reference: 'ref-taker' },
      instrumentId: crypto.randomUUID(),
    });
    await ledger.post(
      recipes.deposit({ userId: TAKER, assetId: ASSET, amount: parseAmount('100'), rail: 'test', railRef: `${TAKER}:fund` }),
    );
  };
  const buyOffer = (p2p: P2pService, makerId: string) =>
    p2p.createOffer({
      makerId,
      side: 'buy',
      asset: ASSET,
      fiatCurrency: 'EUR',
      priceType: 'fixed',
      price: parseAmount('0.92'),
      minAmt: parseAmount('10'),
      maxAmt: parseAmount('50'),
      totalAmt: parseAmount('100'),
      methods: ['sepa'],
      terms: 'TEST terms',
      makerTier: 'basic',
    });

  it('a blank cancel limit refuses every buy: a take of a sell ad, a new buy ad and a take of one', async () => {
    const roomy = service({ activeOrderCap: 5, pairLimits: PAIRS });
    const buy = await buyOffer(roomy, MAKER);
    await takerSells();
    const p2p = service({ activeOrderCap: 5, pairLimits: PAIRS, buyerCancels: parseBuyerCancelLimit(null, 24) });
    const sell = await sellOffer(p2p);
    expect((await refusal(take(p2p, sell.id))).code).toBe('p2p.config_unset');
    expect((await refusal(buyOffer(p2p, TAKER))).code).toBe('p2p.config_unset');
    expect((await refusal(take(p2p, buy.id))).code).toBe('p2p.config_unset');
    expect(await sql`SELECT id FROM p2p.p2p_trades`).toHaveLength(0);
  });

  it('a paused buyer may still sell, posts no buy ad, and their own buy ad takes no orders meanwhile', async () => {
    const p2p = service({ activeOrderCap: 5, pairLimits: PAIRS, buyerCancels: { limit: 2, windowHours: 24 } });
    await takerSells();
    const theirs = await buyOffer(p2p, TAKER);
    const sell = await sellOffer(p2p);
    for (let i = 0; i < 2; i++) await p2p.cancelTrade((await take(p2p, sell.id)).id, TAKER, 'TEST');

    expect((await refusal(take(p2p, sell.id))).code).toBe('p2p.buying_restricted');
    const posted = await refusal(buyOffer(p2p, TAKER));
    expect(posted.code).toBe('p2p.buying_restricted');
    expect(posted.limit).toMatchObject({ cap: '2', windowHours: '24' });
    // A seller filling the paused buyer's ad learns only that it takes no orders, nothing about the pause.
    const filled = await refusal(
      p2p.takeOffer({
        tradeId: crypto.randomUUID(),
        offerId: theirs.id,
        takerId: MAKER,
        amount: parseAmount('20'),
        method: 'sepa',
        tier: 'basic',
      }),
    );
    expect(filled.code).toBe('p2p.offer_not_active');
    expect(filled.limit).toBeUndefined();
    // Selling is not paused.
    const buy = await buyOffer(p2p, MAKER);
    expect((await take(p2p, buy.id)).status).toBe('escrowed');
  });

  it('a service built without the owner limits takes as before', async () => {
    const p2p = service(undefined);
    const offer = await sellOffer(p2p);
    expect((await take(p2p, offer.id, '50')).status).toBe('escrowed');
  });
});
