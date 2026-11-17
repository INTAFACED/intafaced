import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REVIEW_MISSING,
  REVIEW_STATUS,
  RERUN_STATUS,
  SEAL,
  annotationLine,
  orphanLines,
  runIdOf,
  staleLines,
  summarize,
} from './why-red.mjs';

const check = (cond, msg) => assert.ok(cond, msg);
const sha = 'a'.repeat(40);
const fail = (message, extra = {}) => ({ annotation_level: 'failure', path: '.github', message, ...extra });
const ok = (id, name) => ({ id, name, status: 'completed', conclusion: 'success' });
const red = (id, name) => ({ id, name, status: 'completed', conclusion: 'failure' });
const review = fail(`No success status "Independent review" on ${sha}.`, { title: REVIEW_MISSING });
const last = (r) => r[r.length - 1];
const base = { sha, annotations: {}, failedSteps: {}, statuses: [] };
// A seal red only because the review of this head is missing.
const onlyReview = {
  ...base,
  checks: [ok(1, 'Format'), red(2, SEAL)],
  annotations: { 2: [review, fail('Process completed with exit code 1.')] },
};
const cancelled = { ...base, checks: [{ ...red(4, 'Tests (1)'), conclusion: 'cancelled' }] };
const job = (id, name, run, status = 'in_progress', conclusion = null) => ({
  id,
  name,
  status,
  conclusion,
  details_url: `https://github.com/o/r/actions/runs/${run}/job/${id}`,
});
const old = { event: 'pull_request', run_attempt: 3, created_at: '2026-10-30T02:47:29Z', run_started_at: '2026-10-30T13:35:00Z' };

test('annotationLine keeps the useful line and drops boilerplate', () => {
  check(annotationLine(fail('Process completed with exit code 1.')) === null, 'drops the exit-code boilerplate');
  check(annotationLine({ annotation_level: 'notice', message: 'ubuntu-latest will migrate' }) === null, 'drops notices');
  check(
    annotationLine(fail('command (/home/runner/work/x/x/services/svc-support) /bin/pnpm run typecheck exited (1)')) ===
      'svc-support: typecheck failed (exit 1)',
    'names the package a turbo task failed in',
  );
  check(
    annotationLine(fail('AssertionError: expected false', { path: 'packages/config/a.test.ts', start_line: 281 })) ===
      'packages/config/a.test.ts:281 AssertionError: expected false',
    'keeps the file and line',
  );
});

test('summarize: GREEN, RUNNING, REVIEW and RESEAL', () => {
  check(last(summarize({ ...base, checks: [ok(1, 'Format'), ok(2, SEAL)] })).startsWith('GREEN'), 'all green');
  check(last(summarize({ ...base, checks: [] })).startsWith('RUNNING'), 'no checks yet is not green');
  check(last(summarize({ ...base, checks: [ok(1, 'Gate-file guard')] })).startsWith('RUNNING'), 'green without the seal is not green');
  check(
    last(summarize({ ...base, checks: [ok(1, 'Format'), { id: 2, name: 'Tests', status: 'in_progress', conclusion: null }] })).startsWith(
      'RUNNING',
    ),
    'running',
  );

  check(last(summarize(onlyReview)).startsWith('REVIEW'), 'a seal red only for the review says so');
  check(!summarize(onlyReview).some((l) => l.startsWith('RED ')), 'and lists nothing as red');
  check(
    last(summarize({ ...onlyReview, statuses: [{ context: REVIEW_STATUS, state: 'success' }] })).startsWith('REVIEW'),
    'a review status alone is still a REVIEW red',
  );
  check(
    last(summarize({ ...onlyReview, statuses: [{ context: REVIEW_STATUS, state: 'success' }] })).includes('no longer reads statuses'),
    'and says a status no longer seals: the CI review job does',
  );
  check(
    last(summarize({ ...onlyReview, statuses: [{ context: RERUN_STATUS, state: 'failure' }] })).startsWith('RESEAL'),
    'a failed sign-off re-run asks for one re-run by hand',
  );
  const reviewAndRunning = {
    ...onlyReview,
    checks: [...onlyReview.checks, { id: 6, name: 'Gitleaks', status: 'in_progress', conclusion: null }],
  };
  check(last(summarize(reviewAndRunning)).startsWith('RUNNING'), 'never "nothing to fix" while another check still runs');
  const sealWaiting = { ...base, checks: [ok(1, 'Format'), { id: 2, name: SEAL, status: 'in_progress', conclusion: null }] };
  check(last(summarize(sealWaiting)).includes('waiting for the independent review'), 'a running seal alone may be the review wait');
});

