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

/**
 * P-ads-merchant-08 (J-p2p-05 #4): an offline maker's ads, or a scheduled one's outside every window, are off the board
 * for others and back in the next window; the to-do list orders the person's open orders by deadline; a bulk action
 * answers per ad, and once per key.
 */

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort();
const migrations = files.map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

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

describe('svc-p2p merchant console (P-ads-merchant-08)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger!: MemoryLedger;
  let instruments!: InstrumentService;
  let p2p!: P2pService;

  const service = () => new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), { instruments, feeBps: 0, deadlines: DEADLINES });

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    instruments = new InstrumentService(sql);
    p2p = service();
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
      totalAmt: parseAmount('100'),
      methods: ['sepa'],
      terms: 'TEST terms',
      idempotencyKey: `create:${crypto.randomUUID()}`,
    });
  const take = (offerId: string) =>
    p2p.takeOffer({
      tradeId: crypto.randomUUID(),
      offerId,
      takerId: TAKER,
      amount: parseAmount('20'),
      method: 'sepa',
      tier: 'basic',
    });
  const board = async () => (await p2p.listOfferBoard({ limit: 50, viewerId: TAKER })).offers.map((offer: { id: string }) => offer.id);

  const iso = (d: Date) => d.toISOString();
  const day = (d: Date) => ((d.getUTCDay() + 6) % 7) + 1; // ISO: 1 Monday … 7 Sunday
  const midnightAfter = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));

  it('an offline maker is off the board for others, still on their own, and back once online; open orders carry on', async () => {
    const offer = await sellOffer();
    const trade = await take(offer.id);
    expect(await board()).toContain(offer.id);
    const off = await p2p.setPresence(MAKER, { mode: 'offline' });
    expect(off).toMatchObject({ mode: 'offline', onBoard: false, nextChangeAt: null });
    expect(await board()).not.toContain(offer.id);
    expect((await p2p.listOffers({ limit: 50 })).map((o) => o.id)).not.toContain(offer.id);
    const own = (await p2p.listOfferBoard({ limit: 50, viewerId: MAKER })).offers.map((o: { id: string }) => o.id);
    expect(own).toContain(offer.id);
    // The order taken before going offline goes on.
    expect((await p2p.markFiatSent(trade.id, TAKER)).status).toBe('fiat_sent');
    await p2p.setPresence(MAKER, { mode: 'online' });
    expect(await board()).toContain(offer.id);
    // No row is online.
    expect(await p2p.presence(OTHER)).toMatchObject({ mode: 'online', onBoard: true, updatedAt: null });
  });

  it('on a schedule, the ads are on the board inside a window and off outside it, with when that changes next', async () => {
    const offer = await sellOffer();
    const now = new Date();
    const today = day(now);
    const tomorrow = (today % 7) + 1;
    const open = await p2p.setPresence(MAKER, {
      mode: 'scheduled',
      timezone: 'UTC',
      windows: [{ day: today, start: '00:00', end: '24:00' }],
    });
    expect(open).toMatchObject({ mode: 'scheduled', timezone: 'UTC', onBoard: true });
    expect(iso(open.nextChangeAt!)).toBe(iso(midnightAfter(now)));
    expect(await board()).toContain(offer.id);
    // Only tomorrow: off now, and back on the board when tomorrow's window opens.
    const closed = await p2p.setPresence(MAKER, {
      mode: 'scheduled',
      timezone: 'UTC',
      windows: [{ day: tomorrow, start: '00:00', end: '24:00' }],
    });
    expect(closed.onBoard).toBe(false);
    expect(iso(closed.nextChangeAt!)).toBe(iso(midnightAfter(now)));
    expect(await board()).not.toContain(offer.id);
    // Back to back windows are one stretch: the change is at the end of tomorrow, not at midnight.
    const both = await p2p.setPresence(MAKER, {
      mode: 'scheduled',
      timezone: 'UTC',
      windows: [
        { day: today, start: '00:00', end: '24:00' },
        { day: tomorrow, start: '00:00', end: '24:00' },
      ],
    });
    expect(both.onBoard).toBe(true);
    expect(iso(both.nextChangeAt!)).toBe(iso(midnightAfter(midnightAfter(now))));
    // In another time zone the window is that zone's day: a window on the zone's today is open.
    const zone = 'Pacific/Kiritimati';
    const zoneToday = ((new Date(now.toLocaleString('en-US', { timeZone: zone })).getDay() + 6) % 7) + 1;
    expect(
      (await p2p.setPresence(MAKER, { mode: 'scheduled', timezone: zone, windows: [{ day: zoneToday, start: '00:00', end: '24:00' }] }))
        .onBoard,
    ).toBe(true);
  });

  it('a schedule that is not a valid week refuses p2p.schedule_invalid and keeps the one before', async () => {
    await p2p.setPresence(MAKER, { mode: 'offline' });
    const bad = [
      { timezone: 'UTC', windows: [] },
      { timezone: 'UTC', windows: [{ day: 8, start: '09:00', end: '10:00' }] },
      { timezone: 'UTC', windows: [{ day: 1, start: '10:00', end: '09:00' }] },
      { timezone: 'UTC', windows: [{ day: 1, start: '9:00', end: '10:00' }] },
      { timezone: 'UTC', windows: [{ day: 1, start: '22:00', end: '24:30' }] },
      {
        timezone: 'UTC',
        windows: [
          { day: 2, start: '09:00', end: '12:00' },
          { day: 2, start: '11:00', end: '13:00' },
        ],
      },
      { timezone: 'Mars/Olympus', windows: [{ day: 1, start: '09:00', end: '10:00' }] },
    ];
    for (const input of bad) {
      expect((await refusal(p2p.setPresence(MAKER, { mode: 'scheduled', ...input }))).code).toBe('p2p.schedule_invalid');
    }
    expect((await p2p.presence(MAKER)).mode).toBe('offline');
  });

  it('the to-do list holds the person’s open orders that wait on someone, soonest deadline first, each with its link', async () => {
    const offer = await sellOffer();
    const first = await take(offer.id);
    const paid = await take(offer.id);
    await p2p.markFiatSent(paid.id, TAKER);
    const third = await take(offer.id);
    // Deadlines: the two waiting for payment end before the paid one's release window.
    const seller = await p2p.todos(MAKER, 50);
    expect(seller.map((t) => [t.tradeId, t.kind, t.role])).toEqual([
      [first.id, 'counterparty_action', 'seller'],
      [third.id, 'counterparty_action', 'seller'],
      [paid.id, 'release_required', 'seller'],
    ]);
    const deadlines = seller.map((t) => t.deadlineAt!.getTime());
    expect([...deadlines].sort((a, b) => a - b)).toEqual(deadlines);
    expect(seller[0]!.link).toBe(`/uc/order?tradeId=${first.id}`);
    const buyer = await p2p.todos(TAKER, 50);
    expect(buyer.map((t) => [t.tradeId, t.kind])).toEqual([
      [first.id, 'payment_required'],
      [third.id, 'payment_required'],
      [paid.id, 'counterparty_action'],
    ]);
    // Someone else's orders are not in it, and the limit holds.
    expect(await p2p.todos(OTHER, 50)).toEqual([]);
    expect(await p2p.todos(MAKER, 1)).toHaveLength(1);
  });

  it('a bulk pause answers per ad: a closed one refuses p2p.offer_closed; the same key again changes nothing', async () => {
    const ads = [];
    for (let i = 0; i < 5; i += 1) ads.push(await sellOffer());
    await p2p.closeOffer(ads[4]!.id, MAKER);
    const key = `bulk:${crypto.randomUUID()}`;
    const ids = ads.map((ad) => ad.id);
    const run = await p2p.bulkOffers({ makerId: MAKER, action: 'pause', offerIds: ids, idempotencyKey: key });
    expect(run.replayed).toBe(false);
    const byId = Object.fromEntries(run.results.map((r) => [r.offerId, r]));
    for (const ad of ads.slice(0, 4)) expect(byId[ad.id]).toEqual({ offerId: ad.id, ok: true, status: 'paused', code: null });
    expect(byId[ads[4]!.id]).toEqual({ offerId: ads[4]!.id, ok: false, status: null, code: 'p2p.offer_closed' });
    // Resume one by hand, then repeat the same request: the stored answer, and the resumed ad stays active.
    await p2p.resumeOffer(ads[0]!.id, MAKER);
    const again = await p2p.bulkOffers({ makerId: MAKER, action: 'pause', offerIds: [...ids].reverse(), idempotencyKey: key });
    expect(again).toEqual({ ...run, replayed: true });
    expect((await p2p.getOffer(ads[0]!.id, MAKER)).status).toBe('active');
    // The same key for another request refuses.
    expect((await refusal(p2p.bulkOffers({ makerId: MAKER, action: 'resume', offerIds: ids, idempotencyKey: key }))).code).toBe(
      'p2p.idempotency_conflict',
    );
    // Another person's ad answers not_a_party; all reaches every paused ad of the caller.
    const all = await p2p.bulkOffers({ makerId: MAKER, action: 'resume', all: true, idempotencyKey: `bulk:${crypto.randomUUID()}` });
    expect(all.results.map((r) => r.offerId).sort()).toEqual(ids.slice(1, 4).sort());
    expect(all.results.every((r) => r.ok && r.status === 'active')).toBe(true);
    const stranger = await p2p.bulkOffers({
      makerId: OTHER,
      action: 'remove',
      offerIds: [ads[1]!.id],
      idempotencyKey: `bulk:${crypto.randomUUID()}`,
    });
    expect(stranger.results).toEqual([{ offerId: ads[1]!.id, ok: false, status: null, code: 'p2p.not_a_party' }]);
    expect((await p2p.getOffer(ads[1]!.id, MAKER)).status).toBe('active');
    expect(
      (await refusal(p2p.bulkOffers({ makerId: MAKER, action: 'pause', offerIds: [], idempotencyKey: `bulk:${crypto.randomUUID()}` })))
        .code,
    ).toBe('p2p.bulk_scope_invalid');
  });
});
