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
export function stackTool(args, timeout, env = process.env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'tooling/scripts/local-test-stack.mjs'), ...args],
      { cwd: ROOT, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 },
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

/** `env` without its `LOCAL_STACK_*=off` values: the environment a blanked service is started again in. */
export function withoutOff(env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (/^LOCAL_STACK_[A-Z0-9_]+$/.test(k) && out[k] === 'off') delete out[k];
  return out;
}

/**
 * The stack tool's `overrides` answer: the running services a file left started with an owner value off (`{ name:
 * [variables] }`, J-agents-15's `ownerValue()`), or why it could not be read.
 */
export function blankServices(res) {
  if (res.code !== 0) return { blank: {}, error: res.timedOut ? 'overrides timed out' : `overrides exit ${res.code}` };
  try {
    const got = JSON.parse(res.stdout.trim() || '{}');
    const blank = {};
    for (const [name, vars] of Object.entries(got ?? {}))
      if (/^[a-z0-9-]+$/.test(name) && Array.isArray(vars))
        blank[name] = vars.filter((v) => typeof v === 'string' && /^LOCAL_STACK_[A-Z0-9_]+$/.test(v));
    return { blank };
  } catch {
    return { blank: {}, error: 'overrides answer is not JSON' };
  }
}

/**
 * After a file that restarts a service: when `status` says a part of the stack is down, `start` it again (idempotent: it
 * starts only what is down, and leaves a market maker that a journey stopped off). When a service is still running with
 * an owner value off (a file restarted it with `LOCAL_STACK_*=off` and did not put it back), `restart` it without those
 * values instead, which also starts what is down. Then `status` once more. `healMs` is the time the restore can give the
 * start; under MIN_START_MS it starts nothing. Returns what it did, in words; empty when the stack was healthy.
 */
export async function healStack({ run = stackTool, statusMs = STATUS_MS, healMs, env = process.env }) {
  const before = await run(['status'], statusMs);
  const { blank, error } = blankServices(await run(['overrides'], statusMs));
  const names = Object.keys(blank).sort();
  if (before.code === 0 && !names.length && !error) return [];
  const said = [];
  if (error) said.push(`could not read which services run with an owner value off (${error})`);
  if (names.length) said.push(`started with an owner value off: ${names.map((n) => `${n} (${blank[n].join(', ')})`).join('; ')}`);
  if (before.code !== 0) {
    const down = downRows(before.stdout);
    said.unshift(
      `stack not healthy (status ${before.timedOut ? `timed out after ${statusMs / 1000}s` : `exit ${before.code}`}${down.length ? `: ${down.join('; ')}` : ''})`,
    );
  }
  const act = names.length ? ['restart', ...names] : before.code !== 0 ? ['start'] : null;
  if (!act) return said;
  if (!(healMs >= MIN_START_MS)) {
    said.push(
      `not ${act[0] === 'restart' ? 'restarted' : 'started again'}: ${Math.max(0, Math.floor((healMs || 0) / 1000))}s left in this restore, under ${MIN_START_MS / 1000}s; later files may fail on it`,
    );
    return said;
  }
  if (act[0] === 'restart') said.push(`restarting ${names.join(', ')} without ${names.length > 1 ? 'them' : 'it'}`);
  else said[0] += '; starting what is down';
  const res = await run(act, healMs, act[0] === 'restart' ? withoutOff(env) : env);
  if (res.code !== 0) said.push(`${act[0]} ${res.timedOut ? `timed out after ${healMs / 1000}s` : `exit ${res.code}`}`);
  const after = await run(['status'], statusMs);
  if (after.code === 0) said.push('stack healthy again');
  else {
    const still = downRows(after.stdout);
    said.push(`stack still not healthy${still.length ? `: ${still.join('; ')}` : ''}; later files may fail on it`);
  }
  return said;
}
