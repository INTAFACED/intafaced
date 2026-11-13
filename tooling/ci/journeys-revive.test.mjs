/**
 * journeys-revive.mjs: a finished journeys run on main with no report is re-run, spaced out and bounded, then named.
 * The planted case is run 4005 (43037279979) of 11 Nov 2026, which died at "Install the browser" with no report.json.
 * Run by tooling/scripts/tooling-tests.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_ATTEMPT,
  PR_MAX_ATTEMPT,
  WAIT_MINUTES,
  candidates,
  decide,
  isRefusal,
  issueTitle,
  mainInputOnly,
  prCandidates,
  prTick,
  revertRerun,
  revertTick,
  isAutoRevert,
  REVERT_WORKFLOWS,
  tick,
  verdictReds,
} from './journeys-revive.mjs';

const REPO = 'INTAFACED/intafaced';
const NOW = Date.parse('2026-11-11T16:30:00Z');
const run = (over = {}) => ({
  id: 43037279979,
  run_number: 4005,
  head_branch: 'main',
  head_repository: { full_name: REPO },
  head_sha: 'f20569a2d0000000000000000000000000000000',
  event: 'push',
  status: 'completed',
  conclusion: 'failure',
  run_attempt: 2,
  created_at: '2026-11-11T14:18:58Z',
  updated_at: '2026-11-11T15:23:40Z',
  ...over,
});

/** A fake GitHub: `reports` the run ids that have a report.json; records every write. */
function fakeIo(runs, { reports = new Set(), open = new Set(), rerunStatus = 201 } = {}) {
  const calls = { rerun: [], created: [], checked: [] };
  return {
    calls,
    io: {
      listRuns: async () => runs,
      hasReport: async (r) => {
        calls.checked.push(r.id);
        return reports.has(r.id);
      },
      rerun: async (r) => {
        calls.rerun.push(r.id);
        return { ok: rerunStatus >= 200 && rerunStatus < 300, status: rerunStatus };
      },
      openIssue: async (title) => (open.has(title) ? { title } : null),
      createIssue: async (title, body) => calls.created.push({ title, body }),
      reportLikely: async (r) => {
        calls.likely = [...(calls.likely ?? []), r.id];
        return reports.has(r.id);
      },
    },
  };
}

test('a finished main run with no report is re-run once its wait has passed', async () => {
  const { io, calls } = fakeIo([run()]);
  const lines = await tick({ repo: REPO, now: NOW, io });
  assert.deepEqual(calls.rerun, [43037279979]);
  assert.deepEqual(calls.created, []);
  assert.match(lines[0], /run 4005 .* re-run of failed jobs requested/);
});

test('a run with a report is left alone', async () => {
  const { io, calls } = fakeIo([run()], { reports: new Set([43037279979]) });
  assert.deepEqual(await tick({ repo: REPO, now: NOW, io }), []);
  assert.deepEqual(calls.rerun, []);
  assert.deepEqual(calls.created, []);
});

test('a run still going (a first run or a re-run attempt) is left alone, its report not even read', async () => {
  for (const status of ['in_progress', 'queued', 'waiting']) {
    const { io, calls } = fakeIo([run({ status, conclusion: null, run_attempt: 3 })]);
    assert.deepEqual(await tick({ repo: REPO, now: NOW, io }), []);
    assert.deepEqual(calls.checked, []);
    assert.deepEqual(calls.rerun, []);
  }
});

test('cancelled, skipped and green runs, pull request and fork runs, and runs older than the window are not read', () => {
  const left = [
    run({ conclusion: 'cancelled' }),
    run({ conclusion: 'skipped' }),
    run({ conclusion: 'success' }),
    run({ event: 'pull_request' }),
    run({ head_branch: 'feature' }),
    run({ head_repository: { full_name: 'someone/fork' } }),
    run({ created_at: '2026-11-09T14:00:00Z' }),
  ];
  assert.deepEqual(candidates(left, { repo: REPO, now: NOW }), []);
  for (const conclusion of ['failure', 'timed_out', 'startup_failure'])
    assert.equal(candidates([run({ conclusion })], { repo: REPO, now: NOW }).length, 1, conclusion);
});

