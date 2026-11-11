// The judge-down rule (project-state OWNER 289 point 11: "A judge that stops shows as 'judge down', with the one action
// it needs, never as red PRs. No PR merges without its judge."), end to end offline: a planted bad key's answer goes
// through the Review step's own shell (read from ci-review.yml), the job it leaves is built the way GitHub reports it,
// and the seal's verdict reader and its wait read that job. Down never passes and the seal waits; a real FAIL still
// blocks; a real PASS still passes.
//
//   node --test tooling/ci/judge-down.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JUDGE_CHECK,
  JUDGE_DOWN_STEP,
  REVIEW_CHECK,
  REVIEW_WORKFLOW,
  ciReviewVerdict,
  isJudgeDown,
  judgeDownNeed,
  missingTitle,
  reviewJob,
} from './review-marker.mjs';
import { inputsGoing, readGoing, sealNow, CI_JOBS_NAME } from './journey-seal.mjs';
import { CATCH_UP_CAP, KEY_ISSUE_TITLE, KEY_LABEL, LABEL, catchUpTargets, describe, issueBody, keyIssueBody } from './judge-down.mjs';

const WF = readFileSync(new URL('../../.github/workflows/ci-review.yml', import.meta.url), 'utf8');
const REVIEW = WF.slice(WF.indexOf('\n  review:\n'), WF.indexOf('\n  # The proof read, a check'));
const HEAD = 'a'.repeat(40);
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const stepOf = (name, text = REVIEW) => {
  const at = text.indexOf(`- name: ${name}\n`);
  assert.ok(at > 0, `step ${name}`);
  const next = text.indexOf('\n      - ', at + 1);
  return text.slice(at, next === -1 ? undefined : next);
};

// The answers a planted bad key and a used-up account get from the reviewer CLI (the 429 is the real one of 10 Nov).
const BAD_KEY = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: 401,
  result:
    'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}',
};
const WEEKLY = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: 429,
  result: "You've hit your weekly limit · resets Nov 14, 10am (UTC)",
};
const MALFORMED = { type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, result: 'no structured output' };

/**
 * The Review step's whole `run:` block (a YAML literal block: the lines indented past `run: |`, de-indented), exactly
 * the script GitHub hands its default shell.
 */
