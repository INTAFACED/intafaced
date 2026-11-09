#!/usr/bin/env node
/**
 * MAIN FIRST (real-app-journeys.yml, the `touch` job's step `Main's journeys first`; INTAFACED/project-state#1574 item
 * 3): a Real-app journeys run on a branch or pull request that finds a run on main still waiting for runners (jobs
 * queued, or its shards not yet planned) is DEFERRED: its touch job ends at once and the run runs nothing, so it holds
 * no runner and queues no shard ahead of main's. Main's run, once its shards are queued (its `Let deferred runs go`
 * job, `--release`), re-runs the newest deferred run of each branch, whose jobs then queue behind main's. It never gives
 * up on main (a deferred run starts only when main's shards are queued), never waits on a runner, never fails a run and
 * never touches a main run; an unreadable API lets the run go on at once. A hand-dispatched full run off main
 * (DISPATCH_FULL) is also deferred while DISPATCH_CAP other hand-dispatched full runs run, and each of those, when it
 * ends, lets the deferred ones go too.
 *
 *   node tooling/ci/main-first.mjs --self-test
 *   GH_TOKEN=... REPO=owner/name [DISPATCH_FULL=true RUN_ID=…] node tooling/ci/main-first.mjs   (writes deferred=true|false)
 *   GH_TOKEN=... REPO=owner/name node tooling/ci/main-first.mjs --release                          (re-runs deferred runs)
 *
 * Why it never gives up (project-state#1906, the guide's round 2, 9 Nov 2026): with a 30-minute limit, branch runs went
 * on while main waited, so at 09:33 UTC main's run 2866 had been queued since 08:34 behind 13 hand-dispatched full runs
 * and 11 pull request runs. Why it holds no runner (the guide's CI audit, 10:55 UTC on 9 Nov): a waiting step kept one
 * runner busy on every run off main, 13 such runs at 10:47 UTC. Why the cap: the 09:33 queue held 13 hand-dispatched
 * full runs, 45 shards each.
 * Why main first (read with `gh api` at 02:49 UTC on 9 Nov 2026): main's run 42542683115 (head 125a1de) was created at 00:54:16
 * and waited in `real-app-journeys-main` behind abb79bc's run until 01:46:09 (one main run at a time, OWNER 206, by
 * design); then its first job waited 7 minutes for a runner (created 01:46:09, started 01:53:27) and its 44 shards,
 * created at 02:03:31, started from 02:26:05 to 02:45:51, 23 to 42 minutes later, while about 100 jobs ran at once and
 * 18 Real-app journeys runs were queued. Runners go to the jobs queued first, so a branch's shards queued before main's
 * took them. GitHub has no job priority; deferring branch runs while main's jobs wait, and re-running them after, is
 * the lever there is. Its cost: a deferred run's touch job runs twice (seconds each) and its result comes later.
 * A run waiting in main's concurrency group reads `pending` (run 42554292414 at 03:13 UTC), not `queued`; a run whose
 * only unstarted job is waiting for a runner reads `queued` (42542683115, its scoreboard job, at 03:13 UTC); and a job
 * waiting on `needs` is not listed until it is created (42542683115's jobs at 02:49 UTC listed no scoreboard job).
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const WORKFLOW = 'real-app-journeys.yml';
/** The touch job's step that marks a deferred run (real-app-journeys.yml; workflow-concurrency.test.mjs holds the
 *  name), so `--release` can find it in the jobs API. */
export const DEFER_MARK = "Deferred: main's journeys or the cap come first";
/** A deferred run older than this is not re-run: its branch has moved on, or a person re-runs it. */
export const RELEASE_WINDOW_MS = 6 * 3600_000;
/** The most runs one release re-runs, so one call can't flood the queue. */
export const RELEASE_MAX = 40;
/** The most hand-dispatched full runs off main that hold runners at once. */
export const DISPATCH_CAP = 2;
/** The touch job's step that marks a hand-dispatched full run (real-app-journeys.yml; workflow-concurrency.test.mjs holds
 *  the name), so another run can tell it from a targeted one in the jobs API. */
