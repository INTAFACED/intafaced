// The planted cases of the journey-steps seal (journey-seal.mjs): a known-good shape seals; a red named step, a run on an
// older head, a step missing from the report, a run still going, an earlier attempt's report and an unreadable report do
// not; a step exempted on a strict `Left-or-replaced:` line seals without a run, and anything else that looks like an
// exemption fails closed. tooling-tests.mjs runs this file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { readReport } from './journey-verdict.mjs';
import {
  currentReportArtifact,
  fileSteps,
  fullVerdict,
  judgeTouched,
  JOURNEY_TEST,
  touchedSteps,
  globRe,
  isSharedSetup,
  judgeFullRun,
  judgeSteps,
  mainReference,
  splitInherited,
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
  stepsIn,
  titleProblems,
  titleSteps,
  JOURNEYS_WORKFLOW,
  SEAL,
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
  // Anything else that looks like an exemption is a problem (the seal fails closed).
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

test('a Left-or-replaced line passes its steps without a run; a malformed one fails the seal; a prose section exempts nothing', async () => {
  const one = { runs: [run(1)], reportOf: reports({ 1: { states: { 'J-bank-13#1': 'passed' } } }) };
  const left = await judge({ body: 'Left-or-replaced: J-bank-13 #2\n', ...one });
  assert.equal(left.ok, true, left.lines.join('\n'));
  assert.match(left.lines.join('\n'), /J-bank-13#2: exempted on a Left-or-replaced line/);
  const both = await judge({ body: 'Left-or-replaced: J-bank-13 #1 #2\n', reportOf: () => assert.fail('nothing to read') });
  assert.equal(both.ok, true);
  const broken = await judge({ body: 'Left-or-replaced: J-bank-13 #2 needs the issuer\n', ...one });
  assert.equal(broken.ok, false, 'a malformed line fails even though #1 passed');
  assert.match(broken.lines.join('\n'), /looks like an exemption but isn't one/);
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

test('the newest finished run that reports a step decides: a newer failure outranks an older pass, a newer pass an older failure', async () => {
  const fail = { states: { 'J-bank-13#1': 'passed', 'J-bank-13#2': 'failed' } };
  const older = { run_started_at: '2026-11-06T01:00:00Z' };
  const newer = { run_started_at: '2026-11-06T02:00:00Z' };
  assert.equal((await judge({ runs: [run(1, older), run(2, newer)], reportOf: reports({ 1: green, 2: fail }) })).ok, false);
  assert.equal((await judge({ runs: [run(1, newer), run(2, older)], reportOf: reports({ 1: green, 2: fail }) })).ok, true);
  // A targeted run of another journey file is newer but doesn't list these steps: the older run still decides.
  const other = { states: { 'J-wallet-05#1': 'passed' } };
  assert.equal((await judge({ runs: [run(1, older), run(2, newer)], reportOf: reports({ 1: green, 2: other }) })).ok, true);
});

test('a re-run attempt is ordered by its own start, so it outranks a run started between its attempts', async () => {
  const fail = { states: { 'J-bank-13#1': 'failed', 'J-bank-13#2': 'failed' } };
  const rerun = run(1, { run_attempt: 2, created_at: '2026-11-06T01:00:00Z', run_started_at: '2026-11-06T03:00:00Z' });
  const between = run(2, { run_started_at: '2026-11-06T02:00:00Z' });
  assert.equal((await judge({ runs: [rerun, between], reportOf: reports({ 1: green, 2: fail }) })).ok, true);
});

test('cancelled and skipped runs are passed over', async () => {
  const runs = [
    run(1, { run_started_at: '2026-11-06T01:00:00Z' }),
    run(2, { conclusion: 'cancelled', run_started_at: '2026-11-06T02:00:00Z' }),
  ];
  assert.equal((await judge({ runs, reportOf: reports({ 1: green, 2: new Error('must not read') }) })).ok, true);
});

test('an unreadable report fails closed unless a newer run decides', async () => {
  const older = { run_started_at: '2026-11-06T01:00:00Z' };
  const newer = { run_started_at: '2026-11-06T02:00:00Z' };
  const v = await judge({
    runs: [run(1, older), run(2, newer)],
    reportOf: reports({ 1: green, 2: { error: 'no real-app-journeys artifact from its current attempt' } }),
  });
  assert.equal(v.ok, false);
  assert.match(v.lines.join('\n'), /couldn't be read/);
  assert.equal((await judge({ runs: [run(1, older), run(2, newer)], reportOf: reports({ 1: new Error('boom'), 2: green }) })).ok, true);
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
    reportOf: reports({ 1: green }),
    files: async () => ['services/svc-bank/src/cards.ts'],
    verdictOf: async () => ({ red: [], failing: 0, missing: [] }), // product code: a clean full run (journey-touch.mjs)
  });
  const pull = { state: 'open', head: { sha: HEAD }, title: 'x (J-bank-13 #1 #2)', body: '' };
  assert.equal((await sealPull({ repo: REPO, number: 5, sha: HEAD, io: io(pull) })).ok, true);
  assert.equal((await sealPull({ repo: REPO, number: 5, sha: OLD, io: io(pull) })).ok, false);
  assert.equal((await sealPull({ repo: REPO, number: 5, sha: HEAD, io: io({ ...pull, state: 'closed' }) })).ok, false);
  const edited = { ...pull, title: 'x (J-bank-13 #1 #2 #3)' };
  assert.equal((await sealPull({ repo: REPO, number: 5, sha: HEAD, io: io(edited) })).ok, false, 'a step added to the title is read');
});

test('stepsIn keys match the report reader (journey-verdict readReport)', () => {
  assert.deepEqual(stepsIn('J-p2p-01 #9'), ['J-p2p-01#9']);
});

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
    return { jobs: [seal({ status: polls++ < 2 ? 'in_progress' : 'completed' })] };
  };
  const post = async (path) => (calls.push(`POST ${path}`), { status: 201 });
  const msg = await rerunSealJob({ repo: 'o/r', sha: HEAD, get, post, sleep: async () => {}, log: () => {} });
  assert.equal(msg, 're-ran the seal job 9 of run 77');
  assert.deepEqual(
    calls.filter((c) => c.startsWith('POST')),
    ['POST /repos/o/r/actions/jobs/9/rerun'],
  );
  assert.equal(calls.filter((c) => c.includes('check-runs')).length, 0, 'the Checks API is never read');
  const done = async (path) => (path.includes('/runs?') ? { workflow_runs: [ci()] } : { jobs: [seal()] });
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
  const sealJob = (id, over) => ({ id, name: SEAL, status: 'completed', conclusion: 'failure', ...over });
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

// ---- Shared journey setup needs a clean full run on the head (judgeFullRun) ----

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
    'tooling/scripts/local-infra-bootstrap.sh',
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
  assert.equal(SHARED_SETUP.length, 6);
  assert.deepEqual(
    pullFilePaths([{ filename: 'a/new.mjs', previous_filename: 'tooling/scripts/local-test-world.mjs' }]),
    ['a/new.mjs', 'tooling/scripts/local-test-world.mjs'],
    'a file renamed out of the list still counts',
  );
});

const fullRep = { states: { 'J-a-01#1': 'passed' }, files: { 'J-a-01#1': 'J-a-01.pw.mjs', 'J-b-01#1': 'J-b-01.pw.mjs' } };
const clean = { red: [], failing: 3, missing: [] };
const dirty = { red: [{ step: 'J-wallet-05#3', why: 'failing, not in the baseline', money: false }], failing: 4, missing: [] };
const targeted = { red: [], failing: 0, missing: ['J-b-01.pw.mjs'] };
const partialRed = { red: [{ step: 'J-a-01#1', why: 'failing, not in the baseline' }], failing: 1, missing: ['J-b-01.pw.mjs'] };
const full = (over) =>
  judgeFullRun({
    sha: HEAD,
    repo: REPO,
    shared: ['tooling/scripts/local-stack-services/identity.mjs'],
    runs: [run(1)],
    reportOf: reports({ 1: fullRep, 2: fullRep, 3: fullRep, 4: fullRep }),
    verdictOf: async () => clean,
    ...over,
  });

test('judgeFullRun: a clean full run on the exact head passes; a dirty one fails', async () => {
  const ok = await full();
  assert.equal(ok.ok, true);
  assert.match(ok.lines[0], /run 1 \(attempt 1\) is clean: 3 failing or missing step\(s\), 0 outside the list/);
  const bad = await full({ verdictOf: async () => dirty });
  assert.equal(bad.ok, false);
  assert.match(bad.lines[0], /1 step\(s\) outside the list or against its rules: J-wallet-05#3: failing, not in the baseline/);
});

test('judgeFullRun: the newest full run decides; a run short of files is passed over only when clean on what it has', async () => {
  const verdicts = { 1: clean, 2: dirty, 3: targeted, 4: partialRed };
  assert.equal(
    (await full({ runs: [run(1), run(4)], verdictOf: async (_rep, r) => verdicts[r.id] })).ok,
    false,
    'a newer short run with a red step fails, whatever older run is clean',
  );
  const by = async (_rep, r) => verdicts[r.id];
  assert.equal((await full({ runs: [run(1), run(2)], verdictOf: by })).ok, false, 'a newer dirty full run outranks an older clean one');
  assert.equal((await full({ runs: [run(2), run(3)], verdictOf: by })).ok, false, 'a newer targeted run does not hide a dirty full one');
  assert.equal((await full({ runs: [run(1), run(3)], verdictOf: by })).ok, true, 'a newer targeted run leaves the clean full run deciding');
  const only = await full({ runs: [run(3)], verdictOf: by });
  assert.equal(only.ok, false, 'a targeted run alone is not a full run');
  assert.match(only.lines.join('\n'), /none has finished/);
  assert.match(only.lines.join('\n'), /not a full run \(no step from 1 journey file/);
});

test('judgeFullRun: an older head, a run going, a cancelled run, no run and an unreadable report do not pass', async () => {
  assert.equal((await full({ runs: [run(1, { head_sha: OLD })] })).ok, false, 'a clean run on an older head counts for nothing');
  const going = await full({ runs: [run(1), run(2, { status: 'in_progress' })] });
  assert.equal(going.state, 'wait');
  assert.equal(
    (await full({ runs: [run(1), run(2, { status: 'in_progress' })], waitOnRunning: false })).ok,
    true,
    'merge queue: finished runs only',
  );
  assert.equal((await full({ runs: [run(1, { conclusion: 'cancelled' })] })).ok, false);
  assert.equal((await full({ runs: [] })).ok, false);
  assert.equal((await full({ reportOf: reports({ 1: new Error('HTTP 500') }) })).ok, false);
  assert.equal((await full({ reportOf: reports({ 1: { error: 'no report' } }) })).ok, false);
  assert.equal(
    (await full({ verdictOf: async () => Promise.reject(new Error('gh: HTTP 403')) })).ok,
    false,
    'an unworkable verdict fails closed',
  );
  assert.equal(
    (
      await full({
        verdictOf: async () => ({ red: [{ step: '(input)', why: "the pass history couldn't be read" }], failing: 0, missing: [] }),
      })
    ).ok,
    false,
    'an unreadable verdict input is red',
  );
});

test('sealPull: a shared-setup pull request needs the clean full run, whatever its title; others are unchanged', async () => {
  const io = ({ files, verdict = clean, runs = [run(1)] }) => ({
    pull: async () => ({ state: 'open', head: { sha: HEAD }, title: 'stack: identity gets its TEST staff roster', body: '' }),
    runs: async () => runs,
    reportOf: reports({ 1: fullRep }),
    files: async () => files,
    verdictOf: async () => verdict,
  });
  const shared = ['tooling/scripts/local-stack-services/identity.mjs'];
  const dirtySeal = await sealPull({ repo: REPO, number: 7, sha: HEAD, io: io({ files: shared, verdict: dirty }) });
  assert.equal(dirtySeal.ok, false, 'shared setup with a dirty full run fails');
  assert.equal(dirtySeal.stepsOk, true);
  assert.equal(dirtySeal.fullOk, false);
  assert.equal((await sealPull({ repo: REPO, number: 7, sha: HEAD, io: io({ files: shared }) })).ok, true, 'with a clean one passes');
  assert.equal((await sealPull({ repo: REPO, number: 7, sha: HEAD, io: io({ files: shared, runs: [] }) })).ok, false, 'with none fails');
  // Product code off the list can reach any journey and no recorded map says which (journey-touch.mjs), so it needs the
  // same clean full run; a pull request touching nothing a journeys run reads needs none.
  const product = (over) =>
    sealPull({ repo: REPO, number: 7, sha: HEAD, io: io({ files: ['services/svc-support/src/chat.ts'], ...over }) });
  const none = await product({ runs: [] });
  assert.equal(none.ok, false, 'planted: product code with no run on its head fails');
  assert.equal(none.fullOk, false);
  assert.match(none.lines.join('\n'), /it changes what can reach any journey \(services\/svc-support\/src\/chat\.ts: product code/);
  assert.equal((await product({ verdict: dirty })).ok, false, 'product code with a dirty full run fails');
  assert.equal((await product({})).ok, true, 'product code with a clean full run passes');
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
    reportOf: reports({ 1: { ...fullRep, states: green.states } }),
  });
  assert.equal((await sealPull({ repo: REPO, number: 7, sha: HEAD, io: both(clean) })).ok, true);
  assert.equal(
    (await sealPull({ repo: REPO, number: 7, sha: HEAD, io: both(dirty) })).ok,
    false,
    'green named steps do not cover a dirty full run',
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

test('review round 1 (B1): a newer run on the head that lost a shard and failed a step in a shard that reported is not hidden behind an older clean run', async () => {
  const spec = (title, status, file) => ({ title, file, tests: [{ status }] });
  const rep = (...specs) => readReport({ suites: [{ file: 'J-a-01.pw.mjs', specs }] });
  const named = rep(spec('J-a-01 #1', 'expected', 'J-a-01.pw.mjs'), spec('J-b-01 #1', 'expected', 'J-b-01.pw.mjs'));
  const inputs = {
    baseline: { run: { number: 100, id: 1 }, steps: [] },
    money: { 'J-a-01#1': false, 'J-b-01#1': false },
    reports: new Map(),
  };
  const read = () => ({ named, passedSince: {}, issues: {}, problems: [] });
  const byRun = {
    1: rep(spec('J-a-01 #1', 'expected', 'J-a-01.pw.mjs'), spec('J-b-01 #1', 'expected', 'J-b-01.pw.mjs')), // full, clean
    2: rep(spec('J-a-01 #1', 'unexpected', 'J-a-01.pw.mjs')), // newer: J-b's shard lost, J-a-01 #1 failed
  };
  const v = await judgeFullRun({
    sha: HEAD,
    repo: REPO,
    shared: ['tooling/scripts/local-test-market.mjs'],
    runs: [run(1), run(2)],
    reportOf: async (r) => byRun[r.id],
    verdictOf: async (report, r) => fullVerdict({ repo: REPO, report, run: r, inputs, read }),
  });
  assert.equal(v.ok, false);
  assert.match(
    v.lines[0],
    /run 2 \(attempt 1\), short of 1 journey file\(s\), has 1 step\(s\) outside the list.*J-a-01#1: failing, not in the baseline/,
  );
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
}) =>
  sealPull({
    repo: REPO,
    number: 8,
    sha: HEAD,
    io: {
      pull: async () => ({ state: 'open', head: { sha: HEAD }, base: { sha: OLD }, title, body }),
      runs: async () => [run(1)],
      reportOf: reports({
        1: { states: { 'J-bank-13#1': 'passed', 'J-bank-13#2': 'passed', 'J-bank-13#3': 'passed' }, ran: ['J-bank-13.pw.mjs'] },
      }),
      // The run on the head is clean by the journeys verdict, so these cases judge the step naming alone.
      verdictOf: async () => ({ red: [], failing: 0, missing: [] }),
      files: async () => files,
      text: async (f, ref) => (ref === HEAD ? (text[f] ?? null) : null),
    },
  });

test('the seal gap (#1249): a journey test change whose title names no step fails, and prints the steps the file holds', async () => {
  const v = await touchedPull({ title: 'test(journeys): J-bank-13 waits for the card list' });
  assert.equal(v.ok, false);
  assert.match(v.lines.join('\n'), /J-bank-13\.pw\.mjs changes the tests of J-bank-13 #1, J-bank-13 #2, J-bank-13 #3/);
  assert.match(v.lines.join('\n'), /Left-or-replaced: J-bank-13 #1 #2 #3/);
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
  const wrong = await touchedPull({ title: 'test(journeys): J-bank-14 #2 waits for the card list' });
  assert.equal(wrong.ok, false, "another journey's step does not cover this file");
  assert.match(wrong.lines.join('\n'), /J-bank-13\.pw\.mjs changes the tests of/);
  const bad = await touchedPull({ title: 'test(journeys): waits', body: '- Left-or-replaced: J-bank-13 #3' });
  assert.equal(bad.ok, false, 'an exemption-like line that is not one');
  assert.match(bad.lines.join('\n'), /looks like an exemption but isn't one/);
  assert.equal((await touchedPull({ title: 'x', body: 'Left-or-replaced: J-bank-13 #9' })).ok, false, 'a step the file does not hold');
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
  const fake = await touchedPull({ title: 'Revert "test(journeys): J-bank-13 waits for the card list"', body: 'undoes the flaky wait' });
  assert.equal(fake.ok, false, 'a Revert title alone is not a revert');
  assert.match(fake.lines.join('\n'), /J-bank-13\.pw\.mjs changes the tests of/);
  assert.equal(
    (await touchedPull({ title: 'Revert "x"', body: 'Reverts someone/else#7434' })).ok,
    false,
    "another repository's PR is not this one's revert",
  );
  assert.equal(
    (await touchedPull({ title: 'Revert "x" and more', body: 'Reverts INTAFACED/intafaced#7434' })).ok,
    false,
    'more after the quote',
  );
  assert.equal(
    (await touchedPull({ title: 'Revert "x"', body: '  Reverts INTAFACED/intafaced#7434' })).ok,
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

test('journey-seal-recheck.yml passes the old body to the recheck as an env value', () => {
  const yml = readFileSync(new URL('../../.github/workflows/journey-seal-recheck.yml', import.meta.url), 'utf8');
  assert.match(yml, /\n {10}OLD_BODY: \$\{\{ github\.event\.changes\.body\.from \}\}/);
  assert.doesNotMatch(
    yml
      .split('\n')
      .filter((l) => /^\s+run:/.test(l))
      .join('\n'),
    /changes\.body/,
    'never in the script text',
  );
});

// 7 Nov 2026, #7398: a job re-run is a new attempt of its CI run, and it joins ci.yml's concurrency group
// (CI-refs/pull/<n>/merge, cancel-in-progress off main), so it cancels whatever CI run of that pull request is in flight.
// The re-check acts only when the run's head is the pull request's current head and no CI run on that head is going;
// each skip has its own test, and each test fails on its own planted fault.
const STALE_OLD = 'b'.repeat(40);
const STALE_NEW = 'c'.repeat(40);
const recheckSeal = (over) => ({ id: 9, name: SEAL, status: 'completed', conclusion: 'success', ...over });
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
  assert.match(r.out, /^threw: CI run 79 \(queued\) on this head is still going.* after 25 min/);
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

test('C1 planted: a red that cannot be bounded stops every pull request', async () => {
  const none = await splitInherited({ upTo: MAIN_SHA, red: redW, main: null, touches: area(), rangeOf: range() });
  assert.equal(none.blocking.length, 1, 'no main run in the head history: every red counts');
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
    reportOf: reports({ 1: { ...fullRep, ran: ['J-bank-13.pw.mjs', 'J-wallet-05.pw.mjs'] }, 50: fullRep }),
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
  const money = await sealPull({
    repo: REPO,
    number: 7,
    sha: HEAD,
    io: { ...io({ files: ['services/svc-support/src/chat.ts'] }), moneyCode: async (p) => p.includes('services/svc-support/src/chat.ts') },
  });
  assert.equal(money.ok, false, 'review R2: a pull request changing money code inherits nothing (AGENTS.md How work flows 8)');
  const manifest = await sealPull({
    repo: REPO,
    number: 7,
    sha: HEAD,
    io: { ...io({ files: ['services/svc-support/src/chat.ts', 'services/svc-support/package.json'] }), moneyCode: async () => false },
  });
  assert.equal(
    manifest.ok,
    false,
    "CI review: a changed package.json may add a ledger-client dependency the base can't see, so every red counts",
  );
  const notInHistory = await sealPull({
    repo: REPO,
    number: 7,
    sha: HEAD,
    io: { ...io({ files: ['services/svc-support/src/chat.ts'] }), contains: async () => false },
  });
  assert.equal(notInHistory.ok, false, 'no main run in the head history: every red counts');
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
  assert.equal(
    (await splitInherited({ upTo: MAIN_SHA, red: redW, main: mainRef(), touches: { ...area(), money: true }, rangeOf: range() })).blocking
      .length,
    1,
    'money code: every red counts',
  );
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

test('recheckTargets: only pull requests with auto-merge armed are re-sealed, and arming re-seals that one whatever it names (#1574 item 4)', async () => {
  const { recheckTargets, ARMED, armed } = await import('./journey-seal.mjs');
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
  assert.deepEqual(await numbers(''), [3], 'after an edit: armed and naming steps');
  assert.deepEqual(await numbers(ARMED, [pulls[0]]), [1], 'on arming: the armed pull request, whatever its title names');
  assert.deepEqual(await numbers(ARMED, [pr(5, 'J-x #1', null)]), [], 'disarmed again before the re-check read it: left alone');
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

test('journey-seal-recheck.yml: arming auto-merge starts a re-check, and an edit of a pull request not armed takes no runner', () => {
  const text = readFileSync('.github/workflows/journey-seal-recheck.yml', 'utf8');
  assert.match(text, /pull_request_target:\n\s+types: \[edited, auto_merge_enabled\]/);
  assert.match(text, /github\.event_name == 'pull_request_target' && github\.event\.pull_request\.auto_merge &&/);
  assert.match(
    text,
    /FINISHED: \$\{\{ github\.event\.workflow_run\.name \|\| \(github\.event\.action == 'auto_merge_enabled' && 'armed'\) \|\| '' \}\}/,
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

test('review 7552-R2: a reopen leaves an older red seal run on the head; the re-check re-runs it with the newest', async () => {
  const runs = [
    { id: 30, event: 'pull_request_target', status: 'completed' },
    { id: 31, event: 'pull_request_target', status: 'completed' },
    { id: 32, event: 'pull_request_target', status: 'completed' },
  ];
  const jobs = {
    30: [{ id: 300, name: SEAL, status: 'completed', conclusion: 'failure' }],
    31: [{ id: 310, name: SEAL, status: 'completed', conclusion: 'success' }],
    32: [{ id: 320, name: SEAL, status: 'completed', conclusion: 'skipped' }],
  };
  const get = async (path) => (path.includes('/runs?') ? { workflow_runs: runs } : { jobs: jobs[/runs\/(\d+)\/jobs/.exec(path)[1]] });
  const posted = [];
  const msg = await rerunSealJob({
    repo: 'o/r',
    sha: HEAD,
    get,
    post: async (p) => (posted.push(/jobs\/(\d+)\/rerun/.exec(p)[1]), { status: 201 }),
    sleep: async () => {},
    log: () => {},
    workflow: 'merge-seal.yml',
    event: 'pull_request_target',
  });
  // The skipped seal (an edit) is passed over; the newest real one (31) is re-run, and so is the older red one (30).
  assert.deepEqual(posted, ['310', '300'], msg);
  // Planted: without otherSeals, run 30's red seal would stay and block the head.
  assert.ok(!posted.includes('320'), 'a skipped seal is never re-run');
});

test('review 7552-R1: merge-seal.yml seals a pull request retargeted to main (edited, base change only)', () => {
  const text = readFileSync(new URL('../../.github/workflows/merge-seal.yml', import.meta.url), 'utf8');
  assert.match(text, /types: \[opened, synchronize, reopened, edited\]/);
  // Review 7552-R6: never a skipped seal job (GitHub counts it as passing); every edit runs the whole seal.
  assert.doesNotMatch(text.split('\njobs:')[1], /\n {4}if:/, 'the seal job has no if: that could skip it');
  assert.match(text, /branches: \[main\]/);
  // Planted: without `edited`, a retarget to main starts no seal run here.
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