test('the tries are spaced: a run that ended inside its wait is not re-run yet', async () => {
  // Attempt 2 ended 15:23:40; its wait is 60 min, so 16:20 is too soon and 16:24 is not.
  const { io, calls } = fakeIo([run()]);
  const lines = await tick({ repo: REPO, now: Date.parse('2026-11-11T16:20:00Z'), io });
  assert.deepEqual(calls.rerun, []);
  assert.match(lines[0], /waiting 60 min/);
  assert.equal(decide(run(), Date.parse('2026-11-11T16:24:00Z')), 'rerun');
  // The waits grow with each attempt, so the tries outlast an outage of hours.
  const waits = Object.values(WAIT_MINUTES);
  assert.ok(waits.every((w, i) => i === 0 || w > waits[i - 1]));
  assert.ok(waits.reduce((a, b) => a + b, 0) >= 6 * 60, 'the waits alone span at least six hours');
});

test('the tries are bounded: no re-run is asked for at or past the last attempt; the run is named in one issue, once', async () => {
  assert.equal(MAX_ATTEMPT, 5);
  for (let attempt = 1; attempt < MAX_ATTEMPT; attempt++) assert.ok(WAIT_MINUTES[attempt] > 0, `attempt ${attempt} has a wait`);
  const late = Date.parse('2026-11-12T12:00:00Z');
  for (const attempt of [MAX_ATTEMPT, MAX_ATTEMPT + 1]) {
    const { io, calls } = fakeIo([run({ run_attempt: attempt })]);
    const lines = await tick({ repo: REPO, now: late, io });
    assert.deepEqual(calls.rerun, [], `attempt ${attempt}: no re-run`);
    assert.equal(calls.created.length, 1);
    assert.equal(calls.created[0].title, 'Journeys run on main has no report: run 4005');
    assert.match(calls.created[0].body, /actions\/runs\/43037279979/);
    assert.match(lines[0], /after its last try, issue opened/);
  }
  const { io, calls } = fakeIo([run({ run_attempt: MAX_ATTEMPT })], { open: new Set([issueTitle(run())]) });
  await tick({ repo: REPO, now: late, io });
  assert.deepEqual(calls.created, [], 'an open issue is not opened again');
});

test('a re-run GitHub does not take is named at once, not asked for again every hour', async () => {
  const { io, calls } = fakeIo([run()], { rerunStatus: 422 });
  const lines = await tick({ repo: REPO, now: NOW, io });
  assert.deepEqual(calls.rerun, [43037279979]);
  assert.equal(calls.created.length, 1);
  assert.match(lines[0], /did not take its re-run \(422\), issue opened/);
});

test('11 Nov replayed: hourly ticks from attempt 2 re-run run 4005 at most three more times, then name it', async () => {
  // Each re-run attempt is planted to last 40 minutes and die again with no report.
  let r = run();
  const reruns = [];
  let issues = 0;
  for (let t = Date.parse('2026-11-11T15:43:00Z'); t < Date.parse('2026-11-13T00:00:00Z'); t += 3600_000) {
    const { io, calls } = fakeIo([r], { open: new Set(issues ? [issueTitle(r)] : []) });
    await tick({ repo: REPO, now: t, io });
    issues += calls.created.length;
    if (calls.rerun.length) {
      reruns.push(new Date(t).toISOString().slice(11, 16));
      r = run({ run_attempt: r.run_attempt + 1, updated_at: new Date(t + 40 * 60_000).toISOString() });
    }
  }
  assert.equal(reruns.length, MAX_ATTEMPT - 2, `re-runs at ${reruns.join(', ')} UTC`);
  assert.equal(r.run_attempt, MAX_ATTEMPT);
  assert.equal(issues, 1);
});

