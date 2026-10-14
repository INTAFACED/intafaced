#!/usr/bin/env node
/**
 * TEST DB SCAN — no test may aim itself at the shared database.
 *
 * THE FAILURE THIS EXISTS TO PREVENT
 *
 * Test suites here connect to a real Postgres, apply migrations, and truncate
 * tables. That is legitimate — the interesting bugs in a money system live in
 * the database, not above it. It is legitimate *only* while each suite owns the
 * database it points at.
 *
 * For a long stretch it did not. Every service's fallback URL named `intafaced`
 * — the same database the local docker fleet serves and every git worktree on
 * the machine shares. A missing environment variable therefore did not fail; it
 * silently aimed a destructive suite at live data. In one day that produced:
 *
 *   · svc-identity's KYC queue test failing on `main` and unable to self-heal.
 *     `kyc_records` accumulated across every run by every worktree (307 pending
 *     rows). The queue is oldest-first under a LIMIT, so past that limit a
 *     record created *now* could never appear. It passed on fresh Postgres,
 *     so CI was green while `main` was red on every developer's machine.
 *   · svc-pay TRUNCATE-ing `pay.deposits` / `pay.withdrawals` — tables that had
 *     live rows in the running stack.
 *   · svc-bank's §0.6 custody test failing on `loan_*` tables that exist in no
 *     migration on `main`. An unmerged branch had applied them to the shared
 *     database from a different checkout, making `main` look like it violated
 *     custody doctrine. No clean checkout and no `git bisect` could have found
 *     that, because the cause was not in the history being bisected.
 *   · assorted flaky reds under parallel load, each costing an agent a wrong
 *     turn as they attributed it to their own diff.
 *
 * Three defences now exist, and this is the third:
 *   1. every suite's code default names a `*_test` database;
 *   2. `assertTestDatabase` (packages/db) asks Postgres for `current_database()`
 *      at runtime and refuses to proceed unless the name ends in `_test`;
 *   3. this scan, which catches a shared-database name at review time — before
 *      it is ever run, and without needing a Postgres to be up.
 *
 * (1) is a default, and defaults get overridden. (2) is the real enforcement,
 * but it only fires when the suite actually runs, which needs a database. This
 * check is cheap, runs in the `gates` job with no services attached, and puts
 * the explanation in the diff where the mistake is being made.
 *
 * WHAT COUNTS AS A VIOLATION
 *
 * A test file that (a) can actually open a Postgres connection and (b) names a
 * database that is not `*_test`. The scan reads the database name out of the
 * connection string, so `.../intafaced_test` is fine, `.../intafaced` is not,
 * and a future `.../intafaced_bank_loans_test` is fine without editing this file.
 *
 * Condition (a) matters. `packages/config/src/env.test.ts` contains the literal
 * `postgres://svc_ledger:svc_ledger@localhost:5432/intafaced` as a fixture for
 * env-schema validation; it imports no driver and connects to nothing. Flagging
 * it would be a false positive, and the practical fate of a gate that cries
 * wolf is that someone disables it — at which point it protects nothing. So a
 * connection string is only evidence of a connection when the file has some way
 * to make one.
 *
 * Exit 0 = every test file owns its database. Exit 1 = one of them does not.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/** Where test files live. `vendor/` is deliberately excluded — not our code. */
const ROOTS = ['services', 'packages', 'apps', 'tooling'];

/** Directories never worth walking into. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.turbo', 'coverage', '.git', 'vendor']);

const TEST_FILE = /\.(test|spec)\.(ts|tsx|mts|js|mjs)$/;

/**
 * A postgres connection string, captured far enough to read the database name.
 * Matches postgres:// and postgresql://, with or without credentials.
 */
