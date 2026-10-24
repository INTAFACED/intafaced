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
 * P-trade-orders-03: an ad that still lists a payment method the operator has retired everywhere refuses the take by
 * name with the operator's reason and no end time, before anything is reserved. A method still accepted in some
 * market, or switched back on, is not retired.
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

async function refusal(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

describe('svc-p2p retired payment method (P-trade-orders-03)', () => {
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
        releaseSeconds: 1800,
        disputeSeconds: 604_800,
        escalationRecheckSeconds: 3_600,
      },
    });
    await instruments.registerMethodSchema({ methodId: 'sepa', country: ANY_COUNTRY, label: 'Test rail', fields: FIELDS });
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
      totalAmt: parseAmount('500'),
      methods: ['sepa'],
      terms: 'TEST terms',
    });

  const take = (offerId: string) =>
    p2p.takeOffer({ tradeId: crypto.randomUUID(), offerId, takerId: TAKER, amount: parseAmount('20'), method: 'sepa', tier: 'basic' });

  it('refuses the quote and the take with the reason and no end time, and reserves nothing', async () => {
    const offer = await sellOffer();
    await instruments.setMethodSchemaEnabled('sepa', ANY_COUNTRY, false, 'regulation');
    const journal = ledger.journal().length;

    for (const attempt of [
      p2p.quoteTake({ offerId: offer.id, takerId: TAKER, method: 'sepa', amount: parseAmount('20') }),
      take(offer.id),
    ]) {
      const err = await refusal(attempt);
      expect(err).toBeInstanceOf(P2pError);
      expect(err).toMatchObject({ code: 'p2p.method_delisted', limit: { until: null, reason: 'regulation' } });
    }
    expect(ledger.journal()).toHaveLength(journal);
    expect(await sql`SELECT id FROM p2p.p2p_trades`).toHaveLength(0);
    expect(await sql`SELECT remaining_amt FROM p2p.offers WHERE id = ${offer.id}`).toEqual([{ remaining_amt: '500.000000000000000000' }]);
  });

  it('a retry of a take placed before the retirement is still that take, never relabelled as nothing placed', async () => {
    const offer = await sellOffer();
    const tradeId = crypto.randomUUID();
    const placed = await p2p.takeOffer({
      tradeId,
      offerId: offer.id,
      takerId: TAKER,
      amount: parseAmount('20'),
      method: 'sepa',
      tier: 'basic',
    });
    await instruments.setMethodSchemaEnabled('sepa', ANY_COUNTRY, false, 'regulation');
    const retry = await refusal(
      p2p.takeOffer({ tradeId, offerId: offer.id, takerId: TAKER, amount: parseAmount('20'), method: 'sepa', tier: 'basic' }),
    );
    expect(retry).toMatchObject({ code: 'p2p.trade_exists' });
    expect((await p2p.getTrade(placed.id)).status).toBe('escrowed');
  });

  it('an id the registry would never accept is simply not retired', async () => {
    expect(await instruments.retiredMethod('Bank Transfer')).toBeNull();
    expect(await instruments.retiredMethod('')).toBeNull();
  });

  it('is not retired while another market still accepts it, and the take refuses without naming a retirement', async () => {
    await instruments.registerMethodSchema({ methodId: 'sepa', country: 'FR', label: 'Test rail FR', fields: FIELDS });
    const offer = await sellOffer();
    await instruments.setMethodSchemaEnabled('sepa', ANY_COUNTRY, false, 'low_demand');

    expect(await instruments.retiredMethod('sepa')).toBeNull();
    const err = await refusal(take(offer.id));
    expect((err as P2pError).code).not.toBe('p2p.method_delisted');
  });

  it('switching it back on, or re-registering it enabled, clears the reason; a label-only replace keeps it', async () => {
    await instruments.setMethodSchemaEnabled('sepa', ANY_COUNTRY, false, 'fraud_risk');
    expect(await instruments.retiredMethod('sepa')).toMatchObject({ reason: 'fraud_risk' });

    await instruments.registerMethodSchema({ methodId: 'sepa', country: ANY_COUNTRY, label: 'Renamed rail', fields: FIELDS });
    expect(await instruments.retiredMethod('sepa')).toMatchObject({ reason: 'fraud_risk' });

    await instruments.registerMethodSchema({
      methodId: 'sepa',
      country: ANY_COUNTRY,
      label: 'Renamed rail',
      fields: FIELDS,
      enabled: true,
    });
    expect(await instruments.retiredMethod('sepa')).toBeNull();
    expect(await sql`SELECT delist_reason, delisted_at FROM p2p.payment_method_schemas`).toEqual([
      { delist_reason: null, delisted_at: null },
    ]);

    await instruments.setMethodSchemaEnabled('sepa', ANY_COUNTRY, false, 'provider_withdrawn');
    await instruments.setMethodSchemaEnabled('sepa', ANY_COUNTRY, true);
    expect(await sql`SELECT delist_reason, delisted_at FROM p2p.payment_method_schemas`).toEqual([
      { delist_reason: null, delisted_at: null },
    ]);
  });

  it('a register cannot switch a live method off, which would skip the reason', async () => {
    const err = await refusal(
      instruments.registerMethodSchema({ methodId: 'sepa', country: ANY_COUNTRY, label: 'Test rail', fields: FIELDS, enabled: false }),
    );
    expect(err).toMatchObject({ code: 'p2p.delist_reason_required' });
    expect(await sql`SELECT enabled FROM p2p.payment_method_schemas`).toEqual([{ enabled: true }]);
    // Staging a new method switched off, or re-registering one already retired, is not a retirement.
    await instruments.registerMethodSchema({ methodId: 'sepa', country: 'FR', label: 'Staged', fields: FIELDS, enabled: false });
    await instruments.setMethodSchemaEnabled('sepa', ANY_COUNTRY, false, 'regulation');
    await instruments.registerMethodSchema({ methodId: 'sepa', country: ANY_COUNTRY, label: 'Test rail', fields: FIELDS, enabled: false });
    expect(await instruments.retiredMethod('sepa')).toMatchObject({ reason: 'regulation' });
  });

  it('will not switch a method off without a reason, and the database refuses a reason outside the list', async () => {
    const err = await refusal(instruments.setMethodSchemaEnabled('sepa', ANY_COUNTRY, false));
    expect(err).toBeInstanceOf(InstrumentError);
    expect(err).toMatchObject({ code: 'p2p.delist_reason_required' });
    expect(await sql`SELECT enabled FROM p2p.payment_method_schemas`).toEqual([{ enabled: true }]);

    await expect(sql`UPDATE p2p.payment_method_schemas SET enabled = false, delist_reason = 'whim'`).rejects.toThrow();
  });
});
