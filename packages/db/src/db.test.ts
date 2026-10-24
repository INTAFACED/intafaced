import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzleConfig, MIGRATION_CONVENTION } from './migrate.js';
import { isSerializationFailure } from './connection.js';
import {
  assertTestDatabase,
  createTestDatabase,
  createTestDb,
  postgresAvailable,
  rewriteSchemaSql,
  sweepStaleTestSchemas,
  type TestDatabase,
} from './testing.js';

describe('drizzleConfig', () => {
  it('confines a service to its own Postgres schema', () => {
    const config = drizzleConfig({ schema: 'ledger' });
    expect(config.schemaFilter).toEqual(['ledger']);
    expect(config.dialect).toBe('postgresql');
  });

  it('defaults to the service role rather than a superuser', () => {
    const config = drizzleConfig({ schema: 'trade', url: undefined });
    const url = (config.dbCredentials as { url: string }).url;
    // Only meaningful when DATABASE_URL is unset, which is the case in CI.
    if (!process.env.DATABASE_URL) {
      expect(url).toContain('svc_trade');
    }
  });

  it('lets a service override paths without touching schema isolation', () => {
    const config = drizzleConfig({ schema: 'pay', schemaPath: './src/db/tables.ts', out: './migrations' });
    expect(config.schema).toBe('./src/db/tables.ts');
    expect(config.out).toBe('./migrations');
    expect(config.schemaFilter).toEqual(['pay']);
  });

  it('declares the reversible-migration convention CI checks for', () => {
    expect(MIGRATION_CONVENTION.downSuffix).toBe('.down.sql');
  });
});

describe('rewriteSchemaSql', () => {
  it('rewrites quoted and bare schema qualifiers for isolated test schemas', () => {
    const src = `
      CREATE TABLE "ledger"."accounts" (...);
      SELECT * FROM ledger.accounts WHERE kind = 'hold'::ledger.account_kind;
    `;
    const out = rewriteSchemaSql(src, 'ledger', 'test_ledger_1_2');
    expect(out).toContain('"test_ledger_1_2"."accounts"');
    expect(out).toContain('FROM test_ledger_1_2.accounts');
    expect(out).toContain("'hold'::test_ledger_1_2.account_kind");
    expect(out).not.toContain('"ledger"');
    expect(out).not.toMatch(/\bledger\./);
  });

  it('refuses unsafe identifiers', () => {
    expect(() => rewriteSchemaSql('x', 'ledger;drop', 'y')).toThrow(/Unsafe/);
  });
});

/**
 * The claim `createTestDatabase` exists to make is that two runs of the SAME
 * suite cannot see each other. Asserting it here, rather than only observing
 * that svc-trade stopped flaking, is what keeps it true: a regression that
 * quietly reused one database would still pass every service suite run alone.
 */
const ADMIN = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
/** Resolved once, at module scope: `describe` callbacks are synchronous. */
const live = await postgresAvailable(ADMIN);
// Most CI service roles have CREATEDB but deliberately are not superusers.
// Catalog locks, event triggers, and role creation are failure-injection tools
// available only in a dedicated superuser test fixture.
const superuserFixture =
  live &&
  (await (async () => {
    const probe = postgres(ADMIN, { max: 1, onnotice: () => undefined });
    try {
      const [role] = await probe<{ rolsuper: boolean }[]>`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`;
      return role?.rolsuper === true;
    } finally {
      await probe.end({ timeout: 5 });
    }
  })());