export const DISPATCH_MARK = 'A hand-dispatched full run';
/** real-app-journeys.yml's first job, which runs this wait. */
export const TOUCH_JOB = 'What this run runs';
/** A job GitHub has created but not yet given a runner. */
const WAITING = new Set(['queued', 'waiting', 'pending', 'requested']);
/** real-app-journeys.yml's planner job: until it finishes, a main run has not queued its shards (workflow-concurrency.test.mjs
 *  holds the name). */
export const PLAN_JOB = 'Plan the shards';

/**
 * Why a main run is still waiting for runners, or null when none is. `runs` are WORKFLOW's runs on main not completed;
 * `jobsOf(id)` gives one run's latest jobs. A run waiting in its concurrency group (`pending`, behind the running main
 * run) needs no runner yet, so it holds nothing back. A run `queued`, or in progress with a job waiting for a runner
 * or its planner not finished (its shards are queued when the planner ends), is still taking runners. A run whose jobs
 * can't be read is passed over. Pure apart from `jobsOf`, so the self-test runs offline.
 */
export async function mainWaiting(runs, jobsOf) {
  for (const run of runs ?? []) {
    if (run?.head_branch !== 'main' || run?.event === 'pull_request') continue;
    if (run.status === 'queued') return `main's run ${run.id} is queued for a runner`;
    if (run.status !== 'in_progress') continue;
    const jobs = await jobsOf(run.id);
    if (!Array.isArray(jobs)) continue;
    const waiting = jobs.filter((j) => WAITING.has(j?.status));
    if (waiting.length) return `main's run ${run.id} has ${waiting.length} job(s) waiting for a runner`;
    if (!jobs.some((j) => j?.name === PLAN_JOB && j?.status === 'completed')) return `main's run ${run.id} has not queued its shards yet`;
  }
  return null;
}

/**
 * Why a hand-dispatched full run must wait for the cap, or null. `runs` are WORKFLOW's in-progress workflow_dispatch runs;
 * `self` this run's id. A run counts when it is off main, is not this one, its touch job marked it a full run
 * (DISPATCH_MARK succeeded), that job finished, and it was not deferred (DEFER_MARK did not run), so its shards hold
 * runners or soon will. A deferred run is completed, so it is not in progress and never counts.
 */
export async function dispatchBusy(runs, jobsOf, self) {
  let busy = 0;
  for (const run of runs ?? []) {
    if (run?.event !== 'workflow_dispatch' || run?.head_branch === 'main' || String(run?.id) === String(self)) continue;
    if (run.status !== 'in_progress') continue;
    const jobs = await jobsOf(run.id);
    const touch = Array.isArray(jobs) ? jobs.find((j) => j?.name === TOUCH_JOB) : null;
    if (touch?.status !== 'completed') continue;
    const ran = (name) => (touch.steps ?? []).some((st) => st?.name === name && st?.conclusion === 'success');
    if (ran(DISPATCH_MARK) && !ran(DEFER_MARK)) busy++;
  }
  return busy >= DISPATCH_CAP ? `${busy} hand-dispatched full runs already hold their runners (at most ${DISPATCH_CAP} at once)` : null;
}

/**
 * The deferred runs to re-run: `runs` are WORKFLOW's recent runs, any status; `jobsOf(id)` gives one run's latest jobs.
 * Per branch and event, only the newest run counts (an older one is superseded, and re-running it would cancel the newer
 * in their concurrency group); it is re-run when it is completed, off main, created within RELEASE_WINDOW_MS of `now`,
 * and its touch job marked it deferred. Pure apart from `jobsOf`. Returns ids, oldest first, at most RELEASE_MAX.
 */
