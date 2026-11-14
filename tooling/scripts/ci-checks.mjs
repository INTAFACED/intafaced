#!/usr/bin/env node
/**
 * CI'S CHECKS, ON A BUILDER'S MACHINE, BY HAND, TO DIAGNOSE A RED. The pre-push hook ran this until CI's checks moved
 * to GitHub's branch run before the pull request (.githooks/pre-push says why).
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
 *     tests (`vitest related --run` in each package CI's test job selects that holds a changed file: the test files
 *     whose imports reach one of that package's changed files, plus every test of the package that walks the source
 *     tree, which nothing imports). Each package's own `test` script runs as CI's `pnpm test` runs it (svc-fix's Maven
 *     tests, sbe-codec's jar, a tsc first), its `vitest run` narrowed to those files.
 *     The packages that only depend on a changed one are built and typechecked here, and their tests are left to CI:
 *     one change to packages/contracts reached 34 packages, run one after another, 41 to 48 minutes of tests on a
 *     loaded Mac against CI's 7 to 18 split across its runners (J-agents-21 #11's four pushes, 13 Nov).
 * Left out, and said so in the output: the NATS bus, Redis and the EVM chains (their suites run in CI; a chain suite is
 * excluded by name when no chain answers on 8545 here), the tests of the packages that hold no changed file, and the
 * rest of CI's unit selection (the test files no change reaches). Clocks are UTC, as on CI's runners. A pass here is an early
 * copy of CI's verdict, never a replacement for it.
 *
 *   node tooling/scripts/ci-checks.mjs                  the branch against its merge-base with origin/main
 *   node tooling/scripts/ci-checks.mjs --base <ref>     against another ref (a stacked branch)
 *   node tooling/scripts/ci-checks.mjs --list           print what would run, run nothing
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/**
 * The packages whose tests run here: those of CI's selection (`tested`, { name, directory }) that hold a changed file,
 * each with its own changed files. A package that only depends on a changed one is left to CI's test job; its build and
 * typecheck still run here.
 */
export function touchedPackages(tested, files) {
  return tested.map((p) => ({ ...p, own: files.filter((f) => f.startsWith(`${p.directory}/`)) })).filter((p) => p.own.length > 0);
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

/**
 * The database name a run uses in place of CI's (`intafaced_test`): its own, so runs never share tables or locks. It ends
 * in `_test` because the repo's test guards (packages/db testing.ts, pay-sim's safety.ts) refuse any other name.
 */
export const runDatabase = (pid = process.pid, now = Date.now()) => `intafaced_run_${pid}_${now.toString(36)}_test`;

/**
 * Run fn holding a lock every run on this machine shares (a directory, made atomically). CI's bootstrap script grants on
 * roles every run shares, and two runs granting at once fail with "tuple concurrently updated" (3 runs at once in the
 * replay, 13 Nov). A lock older than staleMs is a killed run's and is taken over.
 */
export function withLock(dir, fn, { waitMs = 20 * 60_000, staleMs = 15 * 60_000 } = {}) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(dir).mtimeMs > staleMs) rmSync(dir, { recursive: true, force: true });
      } catch {
        /* released meanwhile */
      }
      if (Date.now() > until) throw new Error(`waited ${Math.round(waitMs / 60_000)} minutes for ${dir}`);
      Atomics.wait(pause, 0, 0, 250);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * CI's Postgres (postgres:16-alpine, musl) sorts text byte by byte, as collation C does; a Mac's en_US.UTF-8 doesn't
 * ('default' before 'Rig-A'), so a test's ORDER BY reads differently here (svc-mining-pool reads.db.test, #8211's
 * replay, 13 Nov). This run's own database is made collating C (bootstrapScript). The suites' own databases
 * (packages/db createTestDatabase) are made from template1, which this can't reach: a template1 that isn't C is a
 * warning, never a refused push (a machine setting is not a fault in the push). Null when it is C.
 */
