#!/usr/bin/env node
/**
 * The wire replays .githooks/pre-push runs: for each service this push changes that keeps a wire replay
 * (`services/<service>/src/wire-replay.test.ts`), the replay itself, after a build of the packages it reads, under one
 * time limit. A push that changes a shared package (`packages/`) runs no replay: its packages would build here, the CPU
 * the hook stopped spending on 22 Nov (#9599), and CI's Tests job judges it. Otherwise the packages are main's, already
 * in turbo's shared cache, and the build step takes about a second.
 *
 *   exit 0  the push changes no service with a replay (decided from the file names alone), or every replay passed;
 *   exit 1  a replay answered other than its recording: vitest prints the calls that differ above, and this names the
 *           command that rewrites the recording when the change to the wire is meant;
 *   exit 0  TIMEOUT: the replays ran past the limit, the run is stopped and the push goes on; CI's Tests job judges them.
 *
 * Failure it prevents: a new route whose answers the replay had not recorded, first seen as a red Tests job minutes after
 * the push, then a second push with the recording rewritten: svc-trade's GET /api/v1/venue/deposit-routes (#9297,
 * e4b1c05a79, 21 Nov) and GET /api/v1/venue/margin-rules (#9519, 43ca732ccc, 21 Nov) (project-state#3682). svc-trade's
 * replay takes about 7 s here; svc-edge's, the slowest, 21 s.
 *
 * WIRE_REPLAY_WRITE is never passed on: the hook judges the recording and never rewrites it.
 *
 *   node tooling/scripts/pre-push-wire-replay.mjs [--limit <seconds>]
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIMIT_SECONDS = 60;
const REPLAY = 'src/wire-replay.test.ts';

/** The services (folder names under services/) whose files `files` changes and that keep a wire replay, sorted. */
export function replaysFor(files, hasReplay = (service) => existsSync(join(ROOT, 'services', service, REPLAY))) {
  const services = new Set(files.map((f) => /^services\/([^/]+)\//.exec(f)?.[1]).filter(Boolean));
  return [...services].filter((s) => hasReplay(s)).sort();
}

/** The command that rewrites a service's recording, for a change that is meant to change its wire. */
export const rewriteCommand = (pkg) => `WIRE_REPLAY_WRITE=1 pnpm --filter ${pkg} exec vitest run ${REPLAY}`;

/** Runs one command in its own process group; resolves to 'pass', 'fail' or 'timeout' at the deadline. */
function run(args, { deadline, cwd = ROOT, env }) {
  return new Promise((resolve) => {
    const left = deadline - Date.now();
    if (left <= 0) return resolve('timeout');
    const child = spawn('pnpm', args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'], detached: true });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
      resolve('timeout');
    }, left);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? 'pass' : 'fail');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve('fail');
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
  const services = replaysFor(files);
  if (!services.length) return 0;
  if (files.some((f) => f.startsWith('packages/'))) {
    console.log('wire replay: this push changes a shared package, so the replays would build it here; left to CI');
    return 0;
  }
  if (!existsSync(join(ROOT, 'node_modules', '.bin', 'turbo'))) {
    console.error(
      "  ✖ the wire replay needs this worktree's install — push refused. Install it: pnpm install --frozen-lockfile --prefer-offline",
    );
    return 1;
  }
  const pkgs = services.map((s) => JSON.parse(readFileSync(join(ROOT, 'services', s, 'package.json'), 'utf8')).name);
  const { WIRE_REPLAY_WRITE: _never, ...env } = process.env;
  const started = Date.now();
  const deadline = started + limitSeconds * 1000;
  const timeout = () => {
    console.log(`wire replay: TIMEOUT after ${limitSeconds}s — stopped; the push goes on and CI's Tests job judges it`);
    return 0;
  };
  console.log(`wire replay: ${pkgs.join(' ')}, limit ${limitSeconds}s`);
  const built = await run(['turbo', 'run', 'build', '--output-logs=errors-only', ...pkgs.map((p) => `--filter=${p}^...`)], {
    deadline,
    env,
  });
  if (built === 'timeout') return timeout();
  if (built === 'fail') {
    console.error('  ✖ wire replay: the packages the replays read did not build — push refused. The error is above.');
    return 1;
  }
  const red = [];
  for (const pkg of pkgs) {
    const verdict = await run(['--filter', pkg, 'exec', 'vitest', 'run', REPLAY], { deadline, env });
    if (verdict === 'timeout') return timeout();
    if (verdict === 'fail') red.push(pkg);
  }
  const took = Math.round((Date.now() - started) / 1000);
  if (!red.length) {
    console.log(`wire replay: passed in ${took}s`);
    return 0;
  }
  for (const pkg of red)
    console.error(
      [
        `\n  ✖ ${pkg}'s wire replay does not answer as recorded (${took}s) — push refused. The calls that differ are above.`,
        '    A call added or changed on purpose: rewrite the recording, commit it, and name the wire change in the PR:',
        `      ${rewriteCommand(pkg)}`,
        "    Any other difference is a change to the wire to fix. CI's Tests job runs the same test.\n",
      ].join('\n'),
    );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exit(await main());
