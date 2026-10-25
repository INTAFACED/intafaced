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
 * P-ads-merchant-19: cash-in-person rules and payment-note rules carried on the method row. Rules make a method cash in
 * person: its price is locked, so a floating ad cannot list it (at post, on an edit, and at take when the operator made
 * it cash later), and an order paid with it takes the row's release window, copied at take.
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
const RELEASE_SECONDS = 1800;
const NOTES = { guidance: 'Write only the order number.', forbidden: ['USDT', 'crypto'] };
const CASH = { meetingGuidance: 'Meet in a busy public place.', proof: 'Count the notes together.', releaseWindowSeconds: 600 };

async function refusal(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

describe('svc-p2p method rules: cash in person and payment notes (P-ads-merchant-19)', () => {
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
        paymentSeconds: 900,
        releaseSeconds: RELEASE_SECONDS,
        disputeSeconds: 604_800,
        escalationRecheckSeconds: 3_600,
      },
      referencePrices: { price: async (asset, fiat) => (asset === ASSET && fiat === 'EUR' ? parseAmount('0.92') : null) },
    });
    await instruments.registerMethodSchema({
      methodId: 'sepa',
      country: ANY_COUNTRY,
      label: 'Bank transfer',
      fields: FIELDS,
      noteRules: NOTES,
    });
    await instruments.registerMethodSchema({ methodId: 'cash', country: 'DE', label: 'Cash in person', fields: FIELDS, cashRules: CASH });
    for (const methodId of ['sepa', 'cash']) {
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

  const sellOffer = (methods: string[], priceType: 'fixed' | 'float' = 'fixed') =>
    p2p.createOffer({
      makerId: MAKER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'EUR',
      priceType,
      price: parseAmount(priceType === 'fixed' ? '0.92' : '1.01'),
      minAmt: parseAmount('10'),
      maxAmt: parseAmount('50'),
      totalAmt: parseAmount('500'),
      methods,
      terms: 'TEST terms',
    });

  const take = (offerId: string, method: string) =>
    p2p.takeOffer({ tradeId: crypto.randomUUID(), offerId, takerId: TAKER, amount: parseAmount('20'), method, tier: 'basic' });

  const schema = async (methodId: string, country: string) =>
    (await instruments.listMethodSchemas({ methodId, includeDisabled: true, limit: 10 })).find((row) => row.country === country)!;

  it('stores the rules on the row, keeps them on a replace that omits them, and clears them with null', async () => {
    expect(await schema('sepa', ANY_COUNTRY)).toMatchObject({ kind: 'transfer', noteRules: NOTES, cashRules: null });
    expect(await schema('cash', 'DE')).toMatchObject({ kind: 'cash_in_person', noteRules: null, cashRules: CASH });

    const replaced = await instruments.registerMethodSchema({ methodId: 'cash', country: 'DE', label: 'Cash v2', fields: FIELDS });
    expect(replaced).toMatchObject({ label: 'Cash v2', kind: 'cash_in_person', cashRules: CASH });

    const cleared = await instruments.registerMethodSchema({
      methodId: 'sepa',
      country: ANY_COUNTRY,
      label: 'Bank transfer',
      fields: FIELDS,
      noteRules: null,
    });
    expect(cleared.noteRules).toBeNull();
    const transfer = await instruments.registerMethodSchema({
      methodId: 'cash',
      country: 'DE',
      label: 'Cash',
      fields: FIELDS,
      cashRules: null,
    });
    expect(transfer).toMatchObject({ kind: 'transfer', cashRules: null });
  });

  it('trims the texts, drops repeated words, and refuses rules out of bounds before anything is stored', async () => {
    const trimmed = await instruments.registerMethodSchema({
      methodId: 'sepa',
      country: 'FR',
      label: 'Bank transfer',
      fields: FIELDS,
      noteRules: { guidance: '  Order number only.  ', forbidden: [' USDT ', 'USDT'] },
    });
    expect(trimmed.noteRules).toEqual({ guidance: 'Order number only.', forbidden: ['USDT'] });

    const bad = [
      { noteRules: { guidance: ' ', forbidden: [] } },
      { noteRules: { guidance: 'x'.repeat(501), forbidden: [] } },
      { noteRules: { guidance: 'ok', forbidden: Array.from({ length: 21 }, (_, i) => `w${i}`) } },
      { noteRules: { guidance: 'ok', forbidden: [''] } },
      { cashRules: { ...CASH, meetingGuidance: '' } },
      { cashRules: { ...CASH, proof: 'x'.repeat(1001) } },
      { cashRules: { ...CASH, releaseWindowSeconds: 299 } },
      { cashRules: { ...CASH, releaseWindowSeconds: 86_401 } },
      { cashRules: { ...CASH, releaseWindowSeconds: 600.5 } },
    ];
    for (const rules of bad) {
      const err = await refusal(
        instruments.registerMethodSchema({ methodId: 'new', country: 'DE', label: 'New', fields: FIELDS, ...rules }),
      );
      expect(err).toBeInstanceOf(InstrumentError);
      expect((err as InstrumentError).code).toBe('p2p.instrument_schema_invalid');
    }
    expect(await sql`SELECT 1 FROM p2p.payment_method_schemas WHERE method_id = 'new'`).toHaveLength(0);
  });

  it('refuses a floating ad that lists a cash method, and posts it at a fixed price or without the cash method', async () => {
    const err = await refusal(sellOffer(['sepa', 'cash'], 'float'));
    expect(err).toBeInstanceOf(P2pError);
    expect((err as P2pError).code).toBe('p2p.floating_not_allowed_for_method');
    expect(err.message).toContain('cash');
    expect(await sql`SELECT 1 FROM p2p.offers`).toHaveLength(0);
    expect((await sellOffer(['sepa', 'cash'])).priceType).toBe('fixed');
    expect((await sellOffer(['sepa'], 'float')).priceType).toBe('float');
  });

  it('refuses an edit that adds a cash method to a floating ad', async () => {
    const offer = await sellOffer(['sepa'], 'float');
    const err = await refusal(
      p2p.updateOffer({ offerId: offer.id, makerId: MAKER, idempotencyKey: 'edit:cash:1', methods: ['sepa', 'cash'] }),
    );
    expect((err as P2pError).code).toBe('p2p.floating_not_allowed_for_method');
    expect((await p2p.getOffer(offer.id, MAKER)).methods).toEqual(['sepa']);
  });

  it('refuses the take of a floating ad on a method the operator made cash after the post, reserving nothing', async () => {
    const offer = await sellOffer(['sepa'], 'float');
    await instruments.registerMethodSchema({ methodId: 'sepa', country: 'FR', label: 'Cash in FR', fields: FIELDS, cashRules: CASH });
    const journal = ledger.journal().length;
    const err = await refusal(take(offer.id, 'sepa'));
    expect((err as P2pError).code).toBe('p2p.floating_not_allowed_for_method');
    expect(ledger.journal().length).toBe(journal);
    expect(await sql`SELECT 1 FROM p2p.p2p_trades`).toHaveLength(0);
    const [row] = await sql<{ remaining_amt: string }[]>`SELECT remaining_amt::text FROM p2p.offers WHERE id = ${offer.id}`;
    expect(parseAmount(row!.remaining_amt)).toBe(parseAmount('500'));
  });

  it('refuses to resume a paused floating ad whose method the operator made cash during the pause', async () => {
    const offer = await sellOffer(['sepa'], 'float');
    await p2p.pauseOffer(offer.id, MAKER);
    await instruments.registerMethodSchema({ methodId: 'sepa', country: 'FR', label: 'Cash in FR', fields: FIELDS, cashRules: CASH });
    const err = await refusal(p2p.resumeOffer(offer.id, MAKER));
    expect((err as P2pError).code).toBe('p2p.floating_not_allowed_for_method');
    const [row] = await sql<{ status: string }[]>`SELECT status FROM p2p.offers WHERE id = ${offer.id}`;
    expect(row!.status).toBe('paused');
  });

  it('the database refuses a cash release window that is not a whole number of seconds in bounds, or not a number', async () => {
    for (const window of ['600.5', '299', '86401', '"600"']) {
      await expect(
        sql.unsafe(
          `UPDATE p2p.payment_method_schemas SET cash_rules = '{"meetingGuidance":"m","proof":"p","releaseWindowSeconds":${window}}'::jsonb WHERE method_id = 'cash'`,
        ),
      ).rejects.toThrow(/payment_method_schemas_cash_rules_ck/);
    }
  });

  it('lists a stored row whose rules are past today’s bounds instead of refusing the whole catalogue', async () => {
    const words = JSON.stringify(Array.from({ length: 25 }, (_, i) => `w${i}`));
    await sql.unsafe(
      `UPDATE p2p.payment_method_schemas SET note_rules = '{"guidance":"Old rule","forbidden":${words}}'::jsonb WHERE method_id = 'sepa'`,
    );
    const listed = await instruments.listMethodSchemas({ country: 'DE', limit: 10 });
    expect(listed.find((row) => row.methodId === 'sepa')?.noteRules?.forbidden).toHaveLength(25);
  });

  it('an order paid in cash in person takes the row’s release window, copied at take', async () => {
    const offer = await sellOffer(['sepa', 'cash']);
    const trade = await take(offer.id, 'cash');
    expect(trade.cashReleaseSeconds).toBe(CASH.releaseWindowSeconds);
    // The operator changes the window later: the order keeps the one it was taken under.
    await instruments.registerMethodSchema({
      methodId: 'cash',
      country: 'DE',
      label: 'Cash',
      fields: FIELDS,
      cashRules: { ...CASH, releaseWindowSeconds: 3600 },
    });
    const marked = await p2p.markFiatSent(trade.id, TAKER);
    expect(marked.deadlineAt!.getTime() - marked.fiatSentAt!.getTime()).toBe(CASH.releaseWindowSeconds * 1000);
  });

  it('an order paid by transfer keeps the published release deadline', async () => {
    const offer = await sellOffer(['sepa', 'cash']);
    const trade = await take(offer.id, 'sepa');
    expect(trade.cashReleaseSeconds).toBeNull();
    const marked = await p2p.markFiatSent(trade.id, TAKER);
    expect(marked.deadlineAt!.getTime() - marked.fiatSentAt!.getTime()).toBe(RELEASE_SECONDS * 1000);
  });
});
