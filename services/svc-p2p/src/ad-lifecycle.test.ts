import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { P2pError, P2pService, relistedOfferId } from './p2p-service.js';

/**
 * P-ads-merchant-06 (J-p2p-05 #1, #2): My Ads lists closed ads with why; closing an ad with an open order refuses with
 * how many and leaves the order alone; a closed ad is relisted as a new ad through the checks a new ad passes; ad edits
 * are capped per person per UTC day with the reset time; an ad left under one order's minimum with nothing open closes
 * as sold out, once.
 */

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort();
const migrations = files.map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));
const LIFECYCLE = '20261030125739_p2p_ad_lifecycle.sql';

const MAKER = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ASSET = 'USDT';
const FIELDS = [{ key: 'account_reference', label: 'Account reference', required: true }];
const DEADLINES = {
  escrowSeconds: 120,
  paymentSeconds: 900,
  releaseSeconds: 1800,
  disputeSeconds: 604_800,
  escalationRecheckSeconds: 3_600,
};

async function refusal(p: Promise<unknown>): Promise<P2pError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(P2pError);
  return err as P2pError;
}

describe('svc-p2p ad lifecycle (P-ads-merchant-06)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger!: MemoryLedger;
  let instruments!: InstrumentService;
  let p2p!: P2pService;

  const service = (offerEditsPerDay?: number | null) =>
    new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), {
      instruments,
      feeBps: 0,
      deadlines: DEADLINES,
      ...(offerEditsPerDay === undefined ? {} : { offerEditsPerDay }),
    });

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    instruments = new InstrumentService(sql);
    p2p = service(3);
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

  const sellOffer = (total = '100', min = '10', max = '50') =>
    p2p.createOffer({
      makerId: MAKER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'EUR',
      priceType: 'fixed',
      price: parseAmount('0.92'),
      minAmt: parseAmount(min),
      maxAmt: parseAmount(max),
      totalAmt: parseAmount(total),
      methods: ['sepa'],
      terms: 'TEST terms',
      idempotencyKey: `create:${crypto.randomUUID()}`,
    });

  const take = (offerId: string, amount = '20') =>
    p2p.takeOffer({ tradeId: crypto.randomUUID(), offerId, takerId: TAKER, amount: parseAmount(amount), method: 'sepa', tier: 'basic' });

  const edit = (offerId: string, key: string, price = '0.93', makerId = MAKER) =>
    p2p.updateOffer({ offerId, makerId, idempotencyKey: key, price: parseAmount(price) });

  it('closing an ad with an open order refuses with how many and which, and the order is untouched', async () => {
    const offer = await sellOffer();
    const first = await take(offer.id);
    const second = await take(offer.id);

    const err = await refusal(p2p.closeOffer(offer.id, MAKER));
    expect(err.code).toBe('p2p.offer_has_open_trades');
    expect(err.message).toContain('2 open orders');
    expect(err.limit).toMatchObject({ until: null, openTrades: '2' });
    expect([...(err.limit?.openTradeIds ?? [])].sort()).toEqual([first.id, second.id].sort());
    expect((await p2p.getOffer(offer.id, MAKER)).status).toBe('active');
    expect((await p2p.getTrade(first.id)).status).toBe('escrowed');

    // Once the orders finish, it closes, by the maker, and says so.
    await p2p.cancelTrade(first.id, TAKER);
    await p2p.cancelTrade(second.id, TAKER);
    const closed = await p2p.closeOffer(offer.id, MAKER);
    expect(closed).toMatchObject({ status: 'closed', closeReason: 'by_you' });
    expect(closed.statusSince.getTime()).toBeGreaterThanOrEqual(offer.statusSince.getTime());
    expect(await p2p.listOwnOffers(MAKER, 'closed', 50)).toEqual([expect.objectContaining({ id: offer.id, closeReason: 'by_you' })]);
  });

  it('only the maker closes an ad, and closing twice is the same close', async () => {
    const offer = await sellOffer();
    expect((await refusal(p2p.closeOffer(offer.id, OTHER))).code).toBe('p2p.not_a_party');
    const closed = await p2p.closeOffer(offer.id, MAKER);
    const again = await p2p.closeOffer(offer.id, MAKER);
    expect(again).toMatchObject({ status: 'closed', closeReason: 'by_you' });
    expect(again.statusSince).toEqual(closed.statusSince);
  });

  it('relists a closed ad as a new active ad with a fresh create time that names it, once', async () => {
    const offer = await sellOffer();
    await p2p.closeOffer(offer.id, MAKER);
    const relisted = await p2p.relistOffer({ offerId: offer.id, makerId: MAKER });
    expect(relisted).toMatchObject({
      id: relistedOfferId(offer.id),
      status: 'active',
      relistedFrom: offer.id,
      price: offer.price,
      minAmt: offer.minAmt,
      maxAmt: offer.maxAmt,
      totalAmt: offer.totalAmt,
      remainingAmt: offer.totalAmt,
    });
    expect(relisted.id).not.toBe(offer.id);
    expect(relisted.createdAt.getTime()).toBeGreaterThan(offer.createdAt.getTime());
    // The closed ad stays closed with its reason; asking again, even after the new ad is closed, is the same new ad.
    expect(await p2p.getOffer(offer.id, MAKER)).toMatchObject({ status: 'closed', closeReason: 'by_you' });
    await p2p.closeOffer(relisted.id, MAKER);
    expect((await p2p.relistOffer({ offerId: offer.id, makerId: MAKER })).id).toBe(relisted.id);
    expect(await sql`SELECT id FROM p2p.offers WHERE relisted_from = ${offer.id}`).toHaveLength(1);
  });

  it('two relists of one closed ad at once post one ad', async () => {
    const offer = await sellOffer();
    await p2p.closeOffer(offer.id, MAKER);
    const both = await Promise.allSettled([
      p2p.relistOffer({ offerId: offer.id, makerId: MAKER }),
      p2p.relistOffer({ offerId: offer.id, makerId: MAKER }),
    ]);
    const posted = both.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id);
    expect(new Set(posted)).toEqual(new Set([relistedOfferId(offer.id)]));
    expect(await sql`SELECT id FROM p2p.offers WHERE relisted_from = ${offer.id}`).toHaveLength(1);
  });

  it('an ad someone else posted under the derived id does not block the relist', async () => {
    const offer = await sellOffer();
    await p2p.closeOffer(offer.id, MAKER);
    await ledger.post(
      recipes.deposit({ userId: OTHER, assetId: ASSET, amount: parseAmount('100'), rail: 'test', railRef: `${OTHER}:fund` }),
    );
    await p2p.createOffer({
      makerId: OTHER,
      side: 'buy',
      asset: ASSET,
      fiatCurrency: 'EUR',
      priceType: 'fixed',
      price: parseAmount('0.9'),
      minAmt: parseAmount('10'),
      maxAmt: parseAmount('20'),
      totalAmt: parseAmount('20'),
      methods: ['sepa'],
      offerId: relistedOfferId(offer.id),
      idempotencyKey: 'squat-key-1',
    });
    const relisted = await p2p.relistOffer({ offerId: offer.id, makerId: MAKER });
    expect(relisted).toMatchObject({ makerId: MAKER, status: 'active', relistedFrom: offer.id });
    expect(relisted.id).not.toBe(relistedOfferId(offer.id));
    expect((await p2p.relistOffer({ offerId: offer.id, makerId: MAKER })).id).toBe(relisted.id);
  });

  it('relisting runs the checks a new ad does: the free balance must still cover it', async () => {
    const offer = await sellOffer('400', '10', '50');
    await p2p.closeOffer(offer.id, MAKER);
    // The maker moves most of the balance out meanwhile; the new sell ad would offer more than is free.
    const strict = new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), {
      instruments,
      feeBps: 0,
      deadlines: DEADLINES,
      sellBalanceAtPost: true,
    });
    await ledger.post(
      recipes.withdrawHold({ userId: MAKER, assetId: ASSET, amount: parseAmount('300'), rail: 'test', withdrawalId: 'w-1' }),
    );
    const err = await refusal(strict.relistOffer({ offerId: offer.id, makerId: MAKER }));
    expect(err.code).toBe('p2p.insufficient_balance');
    expect(await sql`SELECT id FROM p2p.offers WHERE relisted_from = ${offer.id}`).toHaveLength(0);
  });

  it('refuses to relist an ad that is not closed, or someone else’s', async () => {
    const offer = await sellOffer();
    expect((await refusal(p2p.relistOffer({ offerId: offer.id, makerId: MAKER }))).code).toBe('p2p.offer_not_active');
    await p2p.closeOffer(offer.id, MAKER);
    expect((await refusal(p2p.relistOffer({ offerId: offer.id, makerId: OTHER }))).code).toBe('p2p.not_a_party');
  });

  it('caps edits per person per UTC day with the reset time; a retried edit counts once; a refused edit counts nothing', async () => {
    const offer = await sellOffer();
    const before = await p2p.offerEditQuota(MAKER);
    expect(before).toMatchObject({ limit: 3, used: 0, remaining: 3 });
    const midnight = new Date();
    midnight.setUTCHours(24, 0, 0, 0);
    expect(before.resetsAt.toISOString()).toBe(midnight.toISOString());

    await edit(offer.id, 'edit-key-1');
    await edit(offer.id, 'edit-key-1'); // the same edit again
    // An edit the service refuses (min above max) is rolled back with its count.
    await expect(
      p2p.updateOffer({ offerId: offer.id, makerId: MAKER, idempotencyKey: 'edit-key-x', minAmt: parseAmount('60') }),
    ).rejects.toThrow();
    await edit(offer.id, 'edit-key-2', '0.94');
    await edit(offer.id, 'edit-key-3', '0.95');
    expect(await p2p.offerEditQuota(MAKER)).toMatchObject({ used: 3, remaining: 0 });

    const err = await refusal(edit(offer.id, 'edit-key-4', '0.96'));
    expect(err.code).toBe('p2p.edit_quota_reached');
    expect(err.limit).toEqual({ until: midnight.toISOString(), cap: '3', remaining: '0' });
    expect((await p2p.getOffer(offer.id, MAKER)).price).toBe(parseAmount('0.95'));
  });

  it('a blank edit cap refuses every edit and the quota read with config_unset; a service built without one has no cap', async () => {
    const blank = service(null);
    const offer = await sellOffer();
    expect((await refusal(blank.offerEditQuota(MAKER))).code).toBe('p2p.config_unset');
    expect(
      (await refusal(blank.updateOffer({ offerId: offer.id, makerId: MAKER, idempotencyKey: 'edit-key-1', price: parseAmount('0.93') })))
        .code,
    ).toBe('p2p.config_unset');
    const uncapped = service();
    for (const n of [1, 2, 3, 4, 5])
      await uncapped.updateOffer({ offerId: offer.id, makerId: MAKER, idempotencyKey: `edit-key-${n}`, price: parseAmount('0.93') });
  });

  it('the release that leaves an ad under its minimum with no order open closes it as sold out, once', async () => {
    const offer = await sellOffer('45', '10', '20');
    const a = await take(offer.id, '20');
    const b = await take(offer.id, '20');
    // 5 left, under the 10 minimum: the first release leaves one order open, so the ad stays.
    await p2p.markFiatSent(a.id, TAKER);
    await p2p.confirmFiatReceived(a.id, MAKER);
    expect((await p2p.getOffer(offer.id, MAKER)).status).toBe('active');
    await p2p.markFiatSent(b.id, TAKER);
    await p2p.confirmFiatReceived(b.id, MAKER);
    const sold = await p2p.getOffer(offer.id, MAKER);
    expect(sold).toMatchObject({ status: 'closed', closeReason: 'sold_out' });
    // Closing it by hand afterwards keeps the reason it closed for.
    expect(await p2p.closeOffer(offer.id, MAKER)).toMatchObject({ status: 'closed', closeReason: 'sold_out' });
  });

  it('a refund that leaves the ad under a minimum raised meanwhile closes it as sold out', async () => {
    const offer = await sellOffer('25', '10', '20');
    // 10 sold for real: 15 left.
    const sold = await take(offer.id, '10');
    await p2p.markFiatSent(sold.id, TAKER);
    await p2p.confirmFiatReceived(sold.id, MAKER);
    // Another 10 taken (5 left), and the maker raises the minimum to 20 while it is open: the edit cannot close it.
    const open = await take(offer.id, '10');
    await p2p.updateOffer({ offerId: offer.id, makerId: MAKER, idempotencyKey: 'edit-key-min', minAmt: parseAmount('20') });
    expect((await p2p.getOffer(offer.id, MAKER)).status).toBe('active');
    // The refund brings 15 back, under the new minimum, with nothing open: it closes as sold out.
    await p2p.cancelTrade(open.id, TAKER);
    expect(await p2p.getOffer(offer.id, MAKER)).toMatchObject({ status: 'closed', closeReason: 'sold_out' });
  });

  it('editing a closed ad says it is closed, even when the day’s edits are spent', async () => {
    const offer = await sellOffer();
    for (const n of [1, 2, 3]) await edit(offer.id, `edit-key-${n}`, `0.9${n}`);
    await p2p.closeOffer(offer.id, MAKER);
    expect((await refusal(edit(offer.id, 'edit-key-4', '0.99'))).code).toBe('p2p.offer_not_active');
    expect((await refusal(edit(offer.id, 'edit-key-5', '0.99', OTHER))).code).toBe('p2p.not_a_party');
  });

  it('a cancelled order gives the amount back, so the ad does not close', async () => {
    const offer = await sellOffer('25', '10', '20');
    const a = await take(offer.id, '20');
    await p2p.cancelTrade(a.id, TAKER);
    expect((await p2p.getOffer(offer.id, MAKER)).status).toBe('active');
  });

  it('an erase can still delete a never-traded ad that was edited and relisted: its edits go, the new ad forgets it', async () => {
    const offer = await sellOffer();
    await edit(offer.id, 'edit-key-1');
    await p2p.closeOffer(offer.id, MAKER);
    const relisted = await p2p.relistOffer({ offerId: offer.id, makerId: MAKER });
    await sql`DELETE FROM p2p.offers WHERE id = ${offer.id}`;
    expect(await sql`SELECT 1 FROM p2p.offer_edits WHERE offer_id = ${offer.id}`).toHaveLength(0);
    expect((await p2p.getOffer(relisted.id, MAKER)).relistedFrom).toBeNull();
  });

  it('the migration keeps every old row’s status, starts status_since from its last update and leaves reasons blank', async () => {
    const at = files.indexOf(LIFECYCLE);
    expect(at).toBeGreaterThan(0);
    const before = migrations.slice(0, at);
    const old = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations: before });
    try {
      const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      for (const [i, status] of (['active', 'paused', 'closed'] as const).entries()) {
        await old.sql`
          INSERT INTO p2p.offers (id, maker_id, side, asset, fiat_currency, price_type, price, min_amt, max_amt,
                                  total_amt, remaining_amt, methods, terms, status, updated_at)
          VALUES (${ids[i]!}, ${MAKER}, 'sell', ${ASSET}, 'EUR', 'fixed', 1, 1, 2, 2, 2, '["sepa"]'::jsonb, '', ${status},
                  '2026-10-01T00:00:00Z')
        `;
      }
      await old.sql.unsafe(migrations[at]!);
      const rows = await old.sql<Array<{ status: string; close_reason: string | null; status_since: Date; relisted_from: string | null }>>`
        SELECT status, close_reason, status_since, relisted_from FROM p2p.offers ORDER BY status
      `;
      expect(rows.map((r) => [r.status, r.close_reason, r.status_since.toISOString(), r.relisted_from])).toEqual([
        ['active', null, '2026-10-01T00:00:00.000Z', null],
        ['paused', null, '2026-10-01T00:00:00.000Z', null],
        ['closed', null, '2026-10-01T00:00:00.000Z', null],
      ]);
      // A reason on an ad that is not closed is refused by the table itself.
      await expect(old.sql`UPDATE p2p.offers SET close_reason = 'by_you' WHERE status = 'active'`).rejects.toThrow(
        /offers_close_reason_ck/,
      );
    } finally {
      await old.drop();
    }
  });
});