// ── Pull requests red only on main's inputs ─────────────────────────────────
// The verdict's summary lines as the job log printed them on 11 Nov 2026 (run 4047's job 130847213771 and run 4030's
// attempt 2, job 130868099809), shortened to the rows.
const T = '2026-11-11T23:07:57.0284575Z ';
const summary = (rows) =>
  [
    '### Verdict against the list of steps not built yet',
    '',
    'Baseline: run 1719 (`docs/runbooks/journey-baseline.json`).',
    `Failing or missing steps: 44; outside the list or against its rules: **${rows.length}**.`,
    '',
    ...rows.map((r) => `- ${r}`),
    '',
    '### Set aside by the machine: 3',
    '',
    '- J-home-ia-06#1: missing in this run; set aside until 2026-11-15T13:16:27.000Z (first flaky in run 2332); owner: the home-ia area',
  ]
    .map((l) => T + l)
    .join('\n');
const HISTORY =
  "(input) (money): the pass history couldn't be read: run 4005's report couldn't be read (run 43037279979's real-app-journeys artifact has no report.json), so a pass in it can't be ruled out";
// Run 4084's own verdict (43127556856, 12 Nov 2026 01:09 UTC), shortened: the installation's API budget was spent.
const NAMED_LIMITED =
  "(input) (money): the baseline's named run 1719 (42357098806) report couldn't be read: Command failed: gh run download 42357098806 --repo INTAFACED/intafaced --name real-app-journeys --dir /tmp/verdict-ON5QHZ: error fetching artifacts: HTTP 403: API rate limit exceeded for installation.";
// Every pull request's verdict after it, until its re-run was cancelled at 02:11 UTC (#8025, run 43134112457).
const HISTORY_4084 =
  "(input) (money): the pass history couldn't be read: run 4084's report couldn't be read (run 43127556856's real-app-journeys artifact has no report.json), so a pass in it can't be ruled out";
const OWN_STEP = 'J-portfolio-06#1 (money): failing, not in the baseline';
const UNBUILT = "J-agents-08#2 (money): called unbuilt, but passed on main in run 4005, after the baseline's run 1719";

const VERDICT_RED = [
  { name: 'Plan', conclusion: 'success', steps: [] },
  {
    name: 'Real-app journeys',
    conclusion: 'failure',
    steps: [
      { name: 'Red when a shard was red or sent no report', conclusion: 'success' },
      { name: 'Verdict tests', conclusion: 'success' },
      { name: 'Verdict against the list of steps not built yet', conclusion: 'failure' },
    ],
  },
];
const prRun = (over = {}) => ({
  id: 43113864635,
  run_number: 4047,
  event: 'pull_request',
  head_repository: { full_name: REPO },
  head_sha: 'dcfd924764',
  status: 'completed',
  conclusion: 'failure',
  run_attempt: 1,
  created_at: '2026-11-11T22:41:30Z',
  pull_requests: [{ number: 7990 }],
  ...over,
});
const PR_NOW = Date.parse('2026-11-11T23:51:00Z');
/** A fake GitHub for the pull request pass: main's runs and reports, and per run its jobs and its verdict's rows. */
function prIo({
  runs = [prRun()],
  main = [],
  reports = new Set([43037279979]),
  jobs = VERDICT_RED,
  rows = { 43113864635: [HISTORY] },
  pr = {},
  newer = [],
  budget = { limit: 15000, used: 100, remaining: 14900, reset: 1794452400 },
} = {}) {
  const calls = { rerun: [], logs: 0 };
  return {
    calls,
    io: {
      listRuns: async () => main,
      hasReport: async (r) => reports.has(r.id),
      listPrRuns: async () => runs,
      pull: async () => ({ state: 'open', draft: false, head: { sha: 'dcfd924764' }, ...pr }),
      headRuns: async () => newer,
      budget: async () => budget,
      jobs: async () => jobs,
      jobLog: async () => {
        calls.logs++;
        return summary(rows[runs[0].id] ?? []);
      },
      rerun: async (r) => {
        calls.rerun.push(r.id);
        return { ok: true, status: 201 };
      },
    },
  };
}

