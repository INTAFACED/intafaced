import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import * as schema from './schema.js';

/**
 * THE SCHEMA DRIFT GATE.
 *
 *
 * WHAT WENT WRONG, AND WHY A TEST RATHER THAN CARE.
 *
 * `drizzle/*.sql` and `src/db/schema.ts` are two descriptions of one database.
 * The migrations have run against real data and are immutable; `schema.ts` has
 * never run against anything. Nothing kept them honest, so `schema.ts` fell
 * four migrations behind: no `purpose` column, the pre-0001 identity index,
 * and none of the eight CHECK constraints.
 *
 * A stale ORM file is normally a nuisance. This one was a loaded gun, because
 * `schema.ts` is an INPUT to a code generator. Diffing the drifted file against
 * a snapshot of the database as it actually is emits 21 statements, of which
 * fifteen drop something. All 21 are reproduced in schema.ts's header; the ones
 * that matter are:
 *
 *     ALTER TABLE "ledger"."accounts" DROP CONSTRAINT "accounts_hold_purposed_ck";
 *     ALTER TABLE "ledger"."accounts" DROP CONSTRAINT "accounts_non_negative_ck";
 *     ALTER TABLE "ledger"."accounts" DROP CONSTRAINT "accounts_owner_id_space_ck";
 *     ALTER TABLE "ledger"."ledger_entries" DROP CONSTRAINT "ledger_entries_positive_ck";
 *     DROP INDEX "ledger"."accounts_identity_purpose_idx";
 *     ALTER TABLE "ledger"."accounts" DROP COLUMN "purpose";
 *
 * Every database-level money invariant in §4.2, removed by someone doing nothing
 * worse than regenerating a migration in good faith. Reviewing that diff would
 * require noticing which few of twenty-one lines are the ones that stop two
 * loans in one asset unsecuring each other.
 *
 * So the gate is not "remember to check". It is: build the database BOTH ways
 * and require them to be the same database.
 *
 *
 * HOW IT WORKS.
 *
 *   Side A — the truth. A per-run database with `drizzle/*.sql` applied
 *            verbatim, in order. This is what production has.
 *   Side B — the claim. A per-run database with the DDL drizzle-kit generates
 *            from `schema.ts` against an empty state. That is the whole of what
 *            this file asserts the database looks like, expressed as SQL by the
 *            same generator that would later be asked to migrate towards it.
 *
 * Then both are read back out of `pg_catalog` / `information_schema` and
 * compared: columns, constraints (including every CHECK), indexes, enums.
 *
 *
 * WHY THE COMPARISON IS THROUGH POSTGRES AND NOT THROUGH drizzle-kit.
 *
 * The obvious gate is `pushSchema()` — ask drizzle-kit to diff `schema.ts`
 * against a live database and assert it wants to change nothing. It cannot be
 * used here: on drizzle-kit 0.30.6 it throws while introspecting this schema,
 *
 *     TypeError: Cannot read properties of undefined (reading 'map')
 *       at fromDatabase (drizzle-kit/api.js:30718)
 *
 * — before producing any statement at all, for `schema.ts` correct and drifted
 * alike. A gate that cannot run is not a gate.
 *
 * It would be the wrong shape even if it ran. Push compares drizzle-kit's own
 * rendering of `schema.ts` against its own re-parse of what it pulled back out
 * of Postgres, so the two sides are normalised by different code paths and
 * disagree on formatting: parenthesisation of a CASE expression, the spelling
 * of a numeric default, the presence of a cast. Each disagreement is a
 * difference the gate would report against a clean tree — and a gate that fires
 * on a clean tree gets disabled, after which the real drift walks through the
 * hole where it used to be.
 *
 * Both sides of THIS comparison are rendered by the same Postgres deparser, so
 * formatting, parenthesisation, quoting, casing and type-cast spelling are
 * normalised away before anything is compared. That is what lets the assertion
 * be exact — no allowlist of "known acceptable differences", because such a
 * list is where a dropped constraint eventually goes to hide.
 *
 * The cost is two `CREATE DATABASE` round trips. The thing it protects is every
 * money invariant §4.2 pushed down into the database on purpose.
 *
 *
 * WHEN THIS TEST GOES RED.
 *
 * Almost always the fix is to correct `schema.ts`, because the migrations have
 * already run somewhere and it has not. Changing an applied migration to match
 * the ORM file is rewriting history and is never the answer. If the database
 * genuinely needs to change, write a NEW migration (backfill before you
 * constrain) and then update `schema.ts` to match it.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so catalog
 * snapshots stay on the real `ledger` schema). Local without that env starts
 * Testcontainers `postgres:16-alpine`. Docker/PG down is a failed suite, not a
 * green skip.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

/**
 * Read from disk, never listed here — a hardcoded list silently stops covering
 * the newest migration, which is precisely the one most likely to have drifted.
 */
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

