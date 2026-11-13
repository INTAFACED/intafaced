/**
 * rule-tests.mjs: which unit tests a builder's machine runs before a push, and which packages a diff reaches.
 * Run: node --test tooling/scripts/rule-tests.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packageOf, rule, ruleTestsIn, selectPackages } from './rule-tests.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PACKAGES = new Set(['apps/customer', 'services/svc-trade', 'services/svc-ledger', 'packages/i18n']);
const EDGES = { 'apps/customer': ['services/svc-trade'], 'packages/i18n': ['services/svc-ledger'] };

test('a changed file selects its own package, and only that, when nothing reads it', () => {
  assert.deepEqual(selectPackages(['services/svc-ledger/src/a.ts'], PACKAGES, {}), ['services/svc-ledger']);
});

test("a changed package also selects each package whose tests read it (CI's read edges)", () => {
  assert.deepEqual(selectPackages(['services/svc-trade/src/copy/errors.ts'], PACKAGES, EDGES), ['apps/customer', 'services/svc-trade']);
  assert.deepEqual(selectPackages(['services/svc-ledger/x.ts', 'services/svc-trade/y.ts'], PACKAGES, EDGES), [
    'apps/customer',
    'packages/i18n',
    'services/svc-ledger',
    'services/svc-trade',
  ]);
});

test('a path outside the packages, or one that only looks like a package, selects nothing', () => {
  assert.deepEqual(selectPackages(['docs/x.md', 'tooling/ci/a.mjs', 'services/svc-tradex/a.ts'], PACKAGES, EDGES), []);
  assert.equal(packageOf('services/svc-trade', PACKAGES), null);
  assert.deepEqual(selectPackages(['apps/customerx/a.ts'], PACKAGES, { 'apps/customer': ['apps/customer'] }), []);
});

test('a test that walks a folder and reads the source it finds is a rule test', () => {
  assert.ok(rule("for (const n of readdirSync(dir)) if (n.endsWith('.tsx')) readFileSync(n)"));
  assert.ok(rule("execFileSync('git', ['ls-files', '--', '*.ts'])"));
  assert.ok(rule('readdirSync(dir, { recursive: true }).filter((f) => /\\.tsx?$/.test(f))'));
});

test('a planted near miss is not: one file read by name, a migrations walk, a database test', () => {
  assert.ok(!rule("readFileSync(new URL('./format.ts', import.meta.url))"), 'reads one file, walks nothing');
  assert.ok(!rule("readdirSync(drizzle).filter((n) => n.endsWith('.sql'))"), 'walks migrations, reads no source');
  assert.ok(!rule("import { createTestDatabase } from '@intafaced/db'; readdirSync(src).filter((n) => n.endsWith('.ts'))"));
  assert.ok(!rule("import { PostgreSqlContainer } from '@testcontainers/postgresql'; readdirSync(d).filter((n) => n.endsWith('.ts'))"));
});

test('Postgres and stack files never run, whatever they read', () => {
  const walker = "readdirSync(d).filter((n) => n.endsWith('.ts'))";
  const files = ['p/a.pg.test.ts', 'p/b.e2e.test.ts', 'p/c.test.ts', 'p/d.test.tsx', 'p/e.ts', 'p/f.test.mjs'];
  assert.deepEqual(
    ruleTestsIn(files, () => walker),
    ['p/c.test.ts', 'p/d.test.tsx'],
  );
});

// The census (project-state #2065 row d22): the rule-test files CI's unit run failed on in journey PRs' first heads.
// If one stops being selected, the check no longer covers what it was built for.
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

test('every rule test the census found CI failing on is selected from the real tree', () => {
  const read = (f) => readFileSync(ROOT + f, 'utf8');
  assert.deepEqual(ruleTestsIn(CENSUS_RULE_TESTS, read), [...CENSUS_RULE_TESTS].sort());
});
