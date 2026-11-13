/**
 * ci-checks.mjs: a builder's machine runs CI's checks with CI's database environment, read from CI's files.
 * Run: node --test tooling/scripts/ci-checks.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  withBuiltTwins,
} from './ci-checks.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ACTION = readFileSync(ROOT + '.github/actions/test-infra/action.yml', 'utf8');

test("CI's database environment is read from the test-infra action, every per-service URL included", () => {
  const { env, skipped } = ciTestEnv(ACTION);
  assert.equal(env.REQUIRE_POSTGRES, '1', 'a database suite fails instead of skipping');
  assert.match(env.TEST_DATABASE_URL, /^postgres:\/\/.+\/intafaced_test$/);
  // Every key assert-test-db-env.mjs requires (CI's own probe) is set.
  const required = [...readFileSync(ROOT + 'tooling/ci/assert-test-db-env.mjs', 'utf8').matchAll(/key: '([A-Z0-9_]+)'/g)].map((m) => m[1]);
  assert.ok(required.length >= 10, 'the probe lists its URLs');
  for (const key of required) assert.ok(env[key], `${key} comes from CI's action`);
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
  const text = readFileSync(new URL('./ci-checks.mjs', import.meta.url), 'utf8');
  assert.match(text, /affectedFilters\(files, edges, mergeBase\)/);
  assert.match(text, /buildFilters\(files, edges, mergeBase\)/);
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

test("a changed source file brings its built twin, which a dependent's tests import", () => {
  assert.deepEqual(
    withBuiltTwins(['packages/i18n/src/en/trade.ts', 'apps/customer/src/a.tsx', 'services/svc-trade/src/x.test.ts']).sort(),
    ['apps/customer/src/a.tsx', 'packages/i18n/dist/en/trade.js', 'packages/i18n/src/en/trade.ts', 'services/svc-trade/src/x.test.ts'],
  );
});

test('a rule test walks a folder and reads the source it finds; one file read by name or a migrations walk is not', () => {
  assert.ok(ruleTest('a/x.test.ts', "for (const n of readdirSync(dir)) if (n.endsWith('.tsx')) readFileSync(n)"));
  assert.ok(ruleTest('a/x.test.ts', "execFileSync('git', ['ls-files', '--', '*.ts'])"));
  assert.ok(!ruleTest('a/x.test.ts', "readFileSync(new URL('./format.ts', import.meta.url))"));
  assert.ok(!ruleTest('a/x.test.ts', "readdirSync(drizzle).filter((n) => n.endsWith('.sql'))"));
  assert.ok(!ruleTest('a/x.ts', "readdirSync(d).filter((n) => n.endsWith('.ts'))"), 'not a test file');
});

// The census (project-state #2065 row d22): the rule-test files CI's unit run failed on in journey PRs' first heads.
const CENSUS_RULE_TESTS = [
  'apps/customer/src/app/contracts-subpaths.test.ts',
  'apps/customer/src/features/developers/developers-reference.test.ts',
  'apps/customer/src/features/pay/portal/copy-lint.test.ts',
  'apps/customer/src/features/pay/portal/no-founder-admin.test.ts',
  'apps/customer/src/screens/trade/copy-no-yet.test.ts',
  'apps/customer/src/screens/trade/copybots/refusals.test.ts',
  'apps/customer/src/shared/copy-promises.test.ts',
  'apps/customer/src/shared/no-new-hand-schemas.test.ts',
  'packages/ledger-client/src/recipes/live-path-inventory.test.ts',
];

test('every rule test the census saw CI fail on is picked from the real tree', () => {
  for (const f of CENSUS_RULE_TESTS) assert.ok(ruleTest(f, readFileSync(ROOT + f, 'utf8')), f);
});

test("the checks never inherit a hook's GIT_* variables (a tooling test's temp repo wrote into the real one)", () => {
  const text = readFileSync(new URL('./ci-checks.mjs', import.meta.url), 'utf8');
  assert.match(text, /filter\(\(\[k\]\) => !k\.startsWith\('GIT_'\)\)/);
  assert.match(readFileSync(ROOT + '.githooks/pre-push', 'utf8'), /GIT_\[A-Z_\]\*\\\)=\.\*\/\\1\/p'\); do unset "\$v"; done/);
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

// Planted gates runs, in gates.mjs's and tooling-tests.mjs's own output shapes (the timeout line is #8219's from the replay).
const TIMEOUT_LINE =
  'TOOLING TESTS FAILED — exit 1 (spawnSync /opt/homebrew/Cellar/node@22/22.23.5/bin/node ETIMEDOUT), no TAP summary across 74 files.';
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
  assert.match(shown, /ETIMEDOUT/, 'what the gates printed is still shown');
});

test('a planted failing tooling test refuses, timeout or not; so does any other red gate', () => {
  const failed = gatesRun([
    RED('tooling-tests'),
    'not ok 3 - planted',
    'TOOLING TESTS FAILED — exit 1, 1 failed, 0 cancelled, 2 passed across 1 files.',
  ]);
  assert.equal(failed.v.ok, false);
  const failedThenTimedOut = gatesRun([RED('tooling-tests'), 'ok 1 - a', 'not ok 2 - planted', TIMEOUT_LINE]);
  assert.equal(failedThenTimedOut.v.ok, false, 'a test that failed before the stop is a real red');
  const another = gatesRun([RED('tooling-tests'), RED('boundary-fetch'), TIMEOUT_LINE]);
  assert.equal(another.v.ok, false, 'another red gate beside the timeout is red');
  const manifest = gatesRun(['✖ GATE MANIFEST BROKEN', TIMEOUT_LINE]);
  assert.equal(manifest.v.ok, false);
});
