import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';

/**
 * A DISPUTED ESCROW TERMINATES ONLY ON AN ATTRIBUTED HUMAN RULING.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SUITE TOUCHES NO TYPESCRIPT AT ALL
 *
 * The two bypasses this exists for are both reachable without calling a single
 * method of `P2pService`. `state.ts` already forbids `disputed → escrowed`, and
 * `resolveDispute` already refuses to be called by anything without a
 * moderator's session — and neither of those facts is what protects the escrow,
 * because a migration, a fix-up script, a psql session or the next writer in
 * this service does not go through either of them. A service-level test of this
 * invariant proves the service is polite. It says nothing about the invariant.
 *
 * So every statement below is raw SQL against the real schema. If the trigger is
 * the thing holding the line, this is the only place the line can be measured.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS ACTUALLY REPRODUCED, before drizzle/0003
 *
 * Against `0000` + `0001`, four escrows terminated with the dispute row still
 * `open` or ruled by a machine, and the gate stayed green throughout:
 *
 *   cancelled/refunded  dispute open      ruled by (none)
 *   cancelled/refunded  dispute resolved  ruled by System:p2p-backstop
 *   cancelled/refunded  dispute resolved  ruled by automation:p2p
 *   cancelled/refunded  dispute resolved  ruled by p2p-backstop
 *
 * The first is the two-step un-dispute: `disputed → escrowed` (the trigger
 * fires and sleeps, `NEW.resolution` is NULL), then `escrowed → cancelled` with
 * a resolution (`OLD.status` is no longer `disputed`, so it never fires). The
 * other three are one case-sensitive `LIKE 'system:%'` denylist meeting three
 * spellings it did not enumerate.
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
  '0003_p2p_dispute_ruling_invariant.sql',
  '0005_p2p_late_settle_error.sql',
  '0006_p2p_dispute_open_origin.sql',
  '0007_p2p_dispute_chat_thread.sql',
  '0010_p2p_dispute_resolution_match.sql',
].map((file) => readFileSync(join(here, '..', 'drizzle', file), 'utf8'));

const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
/**
 * Deliberately carries hex LETTERS, unlike the all-digit moderator the other
 * suites use. The uppercase test below is vacuous against an id made only of
 * digits — `toUpperCase()` returns it unchanged — and a test that cannot fail
 * is the thing this whole branch is about.
 */
