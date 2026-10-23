import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, mulBps, parseAmount, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { P2pService } from './p2p-service.js';

/**
 * P-trade-orders-06: a locked quote holds the price, the fee and both amounts for the escrow window. A take that names
 * it places exactly that, or refuses before anything is reserved: `p2p.quote_expired` past the window,
 * `p2p.quote_changed` when the price or the fee moved.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const MAKER = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ASSET = 'USDT';

describe('svc-p2p locked take quote (P-trade-orders-06)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger!: MemoryLedger;
  let instruments!: InstrumentService;
  let p2p!: P2pService;

  const service = (feeBps: number) =>
    new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), {
      instruments,
      feeBps,
      deadlines: {
        escrowSeconds: 120,
        paymentSeconds: 900,
        releaseSeconds: 1800,
        disputeSeconds: 604_800,
        escalationRecheckSeconds: 3_600,
      },
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
    p2p = service(100);
    await ledger.post(
      recipes.deposit({ userId: MAKER, assetId: ASSET, amount: parseAmount('100'), rail: 'test', railRef: `${MAKER}:fund` }),
    );
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  const sellOffer = () =>
    p2p.createOffer({
      makerId: MAKER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'EUR',
      priceType: 'fixed',
      price: parseAmount('0.92'),
      minAmt: parseAmount('10'),
      maxAmt: parseAmount('50'),
      totalAmt: parseAmount('100'),
      methods: ['sepa'],
      terms: 'TEST terms',
    });

  async function nothingReserved(offerId: string) {
    expect((await p2p.getOffer(offerId)).remainingAmt).toBe(parseAmount('100'));
    expect(await sql`SELECT id FROM p2p.p2p_trades`).toHaveLength(0);
    expect(ledger.journal()).toHaveLength(1);
    expect(ledger.reconcile()).toEqual({ ok: true });
  }

  it('a fiat amount buys the coin amount rounded down, and the locked quote holds it for the escrow window', async () => {
    const offer = await sellOffer();
    const quoteId = crypto.randomUUID();
    const before = Date.now();
    const locked = await p2p.lockQuote({ quoteId, offerId: offer.id, takerId: TAKER, method: 'sepa', fiatAmount: parseAmount('20') });
    // 20 / 0.92 = 21.739130434782608695652…, down to the ledger's 18 places; it costs exactly 20.00 EUR.
    expect(formatAmount(locked.amount)).toBe('21.739130434782608695');
    expect(formatAmount(locked.fiatAmount)).toBe('20');
    expect(locked.feeBps).toBe(100);
    expect(locked.fee).toBe(mulBps(locked.amount, 100));
    const window = locked.expiresAt.getTime() - before;
    expect(window).toBeGreaterThan(110_000);
    expect(window).toBeLessThan(130_000);

    // A retry returns the first quote; the same id for another method or person refuses.
    expect(await p2p.lockQuote({ quoteId, offerId: offer.id, takerId: TAKER, method: 'sepa', fiatAmount: parseAmount('20') })).toEqual(
      locked,
    );
    await expect(
      p2p.lockQuote({ quoteId, offerId: offer.id, takerId: OTHER, method: 'sepa', amount: parseAmount('10') }),
    ).rejects.toMatchObject({ code: 'p2p.idempotency_conflict' });
    await nothingReserved(offer.id);
  });

  it('a take that names the quote places exactly its terms, once', async () => {
    const offer = await sellOffer();
    const quoteId = crypto.randomUUID();
    const locked = await p2p.lockQuote({ quoteId, offerId: offer.id, takerId: TAKER, method: 'sepa', amount: parseAmount('10') });
    const tradeId = crypto.randomUUID();
    const trade = await p2p.takeOffer({ offerId: offer.id, takerId: TAKER, amount: locked.amount, method: 'sepa', tradeId, quoteId });
    expect(trade.status).toBe('escrowed');
    expect(trade.price).toBe(locked.price);
    expect(trade.fiatAmount).toBe(locked.fiatAmount);
    expect(trade.feeBps).toBe(locked.feeBps);
    // The same take again after the window: it reaches the trade it placed, not a refusal saying nothing was placed.
    await sql`UPDATE p2p.take_quotes SET created_at = now() - interval '1 hour', expires_at = now() - interval '1 minute'`;
    await expect(
      p2p.takeOffer({ offerId: offer.id, takerId: TAKER, amount: locked.amount, method: 'sepa', tradeId, quoteId }),
    ).rejects.toMatchObject({ code: 'p2p.trade_exists' });
    expect(await sql`SELECT id FROM p2p.p2p_trades`).toHaveLength(1);
  });

  it('past its window the take refuses p2p.quote_expired and nothing is reserved; a new quote works', async () => {
    const offer = await sellOffer();
    const quoteId = crypto.randomUUID();
    await p2p.lockQuote({ quoteId, offerId: offer.id, takerId: TAKER, method: 'sepa', amount: parseAmount('10') });
    await sql`UPDATE p2p.take_quotes SET created_at = now() - interval '1 hour', expires_at = now() - interval '1 second'`;
    await expect(
      p2p.takeOffer({
        offerId: offer.id,
        takerId: TAKER,
        amount: parseAmount('10'),
        method: 'sepa',
        tradeId: crypto.randomUUID(),
        quoteId,
      }),
    ).rejects.toMatchObject({ code: 'p2p.quote_expired' });
    await nothingReserved(offer.id);

    const fresh = crypto.randomUUID();
    await p2p.lockQuote({ quoteId: fresh, offerId: offer.id, takerId: TAKER, method: 'sepa', amount: parseAmount('10') });
    const trade = await p2p.takeOffer({
      offerId: offer.id,
      takerId: TAKER,
      amount: parseAmount('10'),
      method: 'sepa',
      tradeId: crypto.randomUUID(),
      quoteId: fresh,
    });
    expect(trade.status).toBe('escrowed');
  });

  it('a moved price or fee refuses p2p.quote_changed, and nothing is reserved', async () => {
    const offer = await sellOffer();
    const priceQuote = crypto.randomUUID();
    await p2p.lockQuote({ quoteId: priceQuote, offerId: offer.id, takerId: TAKER, method: 'sepa', amount: parseAmount('10') });
    await sql`UPDATE p2p.offers SET price = 0.95 WHERE id = ${offer.id}`;
    await expect(
      p2p.takeOffer({
        offerId: offer.id,
        takerId: TAKER,
        amount: parseAmount('10'),
        method: 'sepa',
        tradeId: crypto.randomUUID(),
        quoteId: priceQuote,
      }),
    ).rejects.toMatchObject({ code: 'p2p.quote_changed' });
    await nothingReserved(offer.id);

    const feeQuote = crypto.randomUUID();
    await p2p.lockQuote({ quoteId: feeQuote, offerId: offer.id, takerId: TAKER, method: 'sepa', amount: parseAmount('10') });
    await expect(
      service(150).takeOffer({
        offerId: offer.id,
        takerId: TAKER,
        amount: parseAmount('10'),
        method: 'sepa',
        tradeId: crypto.randomUUID(),
        quoteId: feeQuote,
      }),
    ).rejects.toMatchObject({ code: 'p2p.quote_changed' });
    await nothingReserved(offer.id);
  });

  it('a quote is the taker’s own and for the take it names', async () => {
    const offer = await sellOffer();
    const quoteId = crypto.randomUUID();
    await p2p.lockQuote({ quoteId, offerId: offer.id, takerId: TAKER, method: 'sepa', amount: parseAmount('10') });
    await expect(
      p2p.takeOffer({
        offerId: offer.id,
        takerId: OTHER,
        amount: parseAmount('10'),
        method: 'sepa',
        tradeId: crypto.randomUUID(),
        quoteId,
      }),
    ).rejects.toMatchObject({ code: 'p2p.quote_not_found' });
    await expect(
      p2p.takeOffer({
        offerId: offer.id,
        takerId: TAKER,
        amount: parseAmount('11'),
        method: 'sepa',
        tradeId: crypto.randomUUID(),
        quoteId,
      }),
    ).rejects.toMatchObject({ code: 'p2p.quote_mismatch' });
    await expect(
      p2p.takeOffer({
        offerId: offer.id,
        takerId: TAKER,
        amount: parseAmount('10'),
        method: 'sepa',
        tradeId: crypto.randomUUID(),
        quoteId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'p2p.quote_not_found' });
    await nothingReserved(offer.id);
  });

  it('a fiat amount below the ad’s minimum, or one that buys nothing, refuses', async () => {
    const offer = await sellOffer();
    await expect(p2p.quoteTake({ offerId: offer.id, takerId: TAKER, method: 'sepa', fiatAmount: parseAmount('5') })).rejects.toMatchObject({
      code: 'p2p.amount_below_min',
    });
    await expect(p2p.quoteTake({ offerId: offer.id, takerId: TAKER, method: 'sepa', fiatAmount: parseAmount('0') })).rejects.toMatchObject({
      code: 'p2p.invalid_amount',
    });
  });
});
