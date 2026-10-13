import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { ACCOUNT_KINDS } from '@intafaced/ledger-client';

/**
 * LOCK POTS MUST NAME THEIR CLAIM IN THE DATABASE (STOP §4.2b #1).
 *
 * `assertPurposedLocks` already refuses unpurposed hold/escrow/stake/collateral
 * on the TypeScript path. Only `hold` had a CHECK. An unpurposed collateral
 * insert via raw SQL is the worst case (accounts.ts): releasing loan A could
 * unsecure loan B while every posting balances.
 *
 * Asserts raw-SQL refusal with ledger-client out of the picture.
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

const read = (f: string) => readFileSync(join(drizzleDir, f), 'utf8');
const allMigrations = allMigrationFiles.map((f) => (schema: string) => rewriteSchemaSql(read(f), 'ledger', schema));

const USER = '0007e7f3-2e25-4dc9-88b4-146db6d491f0';
const CHECK_VIOLATION = '23514';

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
      `H8a: svc-ledger purposed-locks is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-ledger purposed-locks PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-ledger purposed lock kinds', () => {
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

  describe('accounts_lock_purposed_ck — database backstop for all lock kinds', () => {
    let db: TestDb | undefined;

    beforeAll(async () => {
      if (!adminUrl) throw new Error('H8a: test db not opened');
      db = await createTestDb({ service: 'ledger_purposed', url: adminUrl, migrations: allMigrations });
    }, 120_000);
    afterAll(async () => {
      await db?.drop();
    }, 30_000);

    function requireDb(): TestDb {
      if (!db) throw new Error('H8a: test db not opened');
      return db;
    }

    it('still allows available with empty purpose', async () => {
      await expect(
        requireDb().sql`
          INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
          VALUES ('user'::owner_type, ${USER}, 'USDT', 'available'::account_kind, '')
        `,
      ).resolves.toBeDefined();
    });

    /**
     * DRIVEN OFF THE KIND LIST, NOT A COPY OF IT.
     *
     * 0007's CHECK enumerated the four locked kinds, and this test enumerated
     * the same four independently — so a fifth lock kind would have been added
     * to the enum, missed by the constraint, and missed by the test that exists
     * to guard the constraint. Both lists have to come from one place, and
     * `ACCOUNT_KINDS` in ledger-client is where kinds are declared.
     *
     * `available` is the single exemption: it reserves nothing, so it has
     * nothing to name. Everything else must justify itself in the database, and
     * a new kind is covered here the moment it joins the enum.
     */
    const LOCK_KINDS = ACCOUNT_KINDS.filter((k) => k !== 'available');

    it('covers every non-available kind the enum declares', () => {
      // Guards the guard: if `ACCOUNT_KINDS` were ever empty or mis-imported,
      // `it.each` below would silently assert nothing at all.
      expect(LOCK_KINDS.length).toBeGreaterThanOrEqual(4);
      expect(LOCK_KINDS).not.toContain('available');
    });

    it.each(LOCK_KINDS)('REFUSES unpurposed %s via raw SQL (no ledger-client)', async (kind) => {
      await expect(
        requireDb().sql`
            INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
            VALUES ('user'::owner_type, ${USER}, 'USDT', ${kind}::account_kind, '')
          `,
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    /**
     * THE BACKFILL 0007 SHIPPED, AS A TEST.
     *
     * 0008 refuses a `legacy:<id>` purpose rather than accepting it, because a
     * purpose that names the row it is attached to answers nothing. Under 0007's
     * constraint this insert SUCCEEDED — the string is non-empty, so the CHECK
     * was satisfied by data it existed to catch.
     *
     * The migration cannot re-raise here (its refusal ran before this schema had
     * any rows), so the constraint has to carry the rule forward. Anything that
     * looks like the minted identity is refused on the way in.
     */
    it('REFUSES the legacy: stamp 0007 would have minted', async () => {
      await expect(
        requireDb().sql`
          INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
          VALUES ('user'::owner_type, ${USER}, 'USDT', 'collateral'::account_kind, ${'legacy:' + USER})
        `,
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it('allows purposed collateral', async () => {
      await expect(
        requireDb().sql`
          INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
          VALUES ('user'::owner_type, ${USER}, 'USDT', 'collateral'::account_kind, 'loan:probe-1')
        `,
      ).resolves.toBeDefined();
    });

    it('REFUSES whitespace-only lock purpose via raw SQL (0011 btrim belt)', async () => {
      // Client trims and treats spaces as empty; 0008 length(purpose)>0 let
      // purpose '   ' land as a lock pot that names nothing.
      await expect(
        requireDb().sql`
          INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
          VALUES ('user'::owner_type, ${USER}, 'USDT', 'hold'::account_kind, '   ')
        `,
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it('REFUSES padded lock purpose — identity is the trimmed claim (P0-3)', async () => {
      await expect(
        requireDb().sql`
          INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
          VALUES ('user'::owner_type, ${USER}, 'USDT', 'hold'::account_kind, 'order:x ')
        `,
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    /**
     * 0011 used bare `btrim(purpose)` — space only. Client `String.trim()` also
     * strips tab/CR/LF/NBSP. Raw SQL could open `order:x\t` beside `order:x`
     * while recon stayed green (P0-3 dual book). 0012 closes that belt.
     */
    it('REFUSES tab-padded lock purpose — not just space (0012 JS-trim belt)', async () => {
      await expect(
        requireDb().sql`
          INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
          VALUES ('user'::owner_type, ${USER}, 'USDT', 'hold'::account_kind, ${'order:x\t'})
        `,
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it('REFUSES tab-only lock purpose — names nothing after JS trim', async () => {
      await expect(
        requireDb().sql`
          INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
          VALUES ('user'::owner_type, ${USER}, 'USDT', 'hold'::account_kind, ${'\t\t\t'})
        `,
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it('REFUSES Unicode White_Space pads that String.trim strips (FEFF, 2028, 2029)', async () => {
      for (const pad of ['\uFEFF', '\u2028', '\u2029', '\u3000']) {
        await expect(
          requireDb().sql`
            INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
            VALUES ('user'::owner_type, ${USER}, 'USDT', 'hold'::account_kind, ${'order:x' + pad})
          `,
        ).rejects.toMatchObject({ code: CHECK_VIOLATION });
      }
    });

    it('REFUSES a vertical tab pad (U+000B)', async () => {
      await expect(
        requireDb().sql`
          INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
          VALUES ('user'::owner_type, ${USER}, 'USDT', 'hold'::account_kind, ${'order:x\u000b'})
        `,
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it('allows a purpose that ends in the letter v', async () => {
      await expect(
        requireDb().sql`
          INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
          VALUES ('user'::owner_type, ${USER}, 'USDT', 'hold'::account_kind, 'order:v')
        `,
      ).resolves.toBeDefined();
    });

    it('allows a trailing character String.trim keeps (U+180E)', async () => {
      await expect(
        requireDb().sql`
          INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
          VALUES ('user'::owner_type, ${USER}, 'USDT', 'hold'::account_kind, ${'order:x\u180E'})
        `,
      ).resolves.toBeDefined();
    });

    it('REFUSES NBSP-padded lock purpose (U+00A0 dual pot)', async () => {
      await expect(
        requireDb().sql`
          INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
          VALUES ('user'::owner_type, ${USER}, 'USDT', 'hold'::account_kind, ${'order:x\u00a0'})
        `,
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it('REFUSES purpose on available — fungible pot must stay one row', async () => {
      // Same failure class as assertAvailableUnpurposed on the TypeScript path.
      await expect(
        requireDb().sql`
          INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
          VALUES ('user'::owner_type, ${USER}, 'USDT', 'available'::account_kind, 'split')
        `,
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });
});
