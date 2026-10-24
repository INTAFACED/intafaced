import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { runMigrations, type MigrateClient } from './migrate.js';
import { PostgresLedger } from '../src/ledger/postgres-ledger.js';
import { recipes, parseAmount } from '@intafaced/ledger-client';

const realDir = fileURLToPath(new URL('../drizzle/', import.meta.url));
let sequence = 0;

async function fixture(run: (sql: postgres.Sql, dir: string) => Promise<void>) {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error('native ledger migration proofs require a dedicated TEST_DATABASE_URL');
  const url = new URL(base);
  if (!url.pathname.endsWith('_test')) throw new Error('ledger migration proof refuses a non-test database');
  const admin = postgres(base, { max: 1, onnotice: () => undefined });
  const name = `ledger_migrate_${process.pid}_${++sequence}_test`;
  const dir = await mkdtemp(join(tmpdir(), 'ledger-migrate-proof-'));
  let sql: postgres.Sql | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    url.pathname = `/${name}`;
    sql = postgres(url.toString(), { max: 4, onnotice: () => undefined, connection: { search_path: 'ledger,public' } });
    await sql`CREATE SCHEMA ledger`;
    await run(sql, dir);
  } finally {
    await sql?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
}
const migrate = (sql: postgres.Sql, dir: string, down = false) =>
  runMigrations(sql as unknown as MigrateClient, { migrationsDir: dir, down });

/** CREATE/DROP DATABASE on a busy shared test server can sit past Vitest's 5s default. The proof itself is unchanged. */
const proof = (name: string, run: () => Promise<void>) => it(name, run, 20_000);

async function files(dir: string, entries: Record<string, string>) {
  await Promise.all(Object.entries(entries).map(([name, body]) => writeFile(join(dir, name), body)));
}
async function realFiles(dir: string, predicate: (name: string) => boolean = () => true) {
  for (const name of await readdir(realDir)) {
    if (predicate(name)) await writeFile(join(dir, name), await readFile(join(realDir, name)));
  }
}