function reviewScript(text = REVIEW) {
  const step = stepOf('Review', text);
  const lines = step.slice(step.indexOf('        run: |\n') + '        run: |\n'.length).split('\n');
  const body = [];
  for (const l of lines) {
    if (l.trim() && !l.startsWith(' '.repeat(10))) break;
    body.push(l.slice(10));
  }
  return `${body.join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * The Review step run as GitHub runs it (`bash --noprofile --norc -eo pipefail`), with a stub reviewer CLI on its path
 * that prints `answer`, writes `err` to stderr and exits `code`; then the Verdict step's own command when its `if:`
 * holds. Returns the step's exit, its log, its outputs, and the review folder.
 */
function replayReview(answer, code = 1, err = '') {
  const t = mkdtempSync(join(tmpdir(), 'judge-down-'));
  const dir = join(t, 'review');
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'schema.json'), '{}');
  writeFileSync(join(dir, 'prompt.txt'), 'x');
  writeFileSync(join(dir, 'head.txt'), HEAD);
  writeFileSync(join(dir, 'tests', 'verdict.json'), JSON.stringify({ head: HEAD, verdict: 'PASS', lines: [], findings: [] }));
  // The stub sits where the step calls the pinned reviewer CLI, under the name the step itself uses.
  const cli = /\$RUNNER_TEMP\/reviewer\/node_modules\/\.bin\/([\w-]+)/.exec(reviewScript())?.[1];
  assert.ok(cli, "the Review step's reviewer CLI path");
  const bin = join(t, 'reviewer/node_modules/.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(t, 'answer'), typeof answer === 'string' ? answer : JSON.stringify(answer));
  writeFileSync(join(t, 'err'), err);
  writeFileSync(join(bin, cli), `#!/bin/bash\ncat > /dev/null\ncat "${t}/answer"\ncat "${t}/err" >&2\nexit ${code}\n`);
  chmodSync(join(bin, cli), 0o755);
  const out = join(t, 'out');
  writeFileSync(out, '');
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', reviewScript()], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, RUNNER_TEMP: t, GITHUB_WORKSPACE: ROOT, GITHUB_OUTPUT: out, CLAUDE_CODE_OAUTH_TOKEN: 'planted-bad-key' },
  });
  const outputs = Object.fromEntries(
    readFileSync(out, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  // The Verdict step: `if: steps.review.outputs.kind != 'down'` with GitHub's implicit success().
  let verdict = 'skipped';
  if (r.status === 0 && outputs.kind !== 'down')
    verdict =
      spawnSync('node', [join(ROOT, 'tooling/ci/ci-review.mjs'), 'judge', dir], { encoding: 'utf8' }).status === 0 ? 'success' : 'failure';
  return { status: r.status, stdout: `${r.stdout}${r.stderr}`, outputs, verdict };
}

/**
 * The CI review job as GitHub's jobs API reports it after the Review step left `outputs`, following the workflow's own
 * `if:`s: on down the verdict steps and the seal re-run are skipped and Judge down runs; the job concludes success.
 */
function jobAfter(outputs, verdict = 'success') {
  const down = outputs.kind === 'down';
  const steps = [
    { name: 'Review', status: 'completed', conclusion: 'success' },
    { name: 'Verdict', status: 'completed', conclusion: down ? 'skipped' : verdict },
    { name: 'Test verdict', status: 'completed', conclusion: down ? 'skipped' : 'success' },
    { name: 'Re-run a red seal on this head', status: 'completed', conclusion: down ? 'skipped' : 'success' },
    { name: JUDGE_DOWN_STEP, status: 'completed', conclusion: down ? 'success' : 'skipped' },
  ];
  const failed = steps.some((s) => s.conclusion === 'failure');
  return { name: 'CI review', head_sha: HEAD, status: 'completed', conclusion: failed ? 'failure' : 'success', steps };
}

const run = (jobs, id = 1) => ({
  id,
  path: REVIEW_WORKFLOW,
  event: 'pull_request_target',
  head_sha: HEAD,
  status: 'completed',
  pull_requests: [{ number: 7, base: { ref: 'main' } }],
  jobs: [jobs],
});
const seal = (job, check = REVIEW_CHECK) =>
  ciReviewVerdict({ sha: HEAD, base: 'main', number: 7, runs: [run([job])], attempts: async (r) => r.jobs, check });

test('the workflow: on down the verdict steps are skipped, Judge down is the marker, and the job the seal reads holds no statuses permission', () => {
  assert.match(stepOf('Verdict'), /\n {8}if: steps\.review\.outputs\.kind != 'down'\n/);
  assert.match(
    stepOf('Test verdict'),
    /\n {8}if: \$\{\{ !cancelled\(\) && steps\.review\.outcome == 'success' && steps\.review\.outputs\.kind != 'down' \}\}\n/,
  );
  const marker = stepOf(JUDGE_DOWN_STEP);
  assert.match(marker, /\n {8}if: \$\{\{ !cancelled\(\) && steps\.review\.outputs\.kind == 'down' \}\}\n/);
  assert.match(marker, /\n {8}continue-on-error: true\n/);
  assert.ok(WF.indexOf(`- name: ${JUDGE_DOWN_STEP}\n`) > WF.indexOf('- name: Verdict\n'), 'the marker comes after the verdicts');
  assert.doesNotMatch(REVIEW, /statuses: write/);
  // The step's own failure exits 0 (judge-down.mjs), so the marker can't turn into a failed step.
  const js = readFileSync(new URL('./judge-down.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(js.slice(js.indexOf('if (process.argv[1]')), /run\(source\)[\s\S]*process\.exit\(1\)/);
});

const ok = (verdict) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  structured_output: { verdict, findings: verdict === 'FAIL' ? ['blocking: x'] : [] },
});
const TOO_LONG = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: 400,
  result:
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}',
};

