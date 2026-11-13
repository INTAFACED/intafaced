#!/usr/bin/env node
/**
 * CI'S UNIT RUN, ON A BUILDER'S MACHINE, BEFORE THE PUSH.
 *
 * Why: a builder's "affected" vitest run was a guess at what CI would test. CI's `Tests (changed)` job runs every test
 * of the changed packages, their dependents and their readers, on a real Postgres; the guess ran the files near the
 * change, and database suites skipped for want of a database. Of 98 journey pull requests, 31 first heads were red on
 * CI's unit run, and the guess had missed every one (project-state #2065, rows d22 and d32 part 1). A fast red makes
 * the builder push again, which cancels the journeys run before its verdict.
 *
 * What runs is CI's, read from CI's own files on every call, so it cannot drift:
 *   · the packages: tooling/ci/ci-affected.mjs `affectedFilters` against the merge-base (what `--filters` prints in
 *     the `Pick this job's packages` step), turbo filters `...[<merge-base>]` plus the readers in test-read-edges.json;
 *   · the database: the `Test environment` step of .github/actions/test-infra/action.yml (TEST_DATABASE_URL and the
 *     per-service URLs, REQUIRE_POSTGRES=1, so a database suite fails instead of skipping), the same bootstrap script
 *     (tooling/infra/postgres-init/02-intafaced-test-db.sh), the same schema count and tooling/ci/assert-test-db-env.mjs;
 *   · the build and the run: `pnpm turbo run build <filters> --filter=!./apps/*`, then `pnpm test --continue <filters>`.
 * Left out, and said so in the output: the NATS bus, Redis and the EVM chains (their suites run in CI), and for a
 * run-everything change CI's sixteen shards (this runs its changed packages and their dependents). Clocks are UTC, as on
 * CI's runners.
 *
 * `node tooling/ci/gates.mjs` runs it after the gates on a builder's machine (no `CI` variable), so a builder runs one
 * command before a push. It is an early copy of CI's verdict, never a replacement for it.
 *
 *   node tooling/scripts/ci-tests.mjs                  the branch against its merge-base with origin/main
 *   node tooling/scripts/ci-tests.mjs --base <ref>     against another ref (a stacked branch)
 *   node tooling/scripts/ci-tests.mjs --list           print what would run, run nothing
 *   CI_TESTS_CONCURRENCY=<n>                          packages at once (default 2; CI's runner uses 3 on 4 cores)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const ACTION = '.github/actions/test-infra/action.yml';
const BOOTSTRAP = 'tooling/infra/postgres-init/02-intafaced-test-db.sh';

/** The keys of CI's test environment that a builder's machine provides: the database ones. */
export const LOCAL_KEYS = /^(REQUIRE_POSTGRES|TEST_DATABASE_URL(_[A-Z0-9_]+)?)$/;

/**
 * CI's test environment, read from the `Test environment` step of the test-infra action: each `echo 'K=V'` line and
 * the per-service loop. Returns { env, skipped } with only LOCAL_KEYS in env. Throws when the step can't be read, so
 * a changed action is a red here, never a run against a guessed database.
 */
export function ciTestEnv(actionText) {
  const step = actionText.split(/- name: /).find((s) => s.startsWith('Test environment'));
  if (!step) throw new Error(`${ACTION}: no "Test environment" step`);
  const env = {};
  for (const m of step.matchAll(/echo '([A-Z0-9_]+)=([^']*)'/g)) env[m[1]] = m[2];
  const loop = step.match(/for pair in ([^;]+);\s*do\s+echo "TEST_DATABASE_URL_\$\{pair%%:\*\}=([^"]+)"/);
  if (!loop) throw new Error(`${ACTION}: the per-service TEST_DATABASE_URL loop changed shape`);
  for (const pair of loop[1].replace(/\\\n/g, ' ').trim().split(/\s+/)) {
    const [key, role] = pair.split(':');
    env[`TEST_DATABASE_URL_${key}`] = loop[2].replaceAll('${pair##*:}', role);
  }
  if (!env.TEST_DATABASE_URL || env.REQUIRE_POSTGRES !== '1') throw new Error(`${ACTION}: no TEST_DATABASE_URL or REQUIRE_POSTGRES`);
  const local = {};
  const skipped = [];
  for (const [k, v] of Object.entries(env)) LOCAL_KEYS.test(k) ? (local[k] = v) : skipped.push(k);
  return { env: local, skipped };
}

