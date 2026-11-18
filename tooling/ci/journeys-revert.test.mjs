import test from 'node:test';
import assert from 'node:assert/strict';
import { moneyGuardAt } from './journey-verdict.mjs';
import {
  REAL_APP,
  RECORD_MARK,
  REFRESH_MAX,
  REVOKE_PROBES,
  afterRevoke,
  backNotes,
  bisectTitle,
  breakIssueNotes,
  cancelDoomed,
  commitReaches,
  isAutoRevert,
  coveredSteps,
  culpritOf,
  endedShards,
  failingSteps,
  failingText,
  goingElsewhere,
  joinReports,
  journeyFilesChanged,
  journeyFilesOf,
  journeysOf,
  leftOutSteps,
  narrow,
  outrightFailures,
  parseRecord,
  parseSettle,
  parseSteps,
  recoveryComment,
  recoveryRecord,
  redRunOf,
  refreshWhy,
  refuseRevert,
  refusedAfterRevoke,
  revertBody,
  revertBranch,
  revertForRun,
  revertMergePull,
  revertSteps,
  revertTitle,
  settleNotes,
  settledFor,
  shardOf,
  spentWhy,
  subjectPr,
} from './journeys-revert.mjs';

test('journeys-revert: steps, culprits, reverts, issues and records', () => {
  const eq = (got, want, m) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${m}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  };
  const spec = (title, ...statuses) => ({ title, file: 'J-a-01.pw.mjs', tests: statuses.map((status) => ({ status })) });
  const report = (...specs) => ({ suites: [{ title: 'J-a-01.pw.mjs', file: 'J-a-01.pw.mjs', specs }] });
  const pass = report(spec('J-a-01 #1 x', 'expected'), spec('J-a-01 #2 y', 'expected'));
  const red = report(spec('J-a-01 #1 x', 'expected'), spec('J-a-01 #2 y', 'unexpected'));
  const flaky = report(spec('J-a-01 #1 x', 'expected'), spec('J-a-01 #2 y', 'flaky'));
  eq([...outrightFailures(red)], [['J-a-01#2', 'J-a-01.pw.mjs']], 'an unexpected test fails its step outright, with its file');
  eq([...outrightFailures(flaky)], [], 'a pass on the retry is not an outright failure');
  eq(revertSteps(pass, red), ['J-a-01#2'], 'passed, then failed outright: revert at once');
  eq(revertSteps(pass, flaky), [], 'planted fault: a pass on the retry reverts nothing (the verdict sets it aside)');
  eq(revertSteps(pass, pass), [], 'known-good: green runs revert nothing');
  eq(revertSteps(red, red), [], 'a step already red started its revert a run ago, so it never starts another');
  {
    // The run before holds no J-algo-dev-04 at all, main's first run with it fails #3 outright, and
    // the merge between the runs added its file. The revert starts; the merge that brought it is its culprit.
    const at = (j, specs) => ({ suites: [{ title: `${j}.pw.mjs`, file: `${j}.pw.mjs`, specs }] });
    const s = (title, status) => ({ title, file: title.split(' ')[0] + '.pw.mjs', tests: [{ status }] });
    const before = at('J-algo-dev-03', [s('J-algo-dev-03 #1 x', 'expected')]);
    const after = joinReports([
      before,
      at('J-algo-dev-04', [s('J-algo-dev-04 #1 a', 'expected'), s('J-algo-dev-04 #3 c', 'unexpected'), s('J-algo-dev-04 #4 d', 'flaky')]),
    ]);
    const added = journeyFilesChanged([
      { filename: 'apps/customer/tests/real-app/J-algo-dev-04.pw.mjs', status: 'added' },
      { filename: 'apps/customer/src/x.ts', status: 'modified' },
      { filename: 'apps/customer/tests/real-app/J-old.pw.mjs', status: 'removed' },
    ]);
    eq([...added], ['J-algo-dev-04.pw.mjs'], 'the journey files a compare added or changed, not one it removed');
    eq(revertSteps(before, after, added), ['J-algo-dev-04#3'], 'a step new to main that fails outright on its first run is reverted');
    eq(
      revertSteps(before, after, new Set(['J-other.pw.mjs'])),
      [],
      'a step that never passed, in a file no commit between touched, is not',
    );
    eq(revertSteps(before, after, null), [], 'no compare read: only a step that passed before counts');
    // A run left out J-agents-18 #5, unbuilt and red by name; a merge changed
    // its file, and the next run failed it outright as always. Left out is red before, not new: nothing starts. The
    // same step absent with no leave-out list still starts (the J-algo-dev-04 case above), so the planted fault holds.
    const list = leftOutSteps(
      'J-agents-18.pw.mjs › J-agents-18 #5 opens the Launch, Risk and Compliance, and Growth agent pages: run history\n' +
        'J-x-01.pw.mjs › a describe › J-x-01 #12 y\n\nnot a step line\n',
    );
    eq([...list], ['J-agents-18#5', 'J-x-01#12'], 'the leave-out list names its steps by key, describe titles and all');
    const ag18 = (specs) => ({ suites: [{ title: 'J-agents-18.pw.mjs', file: 'J-agents-18.pw.mjs', specs }] });
    const prev18 = ag18([s('J-agents-18 #3 c', 'unexpected'), s('J-agents-18 #4 d', 'expected')]);
    const now18 = ag18([s('J-agents-18 #3 c', 'unexpected'), s('J-agents-18 #4 d', 'expected'), s('J-agents-18 #5 e', 'unexpected')]);
    const touched = new Set(['J-agents-18.pw.mjs']);
    eq(revertSteps(prev18, now18, touched, list), [], 'a step the run before left out counts as red there: no revert');
    eq(revertSteps(prev18, now18, touched), ['J-agents-18#5'], 'planted fault: without the list it reads as new and starts');
    eq(
      revertSteps(ag18([s('J-agents-18 #3 c', 'unexpected'), s('J-agents-18 #5 e', 'expected')]), now18, touched, list),
      ['J-agents-18#5'],
      'a step that passed in the run before still starts, whatever the list says',
    );
    const wasRed = joinReports([before, at('J-algo-dev-04', [s('J-algo-dev-04 #3 c', 'unexpected')])]);
    eq(revertSteps(wasRed, after, added), [], 'a step already red in the run before started its revert then');
    eq(
      commitReaches(['apps/customer/tests/real-app/J-algo-dev-04.pw.mjs'], ['J-algo-dev-04.pw.mjs'], null, () => true).reaches,
      true,
      'the merge that added the journey file reaches it, so the probe runs on it',
    );
  }
  eq(parseSteps('J-a-01#2, J-a-01#10 J-a-01#2'), ['J-a-01#2', 'J-a-01#10'], 'steps parse, dedupe, numeric order');
  let threw = false;
  try {
    parseSteps('J-a-01#2;rm -rf /');
  } catch {
    threw = true;
  }
  eq(threw, true, 'a malformed step input is refused');
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const C = 'c'.repeat(40);
  eq(narrow([], () => ({})).none.startsWith('no commit'), true, 'no commit: nothing blamed');
  eq(narrow([A], () => ({ reaches: true, why: 'x' })).probe, [A], 'one commit that can reach the journey is probed, never blamed unproven');
  eq(
    narrow([A], () => ({ reaches: false, why: 'x' })).none?.startsWith('no commit in the range'),
    true,
    'one commit that cannot is blamed for nothing',
  );
  const reach = { [A]: { reaches: false, why: 'none' }, [B]: { reaches: true, why: 'x' }, [C]: { reaches: false, why: 'none' } };
  eq(narrow([A, B, C], (s) => reach[s]).probe, [B], 'the one commit of several that can reach the journey is probed');
  eq(narrow([A, B, C], () => ({ reaches: false, why: '' })).none?.startsWith('no commit in the range'), true, 'none can reach');
  eq(narrow([A, B, C], () => ({ reaches: true, why: '' })).probe, [A, B, C], 'several can reach: probe');
  const atHead = () => true;
  eq(commitReaches(['tooling/ci/gates.mjs'], ['J-a-01.pw.mjs'], null, atHead).reaches, false, 'a CI-only commit cannot reach a journey');
  eq(commitReaches(['services/svc-x/src/a.ts'], ['J-a-01.pw.mjs'], null, atHead).reaches, true, 'product code without a map reaches all');
  eq(commitReaches([`${REAL_APP}J-a-01.pw.mjs`], ['J-a-01.pw.mjs'], null, atHead).reaches, true, "a failing journey's own file reaches it");
  eq(commitReaches([`${REAL_APP}J-b-02.pw.mjs`], ['J-a-01.pw.mjs'], null, atHead).reaches, false, "another journey's file does not");
  eq(subjectPr('feat: x (#7602)'), 7602, 'squash subject names its pull request');
  eq(subjectPr('feat: x'), null, 'no number');
  const ok = { subject: 'feat: x (#1)', parents: 1, files: ['apps/x.ts'], pr: { number: 1, head: { ref: 'feat/x' } } };
  eq(refuseRevert(ok), null, 'a squash commit reverts');
  eq(refuseRevert({ ...ok, subject: 'Revert "feat: x" (#2)' }) !== null, true, 'never revert a revert (subject)');
  eq(refuseRevert({ ...ok, pr: { number: 2, head: { ref: 'revert/auto-abc' } } }) !== null, true, 'never revert a revert (branch)');
  eq(refuseRevert({ ...ok, parents: 2 }) !== null, true, 'a merge commit is not reverted');
  eq(refuseRevert({ ...ok, files: ['.github/workflows/ci.yml'] }) !== null, true, 'a workflow change is not reverted by the App');
  eq(revertBranch(A), 'revert/auto-aaaaaaaaaa', 'branch name');
  eq(
    revertTitle({ prNumber: 7, sha: A, files: ['apps/x.ts'], redRun: 9 }),
    'Revert #7, which turned the Real-app journeys red (run 9)',
    'title',
  );
  eq(
    revertTitle({ prNumber: 7, sha: A, files: ['tooling/ci/gates.mjs'], redRun: 9 }).startsWith('ci: revert #7'),
    true,
    'a gate revert says ci:',
  );
  eq(/J-[a-z]/.test(revertTitle({ prNumber: 7, sha: A, files: [], redRun: 9 })), false, 'no journey step in the title');
  const body = revertBody({ repo: 'o/r', sha: A, subject: 's (#7)', prNumber: 7, redRun: 9, steps: ['J-a-01#2'], base: 'main' });
  eq(
    ['actions/runs/9', '`J-a-01 #2`', '#7'].every((t) => body.includes(t)),
    true,
    'body names the red run, the steps and the culprit',
  );
  // One revert for both reds: a CI red names its run, its test files and its probed jobs, and its title says CI.
  eq(
    revertTitle({ prNumber: 7, sha: A, files: ['apps/x.ts'], redRun: 9, kind: 'ci' }),
    "Revert #7, which turned main's CI red (run 9)",
    'a CI revert title',
  );
  const ciText = failingText({ kind: 'ci', tests: ['tooling/ci/journey-reach-map.test.mjs'], jobs: ['Doctrine gates'] });
  eq(ciText, '`tooling/ci/journey-reach-map.test.mjs`, the Doctrine gates job', 'a CI red names its files and jobs');
  const ciBody = revertBody({ repo: 'o/r', sha: A, subject: 's (#7)', prNumber: 7, redRun: 9, steps: [], base: 'main', failing: ciText });
  eq(
    ['actions/runs/9', 'the Doctrine gates job', '#7'].every((t) => ciBody.includes(t)),
    true,
    'a CI body names the run, the job and the culprit',
  );
  eq(failingText({ kind: 'journeys', steps: ['J-a-01#2'] }), '`J-a-01 #2`', 'a journeys red names its steps');
  // The one break issue per journey gets the revert's link and `regression`, or `main-unknown-red`.
  eq(journeysOf(['J-a-01#2', 'J-a-01#3', 'J-b-02#1']), ['J-a-01', 'J-b-02'], 'each failing journey once, in order');
  const linked = breakIssueNotes({ steps: ['J-a-01#2', 'J-a-01#3'], revertUrl: 'https://github.com/o/r/pull/9', redRunUrl: 'u' });
  eq(
    linked.map((n) => [n.title, n.labels]),
    [['Journey broken on main: J-a-01', ['regression']]],
    "a revert notes the journey's one issue as a regression",
  );
  eq(linked[0].body.includes('https://github.com/o/r/pull/9'), true, 'the note links the revert');
  eq(linked[0].opens, true, 'a traced red opens its journey issue when main trust has not yet');
  eq(linked[0].body.includes('<!-- steps: J-a-01#2, J-a-01#3 -->'), true, 'the opened issue names its steps, so main trust can close it');
  const untraced = breakIssueNotes({ steps: ['J-b-02#1'], reason: 'no commit between them can reach J-b-02', redRunUrl: 'u' });
  eq(
    untraced.map((n) => n.labels),
    [['main-unknown-red']],
    'a red traced to no single merge is main-unknown-red',
  );
  eq(untraced[0].body.includes('no commit between them can reach J-b-02'), true, 'the note says why');
  eq(untraced[0].opens, false, 'an untraced red opens no issue: main-unknown-red stops every builder');
  // refresh: main-bisect's red revert is rebased once per merge into main, at most REFRESH_MAX.
  const rpr = (over = {}) => ({
    number: 8138,
    draft: false,
    user: { login: 'intafaced-mac-agents[bot]', type: 'Bot' },
    head: { ref: 'revert/auto-2481c93533', sha: 'c'.repeat(40), repo: { full_name: 'o/r' } },
    ...over,
  });
  const rrun = (over = {}) => ({
    id: 1,
    run_number: 9,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'failure',
    run_started_at: '2026-11-12T16:00:00Z',
    ...over,
  });
  const rruns = (ci = {}, review = {}) => ({
    'ci.yml': [rrun(ci)],
    'ci-review.yml': [rrun({ id: 2, event: 'pull_request_target', conclusion: 'success', ...review })],
  });
  const at = { repo: 'o/r', mainAt: Date.parse('2026-11-13T00:51:39Z'), rebased: 0 };
  eq(refreshWhy(rpr(), { ...at, runs: rruns() }).refresh, true, "#8138: its CI red before main's head: rebased");
  eq(
    refreshWhy(rpr(), { ...at, runs: rruns({ conclusion: 'success' }, { conclusion: 'failure' }) }).refresh,
    true,
    'a red CI review alone: rebased',
  );
  eq(refreshWhy(rpr(), { ...at, runs: rruns({ conclusion: 'success' }) }).refresh, false, 'every check green: left');
  eq(
    refreshWhy(rpr(), { ...at, runs: rruns({ run_started_at: '2026-11-13T01:00:00Z' }) }).refresh,
    false,
    "red after main's head: once per merge",
  );
  eq(
    refreshWhy(rpr(), { ...at, runs: rruns({}, { status: 'in_progress', conclusion: null }) }).refresh,
    false,
    'a check still going: left',
  );
  eq(refreshWhy(rpr(), { ...at, runs: rruns(), rebased: REFRESH_MAX }).refresh, false, 'bounded: REFRESH_MAX rebases');
  eq(
    refreshWhy(rpr({ user: { login: 'ZenYoda3', type: 'User' } }), { ...at, runs: rruns() }).refresh,
    false,
    "a person's pull request: never",
  );
  eq(refreshWhy(rpr({ head: { ...rpr().head, repo: { full_name: 'x/y' } } }), { ...at, runs: rruns() }).refresh, false, 'a fork: never');
  eq(refreshWhy(rpr({ head: { ...rpr().head, ref: 'fix/x' } }), { ...at, runs: rruns() }).refresh, false, 'another branch: never');
  eq(refreshWhy(rpr({ draft: true }), { ...at, runs: rruns() }).refresh, false, 'a draft: never');
  eq(
    refreshWhy(rpr(), { ...at, runs: { 'ci.yml': [rrun(), rrun({ id: 3, run_number: 10, conclusion: 'success' })], 'ci-review.yml': [] } })
      .refresh,
    false,
    'the newest run decides',
  );
  const conflicted = breakIssueNotes({ steps: ['J-c-03#4'], conflict: '#7 (`abcdef0123`)', redRunUrl: 'u' });
  eq(
    conflicted.map((n) => [n.labels, n.opens]),
    [[['regression'], true]],
    "a revert that conflicts: the journey's issue is a regression, opened",
  );
  eq(
    conflicted[0].body.includes('#7') && conflicted[0].body.includes('conflicts') && !conflicted[0].body.includes('revert it by hand'),
    true,
    'it names the culprit and the conflict',
  );
  eq(conflicted[0].body.includes('<!-- steps: J-c-03#4 -->'), true, 'the issue names its steps, so main trust can close it');
  // fix-01, act on the job: an early start, once; the break back when its journey passes alone on main's head.
  eq(
    [shardOf('Journeys (shard 17 of 32)'), shardOf('real-app-journeys-shard-3'), shardOf('Journeys revert'), shardOf('real-app-journeys')],
    [17, 3, null, null],
    'shard numbers',
  );
  eq(
    joinReports([report(spec('J-a-01 #1 x', 'expected')), report(spec('J-a-01 #2 y', 'unexpected'))]).suites.length,
    2,
    'shard reports join',
  );
  eq(revertSteps(pass, joinReports([red])), ['J-a-01#2'], "a shard's report alone starts the revert");
  eq(bisectTitle(A, ['J-a-01#2', 'J-b-02#1']), `Main bisect ${A} J-a-01#2,J-b-02#1`, 'the run name');
  eq(
    [...coveredSteps([bisectTitle(A, ['J-a-01#2']), bisectTitle(B, ['J-c-03#1']), 'Main bisect', null], A)],
    ['J-a-01#2'],
    "only that commit's started steps",
  );
  eq(
    endedShards(
      [
        { name: 'Journeys (shard 1 of 2)', status: 'completed' },
        { name: 'Journeys (shard 2 of 2)', status: 'in_progress' },
        { name: 'What this run runs', status: 'completed' },
      ],
      new Set(),
    ).map((j) => j.shard),
    [1],
    'only shard jobs that ended',
  );
  eq(endedShards([{ name: 'Journeys (shard 1 of 2)', status: 'completed' }], new Set([1])), [], 'a shard is read once');
  eq(
    revertMergePull('Revert #7929, which turned the Real-app journeys red (run 42970678172) (#7936)'),
    7936,
    "the revert's own pull request",
  );
  eq(revertMergePull('ci: revert #7, which turned the Real-app journeys red (run 9) (#8)'), 8, 'a gate revert');
  eq(
    [
      revertMergePull('Revert #7929, which turned the Real-app journeys red (run 1)'),
      revertMergePull('Revert "x" (#5)'),
      revertMergePull("Revert #7, which turned main's CI red (run 9) (#8)"),
    ],
    [null, null, null],
    'anything else is not one',
  );
  eq(failingSteps('x\n- Failing: `J-home-ia-07 #4`, `J-a-01 #12`\n- Culprit: #1'), ['J-home-ia-07#4', 'J-a-01#12'], 'the failing steps');
  eq(
    journeyFilesOf(['J-a-01#2'], ['J-a-01.pw.mjs', 'J-a-01-lookup.pw.mjs', 'J-a-010.pw.mjs', 'J-a-02.pw.mjs']),
    ['J-a-01-lookup.pw.mjs', 'J-a-01.pw.mjs'],
    "the journey's own files",
  );
  const backed = backNotes({ steps: ['J-a-01#2'], back: true, sha: A, runUrl: 'u' });
  eq(
    [backed[0].title, backed[0].labels, backed[0].opens, /the break is back/.test(backed[0].body)],
    ['Journey broken on main: J-a-01', [], false, true],
    'back: a comment, no label, no new issue',
  );
  eq(/not back/.test(backNotes({ steps: ['J-a-01#2'], back: false, sha: A, runUrl: 'u' })[0].body), true, 'still red says so');
  eq(
    /did not finish/.test(backNotes({ steps: ['J-a-01#2'], back: null, sha: A, runUrl: 'u' })[0].body),
    true,
    'a run that broke says nothing',
  );
  // Settle: a red no merge explains, run alone on main's head.
  const settle = (back) =>
    settleNotes({
      steps: ['J-a-01#2', 'J-a-01#3', 'J-b-01#1'],
      back,
      sha: A,
      runUrl: 'u',
      redRunUrl: 'https://x/actions/runs/42',
      at: 't',
    });
  const passed = settle(true);
  // A money step's flaky issue carries the mark the state repo's pull reads.
  const marked = settleNotes({
    steps: ['J-a-01#2', 'J-b-01#1', 'J-c-01#1'],
    back: true,
    sha: A,
    runUrl: 'u',
    redRunUrl: 'https://x/actions/runs/42',
    at: 't',
    money: { 'J-a-01#2': true, 'J-b-01#1': false },
  }).map((n) => /<!-- money-flaky: (\S+) -->/.exec(n.body)?.[1] ?? null);
  eq(
    marked,
    ['J-a-01#2', null, 'J-c-01#1'],
    'a money step (or one the guard does not know) is marked money-flaky; a non-money step is not',
  );
  const guard = moneyGuardAt('.');
  eq(guard['J-cex-spot-01#8'], true, "the guard at this checkout calls J-cex-spot-01 #8 money, as main's verdict did");
  const real = settleNotes({ steps: ['J-cex-spot-01#8'], back: true, sha: A, runUrl: 'u', redRunUrl: 'r', at: 't', money: guard })[0].body;
  eq(real.includes('<!-- money-flaky: J-cex-spot-01#8 -->'), true, "#8379's step, settled flaky, opens marked money-flaky");
  eq(
    passed.map((n) => [n.title, n.labels, n.opens]),
    [
      ['Flaky step on main: J-a-01 #2', ['flaky'], true],
      ['Flaky step on main: J-a-01 #3', ['flaky'], true],
      ['Flaky step on main: J-b-01 #1', ['flaky'], true],
    ],
    'passes alone: one flaky issue per step, no break issue',
  );
  eq(
    passed.some((n) => n.labels.includes('regression')),
    false,
    'planted fault: a pass alone never opens a regression',
  );
  eq(
    parseSettle(passed[0].body),
    { v: 1, steps: ['J-a-01#2'], red_run: 42, sha: A, run: 'u', result: 'pass', at: 't' },
    'the settle record reads back',
  );
  const failed = settle(false);
  eq(
    failed.map((n) => [n.title, n.labels, n.opens, /<!-- steps: ([^>]*) -->/.exec(n.body)?.[1]]),
    [
      ['Journey broken on main: J-a-01', ['regression'], true, 'J-a-01#2, J-a-01#3'],
      ['Journey broken on main: J-b-01', ['regression'], true, 'J-b-01#1'],
    ],
    'fails again alone: one regression issue per journey at once, naming the steps Main trust closes it on',
  );
  eq(
    settle(null).map((n) => [n.labels, n.opens]),
    [
      [['main-unknown-red'], true],
      [['main-unknown-red'], true],
    ],
    'a settle run that broke: a labelled main-unknown-red issue, never nothing',
  );
  // A failed revoke never hides why the revert failed (no throw inside finally).
  eq(
    afterRevoke(new Error('could not open the revert pull request: HTTP 422'), 'the revert token may still be live').message,
    'could not open the revert pull request: HTTP 422; and the revert token may still be live',
    'both errors are said',
  );
  eq(afterRevoke(null, 'the revert token may still be live').message, 'the revert token may still be live', 'the revoke alone');
  const e0 = new Error('x');
  eq(afterRevoke(e0, null) === e0, true, 'the earlier error alone, unchanged');
  eq(afterRevoke(null, null), null, 'nothing went wrong');
  // Settle beside the probe: a named merge wins over an early settle, in either order.
  const app = (over) => ({
    user: { login: 'intafaced-mac-agents[bot]' },
    head: { ref: 'revert/auto-abc' },
    state: 'open',
    merged_at: null,
    body: '- Red run: https://github.com/o/r/actions/runs/42 on `main`',
    ...over,
  });
  eq(revertForRun([app({})], 42)?.state, 'open', 'an open App revert for this red run is found');
  eq(
    revertForRun([app({ state: 'closed', merged_at: '2026-11-12T10:00:00Z' })], '42')?.merged_at,
    '2026-11-12T10:00:00Z',
    'a merged one too',
  );
  eq(revertForRun([app({ state: 'closed' })], 42), null, 'one closed unmerged is no longer the cause');
  eq(revertForRun([app({})], 4), null, 'planted fault: another run (42 is not 4) names no revert');
  eq(revertForRun([app({ user: { login: 'ZenYoda3' } })], 42), null, 'only the App opens the automatic revert');
  eq(revertForRun([app({ head: { ref: 'fix/42' } })], 42), null, 'only on a revert/auto- branch');
  const rec42 = settleNotes({ steps: ['J-a-01#2'], back: true, sha: A, runUrl: 'u', redRunUrl: 'https://x/actions/runs/42', at: 't' })[0]
    .body;
  eq(settledFor([{ user: { login: 'github-actions[bot]' }, body: rec42 }], 42), true, 'the flaky issue this red settled');
  eq(settledFor([{ user: { login: 'github-actions[bot]' }, body: rec42 }], 43), false, "another red's flaky issue stays open");
  eq(settledFor([{ user: { login: 'ZenYoda3' }, body: rec42 }], 42), false, 'only the workflow writes the record');
  // An automatic revert's body, as it merged.
  eq(
    failingSteps(
      'Automatic revert by the revert on main.\n\n- Red run: https://github.com/INTAFACED/intafaced/actions/runs/42970678172 on `main`\n- Failing: `J-home-ia-07 #4`\n- Culprit: #7929',
    ),
    ['J-home-ia-07#4'],
    "plant 1's revert body",
  );
  // The control and the recovery record.
  const ctlBody = revertBody({
    repo: 'o/r',
    sha: A,
    subject: 's (#7)',
    prNumber: 7,
    redRun: 9,
    steps: ['J-a-01#2'],
    base: 'main',
    control: B,
  });
  eq(/^- Control: `bbbbbbbbbb`, the last commit/m.test(ctlBody), true, 'the control line');
  eq(
    /- Control:/.test(revertBody({ repo: 'o/r', sha: A, subject: 's', prNumber: 7, redRun: 9, steps: ['J-a-01#2'], base: 'main' })),
    false,
    'no control, no line',
  );
  const rec = recoveryRecord({ revertPr: 8, revertBody: ctlBody, steps: ['J-a-01#2'], repair: C, confirmRun: 'u', back: true, at: 't' });
  eq(
    [rec.red_run, rec.blamed, rec.control, rec.confirm.result],
    [9, { pr: 7, sha: A.slice(0, 10) }, { sha: B.slice(0, 10), passed: true }, 'pass'],
    'the record from the body',
  );
  eq(parseRecord(recoveryComment(rec)), rec, 'the record reads back');
  eq([parseRecord('no mark'), parseRecord(`<!-- ${RECORD_MARK} {bad} -->`)], [null, null], 'no record, or a broken one, reads as none');
  eq(
    recoveryRecord({ revertPr: 8, revertBody: 'x', steps: [], repair: C, confirmRun: 'u', back: null, at: 't' }).confirm.result,
    'unfinished',
    'an unfinished confirm',
  );
  eq(
    culpritOf(revertBody({ repo: 'o/r', sha: A, subject: 's', prNumber: 7, redRun: 9, steps: ['J-a-01#2'], base: B, failing: [] })),
    A.slice(0, 10),
    'the culprit commit is read back from the revert body',
  );
  eq(culpritOf('no culprit line'), null, 'a body without a culprit line names none, so nothing is cancelled');
  eq(
    goingElsewhere(
      [
        { id: 1, head_branch: 'main', event: 'push', status: 'in_progress', head_sha: B },
        { id: 2, head_branch: 'main', event: 'push', status: 'queued', head_sha: A },
        { id: 3, head_branch: 'main', event: 'push', status: 'completed', head_sha: B },
        { id: 4, head_branch: 'x', event: 'pull_request', status: 'in_progress', head_sha: B },
        { id: 5, head_branch: 'main', event: 'workflow_dispatch', status: 'queued', head_sha: B },
      ],
      A,
    ).map((r) => r.id),
    [1, 5],
    "only main's runs still going on another commit than the revert's are weighed",
  );
});

