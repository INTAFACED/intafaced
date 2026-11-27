// The planted cases of the journey-steps seal (journey-seal.mjs): a known-good shape seals; a red named step, a run on an
// older head, a step missing from the report, a run still going, an earlier attempt's report and an unreadable report do
// not; a step exempted on a strict `Left-or-replaced:` line seals without a run, and anything else that looks like an
// exemption fails closed. tooling-tests.mjs runs this file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReport, rootInputs } from './journey-verdict.mjs';
import { CANARY } from './journey-touch.mjs';
import {
  currentReportArtifact,
  earlierReportArtifacts,
  flakyWay,
  fileSteps,
  fullVerdict,
  journeyFilesAt,
  judgeTouched,
  judgeTouchedRun,
  titleBeforePush,
  JOURNEY_TEST,
  touchedSteps,
  globRe,
  isSharedSetup,
  judgeSteps,
  mainReference,
  moneyAt,
  moneyInput,
  splitInherited,
  mainsOwn,
  trackingIssue,
  redKinds,
  kindTitle,
  rangeFromCommits,
  areasOf,
  RANGE_MAX,
  pullFilePaths,
  sharedPulls,
  SHARED_SETUP,
  exemptions,
  namesSteps,
  recheckPulls,
  recheckStep,
  rerunSealJob,
  rerunBlocker,
  sealPull,
  carriedPulls,
  stepsIn,
  titleProblems,
  titleSteps,
  JOURNEYS_WORKFLOW,
  SEAL,
  getTried,
  betaOfArtifact,
} from './journey-seal.mjs';

const REPO = 'INTAFACED/intafaced';
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const run = (id, over = {}) => ({
  id,
  head_sha: HEAD,
  path: JOURNEYS_WORKFLOW,
  status: 'completed',
  conclusion: 'success',
  run_attempt: 1,
  created_at: `2026-11-06T0${id % 10}:00:00Z`,
  run_started_at: `2026-11-06T0${id % 10}:00:00Z`,
  head_repository: { full_name: REPO },
  repository: { full_name: REPO },
  ...over,
});
const reports = (byRun) => async (r) => (byRun[r.id] instanceof Error ? Promise.reject(byRun[r.id]) : byRun[r.id]);
const judge = (over) =>
  judgeSteps({
    sha: HEAD,
    repo: REPO,
    title: 'svc-bank: J-bank-13 cards (J-bank-13 #1 #2)',
    body: '',
    runs: [],
    reportOf: reports({}),
    ...over,
  });
const green = { states: { 'J-bank-13#1': 'passed', 'J-bank-13#2': 'passed', 'J-wallet-05#3': 'failed' } };

test('title parsing: lists, ranges, several journeys, case, and what is not a step', () => {
  assert.deepEqual(titleSteps('svc-bank: J-bank-13 I get a card (J-bank-13 #1 #2 #3 #4 #5 #6 #7)').length, 7);
  assert.deepEqual(titleSteps('svc-bank: PF-statements-02 exports (J-portfolio-11 #4 #5)'), ['J-portfolio-11#4', 'J-portfolio-11#5']);
  assert.deepEqual(titleSteps('ci: index (J-ops-console-01 #1 #2 #3, J-ops-console-22 #1–#5, 12 J-bank steps)'), [
    'J-ops-console-01#1',
    'J-ops-console-01#2',
    'J-ops-console-01#3',
    'J-ops-console-22#1',
    'J-ops-console-22#2',
    'J-ops-console-22#3',
    'J-ops-console-22#4',
    'J-ops-console-22#5',
  ]);
  assert.deepEqual(titleSteps('x (J-a-01 #2-#4)'), ['J-a-01#2', 'J-a-01#3', 'J-a-01#4']);
  assert.deepEqual(titleSteps('x (J-a-01 #4 to #2)'), ['J-a-01#2', 'J-a-01#3', 'J-a-01#4'], 'a reversed range still names its steps');
  assert.deepEqual(titleSteps('x (J-a-01 #1, #2 and #3 & #4 / #5)'), ['J-a-01#1', 'J-a-01#2', 'J-a-01#3', 'J-a-01#4', 'J-a-01#5']);
  assert.deepEqual(titleSteps('x (j-Bank-13 #01)'), ['J-bank-13#1'], 'case and leading zeros never hide a step');
  assert.deepEqual(
    titleSteps('x (J-derivatives-02 #5 #6 flake, #7110)'),
    ['J-derivatives-02#5', 'J-derivatives-02#6'],
    'a PR number after other words is not a step',
  );
  assert.deepEqual(titleSteps('svc-bank: J-bank-13 I get a card'), [], 'a journey id with no step names none');
  assert.deepEqual(titleSteps('gate: money PRs are sealed (#7194)'), []);
  assert.deepEqual(titleSteps('x (J-a-01 #1-#100000)'), [], 'a three-digit number is never a step');
  assert.deepEqual(titleSteps('x (J-wallet-05 #2, #6650) (#7052)'), ['J-wallet-05#2'], 'an issue number after the steps is not one');
  assert.deepEqual(titleSteps('x (J-bank-13#1 #2)'), ['J-bank-13#1', 'J-bank-13#2'], "the report's own spelling names steps");
});

test("title parsing: steps written after the journey's words (R0-5, 10 Nov; #7599, 9 Nov)", () => {
  // One journey: the numbers after its words are its steps; a pull request number in brackets is not.
  assert.deepEqual(titleSteps('svc-trade: J-cex-spot-14 a trader sees the venue (#1 #5 #9 #11)'), [
    'J-cex-spot-14#1',
    'J-cex-spot-14#5',
    'J-cex-spot-14#9',
    'J-cex-spot-14#11',
  ]);
  assert.deepEqual(titleSteps('svc-bank: J-bank-03 partner files, steps #2–#4 (#7593)'), ['J-bank-03#2', 'J-bank-03#3', 'J-bank-03#4']);
  assert.deepEqual(titleSteps('svc-bank: J-bank-14 #5 #7 a cardholder answers 3D Secure (#7738)'), ['J-bank-14#5', 'J-bank-14#7']);
  assert.deepEqual(titleProblems('svc-trade: J-cex-spot-14 a trader sees the venue (#1 #5)'), []);
  // Two journeys: stray numbers can't be placed, so the seal fails closed and says how to write them.
  const two = 'svc-trade: J-cex-spot-14 and J-cex-spot-15 venue steps (#1 #5)';
  assert.deepEqual(titleSteps(two), []);
  assert.equal(titleProblems(two).length, 1);
  assert.match(titleProblems(two)[0], /more than one journey/);
  // A title of runs alone is unchanged, and a pull request number never counts.
  assert.deepEqual(titleProblems('ci: index (J-ops-console-01 #1 #2, J-ops-console-22 #1–#5) (#7700)'), []);
  assert.deepEqual(titleSteps('tests: J-academy-05 #5 (#7772)'), ['J-academy-05#5']);
});

test('exemption line: column 0, outside code and comments, step ids only; Markdown sections exempt nothing', () => {
  const ok = (b) => [...exemptions(b).steps].sort();
  const bad = (b) => exemptions(b).problems;
  assert.deepEqual(ok('Left-or-replaced: J-bank-13 #3 #5, J-bank-14 #2\n'), ['J-bank-13#3', 'J-bank-13#5', 'J-bank-14#2']);
  assert.deepEqual(
    ok('a\nLeft-or-replaced: J-bank-13 #1\nb\nLeft-or-replaced: J-bank-13#2\n'),
    ['J-bank-13#1', 'J-bank-13#2'],
    'several lines',
  );
  assert.deepEqual(ok('Left-or-replaced: J-bank-13 #1-#3\n'), ['J-bank-13#1', 'J-bank-13#2', 'J-bank-13#3']);
  // The PR template's prose heading and anything under it exempt nothing, without being a problem.
  const prose = '## Left or replaced\n- J-bank-13 #3: needs the issuer\n1. **J-bank-15 #1**\nNone. J-bank-13 #1 all pass.\n';
  assert.deepEqual(ok(prose), []);
  assert.deepEqual(bad(prose), []);
  // Code and comments hide nothing and exempt nothing.
  for (const b of [
    '```\nLeft-or-replaced: J-bank-13 #1\n```\n',
    '<!--\nLeft-or-replaced: J-bank-13 #1\n-->\n',
    '- ```\n  x\n  ```\n~~~\nLeft-or-replaced: J-bank-13 #1\n~~~\n',
  ]) {
    assert.deepEqual(ok(b), [], b);
    assert.deepEqual(bad(b), [], b);
  }
  // Anything else that looks like an exemption is a problem: printed as a note, and it exempts nothing.
  for (const b of [
    ' Left-or-replaced: J-bank-13 #1',
    '    Left-or-replaced: J-bank-13 #1',
    '- Left-or-replaced: J-bank-13 #1',
    '> Left-or-replaced: J-bank-13 #1',
    'left-or-replaced: J-bank-13 #1',
    'Left-or-replaced: J-bank-13 #1 needs the issuer',
    'Left-or-replaced: #1',
    'Left-or-replaced:',
    'Left-or-replaced: J-bank-13 #1-#100',
    'Left - or - replaced: J-bank-13 #1',
  ]) {
    assert.deepEqual(ok(b), [], b);
    assert.equal(bad(b).length, 1, b);
  }
  assert.deepEqual(exemptions(null), { steps: new Set(), problems: [] });
});

test('a title naming no step is unaffected: no run is read', async () => {
  const v = await judge({ title: 'svc-bank: PF-statements-02 exports', reportOf: () => assert.fail('no report is read') });
  assert.equal(v.ok, true);
  assert.equal(v.state, 'none');
});

test('known-good shape: every named step passed in a finished run on the exact head', async () => {
  const v = await judge({ runs: [run(1)], reportOf: reports({ 1: green }) });
  assert.equal(v.ok, true, v.lines.join('\n'));
  assert.match(v.lines.join('\n'), /J-bank-13#1: passed in run 1/);
});

test('a run whose conclusion is red still seals steps it passed (the steps decide, not other journeys)', async () => {
  const v = await judge({ runs: [run(1, { conclusion: 'failure' })], reportOf: reports({ 1: green }) });
  assert.equal(v.ok, true);
});

test('planted fault: a named step red in the run fails (#7202, run 42162035136)', async () => {
  const states = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [`J-bank-13#${n}`, 'failed']));
  const title =
    "svc-bank: J-bank-13 I get a card: eligibility and terms, virtual and single-use cards, a physical card's delivery and address, activation with step-up, a lost report, and cashback in IFC by rank tier (J-bank-13 #1 #2 #3 #4 #5 #6 #7)";
  // #7202's own "Left or replaced" section opened with "#7: inferences and limits" about a step it claimed built.
  const body = '## Left or replaced\n\n- **#7: inferences and limits, all mine.**\n  - "In token" is read as IFC\n## Proof\n';
  const v = await judge({ title, body, runs: [run(42162035136 % 1e6, { conclusion: 'failure' })], reportOf: async () => ({ states }) });
  assert.equal(v.ok, false);
  assert.equal(v.lines.filter((l) => / failed in run /.test(l)).length, 7);
});

