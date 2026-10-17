import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { isValidOwnerId, type OwnerType } from '@intafaced/ledger-client';
import { disableBalanceTrigger } from '../db/journal-guards.testkit.js';

/**
 * THE INVARIANT LIVES IN POSTGRES (§4.2), AND THE MIGRATION THAT PUT IT THERE
 * IS SAFE ON A POPULATED TABLE.
 *
 * Two separate claims, and neither is provable by the client-side suite:
 *
 *   1. `accounts_owner_id_space_ck` refuses a wrong-space owner_id against a
 *      raw INSERT — i.e. with `ledger-client` and its assertions entirely out
 *      of the picture. Application-only enforcement is bypassable by exactly
 *      the kind of caller this exists to protect against: an adapter bridging a
 *      Java stack, which is the least likely thing in the OS to route through a
 *      TypeScript client library.
 *
 *   2. Migration 0005 does the right thing on a table that ALREADY HAS ROWS. A
 *      constraint added ahead of its backfill passes on an empty database and
 *      fails on a real one. That is not a test that goes red; it is a deploy
 *      that stops in the middle, and this repo has already paid for it once
 *      (13 of 16 services). So the populated cases are built here explicitly:
 *      the migration is run against rows that violate it in each of the three
 *      ways it can be violated, and its handling of each is asserted.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run schema via `createTestDb`). Local without that env
 * starts Testcontainers `postgres:16-alpine`. Docker/PG down is a failed suite,
 * not a green skip.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

const allMigrationFiles = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort();

/** Everything before the one under test — the schema as it exists in production today. */
const PRIOR = allMigrationFiles.filter((f) => !f.startsWith('0005_'));
const UP = readFileSync(join(drizzleDir, '0005_owner_identifier_space.sql'), 'utf8');
const DOWN = readFileSync(join(drizzleDir, '0005_owner_identifier_space.down.sql'), 'utf8');

const read = (f: string) => readFileSync(join(drizzleDir, f), 'utf8');
const priorMigrations = PRIOR.map((f) => (schema: string) => rewriteSchemaSql(read(f), 'ledger', schema));
const allMigrations = allMigrationFiles.map((f) => (schema: string) => rewriteSchemaSql(read(f), 'ledger', schema));

/** A real `identity.users.id`. */
const USER = '0007e7f3-2e25-4dc9-88b4-146db6d491f0';
const USER_2 = '4286702e-ae18-4d68-8764-62d4b53cc145';
/** The vendored `Member.id` — a `Long` — once it has crossed a wire as a string. */
const MEMBER_ID = '1042';

const CHECK_VIOLATION = '23514';

/**
 * The asset these drift rows are written in.
 *
 * It used to be the sentinel string 'DRIFT', which was convenient for cleanup
 * and is now impossible: 0006 added `accounts_asset_id_fk`, so an account may
 * only exist in an asset `ledger.assets` actually carries. Seeding a fake one to
 * keep the sentinel would have been the exact move 0006 refuses — blessing an
 * asset nothing can settle. A real seeded asset costs this test nothing; it
 * isolates by schema, not by asset.
 */
