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

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
    download: () => {
      // A fresh folder each try: a half-finished download never mixes with the next.
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      execFileSync('gh', ['run', 'download', run, '--repo', repo, '--pattern', PATTERN, '--dir', dir], {
        stdio: ['ignore', 'inherit', 'pipe'],
        encoding: 'utf8',
      });
    },
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
