import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { P2pError, P2pService, shareTokenHash } from './p2p-service.js';

/**
 * P-ads-merchant-07 (J-p2p-05 #3): a private ad is off the board and reachable only by its maker or a live share link;
 * a link ends at its time or at once when revoked; an order taken through a link is marked shared, for good; tokens are
 * stored hashed and links are their maker's alone.
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

describe('svc-p2p private ads and share links (P-ads-merchant-07)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger!: MemoryLedger;
  let instruments!: InstrumentService;
  let p2p!: P2pService;

  const service = (shareLinkMaxSeconds: number | null) =>
    new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), { instruments, feeBps: 0, deadlines: DEADLINES, shareLinkMaxSeconds });

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    instruments = new InstrumentService(sql);
    p2p = service(3600);
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
  const privateOffer = async () => {
    const offer = await sellOffer();
    return p2p.setOfferVisibility(offer.id, MAKER, 'private');
  };
  const link = (offerId: string, seconds?: number) =>
    p2p.createShareLink({ linkId: crypto.randomUUID(), offerId, makerId: MAKER, ...(seconds === undefined ? {} : { seconds }) });
  const take = (offerId: string, shareToken?: string) =>
    p2p.takeOffer({
      tradeId: crypto.randomUUID(),
      offerId,
      takerId: TAKER,
      amount: parseAmount('20'),
      method: 'sepa',
      tier: 'basic',
      ...(shareToken ? { shareToken } : {}),
    });
  const board = async () => (await p2p.listOfferBoard({ limit: 50, viewerId: TAKER })).offers.map((offer: { id: string }) => offer.id);

  it('a private ad is off the board and closed to others, open to its maker and through a live link', async () => {
    const offer = await privateOffer();
    expect(offer.visibility).toBe('private');
    expect(await board()).not.toContain(offer.id);
    expect((await p2p.listOffers({ limit: 50 })).map((o) => o.id)).not.toContain(offer.id);
    expect((await p2p.getOffer(offer.id, MAKER)).id).toBe(offer.id);
    expect((await refusal(p2p.getOffer(offer.id, TAKER))).code).toBe('p2p.offer_private');
    const { token } = await link(offer.id);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((await p2p.getOffer(offer.id, TAKER, token)).id).toBe(offer.id);
    // Public again: back on the board.
    await p2p.setOfferVisibility(offer.id, MAKER, 'public');
    expect(await board()).toContain(offer.id);
  });

  it('a take or quote of a private ad without a link refuses before anything is reserved; through one it is marked shared', async () => {
    const offer = await privateOffer();
    const journal = ledger.journal().length;
    expect((await refusal(take(offer.id))).code).toBe('p2p.offer_private');
    expect((await refusal(p2p.quoteTake({ offerId: offer.id, takerId: TAKER, method: 'sepa', amount: parseAmount('20') }))).code).toBe(
      'p2p.offer_private',
    );
    expect(ledger.journal()).toHaveLength(journal);
    expect(await sql`SELECT id FROM p2p.p2p_trades`).toHaveLength(0);

    const { token } = await link(offer.id);
    const quoted = await p2p.quoteTake({ offerId: offer.id, takerId: TAKER, method: 'sepa', amount: parseAmount('20'), shareToken: token });
    expect(quoted.amount).toBe(parseAmount('20'));
    const trade = await take(offer.id, token);
    expect(trade.sharedFrom).toBe(true);
    expect((await p2p.getTrade(trade.id)).sharedFrom).toBe(true);
    // Written once: the table refuses a change.
    await expect(sql`UPDATE p2p.p2p_trades SET shared_from = false WHERE id = ${trade.id}`).rejects.toThrow(/written once at take/);
  });

  it('a public ad taken through a live link is marked shared; from the board, or with a dead or foreign token, it is not', async () => {
    const offer = await sellOffer();
    expect((await take(offer.id)).sharedFrom).toBe(false);
    const live = await link(offer.id);
    expect((await take(offer.id, live.token)).sharedFrom).toBe(true);
    // A token for another ad, or a withdrawn one, does not stand in the way of a public ad: it is a plain take.
    const other = await sellOffer();
    expect((await take(other.id, live.token)).sharedFrom).toBe(false);
    await p2p.revokeShareLink(live.id, MAKER);
    expect((await take(offer.id, live.token)).sharedFrom).toBe(false);
    // Nor of the maker's own read of a private ad.
    const mine = await p2p.setOfferVisibility(offer.id, MAKER, 'private');
    expect((await p2p.getOffer(mine.id, MAKER, live.token)).id).toBe(offer.id);
    // On a private ad a foreign token says private, nothing more.
    expect((await refusal(take(offer.id, (await link(other.id)).token))).code).toBe('p2p.offer_private');
  });

  it('a link refuses once its time ends, and at once when revoked; revoking twice is one revoke', async () => {
    const offer = await privateOffer();
    const short = await link(offer.id, 1);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect((await refusal(p2p.getOffer(offer.id, TAKER, short.token))).code).toBe('p2p.share_link_expired');
    expect((await refusal(take(offer.id, short.token))).code).toBe('p2p.share_link_expired');

    const live = await link(offer.id);
    expect((await p2p.getOffer(offer.id, TAKER, live.token)).id).toBe(offer.id);
    const revoked = await p2p.revokeShareLink(live.id, MAKER);
    expect(revoked.revokedAt).toBeInstanceOf(Date);
    expect((await refusal(p2p.getOffer(offer.id, TAKER, live.token))).code).toBe('p2p.share_link_revoked');
    expect((await refusal(take(offer.id, live.token))).code).toBe('p2p.share_link_revoked');
    expect((await p2p.revokeShareLink(live.id, MAKER)).revokedAt).toEqual(revoked.revokedAt);
  });

  it('links are their maker’s alone, are stored hashed, and never live longer than the owner allows', async () => {
    const offer = await sellOffer();
    const made = await link(offer.id, 10_000_000);
    expect(made.expiresAt.getTime() - made.createdAt.getTime()).toBeLessThanOrEqual(3_600_000);
    const [row] = await sql<Array<{ token_hash: string }>>`SELECT token_hash FROM p2p.offer_share_links WHERE id = ${made.id}`;
    expect(row!.token_hash).toBe(shareTokenHash(made.token));
    expect(JSON.stringify(await sql`SELECT * FROM p2p.offer_share_links`)).not.toContain(made.token);
    expect((await p2p.listShareLinks(offer.id, MAKER)).map((l) => l.id)).toEqual([made.id]);
    expect(JSON.stringify(await p2p.listShareLinks(offer.id, MAKER))).not.toContain(made.token);
    expect((await refusal(p2p.listShareLinks(offer.id, OTHER))).code).toBe('p2p.not_a_party');
    expect((await refusal(p2p.createShareLink({ linkId: crypto.randomUUID(), offerId: offer.id, makerId: OTHER }))).code).toBe(
      'p2p.not_a_party',
    );
    expect((await refusal(p2p.revokeShareLink(made.id, OTHER))).code).toBe('p2p.offer_not_found');
    expect((await refusal(p2p.setOfferVisibility(offer.id, OTHER, 'private'))).code).toBe('p2p.not_a_party');
  });

  it('a blank owner lifetime refuses a new link; links already made keep their end', async () => {
    const offer = await privateOffer();
    const { token } = await link(offer.id);
    const blank = service(null);
    expect((await refusal(blank.createShareLink({ linkId: crypto.randomUUID(), offerId: offer.id, makerId: MAKER }))).code).toBe(
      'p2p.config_unset',
    );
    expect((await blank.getOffer(offer.id, TAKER, token)).id).toBe(offer.id);
  });

  it('a closed ad cannot be shared or have its visibility changed', async () => {
    const offer = await sellOffer();
    await p2p.closeOffer(offer.id, MAKER);
    expect((await refusal(link(offer.id))).code).toBe('p2p.offer_not_active');
    expect((await refusal(p2p.setOfferVisibility(offer.id, MAKER, 'private'))).code).toBe('p2p.offer_not_active');
  });

  it('a private ad relisted stays private and off the board; a public one relisted is public', async () => {
    const hidden = await privateOffer();
    await p2p.closeOffer(hidden.id, MAKER);
    const relisted = await p2p.relistOffer({ offerId: hidden.id, makerId: MAKER });
    expect(relisted.visibility).toBe('private');
    expect(await board()).not.toContain(relisted.id);
    expect((await refusal(p2p.getOffer(relisted.id, TAKER))).code).toBe('p2p.offer_private');
    const open = await sellOffer();
    await p2p.closeOffer(open.id, MAKER);
    const reopened = await p2p.relistOffer({ offerId: open.id, makerId: MAKER });
    expect(reopened.visibility).toBe('public');
    expect(await board()).toContain(reopened.id);
  });
});