export async function toRelease(runs, jobsOf, now = Date.now()) {
  const newest = new Map();
  for (const r of runs ?? []) {
    if (!r || r.head_branch === 'main' || !['pull_request', 'workflow_dispatch'].includes(r.event)) continue;
    const key = `${r.event}:${r.head_branch}`;
    const had = newest.get(key);
    if (!had || Date.parse(r.created_at) > Date.parse(had.created_at)) newest.set(key, r);
  }
  const out = [];
  for (const r of [...newest.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    if (r.status !== 'completed' || now - Date.parse(r.created_at) > RELEASE_WINDOW_MS) continue;
    const jobs = await jobsOf(r.id);
    const touch = Array.isArray(jobs) ? jobs.find((j) => j?.name === TOUCH_JOB) : null;
    if ((touch?.steps ?? []).some((st) => st?.name === DEFER_MARK && st?.conclusion === 'success')) out.push(r.id);
    if (out.length >= RELEASE_MAX) break;
  }
  return out;
}

async function api(repo, path, token, method = 'GET') {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 403 || res.status === 429) throw new Error(`GitHub ${res.status} on ${path}: stopping, not retrying`);
  if (method !== 'GET') return res.status;
  if (res.status !== 200) throw new Error(`GitHub ${res.status} on ${path}`);
  return res.json();
}
const get = (repo, path, token) => api(repo, path, token);

/** Whether this run is deferred, once: { defer, why }. Never throws; an unreadable API lets the run go on. */
/**
 * Why this run defers, or null. `main()` is why main is waiting (mainWaiting), `cap()` why the dispatch cap is full
 * (dispatchBusy), or null when this is not a hand-dispatched full run. A re-run (`attempt` past 1) is one the release let
 * go once main's shards were queued, and main's shards are then exactly the jobs still waiting, so it doesn't wait for
 * main again (it would defer every time, and nothing would release it until the next main run). The cap still holds.
 */
export async function deferWhy({ attempt = 1, main, cap = null }) {
  const why = Number(attempt) > 1 ? null : await main();
  return why || (cap ? await cap() : null);
}

export async function decide(read) {
  try {
    const why = await read();
    return why ? { defer: true, why } : { defer: false, why: 'no main run is waiting for runners and the cap has room' };
  } catch (e) {
    return { defer: false, why: `main's runs could not be read (${e.message}); going on` };
  }
}

