import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { P2pService } from './p2p-service.js';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { P2pErasure } from './erasure.js';

/**
 * P2P EXPORT AND ERASURE — stage 1.
 *
 * Postgres is real because every claim here is about rows: what came back, what
 * is gone, and what is still there on purpose. The interesting assertions are
 * the LAST two in each test — an erase is only correct if you can also say what
 * it did not do.
 *
 * Public `offers.create` still named-refuses until OWNER KMS (Q-p2p). This
 * file drives `P2pService` + `P2pErasure` directly. Fixture rails here are
 * not a live method registry.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `p2p.*` SQL stays on `p2p`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const MAKER = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const MODERATOR = '44444444-4444-4444-8444-444444444444';
const ASSET = 'USDT';

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-p2p erasure is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-p2p erasure PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('p2p export and erasure', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let instruments!: InstrumentService;
  let ledger: MemoryLedger;
  let bus: MemoryEventBus;
  let p2p: P2pService;
  let erasure: P2pErasure;
  let options!: {
    instruments: InstrumentService;
    feeBps: number;
    deadlines: {
      escrowSeconds: number;
      paymentSeconds: number;
      releaseSeconds: number;
      disputeSeconds: number;
      escalationRecheckSeconds: number;
    };
  };

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'p2p', url: admin.url, migrations });
    sql = db.sql;
    instruments = new InstrumentService(sql);
    options = {
      instruments,
      feeBps: 0,
      deadlines: {
        escrowSeconds: 120,
        paymentSeconds: 900,
        releaseSeconds: 1800,
        disputeSeconds: 604_800,
        escalationRecheckSeconds: 3_600,
      },
    };
  }, 120_000);

  /**
   * A take is refused before any lock unless the SELLER holds a destination in
   * the trade's currency, so every seller here needs one.
   *
   * The schema is a FIXTURE and asserts nothing about how any real payment rail
   * works — the registry ships empty precisely because that is not this repo's
   * knowledge to invent.
   */
  async function seedPaymentRails() {
    await instruments.registerMethodSchema({
      methodId: 'sepa',
      country: ANY_COUNTRY,
      label: 'Bank transfer (test fixture)',
      fields: [{ key: 'account_reference', label: 'Account reference', required: true }],
    });

    for (const ownerId of [MAKER, TAKER]) {
      await instruments.createInstrument({
        ownerId,
        methodId: 'sepa',
        country: 'DE',
        fiatCurrency: 'USD',
        label: 'USD destination',
        details: { account_reference: `ref-${ownerId}` },
        instrumentId: crypto.randomUUID(),
      });
    }
  }

  async function fund(userId: string, amount: string) {
    await ledger.post(
      recipes.deposit({ userId, assetId: ASSET, amount: amt(amount), rail: 'test', railRef: `${userId}:${crypto.randomUUID()}` }),
    );
  }

  async function sellOffer() {
    return p2p.createOffer({
      makerId: MAKER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'USD',
      priceType: 'fixed',
      price: amt('1'),
      minAmt: amt('10'),
      maxAmt: amt('500'),
      totalAmt: amt('500'),
      methods: ['sepa'],
    });
  }

  async function completedTrade() {
    await fund(MAKER, '1000');
    const offer = await sellOffer();
    const trade = await p2p.takeOffer({
      offerId: offer.id,
      takerId: TAKER,
      amount: amt('100'),
      method: 'sepa',
      tradeId: crypto.randomUUID(),
    });
    await p2p.confirmFiatReceived(trade.id, MAKER);
    return { offer, trade };
  }

  /** The caller's own instrument id — the one `seedPaymentRails` gave them. */
  async function instrumentIdOf(ownerId: string): Promise<string> {
    const rows = await sql<Array<{ id: string }>>`SELECT id FROM p2p.payment_instruments WHERE owner_id = ${ownerId} LIMIT 1`;
    return rows[0]!.id;
  }

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    bus = new MemoryEventBus('svc-p2p');
    p2p = new P2pService(sql, ledger, bus, options);
    erasure = new P2pErasure(sql);
    await seedPaymentRails();
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  describe('export', () => {
    it('returns everything this service holds about the caller', async () => {
      // Before this, `blueprint.export` was the only export in the platform and
      // every statement in it is prefixed `blueprint.` — no p2p table was
      // covered by anything at all.
      const { trade } = await completedTrade();

      const out = await erasure.exportFor(MAKER);
      expect(out.offers).toHaveLength(1);
      expect(out.trades).toHaveLength(1);
      expect((out.trades[0] as { id: string }).id).toBe(trade.id);
      expect(out.reputation).not.toBeNull();
    });

    it('includes the disputes and the evidence filed about the caller', async () => {
      await fund(MAKER, '1000');
      const offer = await sellOffer();
      const trade = await p2p.takeOffer({
        offerId: offer.id,
        takerId: TAKER,
        amount: amt('100'),
        method: 'sepa',
        tradeId: crypto.randomUUID(),
      });
      await p2p.openDispute({ tradeId: trade.id, openedBy: TAKER, reason: 'nothing arrived', evidence: [{ ref: 'R-1' }] });

      // The SELLER's export carries it: it is a record made ABOUT them, which
      // is the clearest case in this file for a subject-access request.
      const out = await erasure.exportFor(MAKER);
      expect(out.disputes).toHaveLength(1);
      expect(JSON.stringify(out.disputes)).toContain('R-1');
    });

    /**
     * THE EXPORT IS NOT A SECOND WAY TO READ AN ACCOUNT NUMBER.
     *
     * `instruments.reveal` writes an access-log row in the same statement that
     * reads the details — that is the property the whole instrument design
     * rests on. An export that also served the values would be an unlogged
     * disclosure path with a friendly name, so this one carries headers and
     * says where the values are.
     */
    it('carries instrument headers and never their values', async () => {
      const out = await erasure.exportFor(MAKER);

      expect(out.instruments).toHaveLength(1);
      expect(out.instruments[0]).toMatchObject({ method_id: 'sepa', fiat_currency: 'USD', status: 'active' });

      const serialised = JSON.stringify(out.instruments);
      expect(serialised).not.toContain('ref-');
      expect(serialised).not.toContain('account_reference');
      // Not the fingerprint either: a hash handed to a caller is an oracle a
      // guessed account number can be checked against.
      expect(serialised).not.toContain('fingerprint');
    });

    it('names what it does NOT cover rather than implying it is the platform', async () => {
      const out = await erasure.exportFor(MAKER);
      expect(out.notCovered.join(' ')).toContain('svc-ledger');
      expect(out.notCovered.join(' ')).toContain('svc-identity');
      expect(out.notCovered.some((s) => s.includes('payment instruments'))).toBe(true);
      // And it points at the logged path for the values, rather than at nothing.
      expect(out.notCovered.some((s) => s.includes('instruments.reveal'))).toBe(true);
    });

    it('returns nothing for someone this service has never seen', async () => {
      const out = await erasure.exportFor('99999999-9999-4999-8999-999999999999');
      expect(out).toMatchObject({ offers: [], trades: [], disputes: [], orderReviews: [], reputation: null, instruments: [] });
    });

    it('returns a review the caller wrote or received', async () => {
      const { trade } = await completedTrade();
      const review = await p2p.leaveOrderReview({
        tradeId: trade.id,
        authorId: TAKER,
        rating: 'bad',
        explanation: 'the other party was late',
      });

      const about = await erasure.exportFor(MAKER);
      const written = await erasure.exportFor(TAKER);
      expect(about.orderReviews).toEqual([
        expect.objectContaining({ id: review.id, subject_id: MAKER, author_id: TAKER, explanation: 'the other party was late' }),
      ]);
      expect(written.orderReviews).toEqual([expect.objectContaining({ id: review.id, author_id: TAKER, subject_id: MAKER })]);
    });
  });

  describe('erase', () => {
    /**
     * THE REFUSAL, AND WHY IT IS THE RIGHT ANSWER.
     *
     * svc-ledger is holding this person's value. Deleting our copy of who it
     * belongs to and what should happen to it does not remove the money — it
     * removes the only record that can explain it, which is the stranded-funds
     * condition the whole service exists to prevent.
     */
    it('refuses while a trade is still holding escrow', async () => {
      await fund(MAKER, '1000');
      const offer = await sellOffer();
      await p2p.takeOffer({ offerId: offer.id, takerId: TAKER, amount: amt('100'), method: 'sepa', tradeId: crypto.randomUUID() });

      await expect(erasure.eraseFor(MAKER)).rejects.toMatchObject({ code: 'p2p.erase_blocked' });
      await expect(erasure.eraseFor(TAKER)).rejects.toMatchObject({ code: 'p2p.erase_blocked' });

      // And nothing was half-done on the way to refusing — including the
      // destination the buyer is mid-payment to.
      expect(await sql`SELECT user_id FROM p2p.p2p_reputation WHERE user_id = ${MAKER}`).toHaveLength(1);
      const snapshot = await sql`SELECT details FROM p2p.trade_payment_instruments WHERE owner_id = ${MAKER}`;
      expect(snapshot[0]!.details).not.toBeNull();
    });

    it('refuses while a decision is recorded but not yet settled — value that is LATE', async () => {
      await fund(MAKER, '1000');
      const offer = await sellOffer();
      const trade = await p2p.takeOffer({
        offerId: offer.id,
        takerId: TAKER,
        amount: amt('100'),
        method: 'sepa',
        tradeId: crypto.randomUUID(),
      });
      // A real undecided-to-decided transition, before its ledger post.
      await sql`UPDATE p2p.p2p_trades SET status = 'released', resolution = 'released', resolution_reason = 'seller.confirmed', resolved_at = now(), deadline_at = null WHERE id = ${trade.id}`;

      await expect(erasure.eraseFor(MAKER)).rejects.toMatchObject({ code: 'p2p.erase_blocked' });
    });

    it('refuses while a dispute is open', async () => {
      await fund(MAKER, '1000');
      const offer = await sellOffer();
      const trade = await p2p.takeOffer({
        offerId: offer.id,
        takerId: TAKER,
        amount: amt('100'),
        method: 'sepa',
        tradeId: crypto.randomUUID(),
      });
      await p2p.openDispute({ tradeId: trade.id, openedBy: TAKER, reason: 'x' });

      await expect(erasure.eraseFor(MAKER)).rejects.toMatchObject({ code: 'p2p.erase_blocked' });
    });

    it('erases reputation and untraded offers once nothing is live', async () => {
      await completedTrade();
      const untraded = await sellOffer();

      const report = await erasure.eraseFor(MAKER);

      expect(await sql`SELECT user_id FROM p2p.p2p_reputation WHERE user_id = ${MAKER}`).toHaveLength(0);
      expect(await sql`SELECT id FROM p2p.offers WHERE id = ${untraded.id}`).toHaveLength(0);
      expect(report.erased).toEqual([
        { category: 'reputation', rows: 1 },
        { category: 'offers (never traded)', rows: 1 },
        { category: 'ads paused by a removed payment method', rows: 0 },
        { category: 'payment instrument details', rows: 1 },
        { category: 'payment details frozen onto trades', rows: 1 },
      ]);
    });

    /**
     * THE ACCOUNT NUMBER IS THE POINT.
     *
     * `payment_instruments` is the single most sensitive row in this service.
     * An erase that left it there — and did not say so — would be the exact
     * "silently retains half the record" failure the manifest exists to make
     * impossible.
     */
    it('erases the account details, and the destination frozen onto the caller’s own trades', async () => {
      await completedTrade();

      await erasure.eraseFor(MAKER);

      const own = await sql`SELECT status, details, fingerprint FROM p2p.payment_instruments WHERE owner_id = ${MAKER}`;
      expect(own).toHaveLength(1);
      expect(own[0]!.status).toBe('removed');
      expect(own[0]!.details).toBeNull();
      // The fingerprint survives on purpose: an appeal can still be told whether
      // the account a seller now names is the one the buyer was shown, without
      // us holding the account in order to answer.
      expect(own[0]!.fingerprint).toBeTruthy();

      const snapshot = await sql`SELECT details, purged_at FROM p2p.trade_payment_instruments WHERE owner_id = ${MAKER}`;
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0]!.details).toBeNull();
      expect(snapshot[0]!.purged_at).not.toBeNull();
    });

    it('does not touch a counterparty’s account details', async () => {
      await completedTrade();

      await erasure.eraseFor(MAKER);

      // TAKER's own instrument is TAKER's record. MAKER asking to be erased is
      // not TAKER asking.
      const theirs = await sql`SELECT status, details FROM p2p.payment_instruments WHERE owner_id = ${TAKER}`;
      expect(theirs[0]!.status).toBe('active');
      expect(theirs[0]!.details).not.toBeNull();
    });

    /**
     * THE PART THAT MAKES IT HONEST.
     *
     * An erase that silently keeps half the record is worse than one that
     * refuses — the person believes something untrue and only discovers it in a
     * dispute. Every retained category is named, counted, and given a reason
     * that would survive being read out loud.
     */
    it('names, counts and explains everything it kept', async () => {
      // A real disputed trade, ruled on by a real moderator, then settled —
      // the only shape in which a dispute exists and nothing is live.
      await fund(MAKER, '1000');
      const offer = await sellOffer();
      const trade = await p2p.takeOffer({
        offerId: offer.id,
        takerId: TAKER,
        amount: amt('100'),
        method: 'sepa',
        tradeId: crypto.randomUUID(),
      });
      await p2p.openDispute({ tradeId: trade.id, openedBy: TAKER, reason: 'x', evidence: [{ ref: 'R-1' }] });
      await p2p.resolveDispute({ tradeId: trade.id, moderatorId: MODERATOR, resolution: 'refund' });

      const report = await erasure.eraseFor(MAKER);
      const categories = report.retained.map((r) => r.category);

      expect(categories).toContain('settled trades');
      expect(categories).toContain('disputes and their evidence');
      expect(categories).toContain('offers (traded against)');
      expect(categories).toContain('payment instrument records, without their details');

      // Every reason is a real sentence, not the word "compliance".
      for (const line of report.retained) {
        expect(line.rows).toBeGreaterThan(0);
        expect(line.reason!.length).toBeGreaterThan(40);
        expect(line.reason!.toLowerCase()).not.toBe('compliance');
      }

      // The rows really are still there — the manifest is not a story.
      expect(await sql`SELECT id FROM p2p.p2p_trades WHERE id = ${trade.id}`).toHaveLength(1);
      expect(await sql`SELECT id FROM p2p.p2p_disputes WHERE trade_id = ${trade.id}`).toHaveLength(1);
    });

    /**
     * THE ACCESS LOG IS APPEND-ONLY BY TRIGGER, AND THAT IS THE ANSWER.
     *
     * It is the record of who looked at this person's account details. Erasing
     * it on request would delete the evidence of a leak at the request of
     * whoever caused the leak — so it is kept, and it is NAMED as kept.
     */
    it('keeps the access log, and says so', async () => {
      const { trade } = await completedTrade();
      // The owner reading their own details is logged like anyone else's read —
      // an account takeover holds the session and looks exactly like the owner.
      await instruments.revealOwn({ instrumentId: await instrumentIdOf(MAKER), viewerId: MAKER });

      const before = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM p2p.instrument_access_log WHERE owner_id = ${MAKER}
      `;
      expect(before[0]!.n).toBeGreaterThan(0);

      const report = await erasure.eraseFor(MAKER);
      const log = report.retained.find((r) => r.category === 'payment instrument access log');
      expect(log).toBeDefined();
      expect(log!.rows).toBe(before[0]!.n);

      // Still there, and so is the trade it points at.
      const after = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM p2p.instrument_access_log WHERE owner_id = ${MAKER}
      `;
      expect(after[0]!.n).toBe(before[0]!.n);
      expect(await sql`SELECT id FROM p2p.p2p_trades WHERE id = ${trade.id}`).toHaveLength(1);
    });

    it('does not touch anyone else', async () => {
      await completedTrade();
      await erasure.eraseFor(MAKER);

      // The counterparty's reputation is their own record of their own trading.
      expect(await sql`SELECT user_id FROM p2p.p2p_reputation WHERE user_id = ${TAKER}`).toHaveLength(1);
    });

    it('is idempotent — asking twice is not an error', async () => {
      await completedTrade();
      await erasure.eraseFor(MAKER);
      const second = await erasure.eraseFor(MAKER);
      expect(second.erased.every((l) => l.rows === 0)).toBe(true);
    });

    it('names a sensitive-remark case for both parties and leaves the row (P-ads-merchant-19)', async () => {
      const { trade } = await completedTrade();
      await p2p.reportSensitiveRemark({ caseId: crypto.randomUUID(), tradeId: trade.id, reporterId: MAKER, remark: 'USDT' });

      for (const userId of [TAKER, MAKER]) {
        const report = await erasure.eraseFor(userId);
        expect(report.retained.find((line) => line.category === 'reports of a sensitive payment-note remark')).toMatchObject({
          rows: 1,
          reason: expect.stringContaining('staff decide it'),
        });
      }
      expect(await sql`SELECT 1 FROM p2p.remark_cases WHERE trade_id = ${trade.id}`).toHaveLength(1);
    });

    it('names an order review and leaves the row', async () => {
      const { trade } = await completedTrade();
      const review = await p2p.leaveOrderReview({
        tradeId: trade.id,
        authorId: TAKER,
        rating: 'bad',
        explanation: 'the other party was late',
      });

      const subject = await erasure.eraseFor(MAKER);
      const subjectLine = subject.retained.find((line) => line.category === 'order reviews');
      expect(subjectLine).toMatchObject({
        rows: 1,
        reason: expect.stringContaining("The other party's rating and words stay"),
      });
      expect(subject.erased.some((line) => line.category.toLowerCase().includes('review'))).toBe(false);

      const author = await erasure.eraseFor(TAKER);
      expect(author.retained.find((line) => line.category === 'order reviews')).toMatchObject({ rows: 1 });

      const still = await sql<Array<{ id: string; explanation: string | null }>>`
        SELECT id, explanation FROM p2p.order_reviews WHERE id = ${review.id}
      `;
      expect(still).toEqual([{ id: review.id, explanation: 'the other party was late' }]);
    });
  });
});
