/**
 * Runs Maven for sbe-codec and svc-fix, and tries once more when Maven could not RESOLVE a plugin or dependency.
 *
 * Why (#8121, run 43227496169): Maven Central answered "Could not find artifact" for maven-resources-plugin 3.3.1 for a
 * few seconds, so sbe-codec's `build:jar` and svc-fix's `test` failed. Maven then wrote that miss into the local
 * repository, and sbe-codec's own `test` twenty seconds later failed on the cached miss ("was not found ... during a
 * previous attempt ... resolution is not reattempted") without asking Central again. The same job passed on its re-run.
 *
 * So, only when the output names a resolution failure and no test ran, it waits and runs the same goal once more with
 * `-U`, which makes Maven ask Central again instead of trusting the cached miss. A compile error, a failing test or
 * a second resolution failure is returned as it is: a real missing artifact still fails, after one more try.
 */
import { spawnSync } from 'node:child_process';

/** Maven's own words for a plugin or dependency it could not fetch, or a fetch it refuses to repeat. */
const RESOLUTION_FAILURE = [
  /^\[ERROR\] Plugin \S+ or one of its dependencies could not be resolved/m,
  /^\[ERROR\] Failed to execute goal on project \S+: Could not resolve dependencies/m,
  /Could not (?:transfer|find) artifact \S+ (?:from|in)\b/,
  /was not found in \S+ during a previous attempt/,
];

/** True when the run failed fetching from a repository, before any test ran. */
export function isResolutionFailure(output) {
  const text = String(output ?? '');
  if (/Tests run: \d+/.test(text)) return false; // a test ran: its result is never retried
  return RESOLUTION_FAILURE.some((re) => re.test(text));
}

export const RETRY_WAIT_MS = 10_000;

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * spawnSync for Maven with the one resolution retry. Output is captured so it can be read, then written to `out`
 * (default: this process's stdout and stderr; pass `null` to keep it only in the result).
 * Returns the last attempt's result plus `attempts`.
 */
export function runMvnSync(mvn, args, { cwd, env, out, waitMs = RETRY_WAIT_MS, spawn = spawnSync, sleep = sleepSync, log } = {}) {
  const write = out === undefined ? (r) => (process.stdout.write(r.stdout ?? ''), process.stderr.write(r.stderr ?? '')) : out;
  const say = log ?? ((line) => process.stderr.write(`${line}\n`));
  for (let attempt = 1; ; attempt++) {
    const r = spawn(mvn, attempt === 1 ? args : ['-U', ...args], { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (write) write(r);
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.status === 0 || attempt === 2 || !isResolutionFailure(output)) return { ...r, attempts: attempt };
    say(`mvn could not resolve a plugin or dependency from the repository; trying once more with -U in ${waitMs / 1000} s (#8121)`);
    sleep(waitMs);
  }
}