test('summarize: RED whenever anything else is red', () => {
  // Never "nothing to fix" while anything else is red, or while the seal is red for another reason.
  const testsRed = {
    ...onlyReview,
    checks: [...onlyReview.checks, red(3, 'Tests (changed)')],
    annotations: { ...onlyReview.annotations, 3: [fail(' FAIL  src/a.test.ts > b')] },
  };
  const r = summarize(testsRed);
  check(last(r).startsWith('RED'), 'a red job beside the review wait is RED');
  check(
    r.some((l) => l.includes('FAIL src/a.test.ts > b')),
    'and names the failing test',
  );
  const sealOther = { ...base, checks: [red(2, SEAL)], annotations: { 2: [review, fail('needed job build: failure')] } };
  check(last(summarize(sealOther)).startsWith('RED'), 'a seal red for another reason is RED');
  const sealBare = { ...base, checks: [red(2, SEAL)], annotations: { 2: [fail('Process completed with exit code 1.')] } };
  check(last(summarize(sealBare)).startsWith('RED'), 'a seal red with no review annotation is RED');
  check(last(summarize(cancelled)).startsWith('RED'), 'cancelled is not green');
  const statusRed = { ...base, checks: [ok(1, 'Format')], statuses: [{ context: 'Gitleaks', state: 'failure' }] };
  check(
    summarize(statusRed).some((l) => l.includes('status Gitleaks')),
    'a red commit status is listed',
  );
  check(
    last(summarize({ ...statusRed, checks: [ok(1, 'Format'), ok(2, SEAL)] })).startsWith('RED'),
    'a red commit status makes the verdict RED, never GREEN',
  );
  const sealFirst = summarize({ ...testsRed, checks: [red(2, SEAL), ok(1, 'Format'), red(3, 'Tests (changed)')] });
  check(
    sealFirst.findIndex((l) => l.includes(SEAL)) > sealFirst.findIndex((l) => l.includes('Tests (changed)')),
    'the seal prints after the jobs it follows',
  );
});

test('summarize: SUPERSEDED for a run a newer push cancelled', () => {
  const cancelledByPush = fail('Canceling since a higher priority waiting request for CI-refs/pull/1/merge exists');
  const supersededRun = summarize({
    ...base,
    checks: [{ ...red(10, 'Tests (1/8)'), conclusion: 'cancelled' }, red(2, SEAL)],
    annotations: { 10: [cancelledByPush], 2: [fail('needed job tests-full: cancelled')] },
  });
  check(last(supersededRun).startsWith('SUPERSEDED'), 'a run cancelled by a newer push says so');
  check(last(summarize(cancelled)).startsWith('RED'), 'a cancel for another reason stays RED');
});

test('summarize: the latest run of a check decides', () => {
  const rerun = summarize({
    ...base,
    checks: [
      { ...red(7, 'Gate-file guard'), started_at: '2026-10-23T09:00:00Z' },
      { ...ok(8, 'Gate-file guard'), started_at: '2026-10-23T09:05:00Z' },
      ok(2, SEAL),
    ],
  });
  check(last(rerun).startsWith('GREEN'), 'a check that failed and then passed on a later run is green');
  const rerunRed = summarize({
    ...base,
    checks: [
      { ...ok(8, 'Gate-file guard'), started_at: '2026-10-23T09:00:00Z' },
      { ...red(9, 'Gate-file guard'), started_at: '2026-10-23T09:05:00Z' },
      ok(2, SEAL),
    ],
  });
  check(last(rerunRed).startsWith('RED'), 'a check that passed and then failed on a later run is red');
});

test('summarize: a red job with no annotations names its failed step', () => {
  const bare = summarize({
    ...base,
    checks: [red(5, 'Doctrine gates')],
    failedSteps: { 5: ['Doctrine gates (the same list `pnpm verify` runs)'] },
  });
  check(
    bare.some((l) => l.includes('failed step: Doctrine gates')),
    'a red job with no annotations names its failed step',
  );
});

test('staleLines and runIdOf: an old run re-run hours later is STALE', () => {
  const stale = summarize({ ...base, checks: [job(9, 'Tests (changed)', 40993723454)], runs: { 40993723454: old } });
  check(
    stale.some((l) => l.startsWith('STALE    run 40993723454') && l.includes('attempt 3')),
    'an old pull_request run re-run hours later is named stale',
  );
  check(runIdOf({ details_url: 'https://github.com/o/r/actions/runs/77/job/2' }) === '77', 'reads the run id');
  const at = (over) => ({ 1: { ...old, ...over } });
  const testsJob = [job(5, 'Tests (changed)', 1)];
  check(staleLines(at({ run_started_at: '2026-10-30T03:30:00Z' }), testsJob).length === 0, 'a prompt confirmation re-run is not stale');
  check(staleLines(at({ run_attempt: 1 }), testsJob).length === 0, 'a first attempt that waited in the queue is not stale');
  check(staleLines(at({ event: 'push' }), testsJob).length === 0, 'a push run has no merge commit to go stale');
  check(staleLines(at({}), [job(6, SEAL, 1)]).length === 0, "the sign-off workflow's re-run of the seal is not stale");
  check(staleLines(at({}), [job(5, 'Tests (changed)', 1, 'completed', 'success')]).length === 0, 'a green run needs no advice');
  check(staleLines({ 1: null }, testsJob).length === 0, 'an unread run says nothing');
});

