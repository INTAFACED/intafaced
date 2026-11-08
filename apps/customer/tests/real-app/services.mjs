import { execFile } from 'node:child_process';
import path from 'node:path';
import { ROOT, shownOutput } from './stack.mjs';

/**
 * The stack's services as the world restore puts them back: after a file that restarts a service, the next file starts on
 * a stack whose services all answer (docs/runbooks/harness-rewrite-plan.md, piece 5).
 *
 * Failure it prevents: on main run 42379971970, shard 34, J-developer-02 #2's `restart identity` hit the stack tool's
 * 120 s timeout, which cut the restart off part-way. Identity then refused every sign-up for the rest of the shard: the
 * next file's beforeAll waited out its 420 s and J-dex-protocol-18 its 240 s (#7463). The file that restarted still fails
 * its own step; what changes is that the files after it start on a stack that answers again.
 *
 * Both calls run without blocking the worker (execFile, not execFileSync), so Edge's kept-alive sockets don't go stale
 * while they run (#7461). Nothing here fails a step: what it did, or could not do, is returned in words.
 */

/** How long `status` may take: it asks every service's /health, each with a 2.5 s cap. */
export const STATUS_MS = 20_000;
/** The least time a healing `start` is given; with less, the heal only says what is down (a start cut off helps nobody). */
export const MIN_START_MS = 60_000;

/** `node tooling/scripts/local-test-stack.mjs <args>`: its exit code (null when it timed out or could not run) and output. */
export function stackTool(args, timeout) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'tooling/scripts/local-test-stack.mjs'), ...args],
      { cwd: ROOT, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, timedOut: Boolean(err?.killed), stdout, stderr }),
    );
  });
}

/** The status table's rows that are not up, as shown (masked and cut); empty when none can be shown. */
export function downRows(stdout) {
  return shownOutput(stdout)
    .text.split('\n')
    .filter((l) => /\b(DOWN|HALTED)\b/.test(l))
    .map((l) => l.trim());
}

/**
 * When `status` says a part of the stack is down, `start` it again (idempotent: it starts only what is down, and leaves
 * a market maker that a journey stopped off), then ask `status` once more. `healMs` is the time the restore can give the
 * start; under MIN_START_MS it starts nothing. Returns what it did, in words; empty when the stack was healthy.
 */
export async function healStack({ run = stackTool, statusMs = STATUS_MS, healMs }) {
  const before = await run(['status'], statusMs);
  if (before.code === 0) return [];
  const down = downRows(before.stdout);
  const said = [
    `stack not healthy (status ${before.timedOut ? `timed out after ${statusMs / 1000}s` : `exit ${before.code}`}${down.length ? `: ${down.join('; ')}` : ''})`,
  ];
  if (!(healMs >= MIN_START_MS)) {
    said.push(
      `not started again: ${Math.max(0, Math.floor((healMs || 0) / 1000))}s left in this restore, under ${MIN_START_MS / 1000}s; later files may fail on it`,
    );
    return said;
  }
  said[0] += '; starting what is down';
  const start = await run(['start'], healMs);
  if (start.code !== 0) said.push(`start ${start.timedOut ? `timed out after ${healMs / 1000}s` : `exit ${start.code}`}`);
  const after = await run(['status'], statusMs);
  if (after.code === 0) said.push('stack healthy again');
  else {
    const still = downRows(after.stdout);
    said.push(`stack still not healthy${still.length ? `: ${still.join('; ')}` : ''}; later files may fail on it`);
  }
  return said;
}
