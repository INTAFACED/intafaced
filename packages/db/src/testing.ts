import postgres from 'postgres';
import { describeError, recordInfraProbe, redactUrl } from './infra-journal.js';

// `@intafaced/db/testing` is an entry point in its own right; anything reaching
// for the harness should get the journal that reports on it from the same import.
export * from './infra-journal.js';

/**
 * Test database harness (§1 Testing: "drizzle test DB").
 *
 * Each test run gets its own Postgres schema, created from the service's
 * migrations and dropped afterwards. Tests therefore run in parallel without
 * sharing state, and a test that corrupts a book cannot leak into the next one.
 */

/** Static SQL, or a factory that rewrites fully-qualified names to the unique schema. */
export type TestMigration = string | ((schema: string) => string);

export interface TestDbOptions {
  /** The service under test, e.g. 'ledger'. */
  service: string;
  url?: string;
  /** Applied in order to build the schema. Usually the service's migrations. */
  migrations?: readonly TestMigration[];
}

export interface TestDb {
  readonly url: string;
  readonly schema: string;
  readonly sql: postgres.Sql;
  truncateAll(): Promise<void>;
  drop(): Promise<void>;
}

let counter = 0;

const SAFE_IDENT = /^[a-z][a-z0-9_]*$/i;

const DEFAULT_ADMIN_URL = 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';

/**
 * How long a per-run schema or database may live before the sweeper treats it
 * as abandoned. Suites here run in seconds, so this is still orders of
 * magnitude of headroom, and the `backends = 0` condition is the real safety —
 * a live run is connected to its own object.
 *
 * Was two hours. Fifteen minutes, because the leak is no longer rare: a bounded
 * `drop()` (see DROP_WAIT_MS) deliberately walks away from a slow drop, so the
 * sweeper went from catching the occasional crashed worker to being the normal
 * way a database is reclaimed. Measured on this machine, the leftover count went
 * 5 -> 9 across a handful of runs at two hours; at fifteen minutes the backlog
 * drains between runs instead of compounding.
 */
const STALE_AFTER_MS = 15 * 60 * 1000;

/** Marker written into the object's COMMENT so the sweeper can date it. */
const STAMP = 'intafaced-test-run';

const stampFor = () => `${STAMP} ${new Date().toISOString()}`;

/**
 * Parse the creation stamp back out of a COMMENT.
 * Anything not written by us returns null and is therefore never swept.
 */
function stampAgeMs(comment: string | null): number | null {
  if (!comment || !comment.startsWith(`${STAMP} `)) return null;
  const at = Date.parse(comment.slice(STAMP.length + 1));
  if (Number.isNaN(at)) return null;
  return Date.now() - at;
}

