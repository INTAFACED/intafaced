// A change to the judges alone (judge-repair.mjs): it passes only on every other check green and the CI review's PASS
// with no FAIL standing, and only for the judges' own files; every planted fault below passes nothing. tooling-tests.mjs runs this file.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FRESH_MS, JUDGE_FILES, REPAIR_STEP, judge, judgeOnly, main, reviewJobOf, standingFail } from './judge-repair.mjs';
import { REPAIR_STEP as SEAL_REPAIR_STEP, recheckStep } from './journey-seal.mjs';

const SHA = 'a'.repeat(40);
const run = (id, path, conclusion = 'success', extra = {}) => ({
  id,
  path: `.github/workflows/${path}`,
  event: path === 'ci-review.yml' || path === 'merge-seal.yml' ? 'pull_request_target' : 'pull_request',
  head_sha: SHA,
  pull_requests: [{ number: 5, base: { ref: 'main' } }],
  status: conclusion ? 'completed' : 'in_progress',
  conclusion,
  ...extra,
});
const green = () => [
  run(1, 'ci.yml'),
  run(2, 'pr-checks.yml'),
  run(3, 'real-app-journeys.yml'),
  run(4, 'ci-review.yml'),
  run(5, 'merge-seal.yml', null),
];
const reviewJob = (verdict, { test = 'skipped', conclusion = 'success', status = 'completed', down = 'skipped' } = {}) => ({
  id: 77,
  name: 'CI review',
  status,
  conclusion: status === 'completed' ? conclusion : null,
  steps: [
    { name: 'Review', conclusion: 'success' },
    { name: 'Verdict', conclusion: verdict },
    { name: 'Test verdict', conclusion: test },
    { name: 'Judge down', conclusion: down },
  ],
});
const PASS = reviewJob('success');
const DOWN = reviewJob('skipped', { test: 'skipped', down: 'success' });
// No verdict: a cancelled job, or one failing before it judged.
const CANCELLED = reviewJob(null, { test: null, conclusion: 'cancelled' });
const BROKE = reviewJob('skipped', { conclusion: 'failure' });
const files = (...names) => names.map((filename) => ({ filename }));

test('only the judges’ own files make a change the judges’ alone', () => {
  assert.deepEqual(judgeOnly(files('tooling/ci/journey-seal.mjs', '.github/workflows/merge-seal.yml')), { judge: true });
  assert.deepEqual(judgeOnly(files('tooling/ci/ci-review.mjs', 'tooling/ci/step-read.mjs')), { judge: true });
  // planted: one other file, a rename from one, a brief, nothing at all, or an unreadable entry
  for (const f of [
    files('tooling/ci/ci-review.mjs', 'apps/customer/src/app.tsx'),
    [{ filename: 'tooling/ci/ci-review.mjs', previous_filename: 'tooling/ci/journey-verdict.mjs' }],
    files('tooling/ci/ci-review/REVIEW.md'),
    files('tooling/ci/test-judge/JUDGE.md'),
    files('AGENTS.md'),
    files('.github/workflows/ci.yml'),
    [],
    undefined,
    [{ filename: null }],
  ])
    assert.equal(judgeOnly(f).judge, false, JSON.stringify(f));
});

test('every listed judge file exists, and no brief is listed', () => {
  for (const f of JUDGE_FILES) assert.ok(existsSync(f), f);
  assert.equal(new Set(JUDGE_FILES).size, JUDGE_FILES.length);
  assert.ok(!JUDGE_FILES.some((f) => f.endsWith('.md')));
  assert.ok(JUDGE_FILES.includes('tooling/ci/judge-repair.mjs'));
});

test('passes: every other check green and the review’s PASS', () => {
  assert.equal(judge({ sha: SHA, runs: green(), reviewJob: PASS, factory: 'run\n' }).act, 'pass');
});