if (migrations.length === 0) throw new Error(`No migrations found in ${drizzleDir}`);

/**
 * drizzle-kit's ESM build (`api.mjs`) throws `Dynamic require of "fs" is not
 * supported` on import. The CJS build is the same code and loads fine.
 */
const require_ = createRequire(import.meta.url);
const drizzleKit = require_('drizzle-kit/api') as {
  generateDrizzleJson: (imports: Record<string, unknown>) => unknown;
  generateMigration: (prev: unknown, cur: unknown) => Promise<string[]>;
};

interface CatalogSnapshot {
  columns: string[];
  constraints: string[];
  indexes: string[];
  enums: string[];
}

/**
 * Everything about the `ledger` schema that a migration could get wrong, as
 * sorted, comparable strings.
 *
 * `pg_get_constraintdef` and `pg_indexes.indexdef` are Postgres's own canonical
 * renderings — the reason this comparison can be exact.
 */
async function snapshotCatalog(db: TestDatabase): Promise<CatalogSnapshot> {
  const columns = await db.sql<Array<Record<string, unknown>>>`
    SELECT table_name, column_name, udt_name, is_nullable, column_default,
           numeric_precision, numeric_scale
      FROM information_schema.columns
     WHERE table_schema = 'ledger'
     ORDER BY table_name, column_name
  `;

  const constraints = await db.sql<Array<Record<string, unknown>>>`
    SELECT rel.relname AS table_name, con.conname AS name, con.contype AS type,
           pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = con.connamespace
     WHERE nsp.nspname = 'ledger'
       -- 't' = constraint TRIGGER (0023's balance-at-commit). A trigger is behaviour,
       -- not a table shape drizzle's schema can describe; journal-immutable.db.test.ts
       -- executes it instead.
       AND con.contype <> 't'
     ORDER BY rel.relname, con.conname
  `;

  const indexes = await db.sql<Array<Record<string, unknown>>>`
    SELECT indexname AS name, indexdef AS definition
      FROM pg_indexes WHERE schemaname = 'ledger' ORDER BY indexname
  `;

  const enums = await db.sql<Array<Record<string, unknown>>>`
    SELECT t.typname AS name, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'ledger'
     GROUP BY t.typname
     ORDER BY t.typname
  `;

  const render = (rows: Array<Record<string, unknown>>) => rows.map((r) => JSON.stringify(r)).sort();

  return {
    columns: render(columns),
    constraints: render(constraints),
    indexes: render(indexes),
    enums: render(enums),
  };
}

/** What `pnpm db:generate` would emit from `schema.ts` against an empty database. */
async function generateFromSchemaTs(): Promise<string[]> {
  const empty = drizzleKit.generateDrizzleJson({});
  const current = drizzleKit.generateDrizzleJson(schema as unknown as Record<string, unknown>);
  return drizzleKit.generateMigration(empty, current);
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
      `H8a: svc-ledger schema-drift is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-ledger schema-drift PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });

  it('outbox amount CHECK has no SQL subquery (Postgres forbids it)', () => {
    const historical = readFileSync(join(drizzleDir, '0013_tx_posted_outbox.sql'), 'utf8');
    const live = readFileSync(join(drizzleDir, '0019_outbox_amount_string.sql'), 'utf8');
    const orm = readFileSync(join(here, 'schema.ts'), 'utf8');
    const weak = "jsonb_typeof(payload) = 'object' AND jsonb_typeof(payload->'entries') = 'array'";
    const numberRule =
      "jsonb_typeof(payload) = 'object' AND jsonb_exists(payload, 'entries') AND jsonb_typeof(payload->'entries') = 'array' AND NOT jsonb_path_exists(payload, '$.entries[*].amount ? (@.type() == \"number\")')";
    expect(historical).toContain(`CONSTRAINT "ledger_tx_outbox_amount_string_ck" CHECK (${weak})`);
    const tsCheck = orm.match(/'ledger_tx_outbox_amount_string_ck',\s*sql`([^`]+)`/)?.[1];
    expect(tsCheck).toBeTruthy();
    expect(tsCheck).not.toMatch(/\bSELECT\b|jsonb_array_elements/i);
    expect(tsCheck).not.toBe(weak);
    expect(tsCheck).not.toBe(numberRule);
    const flat = (s: string) => s.replace(/\s+/g, ' ');
    expect(flat(live)).toContain(flat(tsCheck!));
  });
});

