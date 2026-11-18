import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  CI_WORKFLOW_PATH,
  MONEY_JOB,
  MONEY_PATHS,
  MONEY_WORKFLOW_PATH,
  MODEL_WORKFLOW_PATH,
  ciRunFor,
  jobResults,
  judgeCiJobs,
  modelVerdict,
  moneyVerdict,
  touchesMoney,
} from './ci-jobs-seal.mjs';

const SHA = 'a'.repeat(40);
const run = (id, over = {}) => ({ id, head_sha: SHA, event: 'pull_request', path: CI_WORKFLOW_PATH, status: 'completed', ...over });
const job = (id, name, conclusion = 'success', status = 'completed') => ({ id, name, status, conclusion });
const green = (tests = ['Tests (changed)']) => [
  job(1, 'Affected tests'),
  job(2, 'Doctrine gates'),
  job(3, 'Format'),
  job(4, 'Typecheck & build'),
  ...tests.map((t, i) => job(10 + i, t)),
];
const product = ['services/svc-pay/src/a.ts'];

test('the newest ci.yml run of the event on the head decides; other workflows, events and heads never do', () => {
  const runs = [
    run(5),
    run(9, { path: '.github/workflows/fake.yml' }),
    run(8, { event: 'pull_request_target' }),
    run(7, { head_sha: 'b'.repeat(40) }),
    run(6),
  ];
  assert.equal(ciRunFor(runs, { sha: SHA, event: 'pull_request' }).id, 6);
  assert.equal(ciRunFor([], { sha: SHA, event: 'pull_request' }), null);
});

test('known good: every job green passes', () => {
  const v = judgeCiJobs({ run: run(1), jobs: green(), files: product });
  assert.equal(v.ok, true, v.lines.join('\n'));
});

test('a run still going waits (red) and says the seal re-runs; none says to merge main or push again', () => {
  for (const [r, said] of [
    [null, /no CI ran .* merge origin\/main if it conflicts/],
    [run(1, { status: 'in_progress' }), /re-runs/],
  ]) {
    const v = judgeCiJobs({ run: r, jobs: [], files: product });
    assert.equal(v.ok, false);
    assert.equal(v.wait, true);
    assert.match(v.lines[0], said);
  }
});

test('planted: a red or missing required job fails', () => {
  assert.equal(
    judgeCiJobs({ run: run(1), jobs: green().map((j) => (j.name === 'Format' ? { ...j, conclusion: 'failure' } : j)), files: product }).ok,
    false,
  );
  assert.equal(judgeCiJobs({ run: run(1), jobs: green().filter((j) => j.name !== 'Doctrine gates'), files: product }).ok, false);
});

test('planted: a pull request whose own ci.yml skips the tests its change needs fails (the base classifies)', () => {
  const v = judgeCiJobs({ run: run(1), jobs: green([]), files: product });
  assert.equal(v.ok, false);
  assert.match(v.lines.join('\n'), /tests-full was missing/);
  const skipped = judgeCiJobs({
    run: run(1),
    jobs: green(['Tests (changed)']).map((j) => (j.name.startsWith('Tests') ? { ...j, conclusion: 'skipped' } : j)),
    files: product,
  });
  assert.equal(skipped.ok, false);
});

test('one red shard of many fails; docs only needs no test job', () => {
  const shards = Array.from({ length: 16 }, (_, i) => `Tests (${i + 1}/16)`);
  const jobs = green(shards).map((j) => (j.name === 'Tests (7/16)' ? { ...j, conclusion: 'failure' } : j));
  assert.equal(judgeCiJobs({ run: run(1), jobs, files: ['.github/workflows/x.yml'] }).ok, false);
  assert.equal(judgeCiJobs({ run: run(1), jobs: green([]), files: ['docs/a.md'] }).ok, true);
});

test('files unreadable whole (null) or a merge queue commit need the full suite', () => {
  assert.equal(judgeCiJobs({ run: run(1), jobs: green([]), files: null }).ok, false);
  assert.equal(judgeCiJobs({ run: run(1), jobs: green([]), files: [], forceFull: true }).ok, false);
});

test('jobResults counts a repeated name by its newest job', () => {
  const r = jobResults([job(1, 'Format', 'failure'), job(2, 'Format', 'success')]);
  assert.equal(r.format, 'success');
});