test('refuses: no PASS, as the judge down, a cancelled review or one failing before it judged (#10746 reviews)', () => {
  for (const j of [DOWN, CANCELLED, BROKE, reviewJob('success', { conclusion: 'failure' })]) {
    const v = judge({ sha: SHA, runs: green(), reviewJob: j, factory: 'run' });
    assert.equal(v.act, 'refuse', JSON.stringify(j));
    assert.match(v.why, /needs the CI review's PASS/);
  }
});

test('refuses: a FAIL from the CI review, whatever files changed', () => {
  for (const j of [reviewJob('failure', { conclusion: 'failure' }), reviewJob('success', { test: 'failure', conclusion: 'failure' })]) {
    const v = judge({ sha: SHA, runs: green(), reviewJob: j, factory: 'run' });
    assert.equal(v.act, 'refuse');
    assert.match(v.why, /FAILed this code/);
  }
});

test('refuses: any other check red on the head', () => {
  for (const [i, c] of [
    [0, 'failure'],
    [1, 'cancelled'],
    [2, 'timed_out'],
    [0, 'action_required'],
    [2, 'startup_failure'],
  ]) {
    const runs = green();
    runs[i] = { ...runs[i], conclusion: c };
    const v = judge({ sha: SHA, runs, reviewJob: PASS, factory: 'run' });
    assert.equal(v.act, 'refuse', c);
    assert.match(v.why, new RegExp(`ended ${c}`));
  }
});

test('waits: CI not yet run, a check still going, or the review job not finished', () => {
  assert.equal(judge({ sha: SHA, runs: green().slice(1), reviewJob: PASS, factory: 'run' }).act, 'wait');
  const runs = green();
  runs[2] = { ...runs[2], status: 'queued', conclusion: null };
  assert.equal(judge({ sha: SHA, runs, reviewJob: PASS, factory: 'run' }).act, 'wait');
  assert.equal(judge({ sha: SHA, runs: green(), reviewJob: null, factory: 'run' }).act, 'wait');
  assert.equal(judge({ sha: SHA, runs: green(), reviewJob: reviewJob(null, { status: 'in_progress' }), factory: 'run' }).act, 'wait');
});

test("the newest run of each workflow decides; another head's runs, push runs and the seal's own run count for nothing", () => {
  const fixed = [...green(), run(0, 'ci.yml', 'failure')];
  assert.equal(judge({ sha: SHA, runs: fixed, reviewJob: PASS, factory: 'run' }).act, 'pass');
  const broke = [...green(), run(9, 'ci.yml', 'failure')];
  assert.equal(judge({ sha: SHA, runs: broke, reviewJob: PASS, factory: 'run' }).act, 'refuse');
  const others = [
    ...green(),
    run(10, 'look-pr.yml', 'failure', { head_sha: 'b'.repeat(40) }),
    run(11, 'pr-checks.yml', 'failure', { event: 'push' }),
  ];
  assert.equal(judge({ sha: SHA, runs: others, reviewJob: PASS, factory: 'run' }).act, 'pass');
  const sealRed = [...green(), run(12, 'merge-seal.yml', 'failure')];
  assert.equal(judge({ sha: SHA, runs: sealRed, reviewJob: PASS, factory: 'run' }).act, 'pass');
});

test('refuses: the factory switch not saying run', () => {
  for (const f of ['pause', '', undefined, 'running'])
    assert.equal(judge({ sha: SHA, runs: green(), reviewJob: PASS, factory: f }).act, 'refuse', String(f));
});

test('reviewJobOf passes over a run whose review job was skipped (an edit)', () => {
  assert.equal(reviewJobOf([{ name: 'CI review', status: 'completed', conclusion: 'skipped' }]), null);
  assert.equal(reviewJobOf([{ name: 'Proof read' }, PASS]), PASS);
});

test('standingFail: a FAIL in any attempt of any run stands, the retired Test judge job’s too; a pass or a skip is none', () => {
  const r = { id: 4, head_sha: SHA };
  assert.equal(standingFail([{ run: r, attempts: [[PASS], [DOWN]] }]), null);
  assert.match(standingFail([{ run: r, attempts: [[reviewJob('failure')], [PASS]] }]), /run 4 attempt 1 .*CI review Verdict failed/);
  assert.match(standingFail([{ run: r, attempts: [[DOWN], [reviewJob('success', { test: 'failure' })]] }]), /attempt 2 .*Test verdict/);
  const judgeJob = { name: 'Test judge', steps: [{ name: 'Verdict', conclusion: 'failure' }] };
  assert.match(standingFail([{ run: r, attempts: [[judgeJob]] }]), /Test judge Verdict failed/);
  // a failed step of another name is no FAIL (the review failing before it judged)
  assert.equal(standingFail([{ run: r, attempts: [[reviewJob('skipped', { conclusion: 'failure' })]] }]), null);
});

// The script end to end against a stand-in GitHub. `attempts` holds the jobs of each attempt of each CI review run on
// the head (run 4 by default); `others` the review runs on other heads, with their trees; `index` the run ids the
// head's tree index names. The old `jobs?filter=latest` read answers too, with the newest attempt, so a planted case
// below fails on code that reads only that.
const TREE = 'f'.repeat(40);
function github({
  pull = {},
  prFiles = files('tooling/ci/ci-review.mjs'),
  runs = green(),
  attempts = { 4: [[PASS]] },
  others = [],
  index = others.map((o) => o.run.id),
  mergeBase = new Date().toISOString(),
  factory = 'run\n',
  seen = [],
} = {}) {
  const head = () => {
    const list = typeof runs === 'function' ? runs() : runs;
    return list.map((r) => (attempts[r.id] ? { ...r, run_attempt: attempts[r.id].length } : r));
  };
  const byId = new Map(others.map((o) => [o.run.id, o]));
  return async (url, init) => {
    seen.push(url);
    assert.equal(init.headers.authorization, 'Bearer t');
    const path = url.replace('https://api.github.com/', '');
    const body = (() => {
      if (path === 'repos/o/r/pulls/5')
        return { state: 'open', draft: false, base: { ref: 'main' }, head: { sha: SHA, repo: { full_name: 'o/r' } }, ...pull };
      if (path.startsWith('repos/o/r/pulls/5/files')) return prFiles;
      if (path.startsWith(`repos/o/r/actions/runs?head_sha=${SHA}`)) return { workflow_runs: head() };
      let m = path.match(/^repos\/o\/r\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?per_page=30&page=1$/);
      if (m) {
        const all = attempts[m[1]] ?? byId.get(Number(m[1]))?.attempts;
        return all?.[m[2] - 1] && { jobs: all[m[2] - 1] };
      }
      m = path.match(/^repos\/o\/r\/actions\/runs\/(\d+)\/jobs\?filter=latest&per_page=30&page=1$/);
      if (m) return attempts[m[1]] && { jobs: attempts[m[1]].at(-1) };
      m = path.match(/^repos\/o\/r\/actions\/runs\/(\d+)$/);
      if (m) {
        const o = byId.get(Number(m[1]));
        return o && { ...o.run, run_attempt: o.attempts.length };
      }
      if (path === `repos/o/r/git/commits/${SHA}`) return { tree: { sha: TREE } };
      if (path.startsWith(`repos/o/r/compare/main...${SHA}`)) return { merge_base_commit: { commit: { committer: { date: mergeBase } } } };
      if (path.startsWith(`repos/o/r/actions/artifacts?name=ci-review-tree-${TREE}&`))
        return { artifacts: index.map((id) => ({ name: `ci-review-tree-${TREE}`, workflow_run: { id } })) };
      if (path === 'repos/o/r/contents/FACTORY?ref=factory-switch') return factory;
      return undefined;
    })();
    if (body === undefined) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => body, text: async () => body };
  };
}
const envFor = () => {
  const out = join(mkdtempSync(join(tmpdir(), 'judge-repair-')), 'out');
  return { env: { GH_TOKEN: 't', REPO: 'o/r', HEAD_SHA: SHA, PR_NUMBER: '5', GITHUB_OUTPUT: out, POLL_MS: '0', WAIT_POLLS: '3' }, out };
};
const output = (out) => (existsSync(out) ? readFileSync(out, 'utf8') : '');

