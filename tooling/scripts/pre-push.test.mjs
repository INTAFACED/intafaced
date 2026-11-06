// Unit tests for the pre-push checks (tooling/scripts/pre-push.mjs) and the gate runner's --jobs and --part options.
// Run by tooling/scripts/tooling-tests.mjs (the `tooling-tests` Doctrine gate).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configDrift,
  elapsed,
  heavyWrapper,
  INFRA_SUITES,
  testRuns,
  parseRefs,
  planChecks,
  skipReason,
  stepEnv,
  SKIP_ENV,
} from './pre-push.mjs';
import { GATES, runOptions, selectGates } from '../ci/gates.mjs';

const BASE = 'a'.repeat(40);
const EDGES = { 'apps/customer': ['services/svc-trade'] };

test('a docs-only push runs the gates only, as CI does', () => {
  const plan = planChecks(['docs/runbooks/x.md', 'services/svc-bank/README.md'], BASE, EDGES);
  assert.equal(plan.kind, 'docs');
  assert.deepEqual(plan.typecheck, []);
  assert.deepEqual(plan.test, []);
});

test("a one-service push typechecks CI's affected selection and tests the changed packages", () => {
  const plan = planChecks(['services/svc-trade/src/a.ts'], BASE, EDGES);
  assert.equal(plan.kind, 'affected');
  assert.deepEqual(plan.typecheck, [`...[${BASE}]`, './apps/customer']);
  assert.deepEqual(plan.test, [`[${BASE}]`]);
  assert.match(plan.gaps[0], /dependents and readers/);
});

test('a run-everything push names what only CI runs', () => {
  for (const f of ['tooling/ci/gates.mjs', 'packages/contracts/src/x.ts', 'AGENTS.md', 'pnpm-lock.yaml', 'odd-root-file.txt']) {
    const plan = planChecks([f], BASE, EDGES);
    assert.equal(plan.kind, 'full', f);
    assert.deepEqual(plan.test, [`[${BASE}]`], f);
    assert.match(plan.gaps[0], /whole repo/, f);
  }
});

test('the escape needs a reason, and a bare flag is refused', () => {
  assert.deepEqual(skipReason({}), { skip: false });
  for (const v of ['1', 'true', 'yes', '', 'short']) assert.ok(skipReason({ [SKIP_ENV]: v }).refused, v);
  assert.deepEqual(skipReason({ [SKIP_ENV]: '  docs typo, CI runs it  ' }), { skip: true, reason: 'docs typo, CI runs it' });
});

test("git's pushed refs are read, and a deletion is marked", () => {
  const refs = parseRefs(
    `refs/heads/x ${'b'.repeat(40)} refs/heads/x ${'0'.repeat(40)}\n(delete) ${'0'.repeat(40)} refs/heads/y ${'c'.repeat(40)}\n\n`,
  );
  assert.equal(refs.length, 2);
  assert.equal(refs[0].deletes, false);
  assert.equal(refs[1].deletes, true);
  assert.deepEqual(parseRefs(''), []);
});

test('gates: no flags is one gate at a time over the whole list (what CI runs)', () => {
  assert.deepEqual(runOptions(['node', 'gates.mjs']), { jobs: 1, part: 'all' });
  const { shared, exclusive } = selectGates(GATES, 'all');
  assert.equal(shared.length + exclusive.length, GATES.length);
});

test('gates: the in-place money mutation gate is exclusive, and the parts split the list', () => {
  assert.ok(GATES.find((g) => g.id === 'money-property-mutation').exclusive);
  const shared = selectGates(GATES, 'shared');
  const exclusive = selectGates(GATES, 'exclusive');
  assert.deepEqual(shared.exclusive, []);
  assert.deepEqual(exclusive.shared, []);
  assert.equal(shared.shared.length + exclusive.exclusive.length, GATES.length);
  assert.ok(exclusive.exclusive.every((g) => g.exclusive));
});