test('planted: a full-suite change whose own ci.yml ran one shard fails; the whole matrix passes', () => {
  const full = ['packages/ledger-client/src/a.ts', '.github/workflows/ci.yml'];
  const one = judgeCiJobs({ run: run(1), jobs: green(['Tests (changed)']), files: full });
  assert.equal(one.ok, false);
  assert.match(one.lines.join('\n'), /16 shards never ran|of its 16 shards never ran/);
  const all = Array.from({ length: 16 }, (_, i) => `Tests (${i + 1}/16)`);
  assert.equal(judgeCiJobs({ run: run(1), jobs: green(all), files: full }).ok, true);
  assert.equal(judgeCiJobs({ run: run(1), jobs: green(all.slice(1)), files: full }).ok, false, 'one shard short');
});

test('a CI run back in progress only because its own seal job is being re-run is still judged (CI review on 7a7eb9a0)', () => {
  const jobs = [...green(), { id: 99, name: 'CI merge seal', status: 'in_progress', conclusion: null }];
  assert.equal(judgeCiJobs({ run: run(1, { status: 'in_progress', run_attempt: 2 }), jobs, files: product }).ok, true);
  // Planted: a required job still running keeps it waiting.
  const running = jobs.map((j) => (j.name === 'Format' ? { ...j, status: 'in_progress', conclusion: null } : j));
  assert.equal(judgeCiJobs({ run: run(1, { status: 'in_progress' }), jobs: running, files: product }).wait, true);
  assert.equal(judgeCiJobs({ run: run(1, { status: 'in_progress' }), jobs: [], files: product }).wait, true, 'no jobs read yet');
});

// ---- #8708: the money browser checks run on the pull request that touches them, and the seal waits for their verdict ----

const MSHA = 'a'.repeat(40);
const mrun = (id, over = {}) => ({ id, head_sha: MSHA, event: 'pull_request', path: MONEY_WORKFLOW_PATH, run_attempt: 1, ...over });
const mjob = (status, conclusion) => [{ id: 1, name: MONEY_JOB, status, conclusion }];

test('#8708: a change that touches no money path owes no run and is not held', () => {
  for (const files of [['services/svc-bank/src/a.ts'], ['docs/x.md'], ['apps/customerx/a.ts'], []]) {
    const v = moneyVerdict({ runs: [], jobs: [], files, sha: MSHA });
    assert.equal(v.ok, true, files.join());
  }
});

test('#8708: when they ran on the exact head, the newest run decides: passed is green, anything else holds the merge', () => {
  const files = ['apps/customer/src/screens/money/Deposit.tsx'];
  assert.equal(moneyVerdict({ runs: [mrun(5)], jobs: mjob('completed', 'success'), files, sha: MSHA }).ok, true);
  // Planted: red, cancelled, skipped or a finished run with no money job fails; still going waits. Each holds the merge.
  for (const [runs, jobs, wait, why] of [
    [[mrun(5)], mjob('completed', 'failure'), false, 'red'],
    [[mrun(5)], mjob('completed', 'cancelled'), false, 'cancelled'],
    [[mrun(5)], mjob('completed', 'skipped'), false, 'skipped'],
    [[mrun(5)], mjob('in_progress', null), true, 'going'],
    [[mrun(5, { status: 'in_progress' })], [], true, 'no job yet'],
    [[mrun(5, { status: 'completed' })], [], false, 'finished with no money job'],
    [[mrun(5), mrun(4)], mjob('completed', 'failure'), false, 'the newest is red, an older one green'],
  ]) {
    const v = moneyVerdict({ runs, jobs, files, sha: MSHA });
    assert.deepEqual([v.ok, v.wait], [false, wait], why);
  }
  // With no run on this head nothing waits (#8708: the merge waits for their verdict when they ran): a head pushed before
  // this change, or a run of another head, event or workflow, is no run here.
  for (const runs of [
    [],
    [mrun(5, { head_sha: 'b'.repeat(40) })],
    [mrun(5, { event: 'push' })],
    [mrun(5, { path: '.github/workflows/other.yml' })],
  ])
    assert.equal(moneyVerdict({ runs, jobs: mjob('completed', 'failure'), files, sha: MSHA }).ok, true);
  assert.equal(
    moneyVerdict({ runs: [mrun(5)], jobs: mjob('completed', 'failure'), files: null, sha: MSHA }).ok,
    false,
    'unreadable files count as touching',
  );
  assert.equal(moneyVerdict({ runs: [mrun(5)], jobs: mjob('in_progress', null), files, sha: MSHA }).wait, true);
});