test('main: a passing change writes pass=true; every planted fault writes nothing', async () => {
  const log = () => {};
  {
    const { env, out } = envFor();
    assert.equal((await main({ env, log, fetchImpl: github() })).act, 'pass');
    assert.equal(output(out), 'pass=true\n');
  }
  for (const [what, gh] of [
    ['another file', github({ prFiles: files('tooling/ci/ci-review.mjs', 'package.json') })],
    ['a draft', github({ pull: { draft: true } })],
    ['the head moved', github({ pull: { head: { sha: 'c'.repeat(40), repo: { full_name: 'o/r' } } } })],
    ['a fork', github({ pull: { head: { sha: SHA, repo: { full_name: 'fork/r' } } } })],
    ['not into main', github({ pull: { base: { ref: 'side' } } })],
    ['CI red', github({ runs: [...green(), run(9, 'ci.yml', 'failure')] })],
    ['a review FAIL', github({ attempts: { 4: [[reviewJob('failure', { conclusion: 'failure' })]] } })],
    ['the review cancelled', github({ attempts: { 4: [[CANCELLED]] } })],
    [
      'a PASS on a review against another base',
      github({
        runs: [...green().slice(0, 3), run(4, 'ci-review.yml', 'success', { pull_requests: [{ number: 5, base: { ref: 'side' } }] })],
      }),
    ],
    ['the judge down', github({ attempts: { 4: [[DOWN]] } })],
    ['a proof-count file with the judge down', github({ prFiles: files('tooling/ci/step-read.mjs'), attempts: { 4: [[DOWN]] } })],
    ['a pause', github({ factory: 'pause\n' })],
    ['still going after every poll', github({ runs: [...green(), run(9, 'real-app-journeys.yml', null)] })],
  ]) {
    const { env, out } = envFor();
    const v = await main({ env, log, fetchImpl: gh, sleep: async () => {} });
    assert.notEqual(v.act, 'pass', what);
    assert.equal(output(out), '', what);
  }
  // an unreadable answer throws, so the step fails and writes nothing (continue-on-error: the seal's steps judge)
  const { env, out } = envFor();
  await assert.rejects(main({ env, log, fetchImpl: async () => ({ ok: false, status: 500 }) }));
  assert.equal(output(out), '');
});

