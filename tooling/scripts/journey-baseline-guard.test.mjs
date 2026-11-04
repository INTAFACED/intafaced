// Tests for tooling/ci/journey-baseline-guard.mjs: the three runbook rules it enforces, each shown passing and
// failing, on small made-up baselines. Runs in the Doctrine gates' tooling tests (tooling/scripts/tooling-tests.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeBaselineChange, namedRunProblem, liveSteps, isProductCode, runRange, listRuns } from '../ci/journey-baseline-guard.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_S = 'c'.repeat(40);
const run = (number, sha) => ({ number, id: 1000 + number, sha, url: `https://x/${number}` });
const meta = (number, sha, over = {}) => ({
  run_number: number,
  id: 1000 + number,
  head_sha: sha,
  head_branch: 'main',
  event: 'schedule',
  status: 'completed',
  conclusion: 'failure',
  path: '.github/workflows/real-app-journeys.yml',
  ...over,
});
const states = (o) => new Map(Object.entries(o));
const unbuilt = (step, extra = {}) => ({
  step,
  file: 'apps/customer/tests/real-app/J-x-01.pw.mjs',
  state: 'unbuilt',
  money: false,
  ...extra,
});
const live = liveSteps([{ id: 'J-x-01', steps: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }] }]);

// Base names run 10; head names run 12; run 11 sits between them.
const base = { run: run(10, SHA_A), steps: [unbuilt('J-x-01#2'), unbuilt('J-x-01#3')] };
const runs = [
  { number: 10, id: 1010, head_sha: SHA_A },
  { number: 11, id: 1011, head_sha: SHA_A },
  { number: 12, id: 1012, head_sha: SHA_B },
];
const reports = new Map([
  [10, states({ 'J-x-01#1': 'passed', 'J-x-01#2': 'failed', 'J-x-01#3': 'failed', 'J-x-01#4': 'failed' })],
  [11, states({ 'J-x-01#1': 'passed', 'J-x-01#2': 'failed', 'J-x-01#3': 'failed', 'J-x-01#4': 'failed' })],
  [12, states({ 'J-x-01#1': 'passed', 'J-x-01#2': 'passed', 'J-x-01#3': 'failed', 'J-x-01#4': 'failed' })],
]);
const judge = (head, over = {}) => judgeBaselineChange({ base, head, live, headRunMeta: meta(12, SHA_B), runs, reports, ...over });

test('pass: removing a step after it passed on main (the regenerated run passed it)', () => {
  const r = judge({ run: run(12, SHA_B), steps: [unbuilt('J-x-01#3')] });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
});

test('fail: adding a step that passed on main as unbuilt (J-x-01#1 passed in runs 10 to 12)', () => {
  const r = judge({ run: run(12, SHA_B), steps: [unbuilt('J-x-01#1'), unbuilt('J-x-01#3')] });
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.problems.map((p) => p.step),
    ['J-x-01#1'],
  );
  assert.match(r.problems[0].why, /passed on main in run 10, 11, 12/);
});

test('fail: the same addition without changing the run is refused on the named run alone', () => {
  const r = judgeBaselineChange({
    base,
    head: { run: base.run, steps: [...base.steps, unbuilt('J-x-01#1')] },
    live,
    runs: runs.slice(0, 1),
    reports,
  });
  assert.equal(r.ok, false);
  assert.match(r.problems[0].why, /run 10\b/);
});

test('fail: removing a step that did not pass (still red in the named run)', () => {
  const r = judge({ run: run(12, SHA_B), steps: [unbuilt('J-x-01#2')] });
  assert.equal(r.ok, false);
  assert.equal(r.problems[0].step, 'J-x-01#3');
  assert.match(r.problems[0].why, /without a pass on main after run 10: it is failed in run 12/);
});