test('replay, the whole Review step: a planted 401 and the real 429 end it without failing and without a verdict, and the seal never reads a pass', async () => {
  for (const answer of [BAD_KEY, WEEKLY]) {
    const r = replayReview(answer);
    assert.equal(r.status, 0, 'the step ends without failing');
    assert.match(r.stdout, /^::warning::judge down/m);
    assert.doesNotMatch(r.stdout, /verdict: review/, 'the answer is never read as a verdict');
    assert.equal(r.outputs.kind, 'down');
    assert.equal(r.outputs.called, undefined, 'a down call is not a call that answered');
    assert.equal(r.verdict, 'skipped');
    const job = jobAfter(r.outputs);
    assert.equal(isJudgeDown(job), true);
    for (const check of [REVIEW_CHECK, JUDGE_CHECK]) {
      const v = await seal(job, check);
      assert.equal(v.ok, false, `${check.label}: down is never a pass`);
      assert.equal(v.state, 'none');
      assert.match(v.why, /the judge was down/);
    }
  }
  assert.equal(replayReview(BAD_KEY).outputs.sign_in, 'true');
  assert.match(replayReview(WEEKLY).outputs.action, /^wait for the reset at Nov 14, 18:00 Bali time/);
});

test('replay, the whole Review step: a real PASS passes and a real FAIL blocks', async () => {
  for (const [verdict, state, conclusion] of [
    ['PASS', 'pass', 'success'],
    ['FAIL', 'fail', 'failure'],
  ]) {
    const r = replayReview(ok(verdict), 0);
    assert.equal(r.status, 0, verdict);
    assert.equal(r.outputs.called, 'true');
    assert.equal(r.outputs.kind, undefined);
    assert.equal(r.verdict, conclusion);
    assert.equal((await seal(jobAfter(r.outputs, r.verdict))).state, state);
  }
});

test('replay, the whole Review step: a 400, a malformed answer, and a crash with no answer still fail it, as before', () => {
  for (const [answer, err] of [
    [TOO_LONG, ''],
    [MALFORMED, ''],
    ['', ''],
    ['', 'TypeError: Cannot read properties of undefined (reading "map")\n'],
  ]) {
    const r = replayReview(answer, 1, err);
    assert.equal(r.status, 1, JSON.stringify(answer).slice(0, 60));
    assert.equal(r.outputs.kind, 'error');
    assert.match(r.stdout, /^::error::/m);
    assert.equal(r.verdict, 'skipped');
  }
  // No answer with an outage on stderr is down, and stderr is printed only as its error line, keys masked.
  const r = replayReview('', 1, `noise\nError: getaddrinfo ENOTFOUND api.example.com sk-ant-oat01-${'Z'.repeat(30)}\n`);
  assert.equal(r.status, 0);
  assert.equal(r.outputs.kind, 'down');
  assert.doesNotMatch(r.stdout, /noise|Z{30}/);
  assert.match(r.stdout, /stderr: Error: getaddrinfo ENOTFOUND api\.example\.com sk-ant-\*\*\*/);
});

test("no shape of a down job reads as a pass: a failed marker, a missing marker, or verdict steps that didn't run", async () => {
  const down = jobAfter({ kind: 'down' });
  const markerFailed = {
    ...down,
    conclusion: 'failure',
    steps: down.steps.map((s) => (s.name === JUDGE_DOWN_STEP ? { ...s, conclusion: 'failure' } : s)),
  };
  const noMarker = { ...down, steps: down.steps.filter((s) => s.name !== JUDGE_DOWN_STEP) };
  const noVerdicts = { ...down, steps: down.steps.filter((s) => !['Verdict', 'Test verdict'].includes(s.name)) };
  for (const job of [down, markerFailed, noMarker, noVerdicts])
    for (const check of [REVIEW_CHECK, JUDGE_CHECK]) assert.equal((await seal(job, check)).ok, false, JSON.stringify(job.steps));
  // A marker beside a real verdict is not down: the verdict decides.
  assert.equal(
    isJudgeDown({
      ...jobAfter({}, 'failure'),
      steps: [...jobAfter({}, 'failure').steps.slice(0, 4), { name: JUDGE_DOWN_STEP, conclusion: 'success' }],
    }),
    false,
  );
});