export async function createTestDb(options: TestDbOptions): Promise<TestDb> {
  const url = options.url ?? process.env.TEST_DATABASE_URL ?? DEFAULT_ADMIN_URL;

  const schema = `test_${options.service}_${process.pid}_${++counter}`;
  if (!SAFE_IDENT.test(schema)) {
    throw new Error(`Refusing to create test schema with unsafe name: ${schema}`);
  }

  const admin = postgres(url, { max: 1, onnotice: () => undefined });
  let client: postgres.Sql | undefined;
  let schemaCreated = false;

  try {
    /**
     * Guard before the first DDL. `createTestDb` gives each run its own *schema*,
     * which isolates suites from each other — but it says nothing about which
     * *database* those schemas are created and dropped in. Pointed at the shared
     * `intafaced`, it happily creates and drops schemas inside the database the
     * running fleet uses. Schema isolation and database isolation are different
     * properties and only one of them was ever enforced here.
     */
    await assertTestDatabase(admin, `createTestDb(${options.service})`);

    await sweepStaleTestSchemas(admin);

    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    // CREATE SCHEMA and COMMENT each autocommit. A failure after CREATE must
    // drop the schema, or an unstamped one is left where the sweeper will not look.
    schemaCreated = true;
    // Dates the schema so an abandoned one can be swept. See sweepStaleTestSchemas.
    await admin.unsafe(`COMMENT ON SCHEMA "${schema}" IS '${stampFor()}'`);

    client = postgres(url, {
      max: 4,
      connection: { search_path: `${schema},public`, application_name: schema },
      onnotice: () => undefined,
    });
    const sql = client;

    for (const migration of options.migrations ?? []) {
      const body = typeof migration === 'function' ? migration(schema) : migration;
      await sql.unsafe(body);
    }

    return {
      url,
      schema,
      sql,
      truncateAll: async () => {
        const tables = await sql<Array<{ tablename: string }>>`
          SELECT tablename FROM pg_tables WHERE schemaname = ${schema}
        `;
        if (tables.length === 0) return;
        const list = tables.map((t) => `"${schema}"."${t.tablename}"`).join(', ');
        await sql.unsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
      },
      drop: async () => {
        await sql.end({ timeout: 5 });
        await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end({ timeout: 5 });
      },
    };
  } catch (err) {
    // The caller does not get drop(). End every pool this attempt opened, and
    // remove a schema CREATE already committed, then rethrow the original error.
    await client?.end({ timeout: 5 }).catch(() => undefined);
    if (schemaCreated) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    }
    await admin.end({ timeout: 5 }).catch(() => undefined);
    throw err;
  }
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PER-RUN DATABASE — isolation for services whose SQL is schema-qualified
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `createTestDb` above isolates by SCHEMA. That only works when the service's
 * SQL is search_path-relative, because the generated schema has a name nobody
 * can predict (`test_ledger_4711_1`). svc-pay, svc-trade and svc-bank write
 * `pay.merchants`, `trade.markets`, `bank.spaces` — fully qualified, on purpose
 * (§2: a service physically cannot reach outside its own schema). Their SQL
 * cannot run inside a schema called anything else, which is exactly why
 * `bank-service.test.ts` documented schema isolation as unavailable to it and
 * stayed on the shared `bank` schema instead.
 *
 * The unstated assumption in that reasoning is that the isolation boundary has
 * to be the schema. It does not. Give the run its own DATABASE and create the
 * service's REAL schema name inside it: `trade.markets` resolves, every
 * migration applies verbatim, and no production statement changes by a
 * character. Two worktrees running the same suite now truncate different
 * `trade.orders` tables in different databases.
 *
 * Why this and not "make the production SQL schema-agnostic": stripping the
 * qualification makes every production query depend on the connection having
 * `search_path` set correctly. That trades a test-harness problem for a
 * production one, in three services that move money, two of which are owned by
 * a human on a claimed mountain. The cost here is instead ~130 ms of
 * `CREATE DATABASE` per suite file, paid once.
 *
 * The `assertTestDatabase` guard from #211 is not weakened. It runs twice: once
 * on the ADMIN connection, which must itself be a `*_test` database before we
 * are willing to issue `CREATE DATABASE` from it, and once on the per-run
 * database. Both ask the server for `current_database()`, so a lying URL is
 * still caught.
 */

export interface TestDatabaseOptions {
  /**
   * The service under test. Also the name of the schema created inside the
   * per-run database — that is the whole point, so `trade.markets` resolves.
   */
  service: string;
  /**
   * Admin URL. Must be a `*_test` database whose role may CREATE DATABASE.
   * Defaults to `TEST_DATABASE_URL`, then the local compose ops role.
   */
  url?: string;
  /** Applied verbatim, in order. These are the service's real migrations. */
  migrations?: readonly string[];
  /** Extensions the migrations rely on. Both defaults are PG13+ trusted. */
  extensions?: readonly string[];
  /** search_path for the returned client. Defaults to `<service>,public`. */
  searchPath?: string;
}