test('main: waits while a check is going, then judges once it ends', async () => {
  let n = 0;
  const runs = () => (n++ < 2 ? [...green(), run(9, 'real-app-journeys.yml', null)] : [...green(), run(9, 'real-app-journeys.yml')]);
  const { env, out } = envFor();
  let slept = 0;
  const v = await main({ env, log: () => {}, fetchImpl: github({ runs }), sleep: async () => slept++ });
  assert.equal(v.act, 'pass');
  assert.equal(slept, 2);
  assert.equal(output(out), 'pass=true\n');
});

test('merge-seal.yml runs it first in the seal job, never failing the job, and every later step is skipped on its pass', () => {
  const text = readFileSync('.github/workflows/merge-seal.yml', 'utf8');
  const seal = text.slice(text.indexOf('\n  seal:\n'));
  const steps = seal.split('\n      - ').slice(1);
  assert.match(steps[0], /^uses: actions\/checkout@/);
  assert.ok(steps[0].includes('ref: ${{ github.event.repository.default_branch }}'));
  assert.ok(steps[1].startsWith(`name: '${REPAIR_STEP}'`), steps[1].slice(0, 80));
  assert.match(steps[1], /\n {8}id: repair\n {8}continue-on-error: true\n/);
  assert.match(steps[1], /run: node tooling\/ci\/judge-repair\.mjs\n/);
  for (const s of steps.slice(2)) assert.match(s, /\n {8}if: .*steps\.repair\.outputs\.pass != 'true'/, s.slice(0, 80));
});