test('orphanLines: an old run re-run with no push is an ORPHAN', () => {
  const now = Date.parse('2026-10-30T13:40:00Z');
  const pr = { number: 6832, title: 'feat: x', headSha: 'b'.repeat(40) };
  const run = { id: 40993723454, created_at: '2026-10-30T02:47:29Z', run_started_at: '2026-10-30T13:16:00Z', run_attempt: 3 };
  const testsRerun = [
    { name: 'Tests (changed)', run_attempt: 3 },
    { name: SEAL, run_attempt: 3 },
  ];
  const orphan = (over = {}, jobs = testsRerun) => orphanLines([pr], { [pr.headSha]: { run: { ...run, ...over }, jobs } }, now);
  check(orphan()[0].startsWith('ORPHAN   #6832 CI run 40993723454 was made 10.9h ago'), 'an old run re-run with no push is an orphan');
  const clean = (lines) => lines.length === 1 && lines[0].startsWith('NO ORPHANS');
  check(clean(orphan({ run_attempt: 1 })), 'an old PR nobody re-ran is only waiting');
  check(clean(orphan({ created_at: '2026-10-30T12:00:00Z' })), 'a recent push is not an orphan');
  check(clean(orphan({ run_started_at: '2026-10-30T03:00:00Z' })), 'a prompt confirmation re-run is not an orphan');
  check(
    clean(
      orphan({}, [
        { name: 'Tests (changed)', run_attempt: 1 },
        { name: SEAL, run_attempt: 3 },
      ]),
    ),
    "the sign-off workflow's seal re-run is not an orphan",
  );
  check(clean(orphanLines([pr], { [pr.headSha]: null }, now)), 'a head with no CI run says nothing');
  const unread = orphanLines([pr], {}, now);
  check(unread.length === 1 && unread[0].startsWith('UNREAD   the CI runs of #6832'), 'an unread head is named, never passed as fine');
});

test('summarize: JUDGE DOWN only when every red is the spent API budget', () => {
  // A check stopped on the spent API budget (api-budget.mjs) is a judge down, never a red to push for.
  {
    const spent = fail("gate-file-guard: judge down: GitHub's hourly API budget is spent: nothing to fix", {
      title: 'judge down: GitHub API budget',
    });
    const sealSpent = fail(
      "GET /repos/o/r/pulls/1: HTTP 403; judge down: GitHub's hourly API budget is spent until 03:20 UTC: nothing to fix; the seal fails closed",
      { title: 'judge down: GitHub API budget' },
    );
    const base = { sha, statuses: [], failedSteps: {}, runs: {} };
    const both = summarize({
      ...base,
      checks: [red(1, 'Gate-file guard'), red(2, SEAL), ok(3, 'CI')],
      annotations: { 1: [fail('Process completed with exit code 3.'), spent], 2: [sealSpent] },
    });
    check(last(both).startsWith('JUDGE DOWN:'), 'every red on the spent budget is JUDGE DOWN');
    const ghText = summarize({
      ...base,
      checks: [red(1, 'Tests (1/16)')],
      annotations: { 1: [fail('AssertionError: expected "gh: API rate limit exceeded for installation" to equal "ok"')] },
    });
    check(last(ghText).startsWith('RED:'), "a test failure that quotes GitHub's words is the change's own red");
    const mixed = summarize({
      ...base,
      checks: [red(1, 'Gate-file guard'), red(2, 'CI')],
      annotations: { 1: [spent], 2: [fail('FAIL src/a.test.ts > adds')] },
    });
    check(last(mixed).startsWith('RED:'), 'a budget red beside a red of its own stays RED');
    const inOne = summarize({
      ...base,
      checks: [red(2, SEAL)],
      annotations: { 2: [sealSpent, fail('touched journeys: not proven on this head')] },
    });
    check(last(inOne).startsWith('RED:'), 'a check with a line of its own beside the budget line stays RED');
    const refused = summarize({
      ...base,
      checks: [red(1, SEAL)],
      annotations: { 1: [fail('GET /repos/o/r/pulls/1: HTTP 403; the seal fails closed')] },
    });
    check(last(refused).startsWith('RED:'), 'a 403 that is not the budget stays RED');
    const secondary = summarize({
      ...base,
      checks: [red(1, SEAL)],
      annotations: { 1: [fail('You have exceeded a secondary rate limit')] },
    });
    check(last(secondary).startsWith('RED:'), 'a secondary rate limit stays RED');
    const silent = summarize({
      ...base,
      checks: [red(1, 'Gate-file guard')],
      annotations: { 1: [fail('Process completed with exit code 3.')] },
    });
    check(last(silent).startsWith('RED:'), 'a red with no error line is never called JUDGE DOWN');
  }
});