export function collationWarning(datcollate) {
  return String(datcollate).trim() === 'C'
    ? null
    : `this Postgres's template1 collates ${String(datcollate).trim() || '(unknown)'}, CI's C: a test that sorts text may read differently here than in CI. ` +
        `To match CI (template1 holds nothing of its own): psql -d postgres -c "ALTER DATABASE template1 IS_TEMPLATE false" -c "DROP DATABASE template1" -c "CREATE DATABASE template1 TEMPLATE template0 LOCALE 'C' IS_TEMPLATE true"`;
}

/**
 * CI's bootstrap script (its text) for this run's database: CI's name replaced, and the database made collating C, as
 * CI's postgres:16-alpine sorts. Throws when the script's CREATE DATABASE line changed shape.
 */
export function bootstrapScript(text, db) {
  const create = "'CREATE DATABASE intafaced_test OWNER intafaced'";
  if (!text.includes(create)) throw new Error(`${BOOTSTRAP}: its CREATE DATABASE line changed shape`);
  return text
    .replace(create, "'CREATE DATABASE intafaced_test OWNER intafaced TEMPLATE template0 LC_COLLATE ''C'' LC_CTYPE ''C'''")
    .replaceAll('intafaced_test', db);
}

/** Tests that need CI's EVM chain (CI starts anvil on 8545 and 8546): they fail by design with no chain. */
export const NEEDS_CHAIN = /\b(REQUIRE_EVM_CHAIN|PROTOCOL_RPC_URL|INDEXER_RPC_URL|INDEXER_REORG_RPC_URL)\b|127\.0\.0\.1:854[56]/;

/**
 * A package's own `test` script, as CI's `pnpm test` runs it (svc-fix's Maven tests, sbe-codec's jar, a tsc first), with
 * its `vitest run` narrowed to `vitest related --run` over targets and the left-out files excluded. A script with no
 * `vitest run` runs whole. Returns the shell command.
 */
export function packageTestCommand(script, targets, exclude = []) {
  const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
  const narrowed = `vitest related --run --passWithNoTests --maxWorkers=2 ${exclude.map((f) => `--exclude ${q(f)}`).join(' ')} ${targets.map(q).join(' ')}`;
  if (!/(^|&&\s*)vitest run\b/.test(script)) return script;
  return script
    .split(/\s*&&\s*/)
    .map((part) => (/^vitest run\b/.test(part) ? `${narrowed} ${part.slice('vitest run'.length).trim()}`.trim() : part))
    .join(' && ');
}

/**
 * The verdict on CI's gates run here. Red is red, except one case: the only red gate is the tooling tests and they were
 * stopped by their own 300 s limit (tooling-tests.mjs TIMEOUT_MS, spawnSync ETIMEDOUT) with no failing test before the
 * stop. That is a loaded Mac's limit, not the code's (#8219's false red in the replay): it is "not checked here, CI will",
 * and the push goes. CI's own gates job keeps the limit as it is.
 */
export function gatesVerdict(status, output) {
  if (status === 0) return { ok: true };
  const red = [...output.matchAll(/^ {2}✖ (\S+) +\d+ms/gm)].map((m) => m[1]);
  const timedOut = /TOOLING TESTS FAILED — exit \S+ \(spawnSync \S+ ETIMEDOUT\)/.test(output);
  if (red.length === 1 && red[0] === 'tooling-tests' && timedOut && !/^\s*not ok \d+/m.test(output))
    return { ok: true, notChecked: 'the tooling tests ran past their 300 s limit on this machine: not checked here, CI will' };
  return { ok: false };
}