test('a re-check leaves a seal still in the repair step alone, as one still in the wait step', () => {
  assert.equal(SEAL_REPAIR_STEP, REPAIR_STEP);
  const runs = [{ id: 9, event: 'pull_request_target', status: 'in_progress' }];
  const sealJob = (step) => ({ id: 1, name: 'CI merge seal', status: 'in_progress', steps: [{ name: step, status: 'in_progress' }] });
  assert.equal(recheckStep(runs, new Map([['9', [sealJob(REPAIR_STEP)]]]), 'pull_request_target').act, 'done');
  assert.equal(
    recheckStep(runs, new Map([['9', [sealJob('Require the CI review on this exact head')]]]), 'pull_request_target').act,
    'wait',
  );
});

// The CI review's finding on intafaced#10746 (run 45378887437): a FAIL stands for its code, so none of these asks again.
const FAIL = reviewJob('failure', { conclusion: 'failure' });
const otherHead = (id, attempts, tree = TREE) => ({
  run: { ...run(id, 'ci-review.yml', 'failure'), head_sha: 'd'.repeat(40), head_commit: { tree_id: tree } },
  attempts,
});
test('main: a FAIL in any attempt, any run on the head, or any head with the same tree passes nothing', async () => {
  const log = () => {};
  const passing = [
    ['a PASS on attempt 2 after a PASS', github({ attempts: { 4: [[PASS], [PASS]] } })],
    ['a FAIL on another head with other code', github({ others: [otherHead(40, [[FAIL]], 'e'.repeat(40))] })],
    ['a PASS on another head with the same code', github({ others: [otherHead(40, [[PASS]])] })],
  ];
  for (const [what, gh] of passing) {
    const { env, out } = envFor();
    assert.equal((await main({ env, log, fetchImpl: gh })).act, 'pass', what);
    assert.equal(output(out), 'pass=true\n', what);
  }
  const twoRuns = (older, newer) => ({
    runs: [...green(), run(8, 'ci-review.yml')],
    attempts: { 4: [[older]], 8: [[newer]] },
  });
  for (const [what, gh] of [
    // (a) the review re-run: a FAIL on attempt 1, then the judge down or a PASS on attempt 2
    ['a FAIL, then down on attempt 2', github({ attempts: { 4: [[FAIL], [DOWN]] } })],
    ['a FAIL, then a PASS on attempt 2', github({ attempts: { 4: [[FAIL], [PASS]] } })],
    ['a Test verdict FAIL, then down', github({ attempts: { 4: [[reviewJob('success', { test: 'failure' })], [DOWN]] } })],
    // (b) an empty commit: the same tree on another head FAILed, in any attempt
    ['a FAIL on another head with the same tree', github({ others: [otherHead(40, [[FAIL]])] })],
    ['a FAIL on attempt 1 of another head with the same tree', github({ others: [otherHead(40, [[FAIL], [PASS]])] })],
    // (c) a new run failing before its Verdict, or down, after an older run's FAIL on this head
    ['a new run failing before Verdict', github(twoRuns(FAIL, BROKE))],
    ['a new run down', github(twoRuns(FAIL, DOWN))],
    ['a new run passing', github(twoRuns(FAIL, PASS))],
    ['a head too old for the tree index', github({ mergeBase: new Date(Date.now() - FRESH_MS - 60_000).toISOString() })],
  ]) {
    const { env, out } = envFor();
    const v = await main({ env, log, fetchImpl: gh, sleep: async () => {} });
    assert.equal(v.act, 'refuse', what);
    assert.equal(output(out), '', what);
  }
  // a run the index names that can't be read fails closed
  const { env, out } = envFor();
  await assert.rejects(main({ env, log, fetchImpl: github({ index: [41] }) }));
  assert.equal(output(out), '');
});