test("the verdict's red rows are read from its job log, and nothing is read when the summary is missing or short", () => {
  assert.deepEqual(verdictReds(summary([HISTORY])), [HISTORY]);
  assert.deepEqual(verdictReds(summary([HISTORY, OWN_STEP])), [HISTORY, OWN_STEP]);
  assert.equal(verdictReds('Error: something threw before the summary'), null);
  assert.equal(verdictReds(summary([HISTORY]).replace('**1**', '**2**')), null);
});

test("only rows about main's inputs count as input-only; a step row or this run's own report never does", () => {
  assert.deepEqual(mainInputOnly([HISTORY]), { runIds: [43037279979], namedIds: [], rateLimited: false });
  assert.deepEqual(mainInputOnly([NAMED_LIMITED]), { runIds: [42357098806], namedIds: [42357098806], rateLimited: true });
  assert.ok(mainInputOnly(["(input) (money): the baseline's named run 1719 (40200000000) report couldn't be read: HTTP 502"]));
  assert.ok(mainInputOnly(["(input) (money): the last run on main's set-aside list couldn't be read: HTTP 502"]));
  assert.equal(mainInputOnly([HISTORY, OWN_STEP]), null);
  assert.equal(mainInputOnly([UNBUILT]), null);
  assert.equal(mainInputOnly(['(input) (money): this run kept no merged journey report']), null);
  assert.equal(mainInputOnly([]), null);
  assert.equal(mainInputOnly(null), null);
});

