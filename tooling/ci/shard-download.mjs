#!/usr/bin/env node
/**
 * The journeys run's shard reports, downloaded for the merge (real-app-journeys.yml, "Merge the shards").
 *
 * Why: run 4084 (43127556856, 12 Nov 2026) asked for its 32 shard artifacts while the workflow token's hourly API budget
 * was spent. `gh run download` answered "HTTP 403: API rate limit exceeded for installation", the step swallowed it, the
 * run saved a report artifact with no report.json, and every pull request's verdict then failed on that run.
 *
 * A primary rate limit is not a refusal: it says when it resets. So this waits for the reset GitHub names
 * (`gh api rate_limit`, which itself spends no budget) and asks once more, at most MAX_WAITS times, never past the job's
 * time limit. Any other refusal (a 401 or a 403 that is not a rate limit, a secondary limit or a 429) is never retried:
 * it fails the step. Any other failure (a dropped connection, a 5xx) is tried again after a pause. When the downloads
 * still fail, the step fails by name, so the run is red for a reason it states, never for "32 of 32 shards sent no report".
 * A run with no shard artifact at all (no shard started) is not a failure here: the next step names the missing shards.
 *
 * It also prints the token's core budget (limit, used, remaining, reset) before and after, never the token: the measure of
 * how many runs at once the budget carries.
 *
 *   node tooling/ci/shard-download.mjs <dir>   (GH_TOKEN, GITHUB_RUN_ID, GITHUB_REPOSITORY)
 * Its tests: tooling/ci/shard-download.test.mjs.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { missingArtifact } from './journey-verdict.mjs';

export const PATTERN = 'real-app-journeys-shard-*';
export const MAX_WAITS = 2;
/** The longest one wait may be: a primary limit resets within the hour. */
export const MAX_WAIT_MS = 61 * 60_000;
export const PAUSES = [10_000, 30_000];

/** A primary rate limit, which names its reset: waited out. Never a secondary limit, which is a refusal. */
export function primaryLimit(stderr) {
  const s = String(stderr ?? '');
  return /API rate limit exceeded/i.test(s) && !/secondary rate limit/i.test(s);
}
/** A refusal: never retried. */
export function refused(stderr) {
  return /HTTP 40[13]|HTTP 429|secondary rate limit|rate limit/i.test(String(stderr ?? '')) && !primaryLimit(stderr);
}

/** Milliseconds to wait for the reset (`reset` in epoch seconds), plus a few seconds; null when it is past the cap. */
export function waitFor(reset, now, cap = MAX_WAIT_MS) {
  const ms = Math.max(0, reset * 1000 - now) + 5_000;
  return ms > cap ? null : ms;
}

/**
 * Download with waits. `io`: download() throws an error with `stderr` on failure; budget() -> { limit, used, remaining,
 * reset }; wait(ms); now(); log(line). Returns { ok, why } and never throws.
 */
