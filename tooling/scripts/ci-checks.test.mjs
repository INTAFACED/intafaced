/**
 * ci-checks.mjs: a builder's machine runs CI's checks with CI's database environment, read from CI's files.
 * Run: node --test tooling/scripts/ci-checks.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEEDS_CHAIN, bootstrapScript, collationWarning, packageTestCommand, withLock } from './ci-checks.mjs';
import {
  LOCAL_KEYS,
  ciNode,
  ciSchemaProof,
  ciTestEnv,
  isolate,
  ruleTest,
  runBorn,
  runDatabase,
  runGates,
  touchedPackages,
} from './ci-checks.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ACTION = readFileSync(ROOT + '.github/actions/test-infra/action.yml', 'utf8');
const SCRIPT = fileURLToPath(new URL('./ci-checks.mjs', import.meta.url));
const PROBE = fileURLToPath(new URL('../ci/assert-test-db-env.mjs', import.meta.url));
const noCi = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CI' && !k.startsWith('GIT_')));

/** A bin folder of stand-ins for pnpm, psql and curl: each logs its call (args and the GIT_* names it was handed). */
function fakeBin(box) {
  const bin = join(box, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'fake.mjs'),
    `import { appendFileSync } from 'node:fs';
const [cmd, ...args] = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cmd, args, git: Object.keys(process.env).filter((k) => k.startsWith('GIT_')) }) + '\\n');
if (cmd === 'curl') process.exit(7);
if (cmd === 'pnpm' && args.some((a) => a.startsWith('--dry'))) process.stdout.write('{"tasks":[]}');
if (cmd === 'psql') {
  const sql = args.join(' ');
  if (/datcollate/.test(sql)) process.stdout.write('C\\n');
  if (/count\\(\\*\\)/.test(sql)) process.stdout.write(process.env.FAKE_SCHEMAS + '\\n');
}
`,
  );
  for (const cmd of ['pnpm', 'psql', 'curl']) {
    writeFileSync(join(bin, cmd), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'fake.mjs')}" ${cmd} "$@"\n`);
    chmodSync(join(bin, cmd), 0o755);
  }
  return bin;
}

/**
 * One whole run of ci-checks.mjs, as a builder runs it, in a planted checkout: a branch one commit past origin/main that
 * changes a package file, pnpm, psql and curl replaced by stand-ins that log their calls, CI's gates and assert-test-db-env
 * planted as loggers, main's look-drift.mjs planted to log only when it runs as itself, the tmpdir a symlink (as the
 * Mac's is), and a hook's GIT_* variable in the environment. Run once; the tests below read its log.
 */
let sandboxRun = null;
function runInSandbox() {
  if (sandboxRun) return sandboxRun;
  const box = mkdtempSync(join(tmpdir(), 'ci-checks-run-'));
  const repo = join(box, 'repo');
  const log = join(box, 'calls.ndjson');
  const bin = fakeBin(box);
  const put = (rel, text, mode) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
    if (mode) chmodSync(join(repo, rel), mode);
  };
  const logger = (name, extra = '') =>
    `import { appendFileSync } from 'node:fs';\n${extra}appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cmd: '${name}', args: process.argv.slice(1), git: Object.keys(process.env).filter((k) => k.startsWith('GIT_')) }) + '\\n');\n`;
  const id = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...noCi(), ...id } }).trim();
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  put('.node-version', `${process.versions.node.split('.')[0]}\n`);
  put('.github/actions/test-infra/action.yml', ACTION);
  put('package.json', JSON.stringify({ name: 'box', scripts: { 'format:check': "prettier --check '**/*.{ts,mjs}'" } }));
  put('node_modules/.bin/turbo', '', 0o755);
  put('tooling/infra/postgres-init/02-intafaced-test-db.sh', `psql -c "SELECT 'CREATE DATABASE intafaced_test OWNER intafaced'"\n`);
  put('tooling/ci/gates.mjs', logger('gates'));
  put('tooling/ci/assert-test-db-env.mjs', logger('assert-test-db-env'));
  put('tooling/ci/look-drift.mjs', logger('look-drift', 'if (import.meta.url !== `file://${process.argv[1]}`) process.exit(0);\n'));
  put('packages/foo/package.json', JSON.stringify({ name: '@box/foo', scripts: { test: 'vitest run' } }));
  put('packages/foo/src/a.ts', 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const mergeBase = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', mergeBase);
  git('checkout', '-qb', 'work');
  put('packages/foo/src/a.ts', 'export const a = 2;\n');
  git('commit', '-qam', 'change');
  const realTmp = join(box, 'tmp-real');
  mkdirSync(realTmp);
  symlinkSync(realTmp, join(box, 'tmp-link'));
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...noCi(),
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: join(box, 'tmp-link'),
      FAKE_LOG: log,
      FAKE_SCHEMAS: String(ciSchemaProof(ACTION).expected),
      GIT_FROM_A_HOOK: '1',
    },
  });
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];
  sandboxRun = { status: r.status, output: `${r.stdout}${r.stderr}`, calls, mergeBase, realTmp };
  return sandboxRun;
}