test('a run red only on main inputs is re-run once main is back', async () => {
  const { io, calls } = prIo();
  const lines = await prTick({ repo: REPO, now: PR_NOW, io });
  assert.deepEqual(calls.rerun, [43113864635]);
  assert.match(lines[0], /#7990.*main is back, re-run of failed jobs requested/);
});

test("it waits while main is not back: the baseline's named run has no report, a run a row names is still going, a main re-run is going, or the API budget a rate-limited row hit is still short", async () => {
  const cases = [
    { rows: { 43113864635: [NAMED_LIMITED] }, reports: new Set(), why: /run 42357098806 has no report yet/ },
    { main: [run({ status: 'queued', conclusion: null, run_attempt: 1 })], why: /run 4005 is still going/ },
    { main: [run({ status: 'in_progress', conclusion: null, run_attempt: 3 })], why: /re-run is still going/ },
    {
      rows: { 43113864635: [NAMED_LIMITED] },
      reports: new Set([42357098806]),
      budget: { limit: 1000, used: 990, remaining: 10, reset: 1794452400 },
      why: /the API budget has 10 of 1000 calls left/,
    },
  ];
  for (const c of cases) {
    const { io, calls } = prIo(c);
    const lines = await prTick({ repo: REPO, now: PR_NOW, io });
    assert.deepEqual(calls.rerun, []);
    assert.match(lines[0], c.why);
  }
});

test('12 Nov replayed: a main run that finished with no report (4084) or was cancelled no longer holds the pull requests; a rate-limited row waits for the budget, then re-runs', async () => {
  const r4084 = run({
    id: 43127556856,
    run_number: 4084,
    run_attempt: 1,
    created_at: '2026-11-12T00:28:41Z',
    updated_at: '2026-11-12T01:09:48Z',
  });
  for (const main of [[r4084], [{ ...r4084, run_attempt: 2, conclusion: 'cancelled' }], []]) {
    const { io, calls } = prIo({ main, rows: { 43113864635: [HISTORY_4084] }, reports: new Set() });
    const lines = await prTick({ repo: REPO, now: Date.parse('2026-11-12T01:30:00Z'), io });
    assert.deepEqual(calls.rerun, [43113864635], JSON.stringify(main).slice(0, 80));
    assert.match(lines[0], /main is back, re-run of failed jobs requested/);
  }
  const { io, calls } = prIo({
    rows: { 43113864635: [NAMED_LIMITED] },
    reports: new Set([42357098806]),
    budget: { limit: 1000, used: 500, remaining: 500, reset: 1794452400 },
  });
  await prTick({ repo: REPO, now: Date.parse('2026-11-12T02:30:00Z'), io });
  assert.deepEqual(calls.rerun, [43113864635]);
});

test("a red of the pull request's own stays red: a step row, another failed step or job, or no summary", async () => {
  const shard = [
    { ...VERDICT_RED[1], steps: [{ name: 'Red when a shard was red or sent no report', conclusion: 'failure' }, VERDICT_RED[1].steps[2]] },
  ];
  const cases = [
    { rows: { 43113864635: [HISTORY, OWN_STEP] } },
    { rows: { 43113864635: [UNBUILT] } },
    { rows: {} },
    { jobs: shard },
    { jobs: [...VERDICT_RED, { name: 'Journeys (shard 3 of 8)', conclusion: 'failure', steps: [] }] },
  ];
  for (const c of cases) {
    const { io, calls } = prIo(c);
    const lines = await prTick({ repo: REPO, now: PR_NOW, io });
    assert.deepEqual(calls.rerun, [], JSON.stringify(c).slice(0, 80));
    assert.match(lines[0], /its own red/);
  }
});

test('bounded: per head (a moved head, a newer run, a closed or draft pull request) and per run (PR_MAX_ATTEMPT)', async () => {
  assert.equal(PR_MAX_ATTEMPT, 3);
  const cases = [
    { pr: { head: { sha: 'newer' } } },
    { pr: { state: 'closed' } },
    { pr: { draft: true } },
    { newer: [prRun({ run_number: 4050 })] },
    { runs: [prRun({ run_attempt: PR_MAX_ATTEMPT })] },
    { runs: [prRun({ conclusion: 'success' })] },
    { runs: [prRun({ status: 'in_progress', conclusion: null })] },
    { runs: [prRun({ head_repository: { full_name: 'someone/fork' } })] },
    { runs: [prRun({ created_at: '2026-11-10T20:00:00Z' })] },
  ];
  for (const c of cases) {
    const { io, calls } = prIo(c);
    assert.deepEqual(await prTick({ repo: REPO, now: PR_NOW, io }), [], JSON.stringify(c));
    assert.deepEqual(calls.rerun, []);
    assert.equal(calls.logs, 0, 'no log is read');
  }
  assert.equal(prCandidates([prRun({ run_attempt: 2 })], { repo: REPO, now: PR_NOW }).length, 1);
});

test('11 Nov replayed on the recorded verdict rows: five of six re-run at 23:00 and at 23:51; the two red ones stop', async () => {
  // Each run's rows at attempt 1 and attempt 2, as the job logs printed them (journey runs 4030 to 4048).
  const record = [
    { id: 43113864635, n: 4047, a1: [HISTORY], a2: null }, // green after the re-run
    { id: 43114148199, n: 4048, a1: [HISTORY], a2: null }, // green
    { id: 43109619673, n: 4043, a1: [HISTORY], a2: null }, // green
    { id: 43106935427, n: 4041, a1: [HISTORY], a2: null }, // green
    { id: 43107761724, n: 4042, a1: [HISTORY], a2: [UNBUILT] }, // red again, now on a step
    { id: 43086802340, n: 4030, a1: [HISTORY, OWN_STEP], a2: [OWN_STEP] }, // its own step from the start
  ];
  const tickAt = async (now, attempt, back) => {
    const reruns = [];
    for (const r of record) {
      const rows = r[`a${attempt}`];
      if (!rows) continue;
      const { io, calls } = prIo({
        runs: [prRun({ id: r.id, run_number: r.n, run_attempt: attempt })],
        rows: { [r.id]: rows },
        reports: back ? new Set([43037279979]) : new Set(),
      });
      await prTick({ repo: REPO, now, io });
      reruns.push(...calls.rerun);
    }
    return reruns;
  };
  // Since 12 Nov a finished main run with no report no longer holds them: its verdict skips run 4005, so the five are
  // re-run at 23:00 already, without waiting for 4005's report (journey-verdict.mjs readHistory).
  assert.deepEqual(
    await tickAt(Date.parse('2026-11-11T23:00:00Z'), 1, false),
    [43113864635, 43114148199, 43109619673, 43106935427, 43107761724],
  );
  assert.deepEqual(await tickAt(PR_NOW, 1, true), [43113864635, 43114148199, 43109619673, 43106935427, 43107761724]);
  assert.deepEqual(await tickAt(Date.parse('2026-11-12T00:30:00Z'), 2, true), [], 'the two red at attempt 2 are their own');
});

test('a refusal (403, 429) stops the pass at once: no later run is re-run, and the CLI names it in one issue', async () => {
  const runs = [prRun(), prRun({ id: 2, run_number: 4048 })];
  const { io, calls } = prIo({ runs, rows: { 43113864635: [HISTORY], 2: [HISTORY] } });
  io.rerun = async (r) => {
    calls.rerun.push(r.id);
    throw new Error('GitHub 429 on POST /repos/x/actions/runs/1/rerun-failed-jobs: stopping, not retrying');
  };
  await assert.rejects(prTick({ repo: REPO, now: PR_NOW, io }), (e) => isRefusal(e));
  assert.deepEqual(calls.rerun, [43113864635]);
  assert.equal(isRefusal(new Error('GitHub 403 on GET /x: stopping, not retrying')), true);
  assert.equal(isRefusal(new Error('GitHub 502 on GET /x')), false);
});

test('lazy (after each CI run on main): a run inside its wait is not read, a large artifact costs no download, a dead run is still re-run', async () => {
  const waiting = run({ id: 1, run_number: 1, updated_at: '2026-11-11T16:20:00Z' });
  const reported = run({ id: 2, run_number: 2 });
  const dead = run({ id: 3, run_number: 3 });
  const { io, calls } = fakeIo([waiting, reported, dead], { reports: new Set([2]) });
  const lines = await tick({ repo: REPO, now: NOW, io, lazy: true });
  assert.deepEqual(calls.likely, [2, 3], 'the waiting run is not read at all');
  assert.deepEqual(calls.checked, [3], 'only the run whose artifact is small is downloaded');
  assert.deepEqual(calls.rerun, [3]);
  assert.equal(lines.length, 1);
});

// ── automatic reverts (revertTick) ──────────────────────────────────────────
const MAIN_AT = Date.parse('2026-11-13T00:51:39Z'); // #8166 merged
const revertPr = (over = {}) => ({
  number: 8138,
  draft: false,
  user: { login: 'intafaced-mac-agents[bot]', type: 'Bot' },
  head: { ref: 'revert/auto-2481c93533', sha: 'cbe12915337701912c2be93f2d1de9b0182d1722', repo: { full_name: REPO } },
  ...over,
});
const revertRun = (over = {}) => ({
  id: 43253820978,
  run_number: 9000,
  event: 'pull_request',
  status: 'completed',
  conclusion: 'failure',
  run_attempt: 1,
  created_at: '2026-11-12T15:58:00Z',
  run_started_at: '2026-11-12T15:58:00Z',
  ...over,
});
function revertIo(pulls, runsByFile, { rerunStatus = 201 } = {}) {
  const calls = { rerun: [] };
  return {
    calls,
    io: {
      openPulls: async () => pulls,
      mainAt: async () => MAIN_AT,
      workflowHeadRuns: async (file) => runsByFile[file] ?? [],
      rerun: async (r) => (calls.rerun.push(r.id), { ok: rerunStatus >= 200 && rerunStatus < 300, status: rerunStatus }),
    },
  };
}

test('#8138 replayed: after the merge that changed the checks, its red CI and CI review re-run once, with no hand', async () => {
  const runs = {
    'ci.yml': [revertRun()],
    'ci-review.yml': [
      revertRun({ id: 43253821356, run_number: 7000, event: 'pull_request_target' }),
      revertRun({ id: 43253821400, run_number: 7001, event: 'pull_request_target', conclusion: 'skipped' }),
    ],
    'real-app-journeys.yml': [revertRun({ id: 5, run_number: 4470, conclusion: 'success' })],
  };
  const f = revertIo([revertPr()], runs);
  const lines = await revertTick({ repo: REPO, io: f.io });
  assert.deepEqual(f.calls.rerun, [43253820978, 43253821356]);
  assert.equal(lines.length, REVERT_WORKFLOWS.length);
  // The next merge's pass, with both re-runs started after main's head: nothing again.
  const after = { ...runs, 'ci.yml': [revertRun({ run_attempt: 2, run_started_at: '2026-11-13T00:55:00Z' })] };
  after['ci-review.yml'] = [
    revertRun({ id: 43253821356, run_number: 7000, event: 'pull_request_target', run_attempt: 2, run_started_at: '2026-11-13T00:55:00Z' }),
  ];
  const g = revertIo([revertPr()], after);
  await revertTick({ repo: REPO, io: g.io });
  assert.deepEqual(g.calls.rerun, [], 'once per merge: a run started after main moved is not re-run');
});

test("only main-bisect's own revert is re-run: not another author, a person, a fork, another branch or a draft", () => {
  assert.equal(isAutoRevert(revertPr(), REPO), true);
  assert.equal(isAutoRevert(revertPr({ user: { login: 'ZenYoda3', type: 'User' } }), REPO), false);
  assert.equal(isAutoRevert(revertPr({ user: { login: 'intafaced-mac-agents[bot]', type: 'User' } }), REPO), false);
  assert.equal(isAutoRevert(revertPr({ head: { ...revertPr().head, repo: { full_name: 'x/y' } } }), REPO), false);
  assert.equal(isAutoRevert(revertPr({ head: { ...revertPr().head, ref: 'fix/revert' } }), REPO), false);
  assert.equal(isAutoRevert(revertPr({ draft: true }), REPO), false);
});

test('bounded: a green, going or newer run, and a run at its last attempt, are left alone', () => {
  const at = { event: 'pull_request', mainAt: MAIN_AT };
  assert.ok(revertRerun([revertRun()], at).run);
  assert.equal(revertRerun([revertRun({ conclusion: 'success' })], at).run, undefined);
  assert.equal(revertRerun([revertRun({ status: 'in_progress', conclusion: null })], at).run, undefined);
  assert.equal(revertRerun([revertRun({ run_started_at: '2026-11-13T01:00:00Z' })], at).run, undefined);
  assert.equal(revertRerun([revertRun({ run_attempt: MAX_ATTEMPT })], at).run, undefined);
  assert.equal(revertRerun([revertRun({ event: 'push' })], at).run, undefined, 'another event is not the pull request run');
  // The newest run decides: an older red one under a newer green one is not re-run.
  assert.equal(revertRerun([revertRun(), revertRun({ id: 2, run_number: 9001, conclusion: 'success' })], at).run, undefined);
});

test('no open automatic revert reads nothing more', async () => {
  const f = revertIo([revertPr({ user: { login: 'ZenYoda3', type: 'User' } })], {});
  f.io.mainAt = async () => assert.fail('main is not read');
  assert.deepEqual(await revertTick({ repo: REPO, io: f.io }), []);
});
