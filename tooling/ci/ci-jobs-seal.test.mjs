import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import {
  CI_WORKFLOW_PATH,
  FRESH_MAIN_STEP,
  MONEY_JOB,
  MONEY_PATHS,
  MONEY_WORKFLOW_PATH,
  MODEL_WORKFLOW_PATH,
  RULE_MARGIN_MS,
  RULE_PATHS,
  LINT_PATHS,
  GATE_PATHS,
  ciRunFor,
  jobResults,
  judgedOnFreshMain,
  judgeCiJobs,
  modelVerdict,
  moneyVerdict,
  RERUN_POLLS,
  rerunStaleGates,
  ruleChanges,
  rulesTakenAt,
  rulesVerdict,
  staleRulesRerun,
  touchesMoney,
} from './ci-jobs-seal.mjs';
import { SHARD_COUNT } from './ci-affected.mjs';

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
  // ci.yml is in the change, so its Rust job runs too (ci-affected.mjs classify `rust`).
  assert.equal(judgeCiJobs({ run: run(1), jobs: green([...all, 'Rust']), files: full }).ok, true);
  assert.equal(judgeCiJobs({ run: run(1), jobs: green([...all.slice(1), 'Rust']), files: full }).ok, false, 'one shard short');
});

test('planted: a change that reaches Rust fails without a green Rust job; Rust files alone need no test shard', () => {
  const rust = ['crates/svc-tax/src/lib.rs'];
  assert.equal(judgeCiJobs({ run: run(1), jobs: green(['Rust']), files: rust }).ok, true);
  const missing = judgeCiJobs({ run: run(1), jobs: green([]), files: rust });
  assert.equal(missing.ok, false);
  assert.match(missing.lines.join('\n'), /rust was missing/);
  assert.equal(
    judgeCiJobs({ run: run(1), jobs: green(['Rust']).map((j) => (j.name === 'Rust' ? { ...j, conclusion: 'failure' } : j)), files: rust })
      .ok,
    false,
  );
  assert.equal(
    judgeCiJobs({ run: run(1), jobs: green(['Rust']).map((j) => (j.name === 'Rust' ? { ...j, conclusion: 'skipped' } : j)), files: rust })
      .ok,
    false,
  );
  assert.equal(judgeCiJobs({ run: run(1), jobs: green(), files: product }).ok, true, 'a TypeScript change needs no Rust job');
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

test('project-state#3326: main changing a rule after CI took its rules fails and says to merge main and push', () => {
  const ci = run(44331599180, { created_at: '2026-11-18T15:05:39Z' });
  // #8915: CI took main's rules at 15:05:39Z; #8916 landed garden/restart-through-helper at 15:31:21Z.
  const change = { sha: '927d7178e8'.padEnd(40, '0'), date: '2026-11-18T15:31:21Z', title: 'fix(journeys): restartService (#8916)' };
  const v = rulesVerdict({
    run: ci,
    changes: [
      { ...change, path: 'tooling/lint/' },
      { ...change, path: '.oxlintrc.json' },
    ],
  });
  assert.equal(v.ok, false);
  assert.equal(v.lines.length, 1, 'one line per commit, naming every rule path it changed');
  assert.match(v.lines[0], /tooling\/lint\/, \.oxlintrc\.json in 927d7178e8/);
  assert.match(v.lines[0], /re-run it \(gh run rerun 44331599180 --job <its id>\)/);
});

test('project-state#3326: a lint change is cleared by a Doctrine gates job that started after it; a gate-list change only by a new head', () => {
  const ci = run(44178387624, { created_at: '2026-11-17T21:17:17Z' });
  const lint = { sha: 'c'.repeat(40), date: '2026-11-17T21:28:03Z', title: 'a lint rule', path: 'tooling/lint/' };
  const gate = { sha: 'd'.repeat(40), date: '2026-11-17T21:28:03Z', title: 'knip (#8797)', path: 'tooling/ci/gates.mjs' };
  const early = [{ id: 2, name: 'Doctrine gates', status: 'completed', conclusion: 'success', started_at: '2026-11-17T21:18:00Z' }];
  const rerun = [{ id: 9, name: 'Doctrine gates', status: 'completed', conclusion: 'success', started_at: '2026-11-17T21:40:00Z' }];
  const before = rulesVerdict({ run: ci, jobs: early, changes: [lint] });
  assert.equal(before.ok, false);
  assert.match(before.lines[0], /gh run rerun 44178387624 --job 2/);
  assert.equal(rulesVerdict({ run: ci, jobs: [...early, ...rerun], changes: [lint] }).ok, true, 'the newest job decides');
  // #8789: gates.mjs gained the dead-code gate after the run's merge commit; a re-run keeps that commit.
  const g = rulesVerdict({ run: ci, jobs: [...early, ...rerun], changes: [gate] });
  assert.equal(g.ok, false);
  assert.match(g.lines[0], /merge origin\/main and push/);
  // A lint change already in main when the job started is no change.
  assert.equal(rulesVerdict({ run: ci, jobs: rerun, changes: [{ ...lint, date: '2026-11-17T21:39:00Z' }] }).ok, true);
});

// #9170 on 20 Nov 2026: CI run 44656912296 was made at 01:53:53Z and its Doctrine gates job 136025275837 started at
// 01:53:56Z; main changed the gate list in f8f945e416 (#9163) at 02:02:04Z. The seal told it to merge main and push, and
// the pull request ran everything again. A gates job that judged on main afresh is re-run alone instead.
test('project-state#3035: a gate-list change is cleared by re-running a Doctrine gates job that judges on main afresh', () => {
  const ci = run(44656912296, { created_at: '2026-11-20T01:53:53Z' });
  const gate = {
    sha: 'f8f945e416af154cde1c9e300d27d1ff07530ba0',
    date: '2026-11-20T02:02:04Z',
    title: 'fix(tooling): one type-check command (#9163)',
    path: 'tooling/ci/gates.mjs',
  };
  const step = (conclusion) => ({ name: FRESH_MAIN_STEP, status: 'completed', conclusion });
  const gates = (id, started_at, steps) => ({ id, name: 'Doctrine gates', status: 'completed', conclusion: 'success', started_at, steps });
  const first = gates(136025275837, '2026-11-20T01:53:56Z', [step('success')]);
  // The job judged before the change: refused, and told to re-run that job, not to merge main and push.
  const before = rulesVerdict({ run: ci, jobs: [first], changes: [gate] });
  assert.equal(before.ok, false);
  assert.match(before.lines[0], /gh run rerun 44656912296 --job 136025275837/);
  assert.doesNotMatch(before.lines[0], /merge origin\/main/);
  // Its re-run started after the change: it judged by the gate list main has now.
  const rerun = gates(136025999999, '2026-11-20T02:10:00Z', [step('success')]);
  assert.equal(rulesVerdict({ run: ci, jobs: [first, rerun], changes: [gate] }).ok, true);
  // A re-run that started before the change still fails: the newest job's own start decides.
  assert.equal(rulesVerdict({ run: ci, jobs: [first, { ...rerun, started_at: '2026-11-20T02:02:00Z' }], changes: [gate] }).ok, false);
  // Planted: a re-run without the step (a merge commit from before ci.yml had it) re-judges the old merge commit: merge
  // main and push, as before.
  for (const steps of [[], [step('skipped')], [step('failure')], undefined]) {
    const v = rulesVerdict({ run: ci, jobs: [first, { ...rerun, steps }], changes: [gate] });
    assert.equal(v.ok, false, JSON.stringify(steps));
    assert.match(v.lines[0], /merge origin\/main and push/);
  }
  assert.equal(judgedOnFreshMain(undefined), false);
});

// #9429 on 21 Nov 2026: CI run 44912458884's Doctrine gates job 136871122503 started at 14:10:05Z; #9422 changed
// tooling/lint/ in 01354ce8b2 at 14:10:35Z. Seal run 44912453971 attempt 2 failed on that verdict alone at 14:43:28Z and
// sat red until someone re-ran the job by hand.
test('project-state#3599: the seal re-runs a Doctrine gates job a lint change on main made stale, and asks no other re-run', () => {
  const ci = run(44912458884, { created_at: '2026-11-21T14:10:00Z' });
  const lint = { sha: '01354ce8b2'.padEnd(40, '0'), date: '2026-11-21T14:10:35Z', title: 'test(lint) (#9422)', path: 'tooling/lint/' };
  const gatesJob = {
    id: 136871122503,
    name: 'Doctrine gates',
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-11-21T14:10:05Z',
  };
  const rules = rulesVerdict({ run: ci, jobs: [gatesJob], changes: [lint] });
  const pass = { ok: true, lines: [] };
  const fail = { ok: false, lines: ['x'] };
  assert.deepEqual(staleRulesRerun({ ci: pass, money: pass, model: pass, rules }), { runId: 44912458884, jobId: 136871122503 });
  // Planted: any other failed verdict asks for none, whether or not the rules are stale too.
  for (const other of ['ci', 'money', 'model']) {
    const vs = { ci: pass, money: pass, model: pass, rules, [other]: fail };
    assert.equal(staleRulesRerun(vs), null, other);
  }
  assert.equal(staleRulesRerun({ ci: fail, money: pass, model: pass, rules: { ok: true, lines: [], rerun: null } }), null);
  assert.equal(staleRulesRerun({ ci: pass, money: pass, model: pass, rules: { ok: true, lines: [], rerun: null } }), null);
  // A gate-list change a re-run can't clear (a gates job that never judged on main afresh) asks none: merge main and push.
  const gate = { ...lint, path: 'tooling/ci/gates.mjs' };
  const g = rulesVerdict({ run: ci, jobs: [gatesJob], changes: [lint, { ...gate, sha: 'e'.repeat(40) }] });
  assert.equal(g.ok, false);
  assert.equal(staleRulesRerun({ ci: pass, money: pass, model: pass, rules: g }), null);
  // No gates job to name: nothing to re-run.
  assert.equal(rulesVerdict({ run: ci, jobs: [], changes: [{ ...lint, date: '2026-11-21T14:20:00Z' }] }).rerun, null);
  // At most once per change: the re-run job starts after the change, so the next seal asks for none.
  const after = rulesVerdict({ run: ci, jobs: [{ ...gatesJob, id: 136871999999, started_at: '2026-11-21T14:44:00Z' }], changes: [lint] });
  assert.equal(after.ok, true);
  assert.equal(staleRulesRerun({ ci: pass, money: pass, model: pass, rules: after }), null);
});

test('project-state#3599: rerunStaleGates waits for the CI run to finish, then re-runs that one job; a refusal is printed, not thrown', async () => {
  const step = { runId: 44912458884, jobId: 136871122503 };
  const calls = [];
  const states = ['in_progress', 'in_progress', 'completed'];
  const line = await rerunStaleGates({
    repo: 'o/r',
    step,
    get: async (p) => (calls.push(['get', p]), { status: states.shift() }),
    post: async (p) => (calls.push(['post', p]), { status: 201 }),
    sleep: async () => {},
  });
  assert.deepEqual(
    calls.filter((c) => c[0] === 'post'),
    [['post', '/repos/o/r/actions/jobs/136871122503/rerun']],
  );
  assert.equal(calls.filter((c) => c[0] === 'get').length, 3);
  assert.match(line, /re-ran Doctrine gates job 136871122503 of CI run 44912458884/);
  const refused = await rerunStaleGates({
    repo: 'o/r',
    step,
    get: async () => ({ status: 'completed' }),
    post: async () => ({ status: 403, message: 'Resource not accessible by integration' }),
    sleep: async () => {},
  });
  assert.match(refused, /could not re-run .*403 Resource not accessible by integration.*by hand/);
  let posts = 0;
  const never = await rerunStaleGates({
    repo: 'o/r',
    step,
    get: async () => ({ status: 'in_progress' }),
    post: async () => (posts++, { status: 201 }),
    sleep: async () => {},
  });
  assert.equal(posts, 0, 'never posts into a running run');
  assert.match(never, new RegExp(`had not finished after ${RERUN_POLLS * 10} s`));
});

test("project-state#3599: merge-seal.yml's seal job may re-run a job (actions: write), and its script still never checks out the pull request", () => {
  const text = readFileSync('.github/workflows/merge-seal.yml', 'utf8');
  const seal = text.split('\n  seal:\n')[1];
  assert.match(seal, /\n {6}actions: write\b/);
  assert.doesNotMatch(text, /ref: \$\{\{ github\.event\.pull_request/);
});

test("project-state#3035: ci.yml's Doctrine gates job merges the head onto main fetched afresh before any gate or install", () => {
  const yml = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = yml.slice(yml.indexOf('    name: Doctrine gates\n'), yml.indexOf('\n  changes:\n'));
  assert.ok(job.length > 0, 'the Doctrine gates job');
  const at = job.indexOf(`- name: ${FRESH_MAIN_STEP}\n`);
  assert.ok(at > job.indexOf('actions/checkout@') && at > 0, 'after the checkout');
  assert.ok(at < job.indexOf('- run: pnpm install') && at < job.indexOf('run: pnpm gates'), 'before the install and the gates');
  const body = job.slice(at, job.indexOf('- uses:', at));
  assert.match(body, /if: github\.event_name == 'pull_request'\n/);
  assert.match(body, /head=\$\(git rev-parse --verify HEAD\^2\)/, "the pull request's head is the merge commit's second parent");
  assert.match(body, /git fetch --no-tags --quiet origin \+refs\/heads\/main:refs\/remotes\/origin\/main/, 'main afresh, as origin/main');
  assert.match(body, /git checkout --quiet --detach refs\/remotes\/origin\/main/, 'main is the first parent');
  assert.match(body, /merge --quiet --no-ff --no-edit "\$head"/, 'the head is the second');
  assert.match(body, /exit 1/, 'a conflict fails the job');
});

test('project-state#3326: no rule change since CI took the rules passes; no CI run is for judgeCiJobs to hold', () => {
  const ci = run(7, { created_at: '2026-11-18T15:05:39Z' });
  assert.equal(rulesVerdict({ run: ci, changes: [] }).ok, true);
  assert.equal(rulesVerdict({ run: null, changes: [] }).ok, true);
});

test('project-state#3326: the rules are taken a margin before the run is created, and a re-run keeps its first created_at', () => {
  assert.equal(rulesTakenAt(run(7, { created_at: '2026-11-18T15:05:39Z', run_attempt: 3 })), '2026-11-18T15:04:39.000Z');
  assert.equal(RULE_MARGIN_MS, 60_000);
  assert.equal(rulesTakenAt(null), null);
});

test('project-state#3326: every RULE_PATHS entry exists, so a moved rule file is not silently unwatched', () => {
  for (const p of RULE_PATHS) assert.ok(existsSync(new URL(`../../${p}`, import.meta.url)), `${p} is missing`);
  for (const p of ['.oxlintrc.json', 'tooling/lint/', 'tooling/ci/gates.mjs']) assert.ok(RULE_PATHS.includes(p), p);
  assert.deepEqual(RULE_PATHS, [...LINT_PATHS, ...GATE_PATHS]);
});

test('project-state#3326: ruleChanges lists main after the moment, per rule path, and reads each commit', async () => {
  const asked = [];
  const get = async (p) => {
    asked.push(p);
    return p.includes('path=tooling%2Flint&')
      ? [{ sha: 'b'.repeat(40), commit: { committer: { date: '2026-11-18T15:31:21Z' }, message: 'a rule (#8916)\n\nbody' } }]
      : [];
  };
  const out = await ruleChanges(get, 'o/r', '2026-11-18T15:04:39.000Z', '2026-11-18T15:43:23Z');
  assert.equal(asked.length, RULE_PATHS.length);
  assert.ok(
    asked.every(
      (p) => p.startsWith('/repos/o/r/commits?sha=main&') && p.includes('since=2026-11-18T15:04:39.000Z') && p.includes('until='),
    ),
  );
  assert.deepEqual(out, [{ path: 'tooling/lint/', sha: 'b'.repeat(40), date: '2026-11-18T15:31:21Z', title: 'a rule (#8916)' }]);
});

test('a test shard that ran red fails the seal even when this head asks for no tests (the run judged main merged in)', () => {
  const jobs = [...green([]), job(10, 'Tests (changed)', 'failure')];
  assert.equal(judgeCiJobs({ run: run(1), jobs, files: ['docs/a.md'] }).ok, false);
  assert.equal(judgeCiJobs({ run: run(1), jobs: [...green([]), job(10, 'Tests (changed)', 'skipped')], files: ['docs/a.md'] }).ok, true);
});

test('jobResults: a failed shard beside skipped ones reads as failure', () => {
  const jobs = [job(10, 'Tests (1/16)', 'skipped'), job(11, 'Tests (2/16)', 'failure'), job(12, 'Tests (3/16)')];
  assert.equal(jobResults(jobs)['tests-full'], 'failure');
  assert.equal(jobResults([job(10, 'Tests (1/16)', 'skipped'), job(12, 'Tests (3/16)')])['tests-full'], 'skipped');
});

// #9920 merged on 22 Nov 2026 with its Look gate red: the required seal never asked for the Look job (classify() never
// set `look`) and never read it (jobResults had no `look`, and its jobs are named `Look / …` by look-pr.yml).
const PR_9920 = JSON.parse(readFileSync(new URL('./fixtures/ci-jobs-seal-9920.json', import.meta.url), 'utf8'));
const lookGreen = (jobs) =>
  jobs.map((j) => (j.name.startsWith('Look / ') ? { ...j, conclusion: 'success' } : j)).filter((j) => j.name !== 'CI jobs');

test('#9920: the real run with two red Look gate shards fails the seal and names the Look gate', () => {
  const v = judgeCiJobs({ run: PR_9920.run, jobs: PR_9920.jobs, files: PR_9920.files });
  assert.equal(v.ok, false, v.lines.join('\n'));
  assert.equal(v.wait, false);
  assert.ok(
    v.lines.some((l) => /look was failure \(the change draws a Customer room\)/.test(l)),
    v.lines.join('\n'),
  );
});

test('#9920 known good: the same run with the Look gate green passes', () => {
  const v = judgeCiJobs({ run: PR_9920.run, jobs: lookGreen(PR_9920.jobs), files: PR_9920.files });
  assert.equal(v.ok, true, v.lines.join('\n'));
});

test('#9920: a change that draws a Customer room needs the Look job: missing or skipped fails, a merge queue needs none', () => {
  const noLook = lookGreen(PR_9920.jobs).filter((j) => !j.name.startsWith('Look'));
  for (const jobs of [noLook, [...noLook, job(99, 'Look', 'skipped')]]) {
    const v = judgeCiJobs({ run: PR_9920.run, jobs, files: PR_9920.files });
    assert.equal(v.ok, false);
    assert.ok(
      v.lines.some((l) => /look was (missing|skipped)/.test(l)),
      v.lines.join('\n'),
    );
  }
  // Unreadable files (null) draw a room as far as the seal can tell.
  assert.ok(judgeCiJobs({ run: PR_9920.run, jobs: noLook, files: null }).lines.some((l) => /look was missing/.test(l)));
  // A merge queue's commit: ci.yml runs no Look job there (its look gate is main's daily one).
  const queue = judgeCiJobs({ run: PR_9920.run, jobs: [...noLook, ...fullShards()], files: [], forceFull: true });
  assert.ok(!queue.lines.some((l) => /look/.test(l)), queue.lines.join('\n'));
});

test('#9920: a red Look job fails even when this head draws no room; a skipped one beside no room passes', () => {
  const red = [...green(), job(50, 'Look / Build (after)'), job(51, 'Look / Look gate on the rooms it changes (1/3)', 'failure')];
  assert.equal(judgeCiJobs({ run: run(1), jobs: red, files: product }).ok, false);
  assert.equal(judgeCiJobs({ run: run(1), jobs: [...green(), job(50, 'Look', 'skipped')], files: product }).ok, true);
});

test('jobResults: the Look job and its reusable workflow jobs (`Look / …`) read as one result; a red one outranks the rest', () => {
  assert.equal(jobResults(PR_9920.jobs).look, 'failure');
  assert.equal(jobResults(lookGreen(PR_9920.jobs)).look, 'success');
  assert.equal(jobResults([job(1, 'Look', 'skipped')]).look, 'skipped');
  assert.equal(jobResults(green()).look, undefined);
  assert.equal(jobResults([job(1, 'Lookout')]).look, undefined);
});

test('any other job of the run that ran red fails the seal, whatever sealNeeded knows of it; the seal jobs themselves do not', () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']) {
    const v = judgeCiJobs({ run: run(1), jobs: [...green(), job(40, 'Fast gates', conclusion)], files: product });
    assert.equal(v.ok, false, conclusion);
    assert.ok(
      v.lines.some((l) => l.includes(`Fast gates was ${conclusion}`)),
      v.lines.join('\n'),
    );
    assert.equal(judgeCiJobs({ run: run(1), jobs: [...green(), job(40, 'A job added later', conclusion)], files: product }).ok, false);
  }
  for (const conclusion of ['success', 'skipped', 'neutral'])
    assert.equal(judgeCiJobs({ run: run(1), jobs: [...green(), job(40, 'Fast gates', conclusion)], files: product }).ok, true, conclusion);
  // ci.yml's own `CI jobs` (the pull request's copy, which a factory pause turns red until its seal is re-run elsewhere)
  // and START_JOB, which starts this seal, are not CI's verdict.
  for (const name of ['CI jobs', 'CI merge seal', 'Start the seal'])
    assert.equal(judgeCiJobs({ run: run(1), jobs: [...green(), job(40, name, 'failure')], files: product }).ok, true, name);
});

function fullShards() {
  return Array.from({ length: SHARD_COUNT }, (_, i) => job(200 + i, `Tests (${i + 1}/${SHARD_COUNT})`));
}
