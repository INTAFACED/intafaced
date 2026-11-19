// post-merge-trust: the pure pieces Main trust decides with, on fixtures, and a scan of the tool's own source.
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ISSUE_LABELS,
  LOST_SHARD_TITLE,
  breakingCommitLines,
  checkRedShas,
  commitLines,
  decideCheck,
  flakyIssueActions,
  flakyIssueBody,
  flakyIssueTitle,
  issueSteps,
  lostShardBody,
  newIssuePayload,
  newlyBrokenTests,
  rerunTaken,
  runConclusion,
  setAsideIssueActions,
  setAsideIssueBody,
  setAsideIssueTitle,
  shardRerun,
  shardsWithoutReport,
  stepChanges,
  stepStates,
  timedOutJobNames,
  untrackedRedBody,
} from './post-merge-trust.mjs';

// Equal as JSON, the comparison every case here was written against.
const eq = (got, want, m) => assert.equal(JSON.stringify(got), JSON.stringify(want), m);

test('journey step states, newly passing and failing steps, newly broken tests', () => {
  const spec = (title, ...statuses) => ({ title, tests: statuses.map((status) => ({ status })) });
  const report = (...specs) => ({ suites: [{ title: 'a.pw.mjs', specs: specs.slice(0, 2), suites: [{ specs: specs.slice(2) }] }] });
  const r1 = report(
    spec('J-a-01 #1 x', 'expected'),
    spec('J-a-01 #2 y', 'unexpected'),
    spec('J-b-02 #1 z', 'skipped'),
    spec('not a journey', 'unexpected'),
  );
  eq(
    [...stepStates(r1)],
    [
      ['J-a-01#1', 'passed'],
      ['J-a-01#2', 'failed'],
      ['J-b-02#1', 'skipped'],
    ],
    'step states, nested suites',
  );
  eq(
    [...stepStates(report(spec('J-a-01 #1 x', 'expected'), spec('J-a-01 #1 dup', 'unexpected')))],
    [['J-a-01#1', 'failed']],
    'a failing duplicate title wins',
  );
  eq([...stepStates(report(spec('J-a-01 #1 x', 'flaky')))], [['J-a-01#1', 'failed']], 'a pass only on the retry is not a pass');
  eq(
    [...stepStates(report(spec('J-a-01 #1 x', 'expected'), spec('J-a-01 #1 y', 'flaky')))],
    [['J-a-01#1', 'failed']],
    'one test passing only on its retry fails the step',
  );
  const m = (o) => new Map(Object.entries(o));
  eq(
    stepChanges(
      m({ 'J-a-01#1': 'failed', 'J-a-01#2': 'passed', 'J-a-01#3': 'passed', 'J-a-01#10': 'passed' }),
      m({ 'J-a-01#1': 'passed', 'J-a-01#2': 'failed', 'J-a-01#3': 'skipped', 'J-a-01#10': 'failed', 'J-c-01#1': 'failed' }),
    ),
    { newlyPassing: ['J-a-01#1'], newlyFailing: ['J-a-01#2', 'J-a-01#10'] },
    'newly passing and failing; skipped and new steps are neither; numeric order',
  );
  {
    const t = (title, status) => ({ title, file: 'J-a-01.pw.mjs', tests: [{ status }] });
    const r = (...specs) => ({ suites: [{ file: 'J-a-01.pw.mjs', specs }] });
    const before = r(t('J-a-01, part of #1: ledger', 'expected'), t('J-a-01 starts: unbuilt', 'unexpected'), t('J-a-01 #2 y', 'expected'));
    const now = r(t('J-a-01, part of #1: ledger', 'unexpected'), t('J-a-01 starts: unbuilt', 'unexpected'), t('J-a-01 #2 y', 'unexpected'));
    eq(
      newlyBrokenTests(before, now),
      ['J-a-01#test J-a-01.pw.mjs › J-a-01, part of #1: ledger'],
      'a test with no step title that passed and now fails is named; one never passing and a step are not',
    );
    eq(newlyBrokenTests(before, before), [], 'known-good: nothing newly broken');
  }
});

