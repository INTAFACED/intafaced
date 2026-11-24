import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testPostgres } from '@intafaced/db/test-postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { P2pService } from './p2p-service.js';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { P2pErasure } from './erasure.js';
import { INSTRUMENT_OWNER_LOCK_CLASS } from './instrument-lock.js';

/**
 * THE ERASE/TAKE RACE — a person told their bank details were gone, while a
 * trade was being written that still holds them in cleartext.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS REPRODUCED
 *
 * `eraseFor` ran at READ COMMITTED and took no lock. Its refusal read took no
 * `FOR UPDATE`, and nothing re-examined it before commit. A take that read the
 * instrument row after erase's UPDATEs and before its COMMIT saw the pre-update
 * version — which is not a bug in MVCC, it is MVCC — and froze the account
 * number onto a brand new trade:
 *
 *     erase · refusal check      -> 0 live trades (proceeds)
 *     erase · REPORTS TO USER:      instruments erased=1, frozen snapshots erased=1
 *     take  · attachToTrade         sees 1 active instrument(s)
 *     trade snapshot: { "purged_at": null, "details": { "account_reference": "…" } }
 *
 * And it does not heal: `purgeExpiredSnapshots` only sweeps TERMINATED trades,
 * so a trade that never terminates carries the details for as long as it exists.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW THE INTERLEAVE IS MADE DETERMINISTIC
 *
 * A concurrency test that "usually" hits the window proves nothing on the run
 * where it does not, so nothing here is timing-dependent in the sense that
 * matters. A third connection holds a `FOR UPDATE` row lock on the ONE
 * `trade_payment_instruments` row that already exists — the snapshot on an
 * earlier, settled trade. `eraseFor` updates `payment_instruments` and then
 * that table, in that order, so the lock parks erase at exactly the point the
 * report is about to become untrue: after the instrument is `removed` in its
 * transaction, before anything is committed.
 *
 * The take is then run against that window. Which of the two wins is not the
 * property under test; the property is that the loser SEES the winner.
 *
 * The offer is deliberately one that has already been traded, so erase's
 * `DELETE FROM p2p.offers … NOT EXISTS (…)` matches no row and takes no lock on
 * it. Otherwise erase and the take would contend on the offer instead, and the
 * test would be measuring the wrong lock.
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
const ASSET = 'USDT';

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await testPostgres(H8A_IMAGE)
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
      `H8a: svc-p2p erase-take-race is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-p2p erase/take race PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('p2p erase/take race', () => {
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

  /**
   * An offer with a settled trade already against it, and plenty of liquidity
   * left. Two things follow: erase is allowed to proceed (nothing is live), and
   * erase will not touch the offer row (it has been traded).
   */
  async function tradedOffer() {
    await fund(MAKER, '10000');
    const offer = await p2p.createOffer({
      makerId: MAKER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'USD',
      priceType: 'fixed',
      price: amt('1'),
      minAmt: amt('10'),
      maxAmt: amt('500'),
      totalAmt: amt('5000'),
      methods: ['sepa'],
    });
    const first = await p2p.takeOffer({
      offerId: offer.id,
      takerId: TAKER,
      amount: amt('100'),
      method: 'sepa',
      tradeId: crypto.randomUUID(),
    });
    await p2p.confirmFiatReceived(first.id, MAKER);
    return offer;
  }

  /** How many backends of this database are parked waiting on a lock right now. */
  async function blockedBackends(): Promise<number> {
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
    `;
    return rows[0]!.n;
  }

  async function waitUntilBlocked(atLeast: number, timeoutMs = 5_000): Promise<void> {
    await vi.waitFor(
      async () => expect(await blockedBackends(), `no backend parked on a lock within ${timeoutMs}ms`).toBeGreaterThanOrEqual(atLeast),
      {
        timeout: timeoutMs,
        interval: 25,
      },
    );
  }

  /** Resolve to the value, or to `{ error }` — so both racers can be awaited without one masking the other. */
  const outcome = <T>(p: Promise<T>) =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (error: Error & { code?: string }) => ({ ok: false as const, error }),
    );

  /**
   * Waits until this promise has settled or `atLeast` backends are parked on a lock, then says whether it settled.
   * Never throws, never consumes the rejection.
   */
  async function settledOrParked<T>(p: Promise<T>, atLeast: number): Promise<boolean> {
    let done = false;
    void p.then(
      () => (done = true),
      () => (done = true),
    );
    await vi.waitFor(
      async () => {
        if (done) return;
        expect(await blockedBackends(), `neither settled nor parked on a lock`).toBeGreaterThanOrEqual(atLeast);
      },
      { timeout: 5_000, interval: 25 },
    );
    return done;
  }

  /** Any payment destination of this person that is still readable, anywhere. */
  async function readableDestinations(ownerId: string) {
    const [live, frozen] = await Promise.all([
      sql<Array<{ id: string }>>`SELECT id FROM p2p.payment_instruments WHERE owner_id = ${ownerId} AND status = 'active'`,
      sql<Array<{ trade_id: string; details: unknown }>>`
        SELECT trade_id, details FROM p2p.trade_payment_instruments
         WHERE owner_id = ${ownerId} AND (purged_at IS NULL OR details IS NOT NULL)
      `,
    ]);
    return { live: [...live], frozen: [...frozen] };
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

  describe('both writers of one person’s payment details take the same lock', () => {
    /**
     * The sharp one. A held advisory lock on the owner's key must be enough to
     * park an erase — which is only true if `eraseFor` asks for it, and asks
     * for it before it reads anything.
     */
    it('eraseFor waits for the instrument-owner lock before it reads a thing', async () => {
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      let taken!: () => void;
      const lockTaken = new Promise<void>((r) => {
        taken = r;
      });
      const gate = sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${INSTRUMENT_OWNER_LOCK_CLASS}, hashtext(${MAKER}))`;
        taken();
        await held;
      });
      await lockTaken;

      const erase = outcome(erasure.eraseFor(MAKER));
      expect(await settledOrParked(erase, 1)).toBe(false);

      release();
      await gate;
      expect((await erase).ok).toBe(true);
    });

    it('takeOffer waits for the same lock, on both parties, before its first row lock', async () => {
      const offer = await tradedOffer();
      await fund(MAKER, '10000');

      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      // The TAKER's key, not the seller's — a take copies one of the two
      // people's details depending on the offer's side, so it must hold both or
      // the erase it races is only half-excluded.
      let taken!: () => void;
      const lockTaken = new Promise<void>((r) => {
        taken = r;
      });
      const gate = sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${INSTRUMENT_OWNER_LOCK_CLASS}, hashtext(${TAKER}))`;
        taken();
        await held;
      });
      await lockTaken;

      const take = outcome(
        p2p.takeOffer({ offerId: offer.id, takerId: TAKER, amount: amt('100'), method: 'sepa', tradeId: crypto.randomUUID() }),
      );
      expect(await settledOrParked(take, 1)).toBe(false);

      release();
      await gate;
      expect((await take).ok).toBe(true);
    });
  });

  describe('the window between erase’s UPDATE and its COMMIT', () => {
    /**
     * THE DEFECT, AS A PROPERTY.
     *
     * Erase is parked mid-transaction with the instrument already `removed` in
     * its own snapshot and nothing committed. A take is launched into exactly
     * that window. Afterwards, ONE thing must be true: if the person was told
     * their destinations were erased, there is no readable destination of
     * theirs anywhere — not an active instrument, not an unpurged snapshot on a
     * trade that was created a moment later.
     *
     * Before the lock, this failed on the last assertion with a snapshot
     * carrying `{"account_reference": "ref-1111…"}` and `purged_at: null`, on a
     * trade that did not exist when erase read the database.
     */
    it('never lets an erase report success while a take is freezing the same details onto a new trade', async () => {
      const offer = await tradedOffer();
      await fund(MAKER, '10000');

      // Park erase on the snapshot row of the earlier settled trade — after its
      // `payment_instruments` UPDATE, before its COMMIT.
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      let taken!: () => void;
      const lockTaken = new Promise<void>((r) => {
        taken = r;
      });
      const gate = sql.begin(async (tx) => {
        const locked = await tx`SELECT trade_id FROM p2p.trade_payment_instruments WHERE owner_id = ${MAKER} FOR UPDATE`;
        taken();
        expect(locked).toHaveLength(1); // the fixture must actually give erase something to block on
        await held;
      });
      await lockTaken;

      const erase = outcome(erasure.eraseFor(MAKER));
      await waitUntilBlocked(1);

      const take = outcome(
        p2p.takeOffer({ offerId: offer.id, takerId: TAKER, amount: amt('100'), method: 'sepa', tradeId: crypto.randomUUID() }),
      );
      // Give the take its chance at the window. Before the lock it sailed
      // straight through it; with the lock it parks here.
      await settledOrParked(take, 2);

      release();
      await gate;

      const [eraseResult, takeResult] = await Promise.all([erase, take]);
      const readable = await readableDestinations(MAKER);

      // Whichever won, the loser saw it. These are the only two coherent
      // endings, and the incoherent one is neither.
      if (eraseResult.ok) {
        expect(readable.live).toEqual([]);
        expect(readable.frozen).toEqual([]);
        // …which means the take must have been refused, exactly as a take
        // against any seller with no destination is refused.
        expect(takeResult.ok).toBe(false);
      } else {
        // Erase refused instead, and it must say why in a way the person can
        // act on rather than failing obscurely.
        expect(['p2p.erase_blocked', 'p2p.erase_raced']).toContain(eraseResult.error.code);
        expect(takeResult.ok).toBe(true);
      }
    });

    /**
     * The same window, stated as the sentence the person is actually shown.
     * `eraseFor` returns a manifest; rule 2 of `erasure.ts` is that the manifest
     * must be true. This asserts the manifest against the database rather than
     * against the counts erase happened to see.
     */
    it('a manifest that claims the destinations are erased is true at commit, not merely when it was read', async () => {
      const offer = await tradedOffer();
      await fund(MAKER, '10000');

      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      let taken!: () => void;
      const lockTaken = new Promise<void>((r) => {
        taken = r;
      });
      const gate = sql.begin(async (tx) => {
        await tx`SELECT trade_id FROM p2p.trade_payment_instruments WHERE owner_id = ${MAKER} FOR UPDATE`;
        taken();
        await held;
      });
      await lockTaken;

      const erase = outcome(erasure.eraseFor(MAKER));
      await waitUntilBlocked(1);
      const take = outcome(
        p2p.takeOffer({ offerId: offer.id, takerId: TAKER, amount: amt('100'), method: 'sepa', tradeId: crypto.randomUUID() }),
      );
      await settledOrParked(take, 2);
      release();
      await gate;

      const eraseResult = await erase;
      await take;

      if (!eraseResult.ok) return; // covered by the test above

      const claimed = eraseResult.value.erased.find((line) => line.category === 'payment instrument details');
      expect(claimed).toBeDefined();

      const readable = await readableDestinations(MAKER);
      expect({ claimedErased: claimed!.rows, stillReadable: readable.live.length + readable.frozen.length }).toEqual({
        claimedErased: 1,
        stillReadable: 0,
      });
    });
  });
});
