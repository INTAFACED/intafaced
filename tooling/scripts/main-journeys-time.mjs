#!/usr/bin/env node
// How long main's Real-app journeys runs wait and boot, read from GitHub's own run and job times.
//
// Usage: node tooling/scripts/main-journeys-time.mjs [--hours 24] [--since <ISO time>] [--json]
// Reads every run of real-app-journeys.yml on main (push, schedule, manual) created in the window, with its jobs, and
// prints, each as a median and a 90th percentile:
//   wait (run)   created -> first job started, over finished runs that ran and were not cancelled (the measure of
//                project-state #2065 row d37 and the 12 Nov garden's facts/G-tests.md section 1);
//   wait (push)  each run's created time -> the first job of the first run created at or after it that ran. Main keeps one
//                run waiting and a newer push replaces it (real-app-journeys.yml, concurrency), so a replaced push's
//                commits report through that later run; this is how long a merge really waits for its first job;
//   boot         on each run's last shard to end, the steps that start the stack and make it trade (BOOT_STEPS);
//   wall         created -> last job ended.
// Read only: it calls `gh api` and writes nothing.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const WORKFLOW = 'real-app-journeys.yml';
/** A shard's steps that boot the stack, by the start of their names in real-app-journeys.yml. */
export const BOOT_STEPS = [
  'Start the local test stack',
  'Open the TEST markets',
  'Load the TEST content',
  'Wait for the first BTC/USDT trade',
];

const minutes = (a, b) => (Date.parse(b) - Date.parse(a)) / 60_000;

/** The value at fraction `p` of the sorted values (nearest rank below), or null for none. */
export function quantile(values, p) {
  const xs = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const k = (xs.length - 1) * p;
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, xs.length - 1);
  return Math.round((xs[lo] + (xs[hi] - xs[lo]) * (k - lo)) * 10) / 10;
}

/** One run's times from its jobs: null fields when it ran no job (a replaced run). */
export function runTimes(run, jobs) {
  const started = jobs.filter((j) => j.started_at && j.status !== 'queued');
  const row = { id: run.id, number: run.run_number, created: run.created_at, status: run.status, conclusion: run.conclusion };
  if (started.length === 0) return { ...row, ran: false, firstJob: null, boot: null, wall: null };
  const firstJob = started.map((j) => j.started_at).sort()[0];
  const ended = started
    .filter((j) => j.completed_at)
    .map((j) => j.completed_at)
    .sort();
  const shards = started.filter((j) => j.name.startsWith('Journeys') && j.completed_at);
  const last = shards.sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at))[0];
  const boot = last
    ? last.steps
        .filter((s) => BOOT_STEPS.some((b) => s.name.startsWith(b)) && s.started_at && s.completed_at)
        .reduce((t, s) => t + minutes(s.started_at, s.completed_at), 0)
    : null;
  return {
    ...row,
    ran: true,
    firstJob,
    wait: minutes(run.created_at, firstJob),
    boot,
    wall: ended.length ? minutes(run.created_at, ended.at(-1)) : null,
  };
}

/** For each run, minutes from its creation to the first job of the first run created at or after it that ran. */
export function pushWaits(rows) {
  const byTime = [...rows].sort((a, b) => a.created.localeCompare(b.created));
  const out = [];
  for (const [i, r] of byTime.entries()) {
    const next = byTime.slice(i).find((x) => x.ran);
    if (next) out.push(minutes(r.created, next.firstJob));
  }
  return out;
}

export function summarise(rows) {
  const finished = rows.filter((r) => r.ran && r.status === 'completed' && r.conclusion !== 'cancelled');
  const push = pushWaits(rows);
  const pair = (xs) => ({ median: quantile(xs, 0.5), p90: quantile(xs, 0.9), n: xs.filter(Number.isFinite).length });
  return {
    runs: rows.length,
    replaced: rows.filter((r) => !r.ran).length,
    finished: finished.length,
    waitRun: pair(finished.map((r) => r.wait)),
    waitPush: pair(push),
    boot: pair(finished.map((r) => r.boot).filter((x) => x != null)),
    wall: pair(finished.map((r) => r.wall).filter((x) => x != null)),
  };
}

function gh(route) {
  return JSON.parse(execFileSync('gh', ['api', route], { encoding: 'utf8', maxBuffer: 1 << 30 }));
}

function repo() {
  return process.env.GITHUB_REPOSITORY || gh('repos/{owner}/{repo}').full_name;
}

async function main(argv) {
  let hours = 24;
  let since = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--hours') hours = Number(argv[++i]);
    else if (argv[i] === '--since') since = argv[++i];
    else if (argv[i] !== '--json') throw new Error(`unexpected argument ${argv[i]}`);
  }
  const from = since ?? new Date(Date.now() - hours * 3_600_000).toISOString();
  const r = repo();
  const runs = [];
  for (let page = 1; ; page += 1) {
    const got = gh(`repos/${r}/actions/workflows/${WORKFLOW}/runs?branch=main&per_page=100&page=${page}&created=%3E%3D${from}`);
    runs.push(...got.workflow_runs.filter((x) => x.head_branch === 'main' && x.event !== 'pull_request'));
    if (got.workflow_runs.length < 100) break;
  }
  const rows = [];
  for (const run of runs) {
    const jobs = [];
    for (let page = 1; ; page += 1) {
      const got = gh(`repos/${r}/actions/runs/${run.id}/attempts/1/jobs?per_page=100&page=${page}`).jobs;
      jobs.push(...got);
      if (got.length < 100) break;
    }
    rows.push(runTimes(run, jobs));
  }
  const s = summarise(rows);
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ from, ...s, rows }, null, 1));
    return;
  }
  console.log(
    `main's ${WORKFLOW} runs created since ${from}: ${s.runs} (${s.replaced} replaced before any job, ${s.finished} finished and not cancelled)`,
  );
  for (const [k, label] of [
    ['waitRun', 'wait (run created -> first job)'],
    ['waitPush', 'wait (push -> first job of the run holding it)'],
    ['boot', 'boot (last shard to end)'],
    ['wall', 'wall (created -> last job ended)'],
  ])
    console.log(`  ${label}: median ${s[k].median} min, p90 ${s[k].p90} min, n ${s[k].n}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