test("CI's database environment is read from the test-infra action, every per-service URL included", () => {
  const { env, skipped } = ciTestEnv(ACTION);
  assert.equal(env.REQUIRE_POSTGRES, '1', 'a database suite fails instead of skipping');
  assert.match(env.TEST_DATABASE_URL, /^postgres:\/\/.+\/intafaced_test$/);
  // Every key assert-test-db-env.mjs requires (CI's own probe) is set: run with none, the probe names each one it wants;
  // run with the action's, it wants none and passes (psql a stand-in that answers, so only the URLs are judged).
  const bin = fakeBin(mkdtempSync(join(tmpdir(), 'db-env-probe-')));
  const probe = (vars) =>
    spawnSync(process.execPath, [PROBE], {
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(Object.entries(noCi()).filter(([k]) => !LOCAL_KEYS.test(k))),
        ...vars,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_LOG: join(bin, 'log'),
        CI: 'true',
      },
    });
  const none = probe({});
  assert.equal(none.status, 1, 'with no URLs the probe refuses');
  const required = [...none.stderr.matchAll(/· ([A-Z0-9_]+) unset/g)].map((m) => m[1]);
  assert.ok(required.length >= 10, 'the probe names its URLs');
  for (const key of required) assert.ok(env[key], `${key} comes from CI's action`);
  const all = probe(env);
  assert.equal(all.status, 0, all.stdout + all.stderr);
  assert.doesNotMatch(all.stderr, /unset/);
  assert.equal(env.TEST_DATABASE_URL_P2P, 'postgres://svc_p2p:svc_p2p@127.0.0.1:5432/intafaced_test');
  // What a laptop lacks is left to CI by name, never faked.
  for (const key of ['CI', 'NATS_URL', 'REDIS_URL', 'REQUIRE_EVM_CHAIN']) assert.ok(skipped.includes(key), key);
});

test('only database keys are taken', () => {
  for (const key of ['REQUIRE_POSTGRES', 'TEST_DATABASE_URL', 'TEST_DATABASE_URL_P2P', 'TEST_DATABASE_URL_SUPPORT_ADMIN'])
    assert.ok(LOCAL_KEYS.test(key), key);
  for (const key of ['CI', 'REDIS_URL', 'REQUIRE_EVM_CHAIN', 'TEST_DATABASE_URLX']) assert.ok(!LOCAL_KEYS.test(key), key);
});

test('planted: a changed action is a refusal, never a run against a guessed database', () => {
  assert.throws(() => ciTestEnv(ACTION.replace('- name: Test environment', '- name: Test env')), /no "Test environment" step/);
  assert.throws(() => ciTestEnv(ACTION.replace('for pair in', 'for p in')), /loop changed shape/);
  assert.throws(() => ciTestEnv(ACTION.replace("echo 'REQUIRE_POSTGRES=1'", "echo 'REQUIRE_POSTGRES=0'")), /REQUIRE_POSTGRES/);
  assert.throws(() => ciSchemaProof(ACTION.replace(/expected=\d+/, 'expected=')), /schema proof changed shape/);
});