/** Run CI's gates (`node tooling/ci/gates.mjs --changed --base <base>`, or a planted command), print what they print. */
export function runGates(cmd, args, opts, write = (t) => process.stdout.write(t)) {
  const r = spawnSync(cmd, args, { ...opts, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  write(output);
  return gatesVerdict(r.status, output);
}

/** When a run's database was made (ms), from its name; NaN for any other name. */
export const runBorn = (name) => {
  const m = /^intafaced_run_\d+_([0-9a-z]+)_test$/.exec(name);
  return m ? parseInt(m[1], 36) : NaN;
};

/**
 * CI's test environment pointed at this run's own database (CI's runner has a fresh Postgres per job; a shared one here
 * had stale tables owned by another role, lock waits between runs, and leftovers from killed runs).
 */
export function isolate(env, db) {
  const out = {};
  for (const [k, v] of Object.entries(env)) out[k] = k.startsWith('TEST_DATABASE_URL') ? v.replace(/\/intafaced_test$/, `/${db}`) : v;
  return out;
}

/**
 * Make this run's database the way CI makes intafaced_test, with CI's own bootstrap script (its text, with the database
 * name changed), then prove it as CI does. Returns { error } or { drop } (a function that removes the database).
 */
function prepareDatabase(env, actionText, run, cleanEnv, log) {
  const url = new URL(env.TEST_DATABASE_URL);
  const db = url.pathname.slice(1);
  const pg = {
    ...cleanEnv,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGCONNECT_TIMEOUT: '30',
  };
  const psql = (sql, dbname = 'postgres') =>
    spawnSync('psql', ['-d', dbname, '-v', 'ON_ERROR_STOP=1', '-tAc', sql], { env: pg, encoding: 'utf8' });
  const drop = () => psql(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
  const collate = psql("SELECT datcollate FROM pg_database WHERE datname = 'template1'");
  const warning = collate.status === 0 ? collationWarning(collate.stdout) : null;
  if (warning) log(`  ⚠ ${warning}`);
  let script;
  try {
    script = bootstrapScript(readFileSync(join(ROOT, BOOTSTRAP), 'utf8'), db);
  } catch (e) {
    return { error: e.message };
  }
  const boot = withLock(join(realpathSync(tmpdir()), 'intafaced-ci-checks-db.lock'), () => {
    // Leftovers of runs that were killed before their drop (older than a day, so no live run is touched).
    const old = psql("SELECT datname FROM pg_database WHERE datname LIKE 'intafaced\\_run\\_%\\_test'");
    for (const name of String(old.stdout).split('\n').filter(Boolean)) {
      const born = runBorn(name);
      if (Number.isFinite(born) && Date.now() - born > 24 * 3600_000) psql(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    return run('bash', ['-c', script], {
      env: { ...pg, POSTGRES_USER: pg.PGUSER, POSTGRES_DB: 'postgres' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  });
  if (boot.status !== 0) {
    drop();
    return {
      error:
        `the test database at ${url.host} is not reachable or could not be made (${String(boot.stderr ?? '')
          .trim()
          .slice(0, 200)}). ` +
        `CI's tests need Postgres 16 there with the role ${pg.PGUSER} (CI's test credentials, in ${ACTION}); on the Mac: brew services start postgresql@16`,
    };
  }
  log(`  test database: ${db} (this run's own, made by ${BOOTSTRAP}; dropped at the end)`);
  const { expected, inList } = ciSchemaProof(actionText);
  const count = psql(`SELECT count(*) FROM pg_namespace WHERE nspname IN (${inList});`, db);
  if (Number(String(count.stdout).trim()) !== expected) {
    drop();
    return { error: `${db} has ${String(count.stdout).trim() || 'no'} of ${expected} service schemas after the bootstrap` };
  }
  const probe = run('node', ['tooling/ci/assert-test-db-env.mjs'], { env: { ...pg, ...env } });
  if (probe.status !== 0) {
    drop();
    return { error: 'tooling/ci/assert-test-db-env.mjs refused the test database URLs (above)' };
  }
  return { drop };
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
  // Never hand a hook's GIT_DIR, GIT_INDEX_FILE or GIT_WORK_TREE to the checks: tooling tests that make their own temp
  // repos then wrote into the real one (13 Nov: core.bare = true and a test user in intafaced's shared git config).
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const baseEnv = node.bin ? { ...clean, PATH: `${node.bin}:${clean.PATH}` } : clean;
  const run = (cmd, args, opts = {}) =>
    spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts, env: opts.env ? { ...opts.env, PATH: baseEnv.PATH } : baseEnv });

  // A fresh worktree has no node_modules (12 of 20 sampled builder threads pushed before installing; #8165). CI's jobs
  // start with the same install, so this does too rather than refusing.
  if (!existsSync(join(ROOT, 'node_modules', '.bin', 'turbo'))) {
    log('  no node_modules here: pnpm install --frozen-lockfile --prefer-offline (as CI does first)');
    if (run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline']).status !== 0)
      return { ok: false, summary: 'pnpm install --frozen-lockfile failed (above); CI installs the same way' };
  }
  const edges = readEdges();
  const filters = affectedFilters(files, edges, mergeBase).map((f) => `--filter=${f}`);
  const buildArgs = buildFilters(files, edges, mergeBase).map((f) => `--filter=${f}`);
  const actionText = readFileSync(join(ROOT, ACTION), 'utf8');
  const { env, skipped } = ciTestEnv(actionText);
  log(`  CI's checks on Node ${node.want}: ${filters.join(' ')}`);
  log(
    `  left to CI: ${skipped.join(', ')}; the tests of the packages that hold no changed file (built and typechecked here); the test files no change reaches; the guards that read the pull request (test-diff, journey baseline, journey list, reach map); the deployment tests and the tooling tests that need a full build`,
  );

  const tested = flags.full || flags.affected ? turboPackages('test', filters, baseEnv) : [];
  if (tested === null) return { ok: false, summary: 'turbo could not list the packages CI would test' };
  // CI starts an EVM chain (anvil on 8545); a builder's machine usually has none, and those suites fail by design
  // without one. With no chain answering here they are left to CI, by name.
  const chain = spawnSync(
    'curl',
    [
      '-s',
      '--max-time',
      '2',
      '-H',
      'content-type: application/json',
      '-d',
      '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}',
      'http://127.0.0.1:8545',
    ],
    { encoding: 'utf8' },
  );
  const hasChain = chain.status === 0 && /"result"/.test(chain.stdout);
  const leftToCi = [];
  const touched = touchedPackages(tested, files);
  const plan = touched.map(({ name, directory, own: ownFiles }) => {
    const own = git(['ls-files', directory]).split('\n').filter(Boolean);
    const tests = own.filter((f) => IS_VITEST_FILE.test(f)).map((f) => ({ f, text: readFileSync(join(ROOT, f), 'utf8') }));
    const rules = tests.filter(({ f, text }) => ruleTest(f, text)).map(({ f }) => join(ROOT, f));
    const exclude = hasChain ? [] : tests.filter(({ text }) => NEEDS_CHAIN.test(text)).map(({ f }) => f.slice(directory.length + 1));
    leftToCi.push(...exclude.map((f) => `${directory}/${f}`));
    const script = JSON.parse(readFileSync(join(ROOT, directory, 'package.json'), 'utf8')).scripts?.test ?? 'vitest run';
    const changed = ownFiles.map((f) => join(ROOT, f));
    return {
      name,
      directory,
      changed,
      targets: [...changed, ...rules],
      command: packageTestCommand(script, [...changed, ...rules], exclude),
    };
  });
  if (leftToCi.length) log(`  left to CI (they need its EVM chain; none answers on 127.0.0.1:8545 here): ${leftToCi.join(', ')}`);
  if (tested.length > plan.length)
    log(`  tests here: ${plan.length} of the ${tested.length} packages CI tests (those holding a changed file); the rest are CI's`);
  if (list) {
    for (const p of plan)
      log(`  ${p.name}: related to ${p.changed.length} changed files, plus ${p.targets.length - p.changed.length} rule tests`);
    return { ok: true, summary: `${plan.length} packages` };
  }

  // Each job runs whatever the one before said, so one run lists every red, as the gates do.
  const results = [];
  const step = (name, ok, why) => {
    results.push({ name, ok });
    log(`  ${ok ? '✓' : '✖'} ${name}${ok ? '' : `: ${why}`}`);
  };

  const notChecked = [];
  const gates = runGates('node', ['tooling/ci/gates.mjs', '--changed', '--base', base], { cwd: ROOT, env: baseEnv });
  if (gates.notChecked) {
    notChecked.push(gates.notChecked);
    log(`  ~ gates: ${gates.notChecked}`);
  } else step('gates', gates.ok, 'a doctrine gate (above)');
  // CI's gates job also runs Look drift with main's rules (ci.yml "Look drift (rules from main)"), which needs only git.
  // Its other guards (test-diff, journey baseline, journey list, the reach map) read the pull request or a token: CI's.
  let drift = null;
  try {
    drift = git(['show', 'origin/main:tooling/ci/look-drift.mjs']);
  } catch {
    /* main has none: the head's own, as CI does */
  }
  // A real path: look-drift.mjs runs only when import.meta.url is file://<argv[1]>, and the Mac's tmpdir is a symlink
  // (/var → /private/var), so through it the script did nothing and exited 0 (the replay's #7972 miss, 13 Nov).
  const driftScript = drift
    ? join(realpathSync(mkdtempSync(join(tmpdir(), 'look-drift-'))), 'look-drift.mjs')
    : join(ROOT, 'tooling/ci/look-drift.mjs');
  if (drift) writeFileSync(driftScript, drift);
  const look = existsSync(driftScript) ? run('node', [driftScript], { env: { ...baseEnv, GUARD_BASE: mergeBase } }) : { status: 0 };
  step('look drift', look.status === 0, 'a look baseline changed (above)');

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

    const runEnv = isolate(env, runDatabase());
    const db = prepareDatabase(runEnv, actionText, run, baseEnv, log);
    if (db.error) step('tests', false, db.error);
    // CI's test job builds its own packages without the apps (their tests run from source), so an app's red build
    // still leaves the tests to run, as there.
    else if (
      build.status !== 0 &&
      run('pnpm', ['turbo', 'run', 'build', '--output-logs=errors-only', ...filters, '--filter=!./apps/*']).status !== 0
    ) {
      db.drop();
      step('tests', false, 'not run: they need the build of the packages they test, which failed');
    } else {
      const red = [];
      try {
        for (const { name, directory, command } of plan) {
          // The package's own test script, as CI's `pnpm test` runs it, its vitest narrowed (packageTestCommand). Two
          // workers a run: CI's runner is 4 cores for one run; here several builders share one Mac.
          const t = run('pnpm', ['exec', 'sh', '-c', command], {
            cwd: join(ROOT, directory),
            env: { ...baseEnv, ...runEnv, TZ: 'UTC', FORCE_COLOR: process.env.FORCE_COLOR ?? '0' },
          });
          if (t.status !== 0) red.push(name);
        }
      } finally {
        db.drop();
      }
      step('tests', red.length === 0, `red in ${red.join(', ')} (above)`);
    }
  }

  const red = results.filter((r) => !r.ok).map((r) => r.name);
  return red.length
    ? { ok: false, summary: `red on CI's own ${red.join(', ')}: CI fails the same way, so fix it before you push` }
    : {
        ok: true,
        summary: `CI's gates, format, build, typecheck and tests passed here${notChecked.length ? `; ${notChecked.join('; ')}` : ''}`,
      };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const at = process.argv.indexOf('--base');
  const res = await runCiChecks({ base: at > 0 ? process.argv[at + 1] : 'origin/main', list: process.argv.includes('--list') });
  console.log(`${res.ok ? '✓' : '✖'} CI's checks: ${res.summary}`);
  process.exit(res.ok ? 0 : 1);
}
