// CI runs a bug fix's test on the code before the fix (#11267): the job's wiring in ci.yml, read as text. Kept apart from
// bug-test-base.test.mjs, which imports the script, so this file loads on any base and fails there by its own assertion.
// Run by tooling/scripts/tooling-tests.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { otherRedJobs } from './ci-jobs-seal.mjs';

const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const job = (name) => {
  const at = ci.indexOf(`\n  ${name}:\n`);
  assert.notEqual(at, -1, `ci.yml has no job ${name}`);
  const rest = ci.slice(at + 1);
  const end = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return end === -1 ? rest : rest.slice(0, end + 1);
};

test('a pull request that closes a bug runs its tests on the code before the fix', () => {
  const changes = job('changes');
  assert.match(changes, /bug: \$\{\{ steps\.bug\.outputs\.issue \}\}/);
  assert.match(changes, /issues: read/);
  assert.match(changes, /run: node tooling\/ci\/bug-test-base\.mjs --which/);
  const bug = job('bug-test');
  assert.match(bug, /if: needs\.changes\.outputs\.bug != ''/);
  assert.match(bug, /fetch-depth: 2/);
  assert.match(bug, /node "\$script" --issue "\$ISSUE" --base HEAD\^1/);
  // Main's copy decides once main has one.
  assert.match(bug, /git cat-file -e FETCH_HEAD:tooling\/ci\/bug-test-base\.mjs/);
});

test('a red bug test holds the merge: the seal fails on a red job it does not otherwise read', () => {
  const name = /\n {2}bug-test:\n {4}name: (.+)\n/.exec(ci)?.[1];
  assert.equal(name, 'Bug test on the base');
  const red = otherRedJobs([{ id: 1, name, status: 'completed', conclusion: 'failure' }]);
  assert.deepEqual(red, [`${name} was failure (a job that ran red stays red)`]);
  assert.deepEqual(otherRedJobs([{ id: 1, name, status: 'completed', conclusion: 'skipped' }]), []);
});
