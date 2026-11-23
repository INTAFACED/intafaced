// Reads the bar of project-state#3917 (#3676 row 8) from GitHub: over the newest 20 successful pull request runs of
// Real-app journeys that took 5 minutes or more, the median run takes 17 minutes or less, from its creation to its end,
// and no run has a shard job over 1.3 times its median shard job. Read from the runs' own job timings, not a report.
//
// Usage: node tooling/scripts/journey-shard-balance.mjs [--runs 20] [--repo INTAFACED/intafaced]
// Prints one line a run and the verdict; exits 1 when the bar does not hold, 0 when it does.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BAR = { runs: 20, minRunMinutes: 5, medianRunMinutes: 17, shardRatio: 1.3 };
const SHARD_JOB = /^Journeys \(shard \d+ of \d+\)$/;

const minutes = (from, to) => (Date.parse(to) - Date.parse(from)) / 60_000;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/**
 * One run's reading from its jobs: its time, created to updated, and its longest shard job against its median shard
 * job. Skipped shard jobs and jobs that never started count for nothing. Pure, for the tests.
 */
export function readRun(run, jobs) {
  const shards = jobs
    .filter((j) => SHARD_JOB.test(j.name) && j.started_at && j.completed_at && j.conclusion !== 'skipped')
    .map((j) => ({ name: j.name, minutes: minutes(j.started_at, j.completed_at) }));
  const mid = median(shards.map((s) => s.minutes));
  const longest = shards.reduce((a, s) => (s.minutes > (a?.minutes ?? -1) ? s : a), null);
  return {
    id: run.databaseId,
    runMinutes: minutes(run.createdAt, run.updatedAt),
    shards: shards.length,
    medianShard: mid,
    longest,
    ratio: mid > 0 && longest ? longest.minutes / mid : 0,
  };
}

/** The bar over the readings, newest first: the runs it counts, their median time and the runs over the shard ratio. */
export function verdict(readings, bar = BAR) {
  const counted = readings.filter((r) => r.runMinutes >= bar.minRunMinutes).slice(0, bar.runs);
  const medianRun = median(counted.map((r) => r.runMinutes));
  const over = counted.filter((r) => r.ratio > bar.shardRatio);
  const holds = counted.length >= bar.runs && medianRun <= bar.medianRunMinutes && over.length === 0;
  return { counted, medianRun, over, holds };
}

function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const repo = opt('--repo', 'INTAFACED/intafaced');
  const want = Number(opt('--runs', BAR.runs));
  const runs = gh([
    'run',
    'list',
    '--repo',
    repo,
    '--workflow',
    'real-app-journeys.yml',
    '--event',
    'pull_request',
    '--status',
    'success',
    '--limit',
    '200',
    '--json',
    'databaseId,createdAt,updatedAt',
  ]);
  const readings = [];
  for (const run of runs) {
    if (minutes(run.createdAt, run.updatedAt) < BAR.minRunMinutes) continue;
    const { jobs } = gh(['api', `repos/${repo}/actions/runs/${run.databaseId}/jobs?per_page=100`]);
    readings.push(readRun(run, jobs));
    if (readings.length >= want) break;
  }
  const v = verdict(readings, { ...BAR, runs: want });
  for (const r of v.counted)
    console.log(
      `run ${r.id}: ${r.runMinutes.toFixed(1)} min, ${r.shards} shards, median shard ${r.medianShard.toFixed(1)}, longest ${r.longest ? `${r.longest.minutes.toFixed(1)} (${r.longest.name})` : 'none'}, ${r.ratio.toFixed(2)}x${r.ratio > BAR.shardRatio ? ' OVER' : ''}`,
    );
  console.log(
    `${v.counted.length} runs, ${v.counted.at(-1) ? `created ${runs.find((r) => r.databaseId === v.counted.at(-1).id).createdAt} to ${runs.find((r) => r.databaseId === v.counted[0].id).createdAt}` : 'none'}: median ${v.medianRun.toFixed(1)} min (bar ${BAR.medianRunMinutes}), ${v.over.length} over ${BAR.shardRatio}x (bar 0): ${v.holds ? 'HOLDS' : 'DOES NOT HOLD'}`,
  );
  process.exit(v.holds ? 0 : 1);
}
