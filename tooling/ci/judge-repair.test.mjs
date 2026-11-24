// A change to the judges alone (judge-repair.mjs): it passes only on every other check green and no FAIL from the CI
// review, and only for the judges' own files; every planted fault below passes nothing. tooling-tests.mjs runs this file.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JUDGE_FILES, REPAIR_STEP, REVIEW_FILES, SEAL_FILES, judge, judgeOnly, main, reviewJobOf } from './judge-repair.mjs';
import { REPAIR_STEP as SEAL_REPAIR_STEP, recheckStep } from './journey-seal.mjs';

const SHA = 'a'.repeat(40);
const run = (id, path, conclusion = 'success', extra = {}) => ({
  id,
  path: `.github/workflows/${path}`,
  event: path === 'ci-review.yml' || path === 'merge-seal.yml' ? 'pull_request_target' : 'pull_request',
  head_sha: SHA,
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
const reviewJob = (verdict, { test = 'skipped', conclusion = 'success', status = 'completed' } = {}) => ({
  id: 77,
  name: 'CI review',
  status,
  conclusion: status === 'completed' ? conclusion : null,
  steps: [
    { name: 'Review', conclusion: 'success' },
    { name: 'Verdict', conclusion: verdict },
    { name: 'Test verdict', conclusion: test },
  ],
});
const PASS = reviewJob('success');
const DOWN = reviewJob('skipped');
const files = (...names) => names.map((filename) => ({ filename }));

test('only the judges’ own files make a change the judges’ alone; a review file is told apart', () => {
  assert.deepEqual(judgeOnly(files('tooling/ci/journey-seal.mjs', '.github/workflows/merge-seal.yml')), { judge: true, review: false });
  assert.deepEqual(judgeOnly(files('tooling/ci/ci-review.mjs', 'tooling/ci/journey-seal.mjs')), { judge: true, review: true });
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
  assert.ok(SEAL_FILES.includes('tooling/ci/judge-repair.mjs') && !REVIEW_FILES.includes('tooling/ci/judge-repair.mjs'));
});

test('passes: a change to the review’s code with every other check green, and the review PASSing or giving no verdict', () => {
  assert.equal(judge({ sha: SHA, runs: green(), reviewJob: PASS, review: true, factory: 'run\n' }).act, 'pass');
  const down = judge({ sha: SHA, runs: green(), reviewJob: DOWN, review: true, factory: 'run' });
  assert.equal(down.act, 'pass');
  assert.match(down.why, /no verdict/);
  // the review failing before it judged (no Verdict) is no verdict either
  assert.equal(
    judge({ sha: SHA, runs: green(), reviewJob: reviewJob('skipped', { conclusion: 'failure' }), review: true, factory: 'run' }).act,
    'pass',
  );
});

test('passes: a change to the seal’s files alone only with the review’s PASS', () => {
  assert.equal(judge({ sha: SHA, runs: green(), reviewJob: PASS, review: false, factory: 'run' }).act, 'pass');
  // planted: the review down, or failing before its verdict
  for (const j of [DOWN, reviewJob('skipped', { conclusion: 'failure' }), reviewJob('success', { conclusion: 'failure' })]) {
    const v = judge({ sha: SHA, runs: green(), reviewJob: j, review: false, factory: 'run' });
    assert.equal(v.act, 'refuse');
    assert.match(v.why, /needs the CI review's PASS/);
  }
});

test('refuses: a FAIL from the CI review, whatever files changed', () => {
  for (const review of [true, false]) {
    for (const j of [reviewJob('failure', { conclusion: 'failure' }), reviewJob('success', { test: 'failure', conclusion: 'failure' })]) {
      const v = judge({ sha: SHA, runs: green(), reviewJob: j, review, factory: 'run' });
      assert.equal(v.act, 'refuse');
      assert.match(v.why, /FAILed this head/);
    }
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
    const v = judge({ sha: SHA, runs, reviewJob: PASS, review: true, factory: 'run' });
    assert.equal(v.act, 'refuse', c);
    assert.match(v.why, new RegExp(`ended ${c}`));
  }
});

test('waits: CI not yet run, a check still going, or the review job not finished', () => {
  assert.equal(judge({ sha: SHA, runs: green().slice(1), reviewJob: PASS, review: true, factory: 'run' }).act, 'wait');
  const runs = green();
  runs[2] = { ...runs[2], status: 'queued', conclusion: null };
  assert.equal(judge({ sha: SHA, runs, reviewJob: PASS, review: true, factory: 'run' }).act, 'wait');
  assert.equal(judge({ sha: SHA, runs: green(), reviewJob: null, review: true, factory: 'run' }).act, 'wait');
  assert.equal(
    judge({ sha: SHA, runs: green(), reviewJob: reviewJob(null, { status: 'in_progress' }), review: true, factory: 'run' }).act,
    'wait',
  );
});

test("the newest run of each workflow decides; another head's runs, push runs and the seal's own run count for nothing", () => {
  const fixed = [...green(), run(0, 'ci.yml', 'failure')];
  assert.equal(judge({ sha: SHA, runs: fixed, reviewJob: PASS, review: true, factory: 'run' }).act, 'pass');
  const broke = [...green(), run(9, 'ci.yml', 'failure')];
  assert.equal(judge({ sha: SHA, runs: broke, reviewJob: PASS, review: true, factory: 'run' }).act, 'refuse');
  const others = [
    ...green(),
    run(10, 'look-pr.yml', 'failure', { head_sha: 'b'.repeat(40) }),
    run(11, 'pr-checks.yml', 'failure', { event: 'push' }),
  ];
  assert.equal(judge({ sha: SHA, runs: others, reviewJob: PASS, review: true, factory: 'run' }).act, 'pass');
  const sealRed = [...green(), run(12, 'merge-seal.yml', 'failure')];
  assert.equal(judge({ sha: SHA, runs: sealRed, reviewJob: PASS, review: true, factory: 'run' }).act, 'pass');
});

test('refuses: the factory switch not saying run', () => {
  for (const f of ['pause', '', undefined, 'running'])
    assert.equal(judge({ sha: SHA, runs: green(), reviewJob: PASS, review: true, factory: f }).act, 'refuse', String(f));
});

test('reviewJobOf passes over a run whose review job was skipped (an edit)', () => {
  assert.equal(reviewJobOf([{ name: 'CI review', status: 'completed', conclusion: 'skipped' }]), null);
  assert.equal(reviewJobOf([{ name: 'Proof read' }, PASS]), PASS);
});

// The script end to end against a stand-in GitHub.
function github({
  pull = {},
  prFiles = files('tooling/ci/ci-review.mjs'),
  runs = green(),
  jobs = [PASS],
  factory = 'run\n',
  seen = [],
} = {}) {
  return async (url, init) => {
    seen.push(url);
    assert.equal(init.headers.authorization, 'Bearer t');
    const path = url.replace('https://api.github.com/', '');
    const body = (() => {
      if (path === 'repos/o/r/pulls/5')
        return { state: 'open', draft: false, base: { ref: 'main' }, head: { sha: SHA, repo: { full_name: 'o/r' } }, ...pull };
      if (path.startsWith('repos/o/r/pulls/5/files')) return prFiles;
      if (path.startsWith(`repos/o/r/actions/runs?head_sha=${SHA}`)) return { workflow_runs: typeof runs === 'function' ? runs() : runs };
      if (path.startsWith('repos/o/r/actions/runs/4/jobs?filter=latest&per_page=30&page=1')) return { jobs };
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
    ['a review FAIL', github({ jobs: [reviewJob('failure', { conclusion: 'failure' })] })],
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