test('decideCheck: re-run, break, still red, green or ignore', () => {
  eq(decideCheck({ conclusion: 'failure', attempt: 1, previous: 'success' }), 'rerun', 'first red after green re-runs');
  eq(decideCheck({ conclusion: 'failure', attempt: 2, previous: 'success' }), 'broken', 'red after re-run is a break');
  eq(decideCheck({ conclusion: 'timed_out', attempt: 2, previous: 'success' }), 'broken', 'a timeout counts as red');
  eq(decideCheck({ conclusion: 'failure', attempt: 1, previous: 'failure' }), 'still-red', 'red after red opens nothing new');
  eq(decideCheck({ conclusion: 'failure', attempt: 1, previous: undefined }), 'still-red', 'no earlier run: nothing to blame');
  eq(decideCheck({ conclusion: 'success', attempt: 1, previous: 'failure' }), 'green', 'green');
  eq(decideCheck({ conclusion: 'cancelled', attempt: 1, previous: 'success' }), 'ignore', 'cancelled ignored');
});

test('break issue texts: an untracked red, red shas and issue steps', () => {
  const run = (id, sha) => ({ id, head_sha: sha, html_url: `https://x/runs/${id}` });
  const untracked = untrackedRedBody({
    name: 'Order-path CX-8',
    sha: 'c'.repeat(40),
    runId: 3,
    runUrl: 'https://x/runs/3',
    prev: run(2, 'b'.repeat(40)),
    lastGreen: run(1, 'a'.repeat(40)),
    range: { commits: [{ sha: 'b'.repeat(40), commit: { message: 'feat: x (#9)' }, author: null }], url: 'https://x/compare' },
  });
  eq(checkRedShas([untracked]), ['cccccccccc'], 'an untracked red names its sha, so a later green closes it');
  eq(untracked.includes('`bbbbbbbbbb` feat: x (#9)'), true, 'an untracked red lists the commits since the last green');
  eq(untracked.includes('new advisory'), false, 'a code check carries no outside-cause line');
  eq(
    untrackedRedBody({
      name: 'PR checks',
      sha: 'c'.repeat(40),
      runId: 3,
      runUrl: 'u',
      prev: run(2, 'b'.repeat(40)),
      lastGreen: null,
    }).includes('not a revert'),
    true,
    'a Dependency audit red says the cause can be outside the commits',
  );
  eq(
    untrackedRedBody({ name: 'x', sha: 'c'.repeat(40), runId: 3, runUrl: 'u', prev: run(2, 'b'.repeat(40)), lastGreen: null }).includes(
      'No green run',
    ),
    true,
    'no green in reach: says so',
  );
  eq(
    checkRedShas([
      '`Order-path CX-8` failed twice on `46b3f74801` (x)',
      null,
      'failed twice on `46b3f74801`, failed twice on `abcdef1234`',
    ]),
    ['46b3f74801', 'abcdef1234'],
    'red shas, deduped',
  );
  eq(
    issueSteps(['x <!-- steps: J-a-01#2, J-a-01#1 -->', 'y <!-- steps: J-a-01#1 -->', null]),
    ['J-a-01#1', 'J-a-01#2'],
    'issue steps, merged',
  );
});

test('time limits: a time-limit cancel counts as timed out', () => {
  const limitJobs = [
    { name: 'Journeys (shard 3 of 8)', annotations: [{ message: 'The job has exceeded the maximum execution time of 1h0m0s' }] },
    { name: 'Journeys (shard 4 of 8)', annotations: [{ message: 'The operation was canceled.' }] },
    { name: 'Real-app journeys', annotations: [] },
  ];
  eq(timedOutJobNames(limitJobs), ['Journeys (shard 3 of 8)'], 'a time-limit annotation marks the job');
  eq(
    timedOutJobNames([
      {
        name: 'Journeys (shard 9 of 12)',
        annotations: [
          { message: "this shard's journeys reached their time limit (60 minutes); the journeys it did not reach count as not run" },
        ],
      },
    ]),
    ['Journeys (shard 9 of 12)'],
    "a shard's own journey limit marks the job",
  );
  eq(runConclusion('cancelled', timedOutJobNames(limitJobs)), 'timed_out', 'a time-limit cancel is a timeout');
  eq(runConclusion('cancelled', []), 'cancelled', 'a replaced run stays cancelled');
  eq(runConclusion('failure', ['x']), 'failure', 'a red run with a timed-out job stays red');
  eq(
    decideCheck({ conclusion: runConclusion('cancelled', ['x']), attempt: 2, previous: 'success' }),
    'broken',
    'a time-limit cancel after a green re-run is a break',
  );
});