test('journeys-revert: a revoked token is refused', async () => {
  const eq = (got, want, m) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${m}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  };
  const answers = (...list) => {
    const left = [...list];
    return async () => left.shift() ?? 200;
  };
  const noWait = async () => {};
  eq(await refusedAfterRevoke(answers(401), { sleep: noWait }), { refused: true, status: 401, tries: 1 }, 'refused at once');
  eq(
    await refusedAfterRevoke(answers(200, 200, 401), { sleep: noWait }),
    { refused: true, status: 401, tries: 3 },
    'refused once the revoke lands',
  );
  eq(await refusedAfterRevoke(answers(502, 401), { sleep: noWait }), { refused: true, status: 401, tries: 2 }, 'a 5xx is asked again');
  eq(
    await refusedAfterRevoke(answers(), { sleep: noWait }),
    { refused: false, status: 200, tries: REVOKE_PROBES.length },
    'still live: not refused',
  );
  eq(
    await refusedAfterRevoke(answers(403, 403, 403, 403, 403, 403), { sleep: noWait }),
    { refused: false, status: 403, tries: 6 },
    'only a 401 counts',
  );
  const slept = [];
  await refusedAfterRevoke(answers(), { sleep: async (ms) => slept.push(ms) });
  eq(slept, REVOKE_PROBES.filter(Boolean), 'waits between tries');
});

