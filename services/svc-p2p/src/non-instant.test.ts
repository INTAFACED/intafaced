import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY, InstrumentError } from './instruments.js';
import { P2pError, P2pService } from './p2p-service.js';

/**
 * P-disputes-security-09: a method whose money arrives within a settlement window. A sell ad listing one needs the
 * seller's consent at post; a take on one without it refuses `p2p.non_instant_not_accepted` and reserves nothing. The
 * order copies the profile of the market it pays into: its payment deadline is the window (a blank window keeps the
 * published deadline), and a party's dispute opens only after it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const MAKER = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const ASSET = 'USDT';
const FIELDS = [{ key: 'account_reference', label: 'Account reference', required: true }];
const PAYMENT_SECONDS = 900;
const WINDOW = 2 * 24 * 60 * 60;

async function refusal(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

describe('svc-p2p non-instant payment methods (P-disputes-security-09)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger!: MemoryLedger;
  let instruments!: InstrumentService;
  let p2p!: P2pService;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    instruments = new InstrumentService(sql);
    p2p = new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), {
      instruments,
      feeBps: 0,
      deadlines: {
        escrowSeconds: 120,
        paymentSeconds: PAYMENT_SECONDS,
        releaseSeconds: 1800,
        disputeSeconds: 604_800,
        escalationRecheckSeconds: 3_600,
      },
    });
    // Instant everywhere; slow in Germany (where the maker is paid) with a two-day window; blank-window in France.
    await instruments.registerMethodSchema({ methodId: 'sepa', country: ANY_COUNTRY, label: 'Instant rail', fields: FIELDS });
    await instruments.registerMethodSchema({
      methodId: 'slow',
      country: 'DE',
      label: 'Slow rail',
      fields: FIELDS,
      settlement: { instant: false, windowSeconds: WINDOW },
    });
    await instruments.registerMethodSchema({
      methodId: 'slow',
      country: 'FR',
      label: 'Slow rail',
      fields: FIELDS,
      settlement: { instant: false, windowSeconds: null },
    });
    for (const methodId of ['sepa', 'slow']) {
      await instruments.createInstrument({
        ownerId: MAKER,
        methodId,
        country: 'DE',
        fiatCurrency: 'EUR',
        label: methodId,
        details: { account_reference: `ref-${methodId}` },
        instrumentId: crypto.randomUUID(),
      });
    }
    await ledger.post(
      recipes.deposit({ userId: MAKER, assetId: ASSET, amount: parseAmount('500'), rail: 'test', railRef: `${MAKER}:fund` }),
    );
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  const sellOffer = (methods: string[], acceptsNonInstant?: boolean) =>
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
      methods,
      terms: 'TEST terms',
      ...(acceptsNonInstant === undefined ? {} : { acceptsNonInstant }),
    });

  const take = (offerId: string, method: string) =>
    p2p.takeOffer({ tradeId: crypto.randomUUID(), offerId, takerId: TAKER, amount: parseAmount('20'), method, tier: 'basic' });

  it('stores the profile per market, keeps it on a replace that omits it, and refuses a window out of bounds', async () => {
    const [de] = await instruments
      .listMethodSchemas({ methodId: 'slow', country: 'DE', limit: 5 })
      .then((rows) => rows.filter((r) => r.country === 'DE'));
    expect(de?.settlement).toEqual({ instant: false, windowSeconds: WINDOW });
    const replaced = await instruments.registerMethodSchema({ methodId: 'slow', country: 'DE', label: 'Slow rail v2', fields: FIELDS });
    expect(replaced.settlement).toEqual({ instant: false, windowSeconds: WINDOW });
    const [sepa] = await instruments.listMethodSchemas({ methodId: 'sepa', limit: 5 });
    expect(sepa?.settlement).toEqual({ instant: true });
    for (const windowSeconds of [59, 2_592_001, 1.5]) {
      const err = await refusal(
        instruments.registerMethodSchema({
          methodId: 'slow',
          country: 'DE',
          label: 'x',
          fields: FIELDS,
          settlement: { instant: false, windowSeconds },
        }),
      );
      expect(err).toBeInstanceOf(InstrumentError);
      expect((err as InstrumentError).code).toBe('p2p.instrument_schema_invalid');
    }
  });

  it('refuses a sell ad listing a non-instant method without consent, and posts it with consent', async () => {
    const err = await refusal(sellOffer(['sepa', 'slow']));
    expect(err).toBeInstanceOf(P2pError);
    expect((err as P2pError).code).toBe('p2p.non_instant_not_accepted');
    expect((await sellOffer(['sepa'])).acceptsNonInstant).toBe(false);
    expect((await sellOffer(['sepa', 'slow'], true)).acceptsNonInstant).toBe(true);
  });

  it('refuses an edit that adds a non-instant method to an ad without consent', async () => {
    const offer = await sellOffer(['sepa']);
    const err = await refusal(
      p2p.updateOffer({ offerId: offer.id, makerId: MAKER, idempotencyKey: 'edit:slow:1', methods: ['sepa', 'slow'] }),
    );
    expect((err as P2pError).code).toBe('p2p.non_instant_not_accepted');
  });

  it('says on the board which methods are non-instant with the longest window, blank when a market leaves it blank', async () => {
    expect(await instruments.boardSettlements(['sepa', 'slow'])).toEqual(new Map([['slow', { instant: false, windowSeconds: null }]]));
    await instruments.setMethodSchemaEnabled('slow', 'FR', false, 'low_demand');
    expect(await instruments.boardSettlements(['sepa', 'slow'])).toEqual(new Map([['slow', { instant: false, windowSeconds: WINDOW }]]));
  });

  it('refuses the take when the profile changed to non-instant after a post without consent, reserving nothing', async () => {
    const offer = await sellOffer(['sepa']);
    // The operator makes the instant rail slow in the maker's market after the ad went up.
    await instruments.registerMethodSchema({
      methodId: 'sepa',
      country: 'DE',
      label: 'Now slow',
      fields: FIELDS,
      settlement: { instant: false, windowSeconds: WINDOW },
    });
    const journal = ledger.journal().length;
    const err = await refusal(take(offer.id, 'sepa'));
    expect((err as P2pError).code).toBe('p2p.non_instant_not_accepted');
    expect(ledger.journal().length).toBe(journal);
    expect(await sql`SELECT 1 FROM p2p.p2p_trades`).toHaveLength(0);
    const [row] = await sql<{ remaining_amt: string }[]>`SELECT remaining_amt::text FROM p2p.offers WHERE id = ${offer.id}`;
    expect(parseAmount(row!.remaining_amt)).toBe(parseAmount('500'));
  });

  it('an instant method keeps the published payment deadline and an open dispute', async () => {
    const offer = await sellOffer(['sepa', 'slow'], true);
    const trade = await take(offer.id, 'sepa');
    expect(trade.settlement).toEqual({ instant: true });
    const escrowed = await p2p.getTrade(trade.id);
    expect(escrowed.status).toBe('escrowed');
    expect(escrowed.deadlineAt!.getTime() - escrowed.escrowedAt!.getTime()).toBe(PAYMENT_SECONDS * 1000);
    await p2p.markFiatSent(trade.id, TAKER);
    expect((await p2p.openDispute({ tradeId: trade.id, openedBy: TAKER, reason: 'TEST' })).status).toBe('open');
  });

  it('a non-instant order pays within the window, and a party dispute opens only after it', async () => {
    const offer = await sellOffer(['sepa', 'slow'], true);
    const trade = await take(offer.id, 'slow');
    expect(trade.settlement).toEqual({ instant: false, windowSeconds: WINDOW });
    const escrowed = await p2p.getTrade(trade.id);
    expect(escrowed.deadlineAt!.getTime() - escrowed.escrowedAt!.getTime()).toBe(WINDOW * 1000);
    expect(escrowed.deadlines.paymentBy).toBe(escrowed.deadlineAt!.toISOString());

    // The operator's later change does not move this order.
    await instruments.registerMethodSchema({
      methodId: 'slow',
      country: 'DE',
      label: 'Slow rail',
      fields: FIELDS,
      settlement: { instant: true },
    });
    expect((await p2p.getTrade(trade.id)).settlement).toEqual({ instant: false, windowSeconds: WINDOW });

    await p2p.markFiatSent(trade.id, TAKER);
    for (const party of [TAKER, MAKER]) {
      const err = await refusal(p2p.openDispute({ tradeId: trade.id, openedBy: party, reason: 'TEST' }));
      expect((err as P2pError).code).toBe('p2p.dispute_before_settlement');
    }
    // Once the window has passed, the dispute opens.
    await sql`
      UPDATE p2p.p2p_trades
         SET deadlines = jsonb_set(deadlines, '{paymentBy}', to_jsonb((now() - interval '1 second')::text))
       WHERE id = ${trade.id}
    `;
    expect((await p2p.openDispute({ tradeId: trade.id, openedBy: TAKER, reason: 'TEST' })).status).toBe('open');
  });

  it('a non-instant method with a blank window keeps the published payment deadline', async () => {
    await instruments.registerMethodSchema({
      methodId: 'slow',
      country: 'DE',
      label: 'Slow rail',
      fields: FIELDS,
      settlement: { instant: false, windowSeconds: null },
    });
    const offer = await sellOffer(['slow'], true);
    const trade = await take(offer.id, 'slow');
    expect(trade.settlement).toEqual({ instant: false, windowSeconds: null });
    const escrowed = await p2p.getTrade(trade.id);
    expect(escrowed.deadlineAt!.getTime() - escrowed.escrowedAt!.getTime()).toBe(PAYMENT_SECONDS * 1000);
  });
});