test("the schema proof is CI's: its count and its list", () => {
  const { expected, inList } = ciSchemaProof(ACTION);
  assert.equal(inList.split(',').length, expected);
});

test("the package selection is CI's own functions, called with the merge-base", () => {
  const { calls, mergeBase, output } = runInSandbox();
  const turbo = (task) => calls.find((c) => c.cmd === 'pnpm' && c.args[0] === 'turbo' && c.args[2] === task)?.args ?? [];
  // The test selection (affectedFilters) and the build's (buildFilters) are turbo's `...[<merge-base>]`, never a branch name.
  for (const task of ['test', 'build', 'typecheck'])
    assert.ok(turbo(task).includes(`--filter=...[${mergeBase}]`), `${task}: ${turbo(task).join(' ')}\n${output}`);
  // ...and CI's jobs read the same functions.
  const ci = readFileSync(ROOT + '.github/workflows/ci.yml', 'utf8');
  assert.match(ci, /node tooling\/ci\/ci-affected\.mjs --filters/);
  assert.match(ci, /node tooling\/ci\/ci-affected\.mjs --build-filters/);
});

test("Node is CI's: .node-version's major, from Homebrew's keg when the default differs", () => {
  assert.deepEqual(ciNode('22\n', '22.23.5'), { bin: null, want: '22' });
  assert.deepEqual(
    ciNode('22', '26.3.1', () => true),
    { bin: '/opt/homebrew/opt/node@22/bin', want: '22' },
  );
  assert.match(ciNode('22', '26.3.1', () => false).error, /brew install node@22/);
  assert.match(ciNode('lts/*', '26.3.1').error, /node-version/);
});

test("on a Linux home Node CI runs comes from CI_NODE_BIN, else nvm's newest of that major", () => {
  const nvm = '/home/builder/.nvm/versions/node';
  const linux = {
    env: {},
    home: '/home/builder',
    list: (dir) => (dir === nvm ? ['v20.19.0', 'v22.9.0', 'v22.23.5', 'v24.1.0'] : []),
  };
  const nvmHas = (p) => p.startsWith(`${nvm}/`);
  assert.deepEqual(ciNode('22', '26.3.1', nvmHas, linux), { bin: `${nvm}/v22.23.5/bin`, want: '22' });
  assert.deepEqual(
    ciNode('22', '26.3.1', (p) => p === '/opt/node22/bin/node', { ...linux, env: { CI_NODE_BIN: '/opt/node22/bin' } }),
    {
      bin: '/opt/node22/bin',
      want: '22',
    },
  );
  assert.match(ciNode('22', '26.3.1', () => false, linux).error, /nvm install 22/);
});

test("tests run in the packages holding a changed file, each on its own changes; a dependent's tests are CI's", () => {
  const tested = [
    { name: '@intafaced/contracts', directory: 'packages/contracts' },
    { name: '@intafaced/svc-trade', directory: 'services/svc-trade' },
    { name: '@intafaced/svc-trade-sim', directory: 'services/svc-trade-sim' },
    { name: '@intafaced/svc-pay', directory: 'services/svc-pay' },
  ];
  const files = ['packages/contracts/src/identity.ts', 'services/svc-trade/src/x.ts', 'services/svc-trade/drizzle/1.sql', 'pnpm-lock.yaml'];
  assert.deepEqual(touchedPackages(tested, files), [
    { name: '@intafaced/contracts', directory: 'packages/contracts', own: ['packages/contracts/src/identity.ts'] },
    {
      name: '@intafaced/svc-trade',
      directory: 'services/svc-trade',
      own: ['services/svc-trade/src/x.ts', 'services/svc-trade/drizzle/1.sql'],
    },
  ]);
  assert.deepEqual(touchedPackages(tested, ['README.md']), [], 'nothing changed in a package: no tests here');
});