/** cancelDoomed's choice, on a fake GitHub whose compare answers from a commit line: P, culprit X, then M (a merge after
 *  it), revert R, then N after the revert; Q sits on a branch off P that never took X. Only a main run holding X and not
 *  R is cancelled. A push that is not an automatic revert never reaches it (revertMergePull). */
test('journeys-revert: cancelDoomed cancels only a main run holding the culprit and not the revert', async () => {
  const eq = (got, want, m) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${m}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  };
  const [P, X, M, R, N, Q] = ['1', '2', '3', '4', '5', '6'].map((c) => c.repeat(40));
  const line = [P, X, M, R, N];
  const compare = (base, head) => {
    if (base === head) return 'identical';
    const [b, h] = [line.indexOf(base), line.indexOf(head)];
    if (head === Q) return base === P ? 'ahead' : 'diverged';
    if (b < 0 || h < 0) return null; // a commit GitHub can't place: 404, no status
    return h > b ? 'ahead' : 'behind';
  };
  const fake = (runs) => {
    const cancelled = [];
    const gh = async (method, path) => {
      if (method === 'POST') {
        cancelled.push(Number(/runs\/(\d+)\/cancel$/.exec(path)[1]));
        return { status: 202, json: null };
      }
      const status = /[?&]status=(\w+)/.exec(path)?.[1];
      if (status) return { status: 200, json: { workflow_runs: runs.filter((r) => r.status === status) } };
      const [base, head] = /\/compare\/(\w+)\.\.\.(\w+)$/.exec(path).slice(1);
      const st = compare(base, head);
      return st ? { status: 200, json: { status: st } } : { status: 404, json: null };
    };
    return { gh, cancelled };
  };
  const run = (id, head_sha, status = 'in_progress', over = {}) => ({
    id,
    run_number: id,
    head_branch: 'main',
    event: 'push',
    status,
    head_sha,
    ...over,
  });
  const cases = [
    [[run(1, M)], [1], 'a run holding the culprit and not the revert is cancelled'],
    [[run(1, X)], [1], 'a run on the culprit itself is cancelled'],
    [[run(2, M, 'queued')], [2], 'a waiting run holding the culprit and not the revert is cancelled'],
    [[run(3, R)], [], "the revert's own run is left"],
    [[run(4, N)], [], 'a run already holding the revert is left'],
    [[run(5, P)], [], 'a run from before the culprit is left'],
    [[run(6, Q)], [], 'a run on a commit that never took the culprit is left'],
    [[run(7, 'f'.repeat(40))], [], 'a run whose commit the compare cannot place is left'],
    [[run(8, M, 'in_progress', { event: 'pull_request', head_branch: 'x' })], [], "a pull request's run is left"],
    [[run(9, M, 'completed')], [], 'a finished run is left'],
    [[run(1, M), run(4, N, 'queued'), run(5, P, 'queued')], [1], 'only the doomed run of several'],
  ];
  for (const [runs, want, m] of cases) {
    const { gh, cancelled } = fake(runs);
    const lines = await cancelDoomed(gh, 'o/r', { headSha: R, culprit: X });
    eq(cancelled, want, m);
    eq(
      lines.length,
      runs.filter((r) => r.status !== 'completed' && r.event !== 'pull_request' && r.head_sha !== R).length,
      `${m}: a line per run weighed`,
    );
  }
});

