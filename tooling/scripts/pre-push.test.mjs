// Unit tests for the pre-push checks (tooling/scripts/pre-push.mjs) and the gate runner's --jobs and --part options.
// Run by tooling/scripts/tooling-tests.mjs (the `tooling-tests` Doctrine gate).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRefs, planChecks, skipReason, SKIP_ENV } from './pre-push.mjs';
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