test('a real FAIL still blocks and a real PASS still passes', async () => {
  const fail = await seal(jobAfter({ kind: '' }, 'failure'));
  assert.equal(fail.state, 'fail');
  assert.equal((await seal(reviewJob(HEAD, 'failure'))).state, 'fail');
  assert.equal((await seal(jobAfter({ kind: '' }, 'success'))).state, 'pass');
  assert.equal((await seal(reviewJob(HEAD, 'success'))).state, 'pass');
  // A FAIL on the head stands even when a later run on it went down.
  const runs = [run([reviewJob(HEAD, 'failure')], 1), run([jobAfter({ kind: 'down' })], 2)];
  const v = await ciReviewVerdict({ sha: HEAD, base: 'main', number: 7, runs, attempts: async (r) => r.jobs });
  assert.equal(v.state, 'fail');
});

test('the seal waits on a down judge, as for a review still running, only for a change that needs the review', () => {
  const runsOf = { 'ci-review.yml': [{ id: 9, head_sha: HEAD, event: 'pull_request_target', status: 'completed', judgeDown: true }] };
  const going = inputsGoing({ sha: HEAD, runsOf, needJourneys: false, needJudge: true });
  assert.deepEqual(going, ['the CI review run 9 (judge down: no verdict; it re-runs when the judge is back)']);
  assert.deepEqual(
    inputsGoing({ sha: HEAD, runsOf, needJourneys: false, needJudge: false }),
    [],
    "a change that needs no review doesn't wait",
  );
  const headCi = `jobs:\n  merge-seal:\n    name: ${CI_JOBS_NAME}\n`;
  assert.equal(sealNow({ files: ['tooling/ci/x.mjs'], headCi, going }).now, false, 'the seal is not run, so it is neither green nor red');
  runsOf['ci-review.yml'][0].judgeDown = false;
  assert.deepEqual(inputsGoing({ sha: HEAD, runsOf, needJourneys: false, needJudge: true }), []);
});

test('readGoing finds the judge down for every change, gate file or not: no PR merges without its judge', async () => {
  const asked = [];
  const fake = (files) => async (p) => {
    asked.push(p);
    if (p.includes('/actions/workflows/ci-review.yml/runs'))
      return {
        workflow_runs: [
          { id: 8, head_sha: HEAD, event: 'pull_request_target', status: 'completed' },
          { id: 9, head_sha: HEAD, event: 'pull_request_target', status: 'completed' },
        ],
      };
    if (p.includes('/actions/workflows/')) return { workflow_runs: [] };
    if (p.includes('/pulls/7/files')) return files.map((filename) => ({ filename, status: 'modified' }));
    if (p.endsWith('/actions/runs/9/jobs?filter=latest&per_page=100')) return { jobs: [jobAfter({ kind: 'down' })] };
    throw new Error(`unexpected ${p}`);
  };
  const pulls = [{ number: 7, title: 'ci: x' }];
  const gate = await readGoing({ get: fake(['.github/workflows/ci-review.yml']), repo: 'o/r', sha: HEAD, pulls });
  assert.deepEqual(gate, ['the CI review run 9 (judge down: no verdict; it re-runs when the judge is back)']);
  const plain = await readGoing({ get: fake(['docs/x.md']), repo: 'o/r', sha: HEAD, pulls });
  assert.deepEqual(plain, gate, 'a change that needs no verdict still waits on a down judge (CI review on 0cef53f9b, item 3)');
});

test('judgeDownNeed: a head whose CI review was down needs the judge, whatever it changes; a pass, a FAIL, a review never run do not', () => {
  const need = judgeDownNeed({
    ok: false,
    state: 'none',
    why: 'the judge was down in run 9 attempt 1, so abc has no CI review verdict yet',
  });
  assert.equal(need?.check, REVIEW_CHECK);
  assert.equal(judgeDownNeed({ ok: true, state: 'pass', why: 'CI review passed on abc' }), null);
  assert.equal(judgeDownNeed({ ok: false, state: 'fail', why: 'CI review FAIL on abc' }), null);
  assert.equal(judgeDownNeed({ ok: false, state: 'none', why: 'no CI review on abc' }), null);
  assert.equal(judgeDownNeed(undefined), null);
});

