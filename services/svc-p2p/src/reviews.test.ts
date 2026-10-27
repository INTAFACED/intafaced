import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { Principal } from '@intafaced/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { P2pService } from './p2p-service.js';
import { createP2pRouter } from './router.js';

/**
 * P-ads-merchant-21: one review per party on a released trade.
 * Postgres is the shared test server (TEST_DATABASE_URL). No balances are invented.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const MAKER = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const MOD = '44444444-4444-4444-8444-444444444444';
const ASSET = 'USDT';

describe('svc-p2p order reviews (P-ads-merchant-21)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let instruments!: InstrumentService;
  let ledger!: MemoryLedger;
  let p2p!: P2pService;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    instruments = new InstrumentService(sql);
    p2p = service();
    for (const methodId of ['sepa']) {
      await instruments.registerMethodSchema({
        methodId,
        country: ANY_COUNTRY,
        label: 'Test rail',
        fields: [{ key: 'account_reference', label: 'Account reference', required: true }],
      });
    }
    for (const ownerId of [MAKER, TAKER]) {
      await instruments.createInstrument({
        ownerId,
        methodId: 'sepa',
        country: 'DE',
        fiatCurrency: 'USD',
        label: 'sepa',
        details: { account_reference: `ref-${ownerId}` },
        instrumentId: crypto.randomUUID(),
      });
    }
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  function service(reviewEditWindowSeconds?: number) {
    return new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), {
      instruments,
      feeBps: 100,
      ...(reviewEditWindowSeconds === undefined ? {} : { reviewEditWindowSeconds }),
      deadlines: {
        escrowSeconds: 120,
        paymentSeconds: 900,
        releaseSeconds: 1800,
        disputeSeconds: 604_800,
        escalationRecheckSeconds: 3_600,
      },
    });
  }

  async function fund(userId: string, amount: string) {
    await ledger.post(
      recipes.deposit({
        userId,
        assetId: ASSET,
        amount: parseAmount(amount),
        rail: 'test',
        railRef: `${userId}:${amount}:${crypto.randomUUID()}`,
      }),
    );
  }

  async function released() {
    const offer = await p2p.createOffer({
      makerId: MAKER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'USD',
      priceType: 'fixed',
      price: parseAmount('1'),
      minAmt: parseAmount('10'),
      maxAmt: parseAmount('100'),
      totalAmt: parseAmount('500'),
      methods: ['sepa'],
      terms: 'pay the named amount',
    });
    const trade = await p2p.takeOffer({
      offerId: offer.id,
      takerId: TAKER,
      amount: parseAmount('10'),
      method: 'sepa',
      tradeId: crypto.randomUUID(),
    });
    await p2p.markFiatSent(trade.id, TAKER);
    await p2p.confirmFiatReceived(trade.id, MAKER);
    return trade;
  }

  const SECRET = 'p2p-reviews-edge-secret-long-enough';
  function caller(
    userId: string,
    scopes: string[] = ['p2p:read', 'p2p:write'],
    moderatorUserIds: readonly string[] = [],
    options?: { placePrincipal?: boolean },
  ) {
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:p2p-reviews');
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'false');
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-p2p' });
    const principal = {
      sub: userId,
      userId,
      sid: '55555555-5555-4555-8555-555555555555',
      scopes,
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(principal);
    const verified = edge({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req-reviews',
    });
    // The edge header schema refuses a non-UUID user id, so a machine session
    // never arrives that way. placePrincipal is that session once it is on the
    // context: kid stays unset, and admin:compliance still passes isModerator.
    const ctx = options?.placePrincipal ? { ...verified, principal } : verified;
    return createP2pRouter(p2p, instruments, undefined, { moderatorUserIds: [...moderatorUserIds] }).createCaller(ctx);
  }

  it('lets both parties rate a released trade once and returns the first on a second leave', async () => {
    await fund(MAKER, '1000');
    const trade = await released();
    const buyer = await caller(TAKER).reviews.leave({ tradeId: trade.id, rating: 'good', comment: 'paid' });
    const again = await caller(TAKER).reviews.leave({ tradeId: trade.id, rating: 'bad', explanation: 'changed my mind' });
    expect(again).toMatchObject({ id: buyer.id, rating: 'good', comment: 'paid' });
    const seller = await caller(MAKER).reviews.leave({ tradeId: trade.id, rating: 'bad', explanation: 'late fiat' });
    expect(seller.subjectId).toBe(TAKER);
    expect(seller.authorId).toBe(MAKER);
    const rows = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM p2p.order_reviews`;
    expect(rows[0]?.n).toBe(2);
    const card = await caller(OTHER, ['p2p:read']).reputation.get({ userId: MAKER });
    expect(card.rating).toEqual({ good: 1, bad: 0 });
    const empty = await caller(OTHER, ['p2p:read']).reputation.get({ userId: OTHER });
    expect(empty.rating).toBeNull();
  });

  it('refuses a bad review without an explanation and a review of a trade that is not released', async () => {
    await fund(MAKER, '1000');
    const offer = await p2p.createOffer({
      makerId: MAKER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'USD',
      priceType: 'fixed',
      price: parseAmount('1'),
      minAmt: parseAmount('10'),
      maxAmt: parseAmount('100'),
      totalAmt: parseAmount('500'),
      methods: ['sepa'],
      terms: 'pay the named amount',
    });
    const open = await p2p.takeOffer({
      offerId: offer.id,
      takerId: TAKER,
      amount: parseAmount('10'),
      method: 'sepa',
      tradeId: crypto.randomUUID(),
    });
    await expect(caller(TAKER).reviews.leave({ tradeId: open.id, rating: 'good' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: expect.objectContaining({ code: 'p2p.review_not_eligible' }),
    });
    await p2p.cancelTrade(open.id, TAKER);
    await expect(caller(TAKER).reviews.leave({ tradeId: open.id, rating: 'good' })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'p2p.review_not_eligible' }),
    });
    const done = await released();
    await expect(caller(TAKER).reviews.leave({ tradeId: done.id, rating: 'bad', explanation: '   ' })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'p2p.explanation_required' }),
    });
    await expect(caller(OTHER).reviews.leave({ tradeId: done.id, rating: 'good' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      cause: expect.objectContaining({ code: 'p2p.trade_not_found' }),
    });
    const stored = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM p2p.order_reviews`;
    expect(stored[0]?.n).toBe(0);
  });

  it('edits inside the owner window and refuses when the window is blank or over', async () => {
    await fund(MAKER, '1000');
    const trade = await released();
    await caller(TAKER).reviews.leave({ tradeId: trade.id, rating: 'good', comment: 'first' });
    await expect(caller(TAKER).reviews.edit({ tradeId: trade.id, comment: 'later' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: expect.objectContaining({ code: 'p2p.config_unset' }),
    });
    const kept = await sql<Array<{ comment: string }>>`SELECT comment FROM p2p.order_reviews`;
    expect(kept[0]?.comment).toBe('first');

    p2p = service(3600);
    const edited = await caller(TAKER).reviews.edit({ tradeId: trade.id, comment: 'later' });
    expect(edited.comment).toBe('later');
    await expect(caller(TAKER).reviews.edit({ tradeId: trade.id, rating: 'bad' })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'p2p.explanation_required' }),
    });
    await sql`UPDATE p2p.order_reviews SET created_at = now() - interval '2 hours' WHERE trade_id = ${trade.id}`;
    await expect(caller(TAKER).reviews.edit({ tradeId: trade.id, comment: 'too late' })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'p2p.review_not_eligible' }),
    });
    const still = await sql<Array<{ comment: string }>>`SELECT comment FROM p2p.order_reviews WHERE trade_id = ${trade.id}`;
    expect(still[0]?.comment).toBe('later');
  });

  it('does not rewrite a review once it has a reply or a moderator hid it', async () => {
    await fund(MAKER, '1000');
    p2p = service(3600);
    const trade = await released();
    await caller(TAKER).reviews.leave({ tradeId: trade.id, rating: 'good', comment: 'fine' });
    await caller(MAKER).reviews.reply({ tradeId: trade.id, text: 'thanks' });
    await expect(caller(TAKER).reviews.edit({ tradeId: trade.id, rating: 'bad', explanation: 'TEST changed' })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'p2p.review_not_eligible' }),
    });
    const other = await released();
    const hidden = await caller(TAKER).reviews.leave({ tradeId: other.id, rating: 'bad', explanation: 'abuse' });
    await caller(MOD, ['p2p:read'], [MOD]).reviews.moderate({ reviewId: hidden.id, reason: 'TEST abusive' });
    await expect(caller(TAKER).reviews.edit({ tradeId: other.id, comment: 'TEST softer' })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'p2p.review_not_eligible' }),
    });
    const rows = await sql<Array<{ rating: string; comment: string }>>`SELECT rating, comment FROM p2p.order_reviews ORDER BY created_at`;
    expect(rows).toEqual([
      { rating: 'good', comment: 'fine' },
      { rating: 'bad', comment: '' },
    ]);
  });

  it('allows one reply and refuses a different second reply', async () => {
    await fund(MAKER, '1000');
    const trade = await released();
    await caller(TAKER).reviews.leave({ tradeId: trade.id, rating: 'bad', explanation: 'short' });
    const reply = await caller(MAKER).reviews.reply({ tradeId: trade.id, text: 'the bank was slow' });
    expect(reply.reply).toBe('the bank was slow');
    const same = await caller(MAKER).reviews.reply({ tradeId: trade.id, text: 'the bank was slow' });
    expect(same.reply).toBe('the bank was slow');
    await expect(caller(MAKER).reviews.reply({ tradeId: trade.id, text: 'a different story' })).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: expect.objectContaining({ code: 'p2p.review_exists' }),
    });
    await expect(caller(TAKER).reviews.reply({ tradeId: trade.id, text: 'myself' })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'p2p.review_not_eligible' }),
    });
  });

  it('hides a review once, keeps it for the author, and drops it from the public rating', async () => {
    await fund(MAKER, '1000');
    const trade = await released();
    const review = await caller(TAKER).reviews.leave({ tradeId: trade.id, rating: 'bad', explanation: 'abuse' });
    await expect(caller(MOD).reviews.moderate({ reviewId: review.id, reason: 'abusive' })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'p2p.moderation_unreachable' }),
    });
    const hidden = await caller(MOD, ['p2p:read', 'p2p:write'], [MOD]).reviews.moderate({
      reviewId: review.id,
      reason: 'abusive',
    });
    expect(hidden.hidden).toBe(true);
    expect(hidden.hiddenReason).toBe('abusive');
    await caller(MOD, ['p2p:read'], [MOD]).reviews.moderate({ reviewId: review.id, reason: 'again' });
    const audit = await sql<Array<{ actor_id: string; reason: string; before_hidden: boolean; after_hidden: boolean }>>`
      SELECT actor_id, reason, before_hidden, after_hidden FROM p2p.order_review_audit
    `;
    expect(audit).toEqual([{ actor_id: MOD, reason: 'abusive', before_hidden: false, after_hidden: true }]);
    const stranger = await caller(OTHER, ['p2p:read']).reviews.list({ userId: MAKER, limit: 20 });
    expect(stranger.reviews).toEqual([]);
    const author = await caller(TAKER, ['p2p:read']).reviews.list({ userId: MAKER, limit: 20 });
    expect(author.reviews).toMatchObject([{ id: review.id, hidden: true, hiddenReason: 'abusive' }]);
    const card = await caller(OTHER, ['p2p:read']).reputation.get({ userId: MAKER });
    expect(card.rating).toBeNull();
  });

  it('gives each party of a trade their own review and the visible one about them, and a stranger not-found', async () => {
    await fund(MAKER, '1000');
    const trade = await released();
    expect(await caller(TAKER, ['p2p:read']).reviews.forTrade({ tradeId: trade.id })).toEqual({ mine: null, theirs: null });
    const buyer = await caller(TAKER).reviews.leave({ tradeId: trade.id, rating: 'good', comment: 'released fast' });
    const seller = await caller(MAKER).reviews.leave({ tradeId: trade.id, rating: 'bad', explanation: 'paid late' });
    expect(await caller(TAKER, ['p2p:read']).reviews.forTrade({ tradeId: trade.id })).toMatchObject({
      mine: { id: buyer.id, rating: 'good' },
      theirs: { id: seller.id, rating: 'bad', explanation: 'paid late' },
    });
    // Hidden: still the author's own, gone from the one it is about.
    await caller(MOD, ['p2p:read'], [MOD]).reviews.moderate({ reviewId: seller.id, reason: 'TEST abusive' });
    expect((await caller(TAKER, ['p2p:read']).reviews.forTrade({ tradeId: trade.id })).theirs).toBeNull();
    expect((await caller(MAKER, ['p2p:read']).reviews.forTrade({ tradeId: trade.id })).mine).toMatchObject({ id: seller.id, hidden: true });
    // A stranger, and a trade that does not exist, look the same.
    const strange = await caller(OTHER, ['p2p:read'])
      .reviews.forTrade({ tradeId: trade.id })
      .catch((e: unknown) => e);
    const missing = await caller(OTHER, ['p2p:read'])
      .reviews.forTrade({ tradeId: crypto.randomUUID() })
      .catch((e: unknown) => e);
    expect(strange).toMatchObject({ code: 'NOT_FOUND' });
    expect(missing).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a system:p2p-backstop session with admin:compliance and writes no audit row', async () => {
    await fund(MAKER, '1000');
    const trade = await released();
    const review = await caller(TAKER).reviews.leave({ tradeId: trade.id, rating: 'bad', explanation: 'abuse' });
    await expect(
      caller('system:p2p-backstop', ['p2p:read', 'admin:compliance'], [], { placePrincipal: true }).reviews.moderate({
        reviewId: review.id,
        reason: 'hide it',
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: expect.objectContaining({ code: 'p2p.ruling_not_attributed' }),
    });
    const audit = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM p2p.order_review_audit`;
    expect(audit[0]?.n).toBe(0);
    const stored = await sql<Array<{ hidden: boolean; hidden_by: string | null }>>`
      SELECT hidden, hidden_by FROM p2p.order_reviews WHERE id = ${review.id}
    `;
    expect(stored[0]).toEqual({ hidden: false, hidden_by: null });
  });

  it('pages every review once and refuses a blank page or a bad cursor', async () => {
    await fund(MAKER, '1000');
    const first = await released();
    const second = await released();
    await caller(TAKER).reviews.leave({ tradeId: first.id, rating: 'good', comment: 'one' });
    await caller(TAKER).reviews.leave({ tradeId: second.id, rating: 'good', comment: 'two' });
    const page = await caller(OTHER, ['p2p:read']).reviews.list({ userId: MAKER, limit: 1 });
    expect(page.reviews).toHaveLength(1);
    // A stranger reads the words and the rating, not who wrote it or on which order.
    expect(page.reviews[0]).toMatchObject({ tradeId: null, authorId: null, subjectId: MAKER, rating: 'good' });
    const own = await caller(MAKER, ['p2p:read']).reviews.list({ userId: MAKER, limit: 10 });
    expect(own.reviews.map((r) => r.authorId)).toEqual([TAKER, TAKER]);
    expect(page.nextCursor).toBeTruthy();
    const rest = await caller(OTHER, ['p2p:read']).reviews.list({ userId: MAKER, limit: 1, cursor: page.nextCursor });
    expect(rest.reviews).toHaveLength(1);
    expect(rest.reviews[0]?.id).not.toBe(page.reviews[0]?.id);
    expect(rest.nextCursor).toBeNull();
    await expect(caller(OTHER, ['p2p:read']).reviews.list({ userId: MAKER })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: expect.objectContaining({ code: 'p2p.review_list_limit_unset' }),
    });
    await expect(caller(OTHER, ['p2p:read']).reviews.list({ userId: MAKER, limit: 10, cursor: 'nope' })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'p2p.cursor_invalid' }),
    });
  });

  it('refuses the review list to a person either side blocked', async () => {
    await fund(MAKER, '1000');
    const trade = await released();
    await caller(TAKER).reviews.leave({ tradeId: trade.id, rating: 'good' });
    await sql`INSERT INTO p2p.contacts (owner_id, peer_id, kind) VALUES (${MAKER}, ${OTHER}, 'block')`;
    await expect(caller(OTHER, ['p2p:read']).reviews.list({ userId: MAKER, limit: 10 })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'p2p.blocked' }),
    });
  });

  it('two concurrent leaves store one review', async () => {
    await fund(MAKER, '1000');
    const trade = await released();
    const [a, b] = await Promise.all([
      p2p.leaveOrderReview({ tradeId: trade.id, authorId: TAKER, rating: 'good', comment: 'a' }),
      p2p.leaveOrderReview({ tradeId: trade.id, authorId: TAKER, rating: 'bad', explanation: 'b', comment: 'b' }),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.rating).toBe(b.rating);
    const rows = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM p2p.order_reviews`;
    expect(rows[0]?.n).toBe(1);
  });

  it('refuses a leave without p2p:write', async () => {
    await fund(MAKER, '1000');
    const trade = await released();
    await expect(caller(TAKER, ['p2p:read']).reviews.leave({ tradeId: trade.id, rating: 'good' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
