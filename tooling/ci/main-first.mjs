#!/usr/bin/env node
/**
 * MAIN FIRST (real-app-journeys.yml, the `touch` job's step `Main's journeys first`; INTAFACED/project-state#1574 item
 * 3): a Real-app journeys run on a branch or pull request waits, before it plans or builds anything, while a run on main
 * still has jobs waiting for a runner or has not yet planned its shards, so main's shards take the runners first. It never fails and never touches a main run: it
 * reads, waits at most MAX_WAIT_MS, then lets the run go on, whatever it read (an unreadable API lets it go on at once).
 *
 *   node tooling/ci/main-first.mjs --self-test
 *   GH_TOKEN=... REPO=owner/name node tooling/ci/main-first.mjs
 *
 * Why (read with `gh api` at 02:49 UTC on 9 Nov 2026): main's run 42542683115 (head 125a1de) was created at 00:54:16
 * and waited in `real-app-journeys-main` behind abb79bc's run until 01:46:09 (one main run at a time, OWNER 206, by
 * design); then its first job waited 7 minutes for a runner (created 01:46:09, started 01:53:27) and its 44 shards,
 * created at 02:03:31, started from 02:26:05 to 02:45:51, 23 to 42 minutes later, while about 100 jobs ran at once and
 * 18 Real-app journeys runs were queued. Runners go to the jobs queued first, so a branch's shards queued before main's
 * took them. GitHub has no job priority; holding branch runs back while main's jobs wait is the lever there is. Its
 * cost: each waiting branch run keeps the one runner its `touch` job already holds, where the run would have queued its
 * planner, its build and up to 48 shards; it adds no job, so a branch run queues no more often than before.
 * A run waiting in main's concurrency group reads `pending` (run 42554292414 at 03:13 UTC), not `queued`; a run whose
 * only unstarted job is waiting for a runner reads `queued` (42542683115, its scoreboard job, at 03:13 UTC); and a job
 * waiting on `needs` is not listed until it is created (42542683115's jobs at 02:49 UTC listed no scoreboard job).
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const WORKFLOW = 'real-app-journeys.yml';
export const POLL_MS = 60_000;
export const MAX_WAIT_MS = 30 * 60_000;
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

async function get(repo, path, token) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 403 || res.status === 429) throw new Error(`GitHub ${res.status} on ${path}: stopping, not retrying`);
  if (res.status !== 200) throw new Error(`GitHub ${res.status} on ${path}`);
  return res.json();
}

/** Waits while mainWaiting says so, up to `maxMs`; always resolves. Returns what it did, for the log. */
export async function waitForMain({ read, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, maxMs = MAX_WAIT_MS }) {
  const start = Date.now();
  for (let waited = 0; ; waited = Date.now() - start) {
    let why;
    try {
      why = await read();
    } catch (e) {
      return `main's runs could not be read (${e.message}); going on`;
    }
    if (!why)
      return waited
        ? `main's runs have their runners after ${Math.round(waited / 60_000)} min; going on`
        : 'no main run is waiting for runners; going on';
    if (waited + POLL_MS > maxMs) return `${why} after ${Math.round(waited / 60_000)} min, the most this waits; going on`;
    log(`${why}; this run waits so main's journeys take the runners first, checking again in ${POLL_MS / 1000}s`);
    await sleep(POLL_MS);
  }
}

async function selfTest() {
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
  let bad = 0;
  for (const [runs, want] of cases) {
    const got = await mainWaiting(runs, jobsOf);
    if (want === null ? got !== null : !want.test(got ?? '')) {
      bad++;
      console.error('main-first self-test failed for', JSON.stringify(runs), '→', got);
    }
  }
  // The wait: bounded, goes on when main has its runners, and goes on at once when GitHub can't be read.
  const clock = { t: 0 };
  const realNow = Date.now;
  Date.now = () => clock.t;
  try {
    const sleep = async (ms) => void (clock.t += ms);
    const log = () => {};
    const always = await waitForMain({ read: async () => 'waiting', sleep, log });
    if (!/the most this waits/.test(always) || clock.t > MAX_WAIT_MS) (bad++, console.error('unbounded wait:', always, clock.t));
    clock.t = 0;
    let n = 0;
    const thrice = await waitForMain({ read: async () => (++n <= 3 ? 'waiting' : null), sleep, log });
    if (!/after 3 min/.test(thrice)) (bad++, console.error('did not go on when main had its runners:', thrice));
    clock.t = 0;
    const broken = await waitForMain({
      read: async () => {
        throw new Error('HTTP 502');
      },
      sleep,
      log,
    });
    if (!/could not be read/.test(broken) || clock.t !== 0) (bad++, console.error('waited on an unreadable API:', broken));
  } finally {
    Date.now = realNow;
  }
  if (bad) process.exit(1);
  console.log('main-first self-test ok');
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const { GH_TOKEN, REPO } = process.env;
  if (!GH_TOKEN || !REPO) return console.log('::notice::main-first has no GH_TOKEN or REPO; going on');
  const read = async () => {
    const lists = await Promise.all(
      ['queued', 'in_progress'].map((s) => get(REPO, `/actions/workflows/${WORKFLOW}/runs?branch=main&status=${s}&per_page=20`, GH_TOKEN)),
    );
    const runs = lists.flatMap((l) => l?.workflow_runs ?? []);
    return mainWaiting(runs, async (id) => (await get(REPO, `/actions/runs/${id}/jobs?filter=latest&per_page=100`, GH_TOKEN))?.jobs);
  };
  console.log(await waitForMain({ read }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main().catch((e) => console.log(`::notice::main-first stopped reading (${e.message}); going on`));
