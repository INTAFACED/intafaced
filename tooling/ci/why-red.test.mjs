import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JOURNEYS,
  collectJourneys,
  journeyFailures,
  journeyLines,
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

// Journey steps from the run's merged report. The fixtures are the recorded reports of #8802 and #8804, trimmed to their
// failed steps: J-portfolio-01 #5 failed on heads ad61e99 and 3ec80e0 at two different lines before 7e1193a fixed it by
// changing line 558 of J-portfolio-01-venue.pw.mjs, the line the head 3ec80e0 report names.
const fixture = (name) => fileURLToPath(new URL(`./fixtures/why-red-${name}.json`, import.meta.url));
const report = (name) => JSON.parse(readFileSync(fixture(name), 'utf8'));
const HEAD = '3ec80e0d3052d00f8eb37196969caa79b8155c7c';
const PREV = 'ad61e9949e1261b2a97e9d8b25ec1c5287994351';
const GREEN_HEAD = '9'.repeat(40);

/** A gh that answers from the fixtures alone: no network. `runs` maps a head to its journeys runs; `reports` a run id to a fixture. */
function fakeGh({ commits, runs, reports }) {
  const asked = [];
  const gh = (args) => {
    asked.push(args.join(' '));
    if (args[0] === 'run' && args[1] === 'download') {
      const name = reports[args[2]];
      if (!name) return { status: 1, stdout: '', stderr: 'no artifact matches' };
      copyFileSync(fixture(name), join(args[args.indexOf('-D') + 1], 'report.json'));
      return { status: 0, stdout: '', stderr: '' };
    }
    const path = args[1];
    if (/\/pulls\/\d+\/commits/.test(path)) return { status: 0, stdout: JSON.stringify(commits.map((sha) => ({ sha }))), stderr: '' };
    const head = /head_sha=([0-9a-f]{40})/.exec(path)?.[1];
    if (head) return { status: 0, stdout: JSON.stringify({ workflow_runs: runs[head] ?? [] }), stderr: '' };
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { gh, asked };
}
const run = (id, conclusion) => ({ id, status: 'completed', conclusion });

test('journeyFailures names the step, the line the fix changed, and what Playwright said there', () => {
  const [f, ...rest] = journeyFailures(report('8802-3ec80e0'));
  assert.equal(rest.length, 0);
  assert.match(f.title, /^J-portfolio-01 #5 cancels the order/);
  assert.equal(`${f.file}:${f.line}`, 'apps/customer/tests/real-app/J-portfolio-01-venue.pw.mjs:558');
  assert.equal(f.source, `await expect(after.row.locator('[data-cell="locked"]')).toHaveText(/^0\\b/);`);
  assert.match(
    f.said,
    /^expect\(locator\)\.toHaveText\(expected\) failed; Expected pattern: \/\^0\\b\/; Received string: "0In orders 0Collateral 0Stake 0"/,
  );
  check(!f.said.includes(String.fromCharCode(27)), 'no terminal colour codes');
  assert.equal(journeyFailures(null), null, 'no report is named, never passed as no failures');
});

test('journeyFailures names the action a timed-out step was waiting on', () => {
  const f = journeyFailures(report('8804-074169d')).find((x) => x.title.startsWith('J-p2p-21 #2'));
  assert.equal(`${f.file}:${f.line}`, 'apps/customer/tests/real-app/J-p2p-21.pw.mjs:126');
  assert.match(f.said, /^timed out waiting on: /);
});

test("collectJourneys reads the hand-run's report when the PR run kept none, and compares the previous red head", () => {
  const { gh, asked } = fakeGh({
    commits: [GREEN_HEAD, 'b'.repeat(40), PREV, 'c'.repeat(40), HEAD],
    runs: {
      [HEAD]: [run(1, 'cancelled'), run(2, 'failure')],
      [PREV]: [run(3, 'failure')],
      ['b'.repeat(40)]: [run(4, 'failure')],
      [GREEN_HEAD]: [run(5, 'success')],
    },
    reports: { 2: '8802-3ec80e0', 3: '8802-ad61e99' },
  });
  const j = collectJourneys(gh, 'o/r', '8802', HEAD, '1');
  assert.equal(j.failures.length, 1);
  assert.equal(j.prev.sha, PREV, 'the nearest earlier head with a finished journeys run; c… had none');
  assert.equal(j.green, GREEN_HEAD);
  check(!asked.some((a) => a.includes('download 5')), 'a green head needs no report');
  const lines = journeyLines(j);
  assert.match(
    lines.find((l) => l.includes('compared:')),
    /failed on ad61e9949e12 too, at apps\/customer\/tests\/real-app\/venue\.mjs:148/,
  );
  check(!lines.some((l) => l.includes('hypothesis')), 'a compared step is not a hypothesis');
  assert.match(
    lines.find((l) => l.startsWith('PREMISE')),
    /previous head ad61e9949e12 too \(1 of these steps\).*test it before the next push/,
  );
  assert.equal(last(lines), `LAST GREEN  ${JOURNEYS} passed on this PR at 999999999999`);
});

test('journeyLines: a first red is a hypothesis with no premise line; a run with no report says so', () => {
  const lines = journeyLines({
    failures: journeyFailures(report('8802-3ec80e0')),
    prev: { sha: PREV, conclusion: 'success', failures: [] },
    green: PREV,
    read: 1,
  });
  check(
    lines.some((l) => l.includes('hypothesis: where it stopped')),
    'marked hypothesis',
  );
  check(!lines.some((l) => l.startsWith('PREMISE')), 'no premise after a green head');
  assert.match(journeyLines({ failures: null })[0], /kept no journeys report/);
});

test('summarize prints the journey lines under the red journeys check, within the promised size', () => {
  // #8804's four failed steps and #8802's one: five, one past the four printed.
  const failures = [...journeyFailures(report('8804-074169d')), ...journeyFailures(report('8802-3ec80e0'))];
  const j = { failures, prev: { sha: PREV, conclusion: 'failure', failures: [] }, green: null, read: 10 };
  const out = summarize({
    ...base,
    checks: [ok(1, 'Format'), red(7, JOURNEYS)],
    annotations: { 7: [fail('Process completed with exit code 1.')] },
    failedSteps: { 7: ['Verdict'] },
    journeys: { 7: j },
  });
  const at = out.findIndex((l) => l.startsWith(`RED      ${JOURNEYS}`));
  assert.match(out[at + 2], /^STEP     J-p2p-21 #2/);
  assert.equal(out.filter((l) => l.startsWith('STEP')).length, 4, 'at most four steps');
  check(out.includes('         ... 1 more steps failed'), 'the rest counted');
  check(
    out.every((l) => l.length <= 200),
    'every line within WIDTH',
  );
  const size = out.join('\n').length;
  check(size < 3000, `the whole answer stays a few thousand characters, not the 30-40K a log read cost (${size})`);
  assert.match(last(out), /^RED: /);
});
