/**
 * Which of a stack service's own source files ran, and when: loaded into each Node service the local stack starts
 * (`node --import <this file> services/svc-x/dist/index.js`, local-test-stack.mjs), so the touched-journeys map can say
 * which journeys a change to one file of a service reaches, not only which journeys reached the service (every service
 * is reached by most journeys, so a service-wide reach holds nearly all of them: project-state #3378).
 *
 * It does nothing unless INTAFACED_CODE_REACH names the file to append to (the stack sets it per service). It starts
 * V8's precise coverage with call counts in its own process (node:inspector, no port is opened), and every TICK_MS, and
 * once more as the process exits, it reads and resets the counts and appends one line naming the service's own source
 * files whose functions ran since the last read:
 *   { pid, start: ms }                                    the process began counting
 *   { pid, from: ms, to: ms, files: ['services/svc-x/src/a/b.ts'] }   functions of these files ran between from and to
 *                                                         (no `files` when none ran: a reader then knows it has seen all
 *                                                         the process ran up to `to`)
 *   { pid, end: ms }                                      the process is exiting; nothing it ran is unread
 * Only paths of the service's own sources go out, each a built file (`services/svc-x/dist/…js`) whose source
 * (`services/svc-x/src/…ts`) is in the checkout: never a value, a name or anything a request carried. A module's top
 * level counts as a function that ran, so a process that starts while a journey runs reaches every file it loads.
 * Recording never changes what the service does; a failure to record stops recording, never the service.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { Session } from 'node:inspector';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CODE_REACH_ENV = 'INTAFACED_CODE_REACH';
export const TICK_MS = 500;
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const BUILT = /^services\/(svc-[a-z0-9-]+)\/dist\/([A-Za-z0-9._@/-]+)\.js$/;

/** Where a stack's services write what ran: `<state>/logs/code/<service>.jsonl`. */
export const codeReachDir = (state) => path.join(state, 'logs', 'code');

/** The flags and environment that make a Node service `name` record into `dir` (the stack's start, for each one). */
export function nodeServiceReach(dir, name, env) {
  if (!NAME.test(String(name))) throw new Error(`not a service name: ${name}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { flags: ['--import', pathToFileURL(SELF).href], env: { ...env, [CODE_REACH_ENV]: path.join(dir, `${name}.jsonl`) } };
}

/** A script URL as the repository source file it was built from (`services/svc-x/src/a.ts`), or null. */
export function sourceOf(url, root = ROOT, exists = existsSync) {
  let file;
  try {
    file = fileURLToPath(String(url));
  } catch {
    return null;
  }
  const rel = path.relative(root, file).split(path.sep).join('/');
  const m = BUILT.exec(rel);
  if (!m || m[2].split('/').includes('..')) return null;
  const src = `services/${m[1]}/src/${m[2]}.ts`;
  return exists(path.join(root, src)) ? src : null;
}

/** The source files with a function that ran, from takePreciseCoverage's `result`. */
export function ranFiles(result, toSource = sourceOf) {
  const out = new Set();
  for (const s of result ?? []) {
    if (!(s.functions ?? []).some((f) => f.ranges?.[0]?.count > 0)) continue;
    const src = toSource(s.url);
    if (src) out.add(src);
  }
  return [...out].sort();
}

/** Starts recording into `out` (a file path). Returns { take, stop } for tests; the service never calls them. */
export function startCodeReach(out, { now = Date.now, tick = TICK_MS, toSource = sourceOf } = {}) {
  const session = new Session();
  session.connect();
  // An in-process session answers synchronously, so a read inside an `exit` listener still lands.
  const post = (method, params) => {
    let err = null;
    let res = null;
    session.post(method, params, (e, r) => {
      err = e;
      res = r;
    });
    if (err) throw err;
    return res;
  };
  const pid = process.pid;
  const write = (o) => appendFileSync(out, `${JSON.stringify({ pid, ...o })}\n`);
  let on = true;
  post('Profiler.enable');
  post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
  let from = now();
  write({ start: from });
  const take = () => {
    if (!on) return;
    try {
      const to = now();
      const files = ranFiles(post('Profiler.takePreciseCoverage')?.result, toSource);
      write(files.length ? { from, to, files } : { from, to });
      from = to;
    } catch {
      on = false; // a read that fails ends recording; the map reads the service's missing end as a gap
    }
  };
  const timer = setInterval(take, tick);
  timer.unref();
  const stop = () => {
    if (!on) return;
    take();
    clearInterval(timer);
    if (on) write({ end: now() });
    on = false;
  };
  process.on('exit', stop);
  // A service with no SIGTERM or SIGINT listener of its own would end without its `exit` event: read once, then end
  // the way the signal would have.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    const own = () => {
      take();
      if (process.listenerCount(sig) === 1) {
        stop();
        process.removeListener(sig, own);
        process.kill(pid, sig);
      }
    };
    process.prependListener(sig, own);
  }
  return { take, stop };
}

// Only as a preload (`--import`), never when another script imports this one for its helpers.
if (
  process.env[CODE_REACH_ENV] &&
  process.execArgv.some((a) => a === pathToFileURL(SELF).href || a.endsWith(`=${pathToFileURL(SELF).href}`))
) {
  try {
    startCodeReach(process.env[CODE_REACH_ENV]);
  } catch {
    /* recording never stops a service */
  }
}