describe('createTestDatabase', () => {
  it('refuses a service name that is not a safe identifier', async () => {
    await expect(createTestDatabase({ service: 'trade; DROP SCHEMA public' })).rejects.toThrow(/unsafe/i);
  });

  it.runIf(live)('gives two concurrent runs of one service separate databases', async () => {
    const [a, b] = await Promise.all([
      createTestDatabase({ service: 'trade', url: ADMIN, migrations: ['CREATE TABLE trade.t (id int primary key)'] }),
      createTestDatabase({ service: 'trade', url: ADMIN, migrations: ['CREATE TABLE trade.t (id int primary key)'] }),
    ]);

    try {
      // The schema keeps its REAL name in both — that is the whole point, and it
      // is why schema-qualified production SQL runs unchanged.
      expect(a.schema).toBe('trade');
      expect(b.schema).toBe('trade');

      // The DATABASE is what differs, and both are quarantined by name.
      expect(a.database).not.toBe(b.database);
      for (const db of [a, b]) {
        expect(db.database).toMatch(/^itf_run_trade_\d+_\d+_[a-z0-9]+_test$/);
        expect(db.database.endsWith('_test')).toBe(true);
      }

      // The failure this replaces: A truncating B's rows mid-test.
      await a.sql`INSERT INTO trade.t (id) VALUES (1)`;
      await b.sql`INSERT INTO trade.t (id) VALUES (1)`; // same PK, no conflict
      await a.truncateAll();

      expect(await a.sql`SELECT id FROM trade.t`).toHaveLength(0);
      expect(await b.sql`SELECT id FROM trade.t`).toHaveLength(1);
    } finally {
      await Promise.all([a.drop(), b.drop()]);
    }
  });

  // No runIf: this needs Postgres wherever it runs, like the PG-hard suites; CI always has one.
  it('drop() with a statement still in flight on a new connection raises no unhandled rejection', async () => {
    // A connection that has just opened looks up array types before its first statement, and postgres.js never
    // handles that promise. drop() used to destroy the pool on the next tick, so a lookup in flight became an
    // unhandled CONNECTION_DESTROYED and failed a suite whose tests had all passed (svc-pay custody policy suite).
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => void unhandled.push(reason);
    process.on('unhandledRejection', record);
    try {
      // Dropped at once and a few ms in, so the lookup is caught before and while it runs. One pass fails on main.
      for (const wait of [0, 3]) {
        const db = await createTestDatabase({ service: 'trade', url: ADMIN });
        // The pool's one open connection is busy, so the next statement opens a second one.
        const busy = db.sql`SELECT pg_sleep(0.05)`.catch(() => undefined);
        const late = db.sql`SELECT 1 AS one`.catch((e: unknown) => e);
        await new Promise((r) => setTimeout(r, wait));
        await db.drop();
        await busy;
        expect(await late).toEqual([{ one: 1 }]);
      }
      // Past the drain bound, so a rejection from a connection terminated late is still seen here.
      await new Promise((r) => setTimeout(r, 2_500));
    } finally {
      process.off('unhandledRejection', record);
    }
    expect(unhandled).toEqual([]);
  }, 60_000);

  it.runIf(live)('drops its database on drop(), leaving nothing behind', async () => {
    const db = await createTestDatabase({ service: 'trade', url: ADMIN });
    const admin = postgres(ADMIN, { max: 1, onnotice: () => undefined });
    try {
      const before = await admin`SELECT 1 FROM pg_database WHERE datname = ${db.database}`;
      expect(before).toHaveLength(1);

      await db.drop();

      const after = await admin`SELECT 1 FROM pg_database WHERE datname = ${db.database}`;
      expect(after).toHaveLength(0);
    } finally {
      await admin.end({ timeout: 5 });
    }
  });

  it.runIf(live)('sweeps only what it can date — a fresh schema is never collected', async () => {
    const admin = postgres(ADMIN, { max: 1, onnotice: () => undefined });
    const unstamped = `test_sweepprobe_${process.pid}_1`;
    try {
      await admin.unsafe(`CREATE SCHEMA "${unstamped}"`);

      // staleAfterMs 0 makes EVERYTHING old enough; survival therefore proves the
      // stamp requirement, not merely that the clock has not advanced.
      const dropped = await sweepStaleTestSchemas(admin, 0);

      expect(dropped).not.toContain(unstamped);
      const still = await admin`SELECT 1 FROM pg_namespace WHERE nspname = ${unstamped}`;
      expect(still).toHaveLength(1);
    } finally {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${unstamped}" CASCADE`).catch(() => undefined);
      await admin.end({ timeout: 5 });
    }
  });
});