const DRIFT_ASSET = 'USDT';

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
      `H8a: svc-ledger owner-identity is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-ledger owner-identity PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-ledger owner identity', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let adminUrl: string | undefined;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    adminUrl = admin.url;
  }, 120_000);

  afterAll(async () => {
    await adminStop();
  }, 30_000);

  // ───────────────────────────────────────────────────────────────────────────
  describe('accounts_owner_id_space_ck — enforced by the database, not by the caller', () => {
    let db: TestDb | undefined;

    beforeAll(async () => {
      if (!adminUrl) throw new Error('H8a: test db not opened');
      db = await createTestDb({ service: 'ledger_ownerid', url: adminUrl, migrations: allMigrations });
    }, 120_000);
    afterAll(async () => {
      await db?.drop();
    }, 30_000);

    const insert = (ownerType: string, ownerId: string) => {
      if (!db) throw new Error('H8a: test db not opened');
      return db.sql`
        INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
        VALUES (${ownerType}::owner_type, ${ownerId}, 'USDT', 'available'::account_kind, '')
      `;
    };

    it('REFUSES a vendored bigint member id in a user account — raw SQL, no client library', async () => {
      // This is the finding. Before 0005 this INSERT succeeded, and the row it
      // created was a second complete book for a human who already had one:
      // non-negative, sum-to-zero, hash-chained, reconciling, invisible.
      await expect(insert('user', MEMBER_ID)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it('refuses an uppercase UUID — same human, second row', async () => {
      await expect(insert('user', USER.toUpperCase())).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it('refuses a UUID in a treasury account — the confusion running the other way', async () => {
      await expect(insert('treasury', USER)).rejects.toMatchObject({ code: CHECK_VIOLATION });
      // A UUID starting with a hex letter satisfies the slug grammar unaided.
      await expect(insert('house', 'a50e8400-e29b-41d4-a716-446655440000')).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it('refuses an UPDATE that moves an existing account into the wrong space', async () => {
      if (!db) throw new Error('H8a: test db not opened');
      await insert('user', USER);
      await expect(db.sql`UPDATE accounts SET owner_id = ${MEMBER_ID} WHERE owner_id = ${USER}`).rejects.toMatchObject({
        code: CHECK_VIOLATION,
      });
      await db.sql`DELETE FROM accounts WHERE owner_id = ${USER}`;
    });

    /**
     * THE DRIFT GUARD.
     *
     * `isValidOwnerId` and the CHECK are two copies of one rule in two
     * languages. A comment asserting they agree is not evidence. Every case is
     * therefore put to both, and the two answers must be the same answer — so a
     * future edit to one that is not mirrored in the other fails here rather
     * than in production, where the disagreement would show up as the client
     * accepting what the database then rejects (a 500 on a money path) or, far
     * worse, as the client accepting what the database also accepts because
     * someone loosened both without noticing what the second one was for.
     */
    const CASES: Array<[OwnerType, string]> = [
      ['user', USER],
      ['user', MEMBER_ID],
      ['user', USER.toUpperCase()],
      ['user', '0'],
      ['user', 'alice'],
      ['user', ''],
      ['user', `${USER} `],
      ['user', `${USER}\n`],
      ['subaccount', USER_2],
      ['subaccount', MEMBER_ID],
      ['module', 'bank:loan-reserve'],
      ['module', `pay:clearing:${USER_2}`],
      ['module', 'bank:earn:pool-1'],
      ['module', MEMBER_ID],
      ['module', USER],
      ['house', 'fees:trade'],
      ['house', 'insurance-fund'],
      ['house', 'market-maker'],
      ['house', 'rewards-engine'],
      ['house', 'burn'],
      ['house', 'Fees:Trade'],
      ['house', ':leading-colon'],
      ['treasury', 'rail:card-sandbox'],
      ['treasury', 'mint'],
      ['treasury', 'bridge:ethereum'],
      ['treasury', 'venue:BINANCE'],
      ['treasury', '1042'],
    ];

    it('agrees with isValidOwnerId on every case, in both directions', async () => {
      if (!db) throw new Error('H8a: test db not opened');
      const disagreements: string[] = [];

      for (const [ownerType, ownerId] of CASES) {
        const client = isValidOwnerId(ownerType, ownerId);
        let database: boolean;
        try {
          await db.sql`
            INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
            VALUES (${ownerType}::owner_type, ${ownerId}, ${DRIFT_ASSET}, 'available'::account_kind, '')
          `;
          database = true;
        } catch (err) {
          if ((err as { code?: string }).code !== CHECK_VIOLATION) throw err;
          database = false;
        }
        if (client !== database) {
          disagreements.push(`${ownerType} / ${JSON.stringify(ownerId)}: client=${client} database=${database}`);
        }
      }

      await db.sql`DELETE FROM accounts WHERE asset_id = ${DRIFT_ASSET}`;
      expect(disagreements).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('migration 0005 on a POPULATED table', () => {
    /**
     * Builds the schema at 0004 — production today — and fills it with rows that
     * look like the live book does (47 user accounts on UUIDs, house fees,
     * a negative treasury rail), plus whatever violations the case under test
     * needs. `apply` then runs 0005 against it, exactly as a deploy would.
     */
    async function populated(seed: (db: TestDb) => Promise<void>): Promise<TestDb> {
      if (!adminUrl) throw new Error('H8a: test db not opened');
      const db = await createTestDb({ service: 'ledger_ownerid_mig', url: adminUrl, migrations: priorMigrations });

      await db.sql`
        INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose, balance) VALUES
          ('user'::owner_type,     ${USER},   'USDT', 'available'::account_kind, '',                 900),
          ('user'::owner_type,     ${USER},   'USDT', 'hold'::account_kind,      'order:abc',          0),
          ('user'::owner_type,     ${USER_2}, 'USDT', 'available'::account_kind, '',                 500),
          ('house'::owner_type,    'fees:trade',        'USDT', 'available'::account_kind, '',        0.4),
          ('treasury'::owner_type, 'rail:card-sandbox', 'USDT', 'available'::account_kind, '',   -11020)
      `;
      // Seeds write one-sided journal entries on purpose; 0023's balance-at-commit
      // trigger is tested in journal-immutable.db.test.ts.
      await disableBalanceTrigger(db.sql);
      await seed(db);
      return db;
    }

    const apply = (db: TestDb) => db.sql.unsafe(rewriteSchemaSql(UP, 'ledger', db.schema));

    it('REFUSES to apply while a wrong-space account still holds value, and names it', async () => {
      // The whole point of ordering backfill before constraint. This must fail
      // at migrate time on the populated database, not succeed on an empty one.
      const db = await populated(async (d) => {
        await d.sql`
          INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose, balance)
          VALUES ('user'::owner_type, ${MEMBER_ID}, 'USDT', 'available'::account_kind, '', 250)
        `;
      });

      try {
        await expect(apply(db)).rejects.toThrow(/1042/);

        // And it left nothing half-applied: the file runs as one implicit
        // transaction, so the canonicalisation and the reclaim roll back with it.
        //
        // Scoped to THIS suite's schema. `pg_constraint` is database-wide, and
        // every other suite in this file — and `postgres-ledger.test.ts` —
        // creates a schema carrying the same constraint name. An unscoped query
        // passes alone and fails under parallel load, which is the flake shape
        // this repo already pays for elsewhere.
        const constraints = await db.sql<Array<{ conname: string }>>`
          SELECT c.conname
            FROM pg_constraint c
            JOIN pg_class      t ON t.oid = c.conrelid
            JOIN pg_namespace  n ON n.oid = t.relnamespace
           WHERE c.conname = 'accounts_owner_id_space_ck' AND n.nspname = ${db.schema}
        `;
        expect(constraints).toHaveLength(0);
        const rows = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM accounts`;
        expect(rows[0]?.n).toBe('6');
      } finally {
        await db.drop();
      }
    });

    it('applies cleanly on data that is already conformant, changing nothing', async () => {
      const db = await populated(async () => undefined);
      try {
        const before = await db.sql`SELECT owner_type, owner_id, asset_id, kind, purpose, balance FROM accounts ORDER BY id`;
        await apply(db);
        const after = await db.sql`SELECT owner_type, owner_id, asset_id, kind, purpose, balance FROM accounts ORDER BY id`;
        expect(after).toEqual(before);
      } finally {
        await db.drop();
      }
    });

    it('canonicalises an uppercase UUID rather than refusing it — and keeps its balance exactly', async () => {
      const db = await populated(async (d) => {
        await d.sql`
          INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose, balance)
          VALUES ('user'::owner_type, ${USER_2.toUpperCase()}, 'BTC', 'available'::account_kind, '', 1.234567890123456789)
        `;
      });

      try {
        await apply(db);
        const rows = await db.sql<Array<{ owner_id: string; balance: string }>>`
          SELECT owner_id, balance FROM accounts WHERE asset_id = 'BTC'
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.owner_id).toBe(USER_2);
        // 18dp preserved through the backfill. Money never passes through a float.
        expect(rows[0]?.balance).toBe('1.234567890123456789');
      } finally {
        await db.drop();
      }
    });

    it('refuses to lowercase into a collision — merging two balances is a post, not an UPDATE', async () => {
      const db = await populated(async (d) => {
        // Same human, same asset, same kind — one row shouted, one row canonical.
        await d.sql`
          INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose, balance)
          VALUES ('user'::owner_type, ${USER.toUpperCase()}, 'USDT', 'available'::account_kind, '', 100)
        `;
      });

      try {
        await expect(apply(db)).rejects.toThrow(/case/i);
      } finally {
        await db.drop();
      }
    });

    it('reclaims a wrong-space account that provably never held anything', async () => {
      const db = await populated(async (d) => {
        await d.sql`
          INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose, balance)
          VALUES ('user'::owner_type, '2001', 'USDT', 'available'::account_kind, '', 0)
        `;
      });

      try {
        await apply(db);
        const rows = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM accounts WHERE owner_id = '2001'`;
        expect(rows[0]?.n).toBe('0');
        // The five legitimate rows are untouched.
        const all = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM accounts`;
        expect(all[0]?.n).toBe('5');
      } finally {
        await db.drop();
      }
    });

    it('does NOT reclaim a zero-balance account that appears in the journal — that is an audit trail', async () => {
      const db = await populated(async (d) => {
        const inserted = await d.sql<Array<{ id: string }>>`
          INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose, balance)
          VALUES ('user'::owner_type, '2002', 'USDT', 'available'::account_kind, '', 0)
          RETURNING id
        `;
        const tx = await d.sql<Array<{ id: string }>>`
          INSERT INTO ledger_tx (idempotency_key, module, reason, hash)
          VALUES ('vendor:increase:2002', 'adapter', 'vendor.balance.increase', 'deadbeef')
          RETURNING id
        `;
        await d.sql`
          INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
          VALUES (${tx[0]!.id}, ${inserted[0]!.id}, 'USDT', 'debit'::direction, 5, 0)
        `;
      });

      try {
        // It moved value once. Deleting it would erase the only record that the
        // adapter ever wrote to the wrong owner — so the migration refuses and
        // makes a human look at it.
        await expect(apply(db)).rejects.toThrow(/2002/);
      } finally {
        await db.drop();
      }
    });

    it('is reversible, and re-applies', async () => {
      const db = await populated(async () => undefined);
      try {
        await apply(db);
        await expect(
          db.sql`
            INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
            VALUES ('user'::owner_type, ${MEMBER_ID}, 'USDT', 'available'::account_kind, '')
          `,
        ).rejects.toMatchObject({ code: CHECK_VIOLATION });

        await db.sql.unsafe(rewriteSchemaSql(DOWN, 'ledger', db.schema));

        // Reversed means the door is open again. That is what reversal MEANS
        // here, and it is why the down migration says so in as many words.
        await db.sql`
          INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
          VALUES ('user'::owner_type, ${MEMBER_ID}, 'USDT', 'available'::account_kind, '')
        `;
        await db.sql`DELETE FROM accounts WHERE owner_id = ${MEMBER_ID}`;

        await apply(db);
        await expect(
          db.sql`
            INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
            VALUES ('user'::owner_type, ${MEMBER_ID}, 'USDT', 'available'::account_kind, '')
          `,
        ).rejects.toMatchObject({ code: CHECK_VIOLATION });
      } finally {
        await db.drop();
      }
    });
  });
});