export interface TestDatabase {
  /** Connection URL of the per-run database. */
  readonly url: string;
  /** Name of the per-run database. Always ends in `_test`. */
  readonly database: string;
  /** The service schema inside it — the real one, e.g. `trade`. */
  readonly schema: string;
  readonly sql: postgres.Sql;
  truncateAll(): Promise<void>;
  drop(): Promise<void>;
}

/** Prefix that marks a database as ours, so the sweeper can recognise it. */
const RUN_DB_PREFIX = 'itf_run_';

/**
 * How long a suite WAITS for its database to be dropped before walking away and
 * leaving it to the sweeper.
 *
 * MEASURED, not guessed. Docker Desktop for Windows, idle server, nothing else
 * running, five consecutive create/drop pairs:
 *
 *   CREATE   921 ms   DROP   4919 ms
 *   CREATE    72 ms   DROP  30277 ms
 *   CREATE    76 ms   DROP  26339 ms
 *   CREATE    62 ms   DROP    345 ms
 *   CREATE    29 ms   DROP     45 ms
 *
 * Creating is cheap; dropping is not. `DROP DATABASE` is a recursive delete of
 * the data directory, and on a Docker overlay filesystem that occasionally
 * takes half a minute for seven megabytes. Two of those five exceed the entire
 * 30s `afterAll` budget the suites had already raised for this — so the run
 * fails in TEARDOWN, after every assertion passed, usually on a service the
 * change under test never touched.
 *
 * That is the flake that has been landing on `svc-trade`, `svc-bank`,
 * `svc-indexer` and `packages/db` at random. It is NOT contention between
 * worktrees and NOT connection exhaustion — 10 of 200 connections were in use
 * when this was measured. Both were blamed in earlier notes, mine included.
 *
 * Two seconds covers the common case with room to spare. Waiting longer buys
 * nothing a suite cares about: the database is already unreachable to everyone
 * else, its name is unique to a run that has ended, and
 * `sweepStaleTestDatabases` exists precisely to reclaim what a crash leaves.
 */
const DROP_WAIT_MS = 2_000;

/** How long `drop()` lets in-flight statements finish before it closes the pool anyway. Seconds, as postgres.js takes it. */
const DRAIN_WAIT_S = 2;

/**
 * Total time one sweep may spend dropping, across all candidates.
 *
 * The sweep runs inside `createTestDatabase`, so it is inside somebody's
 * `beforeAll`. Without a budget, a suite that happens to start when five
 * databases are due for collection pays for all five — housekeeping becoming
 * the failure it exists to clean up after.
 */
