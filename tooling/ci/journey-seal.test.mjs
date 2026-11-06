// The planted cases of the journey-steps seal (journey-seal.mjs): a known-good shape seals; a red named step, a run on an
// older head, a step missing from the report, a run still going, an earlier attempt's report and an unreadable report do
// not; a step exempted on a strict `Left-or-replaced:` line seals without a run, and anything else that looks like an
// exemption fails closed. tooling-tests.mjs runs this file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  currentReportArtifact,
  judgeSteps,
  exemptions,
  namesSteps,
  recheckPulls,
  recheckStep,
  rerunSealJob,
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
  const io = (pull, runs = [run(1)]) => ({ pull: async () => pull, runs: async () => runs, reportOf: reports({ 1: green }) });
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
  assert.equal(recheckStep([]).act, 'done', 'no CI run yet');
  assert.equal(recheckStep([ci({ event: 'merge_group' })]).act, 'done', 'only pull_request runs');
  assert.deepEqual(recheckStep([ci()]), { act: 'jobs', runId: '77', msg: "reading run 77's jobs" });
  assert.equal(recheckStep([ci({ status: 'in_progress' })], []).act, 'done', 'the seal job has not started');
  assert.equal(recheckStep([ci({ status: 'in_progress' })], [seal({ status: 'queued' })]).act, 'done');
  assert.equal(recheckStep([ci()], []).act, 'fail', 'a finished run with no seal job');
  assert.equal(recheckStep([ci({ status: 'in_progress' })], [seal({ status: 'in_progress' })]).act, 'wait');
  assert.equal(recheckStep([ci({ status: 'in_progress' })], [seal()]).act, 'wait', 'the run must finish before a job re-runs');
  assert.deepEqual(recheckStep([ci()], [seal()]), { act: 'rerun', runId: '77', jobId: '9' }, 'a green seal is re-run too');
  assert.equal(recheckStep([ci()], [seal({ conclusion: 'failure' })]).act, 'rerun');
  assert.equal(recheckStep([ci({ id: 76 }), ci({ id: 78 })], [seal()]).runId, '78', 'the newest CI run decides');

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

// The Codex read of #7229 at 2c5588fa (GPT-6 Astra): four ways to fool the reader, each a planted fault.
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

// The rule files still say "listed under" until the owner's yes, so the seal's own failure prints the exact line a
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