describe('svc-ledger — src/db/schema.ts matches drizzle/ (the applied migrations)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let fromMigrations: TestDatabase | undefined;
  let fromSchemaTs: TestDatabase | undefined;
  let truth: CatalogSnapshot | undefined;
  let claim: CatalogSnapshot | undefined;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    fromMigrations = await createTestDatabase({ service: 'ledger', url: admin.url, migrations });

    const generated = await generateFromSchemaTs();
    fromSchemaTs = await createTestDatabase({
      service: 'ledger',
      url: admin.url,
      // The generated DDL creates `ledger` itself; createTestDatabase already made
      // an empty one, so drop it first and let the generator own the whole schema.
      migrations: ['DROP SCHEMA IF EXISTS "ledger" CASCADE;', ...generated],
    });

    truth = await snapshotCatalog(fromMigrations);
    claim = await snapshotCatalog(fromSchemaTs);
  }, 120_000);

  /**
   * CLEANUP MUST NOT BE ABLE TO FAIL THIS GATE.
   *
   * This suite is the only one in the repo that builds TWO per-run databases,
   * so it pays `DROP DATABASE ... WITH (FORCE)` twice. Serially, inside
   * vitest's default 10s hook budget, that is enough to blow the budget when
   * `turbo run test` has the whole monorepo hitting one Postgres: the first
   * full-suite run of this gate went red with
   *
   *     FAIL src/db/schema-drift.test.ts
   *     Error: Hook timed out in 10000ms.
   *
   * with all 104 assertions passing. That failure says nothing about drift. It
   * is the exact way a gate earns its reputation for crying wolf and gets
   * commented out, taking the money invariants with it.
   *
   * So: both drops in parallel, and a budget with real headroom. Every
   * comparison this suite makes is taken in `beforeAll` — cleanup is
   * housekeeping, and `createTestDatabase`'s sweeper already drops anything a
   * killed run abandons. The gate goes red for drift, and for nothing else.
   */
  afterAll(async () => {
    await Promise.all([fromMigrations?.drop(), fromSchemaTs?.drop()]);
    await adminStop();
  }, 60_000);

  /**
   * Each section compares one kind of object. Split rather than one big
   * assertion so a failure names WHAT drifted in its title — "constraints"
   * red is a different emergency from "indexes" red.
   */
  const sections: Array<{ what: keyof CatalogSnapshot; why: string }> = [
    { what: 'columns', why: 'a column that exists in the database is missing from schema.ts, or vice versa' },
    { what: 'constraints', why: 'a CHECK / FK / PK / UNIQUE differs — this is where the money invariants live (§4.2)' },
    { what: 'indexes', why: 'an index differs — account identity uniqueness is an index (0001)' },
    { what: 'enums', why: 'an enum type or its labels differ' },
  ];

  for (const { what, why } of sections) {
    it(`${what} are identical`, () => {
      if (!truth || !claim) throw new Error('H8a: schema-drift catalogs not opened');
      const truthSnap = truth;
      const claimSnap = claim;
      const missingFromSchemaTs = truthSnap[what].filter((row) => !claimSnap[what].includes(row));
      const inventedBySchemaTs = claimSnap[what].filter((row) => !truthSnap[what].includes(row));

      const report = [
        `schema.ts has drifted from the applied migrations — ${why}.`,
        '',
        'The migrations are the source of truth: they have run against real data',
        'and cannot be changed. Correct src/db/schema.ts to match them.',
        '',
        ...(missingFromSchemaTs.length > 0
          ? ['IN THE DATABASE, MISSING FROM schema.ts:', ...missingFromSchemaTs.map((r) => `  - ${r}`), '']
          : []),
        ...(inventedBySchemaTs.length > 0
          ? ['DECLARED BY schema.ts, NOT IN THE DATABASE:', ...inventedBySchemaTs.map((r) => `  + ${r}`)]
          : []),
      ].join('\n');

      expect(missingFromSchemaTs.length + inventedBySchemaTs.length, report).toBe(0);
    });
  }

  /**
   * A guard on the guard.
   *
   * Every assertion above passes trivially if both snapshots are empty — a
   * `CREATE SCHEMA` that silently did nothing, a migration list that failed to
   * load, a filter typo naming a schema that does not exist. Then the gate is
   * bright green and checking nothing at all, which is worse than not having
   * it. Anchor it to what §4.2 actually mandates.
   */
  it('compared a real ledger schema, not two empty ones', () => {
    if (!truth) throw new Error('H8a: schema-drift catalogs not opened');
    expect(truth.columns.length).toBeGreaterThan(30);
    expect(truth.enums.length).toBe(4);

    const checkNames = truth.constraints.filter((c) => JSON.parse(c).type === 'c').map((c) => JSON.parse(c).name as string);
    expect(checkNames).toEqual(
      expect.arrayContaining([
        'accounts_non_negative_ck',
        'accounts_lock_purposed_ck',
        'accounts_purpose_len_ck',
        'accounts_owner_id_space_ck',
        'ledger_entries_positive_ck',
        'chain_tip_singleton_ck',
        'posting_freeze_singleton_ck',
        'posting_freeze_attributed_ck',
      ]),
    );
  });
});
