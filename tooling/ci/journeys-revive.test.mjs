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
  heldOnly,
  heldTick,
  isRefusal,
  issueTitle,
  mainInputOnly,
  prCandidates,
  prTick,
  rowStep,
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

// ── heldTick: pull requests held by main's reds that main has since lost ──
// The planted case is 12-13 Nov 2026: main red on J-campaigns-01 #2 #3 #6 #7 (issue #8137, culprit #8113) from 15:45 UTC,
// and #8165's run 4494 red on those steps only, inherited; the money steps among them stop every pull request.

const H_NOW = Date.parse('2026-11-13T03:00:00Z');
const PR_SHA = '2d7ee0975485a5bcd801451a0e8439bc1b10aaaf';
const verdictLog = (rows) =>
  [
    '2026-11-13T00:10:00.0000000Z ## Verdict',
    `2026-11-13T00:10:00.0000000Z Failing or missing steps: 426; outside the list or against its rules: **${rows.length}**.`,
    '2026-11-13T00:10:00.0000000Z ',
    ...rows.map((r) => `2026-11-13T00:10:00.0000000Z - ${r}`),
    '2026-11-13T00:10:00.0000000Z ',
    '2026-11-13T00:10:00.0000000Z ### Set aside by the machine: 4',
  ].join('\n');
const CAMPAIGN_ROWS = [
  'J-campaigns-01#2: failing, not in the baseline',
  'J-campaigns-01#3 (money): failing, not in the baseline',
  'J-campaigns-01#6 (money): failing, not in the baseline',
  'J-campaigns-01#7: failing, not in the baseline',
];
const judgeJobs = (red) => [
  { id: 1, name: 'Journeys (shard 1 of 32)', conclusion: 'success', steps: [] },
  {
    id: 2,
    name: 'Real-app journeys',
    conclusion: red ? 'failure' : 'success',
    steps: [{ name: 'Verdict against the list of steps not built yet', conclusion: red ? 'failure' : 'success' }],
  },
];
const heldMainRun = (id, n, created, conclusion) => ({
  id,
  run_number: n,
  head_branch: 'main',
  head_repository: { full_name: REPO },
  repository: { full_name: REPO },
  head_sha: String(id).padEnd(40, '0'),
  event: 'push',
  path: '.github/workflows/real-app-journeys.yml',
  status: 'completed',
  conclusion,
  run_attempt: 1,
  created_at: created,
});
const heldPrRun = (over = {}) => ({
  id: 43332027270,
  run_number: 4494,
  head_sha: PR_SHA,
  event: 'pull_request',
  status: 'completed',
  conclusion: 'failure',
  run_attempt: 1,
  created_at: '2026-11-12T23:49:00Z',
  ...over,
});
const heldPull = (over = {}) => ({
  number: 8165,
  state: 'open',
  draft: false,
  auto_merge: { merge_method: 'squash' },
  head: { sha: PR_SHA, repo: { full_name: REPO } },
  ...over,
});

/** main: [{ run, rows }] (newest last is fine; heldTick sorts); prs: [{ pr, run, rows, jobs? }]. */
function heldIo({ main, prs, update = 202, message, changed = new Set(), mergeable = true }) {
  const calls = { updated: [], logs: [], changedReads: [] };
  const logs = new Map();
  const jobsOf = new Map();
  for (const m of main) {
    jobsOf.set(
      m.run.id,
      judgeJobs(m.rows.length > 0).map((j) => ({ ...j, id: m.run.id * 10 + j.id })),
    );
    logs.set(m.run.id * 10 + 2, verdictLog(m.rows));
  }
  for (const p of prs) {
    jobsOf.set(
      p.run.id,
      (p.jobs ?? judgeJobs(true)).map((j) => ({ ...j, id: p.run.id * 10 + j.id })),
    );
    logs.set(p.run.id * 10 + 2, p.log ?? verdictLog(p.rows));
  }
  return {
    calls,
    io: {
      listRuns: async () => main.map((m) => m.run),
      openPulls: async () => prs.map((p) => p.pr),
      headRuns: async (sha) => prs.filter((p) => p.run.head_sha === sha).map((p) => p.run),
      jobs: async (r) => jobsOf.get(r.id),
      jobLog: async (j) => (calls.logs.push(j.id), logs.get(j.id) ?? ''),
      updateBranch: async (pr) => (calls.updated.push(pr.number), { ok: update >= 200 && update < 300, status: update, message }),
      pull: async (n) => ({ number: n, mergeable }),
      testsChangedSince: async (head, mainSha, ids) => {
        calls.changedReads.push([head, mainSha, ids]);
        if (changed instanceof Error) throw changed;
        return new Set(ids.filter((j) => changed.has(j)));
      },
    },
  };
}
const RED_MAIN = { run: heldMainRun(43288342173, 4487, '2026-11-12T19:15:47Z', 'failure'), rows: CAMPAIGN_ROWS };
const GREEN_MAIN = { run: heldMainRun(43400000000, 4600, '2026-11-13T02:00:00Z', 'success'), rows: [] };