test('pass: removing a retired step (gone from journeys.json) is a note, not a refusal', () => {
  const r = judge(
    { run: run(12, SHA_B), steps: [unbuilt('J-x-01#2')] },
    { live: liveSteps([{ id: 'J-x-01', steps: [{ n: 1 }, { n: 2 }] }]) },
  );
  assert.equal(r.ok, true);
  assert.match(r.notes.join('\n'), /J-x-01#3 leaves the baseline as retired/);
});

test('pass: adding a never-passed step as unbuilt, and a note when it was absent in the base run', () => {
  const r = judge({ run: run(12, SHA_B), steps: [unbuilt('J-x-01#3'), unbuilt('J-x-01#4')] });
  assert.equal(r.ok, true);
  const r2 = judgeBaselineChange({
    base,
    head: { run: run(12, SHA_B), steps: [...base.steps.slice(1), unbuilt('J-x-01#9')] },
    live,
    headRunMeta: meta(12, SHA_B),
    runs,
    reports,
  });
  assert.match(r2.notes.join('\n'), /not seen before run 10 .*J-x-01#9/);
});

test('fail: a report gone in the range fails closed for an added unbuilt step', () => {
  const r = judge(
    { run: run(12, SHA_B), steps: [...base.steps.slice(1), unbuilt('J-x-01#4')] },
    { reports: new Map([...reports, [11, null]]) },
  );
  assert.equal(r.ok, false);
  assert.match(r.problems[0].why, /run 11 has no report/);
});

test('fail: what the base itself records of a pass before the runs read (notBaselined, a regression, lastPassedRun)', () => {
  // J-x-01#4 fails in every run read, so only the files show it passed before run 10.
  const withNb = { ...base, notBaselined: [{ step: 'J-x-01#4', money: true, lastPassedRun: 9 }] };
  const head = { run: base.run, steps: [...base.steps, unbuilt('J-x-01#4')] };
  const r = judgeBaselineChange({ base: withNb, head, live, runs: runs.slice(0, 1), reports });
  assert.match(r.problems[0].why, /notBaselined: it passed on main in run 9/);
  const asRegression = { ...base, steps: [...base.steps, { ...unbuilt('J-x-01#4'), state: 'regression', issue: 7 }] };
  const r2 = judgeBaselineChange({ base: asRegression, head, live, runs: runs.slice(0, 1), reports });
  assert.match(r2.problems[0].why, /turned from regression into unbuilt, but a regression entry passed on main before \(issue #7\)/);
  const r3 = judgeBaselineChange({
    base,
    head: { run: base.run, steps: [...base.steps, unbuilt('J-x-01#4', { lastPassedRun: 8 })] },
    live,
    runs: runs.slice(0, 1),
    reports,
  });
  assert.match(r3.problems[0].why, /its own entry says it passed on main in run 8/);
});

test('rule 1: the named run must be a finished, uncancelled run on main that GitHub matches', () => {
  const head = { run: run(12, SHA_B), steps: base.steps };
  assert.equal(judge(head).ok, true);
  for (const [over, why] of [
    [{ head_branch: 'feat/x' }, /not main/],
    [{ conclusion: 'cancelled' }, /was cancelled/],
    [{ status: 'in_progress' }, /has not finished/],
    [{ event: 'pull_request' }, /pull request run/],
    [{ head_sha: SHA_A }, /ran a{40}, not b{40}/],
    [{ path: '.github/workflows/ci.yml' }, /not a Real-app journeys run/],
  ]) {
    const r = judge(head, { headRunMeta: meta(12, SHA_B, over) });
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.match(r.problems[0].why, why);
  }
  assert.match(
    judge({ run: run(9, SHA_B), steps: base.steps }, { headRunMeta: meta(9, SHA_B) }).problems[0].why,
    /moves back from run 10 to run 9/,
  );
  assert.equal(namedRunProblem(run(12, SHA_B), undefined), "run 12 (id 1012) couldn't be read");
});

test('test ahead of code: a stricter test may list a step that passed before, never one whose stricter test passed', () => {
  const strict = unbuilt('J-x-01#1', { strengthenedBy: SHA_S, blocker: 'b', lane: 'L', lastPassedRun: 11, issue: 1 });
  const files = () => ['apps/customer/tests/real-app/J-x-01.pw.mjs'];
  // Runs 10 and 11 came before the stricter test; run 12 has it, and J-x-01#1 passed in all three.
  const before12 = (sha, n) => n === 12;
  const r = judge(
    { run: run(12, SHA_B), steps: [strict, unbuilt('J-x-01#2'), unbuilt('J-x-01#3')] },
    { contains: before12, commitFiles: files, onMain: () => true },
  );
  assert.equal(r.ok, false);
  assert.match(r.problems.at(-1).why, /passed on main in run 12/);
  // With run 12 red for it, the stricter test never passed: allowed.
  const reports2 = new Map([...reports, [12, states({ 'J-x-01#1': 'failed', 'J-x-01#2': 'failed', 'J-x-01#3': 'failed' })]]);
  const ok = judge(
    { run: run(12, SHA_B), steps: [strict, unbuilt('J-x-01#2'), unbuilt('J-x-01#3')] },
    { contains: before12, commitFiles: files, reports: reports2, onMain: () => true },
  );
  assert.deepEqual(ok.problems, []);
  // Missing fields, a short sha, a commit that doesn't touch the file, product code with no proof, an unread compare.
  const bad = (e, over = {}) =>
    judge(
      { run: run(12, SHA_B), steps: [e, unbuilt('J-x-01#2'), unbuilt('J-x-01#3')] },
      { contains: before12, commitFiles: files, reports: reports2, onMain: () => true, ...over },
    )
      .problems.map((p) => p.why)
      .join('\n');
  assert.match(bad({ ...strict, lane: undefined }), /without lane/);
  assert.match(bad({ ...strict, strengthenedBy: 'abc1234' }), /not a full sha/);
  assert.match(bad(strict, { commitFiles: () => ['apps/customer/tests/real-app/J-y-01.pw.mjs'] }), /doesn't change the step's file/);
  assert.match(
    bad(strict, { commitFiles: () => [...files(), 'services/svc-bank/src/a.ts'] }),
    /changes product code .*without a full priorTestProof/,
  );
  assert.match(bad(strict, { contains: () => undefined }), /couldn't be read/);
  assert.match(bad(strict, { commitFiles: () => undefined }), /files couldn't be read/);
  // The runbook: the commit must be on main. One only on a branch is in no run, so every pass would read as earlier.
  assert.match(bad(strict, { onMain: () => false, contains: () => false }), /which is not on main/);
  assert.match(bad(strict, { onMain: () => undefined }), /whether it is on main couldn't be read/);
});

test('an unbuilt entry added with the run unchanged is judged against every run to the newest, not the named run alone', () => {
  const head = { run: base.run, steps: [...base.steps, unbuilt('J-x-01#2b')] };
  const range = runRange(base, head);
  assert.equal(range.from, 10);
  assert.equal(range.to, Infinity);
  // A step that failed in the named run but passed in a later run on main is refused.
  const later = new Map([...reports, [11, states({ ...Object.fromEntries(reports.get(11)), 'J-x-01#4': 'passed' })]]);
  const added = { run: base.run, steps: [...base.steps, unbuilt('J-x-01#4')] };
  const inRange = (h) => runs.filter((x) => x.number >= runRange(base, h).from && x.number <= runRange(base, h).to);
  assert.deepEqual(
    inRange(added).map((x) => x.number),
    [10, 11, 12],
  );
  const r = judgeBaselineChange({ base, head: added, live, runs: inRange(added), reports: later });
  assert.equal(r.ok, false);
  assert.match(r.problems[0].why, /passed on main in run 11/);
  // A change that adds nothing as unbuilt reads only from the base's run to the head's.
  assert.deepEqual(runRange(base, { run: run(12, SHA_B), steps: [unbuilt('J-x-01#3')] }), { from: 10, to: 12, addsUnbuilt: false });
});

test('the runs list fails closed when it ends before the base run', () => {
  const page = (nums) => ({
    status: 0,
    stdout: JSON.stringify({
      workflow_runs: nums.map((n) => ({
        run_number: n,
        id: n,
        head_sha: SHA_A,
        head_branch: 'main',
        event: 'schedule',
        conclusion: 'failure',
      })),
    }),
  });
  const pages = [page([15, 14, 13]), page([])];
  const gh = () => pages.shift() ?? page([]);
  assert.throws(() => listRuns(gh, 'o/r', 10, Infinity), /ended before run 10/);
  const whole = [page([12, 11, 10, 9])];
  assert.deepEqual(
    listRuns(() => whole.shift(), 'o/r', 10, Infinity).map((r) => r.number),
    [10, 11, 12],
  );
});

test('product code matches the runbook definition', () => {
  assert.equal(isProductCode('services/svc-bank/src/a.ts'), true);
  assert.equal(isProductCode('apps/customer/tests/real-app/J-x-01.pw.mjs'), false);
  assert.equal(isProductCode('packages/x/src/a.test.ts'), false);
  assert.equal(isProductCode('tooling/scripts/a.mjs'), false);
});

test('liveSteps leaves deferred journeys and steps out', () => {
  const s = liveSteps([
    { id: 'J-a-01', steps: [{ n: 1 }, { n: 2, deferred: true }] },
    { id: 'J-b-01', deferred: true, steps: [{ n: 1 }] },
  ]);
  assert.deepEqual([...s], ['J-a-01#1']);
});