test('a rule test walks a folder and reads the source it finds; one file read by name or a migrations walk is not', () => {
  assert.ok(ruleTest('a/x.test.ts', "for (const n of readdirSync(dir)) if (n.endsWith('.tsx')) readFileSync(n)"));
  assert.ok(ruleTest('a/x.test.ts', "execFileSync('git', ['ls-files', '--', '*.ts'])"));
  assert.ok(!ruleTest('a/x.test.ts', "readFileSync(new URL('./format.ts', import.meta.url))"));
  assert.ok(!ruleTest('a/x.test.ts', "readdirSync(drizzle).filter((n) => n.endsWith('.sql'))"));
  assert.ok(ruleTest('a/x.test.ts', "declaredRoutes(REPO, { isRouteSource });\nrepo('services/svc-ws/src/x.ts')"), 'the shared route walk');
  assert.ok(!ruleTest('a/x.ts', "readdirSync(d).filter((n) => n.endsWith('.ts'))"), 'not a test file');
});

// The census (project-state #2065 row d22): the rule-test files CI's unit run failed on in journey PRs' first heads.
// Three left the list when they became lint rules (garden/no-promise-copy, garden/no-hand-schema).
const CENSUS_RULE_TESTS = [
  'apps/customer/src/app/contracts-subpaths.test.ts',
  'apps/customer/src/features/developers/developers-reference.test.ts',
  'apps/customer/src/features/pay/portal/copy-lint.test.ts',
  'apps/customer/src/features/pay/portal/no-founder-admin.test.ts',
  'apps/customer/src/screens/trade/copybots/refusals.test.ts',
  'packages/ledger-client/src/recipes/live-path-inventory.test.ts',
];

test('every rule test the census saw CI fail on is picked from the real tree', () => {
  for (const f of CENSUS_RULE_TESTS) assert.ok(ruleTest(f, readFileSync(ROOT + f, 'utf8')), f);
});

test("the checks never inherit a hook's GIT_* variables (a tooling test's temp repo wrote into the real one)", () => {
  const { calls, output } = runInSandbox();
  // Every check it starts (gates, look drift, format, turbo, psql, the database probe); curl's chain probe is no check.
  const checks = calls.filter((c) => c.cmd !== 'curl');
  for (const name of ['gates', 'look-drift', 'pnpm', 'psql', 'assert-test-db-env'])
    assert.ok(
      checks.some((c) => c.cmd === name),
      `${name} ran\n${output}`,
    );
  for (const c of checks) assert.deepEqual(c.git, [], `${c.cmd} ${c.args.join(' ')} was handed ${c.git.join(', ')}`);
  // The pre-push hook no longer runs these checks (they run on GitHub), so its own unset of GIT_* has nothing to guard.
});

test('each run gets its own database: every TEST_DATABASE_URL points at it, nothing else changes', () => {
  const { env } = ciTestEnv(ACTION);
  const db = runDatabase(4242, 1794550000000);
  assert.match(db, /^intafaced_run_4242_[0-9a-z]+_test$/, "ends in _test: the repo's test guards refuse any other name");
  assert.equal(runBorn(db), 1794550000000);
  assert.ok(Number.isNaN(runBorn('intafaced_test')), "CI's own database is never taken for a leftover");
  const out = isolate(env, db);
  for (const [k, v] of Object.entries(out))
    if (k.startsWith('TEST_DATABASE_URL') && env[k].endsWith('/intafaced_test')) assert.ok(v.endsWith(`/${db}`), k);
  assert.equal(out.TEST_DATABASE_URL_SUPPORT_ADMIN, env.TEST_DATABASE_URL_SUPPORT_ADMIN, 'the admin URL (database postgres) is left alone');
  assert.equal(out.REQUIRE_POSTGRES, '1');
  assert.notEqual(runDatabase(1, 1), runDatabase(2, 1), 'two runs never share one');
});

