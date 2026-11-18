#!/usr/bin/env node
/**
 * The typecheck .githooks/pre-push runs: CI's own selection (tooling/ci/ci-affected.mjs --filters: the packages the push
 * changes, their dependents and the readers of what they changed), `turbo run typecheck` over it, under a time limit.
 *
 *   exit 0  nothing TypeScript changed (decided from the file names alone, well under 2 seconds), or the typecheck passed;
 *   exit 1  a type error: turbo prints the compiler's line above, and the push is refused;
 *   exit 0  TIMEOUT: the typecheck ran past the limit, the run is stopped and the push goes on; CI's Typecheck & build
 *           job judges it.
 *
 * Failure it prevents: a type error first seen as a red Typecheck & build job minutes after the push (#8814's first head
 * on 18 Nov, TS2339 in services/svc-trade/src/venue/venue-adl-acks.sql.test.ts; #8804 and #8783 the same week).
 *
 *   node tooling/scripts/pre-push-typecheck.mjs [--limit <seconds>]
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIMIT_SECONDS = 240;

/** A file whose change can change a type: TypeScript source, or a tsconfig or package.json inside a workspace. */
export function touchesTypes(files) {
  return (
    files.some(
      (f) =>
        /^(apps|services|packages|tooling)\//.test(f) && (/\.(ts|tsx|mts|cts)$/.test(f) || /(^|\/)(tsconfig[^/]*|package)\.json$/.test(f)),
    ) || files.some((f) => f === 'tsconfig.base.json' || f === 'pnpm-lock.yaml')
  );
}

/** Runs `pnpm turbo run typecheck` over the filters; resolves to 'pass', 'fail' or 'timeout'. */
function typecheck(filters, { limitSeconds = LIMIT_SECONDS, cwd = ROOT } = {}) {
  const args = ['turbo', 'run', 'typecheck', '--output-logs=errors-only', ...filters.map((f) => `--filter=${f}`)];
  return new Promise((resolve) => {
    // Its own process group, so a timeout stops turbo and every tsc it started, not only pnpm.
    const child = spawn('pnpm', args, { cwd, stdio: ['ignore', 'inherit', 'inherit'], detached: true });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
      resolve('timeout');
    }, limitSeconds * 1000);
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
  let base;
  let files;
  try {
    base = git('merge-base', 'origin/main', 'HEAD');
    files = git('diff', '--name-only', '--no-renames', base, 'HEAD').split('\n').filter(Boolean);
  } catch {
    console.log('typecheck: git cannot say what this push changes; left to CI');
    return 0;
  }
  if (!touchesTypes(files)) return 0;
  if (!existsSync(join(ROOT, 'node_modules', '.bin', 'turbo'))) {
    console.error(
      "  ✖ the typecheck needs this worktree's install — push refused. Install it: pnpm install --frozen-lockfile --prefer-offline",
    );
    return 1;
  }
  const { affectedFilters, readEdges } = await import('../ci/ci-affected.mjs');
  const filters = affectedFilters(files, readEdges(), base);
  const started = Date.now();
  console.log(`typecheck: the packages this push reaches (${filters.join(' ')}), limit ${limitSeconds}s`);
  const verdict = await typecheck(filters, { limitSeconds });
  const took = Math.round((Date.now() - started) / 1000);
  if (verdict === 'timeout') {
    console.log(`typecheck: TIMEOUT after ${limitSeconds}s — stopped; the push goes on and CI's Typecheck & build judges it`);
    return 0;
  }
  if (verdict === 'fail') {
    console.error(
      `\n  ✖ typecheck failed (${took}s) — push refused. The compiler's line is above; CI's Typecheck & build would fail the same way.\n`,
    );
    return 1;
  }
  console.log(`typecheck: passed in ${took}s`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exit(await main());
