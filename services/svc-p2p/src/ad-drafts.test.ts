import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { EVENT_CATALOG, MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { P2pError, P2pService } from './p2p-service.js';
import { parsePairLimits } from './take-limits.js';

/**
 * J-p2p-05 #1 (P-ads-merchant-06 part 2): a draft is off the board and not takeable; submitted while review is
 * `required` it waits for review (`pending`), still off the board and not takeable, and My Ads lists it under pending;
 * with `none` it is listed; a blank switch refuses and the draft stays a draft.
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
const PAIRS = parsePairLimits('{"USDT/EUR":{"min":"1","max":"100"}}');

async function refusal(p: Promise<unknown>): Promise<P2pError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(P2pError);
  return err as P2pError;
}

describe('svc-p2p drafts and ads waiting for review (J-p2p-05 #1)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger!: MemoryLedger;
  let bus!: MemoryEventBus;
  let instruments!: InstrumentService;

  const service = (adReview: 'required' | 'none' | null) =>
    new P2pService(sql, ledger, bus, {
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
      adReview,
    });

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    bus = new MemoryEventBus('svc-p2p');
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

  const draft = (p2p: P2pService, key = 'draft-key-1') =>
    p2p.createOffer({
      makerId: MAKER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'EUR',
      priceType: 'fixed',
      price: parseAmount('0.9'),
      minAmt: parseAmount('10'),
      maxAmt: parseAmount('20'),
      totalAmt: parseAmount('100'),
      methods: ['sepa'],
      terms: 'TEST terms',
      idempotencyKey: key,
      initialStatus: 'draft',
    });

  const onBoard = async (p2p: P2pService, id: string) =>
    (await p2p.listOfferBoard({ asset: ASSET, fiatCurrency: 'EUR', side: 'sell', limit: 50 })).offers.some((o) => o.id === id);
  const take = (p2p: P2pService, offerId: string) =>
    p2p.takeOffer({ tradeId: crypto.randomUUID(), offerId, takerId: TAKER, amount: parseAmount('15'), method: 'sepa', tier: 'basic' });
  const announced = () => bus.published.filter((e) => e.subject === EVENT_CATALOG.p2pOfferCreated.subject);

  it('a draft is off the board, not takeable, not announced, and a retry with its key is the same draft', async () => {
    const p2p = service('required');
    const d = await draft(p2p);
    expect(d.status).toBe('draft');
    expect((await draft(p2p)).id).toBe(d.id);
    expect(await onBoard(p2p, d.id)).toBe(false);
    expect((await refusal(take(p2p, d.id))).code).toBe('p2p.offer_not_active');
    expect(announced()).toHaveLength(0);
    expect((await p2p.listOwnOffers(MAKER, 'draft', 50)).map((o) => o.id)).toEqual([d.id]);
  });

  it('submitted while review is required, it waits for review: pending, off the board, not takeable, listed under pending', async () => {
    const p2p = service('required');
    const d = await draft(p2p);
    const pending = await p2p.submitForListing(d.id, MAKER);
    expect(pending.status).toBe('pending');
    expect(pending.statusSince.getTime()).toBeGreaterThanOrEqual(d.statusSince.getTime());
    expect(await onBoard(p2p, d.id)).toBe(false);
    expect((await refusal(take(p2p, d.id))).code).toBe('p2p.offer_not_active');
    expect(announced()).toHaveLength(0);
    expect((await p2p.listOwnOffers(MAKER, 'pending', 50)).map((o) => o.id)).toEqual([d.id]);
    // A second submit returns it as it is; it cannot be paused or resumed past review.
    expect((await p2p.submitForListing(d.id, MAKER)).status).toBe('pending');
    expect((await refusal(p2p.submitForListing(d.id, OTHER))).code).toBe('p2p.not_a_party');
  });

  it('submitting re-runs the post checks: with trading off it refuses and the draft stays a draft', async () => {
    const p2p = service('none');
    const d = await draft(p2p, 'draft-key-4');
    p2p.setTradingEnabled(false);
    expect((await refusal(p2p.submitForListing(d.id, MAKER))).code).toBe('p2p.trading_disabled');
    expect((await p2p.listOwnOffers(MAKER, 'draft', 50)).map((o) => o.id)).toEqual([d.id]);
    expect(announced()).toHaveLength(0);
  });

  it('a draft or an ad waiting for review, once closed, is never relisted past review', async () => {
    const p2p = service('required');
    const d = await draft(p2p, 'draft-key-5');
    await p2p.closeOffer(d.id, MAKER);
    expect((await refusal(p2p.relistOffer({ offerId: d.id, makerId: MAKER }))).code).toBe('p2p.offer_never_listed');
    const waiting = await draft(p2p, 'draft-key-6');
    await p2p.submitForListing(waiting.id, MAKER);
    await p2p.closeOffer(waiting.id, MAKER);
    expect((await refusal(p2p.relistOffer({ offerId: waiting.id, makerId: MAKER }))).code).toBe('p2p.offer_never_listed');
    expect(await onBoard(p2p, waiting.id)).toBe(false);
    expect(announced()).toHaveLength(0);
  });

  it('with review none a submitted draft is listed and announced once; a blank switch refuses and the draft stays', async () => {
    const blank = await refusal(service(null).submitForListing((await draft(service(null), 'draft-key-2')).id, MAKER));
    expect(blank.code).toBe('p2p.config_unset');
    expect((await service(null).listOwnOffers(MAKER, 'draft', 50)).length).toBe(1);

    const p2p = service('none');
    const d = await draft(p2p, 'draft-key-3');
    const listed = await p2p.submitForListing(d.id, MAKER);
    expect(listed.status).toBe('active');
    expect(await onBoard(p2p, d.id)).toBe(true);
    await p2p.submitForListing(d.id, MAKER);
    expect(announced().filter((e) => (e.payload as { offerId: string }).offerId === d.id)).toHaveLength(1);
  });
});
