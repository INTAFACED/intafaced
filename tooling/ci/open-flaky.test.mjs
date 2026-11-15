import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flakyIssue, parseArgs } from './open-flaky.mjs';

const base = {
  sha: 'abcdef1234567',
  run: 'https://github.com/o/r/actions/runs/42',
  title: 'the quote answers no liquidity once',
  body: 'saw x',
};

test('a journey step that failed then passed on one commit opens labelled flaky, the pick 1 label', () => {
  const i = flakyIssue({ ...base, steps: ['J-cex-spot-11 #12'] });
  assert.equal(i.label, 'flaky');
  assert.equal(i.title, 'Flaky: J-cex-spot-11 #12: the quote answers no liquidity once');
  assert.match(i.body, /failed, then passed, on the same commit `abcdef1234`/);
});

test('a unit test opens labelled flaky-test and says it carries no pick 1 label', () => {
  const i = flakyIssue({ ...base, tests: ['services/svc-bank/src/cards-procedures.test.ts'] });
  assert.equal(i.label, 'flaky-test');
  assert.match(i.body, /no journey step, so it carries `flaky-test` and no pick 1 label/);
});

test('nothing opens bare or mixed: no kind, both kinds, a bad step, no commit or no run is refused', () => {
  assert.throws(() => flakyIssue(base), /name the flaky journey step/);
  assert.throws(() => flakyIssue({ ...base, steps: ['J-a-01 #1'], tests: ['services/x/a.test.ts'] }), /not both/);
  assert.throws(() => flakyIssue({ ...base, steps: ['J-a-01'] }), /not a journey step/);
  assert.throws(() => flakyIssue({ ...base, tests: ['services/x/../../etc/a.test.ts'] }), /not a repo-relative/);
  assert.throws(() => flakyIssue({ ...base, sha: 'main', steps: ['J-a-01 #1'] }), /--sha/);
  assert.throws(() => flakyIssue({ ...base, run: '', steps: ['J-a-01 #1'] }), /--run/);
  assert.throws(() => flakyIssue({ ...base, body: ' ', steps: ['J-a-01 #1'] }), /--body-file/);
});

test('argv: repeated steps collect, and an unknown flag is refused', () => {
  const o = parseArgs(['--step', 'J-a-01 #1', '--step', 'J-a-01 #2', '--sha', 'abc1234', '--body-file', 'f', '--dry-run']);
  assert.deepEqual(o.steps, ['J-a-01 #1', 'J-a-01 #2']);
  assert.equal(o.bodyFile, 'f');
  assert.equal(o.dryRun, true);
  assert.throws(() => parseArgs(['--label', 'x']), /unknown argument/);
});