test("#8708: MONEY_PATHS are the money workflow's pull_request and push paths, both, and the pull request trigger is there", () => {
  const text = readFileSync(MONEY_WORKFLOW_PATH, 'utf8');
  const lists = [...text.matchAll(/\n {4}paths:\n((?: {6}- '[^']+'\n)+)/g)].map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  assert.equal(lists.length, 2, 'one list under pull_request and one under push');
  for (const l of lists) assert.deepEqual(l, MONEY_PATHS);
  assert.match(text, /\non:\n  workflow_dispatch:\n  pull_request:\n    paths:\n/);
  assert.match(text, /\n  push:\n    branches: \[main\]\n    paths:\n/);
  assert.equal(touchesMoney([MONEY_WORKFLOW_PATH]), true, 'a change to the workflow itself owes a run');
  assert.equal(touchesMoney(['packages/contracts/src/index.ts']), true);
});

// ---- project-state#2962: the seal waits for the Model check and requires its verdict; could not check is judge down ----

const xrun = (id, over = {}) => ({
  id,
  head_sha: SHA,
  event: 'pull_request',
  path: MODEL_WORKFLOW_PATH,
  status: 'completed',
  run_attempt: 1,
  ...over,
});
const xstep = (name, conclusion) => ({ name, status: 'completed', conclusion });
const xjob = (conclusion, steps, status = 'completed') => [{ id: 1, name: 'Model check', status, conclusion, steps }];
const VERDICT = (c) => [xstep('Read the models', 'success'), xstep('Judge down', 'skipped'), xstep('Verdict', c)];
const DOWN = [xstep('Read the models', 'success'), xstep('Judge down', 'success'), xstep('Verdict', 'skipped')];

test('project-state#2962: the Model check passed on the exact head is green; a broken rule, a cancel or no run fails', () => {
  assert.equal(modelVerdict({ runs: [xrun(5)], jobs: xjob('success', VERDICT('success')), sha: SHA }).ok, true);
  for (const [runs, jobs, wait, why] of [
    [[xrun(5)], xjob('failure', VERDICT('failure')), false, 'a rule broke'],
    [[xrun(5)], xjob('cancelled', []), false, 'cancelled'],
    [[xrun(5)], xjob('skipped', []), false, 'skipped'],
    [[xrun(5)], [], false, 'finished with no Model check job'],
    [[xrun(5, { status: 'in_progress' })], xjob(null, [], 'in_progress'), true, 'going'],
    [[xrun(5), xrun(4)], xjob('failure', VERDICT('failure')), false, 'the newest is red, an older one green'],
    // It runs on every pull request, so no run on the head is no verdict, never a pass.
    [[], [], false, 'no run'],
    [[xrun(5, { head_sha: 'b'.repeat(40) })], xjob('success', VERDICT('success')), false, 'another head'],
    [[xrun(5, { event: 'workflow_dispatch' })], xjob('success', VERDICT('success')), false, 'a dispatch is not the pull request run'],
  ]) {
    const v = modelVerdict({ runs, jobs, sha: SHA });
    assert.deepEqual([v.ok, v.wait, Boolean(v.down)], [false, wait, false], why);
  }
});

test('project-state#2962: a run that could not check is judge down, no verdict: never a pass and never a red on the change', () => {
  const v = modelVerdict({ runs: [xrun(5)], jobs: xjob('success', DOWN), sha: SHA });
  assert.deepEqual([v.ok, v.wait, v.down], [false, true, true]);
  assert.match(v.lines[0], /^judge down: .*could not check/);
  // Planted: a job that ran its Verdict too is a verdict, whatever the Judge down step did.
  const both = [xstep('Judge down', 'success'), xstep('Verdict', 'failure')];
  assert.equal(modelVerdict({ runs: [xrun(5)], jobs: xjob('failure', both), sha: SHA }).down, undefined);
});