test('planted fault: one red named step among green ones fails', async () => {
  const v = await judge({ runs: [run(1)], reportOf: reports({ 1: { states: { 'J-bank-13#1': 'passed', 'J-bank-13#2': 'failed' } } }) });
  assert.equal(v.ok, false);
  assert.match(v.lines.join('\n'), /J-bank-13#2: failed in run 1/);
});

test('planted fault: a green run on an older head counts for nothing', async () => {
  const v = await judge({ runs: [run(1, { head_sha: OLD })], reportOf: reports({ 1: green }) });
  assert.equal(v.ok, false);
  assert.match(v.lines.join('\n'), /no finished Real-app journeys run on this head/);
});

test('a run of another workflow file or from another repository counts for nothing', async () => {
  for (const r of [run(1, { path: '.github/workflows/other.yml' }), run(1, { head_repository: { full_name: 'fork/intafaced' } })]) {
    assert.equal((await judge({ runs: [r], reportOf: reports({ 1: green }) })).ok, false);
  }
});

test('planted fault: a named step missing from the report is not green', async () => {
  const v = await judge({ runs: [run(1)], reportOf: reports({ 1: { states: { 'J-bank-13#1': 'passed' } } }) });
  assert.equal(v.ok, false);
  assert.match(v.lines.join('\n'), /J-bank-13#2: no finished Real-app journeys run on this head reports it/);
});

test('a skipped named step is not green', async () => {
  const v = await judge({ runs: [run(1)], reportOf: reports({ 1: { states: { 'J-bank-13#1': 'passed', 'J-bank-13#2': 'skipped' } } }) });
  assert.equal(v.ok, false);
});

test('a Left-or-replaced line passes its steps without a run; a malformed one exempts nothing and is only a note', async () => {
  const one = { runs: [run(1)], reportOf: reports({ 1: { states: { 'J-bank-13#1': 'passed' } } }) };
  const left = await judge({ body: 'Left-or-replaced: J-bank-13 #2\n', ...one });
  assert.equal(left.ok, true, left.lines.join('\n'));
  assert.match(left.lines.join('\n'), /J-bank-13#2: exempted on a Left-or-replaced line/);
  const both = await judge({ body: 'Left-or-replaced: J-bank-13 #1 #2\n', reportOf: () => assert.fail('nothing to read') });
  assert.equal(both.ok, true);
  const broken = await judge({ body: 'Left-or-replaced: J-bank-13 #2 needs the issuer\n', ...one });
  assert.equal(broken.ok, false, 'a malformed line exempts nothing: #2 still has no passing run');
  assert.match(broken.lines.join('\n'), /exempts nothing[\s\S]*J-bank-13#2: no finished Real-app journeys run/);
  // The 7 bodies the old early return failed (#8289 #8321 #8327 #8339 #8364 #8396 #8410): every step passed, so they seal.
  const green = { runs: [run(1)], reportOf: reports({ 1: { states: { 'J-bank-13#1': 'passed', 'J-bank-13#2': 'passed' } } }) };
  for (const body of ['Left-or-replaced: none.\n', 'Left-or-replaced: none (all green)\n', 'Needs no `Left-or-replaced:` line.\n']) {
    const v = await judge({ body, ...green });
    assert.equal(v.ok, true, body);
    assert.match(v.lines.join('\n'), /exempts nothing/);
  }
  assert.equal((await judge({ body: '## Left or replaced\n- J-bank-13 #2: needs the issuer\n', ...one })).ok, false);
  assert.equal((await judge({ body: 'Left-or-replaced: #2\n', ...one })).ok, false, 'a bare #n');
});

test('on a merge queue commit nothing waits: an unfinished run is passed over and the finished ones decide', async () => {
  const runs = [run(1), run(2, { status: 'in_progress', conclusion: null })];
  assert.equal((await judge({ runs, reportOf: reports({ 1: green, 2: new Error('must not read') }), waitOnRunning: false })).ok, true);
  assert.equal(
    (await judge({ runs: [run(2, { status: 'in_progress', conclusion: null })], reportOf: reports({}), waitOnRunning: false })).ok,
    false,
  );
});

test('a run on this head not finished (first attempt or re-run) holds the seal', async () => {
  for (const r of [run(2, { status: 'in_progress', conclusion: null }), run(2, { status: 'queued', run_attempt: 2, conclusion: null })]) {
    const v = await judge({ runs: [run(1), r], reportOf: reports({ 1: green }) });
    assert.equal(v.ok, false);
    assert.equal(v.state, 'wait');
  }
});

test('a failure in any finished run on the head stands: a newer failure outranks an older pass, and an older failure a newer pass (#9827)', async () => {
  const fail = { states: { 'J-bank-13#1': 'passed', 'J-bank-13#2': 'failed' } };
  const older = { run_started_at: '2026-11-06T01:00:00Z' };
  const newer = { run_started_at: '2026-11-06T02:00:00Z' };
  assert.equal((await judge({ runs: [run(1, older), run(2, newer)], reportOf: reports({ 1: green, 2: fail }) })).ok, false);
  // Planted (#9827 on 822aec16bd: run 45030979813 failed J-cex-spot-21 #4, run 45031001317 passed it 14 seconds later,
  // and the seal read the newest alone): the older failure holds it, named, with the way forward.
  const hidden = await judge({ runs: [run(1, newer), run(2, older)], reportOf: reports({ 1: green, 2: fail }) });
  assert.equal(hidden.ok, false, hidden.lines.join('\n'));
  assert.match(
    hidden.lines.join('\n'),
    /J-bank-13#2: passed in run 1 \(attempt 1\), but failed in run 2 \(attempt 1\) on this same head: a step that fails then passes on one commit is flaky and never counts as passing/,
  );
  assert.match(
    hidden.lines.join('\n'),
    /open-flaky\.mjs --step "J-bank-13 #2" --sha a{40} --run https:\/\/github\.com\/INTAFACED\/intafaced\/actions\/runs\/2 /,
  );
  assert.deepEqual(hidden.kinds, ['yours']);
  // Known good: two runs on the head that both pass every named step seal it.
  assert.equal((await judge({ runs: [run(1, newer), run(2, older)], reportOf: reports({ 1: green, 2: green }) })).ok, true);
  // A targeted run of another journey file is newer but doesn't list these steps: the older run still decides.
  const other = { states: { 'J-wallet-05#1': 'passed' } };
  assert.equal((await judge({ runs: [run(1, older), run(2, newer)], reportOf: reports({ 1: green, 2: other }) })).ok, true);
});

test('a re-run attempt is ordered by its own start, and a run started between its attempts that failed a step still stands', async () => {
  const fail = { states: { 'J-bank-13#1': 'failed', 'J-bank-13#2': 'failed' } };
  const rerun = run(1, { run_attempt: 2, created_at: '2026-11-06T01:00:00Z', run_started_at: '2026-11-06T03:00:00Z' });
  const between = run(2, { run_started_at: '2026-11-06T02:00:00Z' });
  const v = await judge({ runs: [rerun, between], reportOf: reports({ 1: green, 2: fail }) });
  assert.equal(v.ok, false);
  assert.match(v.lines.join('\n'), /J-bank-13#1: passed in run 1 \(attempt 2\), but failed in run 2 \(attempt 1\)/);
});

test("an earlier attempt's failure stands against its re-run's pass; one it passed, or one with no report, does not", async () => {
  const rerun = run(1, { run_attempt: 2 });
  const earlier = (states) => ({ ...green, earlier: [{ attempt: 1, states }] });
  const flaky = await judge({ runs: [rerun], reportOf: reports({ 1: earlier({ 'J-bank-13#1': 'passed', 'J-bank-13#2': 'failed' }) }) });
  assert.equal(flaky.ok, false, flaky.lines.join('\n'));
  assert.match(
    flaky.lines.join('\n'),
    /J-bank-13#2: passed in run 1 \(attempt 2\), but failed in run 1 \(attempt 1\) on this same head: a step that fails then passes/,
  );
  assert.equal(
    (await judge({ runs: [rerun], reportOf: reports({ 1: earlier({ 'J-bank-13#1': 'passed', 'J-bank-13#2': 'passed' }) }) })).ok,
    true,
  );
  assert.equal(
    (await judge({ runs: [rerun], reportOf: reports({ 1: { ...green, earlier: [] } }) })).ok,
    true,
    'an attempt with no report is left out',
  );
  const unread = await judge({ runs: [rerun], reportOf: reports({ 1: { ...green, earlier: [{ attempt: 1, error: 'HTTP 500' }] } }) });
  assert.equal(unread.ok, false, 'an earlier report that cannot be read fails closed');
  assert.deepEqual(unread.kinds, ['runner']);
});

test('cancelled and skipped runs are passed over', async () => {
  const runs = [
    run(1, { run_started_at: '2026-11-06T01:00:00Z' }),
    run(2, { conclusion: 'cancelled', run_started_at: '2026-11-06T02:00:00Z' }),
  ];
  assert.equal((await judge({ runs, reportOf: reports({ 1: green, 2: new Error('must not read') }) })).ok, true);
});

test('an unreadable report fails closed, whichever run is newer', async () => {
  const older = { run_started_at: '2026-11-06T01:00:00Z' };
  const newer = { run_started_at: '2026-11-06T02:00:00Z' };
  const v = await judge({
    runs: [run(1, older), run(2, newer)],
    reportOf: reports({ 1: green, 2: { error: 'no real-app-journeys artifact from its current attempt' } }),
  });
  assert.equal(v.ok, false);
  assert.match(v.lines.join('\n'), /couldn't be read/);
  // An older run whose report can't be read may hold a failure the newer pass would hide (#9827): it fails closed too.
  const olderUnread = await judge({ runs: [run(1, older), run(2, newer)], reportOf: reports({ 1: new Error('boom'), 2: green }) });
  assert.equal(olderUnread.ok, false);
  assert.match(olderUnread.lines.join('\n'), /run 1 \(attempt 1\)'s report couldn't be read \(boom\)/);
});

test('#9253: a finished run that started no job is passed over and named; one with jobs and no report still fails closed', async () => {
  const older = { run_started_at: '2026-11-06T01:00:00Z' };
  const noJob = run(2, { conclusion: 'failure', jobCount: 0, run_started_at: '2026-11-06T02:00:00Z' });
  const noReport = { error: 'no real-app-journeys artifact from its current attempt' };
  const v = await judge({ runs: [run(1, older), noJob], reportOf: reports({ 1: green, 2: noReport }) });
  assert.equal(v.ok, true);
  assert.equal(v.lines.filter((l) => l.startsWith('run 2 (attempt 1) started no job')).length, 1);
  // Planted: the same run with jobs, or never counted, fails closed; alone, a no-job run proves nothing; going, it holds.
  assert.equal((await judge({ runs: [run(1, older), { ...noJob, jobCount: 1 }], reportOf: reports({ 1: green, 2: noReport }) })).ok, false);
  assert.equal(
    (await judge({ runs: [run(1, older), { ...noJob, jobCount: undefined }], reportOf: reports({ 1: green, 2: noReport }) })).ok,
    false,
  );
  assert.equal((await judge({ runs: [noJob], reportOf: reports({ 2: noReport }) })).ok, false);
  assert.equal(
    (await judge({ runs: [run(1, older), { ...noJob, status: 'in_progress', conclusion: null }], reportOf: reports({ 1: green }) })).state,
    'wait',
  );
});

test("#9253: the seal's run list counts each finished run's jobs from GitHub's jobs list, never its title", async () => {
  const { makeIo, startedNoJob } = await import('./journey-seal.mjs');
  const listed = [
    run(1, { conclusion: 'failure', display_title: 'Real-app journeys by hand, J-a-01.pw.mjs' }),
    run(2, { conclusion: 'success' }),
    run(3, { conclusion: 'cancelled' }),
    run(4, { status: 'in_progress', conclusion: null }),
  ];
  const jobs = {
    1: [],
    2: [{ name: 'Journeys (1/4)', status: 'completed', conclusion: 'success' }],
    4: [{ name: 'touch', status: 'in_progress' }],
  };
  const asked = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const u = new URL(url);
    const id = /\/runs\/(\d+)\/jobs$/.exec(u.pathname)?.[1];
    const body = id ? { total_count: jobs[id].length, jobs: jobs[id] } : { total_count: listed.length, workflow_runs: listed };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const runs = await makeIo(REPO, 'x').runs(HEAD);
    assert.deepEqual(
      runs.map((r) => [r.id, r.jobCount, startedNoJob(r)]),
      [
        [1, 0, true],
        [2, 1, false],
        [3, undefined, false],
        [4, undefined, false],
      ],
    );
    assert.ok(
      asked.every((u) => !/runs\/3\/jobs/.test(u)),
      'a cancelled run is passed over without a read',
    );
  } finally {
    globalThis.fetch = real;
  }
  // A jobs list that can't be read fails the whole read closed.
  globalThis.fetch = async (url) =>
    /\/jobs/.test(String(url))
      ? new Response('{}', { status: 200 })
      : new Response(JSON.stringify({ total_count: 1, workflow_runs: [listed[0]] }), { status: 200 });
  try {
    await assert.rejects(makeIo(REPO, 'x').runs(HEAD), /run 1's jobs: not a list/);
  } finally {
    globalThis.fetch = real;
  }
});

test("a run's report is the artifact from its current attempt only", () => {
  const r = run(1, { run_attempt: 2, run_started_at: '2026-11-06T03:00:00Z' });
  const first = { id: 10, name: 'real-app-journeys', created_at: '2026-11-06T02:00:00Z', expired: false };
  const second = { id: 11, name: 'real-app-journeys', created_at: '2026-11-06T03:40:00Z', expired: false };
  assert.equal(currentReportArtifact(r, [first]), null, "an earlier attempt's report is not this attempt's");
  assert.equal(currentReportArtifact(r, [first, second]).id, 11);
  assert.equal(currentReportArtifact(r, [{ ...second, expired: true }]), null);
  assert.equal(currentReportArtifact(r, [{ ...second, name: 'real-app-journeys-shard-1' }]), null);
});

test('sealPull: the title and body come from the pull request now; a moved head or a closed PR does not seal', async () => {
  const io = (pull, runs = [run(1)]) => ({
    pull: async () => pull,
    runs: async () => runs,
    // Product code with no map to read runs its bounded set, the CANARY (journey-touch.mjs pullPick), never the full suite.
    reportOf: reports({ 1: { ...green, ran: CANARY } }),
    files: async () => ['services/svc-bank/src/cards.ts'],
    verdictOf: async () => ({ red: [], failing: 0, missing: [] }),
  });
  const pull = { state: 'open', head: { sha: HEAD }, title: 'x (J-bank-13 #1 #2)', body: '' };
  assert.equal((await sealPull({ repo: REPO, number: 5, sha: HEAD, io: io(pull) })).ok, true);
  assert.equal((await sealPull({ repo: REPO, number: 5, sha: OLD, io: io(pull) })).ok, false);
  assert.equal((await sealPull({ repo: REPO, number: 5, sha: HEAD, io: io({ ...pull, state: 'closed' }) })).ok, false);
  const edited = { ...pull, title: 'x (J-bank-13 #1 #2 #3)' };
  assert.equal((await sealPull({ repo: REPO, number: 5, sha: HEAD, io: io(edited) })).ok, false, 'a step added to the title is read');
});

test('sealPull: a run on an earlier commit counts for the head only when nothing a journeys run executes changed since (#11076)', async () => {
  const io = ({ since, runsOn = { [OLD]: [run(1, { head_sha: OLD })] }, readable = true }) => ({
    pull: async () => pull,
    runs: async (sha) => runsOn[sha] ?? [],
    reportOf: reports({ 1: { ...green, ran: CANARY } }),
    files: async () => ['services/svc-bank/src/cards.ts', ...since.map((f) => f.filename)],
    verdictOf: async () => ({ red: [], failing: 0, missing: [] }),
    prCommits: async () => [OLD, HEAD],
    compare: async (base, head) => {
      if (!readable) throw new Error('HTTP 502');
      assert.equal(head, HEAD);
      return { status: 'ahead', files: since };
    },
    blobText: async (path, ref) =>
      path.endsWith('cards.ts') ? `export const x = 1; // ${ref === OLD ? 'old' : 'new'} words\n` : `x(${ref === OLD ? 1 : 2})`,
  });
  const pull = { state: 'open', head: { sha: HEAD }, title: 'x (J-bank-13 #1 #2)', body: '' };
  const seal = (o) => sealPull({ repo: REPO, number: 5, sha: HEAD, io: io(o) });
  // A comment-only push and a unit test: the run on the commit before it counts.
  const quiet = await seal({
    since: [
      { filename: 'services/svc-bank/src/cards.ts', status: 'modified' },
      { filename: 'services/svc-bank/src/cards.test.ts', status: 'modified' },
    ],
  });
  assert.equal(quiet.ok, true, quiet.lines.join('\n'));
  assert.ok(quiet.lines.some((l) => /carried: bbbbbbbbbb: .*count for the head/.test(l)));
  // Code changed since: the earlier run counts for nothing, and the head has none.
  const code = await seal({ since: [{ filename: 'services/svc-bank/src/accounts.ts', status: 'modified' }] });
  assert.equal(code.ok, false);
  // A comparison that can't be read carries nothing.
  assert.equal((await seal({ since: [], readable: false })).ok, false);
  // A red run on the earlier commit stands for the head too.
  const red = await sealPull({
    repo: REPO,
    number: 5,
    sha: HEAD,
    io: {
      ...io({ since: [{ filename: 'services/svc-bank/src/cards.test.ts', status: 'modified' }] }),
      reportOf: reports({ 1: { states: { 'J-bank-13#1': 'failed', 'J-bank-13#2': 'passed' }, ran: CANARY } }),
    },
  });
  assert.equal(red.ok, false);
});

test('stepsIn keys match the report reader (journey-verdict readReport)', () => {
  assert.deepEqual(stepsIn('J-p2p-01 #9'), ['J-p2p-01#9']);
});

// A ci.yml seal job a re-check still re-runs: one red on a step only an older ci.yml runs on a pull request (ciSealReads).
const OLD_CI_STEPS = [{ name: 'Require the named journey steps on this exact head', conclusion: 'failure' }];

test('the recheck re-runs a finished seal whatever its colour, waits out a running one, leaves an unstarted one', async () => {
  const seal = (over) => ({
    id: 9,
    name: SEAL,
    status: 'completed',
    conclusion: 'success',
    details_url: 'https://github.com/o/r/actions/runs/77/job/9',
    ...over,
  });
  const ci = (over) => ({ id: 77, event: 'pull_request', status: 'completed', ...over });
  const J = (entries) => new Map(Object.entries(entries));
  assert.equal(recheckStep([]).act, 'done', 'no CI run yet');
  assert.equal(recheckStep([ci({ event: 'merge_group' })]).act, 'done', 'only pull_request runs');
  assert.deepEqual(recheckStep([ci()]), { act: 'jobs', runId: '77', msg: "reading run 77's jobs" });
  assert.equal(recheckStep([ci({ status: 'in_progress' })], J({ 77: [] })).act, 'done', 'the seal job has not started');
  assert.equal(recheckStep([ci({ status: 'in_progress' })], J({ 77: [seal({ status: 'queued' })] })).act, 'done');
  assert.equal(recheckStep([ci()], J({ 77: [] })).act, 'fail', 'a finished run with no seal job, and no other run');
  assert.equal(recheckStep([ci({ status: 'in_progress' })], J({ 77: [seal({ status: 'in_progress' })] })).act, 'wait');
  assert.equal(recheckStep([ci({ status: 'in_progress' })], J({ 77: [seal()] })).act, 'wait', 'the run must finish before a job re-runs');
  assert.deepEqual(recheckStep([ci()], J({ 77: [seal()] })), { act: 'rerun', runId: '77', jobId: '9' }, 'a green seal is re-run too');
  assert.equal(recheckStep([ci()], J({ 77: [seal({ conclusion: 'failure' })] })).act, 'rerun');
  assert.equal(recheckStep([ci({ id: 76 }), ci({ id: 78 })], J({ 78: [seal()] })).runId, '78', 'the newest CI run decides');

  const calls = [];
  let polls = 0;
  const get = async (path) => {
    calls.push(`GET ${path}`);
    if (path.includes('/workflows/ci.yml/runs')) return { workflow_runs: [ci()] };
    return { jobs: [seal({ status: polls++ < 2 ? 'in_progress' : 'completed', conclusion: 'failure', steps: OLD_CI_STEPS })] };
  };
  const post = async (path) => (calls.push(`POST ${path}`), { status: 201 });
  const msg = await rerunSealJob({ repo: 'o/r', sha: HEAD, get, post, sleep: async () => {}, log: () => {} });
  assert.equal(msg, 're-ran the seal job 9 of run 77');
  assert.deepEqual(
    calls.filter((c) => c.startsWith('POST')),
    ['POST /repos/o/r/actions/jobs/9/rerun'],
  );
  assert.equal(calls.filter((c) => c.includes('check-runs')).length, 0, 'the Checks API is never read');
  const done = async (path) =>
    path.includes('/runs?') ? { workflow_runs: [ci()] } : { jobs: [seal({ conclusion: 'failure', steps: OLD_CI_STEPS })] };
  await assert.rejects(rerunSealJob({ repo: 'o/r', sha: HEAD, get: done, post: async () => ({ status: 500 }), sleep: async () => {} }));
  assert.match(
    await rerunSealJob({
      repo: 'o/r',
      sha: HEAD,
      get: done,
      post: async () => ({ status: 403, message: 'This workflow is already running' }),
    }),
    /already re-running/,
  );
  // AGENTS.md "Check, then merge" 6: any other 403 (a missing permission, a rate limit) or a 429 stops and is reported.
  await assert.rejects(
    rerunSealJob({
      repo: 'o/r',
      sha: HEAD,
      get: done,
      post: async () => ({ status: 403, message: 'Resource not accessible by integration' }),
    }),
    /HTTP 403/,
  );
  await assert.rejects(
    rerunSealJob({ repo: 'o/r', sha: HEAD, get: done, post: async () => ({ status: 429, message: 'rate limit' }) }),
    /HTTP 429/,
  );
});

// The second-model read of #7229 at 2c5588fa: four ways to fool the reader, each a planted fault.
test('Codex 1: an upper-case "TO" range names every step between, not only its ends', () => {
  assert.deepEqual(titleSteps('x (J-bank-13 #1 TO #4)'), ['J-bank-13#1', 'J-bank-13#2', 'J-bank-13#3', 'J-bank-13#4']);
  assert.deepEqual([...exemptions('Left-or-replaced: J-bank-13 #1 TO #3\n').steps].sort(), ['J-bank-13#1', 'J-bank-13#2', 'J-bank-13#3']);
});

test('Codex 2: a step range the parser cannot read fails the seal closed', async () => {
  assert.deepEqual(titleProblems('x (J-bank-13 #1-#100)'), ['J-bank-13 #1-#100']);
  const v = await judge({ title: 'x (J-bank-13 #1-#100)', reportOf: () => assert.fail('nothing to read') });
  assert.equal(v.ok, false);
  assert.match(v.lines.join('\n'), /can't be read as steps/);
  const mixed = await judge({ title: 'x (J-bank-13 #1 #2, J-bank-14 #3-#250)', runs: [run(1)], reportOf: reports({ 1: green }) });
  assert.equal(mixed.ok, false, 'a readable step beside an unreadable range still fails');
  assert.deepEqual(titleProblems('x (J-wallet-05 #2, #6650)'), [], 'a lone issue number is not a range');
});

test('Codex 3: an indented code line under a "Left or replaced" heading exempts nothing', () => {
  for (const b of [
    '## Left or replaced\n\n    - J-bank-13 #1\n',
    '## Left or replaced\n\n\t- J-bank-13 #1\n',
    '## Left or replaced\n- J-bank-13 #1\n',
  ])
    assert.deepEqual([...exemptions(b).steps], [], b);
});

test('Codex 4: a setext heading or thematic break opens no exemption', () => {
  for (const b of [
    'Left or replaced\n----------------\n- J-bank-13 #4\n',
    '## Left or replaced\n- J-bank-13 #1\n\nProof\n-----\n- J-bank-13 #2\n',
  ])
    assert.deepEqual([...exemptions(b).steps], [], b);
});

// Codex round 2 at bdcb884b: three more inputs that sealed with no run, each a planted fault. Each failed on bdcb884b.
const r2 = (body) =>
  judgeSteps({ sha: HEAD, repo: REPO, title: 'svc-bank: x (J-bank-13 #1)', body, runs: [], reportOf: async () => assert.fail('no run') });
test('Codex round 2, 1a: an indented "Left or replaced" over --- exempts nothing', async () => {
  assert.equal((await r2('    Left or replaced\n---\n- J-bank-13 #1')).ok, false);
});
test('Codex round 2, 1b: "Left or replaced" over a - - - break exempts nothing', async () => {
  assert.equal((await r2('Left or replaced\n- - -\n- J-bank-13 #1')).ok, false);
});
test('Codex round 2, 2: a fence inside a list hides nothing and exempts nothing', async () => {
  assert.equal((await r2('- ```\n  Left or replaced\n  ---\n  - J-bank-13 #1\n  ```')).ok, false);
  assert.equal((await r2('- ```\n  Left-or-replaced: J-bank-13 #1\n  ```')).ok, false, 'not even the exact line, inside that fence');
});
test('Codex round 2, 3: an edit to an unreadable range re-runs a green seal', () => {
  const pull = {
    number: 5,
    state: 'open',
    head: { sha: HEAD },
    base: { repo: { full_name: REPO } },
    title: 'svc-bank: x (J-bank-13 #1-#100)',
  };
  assert.deepEqual(
    recheckPulls({ pulls: [pull], sha: HEAD, repo: REPO, oldTitle: 'svc-bank: fix J-bank-13' }).map((p) => p.number),
    [5],
  );
  assert.equal(namesSteps('svc-bank: fix J-bank-13'), false);
  assert.equal(namesSteps('x (J-bank-13 #1-#100)'), true);
  const plain = { ...pull, title: 'svc-bank: fix J-bank-13' };
  assert.deepEqual(
    recheckPulls({ pulls: [plain], sha: HEAD, repo: REPO, oldTitle: 'svc-bank: fix it' }),
    [],
    'still no re-run when no title names steps',
  );
  assert.deepEqual(recheckPulls({ pulls: [{ ...pull, state: 'closed' }], sha: HEAD, repo: REPO }), []);
});

// The fresh reviewer at bdcb884b (comment 6678783654): GitHub's Revert button titles a PR `Revert "<old title>"`. It
// undoes those steps and names none of its own, so it seals like a title that names none (the floor: undo breaks fast).
test('a Revert-button title names no steps and seals without a run', async () => {
  const title = 'Revert "svc-bank: J-bank-13 I get a card (J-bank-13 #1 #2 #3) (#7202)"';
  assert.deepEqual(titleSteps(title), []);
  assert.deepEqual(titleProblems('Revert "x (J-bank-13 #1-#100)"'), []);
  assert.equal(namesSteps(title), false);
  const v = await judge({ title, reportOf: () => assert.fail('no run is read') });
  assert.equal(v.ok, true);
  assert.equal(v.state, 'none');
  assert.deepEqual(
    titleSteps('svc-bank: Revert "J-bank-13 #1" (J-bank-13 #2)'),
    ['J-bank-13#1', 'J-bank-13#2'],
    'only a title that starts with it',
  );
  assert.deepEqual(titleSteps('Reverted J-bank-13 #1 and rebuilt it'), ['J-bank-13#1']);
});

// The seal's own failure prints the exact line a
// builder adds to leave the steps that aren't green, and that line, pasted at column 0, exempts exactly those steps.
test('a failing seal prints the exact Left-or-replaced line for its steps that are not green, and it round-trips', async () => {
  const title = 'x (J-bank-13 #1 #2 #3, J-bank-14 #2)';
  const states = { 'J-bank-13#1': 'passed', 'J-bank-13#2': 'failed', 'J-bank-14#2': 'skipped' };
  const v = await judge({ title, runs: [run(1)], reportOf: reports({ 1: { states } }) });
  assert.equal(v.ok, false);
  const line = v.lines.map((l) => /(Left-or-replaced: .*)$/.exec(l)?.[1]).find(Boolean);
  assert.equal(line, 'Left-or-replaced: J-bank-13 #2 #3, J-bank-14 #2');
  assert.deepEqual([...exemptions(`${line}\n`).steps].sort(), ['J-bank-13#2', 'J-bank-13#3', 'J-bank-14#2']);
  const sealed = await judge({ title, body: `## Left or replaced\n\n${line}\n`, runs: [run(1)], reportOf: reports({ 1: { states } }) });
  assert.equal(sealed.ok, true, sealed.lines.join('\n'));
  const waiting = await judge({
    title: 'x (J-bank-13 #4)',
    runs: [run(2, { status: 'in_progress', conclusion: null })],
    reportOf: reports({}),
  });
  assert.match(waiting.lines.join('\n'), /Left-or-replaced: J-bank-13 #4$/m, 'a seal waiting on a run prints it too');
  const sealedGreen = await judge({ runs: [run(1)], reportOf: reports({ 1: green }) });
  assert.equal(
    sealedGreen.lines.some((l) => l.includes('Left-or-replaced:')),
    false,
    'a green seal prints none',
  );
});

// Second-model read at f30df036: a Revert title is only the whole of GitHub's form, `Revert "<anything>"`, quote closed and
// nothing after it. Anything else is read as usual, so a title that reverts and also implements a step needs its run.
test('a Revert title is only the exact form; extra text or an unclosed quote is read as usual', async () => {
  assert.deepEqual(titleSteps('Revert "old" and implement J-bank-13 #2'), ['J-bank-13#2']);
  assert.deepEqual(titleSteps('Revert "svc-bank: J-bank-13 #1 #2 (#7202)'), ['J-bank-13#1', 'J-bank-13#2'], 'an unclosed quote');
  assert.deepEqual(titleSteps('Revert "x (J-bank-13 #1)" (J-bank-13 #3)'), ['J-bank-13#1', 'J-bank-13#3']);
  assert.deepEqual(titleProblems('Revert "old" then J-bank-13 #1-#100'), ['J-bank-13 #1-#100']);
  const v = await judge({ title: 'Revert "old" and implement J-bank-13 #2', reportOf: async () => assert.fail('no run') });
  assert.equal(v.ok, false);
  assert.deepEqual(titleSteps('Revert "svc-bank: J-bank-13 "cards" (J-bank-13 #1) (#7202)"'), [], 'the exact form, quotes inside');
});

// Second-model read at f30df036: the recheck re-runs the newest pull_request run that has a seal job. A newer run that
// finished with none (cancelled before its jobs) does not hide an older run's seal.
test('the recheck skips a finished CI run with no seal job and re-runs the newest seal there is', async () => {
  const sealJob = (id, over) => ({ id, name: SEAL, status: 'completed', conclusion: 'failure', steps: OLD_CI_STEPS, ...over });
  const ci = (id, over) => ({ id, event: 'pull_request', status: 'completed', ...over });
  const runs = [ci(78, { conclusion: 'cancelled' }), ci(77)];
  const jobs = { 78: [], 77: [sealJob(9)] };
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    if (path.includes('/workflows/ci.yml/runs')) return { workflow_runs: runs };
    return { jobs: jobs[/\/runs\/(\d+)\/jobs/.exec(path)[1]] };
  };
  const msg = await rerunSealJob({
    repo: 'o/r',
    sha: HEAD,
    get,
    post: async () => ({ status: 201 }),
    sleep: async () => {},
    log: () => {},
  });
  assert.equal(msg, 're-ran the seal job 9 of run 77');
  // A newer run still going with its seal not started: that seal reads for itself.
  const going = { 79: [], 77: [sealJob(9)] };
  const get2 = async (path) =>
    path.includes('/workflows/ci.yml/runs')
      ? { workflow_runs: [ci(79, { status: 'in_progress' }), ci(77)] }
      : { jobs: going[/\/runs\/(\d+)\/jobs/.exec(path)[1]] };
  assert.match(
    await rerunSealJob({ repo: 'o/r', sha: HEAD, get: get2, post: async () => assert.fail('no re-run'), sleep: async () => {} }),
    /has not started/,
  );
  // No run on the head has a seal job: that is said, never passed.
  const get3 = async (path) => (path.includes('/workflows/ci.yml/runs') ? { workflow_runs: [ci(78)] } : { jobs: [] });
  await assert.rejects(
    rerunSealJob({ repo: 'o/r', sha: HEAD, get: get3, post: async () => ({ status: 201 }), sleep: async () => {} }),
    /no CI run on this head has a CI merge seal job/,
  );
});

// ---- Shared journey setup (SHARED_SETUP) ----

test('shared setup: the list, and what is not on it', () => {
  for (const f of [
    'tooling/scripts/local-stack-services/identity.mjs',
    'tooling/scripts/local-test-world.mjs',
    'tooling/scripts/local-test-world.test.mjs',
    'tooling/scripts/local-test-merchant-pricing.mjs',
    'apps/customer/tests/real-app/staff.mjs',
    'apps/customer/tests/real-app/real-app.playwright.config.mjs',
    'tooling/scripts/local-test-market.mjs', // #7191: the TEST market maker's first cycle clears an earlier run's quotes
    'tooling/scripts/local-test-stack.mjs',
    'tooling/scripts/local-test-seed.mjs',
    'tooling/scripts/local-test-compose-env.mjs',
    'tooling/scripts/local-stack-fixtures/a/b.json',
    'tooling/scripts/journey-world.mjs',
  ])
    assert.equal(isSharedSetup(f), true, f);
  for (const f of [
    'apps/customer/tests/real-app/J-bank-13.pw.mjs',
    'apps/customer/src/features/more/Support.tsx',
    'services/svc-support/src/chat.ts',
    'xtooling/scripts/local-stack-services/a.mjs',
    'tooling/scripts/local-test-market.mjs.bak',
    'tooling/scripts/sub/local-test-market.mjs',
    'tooling/scripts/journey-world.test.mjs',
    'tooling/scripts/local-founder-seed.mjs',
  ])
    assert.equal(isSharedSetup(f), false, f);
  assert.equal(SHARED_SETUP.length, 5);
  assert.deepEqual(
    pullFilePaths([{ filename: 'a/new.mjs', previous_filename: 'tooling/scripts/local-test-world.mjs' }]),
    ['a/new.mjs', 'tooling/scripts/local-test-world.mjs'],
    'a file renamed out of the list still counts',
  );
});

const fullRep = { states: { 'J-a-01#1': 'passed' }, files: { 'J-a-01#1': 'J-a-01.pw.mjs', 'J-b-01#1': 'J-b-01.pw.mjs' } };
const clean = { red: [], failing: 3, missing: [] };
const dirty = { red: [{ step: 'J-wallet-05#3', why: 'failing, not in the baseline', money: false }], failing: 4, missing: [] };

test('sealPull: shared setup and product code the map cannot narrow need their bounded set run clean, never the full suite (project-state#3377)', async () => {
  // With no map to read (this io has none), the bounded set is the CANARY (journey-touch.mjs pullPick).
  const bounded = { states: { 'J-p2p-01#1': 'passed' }, ran: CANARY };
  const io = ({ files, verdict = clean, runs = [run(1)], rep = bounded }) => ({
    pull: async () => ({ state: 'open', head: { sha: HEAD }, title: 'stack: identity gets its TEST staff roster', body: '' }),
    runs: async () => runs,
    reportOf: reports({ 1: rep }),
    files: async () => files,
    verdictOf: async () => verdict,
  });
  const shared = ['tooling/scripts/local-stack-services/identity.mjs'];
  const dirtySeal = await sealPull({ repo: REPO, number: 7, sha: HEAD, io: io({ files: shared, verdict: dirty }) });
  assert.equal(dirtySeal.ok, false, 'shared setup with a dirty run of its bounded set fails');
  assert.equal(dirtySeal.stepsOk, true);
  assert.equal(dirtySeal.fullOk, false);
  const ok = await sealPull({ repo: REPO, number: 7, sha: HEAD, io: io({ files: shared }) });
  assert.equal(ok.ok, true, 'with a clean one passes');
  assert.match(ok.lines.join('\n'), /main's full run after the merge judges the rest/);
  assert.doesNotMatch(ok.lines.join('\n'), /full run: /, 'no full run is asked for');
  assert.equal((await sealPull({ repo: REPO, number: 7, sha: HEAD, io: io({ files: shared, runs: [] }) })).ok, false, 'with none fails');
  // Planted: a run short of one CANARY file fails, so the bounded set is held whole.
  const short = await sealPull({ repo: REPO, number: 7, sha: HEAD, io: io({ files: shared, rep: { ...bounded, ran: CANARY.slice(1) } }) });
  assert.equal(short.ok, false, 'a run missing a file of the bounded set fails');
  assert.match(short.lines.join('\n'), new RegExp(CANARY[0].replace(/\./g, '\\.')));
  // Product code no recorded map narrows runs the same bounded set; a pull request touching nothing a journeys run reads
  // needs none.
  const product = (over) =>
    sealPull({ repo: REPO, number: 7, sha: HEAD, io: io({ files: ['services/svc-support/src/chat.ts'], ...over }) });
  const none = await product({ runs: [] });
  assert.equal(none.ok, false, 'planted: product code with no run on its head fails');
  assert.equal(none.fullOk, false);
  assert.match(none.lines.join('\n'), /services\/svc-support\/src\/chat\.ts: product code/);
  assert.equal((await product({ verdict: dirty })).ok, false, 'product code with a dirty run fails');
  assert.equal((await product({})).ok, true, 'product code with a clean run of its bounded set passes');
  const plain = await sealPull({
    repo: REPO,
    number: 7,
    sha: HEAD,
    io: io({ files: ['.github/workflows/ci.yml', 'services/svc-support/src/chat.test.ts'], verdict: dirty, runs: [] }),
  });
  assert.equal(plain.ok, true, 'a pull request touching nothing a journeys run reads is unaffected');
  assert.deepEqual(plain.lines, [`#7 (${HEAD.slice(0, 10)}): the title names no journey step`]);
  // Named steps and shared setup together: both must hold.
  const both = (verdict) => ({
    ...io({ files: shared, verdict }),
    pull: async () => ({ state: 'open', head: { sha: HEAD }, title: 'x (J-bank-13 #1 #2)', body: '' }),
    reportOf: reports({ 1: { ...bounded, states: green.states } }),
  });
  assert.equal((await sealPull({ repo: REPO, number: 7, sha: HEAD, io: both(clean) })).ok, true);
  assert.equal(
    (await sealPull({ repo: REPO, number: 7, sha: HEAD, io: both(dirty) })).ok,
    false,
    'green named steps do not cover a dirty run of the bounded set',
  );
});

test('the recheck takes a shared-setup pull request whose title names no step', async () => {
  const p = (number, title) => ({ number, title, state: 'open', head: { sha: HEAD }, base: { repo: { full_name: REPO } } });
  const pulls = [p(1, 'stack: staff roster'), p(2, 'svc-support: chat'), p(3, 'x (J-bank-13 #1)')];
  const files = { 1: ['tooling/scripts/local-stack-services/identity.mjs'], 2: ['services/svc-support/src/chat.ts'], 3: [] };
  const asked = [];
  pulls.push(p(4, 'ci: a check'));
  files[4] = ['.github/workflows/ci.yml'];
  const shared = await sharedPulls({ pulls, sha: HEAD, repo: REPO, filesOf: async (n) => (asked.push(n), files[n]) });
  assert.deepEqual([...shared], [1, 2], 'shared setup and product code both need a journeys run (journey-touch.mjs)');
  assert.deepEqual(asked, [1, 2, 4], 'a title that names steps is taken without reading its files');
  assert.deepEqual(
    recheckPulls({ pulls, sha: HEAD, repo: REPO, shared }).map((x) => x.number),
    [1, 2, 3],
  );
});

test("fullVerdict: the journeys verdict's own rules with the given baseline, and a report short of journey files", () => {
  const spec = (title, status, file) => ({ title, file, tests: [{ status }] });
  const rep = (...specs) => readReport({ suites: [{ file: 'J-a-01.pw.mjs', specs }] });
  const named = rep(
    spec('J-a-01 #1', 'expected', 'J-a-01.pw.mjs'),
    spec('J-a-01 #2', 'unexpected', 'J-a-01.pw.mjs'),
    spec('J-b-01 #1', 'expected', 'J-b-01.pw.mjs'),
  );
  const inputs = {
    baseline: { run: { number: 100, id: 1 }, steps: [{ step: 'J-a-01#2', state: 'unbuilt', money: false }] },
    money: { 'J-a-01#1': false, 'J-a-01#2': false, 'J-b-01#1': false },
    reports: new Map(),
  };
  const read = () => ({ named, passedSince: {}, issues: {}, problems: [] });
  const v = (report, r = read) => fullVerdict({ repo: REPO, report, run: run(1), inputs, read: r });
  const ok = v(
    rep(
      spec('J-a-01 #1', 'expected', 'J-a-01.pw.mjs'),
      spec('J-a-01 #2', 'unexpected', 'J-a-01.pw.mjs'),
      spec('J-b-01 #1', 'expected', 'J-b-01.pw.mjs'),
    ),
  );
  assert.deepEqual([ok.red, ok.failing, ok.missing], [[], 1, []], 'only the listed unbuilt step fails: clean');
  const bad = v(
    rep(
      spec('J-a-01 #1', 'unexpected', 'J-a-01.pw.mjs'),
      spec('J-a-01 #2', 'unexpected', 'J-a-01.pw.mjs'),
      spec('J-b-01 #1', 'expected', 'J-b-01.pw.mjs'),
    ),
  );
  assert.deepEqual(
    bad.red.map((r) => [r.step, r.why]),
    [['J-a-01#1', 'failing, not in the baseline']],
  );
  const part = v(rep(spec('J-a-01 #1', 'expected', 'J-a-01.pw.mjs')));
  assert.deepEqual(part.missing, ['J-b-01.pw.mjs'], 'a targeted report lacks a journey file of the full suite');
  assert.deepEqual(part.red, [], 'judged on the files it has, it is clean there');
  const partBad = v(rep(spec('J-a-01 #1', 'unexpected', 'J-a-01.pw.mjs'), spec('J-a-01 #2', 'unexpected', 'J-a-01.pw.mjs')));
  assert.deepEqual(
    [partBad.missing, partBad.red.map((r) => r.step)],
    [['J-b-01.pw.mjs'], ['J-a-01#1']],
    'a red step in the files it has is red',
  );
  const blind = v(rep(), () => ({
    named: null,
    passedSince: {},
    issues: {},
    problems: ["the baseline's named run report couldn't be read"],
  }));
  assert.equal(blind.red.length, 1, 'an unreadable input is red');
});

test("SHARED_SETUP and real-app-journeys.yml's push trigger do not drift", () => {
  const yml = readFileSync(new URL('../../.github/workflows/real-app-journeys.yml', import.meta.url), 'utf8');
  const push = /\n  push:\n    branches: \[main\]\n    paths:\n((?:      (?:- '[^']+'|#.*)\n)+)/.exec(yml);
  assert.ok(push, "the push trigger's paths list is where this test reads it");
  const paths = [...push[1].matchAll(/^      - '([^']+)'$/gm)].map((m) => m[1]);
  for (const e of SHARED_SETUP) assert.ok(paths.includes(e.trigger ?? e.glob), `the push trigger lists ${e.trigger ?? e.glob}`);
  for (const e of SHARED_SETUP.filter((x) => x.trigger))
    assert.ok(globRe(e.trigger).test(e.glob.replace(/\*+/g, 'x')), `${e.trigger} covers ${e.glob}`);
  assert.equal(globRe('tooling/scripts/local-test-*.mjs').test('tooling/scripts/local-stack-services/a.mjs'), false, 'why both are listed');
  // GitHub's `*` stays within one folder; only `**` crosses a `/` (review round 2 of #7431: no test failed when `*` crossed).
  assert.equal(globRe('tooling/scripts/local-test-*.mjs').test('tooling/scripts/local-test-x/y.mjs'), false, '`*` does not cross a `/`');
  assert.equal(globRe('tooling/scripts/local-stack-services/**').test('tooling/scripts/local-stack-services/a/b.mjs'), true, '`**` does');
});

// ---- A pull request that changes a journey test names the steps it touches (judgeTouched) ----

// A journey file's text, kept as data in its own file: a skip line typed into a test file reads as a skipped test.
const BANK13 = readFileSync(new URL('./fixtures/journey-seal-bank13.txt', import.meta.url), 'utf8');

test('fileSteps: the steps a journey test file holds, by ${J} or written out, never a mention', () => {
  assert.deepEqual(fileSteps('J-bank-13', BANK13), ['J-bank-13#1', 'J-bank-13#2', 'J-bank-13#3']);
  assert.deepEqual(
    fileSteps('J-bank-1', BANK13),
    ['J-bank-1#1', 'J-bank-1#2'],
    "another journey's written-out title is not read as this one's",
  );
});

const touchedPull = async ({
  title,
  body = '',
  files = ['apps/customer/tests/real-app/J-bank-13.pw.mjs'],
  text = { 'apps/customer/tests/real-app/J-bank-13.pw.mjs': BANK13 },
  states = { 'J-bank-13#1': 'passed', 'J-bank-13#2': 'passed', 'J-bank-13#3': 'passed' },
  runs = [run(1)],
  baseText = {},
  ran = ['J-bank-13.pw.mjs'],
}) =>
  sealPull({
    repo: REPO,
    number: 8,
    sha: HEAD,
    io: {
      pull: async () => ({ state: 'open', head: { sha: HEAD }, base: { sha: OLD }, title, body }),
      runs: async () => runs,
      reportOf: reports({
        // The CANARY too: a product path no map narrows runs its bounded set (journey-touch.mjs pullPick).
        1: { states, ran: [...ran, ...CANARY] },
      }),
      // The run on the head is clean by the journeys verdict, so these cases judge the step naming alone.
      verdictOf: async () => ({ red: [], failing: 0, missing: [] }),
      files: async () => files,
      text: async (f, ref) => (ref === HEAD ? (text[f] ?? null) : ref === OLD ? (baseText[f] ?? null) : null),
    },
  });

// A step of the touched file that fails on the head (#2), for the planted cases below.
const RED2 = { 'J-bank-13#1': 'passed', 'J-bank-13#2': 'failed', 'J-bank-13#3': 'passed' };

test('the seal gap (#1249): a journey test change whose title names no step is judged on every step the file holds', async () => {
  const green = await touchedPull({ title: 'test(journeys): J-bank-13 waits for the card list' });
  assert.equal(green.ok, true, 'all of them passing on the head: no body line needed (owner, 21 Nov 2026)');
  const text = green.lines.join('\n');
  assert.match(text, /J-bank-13\.pw\.mjs changes the tests of J-bank-13 #1, J-bank-13 #2, J-bank-13 #3, .*so the seal judges them all/);
  for (const k of ['J-bank-13#1', 'J-bank-13#2', 'J-bank-13#3']) assert.match(text, new RegExp(`${k}: passed in run 1`));
  // Planted: what the old seal stopped for a missing line, with a step failing, still fails, and prints the line that
  // would leave it.
  const red = await touchedPull({ title: 'test(journeys): J-bank-13 waits for the card list', states: RED2 });
  assert.equal(red.ok, false, 'a derived step failing on the head fails the seal, as a named one does');
  assert.match(red.lines.join('\n'), /J-bank-13#2: failed in run 1/);
  assert.match(red.lines.join('\n'), /Left-or-replaced: J-bank-13 #2$/m);
  const missing = await touchedPull({ title: 'x', states: { 'J-bank-13#1': 'passed', 'J-bank-13#2': 'passed' } });
  assert.equal(missing.ok, false, 'a derived step no run on the head reports fails');
  assert.match(missing.lines.join('\n'), /J-bank-13#3: no finished Real-app journeys run on this head reports it/);
  assert.equal((await touchedPull({ title: 'x', runs: [] })).ok, false, 'no run on the head at all');
  assert.equal(
    (await touchedPull({ title: 'x', states: RED2, body: 'Left-or-replaced: J-bank-13 #2\n' })).ok,
    true,
    'the line keeps its real use: leaving the step that fails',
  );
});

test('JOURNEY_TEST: whole and split journey files, never the look sweeps', () => {
  const id = (f) => JOURNEY_TEST.exec(`apps/customer/tests/real-app/${f}`)?.[1] ?? null;
  assert.equal(id('J-bank-13.pw.mjs'), 'J-bank-13');
  assert.equal(id('J-ops-console-02-documents.pw.mjs'), 'J-ops-console-02');
  assert.equal(id('J-wallet-04-security-lock.pw.mjs'), 'J-wallet-04');
  assert.equal(id('J-copy-bots-otc-30.pw.mjs'), 'J-copy-bots-otc-30');
  assert.equal(id('look-sweep-390.pw.mjs'), null);
  assert.equal(id('J-bank-13.mjs'), null);
  assert.equal(JOURNEY_TEST.test('apps/customer/tests/real-app/sub/J-bank-13.pw.mjs'), false);
});

test('a journey test change passes when the title names its steps or a strict line leaves them', async () => {
  assert.equal((await touchedPull({ title: 'test(journeys): J-bank-13 #2 waits for the card list' })).ok, true);
  assert.equal((await touchedPull({ title: 'test(journeys): waits', body: 'Left-or-replaced: J-bank-13 #3' })).ok, true);
  assert.equal(
    (
      await touchedPull({
        title: 'customer: copy',
        files: ['apps/customer/src/x.ts', 'apps/customer/tests/real-app/look-sweep-390.pw.mjs'],
      })
    ).ok,
    true,
    'no journey test changed: unchanged',
  );
});

test('planted: a title naming another journey, a malformed line, an unreadable file', async () => {
  const wrong = await touchedPull({ title: 'test(journeys): J-bank-14 #2 waits for the card list', states: RED2 });
  assert.equal(wrong.ok, false, "another journey's step does not cover this file: its own are judged");
  assert.match(wrong.lines.join('\n'), /J-bank-13\.pw\.mjs changes the tests of/);
  assert.match(wrong.lines.join('\n'), /J-bank-13#2: failed in run 1/);
  const bad = await touchedPull({ title: 'test(journeys): waits', body: '- Left-or-replaced: J-bank-13 #2', states: RED2 });
  assert.equal(bad.ok, false, 'an exemption-like line that is not one leaves nothing');
  assert.match(bad.lines.join('\n'), /J-bank-13#2: failed in run 1/);
  assert.equal(
    (await touchedPull({ title: 'x', body: 'Left-or-replaced: J-bank-13 #9', states: RED2 })).ok,
    false,
    'a step the file does not hold covers nothing',
  );
  const empty = await touchedPull({ title: 'x (J-bank-13 #1)', text: { 'apps/customer/tests/real-app/J-bank-13.pw.mjs': '// nothing' } });
  assert.equal(empty.ok, false, 'a journey file with no readable step fails closed');
  await assert.rejects(
    touchedSteps({ paths: ['apps/customer/tests/real-app/J-bank-13.pw.mjs'], head: HEAD, base: OLD, text: async () => null }),
  );
  assert.deepEqual(
    await touchedSteps({
      paths: ['apps/customer/tests/real-app/J-bank-13.pw.mjs'],
      head: HEAD,
      base: OLD,
      text: async (_f, ref) => (ref === OLD ? BANK13 : null),
    }),
    [{ file: 'apps/customer/tests/real-app/J-bank-13.pw.mjs', journey: 'J-bank-13', steps: ['J-bank-13#1', 'J-bank-13#2', 'J-bank-13#3'] }],
    'a file the head removed is read at the base',
  );
  assert.deepEqual(judgeTouched({ title: 'x', body: '', touched: [] }), { ok: true, lines: [] });
});

test('titleBeforePush: a title naming none of the steps is no longer refused (the seal judges them); an unreadable one still is', () => {
  const t = (journey, steps = [1, 2, 3].map((n) => `${journey}#${n}`)) => [
    { file: `apps/customer/tests/real-app/${journey}.pw.mjs`, journey, steps },
  ];
  assert.deepEqual(
    titleBeforePush({ title: null, touched: t('J-bank-13') }),
    { ok: true, need: ['J-bank-13 #1 #2 #3'] },
    'no pull request yet',
  );
  // The titles #8469 and #8478 first had, refused before 21 Nov 2026: the seal now judges their steps on the head.
  assert.deepEqual(titleBeforePush({ title: 'fix(svc-ws): TEST limits (#8311)', touched: t('J-dev-01') }), {
    ok: true,
    need: ['J-dev-01 #1 #2 #3'],
  });
  assert.equal(titleBeforePush({ title: 'tests(J-dev-01): first (#8477)', touched: t('J-dev-01') }).ok, true);
  assert.equal(titleBeforePush({ title: 'tests(J-dev-01 #2): first', touched: t('J-dev-01') }).ok, true);
  assert.equal(titleBeforePush({ title: 'tests(J-dev-02 #2): first', touched: t('J-dev-01') }).ok, true, "another journey's steps");
  assert.equal(titleBeforePush({ title: 'x', body: 'Left-or-replaced: J-dev-01 #3', touched: t('J-dev-01') }).ok, true, 'a strict line');
  assert.equal(titleBeforePush({ title: 'x J-dev-01 #2-120', touched: t('J-dev-01') }).ok, false, 'an unreadable range');
  const none = titleBeforePush({ title: 'x', touched: t('J-dev-01', []) });
  assert.equal(none.ok, false, 'a journey file with no readable step');
  assert.match(none.lines.join('\n'), /the seal fails closed/);
});

// ---- A journey split across files: a companion file of unnumbered checks beside the file holding its steps ----

// A journey test file's text from its titles, written so no `test(` call is typed into this file.
const pwText = (...titles) => `const J = 'J-x-04';\n${titles.map((t) => `${'test'}(\`${t}\`, async () => {});`).join('\n')}\n`;
const X04 = 'apps/customer/tests/real-app/J-x-04.pw.mjs';
const X04_VENUE = 'apps/customer/tests/real-app/J-x-04-venue.pw.mjs';
const VENUE = pwText(...[1, 2, 3, 4, 5, 6, 7].map((n) => `\${J} #${n} on the venue`));
const CUSTODIAL_BASE = pwText(
  '${J} #1, the custodial branch: orders',
  '${J} #2, the custodial branch: origin',
  '${J}, the custodial branch: refused',
);
const CUSTODIAL_HEAD = pwText(
  '${J}, the custodial branch: orders',
  '${J}, the custodial branch: origin',
  '${J}, the custodial branch: refused',
);
const X04_STATES = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [`J-x-04#${n}`, 'passed']));
const xText = (at) => async (f, ref) => at[ref]?.[f] ?? null;
const xFiles = async () => new Set(['J-x-04.pw.mjs', 'J-x-04-venue.pw.mjs', 'J-x-05.pw.mjs', 'look-sweep-390.pw.mjs']);

test('#10825: retitling the last numbered steps out of a companion file judges the steps its base held, on the head', async () => {
  const touched = await touchedSteps({
    paths: [X04, X04_VENUE],
    head: HEAD,
    base: OLD,
    text: xText({ [HEAD]: { [X04]: CUSTODIAL_HEAD, [X04_VENUE]: VENUE }, [OLD]: { [X04]: CUSTODIAL_BASE, [X04_VENUE]: VENUE } }),
    journeyFiles: xFiles,
  });
  const custodial = touched.filter((t) => t.file === X04);
  assert.deepEqual(custodial, [{ file: X04, journey: 'J-x-04', steps: ['J-x-04#1', 'J-x-04#2'], from: 'base' }]);
  // #10825's own title names them: they are judged as title steps, on the head, where the venue file holds them.
  assert.equal(judgeTouched({ title: 'tests: J-x-04 #1 #2 #3 #4 #5 #7 retitle custodial checks', body: '', touched }).ok, true);
  // A title naming none: the base's steps are derived and judged on the head, never dropped.
  const v = judgeTouched({ title: 'tests: retitle custodial checks', body: '', touched: custodial });
  assert.equal(v.ok, true);
  assert.deepEqual(v.derived, ['J-x-04#1', 'J-x-04#2']);
  assert.match(
    v.lines.join('\n'),
    /J-x-04\.pw\.mjs retitles out the last of its steps, J-x-04 #1, J-x-04 #2, .*judges them all on this head/,
  );
  assert.deepEqual(titleBeforePush({ title: null, touched: custodial }), { ok: true, need: ['J-x-04 #1 #2'] });
  // The whole seal: both steps pass on the head (from the venue file), so it passes with no body line.
  const files = [X04, X04_VENUE];
  const text = { [X04]: CUSTODIAL_HEAD, [X04_VENUE]: VENUE };
  const baseText = { [X04]: CUSTODIAL_BASE, [X04_VENUE]: VENUE };
  const ran = ['J-x-04.pw.mjs', 'J-x-04-venue.pw.mjs'];
  const green = await touchedPull({ title: 'tests: retitle custodial checks', files, text, baseText, states: X04_STATES, ran });
  assert.equal(green.ok, true, green.lines.join('\n'));
  assert.match(green.lines.join('\n'), /J-x-04#1: passed in run 1/);
  // Planted: #1 failing on the head and named nowhere still fails the seal, and the line that would leave it is printed.
  const red = { ...X04_STATES, 'J-x-04#1': 'failed' };
  const bad = await touchedPull({ title: 'tests: retitle custodial checks', files: [X04], text, baseText, states: red, ran });
  assert.equal(bad.ok, false, 'a step retitled out of the file is still judged on the head');
  assert.match(bad.lines.join('\n'), /J-x-04#1: failed in run 1/);
  assert.match(bad.lines.join('\n'), /Left-or-replaced: J-x-04 #1$/m);
  const gone = await touchedPull({ title: 'x', files: [X04], text, baseText, states: { 'J-x-04#2': 'passed' }, ran });
  assert.equal(gone.ok, false, 'a retitled step no run on the head reports fails');
  assert.match(gone.lines.join('\n'), /J-x-04#1: no finished Real-app journeys run on this head reports it/);
});

test('a companion file with no numbered step at the head or the base passes when another file of its journey holds them', async () => {
  const at = { [HEAD]: { [X04]: CUSTODIAL_HEAD, [X04_VENUE]: VENUE }, [OLD]: { [X04]: CUSTODIAL_HEAD.replace('refused', 'no') } };
  const touched = await touchedSteps({ paths: [X04], head: HEAD, base: OLD, text: xText(at), journeyFiles: xFiles });
  assert.deepEqual(touched, [{ file: X04, journey: 'J-x-04', steps: [], siblings: [X04_VENUE] }]);
  const v = judgeTouched({ title: 'tests: J-x-04 custodial check waits', body: '', touched });
  assert.equal(v.ok, true);
  assert.deepEqual(v.derived, []);
  assert.match(
    v.lines.join('\n'),
    /J-x-04's steps live in .*J-x-04-venue\.pw\.mjs, so it changes none, and its run on this head must still be clean/,
  );
  assert.deepEqual(titleBeforePush({ title: 'x', touched }), { ok: true, need: [] });
  // A new companion file (no base) is the same.
  const fresh = await touchedSteps({ paths: [X04], head: HEAD, base: OLD, text: xText({ [HEAD]: at[HEAD] }), journeyFiles: xFiles });
  assert.equal(judgeTouched({ title: 'x', body: '', touched: fresh }).ok, true);
});

test('planted: a file with no numbered step anywhere still fails closed when no file of its journey holds one', async () => {
  const X99 = 'apps/customer/tests/real-app/J-x-99.pw.mjs';
  const typo = pwText('J-x-99 step 1 opens it', 'J-x-99 step 2 closes it');
  const list = async () => new Set(['J-x-99.pw.mjs', 'J-x-99-notes.pw.mjs', 'J-x-990.pw.mjs', 'J-x-04-venue.pw.mjs']);
  const at = {
    [HEAD]: {
      [X99]: typo,
      'apps/customer/tests/real-app/J-x-99-notes.pw.mjs': typo,
      'apps/customer/tests/real-app/J-x-990.pw.mjs': pwText('J-x-990 #1 x'),
      [X04_VENUE]: VENUE,
    },
    [OLD]: { [X99]: typo },
  };
  const touched = await touchedSteps({ paths: [X99], head: HEAD, base: OLD, text: xText(at), journeyFiles: list });
  assert.deepEqual(touched, [{ file: X99, journey: 'J-x-99', steps: [], siblings: [] }], "another journey's steps are no sibling's");
  for (const title of ['x', 'tests: J-x-99 #1 #2', 'tests: J-x-04 #1']) {
    const v = judgeTouched({ title, body: 'Left-or-replaced: J-x-99 #1', touched });
    assert.equal(v.ok, false, title);
    assert.match(
      v.lines.join('\n'),
      /J-x-99\.pw\.mjs changes a journey test, but no `test\(` titled `J-x-99 #n` could be read in it.*fails closed/,
    );
  }
  assert.equal(titleBeforePush({ title: 'x', touched }).ok, false);
  // Without a way to list the journey's files, nothing is a sibling: it fails closed as before.
  const blind = await touchedSteps({
    paths: [X04],
    head: HEAD,
    base: OLD,
    text: xText({ [HEAD]: { [X04]: CUSTODIAL_HEAD, [X04_VENUE]: VENUE } }),
  });
  assert.equal(judgeTouched({ title: 'x', body: '', touched: blind }).ok, false);
  // Through the whole seal, whose io here lists no journey files: the companion file alone fails closed.
  const sealed = await touchedPull({
    title: 'tests: J-x-04 custodial check',
    files: [X04],
    text: { [X04]: CUSTODIAL_HEAD },
    ran: ['J-x-04.pw.mjs'],
  });
  assert.equal(sealed.ok, false);
});

test('the recheck takes a pull request whose body gained an exemption line, so leaving steps there re-runs the seal', () => {
  const p = {
    number: 9,
    title: 'test(journeys): waits',
    body: 'Left-or-replaced: J-bank-13 #3',
    state: 'open',
    head: { sha: HEAD },
    base: { repo: { full_name: REPO } },
  };
  assert.deepEqual(
    recheckPulls({ pulls: [p], sha: HEAD, repo: REPO }).map((x) => x.number),
    [9],
  );
});

test("a GitHub revert of a journey-test PR passes; a fake Revert title without GitHub's body line does not", async () => {
  const revert = await touchedPull({
    title: 'Revert "test(journeys): J-bank-13 waits for the card list"',
    body: 'Reverts INTAFACED/intafaced#7434',
  });
  assert.equal(revert.ok, true, "GitHub's Revert form is never slowed by a body line (OWNER 180)");
  assert.match(revert.lines.join('\n'), /a revert of #7434/);
  const fake = await touchedPull({
    title: 'Revert "test(journeys): J-bank-13 waits for the card list"',
    body: 'undoes the flaky wait',
    states: RED2,
  });
  assert.equal(fake.ok, false, 'a Revert title alone is not a revert: its steps are judged');
  assert.match(fake.lines.join('\n'), /J-bank-13\.pw\.mjs changes the tests of/);
  assert.equal(
    (await touchedPull({ title: 'Revert "x"', body: 'Reverts someone/else#7434', states: RED2 })).ok,
    false,
    "another repository's PR is not this one's revert",
  );
  assert.equal(
    (await touchedPull({ title: 'Revert "x" and more', body: 'Reverts INTAFACED/intafaced#7434', states: RED2 })).ok,
    false,
    'more after the quote',
  );
  assert.equal(
    (await touchedPull({ title: 'Revert "x"', body: '  Reverts INTAFACED/intafaced#7434', states: RED2 })).ok,
    false,
    'the line at column 0 only',
  );
});

test('the recheck takes a pull request whose body lost its exemption line (OLD_BODY), so removing it re-runs the seal', () => {
  const p = {
    number: 10,
    title: 'test(journeys): waits',
    body: 'nothing left here',
    state: 'open',
    head: { sha: HEAD },
    base: { repo: { full_name: REPO } },
  };
  assert.deepEqual(recheckPulls({ pulls: [p], sha: HEAD, repo: REPO }), [], 'no line now and no old body: left alone');
  assert.deepEqual(
    recheckPulls({ pulls: [p], sha: HEAD, repo: REPO, oldBody: 'Left-or-replaced: J-bank-13 #3' }).map((x) => x.number),
    [10],
  );
});

// 7 Nov 2026, #7398: a job re-run is a new attempt of its CI run, and it joins ci.yml's concurrency group
// (CI-refs/pull/<n>/merge, cancel-in-progress off main), so it cancels whatever CI run of that pull request is in flight.
// The re-check acts only when the run's head is the pull request's current head and no CI run on that head is going;
// each skip has its own test, and each test fails on its own planted fault.
const STALE_OLD = 'b'.repeat(40);
const STALE_NEW = 'c'.repeat(40);
const recheckSeal = (over) => ({ id: 9, name: SEAL, status: 'completed', conclusion: 'failure', steps: OLD_CI_STEPS, ...over });
const ciRun = (id, over) => ({ id, event: 'pull_request', status: 'completed', head_sha: STALE_OLD, ...over });
const pr7398 = (over) => ({ number: 7398, state: 'open', head: { sha: STALE_OLD, ref: 'b1' }, ...over });
// `runs(i)` and `jobs(i)` answer the i-th read of the head's runs; `blocker(i)` is read with the same counter, so a
// stand-in can answer differently before and after the wait.
const recheckWith = async ({ runs, jobs, blocker }) => {
  const posts = [];
  let n = 0;
  const get = async (path) => (path.includes('/workflows/ci.yml/runs') ? { workflow_runs: runs(n++) } : { jobs: jobs(n) });
  const post = async (path) => (posts.push(path), { status: 201 });
  const out = await rerunSealJob({
    repo: 'o/r',
    sha: STALE_OLD,
    get,
    post,
    blocker: async () => blocker(n),
    sleep: async () => {},
    log: () => {},
  }).catch((e) => `threw: ${e.message}`);
  return { out, posts };
};
const headFree = () => rerunBlocker({ sha: STALE_OLD, pulls: [pr7398()], headRuns: [ciRun(77)] });
const movedHead = () =>
  rerunBlocker({
    sha: STALE_OLD,
    pulls: [pr7398({ head: { sha: STALE_NEW, ref: 'b1' } })],
    headRuns: [ciRun(77, { conclusion: 'cancelled' })],
  });

test('skip 1, stale head: a run whose head is not the pull request current head is never re-run', async () => {
  // The head moved and every CI run on the old head has finished, so nothing else would stop the re-run.
  const r = await recheckWith({ runs: () => [ciRun(77)], jobs: () => [recheckSeal()], blocker: movedHead });
  assert.deepEqual(r.posts, [], 'a stale head is never re-run');
  assert.match(r.out, /^not re-run: #7398's head moved to cccccccccc/);
  assert.equal(rerunBlocker({ sha: STALE_OLD, pulls: [pr7398({ state: 'closed' })], headRuns: [] }).act, 'skip');
});

test('the late read: a head that moves during the wait is read just before the re-run, not before the wait', async () => {
  // Clear when the re-check starts (reads 0 and 1, the run still going), moved once the run has been waited out.
  const r = await recheckWith({
    runs: (i) => [ciRun(77, i < 2 ? { status: 'in_progress' } : { conclusion: 'cancelled' })],
    jobs: (i) => [recheckSeal(i < 3 ? { status: 'in_progress' } : { conclusion: 'cancelled' })],
    blocker: (i) => (i <= 1 ? headFree() : movedHead()),
  });
  assert.deepEqual(r.posts, [], 'the head moved during the wait: no re-run of the old head');
  assert.match(r.out, /^not re-run: #7398's head moved to cccccccccc/);
});

test("skip 2, CI in progress: the head's newest ci.yml run queued or in progress is never re-run", async () => {
  // In progress for as long as the re-check looks, the seal running: nothing is posted, ever, and it goes red.
  let r = await recheckWith({
    runs: () => [ciRun(77, { status: 'in_progress' })],
    jobs: () => [recheckSeal({ status: 'in_progress' })],
    blocker: headFree,
  });
  assert.deepEqual(r.posts, [], 'a seal in a run still in progress is never re-run');
  assert.match(r.out, /^threw: /);
  // In progress with its seal already finished (the run's last seconds): nothing is posted.
  r = await recheckWith({ runs: () => [ciRun(77, { status: 'in_progress' })], jobs: () => [recheckSeal()], blocker: headFree });
  assert.deepEqual(r.posts, [], 'a run still finishing is never re-run');
  // Queued, no seal job yet: its own seal reads the change, so the re-check exits 0 with no call.
  r = await recheckWith({ runs: () => [ciRun(77, { status: 'queued' })], jobs: () => [], blocker: headFree });
  assert.deepEqual(r.posts, [], 'a queued run is never re-run');
  assert.match(r.out, /has not started/);
});

test('skip 2, CI in progress: another CI run on the same head in flight is waited out, then re-run; never skipped green', async () => {
  // Same head, the newest run with a seal finished, but another run on this head is queued (a reopen, a re-run by
  // hand): a re-run attempt would join the group and cancel it, so the re-check waits; at the bound it goes red.
  const going = () => rerunBlocker({ sha: STALE_OLD, pulls: [pr7398()], headRuns: [ciRun(79, { status: 'queued' }), ciRun(77)] });
  let r = await recheckWith({ runs: () => [ciRun(77)], jobs: () => [recheckSeal()], blocker: going });
  assert.deepEqual(r.posts, [], 'a run in flight on this head is never cancelled by a re-run');
  assert.match(r.out, /^threw: CI run 79 \(queued\) on this head is still going.* after 4 min/);
  // Once it finishes, exactly one re-run.
  r = await recheckWith({ runs: () => [ciRun(77)], jobs: () => [recheckSeal()], blocker: (i) => (i < 4 ? going() : headFree()) });
  assert.deepEqual(r.posts, ['/repos/o/r/actions/jobs/9/rerun']);
});

test("the round 1 cases: a run on another commit of the branch, or a fork's same-named branch, causes no skip", async () => {
  // An older head's run with a new attempt in flight: cancelling it cancels no check this head is judged by.
  const olderCommit = () =>
    rerunBlocker({
      sha: STALE_OLD,
      pulls: [pr7398()],
      headRuns: [ciRun(70, { status: 'in_progress', head_sha: 'd'.repeat(40) }), ciRun(77)],
    });
  let r = await recheckWith({ runs: () => [ciRun(77)], jobs: () => [recheckSeal()], blocker: olderCommit });
  assert.deepEqual(r.posts, ['/repos/o/r/actions/jobs/9/rerun'], 'a run on another commit of the branch: re-run');
  // A fork pull request whose branch has the same name: its runs are on its own SHA.
  const fork = () =>
    rerunBlocker({
      sha: STALE_OLD,
      pulls: [pr7398()],
      headRuns: [ciRun(71, { status: 'in_progress', head_sha: 'e'.repeat(40), head_repository: { full_name: 'f/r' } }), ciRun(77)],
    });
  r = await recheckWith({ runs: () => [ciRun(77)], jobs: () => [recheckSeal()], blocker: fork });
  assert.deepEqual(r.posts, ['/repos/o/r/actions/jobs/9/rerun'], "a fork's same-named branch: re-run");
  assert.equal(rerunBlocker({ sha: STALE_OLD, pulls: [pr7398()], headRuns: [ciRun(81, { event: 'push', status: 'in_progress' })] }), null);
});

test('a completed newest run on the current head, nothing else going: exactly one re-run', async () => {
  const r = await recheckWith({ runs: () => [ciRun(77)], jobs: () => [recheckSeal()], blocker: headFree });
  assert.deepEqual(r.posts, ['/repos/o/r/actions/jobs/9/rerun']);
  assert.equal(rerunBlocker({ sha: STALE_OLD, pulls: [pr7398()], headRuns: [] }), null);
});

test('fullVerdict: two journey files sharing one step id, both run, make a full run; one of them gone is short of it', () => {
  // J-wallet-04 #7 is in J-wallet-04.pw.mjs ("the bank's half") and J-wallet-04-security-lock.pw.mjs ("identity's half").
  // The step-to-file map keeps one file a step, so the seal read a clean full run as short of the other (#7492's seal,
  // run 42419894849 attempt 2). The files each run ran decide it.
  const spec = (title, status, file) => ({ title, file, tests: [{ status }] });
  const rep = (...specs) => readReport({ suites: [{ specs }] });
  const both = () => [
    spec('J-w-04 #1', 'expected', 'J-w-04.pw.mjs'),
    spec("J-w-04 #7 (the bank's half)", 'expected', 'J-w-04.pw.mjs'),
    spec("J-w-04 #7 (identity's half)", 'expected', 'J-w-04-lock.pw.mjs'),
  ];
  const named = rep(...both());
  const inputs = {
    baseline: { run: { number: 100, id: 1 }, steps: [] },
    money: { 'J-w-04#1': false, 'J-w-04#7': false },
    reports: new Map(),
  };
  const read = () => ({ named, passedSince: {}, issues: {}, problems: [] });
  const v = (report, r = read) => fullVerdict({ repo: REPO, report, run: run(1), inputs, read: r });
  assert.deepEqual(named.ran, ['J-w-04-lock.pw.mjs', 'J-w-04.pw.mjs'], 'the report lists both files it ran');
  const full = v(rep(...both()));
  assert.deepEqual([full.missing, full.red], [[], []], 'both files ran: a full run, clean');
  const short = v(rep(...both().slice(0, 2)));
  assert.deepEqual(short.missing, ['J-w-04-lock.pw.mjs'], 'the file left out is named, though its step id ran in the other');
  const noList = v(rep(...both()), () => ({ named: { ...named, ran: undefined }, passedSince: {}, issues: {}, problems: [] }));
  assert.deepEqual(
    noList.red.map((r) => r.why),
    ["the named run's report has no list of the files it ran"],
    'a named run without its file list fails closed',
  );
});

test("fullVerdict: a file main has since deleted is not missing; one main still has is, whatever the pull request's head holds (#8505)", () => {
  // #8485 deleted J-home-ia-06-blocked.pw.mjs on main, but the baseline's named run (1719) ran it, so every full run
  // after it read as short of that file and the seal held every pull request that needs one (#8494, 9c9b8091, run
  // 43712693473). Which files must have run comes from the default branch's own checkout (`onMain`), never the head.
  const spec = (title, file) => ({ title, file, tests: [{ status: 'expected' }] });
  const rep = (...specs) => readReport({ suites: [{ specs }] });
  const a = spec('J-a-01 #1', 'J-a-01.pw.mjs');
  const b = spec('J-b-01 #1', 'J-b-01.pw.mjs');
  const gone = spec('J-c-01 #1', 'J-c-01-blocked.pw.mjs');
  const named = rep(a, b, gone);
  const read = () => ({ named, passedSince: {}, issues: {}, problems: [] });
  const base = { baseline: { run: { number: 100, id: 1 }, steps: [] }, money: {}, reports: new Map() };
  const v = (report, onMain) => fullVerdict({ repo: REPO, report, run: run(1), inputs: { ...base, onMain }, read });
  const mainNow = new Set(['J-a-01.pw.mjs', 'J-b-01.pw.mjs']);
  // Known good: main deleted the file, and the run holds every file main still has.
  assert.deepEqual(v(rep(a, b), mainNow).missing, [], 'a file main deleted is not held against the run');
  // Planted fault: the run left out a file main still has.
  assert.deepEqual(v(rep(a), mainNow).missing, ['J-b-01.pw.mjs'], 'a file main still has, left out, is missing');
  // The trap: a pull request that deletes or skips a file itself. Main still has it, so the run is short of it.
  assert.deepEqual(v(rep(a, b), new Set([...mainNow, 'J-c-01-blocked.pw.mjs'])).missing, ['J-c-01-blocked.pw.mjs']);
  // No list of main's files: nothing is let off (fails closed, as before #8505).
  assert.deepEqual(v(rep(a, b), undefined).missing, ['J-c-01-blocked.pw.mjs']);
  assert.deepEqual(v(rep(a, b), null).missing, ['J-c-01-blocked.pw.mjs']);
});

test("journeyFilesAt: the journey files of a checkout's real-app folder, or null when it can't be read", () => {
  const here = journeyFilesAt(new URL('../..', import.meta.url).pathname);
  assert.ok(here instanceof Set && here.size > 100, 'this checkout holds the journey files');
  assert.ok(here.has('J-home-ia-06.pw.mjs') && !here.has('J-home-ia-06-blocked.pw.mjs'), 'as main holds them since #8485');
  assert.ok(
    [...here].every((f) => f.endsWith('.pw.mjs')),
    'only run files, never helpers',
  );
  assert.equal(journeyFilesAt('/nonexistent-checkout-8505'), null);
});

// ---- C1: reds inherited from main stop only their area (owner decision 180) ----

const MAIN_SHA = 'c'.repeat(40);
const PASS_SHA = 'd'.repeat(40);
const mainRun = (id, over = {}) => run(id, { head_sha: MAIN_SHA, head_branch: 'main', event: 'push', ...over });
const mainRef = (over = {}) => ({
  run: mainRun(50),
  red: new Map([['J-wallet-05#3', 'failing, not in the baseline']]),
  lastPass: { 'J-wallet-05#3': PASS_SHA },
  problems: [],
  ...over,
});
const redW = [{ step: 'J-wallet-05#3', why: 'failing, not in the baseline', money: false }];
const area = (journeys = [], paths = []) => ({ journeys: new Set(journeys), paths: new Set(paths) });
const range =
  (files = ['services/svc-wallet/src/send.ts'], commits = 3) =>
  async () => ({ files, commits, short: false });

test('C1 planted: a red main already had, outside the pull request area, stops no one; inside it, it stops', async () => {
  const out = await splitInherited({
    upTo: MAIN_SHA,
    red: redW,
    main: mainRef(),
    touches: area([], ['services/svc-support/src/chat.ts']),
    rangeOf: range(),
  });
  assert.deepEqual(out.blocking, [], 'outside its journey and its break range: passed over');
  assert.match(
    out.passed[0].why,
    /main's run 50 on cccccccccc has it red too; its area is J-wallet-05 and what 3 commit\(s\) in dddddddddd\.\.cccccccccc changed \(services\/svc-wallet\)/,
  );
  const byJourney = await splitInherited({ upTo: MAIN_SHA, red: redW, main: mainRef(), touches: area(['J-wallet-05']), rangeOf: range() });
  assert.equal(byJourney.blocking.length, 1, 'a pull request touching its journey is stopped');
  assert.match(byJourney.blocking[0].why, /inherited from main's run 50 .*touches J-wallet-05/);
  const byCode = await splitInherited({
    upTo: MAIN_SHA,
    red: redW,
    main: mainRef(),
    touches: area([], ['services/svc-wallet/src/send.ts']),
    rangeOf: range(),
  });
  assert.equal(byCode.blocking.length, 1, 'a pull request changing a file its break range changed is stopped');
  assert.match(
    byCode.blocking[0].why,
    /changes services\/svc-wallet\/src\/send\.ts \(services\/svc-wallet\), which a commit in dddddddddd\.\.cccccccccc/,
  );
  const samePackage = await splitInherited({
    upTo: MAIN_SHA,
    red: redW,
    main: mainRef(),
    touches: area([], ['services/svc-wallet/src/other.ts']),
    rangeOf: range(),
  });
  assert.equal(samePackage.blocking.length, 1, 'another file of a package its break range changed is in its area (AGENTS.md floor 5)');
  const root = await splitInherited({
    upTo: MAIN_SHA,
    red: redW,
    main: mainRef(),
    touches: area([], ['pnpm-lock.yaml']),
    rangeOf: range(['pnpm-lock.yaml']),
  });
  assert.equal(root.blocking.length, 1, 'a root file is its own area');
});

test('C1 planted: a red new on the head always stops it, whatever main has', async () => {
  const mine = [{ step: 'J-bank-13#1', why: 'failing, not in the baseline' }, ...redW];
  const out = await splitInherited({ upTo: MAIN_SHA, red: mine, main: mainRef(), touches: area(), rangeOf: range() });
  assert.deepEqual(
    out.blocking.map((x) => x.step),
    ['J-bank-13#1'],
    'green on main, red here: this head broke it',
  );
  const input = await splitInherited({
    upTo: MAIN_SHA,
    red: [{ step: '(input)', why: 'x' }],
    main: mainRef(),
    touches: area(),
    rangeOf: range(),
  });
  assert.equal(input.blocking.length, 1, 'an unreadable input is never inherited');
});

test("project-state #3754 planted: no main run in the head's history, main's newest finished full run stands in", async () => {
  const latest = mainRef({ run: mainRun(60, { head_sha: 'e'.repeat(40) }) });
  const out = await splitInherited({ upTo: MAIN_SHA, red: redW, main: null, latest, touches: area(), rangeOf: range() });
  assert.deepEqual(out.blocking, [], 'a red main already has, outside the area, no longer holds the pull request');
  assert.equal(out.passed.length, 1);
  assert.match(out.passed[0].why, /main's newest run 60 on eeeeeeeeee \(none is in this head's history\)/);
  const mine = [{ step: 'J-bank-13#1', why: 'failing, not in the baseline', money: false }];
  const own = await splitInherited({ upTo: MAIN_SHA, red: [...redW, ...mine], main: null, latest, touches: area(), rangeOf: range() });
  assert.deepEqual(
    own.blocking.map((x) => x.step),
    ['J-bank-13#1'],
    'a red main lacks still counts',
  );
  const shared = await splitInherited({
    upTo: MAIN_SHA,
    red: redW,
    main: null,
    latest,
    touches: { ...area([], ['tooling/scripts/local-test-world.mjs']), shared: true },
    rangeOf: range(),
  });
  assert.equal(shared.blocking.length, 1, 'shared setup: every red counts');
  const money = await splitInherited({
    upTo: MAIN_SHA,
    red: [{ ...redW[0], money: true }],
    main: null,
    latest,
    touches: area(),
    rangeOf: range(),
  });
  assert.equal(money.blocking.length, 1, 'a money step is never passed over');
  const inArea = await splitInherited({ upTo: MAIN_SHA, red: redW, main: null, latest, touches: area(['J-wallet-05']), rangeOf: range() });
  assert.equal(inArea.blocking.length, 1, 'its own journey: it stops');
  const inHistory = await splitInherited({
    upTo: MAIN_SHA,
    red: redW,
    main: mainRef({ red: new Map() }),
    latest,
    touches: area(),
    rangeOf: range(),
  });
  assert.equal(inHistory.blocking.length, 1, "a run in the head's history wins over the newest one");
});

test('C1 planted: a red that cannot be bounded stops every pull request', async () => {
  const none = await splitInherited({ upTo: MAIN_SHA, red: redW, main: null, touches: area(), rangeOf: range() });
  assert.equal(none.blocking.length, 1, 'no main run in the head history: every red counts');
  const neither = await splitInherited({ upTo: MAIN_SHA, red: redW, main: null, latest: null, touches: area(), rangeOf: range() });
  assert.equal(neither.blocking.length, 1, 'no finished full run on main at all: every red counts');
  const latestBlind = await splitInherited({
    upTo: MAIN_SHA,
    red: redW,
    main: null,
    latest: mainRef({ problems: ['history unreadable'] }),
    touches: area(),
    rangeOf: range(),
  });
  assert.equal(latestBlind.blocking.length, 1, "main's newest run with an unreadable input: every red counts");
  const blind = await splitInherited({
    upTo: MAIN_SHA,
    red: redW,
    main: mainRef({ problems: ['history unreadable'] }),
    touches: area(),
    rangeOf: range(),
  });
  assert.equal(blind.blocking.length, 1, 'main run with an unreadable input: every red counts');
  const wide = await splitInherited({ upTo: MAIN_SHA, red: redW, main: mainRef(), touches: area(), rangeOf: range(['a'], RANGE_MAX + 1) });
  assert.match(wide.blocking[0]?.why ?? '', new RegExp(`can't be bounded \\(${RANGE_MAX + 1} commits`));
  const err = await splitInherited({
    upTo: MAIN_SHA,
    red: redW,
    main: mainRef(),
    touches: area(),
    rangeOf: async () => Promise.reject(new Error('HTTP 404')),
  });
  assert.match(err.blocking[0]?.why ?? '', /can't be bounded \(HTTP 404\)/);
  const short = await splitInherited({
    upTo: MAIN_SHA,
    red: redW,
    main: mainRef(),
    touches: area(),
    rangeOf: async () => ({ files: ['a'], commits: 2, short: true }),
  });
  assert.equal(short.blocking.length, 1, 'a file list GitHub cut short');
  const noSha = await splitInherited({
    upTo: MAIN_SHA,
    red: redW,
    main: mainRef({ lastPass: { 'J-wallet-05#3': '' } }),
    touches: area(),
    rangeOf: range(),
  });
  assert.equal(noSha.blocking.length, 1, 'where it last passed is unreadable');
  const never = await splitInherited({
    upTo: MAIN_SHA,
    red: redW,
    main: mainRef({ lastPass: { 'J-wallet-05#3': null } }),
    touches: area(),
    rangeOf: range(),
  });
  assert.equal(never.blocking.length, 1, 'council G1: a step that never passed on main has no break range, so it is unbounded');
});

test('C1: the main run compared with is the newest finished full one on main the head contains', async () => {
  const reps = { 50: { ok: 1 }, 51: { ok: 1 }, 52: { ok: 1 }, 53: { ok: 1 }, 54: { error: 'gone' } };
  const ref = (mainRuns, { contains = async () => true, verdicts = {} } = {}) =>
    mainReference({
      repo: REPO,
      mainRuns,
      contains,
      reportOf: async (r) => reps[r.id],
      verdictOf: async (_rep, r) =>
        verdicts[r.id] ?? { red: [{ step: 'J-x-01#1', why: 'f' }], missing: [], lastPass: { 'J-x-01#1': null } },
    });
  const runs = [mainRun(50), mainRun(51), mainRun(52, { head_sha: OLD })];
  assert.equal((await ref(runs, { contains: async (sha) => sha === MAIN_SHA }))?.run.id, 51, 'newest the head contains');
  assert.equal((await ref([mainRun(50), mainRun(51, { head_sha: OLD })], { contains: async (sha) => sha === MAIN_SHA }))?.run.id, 50);
  assert.equal(await ref(runs, { contains: async () => false }), null, 'none in the head history');
  assert.equal(
    (await ref([mainRun(50), mainRun(51, { head_branch: 'feature' }), mainRun(53, { event: 'pull_request' })]))?.run.id,
    50,
    'a branch run or a pull request run is not main',
  );
  assert.equal((await ref([mainRun(50), mainRun(51, { conclusion: 'cancelled' })]))?.run.id, 50, 'a cancelled run says nothing');
  assert.equal(
    (await ref([mainRun(50), mainRun(51)], { verdicts: { 51: { red: [], missing: ['J-b-01.pw.mjs'] } } }))?.run.id,
    50,
    'a run short of files is passed over',
  );
  await assert.rejects(ref([mainRun(50), mainRun(54)]), /report couldn't be read/, 'an unreadable main report fails closed');
  const got = await ref([mainRun(50)]);
  assert.deepEqual([...got.red.keys()], ['J-x-01#1']);
});

test('C1 sealPull planted: a product pull request on a red main seals outside the red area and not inside it', async () => {
  const inheritedDirty = { ...dirty, lastPass: { 'J-wallet-05#3': PASS_SHA } };
  const io = ({
    files,
    title = 'svc-support: chat keeps its draft',
    mainVerdict = inheritedDirty,
    rangeFiles = ['services/svc-wallet/src/send.ts'],
  }) => ({
    pull: async () => ({ state: 'open', head: { sha: HEAD }, base: { sha: MAIN_SHA }, title, body: '' }),
    runs: async () => [run(1)],
    reportOf: reports({ 1: { ...fullRep, ran: ['J-bank-13.pw.mjs', 'J-wallet-05.pw.mjs', ...CANARY] }, 50: fullRep }),
    files: async () => files,
    text: async () => 'test(`${J} #1 opens`, async () => {}); test(`${J} #3 sends`, async () => {});',
    verdictOf: async (_rep, r) => (r.id === 50 ? mainVerdict : dirty),
    mainRuns: async () => [mainRun(50)],
    contains: async (sha, head) => sha === MAIN_SHA && head === HEAD,
    mergeBase: async (base, head) => (base === MAIN_SHA && head === HEAD ? MAIN_SHA : null),
    rangeOf: async () => ({ files: rangeFiles, commits: 2, short: false }),
  });
  const outside = await sealPull({ repo: REPO, number: 7, sha: HEAD, io: io({ files: ['services/svc-support/src/chat.ts'] }) });
  assert.equal(outside.ok, true, outside.lines.join('\n'));
  assert.match(outside.lines.join('\n'), /J-wallet-05#3 is red on this head and inherited/);
  const own = await sealPull({
    repo: REPO,
    number: 7,
    sha: HEAD,
    io: io({ files: ['services/svc-support/src/chat.ts'], mainVerdict: { ...clean, lastPass: {} } }),
  });
  assert.equal(own.ok, false, "planted: the same red with main green on it is this pull request's own");
  const named = await sealPull({
    repo: REPO,
    number: 7,
    sha: HEAD,
    io: io({ files: ['services/svc-support/src/chat.ts'], title: 'svc-support: chat (J-wallet-05 #1)' }),
  });
  assert.equal(named.fullOk, false, 'a title naming a step of its journey is in its area');
  const testFile = await sealPull({
    repo: REPO,
    number: 7,
    sha: HEAD,
    io: io({ files: ['services/svc-support/src/chat.ts', 'apps/customer/tests/real-app/J-wallet-05.pw.mjs'], title: 'x (J-wallet-05 #3)' }),
  });
  assert.equal(testFile.fullOk, false, 'its journey test file is in its area');
  const code = await sealPull({ repo: REPO, number: 7, sha: HEAD, io: io({ files: ['services/svc-wallet/src/fees.ts'] }) });
  assert.equal(code.ok, false, 'a package its break range changed is in its area');
  // A journey-test-only pull request run on the full suite: a red main had, in another journey, stops it no more.
  const testOnly = (title, file) =>
    sealPull({ repo: REPO, number: 7, sha: HEAD, io: io({ files: [`apps/customer/tests/real-app/${file}`], title }) });
  assert.equal((await testOnly('x (J-bank-13 #1)', 'J-bank-13.pw.mjs')).fullOk, true, 'test-only, red elsewhere inherited: passes');
  assert.equal((await testOnly('x (J-wallet-05 #3)', 'J-wallet-05.pw.mjs')).fullOk, false, 'test-only on the red journey: stopped');
  const shared = await sealPull({ repo: REPO, number: 7, sha: HEAD, io: io({ files: ['tooling/scripts/local-test-world.mjs'] }) });
  assert.equal(shared.ok, false, 'review R1: shared setup reaches every journey, so nothing inherited is passed over');
  assert.match(shared.lines.join('\n'), /shared setup, which reaches every journey, so every red counts/);
  const money = await sealPull({ repo: REPO, number: 7, sha: HEAD, io: io({ files: ['services/svc-support/src/chat.ts'] }) });
  assert.equal(money.ok, true, 'OWNER 297: a pull request that touches money code is sealed like any other');

  const notInHistory = await sealPull({
    repo: REPO,
    number: 7,
    sha: HEAD,
    io: { ...io({ files: ['services/svc-support/src/chat.ts'] }), contains: async () => false },
  });
  // project-state #3754: main's newest finished full run stands in for one in the head's history.
  assert.equal(notInHistory.ok, true, notInHistory.lines.join('\n'));
  assert.match(notInHistory.lines.join('\n'), /main's newest run 50 .*none is in this head's history/);
  const notInHistoryOwn = await sealPull({
    repo: REPO,
    number: 7,
    sha: HEAD,
    io: { ...io({ files: ['services/svc-support/src/chat.ts'], mainVerdict: { ...clean, lastPass: {} } }), contains: async () => false },
  });
  assert.equal(notInHistoryOwn.ok, false, "outside the head's history, a red main's newest run lacks still counts");
  const noMainRun = await sealPull({
    repo: REPO,
    number: 7,
    sha: HEAD,
    io: { ...io({ files: ['services/svc-support/src/chat.ts'] }), contains: async () => false, mainRuns: async () => [] },
  });
  assert.equal(noMainRun.ok, false, 'no finished full run on main at all: every red counts');
  assert.match(noMainRun.lines.join('\n'), /every red counts/);
  const broken = await sealPull({
    repo: REPO,
    number: 7,
    sha: HEAD,
    io: { ...io({ files: ['services/svc-support/src/chat.ts'] }), mainRuns: async () => Promise.reject(new Error('HTTP 502')) },
  });
  assert.equal(broken.ok, false, 'an unreadable main fails closed');
  assert.match(broken.lines.join('\n'), /couldn't be read \(HTTP 502\), so every red counts/);
});

test('C1: fullVerdict says where each red step last passed on main', () => {
  const spec = (title, status, file) => ({ title, file, tests: [{ status }] });
  const rep = (...specs) => readReport({ suites: [{ file: 'J-a-01.pw.mjs', specs }] });
  const named = rep(
    spec('J-a-01 #1', 'expected', 'J-a-01.pw.mjs'),
    spec('J-a-01 #2', 'expected', 'J-a-01.pw.mjs'),
    spec('J-a-01 #3', 'unexpected', 'J-a-01.pw.mjs'),
  );
  const inputs = { baseline: { run: { number: 100, id: 1, sha: PASS_SHA }, steps: [] }, money: {}, reports: new Map() };
  const read = () => ({ named, passedSince: { 'J-a-01#2': 105 }, issues: {}, problems: [], shas: { 105: MAIN_SHA } });
  const v = fullVerdict({
    repo: REPO,
    report: rep(
      spec('J-a-01 #1', 'unexpected', 'J-a-01.pw.mjs'),
      spec('J-a-01 #2', 'unexpected', 'J-a-01.pw.mjs'),
      spec('J-a-01 #3', 'unexpected', 'J-a-01.pw.mjs'),
    ),
    run: run(1),
    inputs,
    read,
  });
  assert.deepEqual(v.lastPass, { 'J-a-01#1': PASS_SHA, 'J-a-01#2': MAIN_SHA, 'J-a-01#3': null });
});

test('C1 review round 0: a flake on one commit, a reason main lacks, a re-run of an older main run, and areas', async () => {
  const flake = await splitInherited({
    upTo: MAIN_SHA,
    red: redW,
    main: mainRef({ lastPass: { 'J-wallet-05#3': MAIN_SHA } }),
    touches: area([], ['services/svc-wallet/src/send.ts']),
    rangeOf: async () => assert.fail('no compare for an empty range'),
  });
  assert.equal(flake.blocking.length, 0, 'last passed on the commit it now fails on: no commit broke it, its journey is its area');
  const other = await splitInherited({
    upTo: MAIN_SHA,
    red: [{ step: 'J-wallet-05#3', why: 'the baseline says money false, the money rule at this commit says true' }],
    main: mainRef(),
    touches: area(),
    rangeOf: range(),
  });
  assert.equal(other.blocking.length, 1, 'red for a reason main does not have: not inherited');
  const numbers = await splitInherited({
    upTo: MAIN_SHA,
    red: [{ step: 'J-wallet-05#3', why: 'called unbuilt, but passed on main in run 1990', money: false }],
    main: mainRef({ red: new Map([['J-wallet-05#3', 'called unbuilt, but passed on main in run 1981']]) }),
    touches: area(),
    rangeOf: range(),
  });
  assert.equal(numbers.blocking.length, 0, 'the same reason read from two runs differs only in run numbers');
  const noTip = await splitInherited({ upTo: null, red: redW, main: mainRef(), touches: area(), rangeOf: range() });
  assert.equal(noTip.blocking.length, 1, 'the newest main commit the head holds unreadable: unbounded');
  const fixTried = await splitInherited({
    upTo: 'e'.repeat(40),
    red: redW,
    main: mainRef(),
    touches: area([], ['services/svc-fees/src/a.ts']),
    rangeOf: async (from, to) => ({ files: to === 'e'.repeat(40) ? ['services/svc-fees/src/b.ts'] : [], commits: 4, short: false }),
  });
  assert.equal(fixTried.blocking.length, 1, 'the range runs to the newest main commit the head holds, past the reference run');
  // Every path counts by its package, and a journey test file by its journey too (CI review on e288d257).
  assert.deepEqual(areasOf('apps/customer/tests/real-app/J-bank-13.pw.mjs'), ['apps/customer', 'journey J-bank-13']);
  assert.deepEqual(areasOf('apps/customer/src/features/more/Support.tsx'), ['apps/customer']);
  assert.deepEqual(areasOf('services/svc-bank/src/a.test.ts'), ['services/svc-bank']);
  assert.deepEqual(areasOf('pnpm-lock.yaml'), ['pnpm-lock.yaml']);
  for (const rangeFile of ['apps/customer/tests/real-app/J-bank-13.pw.mjs', 'apps/customer/src/x.test.ts']) {
    const out = await splitInherited({
      upTo: MAIN_SHA,
      red: redW,
      main: mainRef(),
      touches: area([], ['apps/customer/src/features/more/Support.tsx']),
      rangeOf: range([rangeFile]),
    });
    assert.equal(out.blocking.length, 1, `planted: ${rangeFile} in the break range puts apps/customer in the area`);
  }
  const elsewhere = await splitInherited({
    upTo: MAIN_SHA,
    red: redW,
    main: mainRef(),
    touches: area([], ['services/svc-support/src/chat.ts']),
    rangeOf: range(['apps/customer/tests/real-app/J-bank-13.pw.mjs', 'tooling/ci/why-red.mjs']),
  });
  assert.equal(elsewhere.blocking.length, 0, 'a pull request in none of the range packages still passes over the inherited red');
  // A re-run attempt of an older main run started last is still older than a later run.
  const reps = { 60: { ok: 1 }, 61: { ok: 1 } };
  const ref = await mainReference({
    repo: REPO,
    mainRuns: [
      mainRun(60, { run_number: 1700, created_at: '2026-11-06T01:00:00Z', run_started_at: '2026-11-06T09:00:00Z', run_attempt: 2 }),
      mainRun(61, { run_number: 1720, created_at: '2026-11-06T05:00:00Z', run_started_at: '2026-11-06T05:00:00Z' }),
    ],
    contains: async () => true,
    reportOf: async (r) => reps[r.id],
    verdictOf: async () => ({ red: [], missing: [], lastPass: {} }),
  });
  assert.equal(ref.run.id, 61, 'by creation, not by the newest attempt start');
});

test('C1: a path a pull request names is printed with its control characters shown as ?, never written', async () => {
  const evil = 'services/svc-wallet/x\n::error::forged.ts';
  const out = await splitInherited({ upTo: MAIN_SHA, red: redW, main: mainRef(), touches: area([], [evil]), rangeOf: range() });
  assert.equal(out.blocking.length, 1);
  assert.doesNotMatch(out.blocking[0].why, /\n/);
});

test("C1 review round 1: the break range also runs to main's reference run when the base read is older (R4)", async () => {
  const OLDER = 'f'.repeat(40);
  const out = await splitInherited({
    upTo: OLDER,
    red: redW,
    main: mainRef(),
    touches: area([], ['services/svc-wallet/src/fees.ts']),
    rangeOf: async (from, to) => ({ files: to === MAIN_SHA ? ['services/svc-wallet/src/send.ts'] : [], commits: 2, short: false }),
  });
  assert.equal(out.blocking.length, 1, 'the commits up to the reference run count even when the newest main commit read is older');
  const err = await splitInherited({
    upTo: OLDER,
    red: redW,
    main: mainRef(),
    touches: area(),
    rangeOf: async (from, to) => (to === OLDER ? Promise.reject(new Error('behind')) : { files: [], commits: 1, short: false }),
  });
  assert.equal(err.blocking.length, 1, 'either end unreadable: unbounded');
});

test("C1 council G2: the break range is every commit's own paths, so a package one commit broke and a later one restored counts", async () => {
  const A = '1'.repeat(40);
  const B = '2'.repeat(40);
  const calls = [];
  const get = async (p) => {
    calls.push(p);
    if (p.includes('/compare/'))
      return { status: 'ahead', total_commits: 2, commits: [{ sha: A }, { sha: B }], files: [{ filename: 'services/svc-a/x.ts' }] };
    if (p.endsWith(A))
      return {
        files: [{ filename: 'services/svc-a/x.ts' }, { filename: 'services/svc-b/y.ts', previous_filename: 'services/svc-c/y.ts' }],
      };
    if (p.endsWith(B)) return { files: [{ filename: 'services/svc-b/y.ts' }] };
    throw new Error(p);
  };
  const r = await rangeFromCommits(get, REPO, PASS_SHA, MAIN_SHA);
  assert.deepEqual(r.files.sort(), ['services/svc-a/x.ts', 'services/svc-b/y.ts', 'services/svc-c/y.ts']);
  assert.equal(r.commits, 2);
  assert.equal(r.short, false);
  const out = await splitInherited({
    upTo: MAIN_SHA,
    red: redW,
    main: mainRef(),
    touches: area([], ['services/svc-b/z.ts']),
    rangeOf: async () => r,
  });
  assert.equal(out.blocking.length, 1, 'svc-b, restored by the net diff, is still in the area');
  const wide = await rangeFromCommits(
    async () => ({ status: 'ahead', total_commits: RANGE_MAX + 1, commits: [] }),
    REPO,
    PASS_SHA,
    MAIN_SHA,
  );
  assert.equal(wide.short, true, 'too wide: no reads, and marked');
  const cut = await rangeFromCommits(async () => ({ status: 'ahead', total_commits: 3, commits: [{ sha: A }] }), REPO, PASS_SHA, MAIN_SHA);
  assert.equal(cut.short, true, 'a commit list shorter than the count is short');
  assert.deepEqual(await rangeFromCommits(async () => ({ status: 'identical' }), REPO, MAIN_SHA, MAIN_SHA), {
    files: [],
    commits: 0,
    short: false,
  });
  await assert.rejects(
    rangeFromCommits(async () => ({ status: 'behind', total_commits: 0 }), REPO, MAIN_SHA, PASS_SHA),
    /behind/,
  );
  await assert.rejects(
    rangeFromCommits(
      async (p) => (p.includes('/compare/') ? { status: 'ahead', total_commits: 1, commits: [{ sha: A }] } : {}),
      REPO,
      PASS_SHA,
      MAIN_SHA,
    ),
    /files: not a list/,
  );
});

test('CI review: a money step red on main too is never passed over, outside every area and as a same-commit flake', async () => {
  const moneyRed = [{ step: 'J-wallet-05#3', why: 'failing, not in the baseline', money: true }];
  const outside = await splitInherited({
    upTo: MAIN_SHA,
    red: moneyRed,
    main: mainRef(),
    touches: area([], ['services/svc-support/src/chat.ts']),
    rangeOf: range(),
  });
  assert.equal(outside.blocking.length, 1);
  assert.match(outside.blocking[0].why, /money step, so it stops every pull request/);
  const flake = await splitInherited({
    upTo: MAIN_SHA,
    red: moneyRed,
    main: mainRef({ lastPass: { 'J-wallet-05#3': MAIN_SHA } }),
    touches: area(),
    rangeOf: range(),
  });
  assert.equal(flake.blocking.length, 1, 'the same-commit flake case does not clear a money step');
  const unmarked = await splitInherited({
    upTo: MAIN_SHA,
    red: [{ step: 'J-wallet-05#3', why: 'failing, not in the baseline' }],
    main: mainRef(),
    touches: area(),
    rangeOf: range(),
  });
  assert.equal(unmarked.blocking.length, 1, 'a red not marked non-money counts as money');
});

test('recheckTargets: after CI every open pull request on the head is re-sealed; after a journeys run only named ones (R3 C3 piece 2)', async () => {
  const { recheckTargets } = await import('./journey-seal.mjs');
  const sha = 'c'.repeat(40);
  const pr = (number, title, over = {}) => ({
    number,
    title,
    state: 'open',
    head: { sha },
    base: { repo: { full_name: 'o/r' } },
    body: '',
    auto_merge: { merge_method: 'squash' },
    ...over,
  });
  const pulls = [
    pr(1, 'fix the copy'),
    pr(2, 'J-bank-13 #1 pays'),
    pr(3, 'other head', { head: { sha: 'd'.repeat(40) } }),
    pr(4, 'closed', { state: 'closed' }),
  ];
  const filesOf = async () => ['services/svc-pay/src/a.test.ts']; // a change no journeys run judges (journey-touch none)
  const ci = await recheckTargets({ finished: 'CI', pulls, sha, repo: 'o/r', filesOf });
  assert.deepEqual(
    ci.map((p) => p.number),
    [1, 2],
  );
  const journeys = await recheckTargets({ finished: 'Real-app journeys', pulls, sha, repo: 'o/r', filesOf });
  assert.deepEqual(
    journeys.map((p) => p.number),
    [2],
    'a journeys run re-seals only what names or touches journeys',
  );
});

test('recheckTargets: only pull requests with auto-merge armed are re-sealed; arming runs merge-seal.yml afresh (#1574 item 4)', async () => {
  const { recheckTargets, armed } = await import('./journey-seal.mjs');
  const sha = 'c'.repeat(40);
  const pr = (number, title, auto_merge) => ({
    number,
    title,
    state: 'open',
    head: { sha },
    base: { repo: { full_name: 'o/r' } },
    body: '',
    auto_merge,
  });
  const on = { merge_method: 'squash' };
  const pulls = [pr(1, 'fix the copy', on), pr(2, 'J-bank-13 #1 pays', null), pr(3, 'J-bank-13 #2 pays', on), pr(4, 'no field')];
  delete pulls[3].auto_merge;
  const filesOf = async () => ['services/svc-pay/src/a.test.ts'];
  assert.deepEqual(
    [on, null, undefined].map((a) => armed({ auto_merge: a })),
    [true, false, false],
  );
  const numbers = async (finished, list = pulls) =>
    (await recheckTargets({ finished, pulls: list, sha, repo: 'o/r', filesOf })).map((p) => p.number);
  assert.deepEqual(await numbers('CI'), [1, 3], 'after CI: every armed pull request on the head, none that is not armed');
  assert.deepEqual(await numbers('Real-app journeys'), [3], 'after a journeys run: armed and naming steps');
  assert.deepEqual(
    await numbers('CI review', [...pulls, { ...pr(6, 'J-x #1', null), draft: true }]),
    [1, 2, 3, 4],
    'after the CI review: every ready pull request on the head, armed or not (sealedOnReview), never a draft',
  );
  assert.deepEqual(await numbers('CI', [pr(5, 'J-x #1', null)]), [], 'disarmed again before the re-check read it: left alone');
  // Planted: without the filter, an unarmed pull request named by its title would be re-sealed after a journeys run.
  const unfiltered = await recheckTargets({
    finished: 'Real-app journeys',
    pulls: pulls.map((p) => ({ ...p, auto_merge: on })),
    sha,
    repo: 'o/r',
    filesOf,
  });
  assert.deepEqual(
    unfiltered.map((p) => p.number),
    [2, 3],
  );
});

test('merge-seal.yml: arming runs the seal afresh, in a group of its own, so one armed after its inputs finished is sealed', () => {
  const text = readFileSync('.github/workflows/merge-seal.yml', 'utf8');
  assert.match(text, /\n    types: \[opened, synchronize, reopened, edited, auto_merge_enabled\]\n/);
  // Planted: in the pull request's group an arming could replace a waiting push's run and leave the new head with none.
  assert.match(
    text,
    /\(github\.event\.action != 'edited' && github\.event\.action != 'auto_merge_enabled'\) \|\| github\.event\.changes\.base/,
  );
});

test("rerunSealJob reads merge-seal.yml's pull_request_target runs when asked, and re-runs that seal", async () => {
  const { SEAL_WORKFLOWS } = await import('./journey-seal.mjs');
  assert.deepEqual(
    SEAL_WORKFLOWS.map((w) => w.workflow),
    ['ci.yml', 'merge-seal.yml'],
  );
  const paths = [];
  const get = async (path) => {
    paths.push(path);
    if (path.includes('/runs?'))
      return {
        workflow_runs: [
          { id: 5, event: 'pull_request_target', status: 'completed' },
          { id: 6, event: 'pull_request', status: 'completed' },
        ],
      };
    return { jobs: [{ id: 50, name: SEAL, status: 'completed', conclusion: 'failure' }] };
  };
  let posted = '';
  const msg = await rerunSealJob({
    repo: 'o/r',
    sha: HEAD,
    get,
    post: async (p) => ((posted = p), { status: 201 }),
    sleep: async () => {},
    log: () => {},
    workflow: 'merge-seal.yml',
    event: 'pull_request_target',
  });
  assert.match(paths[0], /workflows\/merge-seal\.yml\/runs\?head_sha=.*&event=pull_request_target/);
  assert.match(posted, /jobs\/50\/rerun$/, msg);
  assert.match(paths[1], /runs\/5\/jobs/, 'the pull_request_target run, not the ci.yml one');
});

test('planted (#8225): an armed head whose newest seal run holds no `CI merge seal` gets it there, never on an older run', async () => {
  // GitHub reads the required check from the newest run of merge-seal.yml on a head alone (probe intafaced#8246): #8225
  // left its verdict on the push run (31) while an edit's or an arming's run (32) held only a skipped seal, whose check run
  // is named by its expression's raw text, and every armed pull request then waited on a missing check.
  const waits = "${{ (github.run_attempt != '1' || needs.now.outputs.now == 'true') && 'CI merge seal' || 'CI merge seal waits' }}";
  const runs = [
    { id: 30, event: 'pull_request_target', status: 'completed' },
    { id: 31, event: 'pull_request_target', status: 'completed' },
    { id: 32, event: 'pull_request_target', status: 'completed' },
  ];
  const go = async (newest) => {
    const jobs = {
      30: [{ id: 300, name: SEAL, status: 'completed', conclusion: 'failure' }],
      31: [{ id: 310, name: SEAL, status: 'completed', conclusion: 'success' }],
      32: newest,
    };
    const get = async (path) => (path.includes('/runs?') ? { workflow_runs: runs } : { jobs: jobs[/runs\/(\d+)\/jobs/.exec(path)[1]] });
    const posted = [];
    const msg = await rerunSealJob({
      repo: 'o/r',
      sha: HEAD,
      get,
      post: async (p) => (posted.push(p.replace('/repos/o/r/actions/', '')), { status: 201 }),
      sleep: async () => {},
      log: () => {},
      workflow: 'merge-seal.yml',
      event: 'pull_request_target',
    });
    return { posted, msg };
  };
  // Its seal skipped (it waited), or no seal job at all (cancelled before its jobs): run 32 is started whole, and its
  // second attempt is the verdict. The older runs, red or green, are never re-run: GitHub doesn't read them.
  for (const newest of [[{ id: 320, name: waits, status: 'completed', conclusion: 'skipped' }], []]) {
    const r = await go(newest);
    assert.deepEqual(r.posted, ['runs/32/rerun'], r.msg);
  }
  // With a verdict in the newest run, that one is re-run, and only it.
  assert.deepEqual((await go([{ id: 320, name: SEAL, status: 'completed', conclusion: 'success' }])).posted, ['jobs/320/rerun']);
  // A newest run still deciding is waited for, never passed over.
  runs[2].status = 'in_progress';
  assert.equal(
    recheckStep(runs, new Map([['32', [{ id: 320, name: waits, status: 'completed', conclusion: 'skipped' }]]]), 'pull_request_target').act,
    'wait',
  );
});

/** Problems with merge-seal.yml's seal job skipping, or []: it may skip only a first attempt whose `now` job decided,
 *  without error, that the seal waits for its inputs; and its name must be that same expression, valued `CI merge
 *  seal`, so a skipped run never reports under the seal's name (probe intafaced#7679). */
function sealJobSkipProblems(text) {
  const job = text.split('\n  seal:\n')[1] ?? '';
  const cond = "github.run_attempt != '1' || needs.now.result != 'success' || needs.now.outputs.now == 'true'";
  const ifs = [...job.matchAll(/\n {4}if: ([^\n]*)/g)].map((m) => m[1].trim());
  const name = /\n {4}name: ([^\n]*)/.exec(job)?.[1]?.trim() ?? '';
  const out = [];
  if (ifs.length !== 1) out.push(`the seal job needs exactly one job-level if:, has ${ifs.length}`);
  if (ifs[0] !== `\${{ !cancelled() && (${cond}) }}`)
    out.push(`the seal job's if: must be \`!cancelled() && (${cond})\` (a failed decision seals at once), not \`${ifs[0]}\``);
  if (name !== `\${{ (${cond}) && 'CI merge seal' || 'CI merge seal waits for CI, the CI review and the journeys it needs' }}`)
    out.push(`a skippable seal job needs its name as the same expression, never a static name: \`${name}\``);
  if (!/\n {2}now:\n {4}name: [^\n]+\n {4}if: github\.run_attempt == '1'\n/.test(text))
    out.push('the `now` job must ask on a first attempt only');
  return out;
}

test('review 7552-R1: merge-seal.yml seals a pull request retargeted to main (edited, base change only)', () => {
  const text = readFileSync(new URL('../../.github/workflows/merge-seal.yml', import.meta.url), 'utf8');
  assert.match(text, /types: \[opened, synchronize, reopened, edited, auto_merge_enabled\]/);
  // Review 7552-R6: a skipped job counts as passing a required check, so a skipped seal job is never named `CI merge seal`.
  assert.deepEqual(sealJobSkipProblems(text), []);
  // Planted: a static name beside the `if:` would leave a skipped, passing `CI merge seal` on every waiting head.
  assert.match(
    sealJobSkipProblems(text.replace(/name: \$\{\{ \(github\.run_attempt[^\n]*\n/, 'name: CI merge seal\n')).join(),
    /static name/,
  );
  // Planted: without `needs.now.result != 'success'`, a decision that errored would skip the seal instead of sealing now.
  assert.match(sealJobSkipProblems(text.replaceAll(" || needs.now.result != 'success'", '')).join(), /failed decision/);
  // Planted: a `now` job on every attempt would let a re-run skip again, so the seal would never give its verdict.
  assert.match(sealJobSkipProblems(text.replace("    if: github.run_attempt == '1'\n", '')).join(), /first attempt only/);
  assert.match(text, /branches: \[main\]/);
  assert.doesNotMatch(text.replace('reopened, edited', 'reopened'), /reopened, edited/);
});

test('after CI finished, only the default branch seal is re-run; re-running ci.yml would loop (CI review on 7a7eb9a0)', async () => {
  const { sealsToRecheck } = await import('./journey-seal.mjs');
  assert.deepEqual(
    sealsToRecheck('CI').map((w) => w.workflow),
    ['merge-seal.yml'],
  );
  assert.deepEqual(
    sealsToRecheck('Real-app journeys').map((w) => w.workflow),
    ['ci.yml', 'merge-seal.yml'],
  );
  assert.deepEqual(
    sealsToRecheck('').map((w) => w.workflow),
    ['ci.yml', 'merge-seal.yml'],
    'an edit re-runs both',
  );
});

// ---- One seal verdict per head per finished CI run (INTAFACED/project-state#1574, 9 Nov 2026) ----------------------

test("#1574: ci.yml's seal is re-run only when it is red on a step only an older ci.yml runs on a pull request", async () => {
  const { ciSealReads, PR_READ_STEPS } = await import('./journey-seal.mjs');
  const step = (name, conclusion) => ({ name, conclusion });
  assert.deepEqual([...PR_READ_STEPS], ['Require the named journey steps on this exact head', 'Require the CI review on this exact head']);
  assert.equal(ciSealReads({ conclusion: 'failure', steps: [step('Require needed jobs', 'failure')] }), false, 'red on CI jobs');
  assert.equal(ciSealReads({ conclusion: 'success', steps: [step('Require the CI review on this exact head', 'success')] }), false);
  assert.equal(ciSealReads({ conclusion: 'failure', steps: [step('Require the CI review on this exact head', 'skipped')] }), false);
  assert.equal(ciSealReads({ conclusion: 'failure' }), false, 'no steps read: never re-run');
  assert.equal(ciSealReads(undefined), false);
  assert.equal(ciSealReads({ conclusion: 'failure', steps: [step('Require the CI review on this exact head', 'failure')] }), true);
  assert.equal(ciSealReads({ conclusion: 'failure', steps: OLD_CI_STEPS }), true);

  // Through rerunSealJob: a ci.yml seal red on CI's own jobs, or green, posts nothing (a post would be a new CI attempt,
  // whose end starts another re-check); one red on the old journey step is re-run once.
  const run = (id) => ({ id, event: 'pull_request', status: 'completed' });
  const sealOf = (over) => ({ id: 9, name: SEAL, status: 'completed', ...over });
  const go = async (jobs, runs = [run(77)]) => {
    const posts = [];
    const msg = await rerunSealJob({
      repo: 'o/r',
      sha: HEAD,
      get: async (path) => (path.includes('/runs?') ? { workflow_runs: runs } : { jobs: jobs[/runs\/(\d+)\/jobs/.exec(path)[1]] }),
      post: async (path) => (posts.push(path), { status: 201 }),
      sleep: async () => {},
      log: () => {},
    });
    return { msg, posts };
  };
  let r = await go({ 77: [sealOf({ conclusion: 'failure', steps: [step('Require needed jobs', 'failure')] })] });
  assert.deepEqual(r.posts, [], r.msg);
  assert.match(r.msg, /^not re-run: ci\.yml's seal job 9 reads only CI's own jobs/);
  r = await go({ 77: [sealOf({ conclusion: 'success', steps: [] })] });
  assert.deepEqual(r.posts, [], 'a green ci.yml seal is left: merge-seal.yml decides the steps and the review');
  r = await go({ 77: [sealOf({ conclusion: 'failure', steps: OLD_CI_STEPS })] });
  assert.deepEqual(r.posts, ['/repos/o/r/actions/jobs/9/rerun']);
  // The newest ci.yml run on the head decides: its seal, red on the old journey step, is re-run; the older one is not.
  r = await go(
    {
      78: [sealOf({ id: 10, conclusion: 'failure', steps: OLD_CI_STEPS })],
      77: [sealOf({ conclusion: 'failure', steps: [step('Require needed jobs', 'failure')] })],
    },
    [run(78), run(77)],
  );
  assert.deepEqual(r.posts, ['/repos/o/r/actions/jobs/10/rerun'], r.msg);
  // Planted: merge-seal.yml's seal is re-run whatever it failed on (it reads the steps and the review).
  const posts = [];
  await rerunSealJob({
    repo: 'o/r',
    sha: HEAD,
    get: async (path) =>
      path.includes('/runs?')
        ? { workflow_runs: [{ id: 5, event: 'pull_request_target', status: 'completed' }] }
        : { jobs: [sealOf({ id: 50, conclusion: 'failure', steps: [step("Require CI's jobs on this exact head", 'failure')] })] },
    post: async (path) => (posts.push(path), { status: 201 }),
    sleep: async () => {},
    log: () => {},
    workflow: 'merge-seal.yml',
    event: 'pull_request_target',
  });
  assert.deepEqual(posts, ['/repos/o/r/actions/jobs/50/rerun']);
});

/** Problems with an input workflow's `Start the seal` job (START_JOB), or []. */
function startJobProblems(text, finished) {
  const out = [];
  const jobsAt = text.indexOf('\njobs:\n');
  const names = [...text.slice(jobsAt).matchAll(/\n {2}([a-z][a-z0-9-]*):\n/g)].map((m) => m[1]);
  if (!names.includes('seal-start')) return ['no seal-start job'];
  const job = text.split('\n  seal-start:\n')[1].split(/\n {2}[a-z][a-z0-9-]*:\n/)[0];
  if (!/\n    name: Start the seal\n/.test(`\n${job}`)) out.push('not named Start the seal');
  const needs = new Set((/\n    needs: \[([^\]]*)\]/.exec(`\n${job}`)?.[1] ?? '').split(',').map((x) => x.trim()));
  const missing = names.filter((n) => n !== 'seal-start' && !needs.has(n));
  if (missing.length) out.push(`does not need ${missing.join(', ')}, so the seal could read the run as going`);
  // GitHub refuses a workflow whose job needs a job that does not exist, so the run never starts and nothing is proven.
  const unknown = [...needs].filter((n) => n && !names.includes(n));
  if (unknown.length) out.push(`needs ${unknown.join(', ')}, which is not a job here`);
  if (!/\n    if: \$\{\{ !cancelled\(\) && /.test(`\n${job}`)) out.push('runs for a cancelled run');
  if (!/ref: \$\{\{ github\.event\.repository\.default_branch \}\}\n\s+persist-credentials: false/.test(job))
    out.push("does not check out the default branch's script");
  if (!/\n      actions: write /.test(`\n${job}`)) out.push('cannot start the seal');
  if (/\n      (contents|pull-requests|checks|issues|statuses|id-token): write/.test(`\n${job}`))
    out.push('holds a write it does not need');
  if (!job.includes(`FINISHED: ${finished}\n`)) out.push(`FINISHED is not ${finished}`);
  if (!/\n        run: node (\.base\/)?tooling\/ci\/journey-seal\.mjs --recheck\n?/.test(`\n${job}\n`)) out.push('does not run --recheck');
  return out;
}

test('#1574: each seal input ends with Start the seal, after every other job, from the default branch; no workflow_run re-check', async () => {
  const { START_JOB, SEAL_INPUTS, REVIEWED, MONEY } = await import('./journey-seal.mjs');
  assert.equal(START_JOB, 'Start the seal');
  const finished = {
    'ci.yml': 'CI',
    'ci-review.yml': REVIEWED,
    'real-app-journeys.yml': 'Real-app journeys',
    'customer-money-browser.yml': MONEY,
    'model-check.yml': 'Model check',
  };
  assert.deepEqual(
    SEAL_INPUTS.map((i) => i.workflow),
    Object.keys(finished),
  );
  for (const [wf, f] of Object.entries(finished)) {
    const text = readFileSync(`.github/workflows/${wf}`, 'utf8');
    assert.deepEqual(startJobProblems(text, f), [], wf);
    // Planted: a job left out of `needs`, the PR's own checkout, and a missing `!cancelled()` each fail.
    const needs = /\n {4}needs: \[([^\]]*)\]\n {4}if: \$\{\{ !cancelled\(\) && /.exec(text.split('\n  seal-start:\n')[1])[1];
    if (needs.includes(','))
      assert.match(
        startJobProblems(text.replace(`needs: [${needs}]`, `needs: [${needs.split(', ').slice(1).join(', ')}]`), f).join(),
        /does not need/,
      );
    // Planted: a job that is not in the workflow (a removed planner) fails. model-check.yml has a real `plan` job.
    assert.match(
      startJobProblems(text.replace(`needs: [${needs}]`, `needs: [${needs}, removed-plan]`), f).join(),
      /needs removed-plan, which is not a job here/,
    );
    assert.match(
      startJobProblems(
        text.replace(/(\n  seal-start:\n[\s\S]*?)ref: \$\{\{ github\.event\.repository\.default_branch \}\}/, '$1ref: ${{ github.sha }}'),
        f,
      ).join(),
      /default branch/,
    );
    assert.match(
      startJobProblems(text.replace(/(\n  seal-start:\n[\s\S]*?)if: \$\{\{ !cancelled\(\) && /, '$1if: ${{ '), f).join(),
      /cancelled/,
    );
  }
  // Planted: the seal's name for the CI review must be the one recheckTargets reads.
  assert.match(startJobProblems(readFileSync('.github/workflows/ci-review.yml', 'utf8'), 'review').join(), /FINISHED is not/);
  // The separate re-check is gone: a workflow_run workflow on the seal's inputs is a run of its own on every one.
  const looped = readdirSync('.github/workflows')
    .filter((f) => f.endsWith('.yml'))
    .filter((f) => {
      const t = readFileSync(`.github/workflows/${f}`, 'utf8');
      return /--recheck/.test(t) && /\n {2}workflow_run:\n/.test(t);
    });
  assert.deepEqual(looped, []);
  assert.equal(existsSync('.github/workflows/journey-seal-recheck.yml'), false);
});

test("#1574: on a pull request ci.yml's seal reads only CI's own jobs and the switch; the steps and the review are merge-seal.yml's", () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const seal = ci.split('\n  merge-seal:\n')[1].split(/\n {2}[a-z][a-z0-9-]*:\n/)[0];
  const ifOf = (name) => new RegExp(`- name: ${name}\\n\\s+if: ([^\\n]+)`).exec(seal)?.[1] ?? '';
  for (const name of PR_READ_STEPS_LIST)
    assert.match(ifOf(name), /github\.event_name == 'merge_group'/, `${name} runs only on a merge queue's commit`);
  assert.match(ifOf('The factory switch says run'), /github\.event_name == 'pull_request'/);
  // merge-seal.yml, the default branch's copy, still runs both on every pull request, with no `if:` that skips them for one
  // but a change to the judges alone that judge-repair.mjs passed.
  const ms = readFileSync('.github/workflows/merge-seal.yml', 'utf8');
  assert.match(
    ms,
    /- name: Require the named journey steps on this exact head\n\s+if: \$\{\{ !cancelled\(\) && steps\.repair\.outputs\.pass != 'true' \}\}/,
  );
  assert.match(
    ms,
    /- name: Require the CI review on this exact head\n\s+if: \$\{\{ !cancelled\(\) && steps\.repair\.outputs\.pass != 'true' && steps\.needed\.outcome == 'success' \}\}/,
  );
});
const PR_READ_STEPS_LIST = ['Require the named journey steps on this exact head', 'Require the CI review on this exact head'];

// ---- One verdict once the inputs finish: the first attempt waits with no check on the head (#1574) -----------------

test('#1574 sealNow: a first attempt waits only when nothing could stand in for the seal and an input is still going', async () => {
  const { sealNow, CI_JOBS_NAME } = await import('./journey-seal.mjs');
  const newCi = `jobs:\n  merge-seal:\n    name: ${CI_JOBS_NAME}\n`;
  const going = ['CI run 1 (in_progress)'];
  assert.deepEqual(sealNow({ files: ['services/a.ts'], headCi: newCi, going }).now, false, 'waits');
  // Planted, each seals at once (red while waiting, as before), since a pass of its own could stand in for the seal:
  assert.equal(sealNow({ files: ['.github/workflows/x.yml'], headCi: newCi, going }).now, true, 'a workflow change');
  assert.equal(sealNow({ files: ['.github/actions/a/action.yml'], headCi: newCi, going }).now, true, 'an action change');
  assert.equal(
    sealNow({ files: ['services/a.ts'], headCi: 'jobs:\n  merge-seal:\n    name: CI merge seal\n', going }).now,
    true,
    'an old ci.yml',
  );
  assert.equal(sealNow({ files: ['services/a.ts'], headCi: null, going }).now, true, 'no ci.yml at the head');
  // Every input already finished (the first attempt got its runner late): seal now, since no re-check is coming.
  assert.equal(sealNow({ files: ['services/a.ts'], headCi: newCi, going: [] }).now, true);
  // The name sealNow looks for is the one main's ci.yml gives its job.
  assert.match(
    readFileSync('.github/workflows/ci.yml', 'utf8'),
    new RegExp(`\\n    name: ${CI_JOBS_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`),
  );
});

test('#1574 inputsGoing: CI and the review always count; journeys only when the change needs them', async () => {
  const { inputsGoing } = await import('./journey-seal.mjs');
  const sha = HEAD;
  const runsOf = {
    'ci.yml': [{ id: 1, head_sha: sha, event: 'pull_request', status: 'completed' }],
    'ci-review.yml': [{ id: 2, head_sha: sha, event: 'pull_request_target', status: 'completed' }],
    'real-app-journeys.yml': [{ id: 3, head_sha: sha, event: 'pull_request', status: 'queued' }],
  };
  assert.deepEqual(inputsGoing({ sha, runsOf, needJourneys: false }), [], 'a change that reaches no journey never waits for one');
  assert.deepEqual(inputsGoing({ sha, runsOf, needJourneys: true }), ['Real-app journeys run 3 (queued)']);
  runsOf['ci.yml'].push({ id: 4, head_sha: sha, event: 'pull_request', status: 'in_progress' });
  runsOf['ci-review.yml'].push({ id: 5, head_sha: 'f'.repeat(40), event: 'pull_request_target', status: 'in_progress' });
  assert.deepEqual(
    inputsGoing({ sha, runsOf, needJourneys: false }),
    ['CI run 4 (in_progress)'],
    "another head's review is not this head's input",
  );
});

test('project-state#4047: no CI run on the head is CI still to come, so the seal waits, never red on "no CI ran"', async () => {
  const { inputsGoing, sealNow, waitStep, CI_JOBS_NAME, NO_RUN } = await import('./journey-seal.mjs');
  const { judgeCiJobs } = await import('./ci-jobs-seal.mjs');
  const headCi = `jobs:\n  merge-seal:\n    name: ${CI_JOBS_NAME}\n`;
  const files = ['apps/customer/src/features/more/MoreRoutes.tsx'];
  // #9879 on 05a2bbde at 23:42:59 UTC, 22 Nov 2026 (seal run 45084720542): it conflicted with main, so GitHub started no
  // pull_request run; the CI review had skipped. The seal read "every input on this head has finished" and went red.
  const review = { id: 2, head_sha: HEAD, event: 'pull_request_target', status: 'completed' };
  const going = inputsGoing({ sha: HEAD, runsOf: { 'ci-review.yml': [review] }, needJourneys: true });
  assert.deepEqual(going, [`CI: ${NO_RUN} (GitHub starts none while the pull request conflicts with its base: merge main)`]);
  assert.equal(sealNow({ files, headCi, going }).now, false, 'waits: no `CI merge seal` check, so the merge stays blocked');
  // #9884 on 4059116a, 23 Nov 2026: the seal asked at 06:06:13 UTC and CI's run was created at 06:08:08. Another head's
  // or another event's CI run is not this head's.
  const other = [
    { id: 3, head_sha: 'f'.repeat(40), event: 'pull_request', status: 'completed' },
    { id: 4, head_sha: HEAD, event: 'push', status: 'completed' },
  ];
  assert.equal(inputsGoing({ sha: HEAD, runsOf: { 'ci.yml': other }, needJourneys: false }).length, 1);
  // Once CI's run on the head is there, the seal waits for it as for any input, then judges.
  const ci = { id: 1, head_sha: HEAD, event: 'pull_request', status: 'in_progress' };
  assert.deepEqual(inputsGoing({ sha: HEAD, runsOf: { 'ci.yml': [ci] }, needJourneys: false }), ['CI run 1 (in_progress)']);
  const done = { ...ci, status: 'completed', conclusion: 'failure' };
  const finished = inputsGoing({ sha: HEAD, runsOf: { 'ci.yml': [done] }, needJourneys: false });
  assert.deepEqual(finished, []);
  assert.equal(sealNow({ files, headCi, going: finished }).now, true);
  // Planted real failure: a red required job on the head's finished run is judged, and stays red (no wait).
  const red = judgeCiJobs({
    run: { ...done, run_attempt: 1 },
    jobs: [{ id: 2, name: 'Doctrine gates', status: 'completed', conclusion: 'failure' }],
    files: ['services/svc-pay/src/a.ts'],
  });
  assert.equal(red.ok, false);
  assert.equal(red.wait, false, red.lines.join('\n'));
  // A seal that must run at once (a change under .github/) on a conflicting head judges now, as before, rather than
  // waiting out its hour for a run GitHub never starts; while GitHub hasn't computed the conflict yet, or another input
  // is what is going, it waits.
  const pull = { number: 9879, state: 'open', head: { sha: HEAD } };
  assert.equal(waitStep({ pull: { ...pull, mergeable: false }, sha: HEAD, going }).act, 'judge');
  assert.equal(waitStep({ pull: { ...pull, mergeable: null }, sha: HEAD, going }).act, 'wait');
  assert.equal(waitStep({ pull: { ...pull, mergeable: false }, sha: HEAD, going: ['Real-app journeys run 5 (in_progress)'] }).act, 'wait');
});

test('project-state#4047: a seal on a draft holds its check and waits for `gh pr ready`, never red on the skipped review', async () => {
  const { sealNow, waitStep, CI_JOBS_NAME } = await import('./journey-seal.mjs');
  const headCi = `jobs:\n  merge-seal:\n    name: ${CI_JOBS_NAME}\n`;
  // #10284 on 23 Nov 2026 (seal run 45130197219): a draft touching .github/ sealed at once at 07:19 UTC and was red on the
  // CI review, which skips drafts; it was marked ready at 08:11.
  const files = ['.github/workflows/ci.yml'];
  // Planted: a .github/ change still seals at once, draft or not, so a pull request's own `CI merge seal` never stands alone.
  assert.equal(sealNow({ files, headCi, going: ['CI run 1 (in_progress)'] }).now, true);
  const pull = { number: 10284, state: 'open', draft: true, head: { sha: HEAD }, mergeable: true };
  const step = waitStep({ pull, sha: HEAD, going: [] });
  assert.equal(step.act, 'wait', 'a running check: it blocks the merge and is not red');
  assert.match(step.msg, /gh pr ready/);
  // Ready: it judges once the review it then waits for has finished.
  assert.equal(waitStep({ pull: { ...pull, draft: false }, sha: HEAD, going: ['the CI review run 2 (in_progress)'] }).act, 'wait');
  assert.equal(waitStep({ pull: { ...pull, draft: false }, sha: HEAD, going: [] }).act, 'judge');
  // A draft closed, or pushed past, stops the wait as before.
  assert.equal(waitStep({ pull: { ...pull, state: 'closed' }, sha: HEAD, going: [] }).act, 'judge');
});

test('#1574 recheckStep: a waiting first attempt is started whole; a verdict, once given, is re-run in place', async () => {
  const waitingJob = {
    id: 8,
    name: "${{ (github.run_attempt != '1' || needs.now.result != 'success' || needs.now.outputs.now == 'true') && 'CI merge seal' || '...' }}",
    status: 'completed',
    conclusion: 'skipped',
  };
  const nowJob = { id: 7, name: 'Does the seal wait for its inputs', status: 'completed', conclusion: 'success' };
  const run = (id, over) => ({ id, event: 'pull_request_target', status: 'completed', ...over });
  const J = (o) => new Map(Object.entries(o));
  const e = 'pull_request_target';
  assert.deepEqual(recheckStep([run(5)], J({ 5: [nowJob, waitingJob] }), e), {
    act: 'start',
    runId: '5',
    msg: 'run 5, the newest seal run on this head, has no verdict',
  });
  // An edit's newer waiting run beside a push's run that already gave its verdict: the newest is started, since GitHub
  // reads the check from it alone (#8225 re-ran run 5 here, and the head waited on a missing check).
  const verdict = { id: 9, name: SEAL, status: 'completed', conclusion: 'failure' };
  assert.deepEqual(recheckStep([run(5), run(6)], J({ 6: [nowJob, waitingJob], 5: [verdict] }), e), {
    act: 'start',
    runId: '6',
    msg: 'run 6, the newest seal run on this head, has no verdict',
  });
  // A first attempt still deciding: wait, so a seal it skips is then started (never `done`, which would strand it).
  assert.equal(recheckStep([run(5, { status: 'in_progress' })], J({ 5: [{ ...nowJob, status: 'in_progress' }] }), e).act, 'wait');
  // ci.yml's `CI jobs` on a head is no seal: done, not a failure.
  const ci = { id: 1, event: 'pull_request', status: 'completed' };
  assert.equal(recheckStep([ci], J({ 1: [{ id: 2, name: 'CI jobs', status: 'completed', conclusion: 'success' }] })).act, 'done');
  // Planted: a run with no seal, no waiting job and no `CI jobs` is still said, never passed.
  assert.equal(recheckStep([ci], J({ 1: [{ id: 2, name: 'Format', status: 'completed', conclusion: 'success' }] })).act, 'fail');

  // rerunSealJob starts the waiting run with a whole-run re-run (a skipped job has no attempt to re-run by itself).
  const posts = [];
  const msg = await rerunSealJob({
    repo: 'o/r',
    sha: HEAD,
    get: async (path) => (path.includes('/runs?') ? { workflow_runs: [run(5)] } : { jobs: [nowJob, waitingJob] }),
    post: async (path) => (posts.push(path), { status: 201 }),
    sleep: async () => {},
    log: () => {},
    workflow: 'merge-seal.yml',
    event: e,
  });
  assert.deepEqual(posts, ['/repos/o/r/actions/runs/5/rerun'], msg);
  // A head that moved is never started (the re-run would judge a head nobody can merge).
  const none = [];
  const skipped = await rerunSealJob({
    repo: 'o/r',
    sha: HEAD,
    get: async (path) => (path.includes('/runs?') ? { workflow_runs: [run(5)] } : { jobs: [nowJob, waitingJob] }),
    post: async (path) => (none.push(path), { status: 201 }),
    blocker: async () => ({ act: 'skip', msg: '#1 moved' }),
    sleep: async () => {},
    log: () => {},
    workflow: 'merge-seal.yml',
    event: e,
  });
  assert.deepEqual(none, []);
  assert.match(skipped, /^not started: #1 moved/);
});

test('#1574 readGoing: the re-check leaves the seal alone while an input on the head is still going', async () => {
  const { readGoing } = await import('./journey-seal.mjs');
  const reads = [];
  const get = async (path) => {
    reads.push(path);
    if (path.includes('/workflows/ci.yml/runs'))
      return { workflow_runs: [{ id: 1, head_sha: HEAD, event: 'pull_request', status: 'completed' }] };
    if (path.includes('/workflows/ci-review.yml/runs'))
      return { workflow_runs: [{ id: 2, head_sha: HEAD, event: 'pull_request_target', status: 'in_progress' }] };
    if (path.includes('/workflows/customer-money-browser.yml/runs')) return { workflow_runs: [] }; // #8708: not touched here
    if (path.includes('/workflows/model-check.yml/runs')) return { workflow_runs: [] }; // project-state#2962: no run read here
    if (path.includes('/workflows/real-app-journeys.yml/runs')) return { workflow_runs: [] };
    if (path.includes('/runs/2/jobs')) return { jobs: reviewJobs };
    if (path.includes('/files')) return [{ filename: 'docs/a.md' }];
    throw new Error(path);
  };
  let reviewJobs = [
    { name: 'CI review', status: 'in_progress' },
    { name: 'Start the seal', status: 'queued' },
  ];
  let going = await readGoing({ get, repo: 'o/r', sha: HEAD, pulls: [{ number: 3, title: 'docs: a' }] });
  assert.deepEqual(going, ['the CI review run 2 (in_progress)']);
  // The review done and only its Start the seal job going: that job is what asks, so the review counts as finished.
  reviewJobs = [
    { name: 'CI review', status: 'completed', conclusion: 'success' },
    { name: 'Start the seal', status: 'in_progress' },
  ];
  going = await readGoing({ get, repo: 'o/r', sha: HEAD, pulls: [{ number: 3, title: 'docs: a' }] });
  assert.deepEqual(going, []);
  // The seal's own wait (settle false) counts that run as going until its Start the seal job has ended too, so that job's
  // re-check finds the seal still waiting and leaves it: one verdict, not a re-run after it.
  going = await readGoing({ get, repo: 'o/r', sha: HEAD, pulls: [{ number: 3, title: 'docs: a' }], settle: false });
  assert.deepEqual(going, ['the CI review run 2 (in_progress)']);
  assert.ok(reads.some((r) => r.includes('ci-review.yml/runs?head_sha=') && r.includes('event=pull_request_target')));
  // Planted: an unreadable list fails the re-check, never reads as nothing going.
  await assert.rejects(readGoing({ get: async () => ({}), repo: 'o/r', sha: HEAD, pulls: [] }), /not a list/);
});

test('project-state #2548: the re-check never leaves the seal for a CI review run that has not started (#8574, 363a0e9b)', async () => {
  const { readGoing, inputsGoing } = await import('./journey-seal.mjs');
  // #8574 at 02:05:07 UTC, 16 Nov 2026: `gh pr ready` and an edit started two CI review runs on one head. 663 reviewed and
  // ran its Start the seal; 130, the edit's, waited `pending` behind it in the head's concurrency group, then skipped every
  // job, its Start the seal too. The re-check left the seal for 130's end, so no seal ever ran.
  const get = async (path) => {
    if (path.includes('/workflows/ci.yml/runs'))
      return { workflow_runs: [{ id: 1, head_sha: HEAD, event: 'pull_request', status: 'completed' }] };
    if (path.includes('/workflows/ci-review.yml/runs'))
      return {
        workflow_runs: [
          { id: 43789888663, head_sha: HEAD, event: 'pull_request_target', status: 'in_progress' },
          { id: 43789888130, head_sha: HEAD, event: 'pull_request_target', status: 'pending' },
        ],
      };
    if (path.includes('/workflows/customer-money-browser.yml/runs')) return { workflow_runs: [] }; // #8708: not touched here
    if (path.includes('/workflows/model-check.yml/runs')) return { workflow_runs: [] }; // project-state#2962: no run read here
    if (path.includes('/workflows/real-app-journeys.yml/runs'))
      return { workflow_runs: [{ id: 3, head_sha: HEAD, event: 'pull_request', status: 'completed' }] };
    if (path.includes('/runs/43789888663/jobs'))
      return {
        jobs: [
          { name: 'CI review', status: 'completed', conclusion: 'success' },
          { name: 'Proof read', status: 'completed', conclusion: 'success' },
          { name: 'Fix issue after merge', status: 'completed', conclusion: 'skipped' },
          { name: 'Start the seal', status: 'in_progress' },
        ],
      };
    if (path.includes('/runs/43789888130/jobs')) return { jobs: [] };
    if (path.includes('/runs/3/jobs')) return { jobs: [] };
    if (path.includes('/files')) return [{ filename: 'services/svc-agents/src/own/automation.test.ts' }];
    throw new Error(path);
  };
  const pulls = [{ number: 8574, title: 'test(svc-agents): automation.test.ts gets its own database' }];
  // The re-check (unstarted false): nothing is going, so it starts the seal.
  assert.deepEqual(await readGoing({ get, repo: 'o/r', sha: HEAD, pulls, unstarted: false }), []);
  // The seal's own wait still waits for the pending run, so a review that does run still gives the one verdict.
  assert.deepEqual(await readGoing({ get, repo: 'o/r', sha: HEAD, pulls, settle: false }), [
    'the CI review run 43789888663 (in_progress)',
    'the CI review run 43789888130 (pending)',
  ]);
  // Only the review's runs are passed over: CI's and the journeys' Start the seal run on every in-repo pull request.
  const sha = HEAD;
  const runsOf = {
    'ci.yml': [{ id: 1, head_sha: sha, event: 'pull_request', status: 'queued' }],
    'ci-review.yml': [
      { id: 2, head_sha: sha, event: 'pull_request_target', status: 'pending' },
      { id: 4, head_sha: sha, event: 'pull_request_target', status: 'in_progress' },
    ],
    'real-app-journeys.yml': [{ id: 3, head_sha: sha, event: 'pull_request', status: 'pending' }],
  };
  assert.deepEqual(inputsGoing({ sha, runsOf, needJourneys: true, unstarted: false }), [
    'CI run 1 (queued)',
    'the CI review run 4 (in_progress)',
    'Real-app journeys run 3 (pending)',
  ]);
});

test('CI review on e1ba6699: a green verdict never stands while its inputs change; an edit re-judges at once', async () => {
  const { sealNow, whileGoing, readVerdicts, CI_JOBS_NAME } = await import('./journey-seal.mjs');
  const newCi = `jobs:\n  merge-seal:\n    name: ${CI_JOBS_NAME}\n`;
  const going = ['the CI review run 2 (in_progress)'];
  // An edit (or reopen) on a head that already has a verdict: seal now, so the old green can't stand for the new title.
  assert.equal(sealNow({ files: ['services/a.ts'], headCi: newCi, going, verdict: true }).now, true);
  // Planted: the first push of a head, no verdict yet, still waits.
  assert.equal(sealNow({ files: ['services/a.ts'], headCi: newCi, going, verdict: false }).now, false);
  // The re-check: an input still going and a green verdict on the head: re-run it now (it then waits or goes red).
  assert.equal(whileGoing({ going, green: true }), 'rerun-green');
  // A red verdict already blocks, and no verdict is no check: leave both until the last input ends.
  assert.equal(whileGoing({ going, green: false }), 'leave');
  assert.equal(whileGoing({ going: [], green: false }), 'seal');
  // readVerdicts reads merge-seal.yml's latest-attempt seal jobs on the head.
  const get = async (path) =>
    path.includes('/workflows/merge-seal.yml/runs')
      ? {
          workflow_runs: [
            { id: 5, head_sha: HEAD },
            { id: 6, head_sha: HEAD },
          ],
        }
      : {
          jobs: /runs\/5\//.test(path)
            ? [{ name: SEAL, status: 'completed', conclusion: 'success' }]
            : [{ name: 'Does the seal wait for its inputs', status: 'completed', conclusion: 'success' }],
        };
  assert.deepEqual(await readVerdicts({ get, repo: 'o/r', sha: HEAD }), { any: true, green: true });
  const none = async (path) =>
    path.includes('/runs?')
      ? { workflow_runs: [{ id: 6, head_sha: HEAD }] }
      : { jobs: [{ name: 'x', status: 'completed', conclusion: 'skipped' }] };
  assert.deepEqual(await readVerdicts({ get: none, repo: 'o/r', sha: HEAD }), { any: false, green: false });
  // Planted: an unreadable list fails, never reads as "no verdict".
  await assert.rejects(readVerdicts({ get: async () => ({}), repo: 'o/r', sha: HEAD }), /not a list/);
});

// ---- Each input starts the seal itself (INTAFACED/project-state#1574, after 9 Nov 2026 14:50 UTC) ----------------------

test('#1574 settledRun: a run going only because its Start the seal job is reads as finished, with its other jobs’ conclusion', async () => {
  const { settledRun, settleRuns, START_JOB } = await import('./journey-seal.mjs');
  const run = { id: 4, status: 'in_progress', conclusion: null };
  const done = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion });
  const start = (status = 'in_progress') => ({ name: START_JOB, status });
  assert.deepEqual(settledRun(run, [done('gates'), done('CI jobs'), start()]), {
    ...run,
    status: 'completed',
    conclusion: 'success',
    settled: true,
  });
  assert.equal(settledRun(run, [done('gates', 'failure'), start('queued')]).conclusion, 'failure');
  assert.equal(settledRun(run, [done('gates', 'cancelled'), start()]).conclusion, 'cancelled');
  assert.equal(settledRun(run, [done('gates', 'skipped'), done('Tests (1/16)'), start()]).conclusion, 'success');
  // Planted, each still going: another job running, no Start the seal job, a Start the seal job not yet queued (its
  // needs not met), or no other job at all.
  assert.equal(settledRun(run, [done('gates'), { name: 'Tests (2/16)', status: 'in_progress' }, start()]).status, 'in_progress');
  assert.equal(settledRun(run, [done('gates')]).status, 'in_progress');
  assert.equal(settledRun(run, [done('gates'), start('waiting')]).status, 'in_progress');
  assert.equal(settledRun(run, [start()]).status, 'in_progress');
  // A finished run is never re-read; settleRuns reads jobs only for runs still going.
  const read = [];
  const out = await settleRuns(
    [{ id: 1, status: 'completed', conclusion: 'failure' }, run],
    async (id) => (read.push(id), [done('x'), start()]),
  );
  assert.deepEqual(read, [4]);
  assert.deepEqual(
    out.map((r) => [r.id, r.status, r.conclusion]),
    [
      [1, 'completed', 'failure'],
      [4, 'completed', 'success'],
    ],
  );
});

test("#1574 ci-jobs-seal: CI's own Start the seal job still going does not hold the verdict", async () => {
  const { judgeCiJobs } = await import('./ci-jobs-seal.mjs');
  const run = { id: 8, status: 'in_progress', run_attempt: 1 };
  const jobs = [
    { name: 'Affected tests', status: 'completed', conclusion: 'success' },
    { name: 'Doctrine gates', status: 'completed', conclusion: 'success' },
    { name: 'Format', status: 'completed', conclusion: 'success' },
    { name: 'Typecheck & build', status: 'completed', conclusion: 'success' },
    { name: 'CI jobs', status: 'completed', conclusion: 'success' },
    { name: 'Start the seal', status: 'in_progress' },
  ];
  const v = judgeCiJobs({ run, jobs, files: ['docs/a.md'] });
  assert.equal(v.wait, false, v.lines.join());
  // Planted: a job the seal reads still running holds it, as before.
  const going = judgeCiJobs({
    run,
    jobs: [...jobs.slice(0, 1), { name: 'Doctrine gates', status: 'in_progress' }, ...jobs.slice(2)],
    files: ['docs/a.md'],
  });
  assert.equal(going.wait, true);
});

// A GET that fails on the way, or gets GitHub's 502/503/504, is tried again; a refusal is not; the last failure stands
// (intafaced#7707: "which reds main already had couldn't be read (fetch failed)" on two seal attempts in a row).
test('getTried: a dropped request or a 503 is tried again, a 403 is not, and the last failure still fails closed', async () => {
  const waits = [];
  // A stand-in that records each wait instead of waiting.
  const noteWait = async (ms) => void waits.push(ms);
  const answers = (list) => {
    let i = 0;
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      const a = list[Math.min(i++, list.length - 1)];
      if (a instanceof Error) throw a;
      return { status: a, ok: a < 400 };
    };
    return { fetchImpl, calls };
  };
  const dropped = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });

  const once = answers([dropped, 503, 200]);
  assert.equal((await getTried('u', {}, { fetchImpl: once.fetchImpl, sleep: noteWait })).status, 200);
  assert.equal(once.calls.length, 3, 'a dropped request and a 503 are both tried again');
  assert.deepEqual(waits, [3000, 6000]);

  const refused = answers([403, 200]);
  assert.equal((await getTried('u', {}, { fetchImpl: refused.fetchImpl, sleep: noteWait })).status, 403, 'a refusal stands');
  assert.equal(refused.calls.length, 1, 'a 403 is never tried again');
  const limited = answers([429, 200]);
  assert.equal((await getTried('u', {}, { fetchImpl: limited.fetchImpl, sleep: noteWait })).status, 429);
  assert.equal(limited.calls.length, 1, 'a 429 is never tried again');

  const down = answers([dropped]);
  await assert.rejects(getTried('u', {}, { fetchImpl: down.fetchImpl, sleep: noteWait }), /fetch failed \(ECONNRESET\) after 3 tries/);
  assert.equal(down.calls.length, 3, 'three tries, then the error stands');
  const busy = answers([503]);
  assert.equal(
    (await getTried('u', {}, { fetchImpl: busy.fetchImpl, sleep: noteWait })).status,
    503,
    'the last 503 is returned, and api() throws on it',
  );
  assert.equal(busy.calls.length, 3);
});

test('planted: the seal reads GitHub through getTried, not one bare fetch', async () => {
  const { makeIo } = await import('./journey-seal.mjs');
  const dropped = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  const real = globalThis.fetch;
  const asked = [];
  // Each address: dropped on the way once, then answered. A bare fetch would throw on the first.
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    asked.push([u, init?.headers?.accept]);
    if (asked.filter(([a]) => a === u).length === 1) throw dropped();
    if (u.includes('/contents/')) return new Response('the file', { status: 200 });
    return new Response(JSON.stringify({ workflow_runs: [{ id: 1 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const io = makeIo(REPO, 'x');
    const [runs, text] = await Promise.all([io.mainRuns(), io.text('docs/a b.md', HEAD)]);
    assert.deepEqual(runs, [{ id: 1 }], 'api() makes its GET through getTried');
    assert.equal(text, 'the file', 'text() makes its GET through getTried');
    assert.equal(asked.length, 4, 'each GET was tried again once');
    assert.equal(
      asked.find(([u]) => u.includes('/contents/'))?.[0],
      `https://api.github.com/repos/${REPO}/contents/docs/a%20b.md?ref=${HEAD}`,
    );
    assert.equal(asked.find(([u]) => u.includes('/contents/'))?.[1], 'application/vnd.github.raw+json');
  } finally {
    globalThis.fetch = real;
  }
  // A refusal is not tried again, and still fails closed; a file that isn't there is null.
  asked.length = 0;
  globalThis.fetch = async (url) => {
    asked.push([String(url)]);
    return String(url).includes('/contents/') && String(url).includes('gone')
      ? new Response('', { status: 404 })
      : new Response('{"message":"Forbidden"}', { status: 403 });
  };
  try {
    const io = makeIo(REPO, 'x');
    await assert.rejects(io.mainRuns(), /403/);
    await assert.rejects(io.text('docs/a.md', HEAD), /HTTP 403/);
    assert.equal(await io.text('docs/gone.md', HEAD), null);
    assert.equal(asked.length, 3, 'a 403 or a 404 is asked once');
  } finally {
    globalThis.fetch = real;
  }
});

// ---- The revert main-bisect opens runs narrow (project-state #1786 item 5) ----
test('an automatic revert runs the journeys that failed on main and the reverted change own; anything forged is ordinary', async () => {
  const { autoRevertPlan, autoRevertScope, readAutoRevertScope, AUTO_REVERT_AUTHOR } = await import('./journey-seal.mjs');
  const SHA = 'c'.repeat(40);
  const pull = {
    state: 'open',
    head: { sha: HEAD, ref: `revert/auto-${SHA.slice(0, 10)}`, repo: { full_name: REPO } },
    user: { login: AUTO_REVERT_AUTHOR, type: 'Bot' },
    title: 'Revert #7, which turned the Real-app journeys red (run 9)',
    body: 'x\n\n- Red run: r\n- Failing: `J-bank-13 #2`, `J-wallet-05 #3`\n- Culprit: #7',
  };
  const paths = ['services/svc-bank/src/cards.ts', 'apps/customer/tests/real-app/J-p2p-01.pw.mjs'];
  const ok = {
    pull,
    repo: REPO,
    paths,
    commits: [{ commit: { message: `Revert "x"\n\nThis reverts commit ${SHA}.` } }],
    culprit: { sha: SHA, files: paths.map((filename) => ({ filename })) },
    culpritTitle: 'svc-ledger: a thing (J-ledger-02 #1)',
    journeyFiles: new Set(['J-bank-13.pw.mjs', 'J-wallet-05.pw.mjs', 'J-p2p-01.pw.mjs', 'J-ledger-02.pw.mjs', 'J-academy-01.pw.mjs']),
  };
  const v = autoRevertScope(ok);
  assert.equal(v.ok, true);
  assert.deepEqual(v.files, ['J-bank-13.pw.mjs', 'J-ledger-02.pw.mjs', 'J-p2p-01.pw.mjs', 'J-wallet-05.pw.mjs']);
  assert.match(v.why, /main's full journeys run after the merge guards main/);
  assert.equal(autoRevertScope({ ...ok, pull: { ...pull, head: { ...pull.head, ref: 'revert/s1b-7602' } } }), null, 'not its branch');
  const no = (over, why) => {
    const r = autoRevertScope({ ...ok, ...over });
    assert.equal(r.ok, false, why);
    assert.match(r.why, /runs the ordinary scope/);
  };
  no({ pull: { ...pull, user: { login: 'ZenYoda3', type: 'User' } } }, 'a person opened it');
  no({ pull: { ...pull, user: { login: AUTO_REVERT_AUTHOR, type: 'User' } } }, 'a user named like the App');
  no({ pull: { ...pull, head: { ...pull.head, repo: { full_name: 'fork/intafaced' } } } }, 'a fork');
  no({ commits: [...ok.commits, ...ok.commits] }, 'a second commit pushed onto it');
  no({ commits: [{ commit: { message: `Revert "x"\n\nThis reverts commit ${'d'.repeat(40)}.` } }] }, 'reverts another commit');
  no({ culprit: null }, 'the reverted commit unread');
  no({ paths: [...paths, 'services/svc-ledger/src/post.ts'] }, 'a file the reverted commit did not change');
  // intafaced #8149: shared journey setup the reverted commit changed is undone with it, back to what main proved.
  const shared = autoRevertScope({
    ...ok,
    paths: [...paths, 'tooling/scripts/local-test-market.mjs'],
    culprit: { sha: SHA, files: [...paths, 'tooling/scripts/local-test-market.mjs'].map((filename) => ({ filename })) },
  });
  assert.equal(shared.ok, true, 'shared journey setup the reverted commit changed is still an automatic revert');
  assert.deepEqual(shared.files, v.files, "the same journeys: the failing ones and the reverted change's own");
  // A pull request's run is never the full suite (project-state#3377): shared setup's revert runs its narrow files too,
  // and the seal holds it to them (before, the seal asked a full run of it: project-state #2997).
  assert.deepEqual(autoRevertPlan(shared), { files: shared.files, why: shared.why }, 'shared setup: the planner runs it narrow');
  assert.deepEqual(autoRevertPlan(v), { files: v.files, why: v.why }, 'the planner runs only its journeys');
  assert.deepEqual(autoRevertPlan(null), { files: null, why: '' }, 'not an automatic revert: the ordinary scope');
  assert.equal(autoRevertPlan(autoRevertScope({ ...ok, culprit: null })).files, null, 'a refused scope: the ordinary scope');
  no({ paths: [...paths, 'tooling/scripts/local-test-market.mjs'] }, 'shared journey setup the reverted commit did not change');
  no({ pull: { ...pull, body: '' }, paths: ['services/svc-bank/src/cards.ts'], culpritTitle: '' }, 'no journey named');
  // sealPull judges the narrow files, and names them; a forged revert gets the ordinary scope.
  const io = (p) => ({
    pull: async (n) => (n === 7 ? { title: ok.culpritTitle } : p),
    pullCommits: async () => ok.commits,
    commit: async () => ok.culprit,
    journeyFiles: async () => ok.journeyFiles,
    runs: async () => [run(1)],
    reportOf: reports({ 1: { states: {}, files: [] } }),
    files: async () => paths,
    text: async () => "test('J-p2p-01 #1 x', () => {});",
    verdictOf: async () => ({ red: [], failing: 0, missing: [] }),
  });
  const seal = await sealPull({ repo: REPO, number: 8, sha: HEAD, io: io(pull) });
  assert.match(seal.lines.join('\n'), /J-bank-13\.pw\.mjs, J-ledger-02\.pw\.mjs, J-p2p-01\.pw\.mjs, J-wallet-05\.pw\.mjs/);
  assert.doesNotMatch(seal.lines.join('\n'), /neither the title nor a Left-or-replaced line/);
  assert.equal(
    await readAutoRevertScope({ io: io(pull), repo: REPO, pull: { ...pull, head: { ...pull.head, ref: 'main' } }, number: 8, paths }),
    null,
  );
  const forged = await sealPull({ repo: REPO, number: 8, sha: HEAD, io: io({ ...pull, user: { login: 'ZenYoda3', type: 'User' } }) });
  assert.doesNotMatch(forged.lines.join('\n'), /automatic revert of/);
});

// intafaced #9482 (project-state#3637): its auto-merge stayed armed after #9483 fixed J-identity-10 #1 forward. The seal
// holds an automatic revert once main's newest finished journeys run passes its steps outright with the culprit still in.
test("an automatic revert's seal fails once main's newest journeys run passes its steps with the culprit in; red there, it passes", async () => {
  const { AUTO_REVERT_AUTHOR, revertSpent } = await import('./journey-seal.mjs');
  const CULPRIT = 'd'.repeat(40);
  const RED_HEAD = 'e'.repeat(40);
  const FIXED = 'f'.repeat(40);
  const pull = {
    state: 'open',
    draft: false,
    head: { sha: HEAD, ref: `revert/auto-${CULPRIT.slice(0, 10)}`, repo: { full_name: REPO } },
    user: { login: AUTO_REVERT_AUTHOR, type: 'Bot' },
    title: 'Revert #9426, which turned the Real-app journeys red (run 44933042118)',
    body: `x\n\n- Red run: https://github.com/${REPO}/actions/runs/1\n- Failing: \`J-identity-10 #1\`\n- Culprit: #9426, commit \`${CULPRIT}\``,
  };
  const red = mainRun(1, { head_sha: RED_HEAD, conclusion: 'failure' });
  const fixed = mainRun(2, { head_sha: FIXED });
  const io = ({ runs = [red, fixed], step = 'passed', contains = async () => true } = {}) => ({
    mainRuns: async () => runs,
    reportOf: reports({ 1: { states: { 'J-identity-10#1': 'failed' } }, 2: { states: { 'J-identity-10#1': step } } }),
    contains,
  });
  const spent = await revertSpent({ io: io(), repo: REPO, pull, culprit: CULPRIT });
  assert.match(spent, /main no longer needs this revert: main's journeys run \d+ on ffffffffff J-identity-10#1 passed outright/);
  assert.equal(await revertSpent({ io: io({ step: 'failed' }), repo: REPO, pull, culprit: CULPRIT }), null, 'still red on main: it merges');
  assert.equal(await revertSpent({ io: io({ step: 'flaky' }), repo: REPO, pull, culprit: CULPRIT }), null, 'passed only on its retry');
  assert.equal(await revertSpent({ io: io({ runs: [red] }), repo: REPO, pull, culprit: CULPRIT }), null, 'the red run is the newest');
  assert.equal(
    await revertSpent({ io: io({ contains: async (sha) => sha !== CULPRIT }), repo: REPO, pull, culprit: CULPRIT }),
    null,
    "the green run's head lacks the culprit",
  );
  assert.equal(
    await revertSpent({ io: io(), repo: REPO, pull: { ...pull, user: { login: 'ZenYoda3', type: 'User' } }, culprit: CULPRIT }),
    null,
    "not main-bisect's revert",
  );
  // Through sealPull: the same pull request, its own narrow run green, is refused while main has the step back.
  const paths = ['packages/ui/src/lit/a.ts'];
  const seal = (over) =>
    sealPull({
      repo: REPO,
      number: 9482,
      sha: HEAD,
      io: {
        ...io(over),
        pull: async (n) => (n === 9426 ? { title: 'design(customer): Volt' } : pull),
        pullCommits: async () => [{ commit: { message: `Revert "x"\n\nThis reverts commit ${CULPRIT}.` } }],
        commit: async () => ({ sha: CULPRIT, files: paths.map((filename) => ({ filename })) }),
        journeyFiles: async () => new Set(['J-identity-10.pw.mjs']),
        runs: async () => [run(7, { ran: ['J-identity-10.pw.mjs'] })],
        reportOf: reports({
          1: { states: { 'J-identity-10#1': 'failed' } },
          2: { states: { 'J-identity-10#1': over?.step ?? 'passed' } },
          7: { states: { 'J-identity-10#1': 'passed' }, files: {}, ran: ['J-identity-10.pw.mjs'] },
        }),
        files: async () => paths,
        text: async () => null,
        verdictOf: async () => ({ red: [], failing: 0, missing: [] }),
      },
    });
  const back = await seal();
  assert.equal(back.ok, false, back.lines.join('\n'));
  assert.match(back.lines.join('\n'), /main no longer needs this revert/);
  const needed = await seal({ step: 'failed' });
  assert.doesNotMatch(needed.lines.join('\n'), /main no longer needs this revert/);
  assert.equal(needed.ok, true, needed.lines.join('\n'));
});

// ---- Every run on the head is read: a red is never hidden behind a pass on the same head (#9827) ----

test('touched journeys: a red in an older run on the head holds it although a newer run ran every file clean (#9827)', async () => {
  // The #9827 shape on 822aec16bd: run 45030979813 (older) failed J-cex-spot-21 #4, run 45031001317 (newer, 14 seconds
  // later) ran the same files clean, and the seal stopped reading once the newer run covered every file.
  const older = run(2, { run_started_at: '2026-11-22T14:06:14Z' });
  const newer = run(3, { run_started_at: '2026-11-22T14:06:28Z' });
  const rep = (st) => ({ states: { 'J-cex-spot-21#4': st }, files: {}, ran: ['J-cex-spot-21.pw.mjs'] });
  const red = { red: [{ step: 'J-cex-spot-21#4', why: 'failing, not in the baseline', money: false }], failing: 1, missing: [] };
  const touched = (byRun) =>
    judgeTouchedRun({
      sha: HEAD,
      repo: REPO,
      files: ['J-cex-spot-21.pw.mjs'],
      runs: [older, newer],
      reportOf: reports(byRun),
      verdictOf: async (r) => (r.states['J-cex-spot-21#4'] === 'failed' ? red : clean),
    });
  const held = await touched({ 2: rep('failed'), 3: rep('passed') });
  assert.equal(held.ok, false, held.lines.join('\n'));
  assert.match(
    held.lines.join('\n'),
    /run 2 \(attempt 1\) has 1 step\(s\) outside the list or against its rules: J-cex-spot-21#4: failing, not in the baseline; it passed in run 3 \(attempt 1\): a step that fails then passes on one commit is flaky/,
  );
  assert.match(held.lines.join('\n'), /open-flaky\.mjs --step "J-cex-spot-21 #4"/);
  assert.deepEqual(held.kinds, ['yours']);
  // Known good: both runs clean seal it, and both are read.
  const ok = await touched({ 2: rep('passed'), 3: rep('passed') });
  assert.equal(ok.ok, true, ok.lines.join('\n'));
  assert.match(ok.lines.join('\n'), /run 3 \(attempt 1\) ran J-cex-spot-21\.pw\.mjs clean/);
  // An older run's unreadable report fails closed, as a newer one's does.
  assert.equal((await touched({ 2: { error: 'no report' }, 3: rep('passed') })).ok, false);
});

test("touched journeys: an earlier attempt's failed step that a run on the head now passes holds it; an excused one does not", async () => {
  const rerun = run(1, { run_attempt: 2 });
  const failedThen = { states: { 'J-a-01#1': 'failed' }, files: {}, ran: ['J-a-01.pw.mjs'] };
  const now = (earlier) => ({ states: { 'J-a-01#1': 'passed' }, files: {}, ran: ['J-a-01.pw.mjs'], earlier });
  const red = { red: [{ step: 'J-a-01#1', why: 'failing, not in the baseline', money: false }], failing: 1, missing: [] };
  const touched = (rep, verdictOf) =>
    judgeTouchedRun({ sha: HEAD, repo: REPO, files: ['J-a-01.pw.mjs'], runs: [rerun], reportOf: reports({ 1: rep }), verdictOf });
  const byState = async (r) => (r.states['J-a-01#1'] === 'failed' ? red : clean);
  const held = await touched(now([{ attempt: 1, ...failedThen }]), byState);
  assert.equal(held.ok, false, held.lines.join('\n'));
  assert.match(
    held.lines.join('\n'),
    /run 1 \(attempt 1\) failed 1 step\(s\) a run on this head now passes: J-a-01#1: failing, not in the baseline; it passed in run 1 \(attempt 2\): a step that fails then passes/,
  );
  // The verdict excuses it there (a step not built yet, listed in the baseline): not this rule's to hold.
  assert.equal((await touched(now([{ attempt: 1, ...failedThen }]), async () => clean)).ok, true);
  // No earlier report (the attempt ran nothing), or an earlier pass: sealed.
  assert.equal((await touched(now([]), byState)).ok, true);
  assert.equal((await touched(now([{ attempt: 1, ...now(undefined) }]), byState)).ok, true);
  // An earlier report that can't be read fails closed.
  const unread = await touched(now([{ attempt: 1, error: 'HTTP 500' }]), byState);
  assert.equal(unread.ok, false);
  assert.deepEqual(unread.kinds, ['runner']);
});

test("earlierReportArtifacts: each earlier attempt's newest report from its own window; none is left out; an unknown start fails closed", () => {
  const art = (id, at) => ({ id, name: 'real-app-journeys', created_at: at, expired: false });
  const r = { id: 9, run_attempt: 3, run_started_at: '2026-11-22T15:00:00Z' };
  const starts = new Map([
    [1, '2026-11-22T13:00:00Z'],
    [2, '2026-11-22T14:00:00Z'],
  ]);
  const arts = [
    art(1, '2026-11-22T13:30:00Z'),
    art(2, '2026-11-22T13:40:00Z'),
    art(4, '2026-11-22T15:10:00Z'),
    { ...art(5, '2026-11-22T13:50:00Z'), name: 'real-app-journeys-pick' },
  ];
  assert.deepEqual(earlierReportArtifacts(r, arts, starts), [{ attempt: 1, artifact: arts[1] }], 'attempt 2 made no report');
  assert.deepEqual(earlierReportArtifacts({ ...r, run_attempt: 1 }, arts, starts), []);
  assert.deepEqual(earlierReportArtifacts(r, arts, new Map([[2, '2026-11-22T14:00:00Z']]))[0], {
    attempt: 1,
    error: "attempt 1's start couldn't be read",
  });
  // A real re-run, #9856's run 45032927669 (the same steps failed in both attempts, so its seal rightly passes): attempt 1 started 14:27:38 and its report 14759445439 was made 14:44:00; attempt 2 began 14:46:15.
  const live = { id: 45032927669, run_attempt: 2, run_started_at: '2026-11-22T14:46:15Z' };
  const liveArts = [art(14759445439, '2026-11-22T14:44:00Z'), art(14758953776, '2026-11-22T14:52:02Z')];
  assert.deepEqual(earlierReportArtifacts(live, liveArts, new Map([[1, '2026-11-22T14:27:38Z']])), [{ attempt: 1, artifact: liveArts[0] }]);
  assert.equal(currentReportArtifact(live, liveArts).id, 14758953776);
});

test('flakyWay names the step as open-flaky.mjs reads it, the head, and the failing run', () => {
  const w = flakyWay('J-cex-spot-21#4', 'c'.repeat(40), REPO, 45030979813);
  assert.match(w, /never counts as passing \(project-state AGENTS\.md "How work flows" 4\)/);
  assert.match(w, /a re-run that passes does not clear it/);
  assert.ok(w.includes(`--step "J-cex-spot-21 #4" --sha ${'c'.repeat(40)} --run https://github.com/${REPO}/actions/runs/45030979813 `));
});

// ---- A red names its kind in its title (OWNER 289; 10-D-one-verdict.md item 8) ----

test("a red's title names its kind: yours, main's or runner", async () => {
  const full = (over) =>
    judgeTouchedRun({
      sha: HEAD,
      repo: REPO,
      files: ['J-a-01.pw.mjs'],
      runs: [run(1)],
      reportOf: reports({ 1: { ...fullRep, ran: ['J-a-01.pw.mjs'] } }),
      verdictOf: async () => clean,
      ...over,
    });
  // yours: a step red on this head and not on main.
  const bad = await full({ verdictOf: async () => dirty });
  assert.deepEqual(bad.kinds, ['yours']);
  // runner: no result to read.
  assert.deepEqual((await full({ runs: [] })).kinds, ['runner']);
  assert.deepEqual((await full({ runs: [run(1, { conclusion: 'cancelled' })] })).kinds, ['runner']);
  assert.deepEqual((await full({ reportOf: reports({ 1: { error: 'no report' } }) })).kinds, ['runner']);
  assert.deepEqual((await full({ verdictOf: async () => Promise.reject(new Error('gh: HTTP 500')) })).kinds, ['runner']);
  // main's: a red main shares that still stops this pull request (it touches the journey).
  const inherited = await full({
    verdictOf: async () => dirty,
    inherited: (red) => splitInherited({ upTo: MAIN_SHA, red, main: mainRef(), touches: area(['J-wallet-05']), rangeOf: range() }),
  });
  assert.equal(inherited.ok, false, "main's red still blocks a pull request in its area: only the title changes");
  assert.deepEqual(inherited.kinds, ["main's"]);
  const shared = await splitInherited({ red: redW, main: mainRef(), touches: { ...area(), shared: true } });
  assert.deepEqual(redKinds(shared.blocking), ["main's"], 'shared setup: every red counts, and one main shares is still named so');
  // One red of its own among main's makes it yours.
  assert.deepEqual(redKinds([{ step: 'a', onMain: true }, { step: 'b' }]), ['yours']);
  assert.equal(
    kindTitle(['runner', 'yours', 'yours'], 'Named journey steps not green on this head'),
    'yours + runner: Named journey steps not green on this head',
  );
  assert.equal(kindTitle([], 'T'), 'T');
});

test('judgeSteps: a named step that failed is yours; one with no finished run is the runner', async () => {
  const failed = await judgeSteps({
    sha: HEAD,
    repo: REPO,
    title: 'x: J-a-01 #1',
    body: '',
    runs: [run(1)],
    reportOf: reports({ 1: { states: { 'J-a-01#1': 'failed' }, files: {} } }),
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.kinds, ['yours']);
  const none = await judgeSteps({ sha: HEAD, repo: REPO, title: 'x: J-a-01 #1', body: '', runs: [], reportOf: reports({}) });
  assert.deepEqual(none.kinds, ['runner']);
});

// ---- No red while waiting (project-state OWNER 262 part 2): the seal waits in its job, then judges once -------------

test('OWNER 262: the seal waits in its job while an input is going, and judges once none is', async () => {
  const { waitStep, WAIT_STEP, WAIT_POLLS, WAIT_POLL_MS } = await import('./journey-seal.mjs');
  const pull = { number: 3, state: 'open', head: { sha: HEAD } };
  assert.equal(waitStep({ pull, sha: HEAD, going: ['CI run 1 (in_progress)'] }).act, 'wait');
  assert.equal(waitStep({ pull, sha: HEAD, going: [] }).act, 'judge');
  // Planted: a closed pull request or a moved head stops the wait, and the judging steps then say so (red, as before).
  assert.equal(waitStep({ pull: { ...pull, state: 'closed' }, sha: HEAD, going: ['x'] }).act, 'judge');
  assert.equal(waitStep({ pull: { ...pull, head: { sha: 'f'.repeat(40) } }, sha: HEAD, going: ['x'] }).act, 'judge');
  // merge-seal.yml's step carries WAIT_STEP's name, runs before every judging step, and the job's limit covers the wait
  // and the CI review's 20 minutes after it.
  const yml = readFileSync('.github/workflows/merge-seal.yml', 'utf8');
  const seal = yml.slice(yml.indexOf('\n  seal:\n'));
  const at = seal.indexOf(`- name: ${WAIT_STEP}\n`);
  assert.ok(at > 0, 'the seal job has the wait step');
  assert.match(seal.slice(at, seal.indexOf('\n      - ', at + 1)), /run: node tooling\/ci\/journey-seal\.mjs --wait-inputs\n/);
  assert.ok(at < seal.indexOf('- name: Require CI'), 'it waits before judging');
  assert.ok(Number(/\n    timeout-minutes: (\d+)/.exec(seal)?.[1]) >= (WAIT_POLLS * WAIT_POLL_MS) / 60_000 + 20 + 1);
  assert.ok(WAIT_POLL_MS >= 300_000, 'a waiting seal checks at most every 5 minutes, to spare the installation API limit');
});

test('OWNER 262: a re-check leaves a seal still waiting for its inputs alone, and waits out one already judging', async () => {
  const { WAIT_STEP } = await import('./journey-seal.mjs');
  const run = { id: 5, event: 'pull_request_target', status: 'in_progress' };
  const J = (jobs) => new Map([['5', jobs]]);
  const e = 'pull_request_target';
  const sealJob = (steps) => ({ id: 9, name: SEAL, status: 'in_progress', steps });
  const waiting = sealJob([
    { name: 'Run actions/checkout', status: 'completed', conclusion: 'success' },
    { name: WAIT_STEP, status: 'in_progress' },
    { name: "Require CI's jobs on this exact head", status: 'queued' },
  ]);
  assert.equal(recheckStep([run], J([waiting]), e).act, 'done', 'still waiting: it reads the inputs itself');
  const queuedWait = sealJob([{ name: WAIT_STEP, status: 'queued' }]);
  assert.equal(recheckStep([run], J([queuedWait]), e).act, 'done', 'not yet at the wait');
  // Planted: past its wait it may have read inputs before this change, so it is waited out and re-run, as before.
  const judging = sealJob([
    { name: WAIT_STEP, status: 'completed', conclusion: 'success' },
    { name: "Require CI's jobs on this exact head", status: 'in_progress' },
  ]);
  assert.equal(recheckStep([run], J([judging]), e).act, 'wait');
  assert.equal(recheckStep([run], J([sealJob(undefined)]), e).act, 'wait', 'a seal with no steps listed is waited out');
});

test('#7996: a deferred journeys run counts as going, never as a finished run that reports no step', async () => {
  const { readGoing } = await import('./journey-seal.mjs');
  const { DEFER_MARK, TOUCH_JOB } = await import('./main-first.mjs');
  const touch = (deferred) => ({
    jobs: [{ name: TOUCH_JOB, status: 'completed', steps: [{ name: DEFER_MARK, conclusion: deferred ? 'success' : 'skipped' }] }],
  });
  const done = (id, over = {}) => ({ id, head_sha: HEAD, event: 'pull_request', status: 'completed', ...over });
  const at = (journeys, jobsOf) => async (path) => {
    if (path.includes('/workflows/ci.yml/runs')) return { workflow_runs: [done(1)] };
    if (path.includes('/workflows/ci-review.yml/runs')) return { workflow_runs: [done(2, { event: 'pull_request_target' })] };
    if (path.includes('/workflows/customer-money-browser.yml/runs')) return { workflow_runs: [] }; // #8708: not touched here
    if (path.includes('/workflows/model-check.yml/runs')) return { workflow_runs: [] }; // project-state#2962: no run read here
    if (path.includes('/workflows/real-app-journeys.yml/runs')) return { workflow_runs: journeys };
    if (path.includes('/runs/2/jobs')) return { jobs: [{ name: 'CI review', status: 'completed', conclusion: 'success' }] };
    const m = /\/runs\/(\d+)\/jobs/.exec(path);
    if (m) return jobsOf[m[1]];
    if (path.includes('/files')) return [{ filename: 'services/svc-a/src/a.ts' }];
    throw new Error(path);
  };
  const pulls = [{ number: 3, title: 'svc-a: J-a-01 #1' }];
  for (const settle of [true, false]) {
    const going = await readGoing({ get: at([done(30)], { 30: touch(true) }), repo: 'o/r', sha: HEAD, pulls, settle });
    assert.equal(going.length, 1);
    assert.match(going[0], /Real-app journeys run 30 \(deferred/);
  }
  // Planted: a run that ran, and a deferred run a newer finished run on the head superseded, hold nothing.
  assert.deepEqual(await readGoing({ get: at([done(30)], { 30: touch(false) }), repo: 'o/r', sha: HEAD, pulls }), []);
  assert.deepEqual(
    await readGoing({ get: at([done(30), done(31)], { 30: touch(true), 31: touch(false) }), repo: 'o/r', sha: HEAD, pulls }),
    [],
  );
  // A change that needs no journeys never waits for a deferred one.
  const docs = async (path) => (path.includes('/files') ? [{ filename: 'docs/a.md' }] : at([done(30)], { 30: touch(true) })(path));
  assert.deepEqual(await readGoing({ get: docs, repo: 'o/r', sha: HEAD, pulls: [{ number: 3, title: 'docs: a' }] }), []);
  // Planted: unreadable jobs fail closed.
  await assert.rejects(readGoing({ get: at([done(30)], { 30: {} }), repo: 'o/r', sha: HEAD, pulls }), /not a list/);
});

// ---- The lead's decision of 12 Nov 2026 (OWNER 296/297): a step already red on main, tracked there, is main's ----

const NEW_MAIN = 'e'.repeat(40);
const reg = (n, title, labels = ['regression'], over = {}) => ({
  number: n,
  state: 'open',
  title,
  labels: labels.map((name) => ({ name })),
  ...over,
});

test("main's own: the tracking issue is an open regression issue for the journey or an open flaky issue for the step", () => {
  const issues = [
    reg(1, 'Journey broken on main: J-a-01'),
    reg(2, 'Flaky step on main: J-b-01 #2 #5', ['flaky']),
    reg(3, 'Flaky money step on main: J-c-01 #4', ['flaky']),
    reg(4, 'Journey broken on main: J-d-01', []),
    reg(5, 'Journey broken on main: J-e-01', ['regression'], { state: 'closed' }),
    reg(6, 'Journey broken on main: J-f-01', ['regression'], { pull_request: {} }),
    reg(7, 'Flaky step on main: J-g-01 #1', ['regression']),
  ];
  assert.equal(trackingIssue(issues, 'J-a-01#3')?.number, 1);
  assert.equal(trackingIssue(issues, 'J-b-01#5')?.number, 2);
  assert.equal(trackingIssue(issues, 'J-b-01#3'), undefined, 'a flaky issue tracks only its own steps');
  assert.equal(trackingIssue(issues, 'J-b-01#25'), undefined);
  assert.equal(trackingIssue(issues, 'J-c-01#4')?.number, 3);
  assert.equal(trackingIssue(issues, 'J-d-01#1'), undefined, 'unlabelled: not tracked');
  assert.equal(trackingIssue(issues, 'J-e-01#1'), undefined, 'closed: not tracked');
  assert.equal(trackingIssue(issues, 'J-f-01#1'), undefined, 'a pull request is no issue');
  assert.equal(trackingIssue(issues, 'J-g-01#1'), undefined, 'a flaky title needs the flaky label');
  assert.equal(trackingIssue(issues, 'J-a-011#1'), undefined, 'a journey is matched whole');
});

test("main's own planted: excused only when main's newest run has it red the same way, an issue tracks it and the PR touches no test", () => {
  const latest = mainRef({ run: mainRun(60, { head_sha: NEW_MAIN }) });
  const issues = [reg(9, 'Journey broken on main: J-wallet-05')];
  const go = (over = {}) =>
    mainsOwn({ blocking: redW, latest, issues, touches: { ...area([], ['tooling/factory/x.mjs']), shared: false }, ...over });
  const ok = go();
  assert.deepEqual(ok.blocking, []);
  assert.match(ok.passed[0].why, /main's: main's newest finished run 60 on eeeeeeeeee has it red too and #9 tracks it/);
  assert.equal(go({ issues: [] }).blocking.length, 1, 'no open issue: every red counts');
  assert.equal(go({ latest: null }).blocking.length, 1, 'no main run: every red counts');
  assert.equal(go({ latest: { ...latest, problems: ['x'] } }).blocking.length, 1, 'main run with unreadable inputs');
  assert.equal(go({ latest: mainRef({ red: new Map() }) }).blocking.length, 1, "green on main: the PR's own");
  assert.equal(
    go({ latest: mainRef({ red: new Map([['J-wallet-05#3', 'passed on its retry']]) }) }).blocking.length,
    1,
    "a different verdict line on main: the PR's own",
  );
  const red2 = [...redW, { step: 'J-bank-13#1', why: 'failing, not in the baseline', money: false }];
  const mixed = go({ blocking: red2 });
  assert.deepEqual(
    mixed.blocking.map((x) => x.step),
    ['J-bank-13#1'],
    'every other red still counts',
  );
  const journey = go({ touches: { ...area(['J-wallet-05'], []), shared: false } });
  assert.equal(journey.blocking.length, 1, "the PR touches the step's journey");
  assert.match(journey.blocking[0].why, /#9\), but this pull request changes J-wallet-05, so it is this pull request's/);
  for (const f of [
    'apps/customer/tests/real-app/J-bank-13.pw.mjs',
    'apps/customer/tests/real-app/helpers/login.mjs',
    'apps/customer/playwright.real-app.config.ts',
  ])
    assert.equal(go({ touches: { ...area([], [f]), shared: false } }).blocking.length, 1, `a test file the shards read: ${f}`);
  assert.equal(go({ touches: { ...area([], ['tooling/factory/x.mjs']), shared: true } }).blocking.length, 1, 'shared setup');
  assert.equal(go({ blocking: [{ ...redW[0], money: true }] }).blocking.length, 1, 'a money step is never passed over (REVIEW.md item 3)');
  assert.equal(go({ blocking: [{ step: redW[0].step, why: redW[0].why }] }).blocking.length, 1, 'unmarked counts as money');
});

test("main's own sealPull planted: main's newest run outside the head's history is red and tracked; the PR seals only then", async () => {
  const io = ({ files, issues = [reg(9, 'Journey broken on main: J-wallet-05')], newest = dirty, mainIssues = true }) => ({
    pull: async () => ({ state: 'open', head: { sha: HEAD }, base: { sha: MAIN_SHA }, title: 'gate: drop a folder', body: '' }),
    runs: async () => [run(1)],
    reportOf: reports({ 1: { ...fullRep, ran: ['J-bank-13.pw.mjs', 'J-wallet-05.pw.mjs', ...CANARY] }, 50: fullRep, 60: fullRep }),
    files: async () => files,
    text: async () => 'test(`${J} #1 opens`, async () => {}); test(`${J} #3 sends`, async () => {});',
    verdictOf: async (_rep, r) => (r.id === 60 ? newest : r.id === 50 ? { ...clean, lastPass: {} } : dirty),
    mainRuns: async () => [mainRun(50), mainRun(60, { head_sha: NEW_MAIN, created_at: '2026-11-12T10:00:00Z' })],
    contains: async (sha, head) => sha === MAIN_SHA && head === HEAD,
    mergeBase: async () => MAIN_SHA,
    rangeOf: async () => ({ files: [], commits: 0, short: false }),
    ...(mainIssues ? { mainIssues: async () => issues } : {}),
  });
  const seal = (o) => sealPull({ repo: REPO, number: 7, sha: HEAD, io: io(o) });
  const ok = await seal({ files: ['tooling/factory/x.mjs'] });
  assert.equal(ok.ok, true, ok.lines.join('\n'));
  assert.match(ok.lines.join('\n'), /J-wallet-05#3 is red on this head and inherited: it is main's: main's newest finished run 60/);
  assert.equal((await seal({ files: ['tooling/factory/x.mjs'], issues: [] })).ok, false, 'untracked on main: the PR is held');
  assert.equal((await seal({ files: ['tooling/factory/x.mjs'], newest: { ...clean, lastPass: {} } })).ok, false, 'green on main: held');
  assert.equal((await seal({ files: ['tooling/factory/x.mjs'], mainIssues: false })).ok, false, 'no issue reader: as before');
  const tests = await seal({ files: ['tooling/factory/x.mjs', 'apps/customer/tests/real-app/J-bank-13.pw.mjs'] });
  assert.equal(tests.ok, false, 'a PR that changes a test file: the step is its own');
  const shared = await seal({ files: ['tooling/scripts/local-test-world.mjs'] });
  assert.equal(shared.ok, false, 'shared setup: every red counts');
  const broken = await sealPull({
    repo: REPO,
    number: 7,
    sha: HEAD,
    io: { ...io({ files: ['tooling/factory/x.mjs'] }), mainIssues: async () => Promise.reject(new Error('HTTP 502')) },
  });
  assert.equal(broken.ok, false, 'unreadable issues fail closed');
});

test("sealPull judges tooling by the head's tree, as the run's planner picks: unreached runs none; reached, unscanned or a failed scan keep the bounded set", async () => {
  const seen = [];
  const io = (toolingReach) => ({
    pull: async () => ({ state: 'open', head: { sha: HEAD }, base: { sha: MAIN_SHA }, title: 'design: a recipe page', body: '' }),
    runs: async (h) => (seen.push(h), [run(1)]),
    reportOf: reports({ 1: { ...fullRep, ran: ['J-bank-13.pw.mjs', ...CANARY] } }),
    files: async () => ['tooling/design/RECIPE.md', 'tooling/design/volt-recipe.mjs'],
    text: async () => 'test(`${J} #1 opens`, async () => {});',
    verdictOf: async () => clean,
    mainRuns: async () => [],
    contains: async () => true,
    mergeBase: async () => MAIN_SHA,
    rangeOf: async () => ({ files: [], commits: 0, short: false }),
    mainIssues: async () => [],
    ...(toolingReach ? { toolingReach } : {}),
  });
  const pick = async (toolingReach) => {
    seen.length = 0;
    const r = await sealPull({ repo: REPO, number: 7, sha: HEAD, io: io(toolingReach) });
    return { ok: r.ok, lines: r.lines.join('\n'), readRuns: seen.length > 0 };
  };
  const asked = [];
  const none = await pick(async (sha) => (asked.push(sha), ['tooling/uiproof/']));
  assert.deepEqual(asked, [HEAD], "the head's tree is the one scanned");
  assert.equal(none.ok, true, none.lines);
  assert.equal(none.readRuns, false, 'tooling no journeys run reaches: no journeys to judge');
  for (const [why, reach] of [
    ['reached by a journey', async () => ['tooling/design/']],
    ['a scan that fails', async () => Promise.reject(new Error('git archive failed'))],
    ['a scan that could not read the tree', async () => null],
    ['no scanner', null],
  ]) {
    const r = await pick(reach);
    assert.equal(r.readRuns, true, `${why}: the bounded set is judged, as today`);
  }
});

// ---- A merged pull request has nothing left to seal (12 of the 66 failed seals, 12 Nov 2026) ----

test('merged: a seal on a pull request that already merged passes, unless another open pull request has its head', async () => {
  const { mergedNothingToSeal } = await import('./review-marker.mjs');
  const pull = { number: 7, state: 'closed', merged_at: '2026-11-12T12:19:33Z', head: { sha: HEAD } };
  const mine = [{ number: 7, state: 'closed' }];
  assert.match(mergedNothingToSeal(pull, HEAD, mine), /#7 merged at 2026-11-12T12:19:33Z; a merged pull request has nothing left to seal/);
  assert.equal(mergedNothingToSeal({ ...pull, merged_at: null }, HEAD, mine), null, 'closed, not merged: as before');
  assert.equal(mergedNothingToSeal({ ...pull, state: 'open', merged_at: null }, HEAD, mine), null, 'open: as before');
  assert.equal(mergedNothingToSeal(pull, 'b'.repeat(40), mine), null, 'another head');
  assert.equal(mergedNothingToSeal(pull, HEAD, [...mine, { number: 8, state: 'open' }]), null, 'another open PR on this head');
  assert.equal(mergedNothingToSeal(pull, HEAD, [...mine, { number: 8, state: 'closed' }]) === null, false, 'a closed one is no matter');
  assert.equal(mergedNothingToSeal(pull, HEAD, null), null, 'unreadable list: as before');
  const io = (over = {}) => ({
    pull: async () => ({ ...pull, title: 'x (J-a-01 #1)', body: '', base: { sha: MAIN_SHA }, ...over }),
    pullsOn: async () => mine,
    files: async () => {
      throw new Error('a merged pull request is not read further');
    },
  });
  const ok = await sealPull({ repo: REPO, number: 7, sha: HEAD, io: io() });
  assert.equal(ok.ok, true, ok.lines.join('\n'));
  const closed = await sealPull({ repo: REPO, number: 7, sha: HEAD, io: io({ merged_at: null }) });
  assert.deepEqual(closed, { ok: false, lines: ['#7: is closed'] }, 'planted: closed without a merge still fails');
  const shared = await sealPull({
    repo: REPO,
    number: 7,
    sha: HEAD,
    io: { ...io(), pullsOn: async () => [...mine, { number: 8, state: 'open' }] },
  });
  assert.equal(shared.ok, false, 'planted: another open PR on the head still fails');
});

// ---- A money-flag mismatch main made, judged with the head's own money rule (#9601) ----

// Built from #9601 at 9c7bcc7b61 (seal job 137092933754, 22 Nov 2026): #9539 gave apps/admin an unused ledger-client
// dependency, main's rule called J-ops-console-22 #3 money, the baseline says money false, and the seal read with main's
// rule alone held every pull request whose run reached the step, #9601's fix (which drops the dependency) included.
test('sealPull: a money-flag mismatch main made passes on a head whose own money rule agrees with the baseline, and only there (#9601)', async () => {
  const step = 'J-ops-console-22#3';
  const file = 'J-ops-console-22.pw.mjs';
  const parked = {
    issue: { number: 9, state: 'open', title: 'Journey broken on main: J-ops-console-22' },
    comments: [
      { author_association: 'MEMBER', created_at: '2026-11-01T00:00:00Z', body: 'Regression state: parked — needs the stack. Lane B1.' },
    ],
  };
  const named = { states: { [step]: 'failed' }, files: { [step]: file }, ran: [file] };
  const inputs = {
    baseline: { run: { number: 100, id: 1, sha: PASS_SHA }, steps: [{ step, state: 'regression', money: false, issue: 9 }] },
    money: { [step]: true }, // main's rule since #9539
    reports: new Map(),
  };
  const read = (issue) => () => ({ named, passedSince: {}, issues: { 9: issue }, problems: [], shas: {} });
  const rep = { states: { [step]: 'failed' }, files: { [step]: file }, ran: [...CANARY, file] };
  const asked = [];
  const io = ({ headMoney, issue = parked }) => ({
    pull: async () => ({ state: 'open', head: { sha: HEAD }, title: 'admin: drop the unused ledger-client devDependency', body: '' }),
    runs: async () => [run(1)],
    reportOf: reports({ 1: rep }),
    files: async () => ['apps/admin/package.json'],
    verdictOf: async (report, r, o = {}) =>
      fullVerdict({ repo: REPO, report, run: r, inputs, read: read(issue), headMoney: o.headMoney ?? null }),
    ...(headMoney === undefined
      ? {}
      : {
          headMoney: async (sha) => {
            asked.push(sha);
            if (headMoney instanceof Error) throw headMoney;
            return headMoney;
          },
        }),
  });
  const seal = (o) => sealPull({ repo: REPO, number: 9601, sha: HEAD, io: io(o) });
  // The planted fix: the head's own rule says not money, as the baseline does.
  const fixed = await seal({ headMoney: { [step]: false } });
  assert.equal(fixed.ok, true, fixed.lines.join('\n'));
  assert.match(
    fixed.lines.join('\n'),
    /main's money rule disagrees with the baseline on J-ops-console-22#3, and this head's own rule agrees/,
  );
  assert.deepEqual(asked, [HEAD], "the head's rule is read once, for this head");
  // The same mismatch on a head that does not fix it stays red, and so does one whose rule can't be read or isn't given.
  for (const [o, why] of [
    [{ headMoney: { [step]: true } }, /J-ops-console-22#3: the baseline says money false, the money rule at this commit says true/],
    [{ headMoney: {} }, /the money rule at this commit says true/],
    [{ headMoney: new Error('GraphQL: HTTP 502') }, /this head's own money rule couldn't be read \(GraphQL: HTTP 502\), so it stays red/],
    [{}, /the money rule at this commit says true/],
  ]) {
    const v = await seal(o);
    assert.equal(v.ok, false, JSON.stringify(o));
    assert.match(v.lines.join('\n'), why);
  }
  // Agreeing never loosens the step: a red it still gives counts as money, so it is never passed over as inherited.
  const closed = { ...parked, issue: { ...parked.issue, state: 'closed' } };
  const still = await seal({ headMoney: { [step]: false }, issue: closed });
  assert.equal(still.ok, false);
  assert.match(still.lines.join('\n'), /#9 is closed/);
  const v = fullVerdict({ repo: REPO, report: rep, run: run(1), inputs, read: read(closed), headMoney: { [step]: false } });
  assert.deepEqual(
    v.red.map((x) => [x.step, x.money]),
    [[step, true]],
  );
  const passedOver = await splitInherited({
    upTo: MAIN_SHA,
    red: v.red,
    main: { run: { id: 50, head_sha: MAIN_SHA }, problems: [], red: new Map([[step, v.red[0].why]]), lastPass: { [step]: MAIN_SHA } },
    touches: { journeys: new Set(), paths: new Set(['apps/admin/package.json']), shared: false },
    rangeOf: async () => ({ files: [], commits: 1, short: false }),
  });
  assert.equal(passedOver.passed.length, 0, 'a money red is never passed over as inherited');
  // A clean verdict reads no head rule, on a pull request that changes no file the rule or the baseline is read from.
  asked.length = 0;
  const clean = await sealPull({
    repo: REPO,
    number: 9601,
    sha: HEAD,
    io: {
      ...io({ headMoney: { [step]: false } }),
      files: async () => ['apps/admin/src/lib/ops-desk/catalog.ts'],
      verdictOf: async () => ({ red: [], failing: 0, missing: [] }),
    },
  });
  assert.equal(clean.ok, true);
  assert.deepEqual(asked, []);
});

test("moneyAt reads the money rule a checkout holds, as rootInputs does (the seal reads a pull request's head this way)", async () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const at = (p) => join(root, p);
  const list = async (dir) =>
    existsSync(at(dir))
      ? readdirSync(at(dir), { withFileTypes: true }).map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }))
      : null;
  const blobs = async (paths) => new Map(paths.map((p) => [p, existsSync(at(p)) ? readFileSync(at(p), 'utf8') : null]));
  const text = async (p) => readFileSync(at(p), 'utf8');
  const here = rootInputs(root).money;
  assert.deepEqual(await moneyAt({ list, blobs, text }), here);
  // Planted: the admin app's manifest with and without the ledger client gives a different money rule, as #9539 did.
  const admin = (has) => async (paths) => {
    const m = await blobs(paths);
    const pkg = JSON.parse(m.get('apps/admin/package.json'));
    pkg.devDependencies = { ...pkg.devDependencies };
    if (has) pkg.devDependencies['@intafaced/ledger-client'] = 'workspace:*';
    else delete pkg.devDependencies['@intafaced/ledger-client'];
    m.set('apps/admin/package.json', JSON.stringify(pkg));
    return m;
  };
  const withIt = await moneyAt({ list, blobs: admin(true), text });
  const without = await moneyAt({ list, blobs: admin(false), text });
  const moved = Object.keys(withIt).filter((k) => withIt[k] !== without[k]);
  assert.ok(moved.length > 0 && moved.every((k) => withIt[k] && !without[k]), 'the admin manifest is read');
  // Unreadable: it throws, so the seal keeps the red.
  await assert.rejects(moneyAt({ list, blobs, text: async () => null }), /journeys\.json could not be read/);
});

// ---- A change that makes a baselined step money, judged with its head's own money rule (#9539, project-state #3686 half 1) ----

// Built from #9539 at d0887b4 (its journeys run 44971771966 was red on 8 such rows, 22 Nov 2026): it gave apps/admin a
// ledger-client dependency, so its own rule called J-ops-console-22 #3 money while the baseline says money false. Main's
// rule (125ec198c) still agreed with the baseline, so the seal, reading main's inputs alone, passed it and broke main.
test("sealPull: a pull request whose own money rule makes a baselined step money is red, though main's rule agrees (#9539)", async () => {
  const step = 'J-ops-console-22#3';
  const file = 'J-ops-console-22.pw.mjs';
  const parked = {
    issue: { number: 9, state: 'open', title: 'Journey broken on main: J-ops-console-22' },
    comments: [
      { author_association: 'MEMBER', created_at: '2026-11-01T00:00:00Z', body: 'Regression state: parked — needs the stack. Lane B1.' },
    ],
  };
  const named = { states: { [step]: 'failed' }, files: { [step]: file }, ran: [file] };
  const entry = { step, state: 'regression', money: false, issue: 9 };
  const inputs = { baseline: { run: { number: 100, id: 1, sha: PASS_SHA }, steps: [entry] }, money: { [step]: false }, reports: new Map() };
  const read = () => ({ named, passedSince: {}, issues: { 9: parked }, problems: [], shas: {} });
  const rep = { states: { [step]: 'failed' }, files: { [step]: file }, ran: [...CANARY, file] };
  const asked = [];
  const seal = ({ headMoney, files = ['apps/admin/package.json'], headBaseline = null }) =>
    sealPull({
      repo: REPO,
      number: 9539,
      sha: HEAD,
      io: {
        pull: async () => ({ state: 'open', head: { sha: HEAD }, title: 'admin: the ops desk reads the ledger', body: '' }),
        runs: async () => [run(1)],
        reportOf: reports({ 1: rep }),
        files: async () => files,
        text: async (p) => (p === 'docs/runbooks/journey-baseline.json' && headBaseline ? JSON.stringify(headBaseline) : null),
        verdictOf: async (report, r, o = {}) => fullVerdict({ repo: REPO, report, run: r, inputs, read, ...o }),
        headMoney: async (sha) => {
          asked.push(sha);
          if (headMoney instanceof Error) throw headMoney;
          return headMoney;
        },
      },
    });
  // The planted fault: the head's rule calls the step money, the baseline it would merge says not.
  const broke = await seal({ headMoney: { [step]: true } });
  assert.equal(broke.ok, false, broke.lines.join('\n'));
  assert.match(
    broke.lines.join('\n'),
    /J-ops-console-22#3: with this pull request, the baseline says money false, the money rule at its head says true/,
  );
  assert.deepEqual(asked, [HEAD]);
  // As money, so it is never passed over as inherited.
  const v = fullVerdict({ repo: REPO, report: rep, run: run(1), inputs, read, headMoney: { [step]: true } });
  assert.deepEqual(
    v.red.map((x) => [x.step, x.money]),
    [[step, true]],
  );
  // Known good: a head whose rule still agrees, and one that moves the entry with its rule (money, unbuilt), both seal.
  assert.equal((await seal({ headMoney: { [step]: false } })).ok, true);
  const moved = await seal({
    headMoney: { [step]: true },
    files: ['apps/admin/package.json', 'docs/runbooks/journey-baseline.json'],
    headBaseline: { ...inputs.baseline, steps: [{ step, state: 'unbuilt', money: true }] },
  });
  assert.equal(moved.ok, true, moved.lines.join('\n'));
  // Unreadable: the head's rule, or the baseline it changes, fails the seal closed.
  for (const o of [
    { headMoney: new Error('GraphQL: HTTP 502') },
    { headMoney: { [step]: false }, files: ['docs/runbooks/journey-baseline.json'] },
  ]) {
    const v = await seal(o);
    assert.equal(v.ok, false, JSON.stringify(o));
    assert.match(v.lines.join('\n'), /which the money rule or the baseline is read from, and its head's couldn't be read .*fails closed/);
  }
});

test('moneyInput: the files the money rule and the baseline are read from', () => {
  for (const p of [
    'docs/roadmap/journeys.json',
    'docs/roadmap/slices.json',
    'docs/runbooks/journey-baseline.json',
    'apps/admin/package.json',
    'packages/ledger-client/package.json',
    'crates/svc-ledger/Cargo.toml',
  ])
    assert.equal(moneyInput(p), true, p);
  for (const p of ['apps/admin/src/a.ts', 'package.json', 'apps/admin/sub/package.json', 'docs/roadmap/other.json'])
    assert.equal(moneyInput(p), false, p);
});

// ---- A pure revert merges on main's other checks (intafaced #9603, 22 Nov 2026) ----
// Planted in a real repository, so each case is a real commit and GitHub's answers are git's: the revert main-bisect
// opens of main's newest merge passes the seal with a red journeys run on its head and is not waited on; one extra
// changed line, in the culprit's file or another, and a revert of an older merge whose file main changed since, are
// judged in full (that red run fails them).
test('a pure revert of a merge on main passes the seal and is not waited on; one extra line or an older merge is judged in full', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { AUTO_REVERT_AUTHOR, readPureRevert, readGoing } = await import('./journey-seal.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'pure-revert-'));
  try {
    const g = (...args) =>
      execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const A = 'services/svc-support/src/chat.ts';
    const B = 'services/svc-support/src/other.ts';
    const put = (f, lines) => {
      execFileSync('mkdir', ['-p', join(dir, f, '..')]);
      writeFileSync(join(dir, f), `${lines.join('\n')}\n`);
    };
    const ten = (p) => Array.from({ length: 10 }, (_, i) => `${p}${i}`);
    g('init', '-q', '-b', 'main');
    put(A, ten('a'));
    put(B, ten('b'));
    g('add', '.');
    g('commit', '-qm', 'base');
    put(
      A,
      ten('a').map((l, i) => (i === 2 ? 'culprit' : l)),
    );
    g('commit', '-qam', 'culprit (#1)');
    const culprit = g('rev-parse', 'HEAD');
    put(
      B,
      ten('b').map((l, i) => (i === 5 ? 'later' : l)),
    );
    g('commit', '-qam', 'a later merge on another file (#2)');
    const later = g('rev-parse', 'HEAD');
    const revertOn = (base, extra) => {
      g('checkout', '-q', '--detach', base);
      g('revert', '--no-edit', culprit);
      if (extra) {
        execFileSync('sh', ['-c', `echo extra >> ${JSON.stringify(join(dir, extra))}`]);
        g('commit', '-q', '--amend', '--no-edit', '-a');
      }
      const sha = g('rev-parse', 'HEAD');
      g('checkout', '-q', 'main');
      return sha;
    };
    const pure = revertOn(later);
    const extraInCulpritFile = revertOn(later, A);
    const extraElsewhere = revertOn(later, B);
    // The compare API: status and files from `base` to `head` (git's merge base, as GitHub's three dots).
    const compare = async (base, head) => {
      const b = g('rev-parse', base);
      const h = g('rev-parse', head);
      let status = b === h ? 'identical' : 'ahead';
      try {
        g('merge-base', '--is-ancestor', b, h);
      } catch {
        status = 'diverged';
      }
      return {
        status,
        files: g('diff', '--name-only', `${b}...${h}`)
          .split('\n')
          .filter(Boolean)
          .map((filename) => ({ filename })),
      };
    };
    const commitOf = async (sha) => ({
      sha,
      parents: g('rev-list', '--parents', '-n', '1', sha)
        .split(' ')
        .slice(1)
        .map((s) => ({ sha: s })),
      files: g('show', '--name-only', '--format=', sha)
        .split('\n')
        .filter(Boolean)
        .map((filename) => ({ filename })),
    });
    const pathsOf = (head) => g('diff', '--name-only', `main...${head}`).split('\n').filter(Boolean);
    const pullAt = (head, over = {}) => ({
      number: 9,
      state: 'open',
      title: 'ci: revert #1, which turned main red (run 5)',
      body: '',
      base: { ref: 'main', sha: g('rev-parse', 'main') },
      head: { sha: head, ref: `revert/auto-${culprit.slice(0, 10)}`, repo: { full_name: REPO } },
      user: { login: AUTO_REVERT_AUTHOR, type: 'Bot' },
      ...over,
    });
    const ioFor = (pull) => ({
      pull: async () => pull,
      pullCommits: async () => [
        { commit: { message: g('log', '-1', '--format=%B', pull.head.sha) }, parents: [{ sha: g('rev-parse', `${pull.head.sha}^`) }] },
      ],
      commit: commitOf,
      compare,
      files: async () => pathsOf(pull.head.sha),
      text: async () => null,
      journeyFiles: async () => new Set(['J-p2p-01.pw.mjs']),
      runs: async (h) => [run(1, { head_sha: h })],
      reportOf: reports({ 1: { states: { 'J-p2p-01#1': 'failed' }, ran: CANARY } }),
      verdictOf: async () => dirty,
    });
    const seal = (pull) => sealPull({ repo: REPO, number: 9, sha: pull.head.sha, io: ioFor(pull) });
    const scope = (pull) => readPureRevert({ io: ioFor(pull), repo: REPO, pull, number: 9, paths: pathsOf(pull.head.sha) });

    // The planted pure revert: the seal passes with its journeys run red, says why, and names main's full run.
    const ok = await seal(pullAt(pure));
    assert.equal(ok.ok, true, ok.lines.join('\n'));
    assert.match(
      ok.lines.join('\n'),
      new RegExp(`a pure revert of ${culprit.slice(0, 10)}: .*main's full journeys run after the merge judges it`),
    );
    assert.equal((await scope(pullAt(pure))).ok, true);

    // Judged in full: each fails the seal on that red run, and says why it is not a pure revert.
    const full = async (pull, why, label) => {
      const v = await seal(pull);
      assert.equal(v.ok, false, label);
      assert.equal(v.fullOk, false, `${label}: the journeys verdict judged it`);
      assert.match((await scope(pull)).why, why, label);
    };
    await full(pullAt(extraInCulpritFile), /1 of the reverted files differ from before/, 'one extra line in the culprit file');
    await full(
      pullAt(extraElsewhere),
      /changes 1 file\(s\) the reverted commit didn't \(services\/svc-support\/src\/other\.ts\)/,
      'one extra line in another file',
    );
    await full(pullAt(pure, { user: { login: 'ZenYoda3', type: 'User' } }), /not opened by/, 'a person opened it');
    const byHand = pullAt(pure, { head: { ...pullAt(pure).head, ref: 'revert/by-hand' } });
    assert.equal(await scope(byHand), null, "off main-bisect's branch: not this route");
    assert.equal((await seal(byHand)).fullOk, false, "off main-bisect's branch: judged in full");

    // An older merge: main changes the culprit's file after it. The revert opened before that, and one made on top of it
    // (git applies it cleanly: other lines), are both judged in full.
    put(
      A,
      ten('a').map((l, i) => (i === 2 ? 'culprit' : i === 8 ? 'changed since' : l)),
    );
    g('commit', '-qam', 'a later merge on the same file (#3)');
    const stale = await seal(pullAt(pure));
    assert.equal(stale.ok, false, 'opened before main changed its file');
    assert.match((await scope(pullAt(pure))).why, /main changed 1 of its files since/);
    const onTop = revertOn('main');
    assert.equal((await seal(pullAt(onTop))).ok, false, 'made on top of the later change');
    assert.match((await scope(pullAt(onTop))).why, /main changed 1 of its files since/);

    // The wait (readGoing): a pure revert's running journeys run is not waited for; once main changed its file, it is.
    g('reset', '-q', '--hard', later);
    const going = async (pull) => {
      const get = async (path) => {
        if (path.includes('/pulls/9/files')) return pathsOf(pull.head.sha).map((filename) => ({ filename }));
        if (path.includes('/pulls/9/commits')) return ioFor(pull).pullCommits();
        const c = /\/commits\/([0-9a-f]{40})\?/.exec(path);
        if (c) return commitOf(c[1]);
        const m = /\/compare\/([^.]+)\.\.\.([^?]+)\?/.exec(path);
        if (m) return compare(m[1], m[2]);
        if (path.includes('/runs?head_sha='))
          return {
            workflow_runs: path.includes('real-app-journeys')
              ? [{ id: 4, head_sha: pull.head.sha, status: 'in_progress' }]
              : path.includes('/ci.yml/')
                ? [{ id: 1, head_sha: pull.head.sha, event: 'pull_request', status: 'completed' }]
                : [],
          };
        if (path.includes('/jobs')) return { jobs: [], total_count: 0 };
        throw new Error(`unread ${path}`);
      };
      return readGoing({ get, repo: REPO, sha: pull.head.sha, pulls: [pull] });
    };
    assert.deepEqual(await going(pullAt(pure)), [], 'a pure revert: its journeys run is not waited for');
    assert.match(
      (await going(pullAt(extraElsewhere))).join('\n'),
      /run 4 \(in_progress\)/,
      'not pure: the seal waits for its journeys run',
    );

    // Its parent had the culprit's file changed, and main changed it back since: the merge base disagrees with main on
    // that file, so the head is not `git revert` on main even with the file restored and main's file as the culprit's.
    put(
      A,
      ten('a').map((l, i) => (i === 2 ? 'culprit' : i === 8 ? 'moved' : l)),
    );
    g('commit', '-qam', 'a merge that moves the file (#4)');
    put(A, ten('a'));
    g('commit', '-qam', `Revert "x"\n\nThis reverts commit ${culprit}.`);
    const handMade = g('rev-parse', 'HEAD');
    g('reset', '-q', '--hard', 'HEAD^');
    put(
      A,
      ten('a').map((l, i) => (i === 2 ? 'culprit' : l)),
    );
    g('commit', '-qam', 'a merge that moves it back (#5)');
    assert.match((await scope(pullAt(handMade))).why, /its commit's parent has 1 of the reverted files changed since/);
    assert.equal((await seal(pullAt(handMade))).fullOk, false, 'a parent off main state of the file: judged in full');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The beta lane (journey-verdict.mjs betaLane, project-state decision PRs #4060 and #4061), as the merge seal reads it.
test("betaOfArtifact: the run's own notOnBeta list, or unread for a missing, unread or listless set-aside.json", () => {
  const ex = (text) => () => {
    if (text instanceof Error) throw text;
    return text;
  };
  assert.deepEqual(betaOfArtifact('z', ex(JSON.stringify({ notOnBeta: [{ step: 'J-a-01#1', paths: ['/h'] }] }))), {
    steps: [{ step: 'J-a-01#1', paths: ['/h'] }],
  });
  assert.deepEqual(betaOfArtifact('z', ex(JSON.stringify({ notOnBeta: [], betaUnread: 'no dist' }))), { unread: 'no dist' });
  assert.match(betaOfArtifact('z', ex(JSON.stringify({ steps: [] }))).unread, /no notOnBeta list/);
  assert.match(betaOfArtifact('z', ex(new Error('unzip: 11'))).unread, /no readable set-aside.json/);
  assert.match(betaOfArtifact('z', ex('not json')).unread, /no readable set-aside.json/);
});

test("fullVerdict and the beta lane: a pull request's hidden non-money red holds nothing; money, tester path, main's runs and an unread list do", () => {
  const spec = (title, status, file) => ({ title, file, tests: [{ status }] });
  const files = { 'J-algo-dev-01': 'J-algo-dev-01.pw.mjs', 'J-identity-01': 'J-identity-01.pw.mjs', 'J-bank-05': 'J-bank-05.pw.mjs' };
  const rep = (failing, beta) => ({
    ...readReport({
      suites: Object.entries(files).map(([id, file]) => ({
        file,
        specs: [spec(`${id} #1`, `${id}#1` === failing ? 'unexpected' : 'expected', file)],
      })),
    }),
    beta,
  });
  const named = rep(null);
  const inputs = {
    baseline: { run: { number: 100, id: 1 }, steps: [] },
    money: { 'J-algo-dev-01#1': false, 'J-identity-01#1': false, 'J-bank-05#1': true },
    guard: { 'J-algo-dev-01#1': false, 'J-identity-01#1': false, 'J-bank-05#1': true },
    owners: { 'J-algo-dev-01': 'algo-dev', 'J-identity-01': 'identity', 'J-bank-05': 'bank' },
    orders: { 'J-algo-dev-01': 1, 'J-identity-01': 1, 'J-bank-05': 1 },
    reports: new Map(),
  };
  const read = () => ({ named, passedSince: {}, issues: {}, problems: [] });
  const hidden = { steps: ['J-algo-dev-01#1', 'J-identity-01#1', 'J-bank-05#1'].map((step) => ({ step, paths: ['/hidden'] })) };
  const pr = run(1, { head_branch: 'beta/home', event: 'pull_request', created_at: '2026-11-25T06:00:00Z' });
  const mainRun = run(2, { head_branch: 'main', event: 'push', created_at: '2026-11-25T06:00:00Z' });
  const v = (failing, r = pr, beta = hidden) => fullVerdict({ repo: REPO, report: rep(failing, beta), run: r, inputs, read });
  const off = v('J-algo-dev-01#1');
  assert.deepEqual(off.red, [], "a hidden non-money step's red holds no pull request");
  assert.deepEqual(
    off.offBeta.map((x) => x.step),
    ['J-algo-dev-01#1'],
    'and is still listed',
  );
  assert.deepEqual(
    v('J-identity-01#1').red.map((x) => x.step),
    ['J-identity-01#1'],
    'a tester-path step still blocks',
  );
  assert.deepEqual(
    v('J-bank-05#1').red.map((x) => x.step),
    ['J-bank-05#1'],
    'a money step still blocks',
  );
  assert.deepEqual(
    v('J-algo-dev-01#1', mainRun).red.map((x) => x.step),
    ['J-algo-dev-01#1'],
    "main's runs keep every step",
  );
  const other = run(3, { head_branch: 'fix/10883', event: 'pull_request', created_at: '2026-11-25T06:00:00Z' });
  assert.deepEqual(
    v('J-algo-dev-01#1', other).red.map((x) => x.step),
    ['J-algo-dev-01#1'],
    'a pull request off a beta branch keeps every step',
  );
  const fork = run(4, { head_branch: 'beta/home', event: 'pull_request', head_repository: { full_name: 'someone/fork' } });
  assert.deepEqual(
    v('J-algo-dev-01#1', fork).red.map((x) => x.step),
    ['J-algo-dev-01#1'],
    "a fork's beta branch keeps every step",
  );
  assert.deepEqual(
    v('J-algo-dev-01#1', pr, { unread: 'no dist' }).red.map((x) => x.step),
    ['J-algo-dev-01#1'],
    'unread: everything gates',
  );
  assert.deepEqual(
    v('J-algo-dev-01#1', pr, null).red.map((x) => x.step),
    ['J-algo-dev-01#1'],
    'no list: everything gates',
  );
});

test('judgeTouchedRun: a beta run whose only red is outside the beta passes the touched journeys, and says so', async () => {
  const r = run(1, { head_branch: 'beta/home', event: 'pull_request' });
  const got = await judgeTouchedRun({
    sha: HEAD,
    repo: REPO,
    files: ['J-algo-dev-01.pw.mjs'],
    runs: [r],
    reportOf: async () => ({ states: { 'J-algo-dev-01#1': 'failed' }, files: {}, ran: ['J-algo-dev-01.pw.mjs'] }),
    verdictOf: async () => ({ red: [], offBeta: [{ step: 'J-algo-dev-01#1', why: 'failing, not in the baseline', money: false }] }),
  });
  assert.equal(got.ok, true);
  assert.match(
    got.lines.join('\n'),
    /1 red step\(s\) outside the beta's own journeys, money and sign-in hold no beta pull request[^\n]*J-algo-dev-01#1/,
  );
});

test('carriedPulls: a journeys run on an earlier commit re-checks the newer head that carries it, and no other (#11076)', async () => {
  const base = { state: 'open', base: { repo: { full_name: REPO } } };
  const on = (n, sha) => ({ ...base, number: n, head: { sha } });
  const io = (files) => ({
    prCommits: async () => [OLD, HEAD],
    compare: async () => ({ status: 'ahead', files }),
    blobText: async () => null,
  });
  const quiet = [{ filename: 'services/svc-bank/src/cards.test.ts', status: 'modified' }];
  const code = [{ filename: 'services/svc-bank/src/cards.ts', status: 'modified' }];
  assert.deepEqual(
    (await carriedPulls({ pulls: [on(5, HEAD)], sha: OLD, repo: REPO, io: io(quiet) })).map((p) => p.number),
    [5],
  );
  assert.deepEqual(await carriedPulls({ pulls: [on(5, HEAD)], sha: OLD, repo: REPO, io: io(code) }), []);
  // Its own head is re-checked as before, not here; a closed one never.
  assert.deepEqual(await carriedPulls({ pulls: [on(5, OLD)], sha: OLD, repo: REPO, io: io(quiet) }), []);
  assert.deepEqual(await carriedPulls({ pulls: [{ ...on(5, HEAD), state: 'closed' }], sha: OLD, repo: REPO, io: io(quiet) }), []);
});
