#!/usr/bin/env node
/**
 * CI'S CHECKS, ON A BUILDER'S MACHINE, BEFORE THE PUSH (the pre-push hook runs this; .githooks/pre-push).
 *
 * Why: a builder's checks before a push were a guess at CI's: the vitest files it picked near its change, on a Node that
 * isn't CI's, with no database, so every database suite skipped. Of 98 journey pull requests, 31 first heads were red on
 * CI's unit run and the guess had missed every one; 14 more were red on typecheck or build, 6 on a gate (project-state
 * #2065, rows d22 and d32 part 1). A fast red makes the builder push again, which cancels the journeys run before its
 * verdict. CI's whole unit selection run here took 44 minutes on one head (#8159's, 13 Nov), so the tests are narrowed by
 * code, below, and the replay over real past pushes is what shows the narrowing catches what CI catches.
 *
 * Read from CI's own files on every call, so nothing here is a hand list:
 *   · the packages: tooling/ci/ci-affected.mjs `affectedFilters` / `buildFilters` against the merge-base, the functions
 *     CI's jobs print (`--filters`, `--build-filters`);
 *   · Node: the major in .node-version (CI's setup-node), taken from /opt/homebrew/opt/node@<major> when the default
 *     node differs (Node 25+ has a global localStorage that breaks jsdom suites CI passes);
 *   · the database: the `Test environment` step of .github/actions/test-infra/action.yml (TEST_DATABASE_URL and the
 *     per-service URLs, REQUIRE_POSTGRES=1, so a database suite fails instead of skipping), CI's bootstrap script, its
 *     schema count and tooling/ci/assert-test-db-env.mjs;
 *   · the jobs, each with CI's command: gates (`node tooling/ci/gates.mjs --changed`), format (`format:check`'s prettier
 *     over the changed files), build (`turbo run build <build filters>`), typecheck (`turbo run typecheck <filters>`),
 *     tests (`vitest related --run` in each package CI's test job selects: the test files whose imports reach a changed
 *     file or its built twin in dist/, plus every test of the package that walks the source tree, which nothing imports).
 * Left out, and said so in the output: the NATS bus, Redis and the EVM chains (their suites run in CI), and the rest of
 * CI's unit selection (the test files no change reaches). Clocks are UTC, as on CI's runners. A pass here is an early
 * copy of CI's verdict, never a replacement for it.
 *
 *   node tooling/scripts/ci-checks.mjs                  the branch against its merge-base with origin/main
 *   node tooling/scripts/ci-checks.mjs --base <ref>     against another ref (a stacked branch)
 *   node tooling/scripts/ci-checks.mjs --list           print what would run, run nothing
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const ACTION = '.github/actions/test-infra/action.yml';
const BOOTSTRAP = 'tooling/infra/postgres-init/02-intafaced-test-db.sh';

/** A test that walks a directory and reads the source files it finds: no file imports it, so `related` never picks it. */
export const WALKS = /\breaddirSync\b|\bopendirSync\b|\bglobSync\b|\bls-files\b/;
export const READS_SOURCE = /\\?\.tsx?(?:\?|\$|['"`)\]|])|\bts\|tsx\b/;
export const IS_VITEST_FILE = /\.test\.tsx?$/;
export const ruleTest = (path, text) => IS_VITEST_FILE.test(path) && WALKS.test(text) && READS_SOURCE.test(text);

/** The keys of CI's test environment a builder's machine provides: the database ones. */
export const LOCAL_KEYS = /^(REQUIRE_POSTGRES|TEST_DATABASE_URL(_[A-Z0-9_]+)?)$/;

/**
 * CI's test environment, read from the `Test environment` step of the test-infra action: each `echo 'K=V'` line and
 * the per-service loop. Returns { env, skipped } with only LOCAL_KEYS in env. Throws when the step can't be read, so a
 * changed action is a red here, never a run against a guessed database.
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

/** A changed source file and its built twin (`src/a.ts` → `dist/a.js`), which a dependent package's tests import. */
export function withBuiltTwins(files) {
  const out = new Set(files);
  for (const f of files) {
    const m = f.match(/^((?:packages|services)\/[^/]+)\/src\/(.+)\.tsx?$/);
    if (m && !IS_VITEST_FILE.test(f)) out.add(`${m[1]}/dist/${m[2]}.js`);
  }
  return [...out];
}

/** The Node CI runs (.node-version's major): null when the default is it, else the bin dir to put first, or an error. */
export function ciNode(nodeVersionText, current = process.versions.node, exists = existsSync) {
  const want = String(nodeVersionText).trim().split('.')[0];
  if (!/^\d+$/.test(want)) return { error: `.node-version reads "${String(nodeVersionText).trim()}"` };
  if (current.split('.')[0] === want) return { bin: null, want };
  const bin = `/opt/homebrew/opt/node@${want}/bin`;
  return exists(`${bin}/node`)
    ? { bin, want }
    : { error: `CI runs Node ${want} and this machine has ${current}: brew install node@${want}` };
}

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function changedFiles(mergeBase) {
  const tracked = git(['diff', '--name-only', '--no-renames', mergeBase]);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  return [...new Set((tracked + '\n' + untracked).split('\n').filter(Boolean))].sort();
}

/** Bring the local test database to CI's shape (idempotent), then prove it as CI does. Returns an error or null. */
function prepareDatabase(env, actionText, run) {
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
    {
      env: pg,
      encoding: 'utf8',
    },
  );
  if (Number(String(count.stdout).trim()) !== expected)
    return `intafaced_test has ${String(count.stdout).trim() || 'no'} of ${expected} service schemas after the bootstrap`;
  const probe = run('node', ['tooling/ci/assert-test-db-env.mjs'], { env: { ...process.env, ...env } });
  return probe.status === 0 ? null : 'tooling/ci/assert-test-db-env.mjs refused the test database URLs (above)';
}

/** The packages a turbo filter set selects for a task (turbo --dry), as { name, directory }. */
function turboPackages(task, filters, env) {
  const dry = spawnSync('pnpm', ['turbo', 'run', task, ...filters, '--dry=json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    maxBuffer: 64 << 20,
  });
  if (dry.status !== 0) return null;
  const { tasks } = JSON.parse(dry.stdout);
  return tasks.filter((t) => t.task === task && t.package !== '//').map((t) => ({ name: t.package, directory: t.directory }));
}

/** Select and run. Returns { ok, summary }. */
export async function runCiChecks({ base = 'origin/main', list = false, log = console.log } = {}) {
  if (process.env.CI) return { ok: true, summary: 'in CI: its own jobs are the run' };
  const { affectedFilters, buildFilters, classify, readEdges } = await import(new URL('../ci/ci-affected.mjs', import.meta.url));
  let mergeBase;
  try {
    mergeBase = git(['merge-base', 'HEAD', base]).trim();
  } catch {
    return { ok: false, summary: `no merge-base with ${base}: fetch it (git fetch origin main) and run again` };
  }
  const files = changedFiles(mergeBase);
  const flags = classify(files);
  if (!flags.full && !flags.affected && !files.length) return { ok: true, summary: 'nothing changed' };

  const node = ciNode(readFileSync(join(ROOT, '.node-version'), 'utf8'));
  if (node.error) return { ok: false, summary: node.error };
  const baseEnv = node.bin ? { ...process.env, PATH: `${node.bin}:${process.env.PATH}` } : process.env;
  const run = (cmd, args, opts = {}) =>
    spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts, env: opts.env ? { ...opts.env, PATH: baseEnv.PATH } : baseEnv });

  const edges = readEdges();
  const filters = affectedFilters(files, edges, mergeBase).map((f) => `--filter=${f}`);
  const buildArgs = buildFilters(files, edges, mergeBase).map((f) => `--filter=${f}`);
  const actionText = readFileSync(join(ROOT, ACTION), 'utf8');
  const { env, skipped } = ciTestEnv(actionText);
  log(`  CI's checks on Node ${node.want}: ${filters.join(' ')}`);
  log(`  left to CI: ${skipped.join(', ')}; and the test files no change reaches`);

  const tested = flags.full || flags.affected ? turboPackages('test', filters, baseEnv) : [];
  if (tested === null) return { ok: false, summary: 'turbo could not list the packages CI would test' };
  const twins = withBuiltTwins(files).map((f) => join(ROOT, f));
  const plan = tested.map(({ name, directory }) => {
    const own = git(['ls-files', directory]).split('\n').filter(Boolean);
    const rules = own.filter((f) => IS_VITEST_FILE.test(f) && ruleTest(f, readFileSync(join(ROOT, f), 'utf8'))).map((f) => join(ROOT, f));
    return { name, directory, targets: [...twins, ...rules] };
  });
  if (list) {
    for (const p of plan) log(`  ${p.name}: related to ${twins.length} changed files, plus ${p.targets.length - twins.length} rule tests`);
    return { ok: true, summary: `${plan.length} packages` };
  }

  // Each job runs whatever the one before said, so one run lists every red, as the gates do.
  const results = [];
  const step = (name, ok, why) => {
    results.push({ name, ok });
    log(`  ${ok ? '✓' : '✖'} ${name}${ok ? '' : `: ${why}`}`);
  };

  const gates = run('node', ['tooling/ci/gates.mjs', '--changed', '--base', base]);
  step('gates', gates.status === 0, 'a doctrine gate (above)');

  const pattern = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts['format:check']?.match(/\{([^}]+)\}/);
  if (!pattern) step('format', false, "package.json's format:check changed shape: run `pnpm format:check`");
  else {
    const exts = pattern[1].split(',');
    const toCheck = files.filter((f) => exts.some((e) => f.endsWith(`.${e}`)) && existsSync(join(ROOT, f)));
    const fmt = toCheck.length ? run('pnpm', ['exec', 'prettier', '--check', ...toCheck]) : { status: 0 };
    step('format', fmt.status === 0, 'prettier (above): `pnpm exec prettier --write <file>`');
  }

  if (!flags.full && !flags.affected) {
    step('build, typecheck, tests', true);
  } else {
    // A build rewrites some tracked files (next's next-env.d.ts); put back each one the build changed, so the builder's
    // tree is as it was and the next run doesn't read the build's edits as the builder's.
    const dirty = () => new Set(git(['diff', '--name-only']).split('\n').filter(Boolean));
    const before = dirty();
    const build = run('pnpm', ['turbo', 'run', 'build', '--output-logs=errors-only', ...buildArgs]);
    const touched = [...dirty()].filter((f) => !before.has(f));
    if (touched.length) git(['checkout', '--', ...touched]);
    step('build', build.status === 0, 'the build failed (above)');
    const types = run('pnpm', ['turbo', 'run', 'typecheck', '--continue', '--output-logs=errors-only', ...filters]);
    step('typecheck', types.status === 0, 'type errors (above)');

    const dbError = prepareDatabase(env, actionText, run);
    if (dbError) step('tests', false, dbError);
    // CI's test job builds its own packages without the apps (their tests run from source), so an app's red build
    // still leaves the tests to run, as there.
    else if (
      build.status !== 0 &&
      run('pnpm', ['turbo', 'run', 'build', '--output-logs=errors-only', ...filters, '--filter=!./apps/*']).status !== 0
    )
      step('tests', false, 'not run: they need the build of the packages they test, which failed');
    else {
      const red = [];
      for (const { name, directory, targets } of plan) {
        const t = run('pnpm', ['exec', 'vitest', 'related', '--run', '--passWithNoTests', ...targets], {
          cwd: join(ROOT, directory),
          env: { ...process.env, ...env, TZ: 'UTC', FORCE_COLOR: process.env.FORCE_COLOR ?? '0' },
        });
        if (t.status !== 0) red.push(name);
      }
      step('tests', red.length === 0, `red in ${red.join(', ')} (above)`);
    }
  }

  const red = results.filter((r) => !r.ok).map((r) => r.name);
  return red.length
    ? { ok: false, summary: `red on CI's own ${red.join(', ')}: CI fails the same way, so fix it before you push` }
    : { ok: true, summary: "CI's gates, format, build, typecheck and tests passed here" };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const at = process.argv.indexOf('--base');
  const res = await runCiChecks({ base: at > 0 ? process.argv[at + 1] : 'origin/main', list: process.argv.includes('--list') });
  console.log(`${res.ok ? '✓' : '✖'} CI's checks: ${res.summary}`);
  process.exit(res.ok ? 0 : 1);
}
