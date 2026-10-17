import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { disableBalanceTrigger } from './journal-guards.testkit.js';

/**
 * THE GUARDS NOTHING EVER EXECUTED.
 *
 * D5 sweep. Every database-level guard in `svc-ledger`, checked for a test that
 * actually makes it refuse something. Four came back with no such test — and the
 * reason it looked covered is worth writing down, because the same illusion will
 * form again.
 *
 * `schema-drift.test.ts` mentions all of them. That test builds the database from
 * `drizzle/*.sql` and from `schema.ts` and requires the two to be identical, so it
 * proves each constraint EXISTS and is described consistently. It is an excellent
 * gate and it is not this one: a constraint can exist, be named correctly in both
 * descriptions, and still refuse nothing, because `CHECK (true)` is a valid CHECK.
 * Existence is not enforcement.
 *
 * That distinction has already cost this repo twice — #1039 (the no-double-send
 * guard executed by no test) and #1040 (a NATS container CI ran for months with
 * nothing connected to it). Both were found by asking of a guard: what runs it?
 *
 * The four here:
 *
 *   · `ledger_entries_asset_id_fk` — the ENTRIES half of #1044, which had no
 *      coverage of any kind. #1044's own claim is that "value could exist in an
 *      asset the ledger had never heard of"; it was proven for `accounts` in
 *      `asset-registry.test.ts` and never for `ledger_entries`, which is the
 *      table the value is actually recorded in.
 *   · `chain_tip_singleton_ck` — 0000: two rows "would raise the question which
 *      one is true", and the hash chain is built on there being one answer.
 *   · `posting_freeze_singleton_ck` — same argument, on the kill-switch.
 *   · `accounts_purpose_len_ck` — `purpose` is part of the identity index, so its
 *      128-character cap is a bound on a business key, not a display limit.
 *
 * Raw SQL throughout, ledger-client out of the picture — the point of a database
 * backstop is that it holds when the TypeScript path is not the one writing.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run schema via `createTestDb`). Local without that env
 * starts Testcontainers `postgres:16-alpine`. Docker/PG down is a failed suite,
 * not a green skip.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

const CHECK_VIOLATION = '23514';
const FK_VIOLATION = '23503';
const USER = '5f1e9c62-0d3a-4a7e-9b21-8c4a6f0e1d55';

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
      `H8a: svc-ledger guards-executed is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-ledger guards executed PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('the database guards, made to refuse something', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_guards', url: admin.url, migrations });
    // Raw fixtures below insert one-sided entries on purpose (they test other guards).
    // 0023's balance-at-commit trigger has its own file: journal-immutable.db.test.ts.
    await disableBalanceTrigger(db.sql);
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  describe('ledger_entries_asset_id_fk — the entries half of #1044', () => {
    /**
     * A real transaction and a real account, so the only thing wrong with the
     * entry is its asset. Without this setup the `tx_id` and `account_id`
     * foreign keys would fail first and the test would pass for the wrong
     * reason — which is how a test ends up asserting nothing.
     *
     * A FRESH OWNER EACH TIME. `accounts_identity_purpose_idx` is UNIQUE on
     * (owner_type, owner_id, asset_id, kind, purpose), so reusing one owner made
     * the second call collide on the identity index — which is the index doing
     * its job, and it failed these tests on the first CI run. `randomUUID`
     * satisfies `accounts_owner_id_space_ck`, which requires the `user` space to
     * be a UUID.
     */
    let probe = 0;
    async function realTxAndAccount(assetId = 'USDT'): Promise<{ txId: string; accountId: string }> {
      probe += 1;
      const [tx] = await db!.sql<Array<{ id: string }>>`
          INSERT INTO ledger_tx (idempotency_key, module, reason, hash)
          VALUES (${`guards-fk-probe-${probe}`}, 'test', 'entries asset fk probe', ${`h-guards-fk-${probe}`})
          RETURNING id
        `;
      const [account] = await db!.sql<Array<{ id: string }>>`
          INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
          VALUES ('user'::owner_type, ${randomUUID()}, ${assetId}, 'available'::account_kind, '')
          RETURNING id
        `;
      return { txId: tx!.id, accountId: account!.id };
    }

    it('REFUSES an entry in an asset that was never registered', async () => {
      const { txId, accountId } = await realTxAndAccount();

      await expect(
        db!.sql`
            INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
            VALUES (${txId}, ${accountId}, 'NOTANASSET', 'credit'::direction, 1::numeric, 1::numeric)
          `,
      ).rejects.toMatchObject({ code: FK_VIOLATION });
    });

    /**
     * 0010 · THE ENTRY'S ASSET MUST BE THE ACCOUNT'S OWN ASSET.
     *
     * Both assets here are registered and both columns individually pass 0006's
     * foreign keys. The entry is positive. The account is real. What is wrong is
     * that they disagree — the entry records a movement in `BTC` against an
     * account holding `USDT`, so `balance_after` describes a balance in an asset
     * the entry is not in.
     *
     * Nothing caught this before 0010, including reconciliation: it replays
     * entries per asset, so it re-derives the same wrong answer and reports green.
     */
    it('REFUSES an entry whose asset is not its account’s asset', async () => {
      const { txId, accountId } = await realTxAndAccount('USDT');

      await expect(
        db!.sql`
            INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
            VALUES (${txId}, ${accountId}, 'BTC', 'debit'::direction, 1::numeric, 1::numeric)
          `,
      ).rejects.toMatchObject({ code: FK_VIOLATION });
    });

    it('and an account cannot be moved to another asset while entries describe it', async () => {
      // ON UPDATE RESTRICT. Re-pointing the account would silently re-file every
      // entry already written against it into a different book.
      const { txId, accountId } = await realTxAndAccount('USDT');
      await db!.sql`
          INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
          VALUES (${txId}, ${accountId}, 'USDT', 'debit'::direction, 1::numeric, 1::numeric)
        `;

      await expect(db!.sql`UPDATE accounts SET asset_id = 'BTC' WHERE id = ${accountId}`).rejects.toMatchObject({
        code: FK_VIOLATION,
      });
    });

    it('accepts the same entry in a registered asset — so the refusal is about the asset', async () => {
      const { txId, accountId } = await realTxAndAccount();

      await expect(
        db!.sql`
            INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
            VALUES (${txId}, ${accountId}, 'USDT', 'credit'::direction, 1::numeric, 1::numeric)
          `,
      ).resolves.toBeDefined();
    });

    /**
     * REWRITTEN BY 0010, and the reason is the finding.
     *
     * This test used to isolate the entries foreign key by giving an entry an
     * asset its own account did not hold — the only way to make `DELETE FROM
     * assets` fail on the ENTRIES key rather than on `accounts_asset_id_fk`,
     * which restricts the same delete.
     *
     * Needing an illegal state to be constructible in order to test a guard is a
     * finding about the schema, and it was: raw SQL could record a `USDT` entry
     * against a `BTC` account, so the entry landed in one asset's book while
     * `balance_after` described a balance in another. 0010's composite foreign
     * key makes that unrepresentable, which is worth more than the isolation this
     * test wanted — so the isolation is gone and the stronger property is
     * asserted instead.
     *
     * RESTRICT is still covered: the asset holds an account AND an entry, and the
     * delete is refused. It no longer proves WHICH key refused, and after 0010
     * there is no arrangement in which they can disagree.
     */
    it('and an asset holding live value cannot be deleted (ON DELETE RESTRICT)', async () => {
      await db!.sql`INSERT INTO assets (id, kind, decimals) VALUES ('ENTFK', 'crypto', 18) ON CONFLICT (id) DO NOTHING`;
      const { txId, accountId } = await realTxAndAccount('ENTFK');

      await db!.sql`
          INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
          VALUES (${txId}, ${accountId}, 'ENTFK', 'debit'::direction, 1::numeric, 1::numeric)
        `;

      await expect(db!.sql`DELETE FROM assets WHERE id = 'ENTFK'`).rejects.toMatchObject({ code: FK_VIOLATION });
    });
  });

  describe('the singletons — one row, because two would raise "which one is true"', () => {
    it('chain_tip REFUSES a second row', async () => {
      // `id = false` is the case the CHECK exists for. `id = true` is refused by
      // the primary key, which is a different guard, so both are asserted.
      await expect(db!.sql`INSERT INTO chain_tip (id, hash, seq) VALUES (false, 'other', 1)`).rejects.toMatchObject({
        code: CHECK_VIOLATION,
      });
      await expect(db!.sql`INSERT INTO chain_tip (id, hash, seq) VALUES (true, 'other', 1)`).rejects.toMatchObject({
        code: '23505',
      });

      const rows = await db!.sql<Array<{ n: string }>>`SELECT count(*) AS n FROM chain_tip`;
      expect(Number(rows[0]!.n)).toBe(1);
    });

    it('posting_freeze REFUSES a second row', async () => {
      await expect(
        db!.sql`INSERT INTO posting_freeze (id, frozen, reason, actor) VALUES (false, true, 'other', 'other')`,
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });

      const rows = await db!.sql<Array<{ n: string }>>`SELECT count(*) AS n FROM posting_freeze`;
      expect(Number(rows[0]!.n)).toBe(1);
    });
  });

  describe('accounts_purpose_len_ck — a bound on a business key, not a display limit', () => {
    it('REFUSES a purpose past 128 characters', async () => {
      await expect(
        db!.sql`
            INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
            VALUES ('user'::owner_type, ${USER}, 'USDT', 'hold'::account_kind, ${'loan:' + 'a'.repeat(124)})
          `,
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it('accepts exactly 128, so the boundary is where the constraint says', async () => {
      await expect(
        db!.sql`
            INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
            VALUES ('user'::owner_type, ${USER}, 'USDT', 'hold'::account_kind, ${'a'.repeat(128)})
          `,
      ).resolves.toBeDefined();
    });
  });
});