test('commit lines and the breaking commit', () => {
  const c = (sha, message, login) => ({ sha, commit: { message }, author: login ? { login } : null });
  eq(
    commitLines([c('a'.repeat(40), 'feat: one (#1)\n\nbody', 'alice'), c('b'.repeat(40), 'fix: two (#2)')]),
    ['- `aaaaaaaaaa` feat: one (#1) by alice', '- `bbbbbbbbbb` fix: two (#2)'],
    'commit lines',
  );
  eq(
    commitLines([c('a'.repeat(40), 'x'), c('b'.repeat(40), 'y'), c('c'.repeat(40), 'z')], 2)[0],
    '- … 1 older commits (see the compare link)',
    'long ranges are cut',
  );
  eq(breakingCommitLines([], 'u')[0].startsWith('No commit changed between these runs'), true, 'same commit: no breaking commit named');
  eq(breakingCommitLines([c('a'.repeat(40), 'x')], 'u'), ['The breaking commit:', '- `aaaaaaaaaa` x'], 'one breaking commit');
});

test('set-aside and flaky step issues', () => {
  const row = {
    step: 'J-a-01#3',
    until: '2026-11-14T06:00:00.000Z',
    since: 1700,
    active: true,
    owner: 'the alpha area',
    file: 'J-a-01.pw.mjs',
  };
  eq(setAsideIssueTitle(row), 'Set aside on main until 2026-11-14: J-a-01 #3', 'set-aside issue title');
  const mf = { step: 'J-a-05#1', file: 'J-a-05.pw.mjs', owner: 'the alpha area' };
  eq(flakyIssueTitle(mf), 'Flaky step on main: J-a-05 #1', 'flaky issue title');
  eq(
    flakyIssueActions(
      [mf, mf, { ...mf, step: 'J-a-05#2' }, { ...mf, step: 'J-a-05#3' }, { ...mf, step: 'J-a-05#4' }, { file: 'x' }],
      [
        { title: flakyIssueTitle({ step: 'J-a-05#2' }), state: 'open' },
        { title: flakyIssueTitle({ step: 'J-a-05#3' }), state: 'closed' },
        { title: 'Flaky money step on main: J-a-05 #4', state: 'open' },
      ],
    ).map((r) => r.step),
    ['J-a-05#1', 'J-a-05#3'],
    'a flaky step gets one issue while none is open (an older money-flaky title counts): once per step, again after its last one closed',
  );
  if (!/never counts as proven/.test(flakyIssueBody(mf, 'u'))) throw new Error('the flaky issue says it is never proven');
  // A money step's issue carries a mark so its fix can be ranked first.
  eq(flakyIssueBody({ ...mf, money: true }, 'u').includes('<!-- money-flaky: J-a-05#1 -->'), true, 'a money step is marked money-flaky');
  eq(flakyIssueBody({ ...mf, money: false }, 'u').includes('money-flaky'), false, 'a non-money step is not');
  eq(flakyIssueBody(mf, 'u').includes('<!-- money-flaky: J-a-05#1 -->'), true, 'a row with no money field counts as money');
  const ended = { ...row, step: 'J-a-01#4', active: false };
  const acts = setAsideIssueActions(
    [row, ended, { ...row, step: 'J-a-01#5' }, { ...row, step: 'J-a-01#6' }],
    [
      { title: setAsideIssueTitle(ended), state: 'open', number: 4 },
      { title: setAsideIssueTitle({ ...row, step: 'J-a-01#5' }), state: 'open', number: 5 },
      { title: setAsideIssueTitle({ ...row, step: 'J-a-01#6' }), state: 'closed', number: 6 },
    ],
  );
  eq(
    acts.open.map((r) => r.step),
    ['J-a-01#3'],
    'an issue opens once per active set-aside, never again once closed',
  );
  eq(
    acts.close.map((c) => c.issue.number),
    [4],
    'an ended set-aside closes its open issue',
  );
  const body = setAsideIssueBody(row, 'https://x/runs/9');
  eq(
    ['Owner: the alpha area', '2026-11-14 06:00 UTC', 'J-a-01.pw.mjs', 'does not count as proven'].every((t) => body.includes(t)),
    true,
    'set-aside issue names owner, end date and file',
  );
});