/**
 * Local Postgres this desk uses. A failed createTestDb must not leave this
 * worker holding the schema.
 */
const L1280_URL = ADMIN;

describe.skipIf(!live)('createTestDb setup failure cleanup', () => {
  it('drops the schema and ends both pools when a migration throws', async () => {
    const service = 'l1280mig';
    const prefix = `test_${service}_${process.pid}_`;
    const sentinel = 'L1280-migration-failed';
    const probe = postgres(L1280_URL, { max: 1, onnotice: () => undefined });

    try {
      let thrown: unknown;
      try {
        await createTestDb({
          service,
          url: L1280_URL,
          migrations: [`SELECT '${sentinel}'::int`],
        });
        thrown = undefined;
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toMatchObject({
        code: '22P02',
        message: expect.stringContaining(sentinel),
      });

      const schemas = await probe<{ nspname: string }[]>`
        SELECT nspname FROM pg_namespace WHERE strpos(nspname, ${prefix}) = 1
      `;
      expect(schemas).toEqual([]);

      const leaked = await probe<{ application_name: string; query: string }[]>`
        SELECT application_name, query
          FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
           AND datname = current_database()
           AND (
             strpos(application_name, ${prefix}) = 1
             OR strpos(query, ${prefix}) > 0
           )
      `;
      expect(leaked).toEqual([]);
    } finally {
      const leftovers = await probe<{ nspname: string }[]>`
        SELECT nspname FROM pg_namespace WHERE strpos(nspname, ${prefix}) = 1
      `;
      for (const row of leftovers) {
        if (/^[a-z][a-z0-9_]*$/i.test(row.nspname)) {
          await probe.unsafe(`DROP SCHEMA IF EXISTS "${row.nspname}" CASCADE`);
        }
      }
      const stuck = await probe<{ pid: number }[]>`
        SELECT pid
          FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
           AND datname = current_database()
           AND (
             strpos(application_name, ${prefix}) = 1
             OR strpos(query, ${prefix}) > 0
           )
      `;
      for (const row of stuck) {
        await probe`SELECT pg_terminate_backend(${row.pid})`;
      }
      await probe.end({ timeout: 5 });
    }
  });

  it('returns a handle whose drop removes the schema and the client', async () => {
    const service = 'l1280ok';
    const prefix = `test_${service}_${process.pid}_`;
    const db = await createTestDb({
      service,
      url: L1280_URL,
      migrations: ['CREATE TABLE kept (id int primary key)'],
    });
    const probe = postgres(L1280_URL, { max: 1, onnotice: () => undefined });
    let dropped = false;

    try {
      expect(db.url).toBe(L1280_URL);
      expect(db.schema).toMatch(new RegExp(`^test_${service}_${process.pid}_\\d+$`));
      expect(typeof db.truncateAll).toBe('function');
      expect(typeof db.drop).toBe('function');

      await db.sql`INSERT INTO kept (id) VALUES (1)`;
      await db.truncateAll();
      expect(await db.sql`SELECT id FROM kept`).toEqual([]);

      await db.drop();
      dropped = true;

      const schemas = await probe<{ nspname: string }[]>`
        SELECT nspname FROM pg_namespace WHERE strpos(nspname, ${prefix}) = 1
      `;
      expect(schemas).toEqual([]);

      const leaked = await probe<{ application_name: string; query: string }[]>`
        SELECT application_name, query
          FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
           AND datname = current_database()
           AND (
             strpos(application_name, ${prefix}) = 1
             OR strpos(query, ${prefix}) > 0
           )
      `;
      expect(leaked).toEqual([]);
    } finally {
      if (!dropped) await db.drop().catch(() => undefined);
      const leftovers = await probe<{ nspname: string }[]>`
        SELECT nspname FROM pg_namespace WHERE strpos(nspname, ${prefix}) = 1
      `;
      for (const row of leftovers) {
        if (/^[a-z][a-z0-9_]*$/i.test(row.nspname)) {
          await probe.unsafe(`DROP SCHEMA IF EXISTS "${row.nspname}" CASCADE`);
        }
      }
      await probe.end({ timeout: 5 });
    }
  });

  it.runIf(superuserFixture)('drops the schema when COMMENT fails after CREATE SCHEMA', async () => {
    const service = 'l1280comment';
    const prefix = `test_${service}_${process.pid}_`;
    const sentinel = 'L1280 comment failed';
    const fn = `l1280_reject_comment_${process.pid}`;
    const probe = postgres(L1280_URL, { max: 1, onnotice: () => undefined });

    try {
      await probe.unsafe(`
        CREATE OR REPLACE FUNCTION ${fn}()
        RETURNS event_trigger
        LANGUAGE plpgsql
        AS $l1280$
        DECLARE
          obj record;
        BEGIN
          FOR obj IN SELECT object_identity FROM pg_event_trigger_ddl_commands()
          LOOP
            IF obj.object_identity LIKE '%l1280comment%' THEN
              RAISE EXCEPTION '${sentinel}';
            END IF;
          END LOOP;
        END;
        $l1280$;
      `);
      await probe.unsafe(`DROP EVENT TRIGGER IF EXISTS ${fn}`);
      await probe.unsafe(`
        CREATE EVENT TRIGGER ${fn}
          ON ddl_command_end
          WHEN TAG IN ('COMMENT')
          EXECUTE FUNCTION ${fn}()
      `);

      let thrown: unknown;
      try {
        await createTestDb({ service, url: L1280_URL });
        thrown = undefined;
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toMatchObject({
        message: expect.stringContaining(sentinel),
      });

      const schemas = await probe<{ nspname: string; comment: string | null }[]>`
        SELECT nspname, obj_description(oid, 'pg_namespace') AS comment
          FROM pg_namespace
         WHERE strpos(nspname, ${prefix}) = 1
      `;
      expect(schemas).toEqual([]);

      const leaked = await probe<{ application_name: string; query: string }[]>`
        SELECT application_name, query
          FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
           AND datname = current_database()
           AND (
             strpos(application_name, ${prefix}) = 1
             OR strpos(query, ${prefix}) > 0
           )
      `;
      expect(leaked).toEqual([]);
    } finally {
      await probe.unsafe(`DROP EVENT TRIGGER IF EXISTS ${fn}`).catch(() => undefined);
      await probe.unsafe(`DROP FUNCTION IF EXISTS ${fn}()`).catch(() => undefined);
      const leftovers = await probe<{ nspname: string }[]>`
        SELECT nspname FROM pg_namespace WHERE strpos(nspname, ${prefix}) = 1
      `;
      for (const row of leftovers) {
        if (/^[a-z][a-z0-9_]*$/i.test(row.nspname)) {
          await probe.unsafe(`DROP SCHEMA IF EXISTS "${row.nspname}" CASCADE`);
        }
      }
      const stuck = await probe<{ pid: number }[]>`
        SELECT pid
          FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
           AND datname = current_database()
           AND (
             strpos(application_name, ${prefix}) = 1
             OR strpos(query, ${prefix}) > 0
           )
      `;
      for (const row of stuck) {
        await probe`SELECT pg_terminate_backend(${row.pid})`;
      }
      await probe.end({ timeout: 5 });
    }
  });
});

/**
 * Local Postgres this desk uses. A failed createTestDatabase must end every
 * pool it opened, and a database CREATE already committed must be dropped:
 * PostgreSQL cannot wrap CREATE DATABASE in a transaction, and the sweeper
 * skips a database that never received its stamp.
 */
const L1281_URL = ADMIN;

function l1281Url(applicationName: string, params: Record<string, string> = {}): string {
  const url = new URL(L1281_URL);
  url.searchParams.set('application_name', applicationName);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function l1281Databases(probe: postgres.Sql, prefix: string): Promise<{ datname: string }[]> {
  return probe<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE strpos(datname, ${prefix}) = 1
  `;
}

async function l1281Activity(
  probe: postgres.Sql,
  applicationName: string,
  prefix: string,
): Promise<{ application_name: string; query: string }[]> {
  return probe<{ application_name: string; query: string }[]>`
    SELECT application_name, query
      FROM pg_stat_activity
     WHERE pid <> pg_backend_pid()
       AND (
         application_name = ${applicationName}
         OR strpos(query, ${prefix}) > 0
       )
  `;
}

async function l1281Reclaim(probe: postgres.Sql, prefix: string, applicationName: string): Promise<void> {
  const leftovers = await l1281Databases(probe, prefix);
  for (const row of leftovers) {
    if (/^[a-z][a-z0-9_]*$/i.test(row.datname)) {
      await probe.unsafe(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`);
    }
  }
  const stuck = await probe<{ pid: number }[]>`
    SELECT pid
      FROM pg_stat_activity
     WHERE pid <> pg_backend_pid()
       AND application_name = ${applicationName}
  `;
  for (const row of stuck) {
    await probe`SELECT pg_terminate_backend(${row.pid})`;
  }
}

