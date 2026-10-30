import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { P2pService } from './p2p-service.js';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY, TAKE_REFUSED_MESSAGE } from './instruments.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * A REFUSED TAKE MUST NOT COST A CONNECTION IT IS ALREADY HOLDING
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * #805 closed an enumeration oracle in `trades.take` and, in closing it, opened
 * a remote denial of service that ten requests are enough to make permanent.
 *
 * The refusal throws, and the throw aborts `reserveTrade`'s transaction — so a
 * log row written on `tx` would roll back with it, and "unlogged" was the whole
 * defect. #805 therefore wrote the row on `this.sql`, the service's pool. That
 * is right about durability and wrong about connections: `refuseTake` runs
 * INSIDE the transaction, the transaction is holding a pool connection, and the
 * INSERT asks the same pool for a second one.
 *
 * `DATABASE_POOL_MAX` defaults to 10 (`packages/config/src/env.ts`). Ten
 * concurrent refused takes against ten DIFFERENT offers therefore hold all ten
 * connections and each queues for an eleventh that will never exist. The
 * transactions sit `idle in transaction`: no statement is running, so
 * `statement_timeout` cannot fire, and postgres.js's client-side queue has no
 * timeout of its own. Nothing unwinds it. The service stops answering, and the
 * ten offer rows stay locked, so those ten offers die with it.
 *
 * The attack needs ten `trades.take` calls naming a method the offers do not
 * list. `methodAllowed` is checked BEFORE the bounds check, so it needs no
 * funds, no valid amount, and no payment instrument. (Ten takes against the
 * SAME offer serialise on `FOR UPDATE` and recover; distinct offers is the
 * permanent case, and it is the one below.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE ASSERTS, AND WHY IT IS SEPARATE
 *
 *   1 · N concurrent refused takes against N distinct offers all settle, and
 *       the service still serves an unrelated request afterwards.
 *   2 · Every one of them is still on the record — #805's guarantee has to
 *       survive the fix, and under concurrency, not just one at a time.
 *   3 · They are still indistinguishable — the fix must not reopen the oracle.
 *
 * It is its own file, on its OWN DATABASE, for a reason the sibling suites do
 * not have: it deliberately saturates a connection pool. Sharing `intafaced_test`
 * with ~150 worktrees while doing that is antisocial at best, and on the broken
 * code it leaves ten backends wedged `idle in transaction` holding row locks —
 * on a shared database that is somebody else's flaky red. `createTestDatabase`
 * stamps this run its own `itf_run_p2p_<pid>_<n>_<rand>_test`, dropped WITH
 * (FORCE) in `afterAll`, so the wedged backends are terminated with it. The
 * pool it saturates is its own and is bounded at POOL_MAX.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `p2p.*` SQL stays on `p2p`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = [
  '0000_p2p_init.sql',
  '0001_p2p_payment_instruments.sql',
  '0002_p2p_instrument_field_guard.sql',
  '0003_p2p_dispute_ruling_invariant.sql',
  '0005_p2p_late_settle_error.sql',
  '0006_p2p_dispute_open_origin.sql',
  '0007_p2p_dispute_chat_thread.sql',
  '0010_p2p_immutable_trade_terms.sql',
  '0011_p2p_payto_snapshot.sql',
  '0012_p2p_dispute_resolution_match.sql',
  '0013_p2p_dispute_ruling_frozen.sql',
  '0014_p2p_escrow_lock_attempts.sql',
  '0015_p2p_customer_depth.sql',
  '0016_p2p_ops_escalation.sql',
  '0019_p2p_maker_verification_tier.sql',
  '0022_p2p_method_delist_reason.sql',
  '0023_p2p_take_step_ups.sql',
  '20261024075545_p2p_non_instant_methods.sql',
  '20261024111016_p2p_release_step_ups.sql',
  '20261024125300_p2p_trade_reminders.sql',
  '20261024133500_p2p_trade_mismatches.sql',
  '20261024141500_p2p_rail_exceptions.sql',
  '20261025020000_p2p_method_rules.sql',
  '20261030125739_p2p_ad_lifecycle.sql',
].map((file) => readFileSync(join(here, '..', 'drizzle', file), 'utf8'));

const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const ASSET = 'USDT';
const METHOD = 'test-transfer';

/**
 * The production default, verbatim (`packages/config/src/env.ts`). The bug is a
 * function of the pool size, so the number here is the number that ships — not
 * a smaller one chosen to make the test quick.
 */
const POOL_MAX = 10;

/**
 * How long the attack is given to settle before it counts as wedged.
 *
 * On working code the ten takes settle in tens of milliseconds. On the broken
 * code they never settle at all — the deadlock is permanent, not slow — so this
 * window is not a performance threshold that a loaded machine could trip. It is
 * only how long the test is willing to wait to say so.
 */
const WEDGED_AFTER_MS = 15_000;

/**
 * Resolve to `value` if `promise` has not settled in `ms`.
 *
 * The wedge has to be reported, not waited on: a test that simply awaits a
 * deadlocked take hangs the whole run and tells nobody why. `unref` so a timer
 * still pending on a wedged run cannot hold the process open.
 */
function within<T>(promise: Promise<T>, ms: number, value: T): Promise<T> {
  const expiry = new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(value), ms) as unknown as { unref?: () => void };
    timer.unref?.();
  });
  return Promise.race([promise, expiry]).catch(() => value);
}

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
      `H8a: svc-p2p take-refusal-deadlock is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-p2p take-refusal-deadlock PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-p2p take refusal under concurrency', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: ReturnType<typeof postgres>;
  let observer!: ReturnType<typeof postgres>;
  let instruments!: InstrumentService;
  let ledger: MemoryLedger;
  let p2p: P2pService;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'p2p', url: admin.url, migrations });
    /**
     * THE SERVICE'S POOL, shaped like the one `createDb` builds in production:
     * `max` from `DATABASE_POOL_MAX` and the same 15s `statement_timeout`. The
     * timeout is here precisely so the test can show it does not help — an idle
     * transaction is not a running statement.
     */
    sql = postgres(db.url, {
      max: POOL_MAX,
      connection: { search_path: 'p2p,public', application_name: 'p2p-deadlock-test', statement_timeout: 15_000 },
      onnotice: () => undefined,
    });
    /** A connection OUTSIDE the pool under attack, so it can still report on it. */
    observer = postgres(db.url, { max: 1, onnotice: () => undefined });
    instruments = new InstrumentService(sql);
  }, 120_000);

  async function registerMethod(methodId = METHOD) {
    await instruments.registerMethodSchema({
      methodId,
      country: ANY_COUNTRY,
      label: 'Test transfer',
      fields: [{ key: 'account_reference', label: 'Account reference', required: true }],
    });
  }

  async function sellerInstrument(methodId = METHOD) {
    await instruments.createInstrument({
      ownerId: SELLER,
      methodId,
      country: 'DE',
      fiatCurrency: 'USD',
      label: 'Main account',
      details: { account_reference: 'ref-0001' },
      instrumentId: crypto.randomUUID(),
    });
  }

  /** `count` DISTINCT active offers, each listing exactly `methods`. */
  async function offers(count: number, methods: string[] = [METHOD]) {
    await ledger.post(
      recipes.deposit({ userId: SELLER, assetId: ASSET, amount: amt('100000'), rail: 'test', railRef: crypto.randomUUID() }),
    );
    const made = [];
    for (let i = 0; i < count; i++) {
      made.push(
        await p2p.createOffer({
          makerId: SELLER,
          side: 'sell',
          asset: ASSET,
          fiatCurrency: 'USD',
          priceType: 'fixed',
          price: amt('1'),
          minAmt: amt('10'),
          maxAmt: amt('500'),
          totalAmt: amt('500'),
          methods,
        }),
      );
    }
    return made;
  }

  /**
   * WARM THE POOL before the attack.
   *
   * Not a thumb on the scale — the opposite. postgres.js opens connections
   * lazily and hands a new request to the first IDLE connection before it opens
   * another, so on a cold pool the ten takes stagger into distinct phases and
   * the first one finishes and frees its connection before the tenth has begun.
   * A live service's pool is warm; a cold one is the unrealistic case. Warming
   * makes the test deterministic instead of dependent on connect latency, and
   * every connection it opens is one the pool was configured to allow anyway.
   */
  async function warmPool() {
    await Promise.all(Array.from({ length: POOL_MAX }, () => sql`SELECT pg_sleep(0.05)`));
  }

  /** How many of this pool's backends are stuck holding an open transaction. */
  async function idleInTransaction(): Promise<number> {
    const rows = await observer<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE application_name = 'p2p-deadlock-test' AND state = 'idle in transaction'
    `;
    return rows[0]?.n ?? 0;
  }

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    p2p = new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), { instruments, feeBps: 0 });
    await registerMethod();
  });

  afterAll(async () => {
    await observer?.end({ timeout: 0 }).catch(() => undefined);
    await sql?.end({ timeout: 0 }).catch(() => undefined);
    // WITH (FORCE) — on a regression this drops a database with wedged
    // backends still attached, which is the only way it gets cleaned up.
    await db?.drop();
    await adminStop();
  }, 30_000);

  // ── 1 · THE DENIAL OF SERVICE ─────────────────────────────────────────────

  describe('N concurrent refused takes on a pool of N', () => {
    /**
     * THE TEST THAT WOULD HAVE CAUGHT #805.
     *
     * Ten refused takes, ten distinct offers, a pool of ten. On the fixed code
     * every one of them settles and the service goes on working. On #805 as
     * merged, all ten transactions park `idle in transaction` waiting for an
     * eleventh connection, nothing times out, and svc-p2p is finished.
     */
    it('all settle, and the service still serves an unrelated request', async () => {
      await sellerInstrument();
      const made = await offers(POOL_MAX);
      await warmPool();

      // Ten takes naming a method no offer lists. No funds, no valid amount and
      // no instrument are needed: `methodAllowed` is checked before the bounds.
      const takes = made.map((offer) =>
        p2p.takeOffer({ offerId: offer.id, takerId: BUYER, amount: amt('100'), method: 'zzz', tradeId: crypto.randomUUID() }).then(
          () => 'resolved',
          (err: unknown) => `rejected:${(err as { code?: string }).code}`,
        ),
      );

      const settled = await within(Promise.all(takes), WEDGED_AFTER_MS, ['WEDGED']);

      expect(settled).toEqual(Array.from({ length: POOL_MAX }, () => 'rejected:p2p.take_refused'));

      // THE POOL IS BACK. Not "eventually" — the transactions ended when the
      // refusals threw, which is what they were always supposed to do.
      expect(await idleInTransaction()).toBe(0);

      // AN UNRELATED REQUEST, on the same pool, from a caller who did nothing
      // wrong. This is the assertion that makes it a denial of service rather
      // than ten failed calls.
      const healthy = await within(
        p2p.getOffer(made[0]!.id).then(() => 'served'),
        10_000,
        'HUNG',
      );
      expect(healthy).toBe('served');
    }, 60_000);

    it('leaves the attacked offers takeable — the row locks are released', async () => {
      await sellerInstrument();
      const made = await offers(POOL_MAX);
      await warmPool();

      await within(
        Promise.all(
          made.map((o) =>
            p2p
              .takeOffer({ offerId: o.id, takerId: BUYER, amount: amt('100'), method: 'zzz', tradeId: crypto.randomUUID() })
              .catch(() => null),
          ),
        ),
        WEDGED_AFTER_MS,
        [],
      );

      // On the broken code these ten rows stay `FOR UPDATE`-locked by ten
      // transactions that never end, so the offers are collateral damage: they
      // can never be taken again, by anyone.
      const rows = await within(
        observer<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_locks
           WHERE relation = 'p2p.offers'::regclass AND mode = 'RowShareLock' AND granted
        `.then((r) => r[0]?.n ?? -1),
        10_000,
        -1,
      );
      expect(rows).toBe(0);

      // And a real take on one of them goes through.
      const trade = await within(
        p2p
          .takeOffer({ offerId: made[0]!.id, takerId: BUYER, amount: amt('100'), method: METHOD, tradeId: crypto.randomUUID() })
          .then((t) => t.status),
        10_000,
        'HUNG',
      );
      expect(trade).toBe('escrowed');
    }, 60_000);
  });

  // ── 2 · #805's GUARANTEE SURVIVES ─────────────────────────────────────────

  describe('the denial is still written down', () => {
    it('logs one row per refusal, after the transaction that aborted', async () => {
      await sellerInstrument();
      const [offer] = await offers(1);

      await expect(
        p2p.takeOffer({ offerId: offer!.id, takerId: BUYER, amount: amt('100'), method: 'zzz', tradeId: crypto.randomUUID() }),
      ).rejects.toMatchObject({
        code: 'p2p.take_refused',
      });

      // The row is written on a connection the aborted transaction has already
      // released, so it is neither rolled back with the take nor contending
      // with it. Durability was never the thing in question — deferring the
      // write must not have quietly dropped it.
      const log = await instruments.accessLogFor(SELLER, 100);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        ownerId: SELLER,
        viewerId: BUYER,
        outcome: 'denied',
        denyReason: 'take_refused',
        instrumentId: null,
        tradeId: null,
      });

      // And the take really did roll back: nothing else survived it.
      expect(await sql`SELECT id FROM p2p.p2p_trades`).toHaveLength(0);
      expect((await p2p.getOffer(offer!.id)).remainingAmt).toBe(amt('500'));
      expect(ledger.totalsByAsset()[ASSET] ?? '0').toBe('0');
    }, 30_000);

    it('loses none of them under the concurrency that used to wedge it', async () => {
      // The pool-saturating case is exactly where a deferred write would be
      // easiest to drop, so the count is asserted there and not only in the
      // single-take case above.
      await sellerInstrument();
      const made = await offers(POOL_MAX);
      await warmPool();

      await within(
        Promise.all(
          made.map((o) =>
            p2p
              .takeOffer({ offerId: o.id, takerId: BUYER, amount: amt('100'), method: 'zzz', tradeId: crypto.randomUUID() })
              .catch(() => null),
          ),
        ),
        WEDGED_AFTER_MS,
        [],
      );

      const log = await within(instruments.accessLogFor(SELLER, 100), 10_000, []);
      expect(log.filter((e) => e.outcome === 'denied' && e.denyReason === 'take_refused')).toHaveLength(POOL_MAX);
    }, 60_000);
  });

  // ── 3 · THE ORACLE STAYS CLOSED ───────────────────────────────────────────

  describe('the refusals are still indistinguishable', () => {
    /**
     * The two reasons a take can be refused on the method, put side by side.
     * If deferring the log write had let either of them acquire a distinct
     * code, message or log shape, the oracle #805 closed would be open again.
     */
    it('same error and same log row, whichever reason applied', async () => {
      await registerMethod('other-rail');

      // (a) Offer listed the method; destination removed after post.
      //     Refused inside `attachToTrade` (uniform take refuse).
      await sellerInstrument('other-rail');
      const [listed] = await offers(1, ['other-rail']);
      for (const h of await instruments.listInstruments(SELLER, false, 200)) {
        if (h.status === 'active') await instruments.removeInstrument({ instrumentId: h.id, ownerId: SELLER });
      }
      const a = await p2p
        .takeOffer({ offerId: listed!.id, takerId: BUYER, amount: amt('100'), method: 'other-rail', tradeId: crypto.randomUUID() })
        .then(
          () => null,
          (e: Error & { code?: string }) => ({ name: e.name, code: e.code, message: e.message }),
        );

      // (b) The offer lists other-rail; take tries METHOD which is not listed.
      //     Seller holds METHOD. Refused by methodAllowed path → same refuseTake.
      await sellerInstrument(METHOD);
      await sellerInstrument('other-rail');
      const [notListed] = await offers(1, ['other-rail']);
      const b = await p2p
        .takeOffer({ offerId: notListed!.id, takerId: BUYER, amount: amt('100'), method: METHOD, tradeId: crypto.randomUUID() })
        .then(
          () => null,
          (e: Error & { code?: string }) => ({ name: e.name, code: e.code, message: e.message }),
        );

      expect(a).toEqual(b);
      expect(a).toEqual({ name: 'InstrumentError', code: 'p2p.take_refused', message: TAKE_REFUSED_MESSAGE });
      // The message names nothing the caller was not entitled to know.
      expect(a!.message).not.toContain('other-rail');
      expect(a!.message).not.toContain(METHOD);
      expect(a!.message).not.toContain('USD');
      expect(a!.message).not.toContain(SELLER);

      // The log must not restore the distinction the response erased.
      const log = await instruments.accessLogFor(SELLER, 100);
      expect(log).toHaveLength(2);
      const shape = (e: (typeof log)[number]) => ({
        outcome: e.outcome,
        denyReason: e.denyReason,
        viewerRole: e.viewerRole,
        viewerId: e.viewerId,
        instrumentId: e.instrumentId,
        tradeId: e.tradeId,
      });
      expect(shape(log[0]!)).toEqual(shape(log[1]!));
    }, 30_000);
  });
});