test('lost shard reports: the issue, and the one re-run of a shard that sent no report', () => {
  const lost = lostShardBody({ missing: ['shard 2 of 4'], sha: 'a'.repeat(40), runId: 9, runUrl: 'u', attempt: 2, why: null });
  if (!/`shard 2 of 4` sent no report on `aaaaaaaaaa` \(\[run 9\]\(u\), attempt 2, after its one re-run\)/.test(lost))
    throw new Error('the lost-shard issue names the shard, the commit, the run and its attempt');
  eq(LOST_SHARD_TITLE, 'Broken on main: Real-app journeys (shard lost)', 'one lost-shard issue title');
  eq(newIssuePayload(LOST_SHARD_TITLE, lost, ISSUE_LABELS.break).labels, ['regression'], 'the lost-shard issue opens labelled');
  const shardJobs = [1, 2, 3, 4].map((n) => ({ name: `Journeys (shard ${n} of 4)` })).concat([{ name: 'Real-app journeys' }]);
  eq(
    shardsWithoutReport(shardJobs, ['real-app-journeys-shard-1', 'real-app-journeys-shard-3', 'real-app-journeys', 'x-shard-2']),
    ['shard 2 of 4', 'shard 4 of 4'],
    'the shards that sent no report, by their own artifact only',
  );
  eq(
    shardsWithoutReport(shardJobs.slice(0, 2), ['real-app-journeys-shard-1', 'real-app-journeys-shard-2']),
    ['shard 3 of 4', 'shard 4 of 4'],
    'a shard with no job at all (abandoned) still counts as sending no report',
  );
  eq(shardsWithoutReport([{ name: 'Real-app journeys' }], []), [], 'no shard job: nothing ran to count');
  eq(
    shardsWithoutReport(
      shardJobs,
      [1, 2, 3, 4].map((n) => `real-app-journeys-shard-${n}`),
    ),
    [],
    'every shard reported',
  );
  const jobsOf = (states) => Object.entries(states).map(([n, c]) => ({ name: `Journeys (shard ${n} of 4)`, conclusion: c }));
  const shardsOk = jobsOf({ 1: 'success', 2: 'failure', 3: 'success', 4: 'success' });
  eq(rerunTaken({ status: 201, json: null }), true, 'a 201 re-run is taken');
  eq(rerunTaken({ status: 403, json: null, alreadyRunning: true }), true, 'already running is taken');
  for (const status of [404, 422, 500, 0]) eq(rerunTaken({ status, json: null }), false, `a ${status} re-run is not taken`);
  const go = (o) => shardRerun({ attempt: 1, conclusion: 'failure', jobs: shardsOk, missing: ['shard 2 of 4'], ...o }).rerun;
  eq(go({}), true, 'a red first attempt whose only failed shard sent no report re-runs its failed jobs');
  eq(go({ attempt: 2 }), false, 'once only: the re-run is judged as it is');
  eq(go({ missing: [] }), false, 'every shard reported: no re-run');
  eq(go({ conclusion: 'success' }), false, 'a green run is not re-run');
  eq(
    go({ jobs: jobsOf({ 1: 'failure', 2: 'failure', 3: 'success', 4: 'success' }) }),
    false,
    'a failed shard that sent its report is never re-run: its reds stand',
  );
  eq(go({ jobs: jobsOf({ 1: 'success', 3: 'success', 4: 'success' }) }), false, 'a missing shard with no job: no re-run of the whole run');
});

test('issue labels: every issue for a red main opens labelled', () => {
  // The break issue is labelled regression and the set-aside issue flaky, so a builder's pick finds them.
  eq(
    newIssuePayload('Journey broken on main: J-a-01', 'b', ISSUE_LABELS.break),
    { title: 'Journey broken on main: J-a-01', body: 'b', labels: ['regression'] },
    'a break issue opens labelled regression',
  );
  eq(
    newIssuePayload('Set aside on main until x: J-a-01 #1', 'b', ISSUE_LABELS.setAside).labels,
    ['flaky'],
    'a set-aside issue opens labelled flaky',
  );
  eq(newIssuePayload('Broken on main: CI', 'b'), { title: 'Broken on main: CI', body: 'b' }, 'no labels asked, none sent');
  // Every path that opens an issue for a red main passes its labels: no path opens one bare.
  const src = readFileSync(new URL('./post-merge-trust.mjs', import.meta.url), 'utf8');
  const bare = [...src.matchAll(/upsertIssue\(repo, (?:[^()]|\([^()]*\)|\{[^}]*\})*\)/g)]
    .map((m) => m[0])
    .filter((c) => !c.includes('ISSUE_LABELS.') && !c.includes('labels = []'));
  eq(bare, [], 'no caller opens an issue without labels');
});