describe.skipIf(!live)('createTestDatabase setup failure cleanup', () => {
  it('ends the admin pool when assertTestDatabase refuses before CREATE DATABASE', async () => {
    const service = 'l1281assert';
    const prefix = `itf_run_${service}_${process.pid}_`;
    const app = 'l1281_assert_pool';
    const host = `l1281_assert_host_${process.pid}`;
    const probe = postgres(L1281_URL, { max: 1, onnotice: () => undefined });
    const hostUrl = new URL(L1281_URL);
    hostUrl.pathname = `/${host}`;
    hostUrl.searchParams.set('application_name', app);

    try {
      await probe.unsafe(`DROP DATABASE IF EXISTS "${host}" WITH (FORCE)`);
      await probe.unsafe(`CREATE DATABASE "${host}"`);

      let thrown: unknown;
      try {
        await createTestDatabase({ service, url: hostUrl.toString() });
        thrown = undefined;
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toMatchObject({
        message: expect.stringContaining('REFUSING TO RUN'),
      });

      expect(await l1281Databases(probe, prefix)).toEqual([]);
      expect(await l1281Activity(probe, app, prefix)).toEqual([]);
    } finally {
      const stuck = await probe<{ pid: number }[]>`
        SELECT pid
          FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
           AND (datname = ${host} OR application_name = ${app})
      `;
      for (const row of stuck) {
        await probe`SELECT pg_terminate_backend(${row.pid})`;
      }
      await probe.unsafe(`DROP DATABASE IF EXISTS "${host}" WITH (FORCE)`);
      await l1281Reclaim(probe, prefix, app);
      await probe.end({ timeout: 5 });
    }
  });

  it('ends the admin pool when CREATE DATABASE fails without permission denied', async () => {
    const service = 'l1281ro';
    const prefix = `itf_run_${service}_${process.pid}_`;
    const app = 'l1281_ro_pool';
    const probe = postgres(L1281_URL, { max: 1, onnotice: () => undefined });
    let opened: TestDatabase | undefined;

    try {
      let thrown: unknown;
      try {
        opened = await createTestDatabase({
          service,
          url: l1281Url(app, { options: '-c default_transaction_read_only=on' }),
        });
        thrown = undefined;
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toMatchObject({
        code: '25006',
        message: expect.stringContaining('read-only transaction'),
      });
      expect(await l1281Databases(probe, prefix)).toEqual([]);
      expect(await l1281Activity(probe, app, prefix)).toEqual([]);
    } finally {
      if (opened) await opened.drop().catch(() => undefined);
      await l1281Reclaim(probe, prefix, app);
      await probe.end({ timeout: 5 });
    }
  });

  it.runIf(superuserFixture)('ends the admin pool and throws the CREATEDB message when permission is denied', async () => {
    const service = 'l1281denied';
    const prefix = `itf_run_${service}_${process.pid}_`;
    const app = 'l1281_denied_pool';
    const role = `l1281_nocreatedb_${process.pid}`;
    // CI's Postgres authenticates TCP logins with scram, so the role needs its own
    // password and the URL must carry it: otherwise login fails before the
    // CREATEDB check this test is about. (A trust-auth local server ignores it.)
    const rolePassword = `l1281-${process.pid}-pw`;
    const probe = postgres(L1281_URL, { max: 1, onnotice: () => undefined });
    const url = new URL(L1281_URL);
    url.username = role;
    url.password = rolePassword;
    url.searchParams.set('application_name', app);

    try {
      await probe.unsafe(`DROP ROLE IF EXISTS "${role}"`);
      await probe.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${rolePassword}' NOCREATEDB NOSUPERUSER NOCREATEROLE`);

      let thrown: unknown;
      try {
        await createTestDatabase({ service, url: url.toString() });
        thrown = undefined;
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(
        `createTestDatabase(${service}) cannot create a database: permission denied to create database`,
      );
      expect((thrown as Error).message).toContain('CREATEDB');
      expect(await l1281Databases(probe, prefix)).toEqual([]);
      expect(await l1281Activity(probe, app, prefix)).toEqual([]);
    } finally {
      const stuck = await probe<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND usename = ${role}
      `;
      for (const row of stuck) {
        await probe`SELECT pg_terminate_backend(${row.pid})`;
      }
      await probe.unsafe(`DROP ROLE IF EXISTS "${role}"`);
      await l1281Reclaim(probe, prefix, app);
      await probe.end({ timeout: 5 });
    }
  });

  it('drops the database and ends the pools when a migration throws', async () => {
    const service = 'l1281mig';
    const prefix = `itf_run_${service}_${process.pid}_`;
    const app = 'l1281_mig_pool';
    const sentinel = 'L1281-migration-failed';
    const probe = postgres(L1281_URL, { max: 1, onnotice: () => undefined });

    try {
      let thrown: unknown;
      try {
        await createTestDatabase({
          service,
          url: l1281Url(app),
          migrations: [`SELECT '${sentinel}'::int`],
        });
        thrown = undefined;
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toMatchObject({
        code: '22P02',
        message: expect.stringContaining(sentinel),
      });
      expect(await l1281Databases(probe, prefix)).toEqual([]);
      expect(await l1281Activity(probe, app, prefix)).toEqual([]);
    } finally {
      await l1281Reclaim(probe, prefix, app);
      await probe.end({ timeout: 5 });
    }
  });

  /**
   * COMMENT ON DATABASE does not fire ddl_command_end, so an event trigger
   * cannot fail it. A SHARE lock on pg_shdescription blocks that comment and
   * still lets the preceding catalog read and CREATE DATABASE through.
   * Cancelling the wait is the failure.
   */
  it.runIf(superuserFixture)(
    'drops the database and ends the pools when COMMENT ON DATABASE fails',
    async () => {
      const service = 'l1281comment';
      const prefix = `itf_run_${service}_${process.pid}_`;
      const app = 'l1281_comment_pool';
      const probe = postgres(L1281_URL, { max: 1, onnotice: () => undefined });
      const locker = postgres(L1281_URL, { max: 1, onnotice: () => undefined });
      let opened: TestDatabase | undefined;
      let thrown: unknown;

      try {
        let pending = Promise.resolve();
        await locker.begin(async (tx) => {
          await tx.unsafe('LOCK TABLE pg_shdescription IN SHARE MODE');
          pending = createTestDatabase({ service, url: l1281Url(app) }).then(
            (db) => {
              opened = db;
            },
            (err: unknown) => {
              thrown = err;
            },
          );

          const deadline = Date.now() + 4_000;
          let cancelled = false;
          while (Date.now() < deadline && !opened && thrown === undefined) {
            const waiting = await probe<{ pid: number }[]>`
            SELECT pid
              FROM pg_stat_activity
             WHERE application_name = ${app}
               AND pid <> pg_backend_pid()
               AND strpos(query, 'COMMENT ON DATABASE') > 0
          `;
            if (waiting[0]) {
              await probe`SELECT pg_cancel_backend(${waiting[0].pid})`;
              cancelled = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }

          if (cancelled) {
            const quiet = Date.now() + 2_000;
            while (Date.now() < quiet) {
              const still = await probe<{ pid: number }[]>`
              SELECT pid
                FROM pg_stat_activity
               WHERE application_name = ${app}
                 AND pid <> pg_backend_pid()
                 AND strpos(query, 'COMMENT ON DATABASE') > 0
            `;
              if (still.length === 0) break;
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          }
        });
        await pending;

        expect(thrown).toMatchObject({ code: '57014' });
        expect(await l1281Databases(probe, prefix)).toEqual([]);
        expect(await l1281Activity(probe, app, prefix)).toEqual([]);
      } finally {
        if (opened) await opened.drop().catch(() => undefined);
        await l1281Reclaim(probe, prefix, app);
        await probe.end({ timeout: 5 });
        await locker.end({ timeout: 5 });
      }
    },
    15_000,
  );

  it('returns a handle whose drop removes the database and the client', async () => {
    const service = 'l1281ok';
    const prefix = `itf_run_${service}_${process.pid}_`;
    const db = await createTestDatabase({
      service,
      url: L1281_URL,
      migrations: ['CREATE TABLE l1281ok.kept (id int primary key)'],
    });
    const probe = postgres(L1281_URL, { max: 1, onnotice: () => undefined });
    let dropped = false;

    try {
      expect(db.schema).toBe('l1281ok');
      expect(db.database).toMatch(new RegExp(`^itf_run_${service}_${process.pid}_\\d+_[a-z0-9]+_test$`));
      expect(db.database.endsWith('_test')).toBe(true);
      expect(db.url).toContain(`/${db.database}`);
      expect(typeof db.truncateAll).toBe('function');
      expect(typeof db.drop).toBe('function');

      await db.sql`INSERT INTO l1281ok.kept (id) VALUES (1)`;
      await db.truncateAll();
      expect(await db.sql`SELECT id FROM l1281ok.kept`).toEqual([]);

      await db.drop();
      dropped = true;

      expect(await l1281Databases(probe, prefix)).toEqual([]);
      const leaked = await probe<{ application_name: string; query: string }[]>`
        SELECT application_name, query
          FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
           AND (
             application_name = ${db.database}
             OR strpos(query, ${prefix}) > 0
           )
      `;
      expect(leaked).toEqual([]);
    } finally {
      if (!dropped) await db.drop().catch(() => undefined);
      await l1281Reclaim(probe, prefix, db.database);
      await probe.end({ timeout: 5 });
    }
  });
});

/**
 * The refuse path is the load-bearing one. Live suites only ever hit the
 * `_test` success branch; a regression that stopped throwing against
 * `intafaced` would be invisible until someone truncated the shared book.
 */
function sqlReturning(db: string, usr = 'intafaced_ops'): postgres.Sql {
  return (async () => [{ db, usr }]) as unknown as postgres.Sql;
}

describe('assertTestDatabase', () => {
  it('refuses a non-_test current_database', async () => {
    await expect(assertTestDatabase(sqlReturning('intafaced'), 'unit')).rejects.toThrow(/REFUSING TO RUN/);
  });

  it('returns when current_database ends in _test', async () => {
    await expect(assertTestDatabase(sqlReturning('intafaced_test'), 'unit')).resolves.toBeUndefined();
  });
});

describe('serialization failures', () => {
  it('recognises the codes worth retrying', () => {
    expect(isSerializationFailure({ code: '40001' })).toBe(true); // serialization_failure
    expect(isSerializationFailure({ code: '40P01' })).toBe(true); // deadlock_detected
  });

  it('does not retry a genuine constraint violation', () => {
    expect(isSerializationFailure({ code: '23505' })).toBe(false); // unique_violation
    expect(isSerializationFailure({ code: '23514' })).toBe(false); // check_violation
    expect(isSerializationFailure(new Error('boom'))).toBe(false);
    expect(isSerializationFailure(null)).toBe(false);
    expect(isSerializationFailure(undefined)).toBe(false);
  });
});