const MODERATOR = '4a4b4c4d-4e4f-4a4b-8c4d-4e4f5a6b7c8d';
const OFFER = '00000000-0000-4000-8000-0000000000f0';

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
      `H8a: svc-p2p dispute-ruling is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-p2p dispute ruling PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('p2p dispute ruling invariant', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'p2p', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  /** A trade sitting in `disputed`, holding escrow, with an OPEN dispute against it. */
  async function disputedTrade(id: string) {
    await sql`
      INSERT INTO p2p.p2p_trades (
        id, offer_id, taker_id, maker_id, seller_id, buyer_id, asset, fiat_currency,
        amount, price, fiat_amount, method, status, deadline_at, escrowed_at
      ) VALUES (
        ${id}, ${OFFER}, ${BUYER}, ${SELLER}, ${SELLER}, ${BUYER}, 'USDT', 'USD',
        100, 1, 100, 'sepa', 'disputed', now() + interval '7 days', now()
      )
    `;
    await sql`
      INSERT INTO p2p.p2p_disputes (trade_id, opened_by, deadline_at)
      VALUES (${id}, ${BUYER}, now() + interval '7 days')
    `;
    return id;
  }

  /** The terminal write a backstop timer would make. Resolves to the error, or null if it was ALLOWED. */
  async function terminate(id: string): Promise<string | null> {
    try {
      await sql`
        UPDATE p2p.p2p_trades
           SET status = 'cancelled', resolution = 'refunded', resolved_at = now(), deadline_at = NULL
         WHERE id = ${id}
      `;
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }

  /** A ruling, written the way `resolveDispute` writes it. */
  async function rule(id: string, moderatorId: string) {
    await sql`
      UPDATE p2p.p2p_disputes
         SET status = 'resolved', moderator_id = ${moderatorId}, resolution = 'refund', resolved_at = now()
       WHERE trade_id = ${id}
    `;
  }

  const statusOf = async (id: string) =>
    (await sql<Array<{ status: string }>>`SELECT status FROM p2p.p2p_trades WHERE id = ${id}`)[0]!.status;

  beforeEach(async () => {
    // The dispute record is not deletable by design (0003 STEP 4). TRUNCATE is
    // not a DELETE and fires no row trigger, which is exactly the distinction
    // that makes the guard safe to add: a test can reset a table, a session
    // cannot erase one person's account of a disagreement.
    await sql`TRUNCATE p2p.p2p_disputes, p2p.p2p_trades, p2p.offers RESTART IDENTITY CASCADE`;
    await sql`
      INSERT INTO p2p.offers (id, maker_id, side, asset, fiat_currency, price_type, price, min_amt, max_amt, total_amt, remaining_amt, methods)
      VALUES (${OFFER}, ${SELLER}, 'sell', 'USDT', 'USD', 'fixed', 1, 10, 500, 500, 400, '["sepa"]'::jsonb)
    `;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  describe('the terminal write must be the ruling the dispute holds', () => {
    /**
     * 0003 reads dispute status and moderator_id and then accepts any terminal
     * resolution. A refund already ruled by a person still lets the trade become
     * released, and settleOnce posts escrowRelease from that row. voided is the
     * same hole and posts nothing. The write is refused here so settleOnce never
     * sees it. A release that matches a release ruling still goes through.
     */
    it('refuses a release or a void that is not the human ruling, and still allows a matching release', async () => {
      const refunded = await disputedTrade('00000000-0000-4000-8000-000000000040');
      await rule(refunded, MODERATOR);

      await expect(sql`
        UPDATE p2p.p2p_trades
           SET status = 'released', resolution = 'released', resolved_at = now(), deadline_at = NULL
         WHERE id = ${refunded}
      `).rejects.toMatchObject({
        code: '23514',
        message: expect.stringMatching(/does not match the human ruling/),
      });

      const refundedRow = (
        await sql<Array<{ status: string; resolution: string | null }>>`
          SELECT status, resolution::text AS resolution FROM p2p.p2p_trades WHERE id = ${refunded}
        `
      )[0]!;
      expect(refundedRow).toEqual({ status: 'disputed', resolution: null });

      const voided = await disputedTrade('00000000-0000-4000-8000-000000000041');
      await rule(voided, MODERATOR);

      await expect(sql`
        UPDATE p2p.p2p_trades
           SET status = 'cancelled', resolution = 'voided', resolved_at = now(), deadline_at = NULL
         WHERE id = ${voided}
      `).rejects.toMatchObject({
        code: '23514',
        message: expect.stringMatching(/does not match the human ruling/),
      });

      const voidedRow = (
        await sql<Array<{ status: string; resolution: string | null }>>`
          SELECT status, resolution::text AS resolution FROM p2p.p2p_trades WHERE id = ${voided}
        `
      )[0]!;
      expect(voidedRow).toEqual({ status: 'disputed', resolution: null });

      const released = await disputedTrade('00000000-0000-4000-8000-000000000042');
      await sql`
        UPDATE p2p.p2p_disputes
           SET status = 'resolved', moderator_id = ${MODERATOR}, resolution = 'release', resolved_at = now()
         WHERE trade_id = ${released}
      `;
      await sql`
        UPDATE p2p.p2p_trades
           SET status = 'released', resolution = 'released', resolved_at = now(), deadline_at = NULL
         WHERE id = ${released}
      `;
      expect(await statusOf(released)).toBe('released');

      const fn = await sql<Array<{ prosrc: string }>>`
        SELECT p.prosrc
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'p2p' AND p.proname = 'p2p_trades_disputed_needs_ruling'
      `;
      expect(fn[0]!.prosrc).toMatch(/SELECT true, "status"::text, "moderator_id", "resolution"::text/);
    });
  });

  describe('the ruling that terminates an escrow', () => {
    it('accepts a real one — an attributed person, on a resolved dispute', async () => {
      // FIRST, because everything below is a refusal and a rule that refuses
      // everything is not protecting anything. This is the shape
      // `resolveDispute` writes, and it must go through.
      const id = await disputedTrade('00000000-0000-4000-8000-000000000001');
      await rule(id, MODERATOR);

      expect(await terminate(id)).toBeNull();
      expect(await statusOf(id)).toBe('cancelled');
    });

    it('refuses the one-statement termination with no ruling at all', async () => {
      const id = await disputedTrade('00000000-0000-4000-8000-000000000002');

      expect(await terminate(id)).toMatch(/terminates only on a human ruling/);
      expect(await statusOf(id)).toBe('disputed');
    });
  });

  describe('bypass 1 · the two-step un-dispute', () => {
    /**
     * Step one on its own. Before 0003 this was silently legal — the trigger
     * fired, saw `NEW.resolution IS NULL`, and returned. It is the statement
     * that makes the second one work, so it is the statement that should fail.
     */
    it('refuses to move a disputed trade back to a live state', async () => {
      const id = await disputedTrade('00000000-0000-4000-8000-000000000003');

      await expect(sql`UPDATE p2p.p2p_trades SET status = 'escrowed' WHERE id = ${id}`).rejects.toThrow(/cannot return to a live state/);
      expect(await statusOf(id)).toBe('disputed');
    });

    /**
     * Step two, proved INDEPENDENTLY of step one.
     *
     * The trigger is disabled for the un-dispute so the row reaches the exact
     * state the bypass produced — `status = 'escrowed'`, dispute row still
     * `open` — and then re-enabled. That is not a shortcut around the thing
     * under test: it is how the second leg is measured on its own, because with
     * step one now refused there is no other way to construct the state, and
     * "the second leg is covered by the first" is precisely the reasoning that
     * left one statement's `OLD.status` holding an invariant.
     */
    it('refuses the terminal write even once the trade has stopped saying `disputed`', async () => {
      const id = await disputedTrade('00000000-0000-4000-8000-000000000004');

      await sql`ALTER TABLE p2p.p2p_trades DISABLE TRIGGER p2p_trades_disputed_needs_ruling_trg`;
      await sql`UPDATE p2p.p2p_trades SET status = 'escrowed' WHERE id = ${id}`;
      await sql`ALTER TABLE p2p.p2p_trades ENABLE TRIGGER p2p_trades_disputed_needs_ruling_trg`;

      expect(await statusOf(id)).toBe('escrowed');
      expect(await terminate(id)).toMatch(/terminates only on a human ruling/);
      expect(await statusOf(id)).toBe('escrowed');
    });

    it('refuses to delete the dispute record that says the trade is under dispute', async () => {
      // The last leg. With the guard above keyed on "a dispute row exists",
      // deleting the row is what would be tried next.
      const id = await disputedTrade('00000000-0000-4000-8000-000000000005');

      await expect(sql`DELETE FROM p2p.p2p_disputes WHERE trade_id = ${id}`).rejects.toThrow(/cannot be deleted/);
      expect(await sql`SELECT 1 FROM p2p.p2p_disputes WHERE trade_id = ${id}`).toHaveLength(1);
    });
  });

  describe('bypass 2 · who is allowed to have ruled', () => {
    /**
     * Every one of these defeated `d_moderator LIKE 'system:%'`. They are not
     * exotic — they are the first four things anyone writes.
     */
    const notPeople = [
      ['System:p2p-backstop', 'the same principal, one capital letter — LIKE is case-sensitive'],
      ['SYSTEM:p2p-backstop', 'and in caps'],
      ['automation:p2p', 'a different namespace for the same kind of thing'],
      ['p2p-backstop', 'no namespace at all, which the prefix rule never looked for'],
      ['system:p2p-backstop', 'the ONE spelling the old denylist did catch — it must still be caught'],
      [MODERATOR.slice(0, -1), 'a UUID one digit short is not an account'],
      [`${MODERATOR} `, 'a trailing space is a different string and not an id'],
      ['', 'the empty string satisfied "is not null" and "does not start with system:"'],
    ] as const;

    notPeople.forEach(([moderatorId, why], index) => {
      it(`refuses a ruling attributed to ${JSON.stringify(moderatorId)} — ${why}`, async () => {
        const id = await disputedTrade(`00000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`);

        // The CHECK refuses to record the attribution in the first place.
        await expect(rule(id, moderatorId)).rejects.toThrow(/p2p_disputes_moderator_is_a_person_ck/);
        // And the escrow does not move, because nothing ruled.
        expect(await terminate(id)).toMatch(/terminates only on a human ruling/);
        expect(await statusOf(id)).toBe('disputed');
      });
    });

    /**
     * An UPPERCASE canonical UUID is the same case bypass one layer in, and it
     * is the reason this is a lowercase rule rather than a case-insensitive
     * one — svc-ledger 0005 STEP 1 made the identical call for `owner_id`.
     */
    it('refuses an uppercase UUID — one person, two strings, is how the case hole gets back in', async () => {
      const id = await disputedTrade('00000000-0000-4000-8000-000000000020');
      await expect(rule(id, MODERATOR.toUpperCase())).rejects.toThrow(/p2p_disputes_moderator_is_a_person_ck/);
    });

    /**
     * DEFENCE IN DEPTH, MEASURED.
     *
     * With the CHECK dropped — which is what a database that applied `0000` but
     * not `0003` STEP 2 looks like, and what one bad `DROP CONSTRAINT` makes of
     * any other — the TRIGGER must still refuse. The two are not one guard
     * written twice: the CHECK stops the attribution being recorded, the
     * trigger stops the escrow moving on it, and only the second is about
     * money. Rolled back, so the constraint outlives this test.
     */
    it('still refuses the escrow movement when the CHECK on the dispute row is gone', async () => {
      const id = await disputedTrade('00000000-0000-4000-8000-000000000021');

      await expect(
        sql.begin(async (tx) => {
          await tx`ALTER TABLE p2p.p2p_disputes DROP CONSTRAINT p2p_disputes_moderator_is_a_person_ck`;
          await tx`
            UPDATE p2p.p2p_disputes
               SET status = 'resolved', moderator_id = 'System:p2p-backstop', resolution = 'refund', resolved_at = now()
             WHERE trade_id = ${id}
          `;
          await tx`
            UPDATE p2p.p2p_trades
               SET status = 'cancelled', resolution = 'refunded', resolved_at = now(), deadline_at = NULL
             WHERE id = ${id}
          `;
        }),
      ).rejects.toThrow(/terminates only on a human ruling/);

      expect(await statusOf(id)).toBe('disputed');
      expect(await sql`SELECT 1 FROM pg_constraint WHERE conname = 'p2p_disputes_moderator_is_a_person_ck'`).toHaveLength(1);
    });
  });

  describe('what it deliberately does not constrain', () => {
    /**
     * `timeoutActionFor('disputed')` returns `escalate_dispute`, which re-arms
     * the trade's deadline so the row stays swept and stays loud without
     * disposing of anything. A guard that also blocked THAT would force the
     * dispute out of the sweeper to satisfy `p2p_trades_live_has_deadline_ck`,
     * which is the stranded-escrow shape the deadline constraint exists to make
     * unrepresentable.
     */
    it('lets an escalation re-arm a disputed trade’s deadline', async () => {
      const id = await disputedTrade('00000000-0000-4000-8000-000000000030');

      await sql`UPDATE p2p.p2p_trades SET deadline_at = now() + interval '1 hour' WHERE id = ${id}`;
      expect(await statusOf(id)).toBe('disputed');
    });

    it('says nothing about a trade nobody ever disputed', async () => {
      // `escrowed → cancelled` on a clock is a stall being unwound, and
      // unwinding is what everyone's silence meant. state.ts explains why this
      // asymmetry is the guarantee rather than a hole in it.
      const id = '00000000-0000-4000-8000-000000000031';
      await sql`
        INSERT INTO p2p.p2p_trades (
          id, offer_id, taker_id, maker_id, seller_id, buyer_id, asset, fiat_currency,
          amount, price, fiat_amount, method, status, deadline_at, escrowed_at
        ) VALUES (
          ${id}, ${OFFER}, ${BUYER}, ${SELLER}, ${SELLER}, ${BUYER}, 'USDT', 'USD',
          100, 1, 100, 'sepa', 'escrowed', now() + interval '15 minutes', now()
        )
      `;

      expect(await terminate(id)).toBeNull();
      expect(await statusOf(id)).toBe('cancelled');
    });
  });
});