/** The schema count CI's `Prove the test database is actually populated` step expects, and its list. */
export function ciSchemaProof(actionText) {
  const expected = actionText.match(/expected=(\d+)/);
  const list = actionText.match(/nspname IN \(([^)]+)\)/);
  if (!expected || !list) throw new Error(`${ACTION}: the schema proof changed shape`);
  return { expected: Number(expected[1]), inList: list[1] };
}

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function changedFiles(mergeBase) {
  const tracked = git(['diff', '--name-only', '--no-renames', mergeBase]);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  return [...new Set((tracked + '\n' + untracked).split('\n').filter(Boolean))].sort();
}

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });

/** Bring the local test database to CI's shape (idempotent), then prove it as CI does. Returns an error or null. */
function prepareDatabase(env, actionText) {
  const url = new URL(env.TEST_DATABASE_URL);
  const pg = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGCONNECT_TIMEOUT: '5',
  };
  const boot = run('bash', [BOOTSTRAP], {
    env: { ...pg, POSTGRES_USER: pg.PGUSER, POSTGRES_DB: 'postgres' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (boot.status !== 0)
    return (
      `the test database at ${url.host} is not reachable or not bootstrapped (${String(boot.stderr ?? '')
        .trim()
        .slice(0, 200)}). ` +
      `CI's tests need Postgres 16 there with the role ${pg.PGUSER} (CI's test credentials, in ${ACTION}); on the Mac: brew services start postgresql@16`
    );
  const { expected, inList } = ciSchemaProof(actionText);
  const count = spawnSync(
    'psql',
    ['-d', url.pathname.slice(1), '-tAc', `SELECT count(*) FROM pg_namespace WHERE nspname IN (${inList});`],
    { env: pg, encoding: 'utf8' },
  );
  if (Number(String(count.stdout).trim()) !== expected)
    return `intafaced_test has ${String(count.stdout).trim() || 'no'} of ${expected} service schemas after the bootstrap`;
  const probe = run('node', ['tooling/ci/assert-test-db-env.mjs'], { env: { ...process.env, ...env } });
  return probe.status === 0 ? null : 'tooling/ci/assert-test-db-env.mjs refused the test database URLs (above)';
}

/** Select and run. Returns { ok, summary }. */
export async function runCiTests({ base = 'origin/main', list = false, log = console.log } = {}) {
  const { affectedFilters, classify, readEdges } = await import(new URL('../ci/ci-affected.mjs', import.meta.url));
  let mergeBase;
  try {
    mergeBase = git(['merge-base', 'HEAD', base]).trim();
  } catch {
    return { ok: false, summary: `no merge-base with ${base}: fetch it (git fetch origin main) and run again` };
  }
  const files = changedFiles(mergeBase);
  const flags = classify(files);
  if (!flags.full && !flags.affected) return { ok: true, summary: "nothing CI's unit run would test (docs only)" };
  const filters = affectedFilters(files, readEdges(), mergeBase).map((f) => `--filter=${f}`);
  const actionText = readFileSync(join(ROOT, ACTION), 'utf8');
  const { env, skipped } = ciTestEnv(actionText);

  log(`  CI's tests: ${filters.join(' ')}`);
  log(`  left to CI: ${skipped.join(', ')}${flags.full ? "; and CI's sixteen shards (a run-everything change)" : ''}`);
  if (list) {
    const dry = spawnSync('pnpm', ['turbo', 'run', 'test', ...filters, '--dry=json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
    const packages = dry.status === 0 ? JSON.parse(dry.stdout).packages.filter((p) => p !== '//') : null;
    return { ok: dry.status === 0, summary: packages ? `${packages.length} packages: ${packages.join(' ')}` : 'turbo --dry failed' };
  }

  const dbError = prepareDatabase(env, actionText);
  if (dbError) return { ok: false, summary: dbError };

  const build = run('pnpm', ['turbo', 'run', 'build', '--output-logs=errors-only', ...filters, '--filter=!./apps/*']);
  if (build.status !== 0) return { ok: false, summary: 'the build of the tested packages failed (above); CI builds them the same way' };

  const concurrency = process.env.CI_TESTS_CONCURRENCY || '2';
  const test = run('pnpm', ['test', '--continue', `--concurrency=${concurrency}`, '--output-logs=errors-only', ...filters], {
    env: { ...process.env, ...env, TZ: 'UTC', FORCE_COLOR: process.env.FORCE_COLOR ?? '0' },
  });
  return test.status === 0
    ? { ok: true, summary: `CI's unit selection passed (${filters.length} filters)` }
    : {
        ok: false,
        summary: "red on CI's own unit selection (failing packages above): CI's unit run fails the same way, so fix it before you push",
      };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const at = process.argv.indexOf('--base');
  const res = await runCiTests({ base: at > 0 ? process.argv[at + 1] : 'origin/main', list: process.argv.includes('--list') });
  console.log(`${res.ok ? '✓' : '✖'} CI's tests: ${res.summary}`);
  process.exit(res.ok ? 0 : 1);
}