// project-state #2997: #8817 stayed armed from 01:15 UTC on 18 Nov after main went green at 02:42 with its culprit in.
test('spent: an open automatic revert closes once main passes its failing steps outright with the culprit still in', () => {
  const body = [
    'Automatic revert by the revert on main (tooling/ci/journeys-revert.mjs, OWNER 249 (3): "a red main is reverted").',
    '',
    '- Red run: https://github.com/o/r/actions/runs/44208633045 on `main`',
    '- Failing: `J-portfolio-01 #1`, `J-portfolio-01 #3`',
    '- Culprit: #8811, commit `061984dd94` fix(local-stack): x (#8811)',
  ].join('\n');
  const pr = (over = {}) => ({
    number: 8817,
    draft: false,
    body,
    user: { login: 'intafaced-mac-agents[bot]', type: 'Bot' },
    head: { ref: 'revert/auto-061984dd94', sha: 'c'.repeat(40), repo: { full_name: 'o/r' } },
    ...over,
  });
  const states = (one = 'passed', three = 'passed') =>
    new Map([
      ['J-portfolio-01#1', one],
      ['J-portfolio-01#3', three],
    ]);
  const at = { repo: 'o/r', holdsCulprit: true, pastRed: true };
  assert.equal(redRunOf(body), 44208633045);
  assert.equal(redRunOf('no line'), null);
  assert.equal(isAutoRevert(pr(), 'o/r'), true);
  const d = spentWhy(pr(), { ...at, states: states() });
  assert.equal(d.close, true, '#8817: main green with its culprit in: closed');
  assert.match(d.why, /J-portfolio-01#1, J-portfolio-01#3 passed outright on main with the culprit still in/);
  const left = (over, why) => assert.equal(spentWhy(over.pr ?? pr(), { ...at, states: states(), ...over }).close, false, why);
  left({ states: states('passed', 'failed') }, 'a failing step still red: left');
  left({ states: states('passed', 'flaky') }, 'a pass only on the retry: left');
  left({ states: new Map([['J-portfolio-01#1', 'passed']]) }, 'a step the run lacks: left');
  left({ holdsCulprit: false }, 'the merge already gone from this head: left');
  left({ holdsCulprit: undefined }, "a compare that couldn't say: left");
  left({ pastRed: false }, "a run on a head before the red run's: left");
  left(
    { pr: pr({ body: body.replace(/^- Failing: .*$/m, '- Failing: `apps/x.test.ts`, the Build job') }) },
    "main's CI revert names no step: left",
  );
  left({ pr: pr({ user: { login: 'ZenYoda3', type: 'User' } }) }, "a person's pull request: never");
  left({ pr: pr({ head: { ...pr().head, ref: 'fix/x' } }) }, 'another branch: never');
  left({ pr: pr({ head: { ...pr().head, repo: { full_name: 'x/y' } } }) }, 'a fork: never');
  left({ pr: pr({ draft: true }) }, 'a draft: never');
});