const SWEEP_BUDGET_MS = 2_000;

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export async function createTestDatabase(options: TestDatabaseOptions): Promise<TestDatabase> {
  const adminUrl = options.url ?? process.env.TEST_DATABASE_URL ?? DEFAULT_ADMIN_URL;
  const schema = options.service;

  if (!SAFE_IDENT.test(schema)) {
    throw new Error(`Refusing to create test schema with unsafe name: ${schema}`);
  }

  /**
   * pid alone is not unique — CI runs suites in containers that can share one.
   * The random tail costs nothing and removes the class of bug entirely.
   * The `_test` SUFFIX is load-bearing: `assertTestDatabase` keys off it.
   */
  const database = `${RUN_DB_PREFIX}${schema}_${process.pid}_${++counter}_${Math.random().toString(36).slice(2, 8)}_test`;
  if (!SAFE_IDENT.test(database) || database.length > 63) {
    throw new Error(`Refusing to create test database with unsafe name: ${database}`);
  }

  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  let databaseCreated = false;
  let client: postgres.Sql | undefined;

  try {
    /**
     * The admin connection must itself own a test database before it is allowed
     * to create more. Pointed at the shared `intafaced` this would still only
     * CREATE (never drop anything pre-existing), but a suite that is willing to
     * talk to the live database at all is one URL typo away from truncating it.
     */
    await assertTestDatabase(admin, `createTestDatabase(${schema})`);

    await sweepStaleTestDatabases(admin);

    try {
      await admin.unsafe(`CREATE DATABASE "${database}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/permission denied to create database/i.test(msg)) throw err;
      /**
       * The single most likely failure on a machine whose Postgres volume predates
       * this harness: the init script only runs on a FRESH volume, so an existing
       * `intafaced_ops` never picked up CREATEDB. Say the fix rather than leaving
       * 85 worktrees to each rediscover it.
       *
       * This branch did not create a database. The outer catch ends the admin pool.
       */
      throw new Error(
        `createTestDatabase(${schema}) cannot create a database: ${msg}\n\n` +
          `This suite isolates itself with a per-run database, which needs the CREATEDB\n` +
          `role attribute. tooling/infra/postgres-init/02-intafaced-test-db.sh grants it,\n` +
          `but postgres-init scripts run ONLY when the data volume is first created — so an\n` +
          `existing local Postgres will not have it.\n\n` +
          `Fix, either one:\n` +
          `  docker compose exec postgres psql -U intafaced -c "ALTER ROLE intafaced_ops WITH CREATEDB"\n` +
          `  docker compose down -v && docker compose up -d    (destroys local dev data)`,
      );
    }
    // CREATE DATABASE and COMMENT each autocommit. A failure after CREATE must
    // drop the database, or an unstamped one is left where the sweeper will not look.
    databaseCreated = true;
    // Dates the database so an abandoned one can be swept. See sweepStaleTestDatabases.
    await admin.unsafe(`COMMENT ON DATABASE "${database}" IS '${stampFor()}'`);

    const url = withDatabase(adminUrl, database);
    client = postgres(url, {
      max: 8,
      connection: { search_path: options.searchPath ?? `${schema},public`, application_name: database },
      onnotice: () => undefined,
    });
    const sql = client;

    // Second guard, on the database the destructive statements will actually hit.
    await assertTestDatabase(sql, `createTestDatabase(${schema}) → ${database}`);

    // pgcrypto: gen_random_uuid() is a column default in these migrations.
    // citext: case-insensitive keys. Both are trusted in PG13+, so the role
    // that owns this freshly created database may install them without
    // superuser — which is why the suites can run as `intafaced_ops`.
    for (const ext of options.extensions ?? ['pgcrypto', 'citext']) {
      if (!SAFE_IDENT.test(ext)) throw new Error(`Unsafe extension name: ${ext}`);
      await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS "${ext}"`);
    }

    /**
     * The service schema, under its REAL name. In production this is created by
     * the database bootstrap (tooling/infra/postgres-init/01-service-schemas.sql)
     * rather than by a migration, so the migrations below assume it exists.
     */
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

    // Verbatim. Not rewritten, not de-qualified — this is the production SQL.
    for (const migration of options.migrations ?? []) {
      await sql.unsafe(migration);
    }

    return {
      url,
      database,
      schema,
      sql,
      truncateAll: async () => {
        const tables = await sql<Array<{ tablename: string }>>`
        SELECT tablename FROM pg_tables WHERE schemaname = ${schema}
      `;
        if (tables.length === 0) return;
        const list = tables.map((t) => `"${schema}"."${t.tablename}"`).join(', ');
        await sql.unsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
      },
      drop: async () => {
        /**
         * A graceful drain, bounded. An idle pool ends at once; the bound only
         * applies while a statement is still in flight.
         *
         * It was `timeout: 0`, which destroys every connection on the next tick.
         * A connection that has just opened runs postgres.js's own array-type
         * lookup before its first statement, and the library never handles that
         * promise: destroyed mid-lookup, it surfaces as an unhandled rejection
         * (`CONNECTION_DESTROYED`, `select b.oid, b.typarray ...`) and fails a
         * suite whose every test passed. That was the svc-pay red with no FAIL
         * line. Draining lets the lookup and its statement finish first.
         */
        await sql.end({ timeout: DRAIN_WAIT_S }).catch(() => undefined);

        /**
         * BOUNDED WAIT — see DROP_WAIT_MS for the measurements behind it.
         *
         * The drop is still issued, and is still the normal way a database goes
         * away. What changed is that the suite stops WAITING for it after two
         * seconds instead of holding the `afterAll` budget open for up to thirty.
         *
         * The connection is deliberately NOT closed on the timeout path. Ending
         * the pool would cancel the in-flight `DROP DATABASE` server-side and
         * turn a slow drop into a guaranteed leak — so the pool closes when the
         * drop settles, whenever that is, and this function returns before it.
         *
         * FORCE terminates leftover backends; without it one straggler connection
         * fails the drop and the database leaks until the sweeper catches it.
         */
        const dropped = admin
          .unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
          .catch(() => undefined)
          .then(() => admin.end({ timeout: 0 }).catch(() => undefined));

        // `unref` so a slow drop can never be the reason a vitest worker stays
        // alive — the whole point is that nothing waits on this.
        await Promise.race([
          dropped,
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, DROP_WAIT_MS);
            timer.unref?.();
          }),
        ]);
      },
    };
  } catch (err) {
    // The caller does not get drop(). End every pool this attempt opened, and
    // remove a database CREATE already committed, then rethrow the original error.
    await client?.end({ timeout: 5 }).catch(() => undefined);
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => undefined);
    }
    await admin.end({ timeout: 5 }).catch(() => undefined);
    throw err;
  }
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SWEEPERS — the leak is bounded, not eliminated
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Both helpers drop their object in `drop()`. A process killed between create
 * and drop — Ctrl-C, an OOM, a crashed vitest worker — leaves it behind, and
 * "leaves it behind" compounds: the shared `intafaced_test` had 27 abandoned
 * `test_%` schemas by the time this was written, from runs weeks old.
 *
 * So every create sweeps first. Two conditions must BOTH hold before anything
 * is dropped, because dropping a live run's schema would be worse than the leak:
 *
 *   1. It carries OUR stamp and the stamp is older than STALE_AFTER_MS (2h).
 *      Unstamped objects are never touched — they were not created by this code
 *      and we cannot date them.
 *   2. No backend is connected to it.
 *
 * Suites here finish in seconds, so (1) alone has ~700x headroom; (2) is the
 * belt to its braces. The cost is one indexed catalog query per suite file.
 */