export function downloadShards(io, { maxWaits = MAX_WAITS, pauses = PAUSES, deadline = Infinity } = {}) {
  let waits = 0;
  let others = 0;
  for (;;) {
    try {
      io.download();
      return { ok: true };
    } catch (e) {
      const said = String(e.stderr ?? e.message ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();
      // No shard uploaded a report (none started): nothing to merge, and the next step names the missing shards.
      if (missingArtifact(e.stderr)) {
        io.log(`no shard artifact to download: ${said}`);
        return { ok: true };
      }
      if (primaryLimit(e.stderr)) {
        if (waits >= maxWaits) return { ok: false, why: `still rate-limited after ${waits} wait(s) for the reset: ${said}` };
        let b;
        try {
          b = io.budget();
        } catch (e2) {
          return { ok: false, why: `rate-limited, and the reset couldn't be read: ${String(e2.message).split('\n')[0]}` };
        }
        const ms = waitFor(b.reset, io.now());
        if (ms === null || io.now() + ms > deadline)
          return { ok: false, why: `rate-limited until ${new Date(b.reset * 1000).toISOString()}, past this job's time: ${said}` };
        waits++;
        io.log(
          `rate-limited (${b.used} of ${b.limit} used, resets ${new Date(b.reset * 1000).toISOString()}): waiting ${Math.round(ms / 1000)} s, then asking again (wait ${waits} of ${maxWaits})`,
        );
        io.wait(ms);
        continue;
      }
      if (refused(e.stderr)) return { ok: false, why: `refused, not retried: ${said}` };
      if (others >= pauses.length) return { ok: false, why: `failed ${others + 1} times: ${said}` };
      io.log(`download failed (${said}): trying again in ${pauses[others] / 1000} s`);
      io.wait(pauses[others++]);
    }
  }
}

/**
 * Downloads at once. `gh run download` takes a run's artifacts one after another: about 2 GB of 64 shard artifacts took
 * 103 s of main's run 44464621638 (19 Nov 2026), 1.7 of the 3.1 minutes its verdict job adds after the last shard
 * (INTAFACED/project-state#3240). Each artifact is still one API call, as before.
 */
export const PARALLEL = 8;
// stdin: "<id> <name>" lines; $1 repo, $2 folder, $3 how many at once (each child gets repo, folder, id, name). Each artifact unzips into <folder>/<name>, the
// layout gh run download gives; any failure fails the whole step with gh's own words on stderr.
const PARALLEL_SCRIPT = `set -euo pipefail
xargs -P "$3" -L 1 bash -c 'set -euo pipefail; z=$(mktemp); gh api "repos/$0/actions/artifacts/$2/zip" > "$z"; mkdir -p "$1/$3"; unzip -q -o "$z" -d "$1/$3"; rm -f "$z"' "$1" "$2"`;

/**
 * The shard artifacts in `list` ("<id> <name>" lines, as the artifacts API gives them): every name PATTERN matches, once,
 * the newest (highest id) when a re-run kept two of one name, in shard order. Pure, for the tests.
 */
export function shardArtifacts(list) {
  const newest = new Map();
  for (const line of String(list ?? '').split('\n')) {
    const m = /^(\d+) (real-app-journeys-shard-(\d+))$/.exec(line.trim());
    if (!m) continue;
    const had = newest.get(m[2]);
    if (!had || Number(m[1]) > had.id) newest.set(m[2], { id: Number(m[1]), name: m[2], shard: Number(m[3]) });
  }
  return [...newest.values()].sort((a, b) => a.shard - b.shard);
}

/** One try: every shard artifact of `run`, PARALLEL at a time, each into `<dir>/<name>`; a failure throws with gh's stderr. */
export function downloadAll(repo, run, dir) {
  // A fresh folder each try: a half-finished download never mixes with the next.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const list = execFileSync(
    'gh',
    ['api', '--paginate', `repos/${repo}/actions/runs/${run}/artifacts?per_page=100`, '--jq', '.artifacts[] | "\\(.id) \\(.name)"'],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  );
  const wanted = shardArtifacts(list);
  // gh run download's own words for a run with none, so downloadShards reads it as it always has (missingArtifact).
  if (!wanted.length)
    throw Object.assign(new Error('no valid artifacts found to download'), { stderr: 'no valid artifacts found to download' });
  console.log(`${wanted.length} shard artifacts, ${PARALLEL} at a time`);
  execFileSync('bash', ['-c', PARALLEL_SCRIPT, 'shard-download', repo, dir, String(PARALLEL)], {
    input: wanted.map((a) => `${a.id} ${a.name}`).join('\n'),
    stdio: ['pipe', 'inherit', 'pipe'],
    encoding: 'utf8',
  });
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** A synchronous pause, for the waits above (step-pictures.mjs shares it). */
export const pause = sleep;
const budget = () =>
  JSON.parse(execFileSync('gh', ['api', 'rate_limit', '--jq', '.resources.core'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const show = (b) => `limit ${b.limit}, used ${b.used}, remaining ${b.remaining}, resets ${new Date(b.reset * 1000).toISOString()}`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  const { GITHUB_RUN_ID: run, GITHUB_REPOSITORY: repo } = process.env;
  if (!dir || !run || !repo || !process.env.GH_TOKEN) {
    console.error('✖ shard-download: <dir>, GITHUB_RUN_ID, GITHUB_REPOSITORY and GH_TOKEN are required');
    process.exit(1);
  }
  const before = (() => {
    try {
      return budget();
    } catch {
      return null;
    }
  })();
  console.log(`API budget before: ${before ? show(before) : 'unreadable'}`);
  // The job's own limit (real-app-journeys.yml scoreboard timeout-minutes) less the time the later steps need.
  const deadline = Date.now() + Number(process.env.WAIT_BUDGET_MINUTES ?? 65) * 60_000;
  const io = {
    download: () => downloadAll(repo, run, dir),
    budget,
    wait: sleep,
    now: Date.now,
    log: (l) => console.log(l),
  };
  const got = downloadShards(io, { deadline });
  try {
    console.log(`API budget after: ${show(budget())}`);
  } catch {
    console.log('API budget after: unreadable');
  }
  if (!got.ok) {
    console.log(`::error::the shard reports couldn't be downloaded: ${got.why}`);
    process.exit(1);
  }
}