describe('actual ledger migration runner on native PostgreSQL', () => {
  proof('serializes concurrent bootstrap and commits one DDL effect with its tracking row', async () =>
    fixture(async (sql, dir) => {
      await files(dir, {
        '0001_probe.sql': 'CREATE TABLE ledger.probe(n integer); INSERT INTO ledger.probe VALUES (1); SELECT pg_sleep(0.03);',
        '0001_probe.down.sql': 'DROP TABLE ledger.probe;',
      });
      await Promise.all([migrate(sql, dir), migrate(sql, dir), migrate(sql, dir)]);
      expect(await sql`SELECT * FROM ledger.probe`).toHaveLength(1);
      expect(await sql`SELECT * FROM ledger.__migrations`).toHaveLength(1);
      await migrate(sql, dir, true);
      expect((await sql`SELECT to_regclass('ledger.probe') AS name`)[0]?.name).toBeNull();
      expect(await sql`SELECT * FROM ledger.__migrations`).toHaveLength(0);
    }),
  );

  proof('rolls back actual up DDL when the tracking insert refuses', async () =>
    fixture(async (sql, dir) => {
      await migrate(sql, dir);
      await sql.unsafe(
        `CREATE FUNCTION ledger.reject_tracking() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'tracking refusal'; END $$; CREATE TRIGGER reject_tracking BEFORE INSERT ON ledger.__migrations FOR EACH ROW EXECUTE FUNCTION ledger.reject_tracking();`,
      );
      await files(dir, { '0001_probe.sql': 'CREATE TABLE ledger.probe(n integer);', '0001_probe.down.sql': 'DROP TABLE ledger.probe;' });
      await expect(migrate(sql, dir)).rejects.toThrow('tracking refusal');
      expect((await sql`SELECT to_regclass('ledger.probe') AS name`)[0]?.name).toBeNull();
      expect(await sql`SELECT * FROM ledger.__migrations`).toHaveLength(0);
    }),
  );

  proof('rolls back all actual down DDL and tracking deletion together', async () =>
    fixture(async (sql, dir) => {
      await files(dir, {
        '0001_a.sql': 'CREATE TABLE ledger.a(n integer);',
        '0001_a.down.sql': 'DROP TABLE ledger.a;',
        '0002_b.sql': 'CREATE TABLE ledger.b(n integer);',
        '0002_b.down.sql': 'DROP TABLE ledger.b;',
      });
      await migrate(sql, dir);
      await sql.unsafe(
        `CREATE FUNCTION ledger.reject_tracking() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.name = '0001_a.sql' THEN RAISE EXCEPTION 'tracking refusal'; END IF; RETURN OLD; END $$; CREATE TRIGGER reject_tracking BEFORE DELETE ON ledger.__migrations FOR EACH ROW EXECUTE FUNCTION ledger.reject_tracking();`,
      );
      await expect(migrate(sql, dir, true)).rejects.toThrow('tracking refusal');
      expect((await sql`SELECT to_regclass('ledger.a') AS a, to_regclass('ledger.b') AS b`)[0]).toMatchObject({ a: 'a', b: 'b' });
      expect(await sql`SELECT * FROM ledger.__migrations`).toHaveLength(2);
    }),
  );

  proof('ignores unapplied down files and refuses a missing applied reversal before DDL', async () =>
    fixture(async (sql, dir) => {
      await files(dir, { '0001_a.sql': 'CREATE TABLE ledger.a(n integer);', '0001_a.down.sql': 'DROP TABLE ledger.a;' });
      await migrate(sql, dir);
      await writeFile(join(dir, '0002_unapplied.sql'), 'SELECT 1;');
      await migrate(sql, dir, true);
      await migrate(sql, dir);
      await rm(join(dir, '0001_a.down.sql'));
      await expect(migrate(sql, dir, true)).rejects.toThrow('missing 0001_a.down.sql');
      expect((await sql`SELECT to_regclass('ledger.a') AS a`)[0]?.a).toBe('a');
    }),
  );

  proof('preserves posted business history and all tracking rows before any reversal', async () =>
    fixture(async (sql, dir) => {
      await realFiles(dir);
      await migrate(sql, dir);
      // Configure every pool connection before the actual service posts.
      const engine = new PostgresLedger(sql);
      await engine.post(
        recipes.deposit({
          userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          assetId: 'USDT',
          amount: parseAmount('1'),
          rail: 'test',
          railRef: 'migration-history',
        }),
      );
      const before = await sql`SELECT name FROM ledger.__migrations ORDER BY name`;
      await expect(migrate(sql, dir, true)).rejects.toThrow('ledger.ledger_tx is not empty');
      expect(await sql`SELECT name FROM ledger.__migrations ORDER BY name`).toEqual(before);
      expect(await sql`SELECT * FROM ledger.ledger_tx`).toHaveLength(1);
    }),
  );

  proof('preserves a known genesis snapshot anchor and atomically refuses its direct down', async () =>
    fixture(async (sql, dir) => {
      await realFiles(dir);
      await migrate(sql, dir);
      const [account] =
        await sql`INSERT INTO ledger.accounts(owner_type, owner_id, asset_id, kind, purpose) VALUES ('user', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'USDT', 'available', '') RETURNING id`;
      await sql`INSERT INTO ledger.balance_snapshots(account_id, as_of, balance, chain_tip_seq, chain_tip_hash) VALUES (${account!.id}, now(), 0, 0, NULL)`;
      await expect(sql.unsafe(await readFile(join(realDir, '0015_snapshot_chain_tip.down.sql'), 'utf8'))).rejects.toThrow(
        'snapshot chain-tip identity',
      );
      const before = await sql`SELECT name FROM ledger.__migrations ORDER BY name`;
      await expect(migrate(sql, dir, true)).rejects.toThrow('snapshot chain-tip identity');
      expect(await sql`SELECT name FROM ledger.__migrations ORDER BY name`).toEqual(before);
      expect((await sql`SELECT chain_tip_seq::text AS seq FROM ledger.balance_snapshots`)[0]?.seq).toBe('0');
      expect((await sql`SELECT to_regclass('ledger.ledger_freeze_outbox') AS name`)[0]?.name).toBe('ledger_freeze_outbox');
    }),
  );

  proof('refuses malformed freeze intents at the database and preserves published switch history on down', async () =>
    fixture(async (sql, dir) => {
      await realFiles(dir);
      await migrate(sql, dir);
      await expect(
        sql`INSERT INTO ledger.ledger_freeze_outbox(idempotency_key, payload) VALUES ('ledger.freeze:bad', ${sql.json({})})`,
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        sql`INSERT INTO ledger.ledger_freeze_outbox(idempotency_key, payload) VALUES ('ledger.freeze:bad-thaw', ${sql.json({ frozen: false, actor: 'ops', changedAt: new Date().toISOString(), reason: 'wrong' })})`,
      ).rejects.toMatchObject({ code: '23514' });
      await sql`INSERT INTO ledger.ledger_freeze_outbox(idempotency_key, payload, published_at) VALUES ('ledger.freeze:recorded', ${sql.json({ frozen: false, actor: 'ops', changedAt: new Date().toISOString(), reason: null })}, now())`;
      const before = await sql`SELECT name FROM ledger.__migrations ORDER BY name`;
      await expect(migrate(sql, dir, true)).rejects.toThrow('recorded ledgerFreezeUpdated');
      expect(await sql`SELECT name FROM ledger.__migrations ORDER BY name`).toEqual(before);
      expect(await sql`SELECT * FROM ledger.ledger_freeze_outbox`).toHaveLength(1);
    }),
  );

  proof('refuses a populated old0013 nested-array outbox upgrade without marking0019 or rewriting evidence', async () =>
    fixture(async (sql, dir) => {
      await realFiles(dir, (name) => Number(name.slice(0, 4)) <= 13);
      await migrate(sql, dir);
      // A legacy raw database row deliberately exercises only outbox structure;
      // its fixture hash is not claimed as a verified posting or original provenance.
      const [tx] =
        await sql`INSERT INTO ledger.ledger_tx(idempotency_key, module, reason, hash) VALUES ('legacy-nested-array', 'test', 'upgrade shape', 'fixture-hash') RETURNING id`;
      const payload = {
        txId: String(tx!.id),
        module: 'test',
        reason: 'upgrade shape',
        hash: 'fixture-hash',
        previousHash: null,
        postedAt: new Date().toISOString(),
        entries: [[]],
      };
      await sql`INSERT INTO ledger.ledger_tx_outbox(tx_id, payload, correlation_id) VALUES (${tx!.id}, ${sql.json(payload)}, 'legacy-structure')`;
      const [before] =
        await sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'ledger.ledger_tx_outbox'::regclass AND conname = 'ledger_tx_outbox_amount_string_ck'`;
      await realFiles(dir);
      await expect(migrate(sql, dir)).rejects.toThrow('Cannot apply 0019');
      expect(await sql`SELECT name FROM ledger.__migrations WHERE name = '0019_outbox_amount_string.sql'`).toHaveLength(0);
      expect((await sql`SELECT payload FROM ledger.ledger_tx_outbox WHERE tx_id = ${tx!.id}`)[0]?.payload).toEqual(payload);
      expect(
        (
          await sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'ledger.ledger_tx_outbox'::regclass AND conname = 'ledger_tx_outbox_amount_string_ck'`
        )[0]?.definition,
      ).toBe(before?.definition);
    }),
  );

  proof('refuses the historical 0007 invented-purpose backfill before writing any purpose', async () =>
    fixture(async (sql, dir) => {
      await realFiles(dir, (name) => name < '0007');
      await migrate(sql, dir);
      await sql`INSERT INTO ledger.accounts(owner_type, owner_id, asset_id, kind, purpose) VALUES ('user', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'USDT', 'stake', '')`;
      await files(dir, { '0007_purposed_lock_kinds.sql': await readFile(join(realDir, '0007_purposed_lock_kinds.sql'), 'utf8') });
      await expect(migrate(sql, dir)).rejects.toThrow('refusing invented legacy purpose');
      expect((await sql`SELECT purpose FROM ledger.accounts`)[0]?.purpose).toBe('');
      expect(await sql`SELECT name FROM ledger.__migrations WHERE name = '0007_purposed_lock_kinds.sql'`).toHaveLength(0);
    }),
  );
});
