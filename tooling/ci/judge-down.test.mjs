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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JUDGE_CHECK, JUDGE_DOWN_STEP, REVIEW_CHECK, REVIEW_WORKFLOW, ciReviewVerdict, isJudgeDown, reviewJob } from './review-marker.mjs';
import { inputsGoing, readGoing, sealNow, CI_JOBS_NAME } from './journey-seal.mjs';
import { CATCH_UP_CAP, catchUpTargets, describe, issueBody } from './judge-down.mjs';

const WF = readFileSync(new URL('../../.github/workflows/ci-review.yml', import.meta.url), 'utf8');
const REVIEW = WF.slice(WF.indexOf('\n  review:\n'), WF.indexOf('\n  # The proof read, a check'));
const HEAD = 'a'.repeat(40);
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

/** The Review step's `failed` function, run by bash as the step runs it, on one planted answer file. */
function replayFailedCall(answer, code = 1) {
  const step = stepOf('Review');
  const fn = /\n( {10}failed\(\) \{\n[\s\S]*?\n {10}\}\n)/.exec(step)?.[1];
  assert.ok(fn, "the Review step's failed() function");
  const d = mkdtempSync(join(tmpdir(), 'judge-down-'));
  const file = join(d, 'answer.json');
  const out = join(d, 'out');
  writeFileSync(file, JSON.stringify(answer));
  writeFileSync(out, '');
  const r = spawnSync('bash', ['-e', '-c', `${fn}\nfalse || failed "$ANSWER" "${code}"\necho reached-the-read`], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_WORKSPACE: new URL('../..', import.meta.url).pathname, GITHUB_OUTPUT: out, ANSWER: file },
  });
  const outputs = Object.fromEntries(
    readFileSync(out, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { status: r.status, stdout: r.stdout, outputs };
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

test('replay: a planted bad key ends the Review step without failing and without a verdict, and the seal never reads a pass', async () => {
  for (const answer of [BAD_KEY, WEEKLY]) {
    const r = replayFailedCall(answer);
    assert.equal(r.status, 0, 'the step ends without failing');
    assert.doesNotMatch(r.stdout, /reached-the-read/, 'the answer is never read as a verdict');
    assert.match(r.stdout, /^::warning::judge down/m);
    assert.equal(r.outputs.kind, 'down');
    const job = jobAfter(r.outputs);
    assert.equal(isJudgeDown(job), true);
    for (const check of [REVIEW_CHECK, JUDGE_CHECK]) {
      const v = await seal(job, check);
      assert.equal(v.ok, false, `${check.label}: down is never a pass`);
      assert.equal(v.state, 'none');
      assert.match(v.why, /the judge was down/);
    }
  }
  assert.equal(replayFailedCall(BAD_KEY).outputs.sign_in, 'true');
  assert.match(replayFailedCall(WEEKLY).outputs.action, /^wait for the reset at Nov 14, 18:00 Bali time/);
});

test('replay: a malformed answer still fails the step, as before', () => {
  const r = replayFailedCall(MALFORMED, 1);
  assert.equal(r.status, 1);
  assert.equal(r.outputs.kind, 'error');
  assert.match(r.stdout, /^::error::/m);
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

test("readGoing reads the newest review run's job only for a change that needs the review, and finds the judge down", async () => {
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
  asked.length = 0;
  const plain = await readGoing({ get: fake(['docs/x.md']), repo: 'o/r', sha: HEAD, pulls });
  assert.deepEqual(plain, []);
  assert.ok(!asked.some((p) => p.includes('/jobs')), 'no job read for a change that needs no review');
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