async function selfTest() {
  let bad = 0;
  const fail = (...m) => (bad++, console.error('main-first self-test failed:', ...m));
  const jobs = {
    1: [{ name: 'What this run runs', status: 'queued' }],
    2: [
      { name: 'What this run runs', status: 'completed', conclusion: 'success' },
      { name: 'Plan the shards', status: 'in_progress' },
    ],
    3: [
      { name: 'Plan the shards', status: 'completed', conclusion: 'success' },
      { name: 'Journeys (shard 1 of 2)', status: 'in_progress' },
      { name: 'Journeys (shard 2 of 2)', status: 'queued' },
    ],
    4: [
      { name: 'Plan the shards', status: 'completed', conclusion: 'success' },
      { name: 'Journeys (shard 1 of 2)', status: 'in_progress' },
      { name: 'Journeys (shard 2 of 2)', status: 'in_progress' },
    ],
    5: [{ name: 'Plan the shards', status: 'completed', conclusion: 'failure' }],
    6: [{ name: 'What this run runs', status: 'in_progress' }],
    7: [{ name: 'Plan the shards', status: 'completed', conclusion: 'success' }], // shards skipped after the plan
  };
  const jobsOf = async (id) => jobs[id];
  const run = (id, status, over = {}) => ({ id, status, head_branch: 'main', event: 'push', ...over });
  const cases = [
    [[run(1, 'in_progress')], /1 job\(s\) waiting/],
    [[run(2, 'in_progress')], /not queued its shards/],
    [[run(3, 'in_progress')], /1 job\(s\) waiting/],
    [[run(4, 'in_progress')], null],
    [[run(5, 'in_progress')], null], // a failed plan queues no shards
    [[run(6, 'in_progress')], /not queued its shards/], // still deciding what it runs
    [[run(7, 'in_progress')], null],
    [[run(8, 'in_progress'), run(1, 'in_progress')], /run 1 has 1 job/], // run 8's jobs can't be read: passed over
    [[run(9, 'queued')], /queued for a runner/],
    [[run(9, 'pending')], null], // waiting behind the running main run in its group: no runner asked for
    [[run(1, 'in_progress', { head_branch: 'feature' })], null],
    [[run(1, 'in_progress', { event: 'pull_request' })], null], // a pull request from a branch named main
    [[run(4, 'in_progress'), run(1, 'in_progress')], /run 1 has 1 job/],
    [[], null],
  ];
  for (const [runs, want] of cases) {
    const got = await mainWaiting(runs, jobsOf);
    if (want === null ? got !== null : !want.test(got ?? '')) fail(JSON.stringify(runs), '→', got);
  }
  // The cap: two running, marked full dispatch runs make a third wait; a deferred, targeted, main or own run doesn't count.
  const touch = (status, marked, deferred = false) => [
    {
      name: TOUCH_JOB,
      status,
      steps: [
        { name: DISPATCH_MARK, conclusion: marked ? 'success' : 'skipped' },
        { name: DEFER_MARK, conclusion: deferred ? 'success' : 'skipped' },
      ],
    },
  ];
  const djobs = {
    11: touch('completed', true),
    12: touch('completed', true),
    13: touch('in_progress', true),
    14: touch('completed', false),
    16: touch('completed', true, true),
  };
  const dOf = async (id) => djobs[id];
  const d = (id, over = {}) => ({ id, status: 'in_progress', event: 'workflow_dispatch', head_branch: `b${id}`, ...over });
  const capCases = [
    [[d(11), d(12)], 99, /2 hand-dispatched full runs/],
    [[d(11), d(12)], 12, null], // itself doesn't count
    [[d(11), d(13)], 99, null], // 13 is still deciding in its own touch job
    [[d(11), d(14)], 99, null], // 14 is a targeted run
    [[d(11), d(16)], 99, null], // 16 was deferred
    [[d(11), d(12, { head_branch: 'main' })], 99, null], // main's runs never count against branches
    [[d(11), d(12, { event: 'pull_request' })], 99, null],
    [[d(11), d(12, { status: 'completed' })], 99, null],
    [[d(11), d(12), d(15)], 99, /2 hand-dispatched/], // 15's jobs can't be read: passed over
  ];
  for (const [runs, self, want] of capCases) {
    const got = await dispatchBusy(runs, dOf, self);
    if (want === null ? got !== null : !want.test(got ?? '')) fail('cap', JSON.stringify(runs), self, '→', got);
  }
  // The decision: defers while main waits, goes on when it doesn't, and goes on at once when GitHub can't be read. It
  // never waits: it reads once.
  let reads = 0;
  const waiting = await decide(async () => (reads++, "main's run 1 is queued for a runner"));
  if (!waiting.defer || reads !== 1) fail('did not defer while main waits, or read more than once', waiting, reads);
  if ((await decide(async () => null)).defer) fail('deferred with main not waiting');
  const broken = await decide(async () => {
    throw new Error('HTTP 502');
  });
  if (broken.defer || !/could not be read/.test(broken.why)) fail('deferred on an unreadable API', broken);
  // A re-run the release let go doesn't wait for main's queued shards again; the cap still holds, and a first attempt waits.
  let mainRead = 0;
  const mainBusy = async () => (mainRead++, "main's run 1 has 44 job(s) waiting for a runner");
  if ((await deferWhy({ attempt: '2', main: mainBusy })) !== null || mainRead) fail('a released re-run deferred for main again');
  if (!(await deferWhy({ attempt: '2', main: mainBusy, cap: async () => 'the cap is full' }))) fail('a released dispatch skipped the cap');
  if (!(await deferWhy({ attempt: '1', main: mainBusy }))) fail("a first attempt didn't wait for main");
  if (await deferWhy({ attempt: '1', main: async () => null })) fail('deferred with nothing waiting');
  // The release: the newest deferred run per branch and event, completed, recent; never main, never a superseded one.
  const now = Date.parse('2026-11-09T11:00:00Z');
  const at = (m) => new Date(now - m * 60_000).toISOString();
  const r = (id, branch, mins, over = {}) => ({
    id,
    head_branch: branch,
    event: 'pull_request',
    status: 'completed',
    created_at: at(mins),
    ...over,
  });
  const rjobs = {
    21: touch('completed', false, true),
    22: touch('completed', false, true),
    23: touch('completed', false, false),
    24: touch('completed', false, true),
    25: touch('completed', false, true),
    26: touch('completed', false, true),
    27: touch('completed', false, true),
  };
  const rOf = async (id) => rjobs[id];
  const runs = [
    r(21, 'a', 30), // deferred, newest on a: released
    r(22, 'b', 40), // deferred but superseded by 28 on b: not released
    r(28, 'b', 10, { status: 'queued' }),
    r(23, 'c', 20), // ran normally: not released
    r(24, 'main', 20, { event: 'push' }), // main: never
    r(25, 'd', 8 * 60), // older than the window: not released
    r(26, 'e', 15, { event: 'workflow_dispatch' }), // a deferred dispatch: released
    r(27, 'a', 50, { event: 'workflow_dispatch' }), // a's dispatch, its own newest: released
  ];
  const got = await toRelease(runs, rOf, now);
  if (JSON.stringify(got) !== JSON.stringify([27, 21, 26])) fail('release picked', got);
  if (bad) process.exit(1);
  console.log('main-first self-test ok');
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const { GH_TOKEN, REPO, DISPATCH_FULL, RUN_ID, RUN_ATTEMPT, GITHUB_OUTPUT } = process.env;
  if (!GH_TOKEN || !REPO) return console.log('::notice::main-first has no GH_TOKEN or REPO; going on');
  const jobsOf = async (id) => (await get(REPO, `/actions/runs/${id}/jobs?filter=latest&per_page=100`, GH_TOKEN))?.jobs;
  if (process.argv.includes('--release')) {
    const list = await get(REPO, `/actions/workflows/${WORKFLOW}/runs?per_page=100`, GH_TOKEN);
    const ids = await toRelease(list?.workflow_runs, jobsOf);
    for (const id of ids) console.log(`re-run deferred run ${id}: HTTP ${await api(REPO, `/actions/runs/${id}/rerun`, GH_TOKEN, 'POST')}`);
    return console.log(`${ids.length} deferred run(s) let go`);
  }
  const read = () =>
    deferWhy({
      attempt: RUN_ATTEMPT,
      main: async () => {
        const lists = await Promise.all(
          ['queued', 'in_progress'].map((s) =>
            get(REPO, `/actions/workflows/${WORKFLOW}/runs?branch=main&status=${s}&per_page=20`, GH_TOKEN),
          ),
        );
        return mainWaiting(
          lists.flatMap((l) => l?.workflow_runs ?? []),
          jobsOf,
        );
      },
      cap:
        DISPATCH_FULL === 'true'
          ? async () => {
              const dispatched = await get(
                REPO,
                `/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&status=in_progress&per_page=50`,
                GH_TOKEN,
              );
              return dispatchBusy(dispatched?.workflow_runs, jobsOf, RUN_ID);
            }
          : null,
    });
  const { defer, why } = await decide(read);
  console.log(defer ? `::notice::deferred: ${why}; this run runs nothing now, and is re-run when main's shards are queued` : why);
  if (GITHUB_OUTPUT) (await import('node:fs')).appendFileSync(GITHUB_OUTPUT, `deferred=${defer}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main().catch((e) => console.log(`::notice::main-first stopped reading (${e.message}); going on`));