/** Drop abandoned per-run schemas left by `createTestDb`. Best-effort. */
export async function sweepStaleTestSchemas(admin: postgres.Sql, staleAfterMs = STALE_AFTER_MS): Promise<string[]> {
  const dropped: string[] = [];
  try {
    const rows = await admin<Array<{ nspname: string; comment: string | null }>>`
      SELECT n.nspname, obj_description(n.oid, 'pg_namespace') AS comment
        FROM pg_namespace n
       WHERE n.nspname LIKE 'test\\_%'
    `;
    for (const row of rows) {
      const age = stampAgeMs(row.comment);
      if (age === null || age < staleAfterMs) continue;
      const busy = await admin<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = ${row.nspname}
      `;
      if ((busy[0]?.n ?? 0) > 0) continue;
      if (!SAFE_IDENT.test(row.nspname)) continue;
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${row.nspname}" CASCADE`);
      dropped.push(row.nspname);
    }
  } catch {
    // A sweep failure must never fail the suite that triggered it.
  }
  return dropped;
}

/** Drop abandoned per-run databases left by `createTestDatabase`. Best-effort. */
export async function sweepStaleTestDatabases(admin: postgres.Sql, staleAfterMs = STALE_AFTER_MS): Promise<string[]> {
  const dropped: string[] = [];
  try {
    const rows = await admin<Array<{ datname: string; comment: string | null; backends: number }>>`
      SELECT d.datname,
             shobj_description(d.oid, 'pg_database') AS comment,
             (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datid = d.oid) AS backends
        FROM pg_database d
       WHERE d.datname LIKE ${`${RUN_DB_PREFIX}%\\_test`}
    `;
    /**
     * BUDGETED, for the same reason `drop()` is bounded: a `DROP DATABASE` can
     * take half a minute on a Docker overlay filesystem (see DROP_WAIT_MS), and
     * this loop runs inside `createTestDatabase` — which is inside a suite's
     * `beforeAll`. Sweeping five abandoned databases without a budget would
     * blow the setup hook of the suite that was merely unlucky enough to start
     * next, turning housekeeping into the very failure it cleans up after.
     *
     * Whatever is not reclaimed this pass is reclaimed on a later one. The
     * backlog is bounded by the staleness window, not by finishing here.
     */
    const deadline = Date.now() + SWEEP_BUDGET_MS;
    for (const row of rows) {
      if (Date.now() >= deadline) break;
      const age = stampAgeMs(row.comment);
      if (age === null || age < staleAfterMs) continue;
      if (row.backends > 0) continue;
      if (!SAFE_IDENT.test(row.datname) || !row.datname.endsWith('_test')) continue;
      await admin.unsafe(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`);
      dropped.push(row.datname);
    }
  } catch {
    // A sweep failure must never fail the suite that triggered it.
  }
  return dropped;
}

/**
 * Rewrite a service migration that hardcodes `"service"` / `service.` into the
 * unique test schema name. Used so createTestDb isolation works when production
 * SQL is schema-qualified on purpose.
 */
export function rewriteSchemaSql(sql: string, fromSchema: string, toSchema: string): string {
  if (!SAFE_IDENT.test(fromSchema) || !SAFE_IDENT.test(toSchema)) {
    throw new Error(`Unsafe schema rewrite: ${fromSchema} → ${toSchema}`);
  }
  // Quoted identifiers first, then bare schema. prefixes (not inside other words).
  return sql.replaceAll(`"${fromSchema}"`, `"${toSchema}"`).replace(new RegExp(`\\b${fromSchema}\\.`, 'g'), `${toSchema}.`);
}

/**
 * True when CI (or REQUIRE_POSTGRES=1) demands a live database.
 * Residual #9: money suites must not silently `describe.skip` on CI.
 */
export function postgresRequired(): boolean {
  return process.env.CI === 'true' || process.env.CI === '1' || process.env.REQUIRE_POSTGRES === '1';
}

/**
 * Resolve a service test DB URL.
 * Prefers a service-specific env, then TEST_DATABASE_URL, then the local compose default.
 */
export function resolveTestDatabaseUrl(serviceEnvKey: string | undefined, localDefault: string): string {
  if (serviceEnvKey) {
    const specific = process.env[serviceEnvKey];
    if (specific && specific.trim() !== '') return specific;
  }
  const shared = process.env.TEST_DATABASE_URL;
  if (shared && shared.trim() !== '') return shared;
  return localDefault;
}

/**
 * THE GUARD. Refuse to run a destructive suite against a non-test database.
 *
 * Isolation that lives only in `.env` is aspirational: `.env` is gitignored, so
 * every developer's copy drifts, and a variable that is merely *absent* falls
 * back to whatever the code's default happens to be. That is not a hypothetical
 * — it is how the shared `intafaced` database on :5433 accumulated 307 pending
 * `identity.kyc_records`, how a branch's `loan_*` tables broke `main`'s custody
 * doctrine test from a different checkout entirely, and how svc-pay came to
 * `TRUNCATE pay.deposits` on a database with live rows in it.
 *
 * A test suite is allowed to be destructive — truncate, apply migrations, drop
 * schemas — precisely and only because it owns its database. This function is
 * what converts that sentence from a comment into an enforced precondition. It
 * asks Postgres itself (`current_database()`), not the connection string, so a
 * URL that lies, a `PGDATABASE` override, or a pooler that redirects elsewhere
 * are all caught. Call it BEFORE the first destructive statement.
 *
 * The rule is a suffix, not a fixed name: any database ending in `_test` is
 * fair game (`intafaced_test`, `intafaced_bank_loans_test`, a per-CI-job DB),
 * and everything else — above all the shared `intafaced` — is refused. A suffix
 * rule stays correct as services add dedicated databases; a hardcoded name
 * would have to be edited every time and would silently rot.
 *
 * Failing loudly here is the entire point. The alternative is what we had: a
 * green suite that quietly mutated the database the running fleet is using.
 */
export async function assertTestDatabase(sql: postgres.Sql, context: string): Promise<void> {
  const rows = await sql<Array<{ db: string; usr: string }>>`
    SELECT current_database() AS db, current_user AS usr
  `;
  const db = rows[0]?.db ?? '<unknown>';
  const usr = rows[0]?.usr ?? '<unknown>';

  if (db.endsWith('_test')) return;

  throw new Error(
    `REFUSING TO RUN ${context} against database "${db}" (as "${usr}").\n\n` +
      `This suite applies migrations and/or truncates tables. It may only run\n` +
      `against a dedicated test database — one whose name ends in "_test".\n` +
      `"${db}" is not one, and on a developer machine it is almost certainly the\n` +
      `SHARED database the local docker fleet and every other git worktree use.\n\n` +
      `Fix: set the suite's TEST_DATABASE_URL_* variable to a *_test database.\n` +
      `  cp .env.example .env   (it ships correct values for every service)\n` +
      `Compose creates and bootstraps intafaced_test via\n` +
      `tooling/infra/postgres-init/02-intafaced-test-db.sh — if it is missing,\n` +
      `run: docker compose down -v && docker compose up -d`,
  );
}

/**
 * True when a live Postgres is reachable — lets *local* suites skip rather than fail.
 * On CI / REQUIRE_POSTGRES, unreachable Postgres is a hard failure (no silent green).
 *
 * THIS IS THE ONLY SANCTIONED POSTGRES PROBE. Five suites used to open their own
 * two-line `reachable()` helper instead, which swallowed the error and returned
 * `false` no matter what — so `REQUIRE_POSTGRES=1` and `CI=true` did nothing to
 * them and five money suites could silently skip on CI. `tooling/ci/skip-honesty-scan.mjs`
 * now fails a build that re-introduces a private probe. Use this one.
 *
 * Every call is journalled (`packages/db/src/infra-journal.ts`) whichever way it
 * goes, so `pnpm verify` can say out loud which suites did not run instead of
 * letting turbo's "N successful" imply that they did.
 */
export async function postgresAvailable(url?: string): Promise<boolean> {
  const target = url ?? process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
  /**
   * Three seconds, not two. Five suites carried a private probe with a 3s
   * timeout; folding them onto this one at 2s would have manufactured skips
   * under exactly the parallel load that started this. A probe must never be
   * stingier than the suites it gates.
   */
  const sql = postgres(target, { max: 1, connect_timeout: 3, onnotice: () => undefined });
  try {
    await sql`SELECT 1`;
    recordInfraProbe({ dependency: 'postgres', outcome: 'ran', target });
    return true;
  } catch (err) {
    const msg = redactUrl(describeError(err));
    if (postgresRequired()) {
      recordInfraProbe({ dependency: 'postgres', outcome: 'required-failed', target, reason: msg });
      throw new Error(
        `Postgres required in CI (residual #9) but unreachable at ${redactUrl(target)}: ${msg}. ` +
          `Bootstrap service roles and set TEST_DATABASE_URL_* (see .github/workflows/ci.yml).`,
      );
    }
    recordInfraProbe({ dependency: 'postgres', outcome: 'skipped', target, reason: msg });
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
}