test("CI's bootstrap script names the database it makes, so a run can make its own from the same text", () => {
  const script = readFileSync(ROOT + 'tooling/infra/postgres-init/02-intafaced-test-db.sh', 'utf8');
  assert.match(script, /CREATE DATABASE intafaced_test OWNER/);
  assert.match(script, /--dbname intafaced_test/);
});

// Planted gates runs, in gates.mjs's and tooling-tests.mjs's own output shapes (the timeout lines are what #8219's
// false red, a loaded Mac's limit, prints since the tooling tests run several files at once and each has its own limit).
const TIMEOUT_LINE = [
  'TOOLING TESTS FAILED — 2 of 168 files: 0 failed, 0 cancelled, 1201 passed, in 300 s.',
  '  ✖ tooling/scripts/local-test-market.test.mjs: stopped after 180 s, its limit (a test that never ends, or a server left running)',
  '  ✖ tooling/scripts/local-test-stack.test.mjs: not run: the whole run reached its limit first',
].join('\n');
const gatesRun = (lines) => {
  const f = join(mkdtempSync(join(tmpdir(), 'gates-')), 'gates.mjs');
  writeFileSync(f, `process.stdout.write(${JSON.stringify(lines.join('\n') + '\n')}); process.exit(1);\n`);
  let shown = '';
  const v = runGates(process.execPath, [f], {}, (t) => (shown += t));
  return { v, shown };
};
const RED = (id) => `  ✖ ${id.padEnd(22)} 300412ms  every tooling/**/*.test.mjs passes`;

test("a planted timeout of the tooling tests here is 'not checked here, CI will': the push goes", () => {
  const { v, shown } = gatesRun([RED('tooling-tests'), '', '✖ 1 of 33 DOCTRINE GATE(S) FAILED', 'ok 1 - a', 'ok 2 - b', TIMEOUT_LINE]);
  assert.equal(v.ok, true);
  assert.match(v.notChecked, /not checked here, CI will/);
  assert.match(shown, /stopped after 180 s/, 'what the gates printed is still shown');
});

test('a planted failing tooling test refuses, timeout or not; so does any other red gate', () => {
  const failed = gatesRun([
    RED('tooling-tests'),
    'not ok 3 - planted',
    'TOOLING TESTS FAILED — 1 of 1 files: 1 failed, 0 cancelled, 2 passed, in 3 s.',
  ]);
  assert.equal(failed.v.ok, false);
  const failedThenTimedOut = gatesRun([RED('tooling-tests'), 'ok 1 - a', 'not ok 2 - planted', TIMEOUT_LINE]);
  assert.equal(failedThenTimedOut.v.ok, false, 'a test that failed before the stop is a real red');
  const another = gatesRun([RED('tooling-tests'), RED('boundary-fetch'), TIMEOUT_LINE]);
  assert.equal(another.v.ok, false, 'another red gate beside the timeout is red');
  const crashed = gatesRun([RED('tooling-tests'), `${TIMEOUT_LINE}\n  ✖ tooling/ci/x.test.mjs: exit 1`]);
  assert.equal(crashed.v.ok, false, 'a file that crashed beside the stopped ones is a real red');
  const manifest = gatesRun(['✖ GATE MANIFEST BROKEN', TIMEOUT_LINE]);
  assert.equal(manifest.v.ok, false);
});

