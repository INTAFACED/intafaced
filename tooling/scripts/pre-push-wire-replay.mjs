#!/usr/bin/env node
/**
 * The wire replay .githooks/pre-push runs: for each service whose own folder this push changes and that holds a recorded
 * wire (services/<svc>/src/wire-replay.test.ts), the build of what it imports (turbo, cached) and then that one test,
 * under one time limit.
 *
 *   exit 0  no such service changed (decided from the file names alone), or every replay matched its recording;
 *   exit 1  a replay differs: vitest prints the differences above, and the push is refused with how to re-record;
 *   exit 0  TIMEOUT: the replays ran past the limit, the run is stopped and the push goes on; CI's unit tests judge it.
 *
 * Failure it prevents: a change to a service's wire first seen as a red unit test minutes after the push, the recording
 * then rewritten in a second push (project-state#3681: svc-bank's replay, first cause of a lost push in #9469, #9425 and
 * #8111 in one week). svc-bank's replay takes about 20 seconds here once its imports are built.
 *
 *   node tooling/scripts/pre-push-wire-replay.mjs [--limit <seconds>]
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIMIT_SECONDS = 240;
const REPLAY = 'src/wire-replay.test.ts';

/** The services whose own folder the files change and that hold a wire replay, in name order. */
export function replayedServices(files, hasReplay = (svc) => existsSync(join(ROOT, 'services', svc, REPLAY))) {
  const touched = new Set(files.map((f) => /^services\/([^/]+)\//.exec(f)?.[1]).filter(Boolean));
  return [...touched].filter((svc) => hasReplay(svc)).sort();
}

/** The command that re-records a service's wire, for a change that is meant to change it. */
export const rerecord = (svc) => `(cd services/${svc} && WIRE_REPLAY_WRITE=1 npx vitest run ${REPLAY})`;

/** Runs pnpm with args in its own process group; resolves to the exit code, or 'timeout' once the deadline passes. */
function pnpm(args, deadline, cwd = ROOT) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', args, { cwd, stdio: ['ignore', 'inherit', 'inherit'], detached: true });
    const timer = setTimeout(
      () => {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {}
        resolve('timeout');
      },
      Math.max(0, deadline - Date.now()),
    );
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(1);
    });
  });
}

async function main() {
  const at = process.argv.indexOf('--limit');
  const limitSeconds = at >= 0 ? Number(process.argv[at + 1]) : LIMIT_SECONDS;
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let files;
  try {
    const base = git('merge-base', 'origin/main', 'HEAD');
    files = git('diff', '--name-only', '--no-renames', base, 'HEAD').split('\n').filter(Boolean);
  } catch {
    console.log('wire replay: git cannot say what this push changes; left to CI');
    return 0;
  }
  const services = replayedServices(files);
  if (services.length === 0) return 0;
  if (!existsSync(join(ROOT, 'node_modules', '.bin', 'turbo'))) {
    console.error(
      "  ✖ the wire replay needs this worktree's install — push refused. Install it: pnpm install --frozen-lockfile --prefer-offline",
    );
    return 1;
  }
  const started = Date.now();
  const deadline = started + limitSeconds * 1000;
  console.log(`wire replay: ${services.join(' ')}, limit ${limitSeconds}s`);
  const differs = [];
  for (const svc of services) {
    const name = JSON.parse(readFileSync(join(ROOT, 'services', svc, 'package.json'), 'utf8')).name;
    let code = await pnpm(['turbo', 'run', 'build', `--filter=${name}^...`, '--output-logs=errors-only'], deadline);
    if (code === 0) code = await pnpm(['--filter', name, 'exec', 'vitest', 'run', REPLAY], deadline);
    if (code === 'timeout') {
      console.log(`wire replay: TIMEOUT after ${limitSeconds}s — stopped; the push goes on and CI's unit tests judge it`);
      return 0;
    }
    if (code !== 0) differs.push(svc);
  }
  const took = Math.round((Date.now() - started) / 1000);
  if (differs.length) {
    console.error(
      `\n  ✖ wire replay failed (${took}s) — push refused. The differences are above; CI's unit tests would fail the same way.`,
    );
    console.error('    A change meant to change the wire re-records it, commits the recording and names it in the PR body:');
    for (const svc of differs) console.error(`      ${rerecord(svc)}`);
    console.error('    Otherwise each difference is a break of the wire: fix the code.\n');
    return 1;
  }
  console.log(`wire replay: matched in ${took}s`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exit(await main());