test('gates: a bad --jobs or --part is refused', () => {
  assert.deepEqual(runOptions(['--jobs', '4', '--part', 'shared']), { jobs: 4, part: 'shared' });
  assert.throws(() => runOptions(['--jobs', '0']), /whole number/);
  assert.throws(() => runOptions(['--jobs']), /whole number/);
  assert.throws(() => runOptions(['--part', 'some']), /shared or exclusive/);
});

test('the steps run without the variables git sets to locate this repository', () => {
  const env = stepEnv({ GIT_DIR: '/repo/.git', GIT_INDEX_FILE: '/repo/.git/index', PATH: '/bin', GIT_SSH_COMMAND: 'ssh' }, [
    'GIT_DIR',
    'GIT_INDEX_FILE',
  ]);
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_INDEX_FILE, undefined);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.GIT_SSH_COMMAND, 'ssh');
  assert.equal(env.FORCE_COLOR, '0');
});

test('the checks run in the Mac-wide heavy slot when its script exists, and `none` opts out', () => {
  const yes = () => true;
  const no = () => false;
  assert.equal(heavyWrapper({}, '/Users/x', yes), '/Users/x/code/review/restart/heavy.sh');
  assert.equal(heavyWrapper({}, '/Users/x', no), null);
  assert.equal(heavyWrapper({ INTAFACED_HEAVY_WRAPPER: '/opt/cap.sh' }, '/Users/x', yes), '/opt/cap.sh');
  assert.equal(heavyWrapper({ INTAFACED_HEAVY_WRAPPER: 'none' }, '/Users/x', yes), null);
  const noLocks = (p) => !p.endsWith('/locks');
  assert.deepEqual(heavyWrapper({}, '/Users/x', noLocks), {
    missing: '/Users/x/code/review/restart/locks',
    path: '/Users/x/code/review/restart/heavy.sh',
  });
});

test('a change to the shared config core settings during the checks is named', () => {
  const before = { 'core.bare': 'false', 'core.hookspath': '.githooks', 'core.worktree': null };
  assert.deepEqual(configDrift(before, { ...before }), []);
  assert.deepEqual(configDrift(before, { ...before, 'core.bare': 'true' }), ['core.bare: false → true']);
  assert.deepEqual(configDrift(before, { ...before, 'core.hookspath': null }), ['core.hookspath: .githooks → (unset)']);
});

test('durations print as minutes and seconds, never 60 seconds', () => {
  assert.equal(elapsed(0), '0m00s');
  assert.equal(elapsed(59_600), '1m00s');
  assert.equal(elapsed(119_600), '2m00s');
  assert.equal(elapsed(125_000), '2m05s');
});

test('vitest packages run without the infrastructure suites, other test scripts run as they are', () => {
  const pkgs = [
    { name: '@intafaced/svc-support', testScript: 'vitest run' },
    { name: '@intafaced/svc-fix', testScript: 'node scripts/run-mvn.mjs test' },
    { name: '@intafaced/no-tests', testScript: '' },
  ];
  const runs = testRuns(pkgs, { hasTestDb: false });
  assert.deepEqual(
    runs.map((r) => r.name),
    ['test', 'test-other'],
  );
  assert.ok(runs[0].args.includes('--filter=@intafaced/svc-support'));
  assert.ok(!runs[0].args.includes('--filter=@intafaced/svc-fix'));
  for (const g of INFRA_SUITES) assert.ok(runs[0].args.includes(g), g);
  assert.ok(runs[1].args.includes('--filter=@intafaced/svc-fix'));
  assert.ok(!runs[1].args.includes('--'));
  assert.ok(runs.every((r) => !r.args.includes('--filter=@intafaced/no-tests')));
});

test('with a test database the infrastructure suites run too', () => {
  const runs = testRuns([{ name: 'a', testScript: 'vitest run' }], { hasTestDb: true });
  assert.equal(runs.length, 1);
  assert.ok(!runs[0].args.includes('--exclude'));
  assert.deepEqual(testRuns([], { hasTestDb: false }), []);
});