test("each package's own test script runs as CI's pnpm test runs it, its vitest narrowed", () => {
  const t = ['/r/a.ts'];
  // svc-fix: Maven's tests first, then vitest.
  assert.match(
    packageTestCommand('node scripts/run-mvn.mjs test && vitest run', t),
    /^node scripts\/run-mvn\.mjs test && vitest related --run --passWithNoTests --maxWorkers=2 +'\/r\/a\.ts'$/,
  );
  // sbe-codec: a step after vitest still runs; vitest's own flags are kept.
  assert.match(
    packageTestCommand('node scripts/run-mvn.mjs test && vitest run --passWithNoTests && node scripts/linked-roundtrip.mjs', t),
    /^node scripts\/run-mvn\.mjs test && vitest related --run .*'\/r\/a\.ts' --passWithNoTests && node scripts\/linked-roundtrip\.mjs$/,
  );
  // customer: tooling/vitest/run-all.mjs, one related run per config it names, every other argument kept on each.
  assert.match(
    packageTestCommand('node ../../tooling/vitest/run-all.mjs vite.config.ts vitest.render.config.ts', t),
    /^vitest related --run .*'\/r\/a\.ts' --config vite\.config\.ts && vitest related --run .*'\/r\/a\.ts' --config vitest\.render\.config\.ts$/,
  );
  // mobile: no vitest, the whole script.
  assert.equal(packageTestCommand('node ./scripts/build-wrap.mjs --check', t), 'node ./scripts/build-wrap.mjs --check');
  // Excluded files and quoting.
  assert.match(packageTestCommand('vitest run', ["/r/it's.ts"], ['src/x.test.ts']), /--exclude 'src\/x\.test\.ts' '\/r\/it'\\''s\.ts'$/);
});

test('the chain suites CI starts anvil for are the ones left to CI when no chain answers here', () => {
  for (const f of [
    'services/svc-protocol/src/amm/router-v2-onchain.test.ts',
    'services/svc-protocol/src/liquidity/liquidity-onchain.test.ts',
  ])
    if (existsSync(ROOT + f)) assert.ok(NEEDS_CHAIN.test(readFileSync(ROOT + f, 'utf8')), f);
  assert.ok(!NEEDS_CHAIN.test('const url = process.env.TEST_DATABASE_URL; // 127.0.0.1:5432'));
});

test("the database bootstrap holds one lock across runs; a killed run's stale lock is taken over", () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'lock-')), 'l');
  // Another run holds it: this one waits, then gives up rather than racing.
  mkdirSync(dir);
  assert.throws(() => withLock(dir, () => 'ran', { waitMs: 600 }), /waited/);
  // Held past staleMs: taken over, and released after.
  utimesSync(dir, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  assert.equal(
    withLock(dir, () => 'ran', { waitMs: 2000, staleMs: 30_000 }),
    'ran',
  );
  assert.ok(!existsSync(dir), 'released');
  assert.equal(
    withLock(dir, () => 'again'),
    'again',
  );
});

test("look drift runs main's script from a real path (the Mac's tmpdir is a symlink, through which it did nothing)", () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-'));
  writeFileSync(join(dir, 'g.mjs'), 'if (import.meta.url === `file://${process.argv[1]}`) process.exit(3);\n');
  assert.equal(spawnSync(process.execPath, [join(realpathSync(dir), 'g.mjs')]).status, 3, 'through the real path it runs');
  // A whole run with a symlinked tmpdir: main's look-drift.mjs (which runs only as itself) ran, from the real folder.
  const { calls, output, realTmp } = runInSandbox();
  const drift = calls.filter((c) => c.cmd === 'look-drift');
  assert.equal(drift.length, 1, `main's look drift ran once\n${output}`);
  assert.ok(drift[0].args[0].startsWith(realpathSync(realTmp)), drift[0].args[0]);
});

test("this run's database collates as CI's (C); a template1 that doesn't is a warning, never a refusal", () => {
  const text = readFileSync(ROOT + 'tooling/infra/postgres-init/02-intafaced-test-db.sh', 'utf8');
  const out = bootstrapScript(text, 'intafaced_run_1_a_test');
  assert.ok(
    out.includes("'CREATE DATABASE intafaced_run_1_a_test OWNER intafaced TEMPLATE template0 LC_COLLATE ''C'' LC_CTYPE ''C'''"),
    'CREATE DATABASE collating C',
  );
  assert.doesNotMatch(out, /intafaced_test\b/);
  assert.throws(() => bootstrapScript(text.replace('OWNER intafaced', 'OWNER someone'), 'x_test'), /changed shape/);
  assert.equal(collationWarning('C\n'), null);
  assert.match(collationWarning('en_US.UTF-8'), /collates en_US\.UTF-8, CI's C/);
});