test('the judge-down issue pages no one: it carries only its own label (CI review on 0cef53f9b, item 5)', () => {
  const js = readFileSync(new URL('./judge-down.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /'nino'/);
});

test('catch-up: the oldest heads with no verdict first, at most the cap, never a running run or this head', async () => {
  const repo = 'o/r';
  const sha = (i) => String(i).padStart(40, '0');
  const pulls = Array.from({ length: 14 }, (_, i) => ({
    number: 100 + i,
    state: 'open',
    base: { ref: 'main' },
    head: { sha: sha(i), repo: { full_name: repo } },
  }));
  pulls.push({ number: 200, state: 'open', base: { ref: 'main' }, head: { sha: sha(99), repo: { full_name: 'fork/r' } } });
  const runs = pulls.map((p, i) => ({
    id: 1000 + i,
    path: REVIEW_WORKFLOW,
    event: 'pull_request_target',
    head_sha: p.head.sha,
    status: i === 2 ? 'in_progress' : 'completed',
    created_at: `2026-11-10T0${9 - (i % 10)}:${String(i).padStart(2, '0')}:00Z`,
  }));
  const withVerdict = new Set([1003]);
  const jobsOf = async (r) => [withVerdict.has(r.id) ? reviewJob(r.head_sha, 'failure') : jobAfter({ kind: 'down' })];
  const { targets, left } = await catchUpTargets({ pulls, runs, jobsOf, repo, skipSha: sha(0) });
  assert.equal(CATCH_UP_CAP, 10);
  assert.equal(targets.length, CATCH_UP_CAP);
  const nums = targets.map((t) => t.pull.number);
  assert.ok(!nums.includes(100), 'not this head');
  assert.ok(!nums.includes(102), 'not a run still going');
  assert.ok(!nums.includes(103), 'not a head with a verdict');
  assert.ok(!nums.includes(200), 'not a fork');
  const created = targets.map((t) => t.run.created_at);
  assert.deepEqual(created, [...created].sort(), 'oldest first');
  assert.equal(left, 14 - 1 - 1 - 1 - CATCH_UP_CAP);
});

test('the status says the one action in 140 characters, and a sign-in issue names the exact link', () => {
  const d = describe('CI review', 'wait for the reset at Nov 14, 18:00 Bali time (Nov 14, 10am UTC)');
  assert.equal(d, 'judge down: CI review. One action: wait for the reset at Nov 14, 18:00 Bali time (Nov 14, 10am UTC)');
  assert.ok(describe('CI review', 'x'.repeat(300)).length <= 140);
  const now = new Date('2026-11-10T04:39:00Z');
  const signIn = issueBody({
    source: 'CI review',
    line: 'the reviewer CLI exited 1; api_error_status=401',
    action: 'sign-in',
    signIn: true,
    signInUrl: 'https://sign-in.example/login',
    runUrl: 'u',
    now,
  });
  assert.match(signIn, /Sign in: https:\/\/sign-in\.example\/login\./);
  assert.match(signIn, /settings\/environments/);
  assert.match(signIn, /12:39 Bali time \(2026-11-10 04:39 UTC\)/);
  assert.match(signIn, /api_error_status=401/);
  assert.doesNotMatch(issueBody({ source: 'CI review', line: 'l', action: 'wait', signIn: false, runUrl: 'u', now }), /Sign in/);
});

// A title or body edit starts a CI review run whose job is skipped by its `if:`, with no steps (head e1d3ad61: run
// 42803694870 skipped, 0 steps; run 42803607208 the real review). It must neither hide a down run nor be re-run for one.
const SKIPPED = { name: 'CI review', head_sha: HEAD, status: 'completed', conclusion: 'skipped', steps: [] };

test('a skipped `edited` run on top of a down run: the seal still waits on the down run', async () => {
  const runs = [
    { id: 10, head_sha: HEAD, event: 'pull_request_target', status: 'completed' },
    { id: 9, head_sha: HEAD, event: 'pull_request_target', status: 'completed' },
  ];
  const jobs = { 9: [jobAfter({ kind: 'down' })], 10: [SKIPPED] };
  const get = async (p) => {
    if (p.includes('/actions/workflows/ci-review.yml/runs')) return { workflow_runs: runs.map((r) => ({ ...r })) };
    if (p.includes('/actions/workflows/')) return { workflow_runs: [] };
    if (p.includes('/pulls/7/files')) return [{ filename: 'AGENTS.md', status: 'modified' }];
    const m = /\/actions\/runs\/(\d+)\/jobs\?filter=latest&per_page=100$/.exec(p);
    if (m) return { jobs: jobs[m[1]] };
    throw new Error(`unexpected ${p}`);
  };
  const pulls = [{ number: 7, title: 'ci: x', body: '' }];
  assert.deepEqual(await readGoing({ get, repo: 'o/r', sha: HEAD, pulls }), [
    'the CI review run 9 (judge down: no verdict; it re-runs when the judge is back)',
  ]);
  // A real review after the down run (the judge back, a verdict) ends the wait, edit run or not.
  jobs[9] = [reviewJob(HEAD, 'success')];
  assert.deepEqual(await readGoing({ get, repo: 'o/r', sha: HEAD, pulls }), []);
});

test('catch-up: a skipped `edited` run on top of a down run re-runs the down run, never the skipped one', async () => {
  const repo = 'o/r';
  const pulls = [{ number: 7, state: 'open', base: { ref: 'main' }, head: { sha: HEAD, repo: { full_name: repo } } }];
  const base = { path: REVIEW_WORKFLOW, event: 'pull_request_target', head_sha: HEAD, status: 'completed' };
  const runs = [
    { ...base, id: 10, created_at: '2026-11-10T06:00:00Z' },
    { ...base, id: 9, created_at: '2026-11-10T05:00:00Z' },
  ];
  const jobs = { 9: [jobAfter({ kind: 'down' })], 10: [SKIPPED] };
  const { targets } = await catchUpTargets({ pulls, runs, repo, skipSha: 'x', jobsOf: async (r) => jobs[r.id] });
  assert.deepEqual(
    targets.map((t) => t.run.id),
    [9],
  );
  // A verdict under the skipped run is a verdict: nothing to re-run.
  jobs[9] = [reviewJob(HEAD, 'failure')];
  assert.deepEqual((await catchUpTargets({ pulls, runs, repo, skipSha: 'x', jobsOf: async (r) => jobs[r.id] })).targets, []);
});

test('a sign-off the seal finds missing because the judge was down is titled judge down, never "Review sign-off missing"', () => {
  assert.match(
    missingTitle('the judge was down in run 42 attempt 1, so abc has no CI review verdict yet; the review re-runs when the judge is back'),
    /^judge down: CI review/,
  );
  assert.equal(missingTitle('no CI review on abc'), 'Review sign-off missing');
  assert.equal(missingTitle(undefined), 'Review sign-off missing');
});

test('the catch-up re-runs are the Start the seal job’s, after the review job closed the issue; the review job re-runs nothing', () => {
  const review = WF.slice(WF.indexOf('\n  review:\n'), WF.indexOf('\n  read:\n'));
  const start = WF.slice(WF.indexOf('\n  seal-start:\n'));
  assert.doesNotMatch(review, /catchup|permission-actions|RERUN_TOKEN/);
  assert.match(review, /judge-closed: \$\{\{ steps\.judge-back\.outputs\.closed \}\}/);
  assert.match(
    start,
    /if: \$\{\{ !cancelled\(\) && needs\.review\.outputs\.judge-closed == 'true' \}\}[\s\S]*judge-down\.mjs back "CI review" catchup/,
  );
  assert.match(start, /actions: write/);
});

test('the second-key issue names the first key\'s error, the time and the one action, and never a key', () => {
  const body = keyIssueBody({
    line: "the reviewer CLI exited 1; api_error_status=429; result: You've hit your weekly limit `x`",
    runUrl: 'https://github.com/r/actions/runs/1',
    now: new Date('2026-11-11T15:28:00Z'),
  });
  assert.match(body, /runs on its second key, `CLAUDE_CODE_OAUTH_TOKEN_2`/);
  assert.match(body, /weekly limit 'x'`/, 'backticks in the line cannot break its code span');
  assert.match(body, /2026-11-11 23:28 Bali time \(2026-11-11 15:28 UTC\), https:\/\/github\.com\/r\/actions\/runs\/1/);
  assert.match(body, /renew the first key before the second runs out too/);
  assert.equal(KEY_ISSUE_TITLE, 'CI review on its second key');
  assert.notEqual(KEY_LABEL, LABEL, 'a second key in use is not the judge down');
});