const PG_URL = /\bpostgres(?:ql)?:\/\/[^\s'"`]+/g;

/**
 * Ways a test file can actually reach Postgres. Only files importing one of
 * these are capable of connecting, so only they can misdirect a connection.
 */
const CONNECTS = [
  /from\s+['"]postgres['"]/, // the `postgres` driver used by every service suite
  /from\s+['"]pg['"]/,
  /from\s+['"]@intafaced\/db(?:\/[a-z]+)?['"]/, // createTestDb / assertTestDatabase
  /from\s+['"]drizzle-orm[^'"]*['"]/,
];

/** @param {string} content */
function canConnect(content) {
  return CONNECTS.some((re) => re.test(content));
}

/**
 * Pull the database name out of a connection string.
 * Returns null when the string is too templated to read (e.g. `${base}/${db}`),
 * because guessing there would produce false positives and a gate that cries
 * wolf gets disabled.
 * @param {string} raw
 */
function databaseName(raw) {
  const withoutQuery = raw.split('?')[0];
  const afterHost = withoutQuery.replace(/^postgres(?:ql)?:\/\//, '');
  const slash = afterHost.indexOf('/');
  if (slash === -1) return null;
  // A URL quoted in a comment ends with the sentence's full stop: "postgres://h/postgres."
  // is the database `postgres`, not one called `postgres.`.
  const db = afterHost
    .slice(slash + 1)
    .trim()
    .replace(/[.,;:)\]]+$/, '');
  if (db === '' || db.includes('${') || db.includes('{')) return null;
  return db;
}

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (TEST_FILE.test(entry)) out.push(full);
  }
  return out;
}

/**
 * The Postgres maintenance database. `CREATE DATABASE` cannot run inside the
 * database it creates, so a suite that builds its OWN throwaway `*_test`
 * database has to connect to `postgres` first. That connection is the admin
 * door, not the shared data: it never applies a migration or truncates a table.
 */
const MAINTENANCE_DB = 'postgres';

/**
 * Source with comments removed, so a guard named only in prose ("we check
 * endsWith('_test')") cannot satisfy the scan. A `//` directly after `:` is the
 * scheme of a URL (`postgres://`), not a comment.
 * @param {string} content
 */
function stripComments(content) {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\w'"`])\/\/.*$/gm, '$1');
}

/**
 * A real runtime guard on the database being provisioned: the code asks
 * Postgres `current_database()`, or tests the name with `endsWith('_test')` /
 * `/_test$/`. A template literal that merely ENDS in `_test` is not a guard,
 * it is a naming habit: nothing refuses to run when the name is wrong.
 * @param {string} code comment-free source
 */
function hasTestNameGuard(code) {
  return (
    /\bcurrent_database\s*\(\s*\)/i.test(code) ||
    /\.endsWith\(\s*['"]_test['"]\s*\)/.test(code) ||
    /_test\$\/\s*\.test\(|\/_test\$\/\.test\(/.test(code)
  );
}

/**
 * A file that opens the maintenance database to provision a per-run
 * database, and guards in code that the database it provisions ends in `_test`.
 * Both halves are required: `postgres` alone stays a violation, so a suite
 * cannot reach the maintenance database and then run its migrations there.
 * @param {string} code comment-free source
 */
function provisionsOwnTestDatabase(code) {
  return /\bCREATE\s+DATABASE\b/i.test(code) && hasTestNameGuard(code);
}

/**
 * Every `DROP DATABASE` whose target is not a `${...}` interpolation. Dropping
 * is irreversible and the maintenance connection can drop ANYTHING, so the
 * target must be a variable the suite created itself (and guarded), never a
 * literal name such as `intafaced`.
 * @param {string} code comment-free source
 * @returns {{index: number, target: string}[]}
 */
function literalDrops(code) {
  const out = [];
  const re = /\bDROP\s+DATABASE\s+(?:IF\s+EXISTS\s+)?[\\"'`]*([^\s;)]*)/gi;
  let m;
  while ((m = re.exec(code)) !== null) {
    if (m[1].startsWith('${')) continue;
    const target = m[1].replace(/[\\"'`]+$/, '');
    out.push({ index: m.index, target: target === '' ? '(unreadable)' : target });
  }
  return out;
}

/**
 * Every location in one test file that names a non-`*_test` database, or
 * drops a database by a literal name.
 * @param {string} content
 * @returns {{line: number, db: string, snippet: string, kind: 'connect' | 'drop'}[]}
 */
function violationsIn(content) {
  if (!content.includes('postgres') || !canConnect(content)) return [];
  const code = stripComments(content);
  const provisions = provisionsOwnTestDatabase(code);
  const found = [];
  content.split(/\r?\n/).forEach((text, i) => {
    const matches = text.match(PG_URL);
    if (!matches) return;
    for (const raw of matches) {
      const db = databaseName(raw);
      if (db === null) continue;
      if (db.endsWith('_test')) continue;
      if (db === MAINTENANCE_DB && provisions) continue;
      found.push({ line: i + 1, db, snippet: text.trim().slice(0, 160), kind: 'connect' });
    }
  });
  const lines = code.split(/\r?\n/);
  for (const d of literalDrops(code)) {
    const line = code.slice(0, d.index).split(/\r?\n/).length;
    found.push({ line, db: d.target, snippet: (lines[line - 1] ?? '').trim().slice(0, 160), kind: 'drop' });
  }
  return found;
}

/**
 * The scan checks itself on every run. A narrowed scanner that stopped catching
 * the real case would print the same green tick as one that never did.
 */
const SELF_TEST = [
  {
    why: 'the shared database is still a violation',
    src: "import postgres from 'postgres';\nconst U = 'postgres://h:5432/intafaced';",
    expect: ['intafaced'],
  },
  {
    why: 'the maintenance database alone (no per-run provisioning) is still a violation',
    src: "import postgres from 'postgres';\nconst U = 'postgres://h:5432/postgres';\nawait sql`TRUNCATE t`;",
    expect: ['postgres'],
  },
  {
    why: 'CREATE DATABASE without a _test guard is still a violation',
    src: "import postgres from 'postgres';\nconst U = 'postgres://h:5432/postgres';\nawait a.unsafe(`CREATE DATABASE \"${name}\"`);",
    expect: ['postgres'],
  },
  {
    why: 'maintenance database used only to CREATE a per-run *_test database is clean',
    src: "import postgres from 'postgres';\nconst U = 'postgres://h:5432/postgres';\nconst name = `svc_${process.pid}_test`;\nif (!name.endsWith('_test')) throw new Error('refusing');\nawait a.unsafe(`CREATE DATABASE \"${name}\"`);",
    expect: [],
  },
  {
    why: 'a per-run name that merely ends in `_test` (template only, no guard in code) is still a violation',
    src: "import postgres from 'postgres';\nconst U = 'postgres://h:5432/postgres';\nconst name = `svc_${process.pid}_test`;\nawait a.unsafe(`CREATE DATABASE \"${name}\"`);",
    expect: ['postgres'],
  },
  {
    why: 'a guard that is only named in a comment is still a violation',
    src: "import postgres from 'postgres';\n// we check name.endsWith('_test') before creating\nconst U = 'postgres://h:5432/postgres';\nawait a.unsafe(`CREATE DATABASE \"${name}\"`);",
    expect: ['postgres'],
  },
  {
    why: 'a current_database() check clears the maintenance connection',
    src: "import postgres from 'postgres';\nconst U = 'postgres://h:5432/postgres';\nconst [live] = await s`SELECT current_database() AS db`;\nawait a.unsafe(`CREATE DATABASE \"${name}\"`);",
    expect: [],
  },
  {
    why: 'DROP DATABASE with a literal name is a violation even with a guard',
    src: "import postgres from 'postgres';\nconst U = 'postgres://h:5432/postgres';\nif (!name.endsWith('_test')) throw new Error('x');\nawait a.unsafe(`CREATE DATABASE \"${name}\"`);\nawait a.unsafe('DROP DATABASE IF EXISTS intafaced WITH (FORCE)');",
    expect: ['intafaced'],
  },
  {
    why: 'DROP DATABASE of a literal quoted name is a violation',
    src: "import postgres from 'postgres';\nawait a.unsafe('DROP DATABASE \"intafaced_test\"');",
    expect: ['intafaced_test'],
  },
  {
    why: 'DROP DATABASE of an interpolated, guarded name is clean',
    src: "import postgres from 'postgres';\nconst U = 'postgres://h:5432/postgres';\nif (!name.endsWith('_test')) throw new Error('x');\nawait a.unsafe(`CREATE DATABASE \"${name}\"`);\nawait a.unsafe(`DROP DATABASE IF EXISTS \"${name}\" WITH (FORCE)`);\nawait a.unsafe(`DROP DATABASE IF EXISTS ${name}`);",
    expect: [],
  },
  {
    why: 'a full stop after a URL in a comment is not part of the database name',
    src: "import postgres from 'postgres';\n// built from postgres://h:5432/postgres.\nconst name = `x_test`;\nif (!name.endsWith('_test')) throw new Error('refusing');\nawait a.unsafe(`CREATE DATABASE \"${name}\"`);",
    expect: [],
  },
  {
    why: 'a *_test database is clean',
    src: "import postgres from 'postgres';\nconst U = 'postgres://h:5432/intafaced_test';",
    expect: [],
  },
];
for (const c of SELF_TEST) {
  const got = violationsIn(c.src).map((v) => v.db);
  if (JSON.stringify(got) !== JSON.stringify(c.expect)) {
    console.error(`\n✖ TEST DB SCAN SELF-TEST FAILED — ${c.why}: expected [${c.expect}], got [${got}]\n`);
    process.exit(1);
  }
}

/** @type {string[]} */
const files = [];
for (const r of ROOTS) walk(join(ROOT, r), files);

/** @type {{file: string, line: number, db: string, snippet: string}[]} */
const violations = [];
/** Files holding a connection string but no way to connect — reported, not failed. */
const skipped = [];
let scanned = 0;

for (const file of files) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (!content.includes('postgres')) continue;
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (!canConnect(content)) {
    skipped.push(rel);
    continue;
  }
  scanned++;
  for (const v of violationsIn(content)) violations.push({ file: rel, ...v });
}

if (violations.length > 0) {
  console.error(`\n✖ TEST DB SCAN FAILED — ${violations.length} test file location(s) name a non-test database\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(
      v.kind === 'drop'
        ? `    → DROP DATABASE targets the literal name "${v.db}"; the target must be a \${...} variable the suite created and guarded`
        : `    → connects to database "${v.db}", which does not end in "_test"`,
    );
    console.error(`      ${v.snippet}\n`);
  }
  console.error('  Test suites apply migrations and truncate tables. Pointed at the shared');
  console.error('  `intafaced` database they mutate the data the local fleet and every other');
  console.error('  worktree are using — which has broken `main` from a different checkout.\n');
  console.error('  Fix: name a dedicated database (conventionally `intafaced_test`) and read it');
  console.error("  from the service's TEST_DATABASE_URL_* variable. See .env.example.\n");
  process.exit(1);
}

const note = skipped.length > 0 ? ` (${skipped.length} with fixture-only URLs and no driver import: ${skipped.join(', ')})` : '';
console.log(`✓ test-db-scan clean — ${scanned} Postgres-capable test file(s) of ${files.length} scanned, all on *_test databases${note}`);