test('rowStep reads the step of a verdict row, money or not, and nothing from an (input) row', () => {
  assert.equal(rowStep('J-campaigns-01#3 (money): failing, not in the baseline'), 'J-campaigns-01#3');
  assert.equal(rowStep('J-charts-desk-04#2: failing, not in the baseline'), 'J-charts-desk-04#2');
  assert.equal(rowStep("(input) (money): the pass history couldn't be read: x"), null);
});

test('main has lost the reds a pull request was held by: its branch is updated from main, once', async () => {
  const { io, calls } = heldIo({ main: [RED_MAIN, GREEN_MAIN], prs: [{ pr: heldPull(), run: heldPrRun(), rows: CAMPAIGN_ROWS }] });
  const lines = await heldTick({ repo: REPO, now: H_NOW, io });
  assert.deepEqual(calls.updated, [8165]);
  assert.match(
    lines[0],
    /#8165: run 4494 red only on J-campaigns-01#2, J-campaigns-01#3, J-campaigns-01#6, J-campaigns-01#7, .* 4600 is no longer red on; branch updated from main/,
  );
});

test('main still red on the steps: nothing moves', async () => {
  const stillRed = { run: heldMainRun(43337933887, 4527, '2026-11-13T00:33:00Z', 'failure'), rows: CAMPAIGN_ROWS };
  const { io, calls } = heldIo({ main: [RED_MAIN, stillRed], prs: [{ pr: heldPull(), run: heldPrRun(), rows: CAMPAIGN_ROWS }] });
  const lines = await heldTick({ repo: REPO, now: H_NOW, io });
  assert.deepEqual(calls.updated, []);
  assert.match(lines[0], /still red on main's newest run 4527/);
});

test('a pull request red on a step of its own stays red, even beside the inherited ones', async () => {
  const rows = [...CAMPAIGN_ROWS, 'J-academy-16#5 (money): failing, not in the baseline'];
  const { io, calls } = heldIo({ main: [RED_MAIN, GREEN_MAIN], prs: [{ pr: heldPull(), run: heldPrRun(), rows }] });
  const lines = await heldTick({ repo: REPO, now: H_NOW, io });
  assert.deepEqual(calls.updated, []);
  assert.match(lines[0], /its own red \(J-academy-16#5/);
});

test('a red shard, a draft, an unarmed pull request or a fork is left as it is', async () => {
  const shardRed = [{ id: 1, name: 'Journeys (shard 1 of 32)', conclusion: 'failure', steps: [] }, ...judgeJobs(true).slice(1)];
  for (const p of [
    { pr: heldPull(), run: heldPrRun(), rows: CAMPAIGN_ROWS, jobs: shardRed },
    { pr: heldPull({ draft: true }), run: heldPrRun(), rows: CAMPAIGN_ROWS },
    { pr: heldPull({ auto_merge: null }), run: heldPrRun(), rows: CAMPAIGN_ROWS },
    { pr: heldPull({ head: { sha: PR_SHA, repo: { full_name: 'someone/fork' } } }), run: heldPrRun(), rows: CAMPAIGN_ROWS },
  ]) {
    const { io, calls } = heldIo({ main: [RED_MAIN, GREEN_MAIN], prs: [p] });
    await heldTick({ repo: REPO, now: H_NOW, io });
    assert.deepEqual(calls.updated, []);
  }
});

test('bounded: a run started after main recovered (the fresh head) is never updated again', async () => {
  const fresh = heldPrRun({ id: 43400000100, run_number: 4610, created_at: '2026-11-13T02:10:00Z' });
  const { io, calls } = heldIo({ main: [RED_MAIN, GREEN_MAIN], prs: [{ pr: heldPull(), run: fresh, rows: CAMPAIGN_ROWS }] });
  const lines = await heldTick({ repo: REPO, now: H_NOW, io });
  assert.deepEqual(calls.updated, []);
  assert.match(lines[0], /started after main's newest run 4600/);
});

test("main's newest run with no readable verdict moves nothing", async () => {
  const dead = { run: heldMainRun(43400000000, 4600, '2026-11-13T02:00:00Z', 'failure'), rows: [] };
  const { io, calls } = heldIo({ main: [RED_MAIN, dead], prs: [{ pr: heldPull(), run: heldPrRun(), rows: CAMPAIGN_ROWS }] });
  // A dead run's log has no verdict summary.
  io.jobLog = async () => 'no summary here';
  const lines = await heldTick({ repo: REPO, now: H_NOW, io });
  assert.deepEqual(calls.updated, []);
  assert.match(lines.at(-1), /no readable verdict: nothing moved/);
});

test('a refused update (403) stops the pass, never retried', async () => {
  const { io, calls } = heldIo({
    main: [RED_MAIN, GREEN_MAIN],
    prs: [
      { pr: heldPull(), run: heldPrRun(), rows: CAMPAIGN_ROWS },
      {
        pr: heldPull({ number: 8152, head: { sha: 'b'.repeat(40), repo: { full_name: REPO } } }),
        run: heldPrRun({ id: 2, run_number: 4495, head_sha: 'b'.repeat(40) }),
        rows: CAMPAIGN_ROWS,
      },
    ],
  });
  io.updateBranch = async (pr) => {
    calls.updated.push(pr.number);
    throw new Error(`GitHub 403 on PUT /repos/${REPO}/pulls/${pr.number}/update-branch: stopping, not retrying`);
  };
  await assert.rejects(heldTick({ repo: REPO, now: H_NOW, io }), (e) => isRefusal(e));
  assert.deepEqual(calls.updated, [8165]);
});

test('a conflict GitHub will not update (422) is named and the pass goes on', async () => {
  const { io, calls } = heldIo({
    main: [RED_MAIN, GREEN_MAIN],
    prs: [{ pr: heldPull(), run: heldPrRun(), rows: CAMPAIGN_ROWS }],
    update: 422,
  });
  const lines = await heldTick({ repo: REPO, now: H_NOW, io });
  assert.deepEqual(calls.updated, [8165]);
  assert.match(lines[0], /GitHub did not update it \(422\)/);
});

test('heldOnly is false for a pull request whose head moved past its run', () => {
  const main = { newest: GREEN_MAIN.run, now: new Set(), before: new Set(CAMPAIGN_ROWS.map(rowStep)) };
  const r = heldOnly({
    repo: REPO,
    pr: heldPull({ head: { sha: 'c'.repeat(40), repo: { full_name: REPO } } }),
    run: heldPrRun(),
    jobs: judgeJobs(true),
    rows: CAMPAIGN_ROWS,
    main,
  });
  assert.equal(r.held, undefined);
});

// project-state#2065 d32 (a), Main trust run 43388036218 (07:45 UTC 13 Nov): twelve pull requests stayed held on
// J-copy-bots-otc-15 #1 #2, which main never had red: the test raced on pull requests and #8226 fixed it on main at
// 06:50 UTC, after their heads left main. Main changed that journey's test since, so they are main's to clear.
const OTC_ROWS = [
  "J-copy-bots-otc-15#1 (money): called unbuilt, but passed on main in run 4724, after the baseline's run 1719",
  "J-copy-bots-otc-15#2 (money): called unbuilt, but passed on main in run 4724, after the baseline's run 1719",
];

test("a red main never had, on a journey whose test main changed since the head left it: main's, so the branch is updated", async () => {
  const { io, calls } = heldIo({
    main: [RED_MAIN, GREEN_MAIN],
    prs: [{ pr: heldPull(), run: heldPrRun(), rows: OTC_ROWS }],
    changed: new Set(['J-copy-bots-otc-15']),
  });
  const lines = await heldTick({ repo: REPO, now: H_NOW, io });
  assert.deepEqual(calls.updated, [8165]);
  assert.deepEqual(calls.changedReads, [[PR_SHA, GREEN_MAIN.run.head_sha, ['J-copy-bots-otc-15']]]);
  assert.match(lines[0], /main changed the test of J-copy-bots-otc-15 since this head\); branch updated from main/);
});

test("planted: a red main never had, whose test main didn't change, or whose read fails, stays the pull request's own", async () => {
  for (const changed of [new Set(), new Set(['J-other-01']), new Error('GitHub 500 on GET')]) {
    const { io, calls } = heldIo({ main: [RED_MAIN, GREEN_MAIN], prs: [{ pr: heldPull(), run: heldPrRun(), rows: OTC_ROWS }], changed });
    const lines = await heldTick({ repo: REPO, now: H_NOW, io });
    assert.deepEqual(calls.updated, []);
    assert.match(lines[0], /its own red \(J-copy-bots-otc-15#1/);
  }
  // Mixed with a step of its own that main never had red and never changed: still its own.
  const rows = [...OTC_ROWS, 'J-academy-16#5 (money): failing, not in the baseline'];
  const { io, calls } = heldIo({
    main: [RED_MAIN, GREEN_MAIN],
    prs: [{ pr: heldPull(), run: heldPrRun(), rows }],
    changed: new Set(['J-copy-bots-otc-15']),
  });
  const lines = await heldTick({ repo: REPO, now: H_NOW, io });
  assert.deepEqual(calls.updated, []);
  assert.match(lines[0], /its own red \(J-academy-16#5/);
  // A step still red on main's newest run never moves, whatever main changed.
  const red = { run: heldMainRun(43400000000, 4600, '2026-11-13T02:00:00Z', 'failure'), rows: [OTC_ROWS[0]] };
  const still = heldIo({
    main: [RED_MAIN, red],
    prs: [{ pr: heldPull(), run: heldPrRun(), rows: OTC_ROWS }],
    changed: new Set(['J-copy-bots-otc-15']),
  });
  assert.match((await heldTick({ repo: REPO, now: H_NOW, io: still.io }))[0], /still red on main's newest run 4600/);
  assert.deepEqual(still.calls.updated, []);
});

test('a pull request the pull holds (blocked, parked, design) is left as it is, as #8157 (parked) should have been', async () => {
  for (const name of ['blocked', 'parked', 'design']) {
    const { io, calls } = heldIo({
      main: [RED_MAIN, GREEN_MAIN],
      prs: [{ pr: heldPull({ labels: [{ name }] }), run: heldPrRun(), rows: CAMPAIGN_ROWS }],
    });
    const lines = await heldTick({ repo: REPO, now: H_NOW, io });
    assert.deepEqual(calls.updated, []);
    assert.equal(lines[0], `#8165: labelled ${name}, left as it is`);
  }
});

test('a pull request that conflicts with main is not sent to GitHub, and a 422 says why', async () => {
  const conflict = heldIo({
    main: [RED_MAIN, GREEN_MAIN],
    prs: [{ pr: heldPull(), run: heldPrRun(), rows: CAMPAIGN_ROWS }],
    mergeable: false,
  });
  assert.match(
    (await heldTick({ repo: REPO, now: H_NOW, io: conflict.io }))[0],
    /it conflicts with main, so GitHub can't update it: its builder merges main/,
  );
  assert.deepEqual(conflict.calls.updated, []);
  const said = heldIo({
    main: [RED_MAIN, GREEN_MAIN],
    prs: [{ pr: heldPull(), run: heldPrRun(), rows: CAMPAIGN_ROWS }],
    update: 422,
    message: 'merge conflict between base and head',
  });
  assert.match((await heldTick({ repo: REPO, now: H_NOW, io: said.io }))[0], /it conflicts with main, so GitHub did not update it \(422\)/);
  const moved = heldIo({
    main: [RED_MAIN, GREEN_MAIN],
    prs: [{ pr: heldPull(), run: heldPrRun(), rows: CAMPAIGN_ROWS }],
    update: 422,
    message: 'expected head sha didn’t match current head ref.',
  });
  assert.match((await heldTick({ repo: REPO, now: H_NOW, io: moved.io }))[0], /its head moved since it was read \(422\)/);
});
