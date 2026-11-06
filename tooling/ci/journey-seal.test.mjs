// The planted cases of the journey-steps seal (journey-seal.mjs): a known-good shape seals; a red named step, a run on an
// older head, a step missing from the report, a run still going, an earlier attempt's report and an unreadable report do
// not; a step listed by its full id under "Left or replaced" seals without a run. tooling-tests.mjs runs this file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  currentReportArtifact,
  judgeSteps,
  leftOrReplaced,
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

test('Left or replaced: full ids under the heading only, outside code, up to the next heading of its level', () => {
  const body = [
    '## Acceptance',
    '- J-bank-13 #1 works',
    '## Left or replaced',
    '- **#7: inferences**, all mine',
    '- J-bank-13 #3, replaced by J-bank-14 #2',
    'None of the rest: J-bank-13 #8 #9 all pass.',
    '<!-- - J-bank-13 #10 -->',
    '1. **J-bank-15 #1**: not built',
    '  - J-bank-13 #4: nested',
    '### detail',
    '- J-bank-13 #5',
    '```',
    '- J-bank-13 #6',
    '```',
    '## Proof',
    '- J-bank-13 #2 left',
  ].join('\n');
  assert.deepEqual([...leftOrReplaced(body)].sort(), ['J-bank-13#3', 'J-bank-13#4', 'J-bank-13#5', 'J-bank-15#1']);
  assert.deepEqual(
    [...leftOrReplaced('## Left or replaced\nNone. J-bank-13 #1 #2 #3 all pass.\n')],
    [],
    'prose under the heading exempts nothing',
  );
  assert.deepEqual(
    [...leftOrReplaced('## Left or replaced\n- the issuer is not wired, so J-bank-13 #2 waits\n')],
    [],
    'only an item that opens with the id',
  );
  assert.deepEqual([...leftOrReplaced('### Left or replaced:\n- J-a-01 #1\n')], ['J-a-01#1'], 'any level, a trailing colon');
  assert.deepEqual([...leftOrReplaced('**Left or replaced**\n- J-a-01 #1\n')], [], 'bold text is not a heading');
  assert.deepEqual([...leftOrReplaced('```\n## Left or replaced\n- J-a-01 #1\n```\n')], [], 'a heading in code is not one');
  assert.deepEqual([...leftOrReplaced(null)], []);
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
  // #7202's own "Left or replaced" opened with "#7: inferences and limits" about a step it claimed built: no full id.
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

test('"Left or replaced" by full id passes without a run; a bare #n does not', async () => {
  const left = await judge({
    body: '## Left or replaced\n- J-bank-13 #2: needs the issuer\n',
    runs: [run(1)],
    reportOf: reports({ 1: { states: { 'J-bank-13#1': 'passed' } } }),
  });
  assert.equal(left.ok, true, left.lines.join('\n'));
  const both = await judge({ body: '## Left or replaced\n- J-bank-13 #1 #2\n', reportOf: () => assert.fail('nothing to read') });
  assert.equal(both.ok, true);
  const bare = await judge({
    body: '## Left or replaced\n- #2: needs the issuer\n',
    runs: [run(1)],
    reportOf: reports({ 1: { states: { 'J-bank-13#1': 'passed' } } }),
  });
  assert.equal(bare.ok, false);
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
  assert.equal(recheckStep([]).act, 'done');
  assert.equal(recheckStep([seal({ status: 'queued' })]).act, 'done');
  assert.equal(recheckStep([seal({ status: 'in_progress' })]).act, 'wait');
  assert.equal(recheckStep([seal()]).act, 'run');
  assert.equal(recheckStep([seal()], 'in_progress').act, 'wait');
  assert.deepEqual(recheckStep([seal()], 'completed'), { act: 'rerun', runId: '77', jobId: '9' }, 'a green seal is re-run too');
  assert.equal(recheckStep([seal({ conclusion: 'failure' })], 'completed').act, 'rerun');
  assert.equal(recheckStep([seal({ details_url: '' })]).act, 'fail');
  assert.equal(
    recheckStep([seal({ id: 1, status: 'in_progress' }), seal({ id: 2 })], 'completed').jobId,
    '9',
    'the newest seal check run decides',
  );
  assert.equal(recheckStep([seal({ id: 2, status: 'in_progress' }), seal({ id: 1 })]).act, 'wait');

  const calls = [];
  let polls = 0;
  const get = async (path) => {
    calls.push(`GET ${path}`);
    if (path.includes('check-runs')) return { check_runs: [seal({ status: polls++ < 2 ? 'in_progress' : 'completed' })] };
    return { status: 'completed' };
  };
  const post = async (path) => (calls.push(`POST ${path}`), { status: 201 });
  const msg = await rerunSealJob({ repo: 'o/r', sha: HEAD, get, post, sleep: async () => {}, log: () => {} });
  assert.equal(msg, 're-ran the seal job 9 of run 77');
  assert.deepEqual(
    calls.filter((c) => c.startsWith('POST')),
    ['POST /repos/o/r/actions/jobs/9/rerun'],
  );
  const done = async () => ({ check_runs: [seal()], status: 'completed' });
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
  assert.deepEqual([...leftOrReplaced('## Left or replaced\n- J-bank-13 #1 TO #3\n')].sort(), [
    'J-bank-13#1',
    'J-bank-13#2',
    'J-bank-13#3',
  ]);
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

test('Codex 3: an indented code line under "Left or replaced" exempts nothing', () => {
  assert.deepEqual([...leftOrReplaced('## Left or replaced\n\n    - J-bank-13 #1\n')], []);
  assert.deepEqual([...leftOrReplaced('## Left or replaced\n\n\t- J-bank-13 #1\n')], [], 'a tab is four columns');
  assert.deepEqual([...leftOrReplaced('## Left or replaced\n- J-bank-13 #2\n  - J-bank-13 #3\n')].sort(), ['J-bank-13#2', 'J-bank-13#3']);
});

test('Codex 4: a setext heading or a thematic break ends the section; a setext "Left or replaced" opens it', () => {
  assert.deepEqual([...leftOrReplaced('## Left or replaced\n- J-bank-13 #1\n\nProof\n-----\n- J-bank-13 #2\n')], ['J-bank-13#1']);
  assert.deepEqual([...leftOrReplaced('## Left or replaced\n- J-bank-13 #1\n\nProof\n=====\n- J-bank-13 #2\n')], ['J-bank-13#1']);
  assert.deepEqual([...leftOrReplaced('## Left or replaced\n- J-bank-13 #1\n\n***\n- J-bank-13 #2\n')], ['J-bank-13#1']);
  assert.deepEqual([...leftOrReplaced('Left or replaced\n----------------\n- J-bank-13 #4\n')], ['J-bank-13#4']);
});
