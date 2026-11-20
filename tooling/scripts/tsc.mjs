#!/usr/bin/env node
/**
 * The one way to type-check in this repo: `node tooling/scripts/tsc.mjs <tsc's own arguments>`, a drop-in for `tsc`.
 * Every package's `typecheck` script calls it, tooling/ci/test-typecheck.mjs calls it for tsconfig.test.json, and the
 * worktree setup points every `node_modules/.bin/tsc` at it (installShims), so a hand-typed `npx tsc` takes it too.
 *
 * A `--noEmit` check of one project becomes, with nothing else changed (same compiler, same config):
 *   - incremental: `--incremental --tsBuildInfoFile <project dir>/node_modules/.cache/tsc/<config>.tsbuildinfo`, so a
 *     check after a one-file edit re-checks only what that edit reaches;
 *   - one at a time: a second check of the same project in the same worktree waits for the first, then reuses its
 *     build-info (a lock directory beside it, released when the holder exits; a dead holder's lock is taken over);
 *   - seeded: a worktree's first check starts from the last passing build-info of the same project on this machine,
 *     kept in the clone's common git directory (`<git common dir>/intafaced-tsc-seed/`). The build-info records paths
 *     relative to itself and a hash of each file's text, so one made in another worktree is valid here: a file whose
 *     text differs is checked again, as after an edit.
 * Anything else (a build, a watch, files named on the command line, `--version`) runs tsc unchanged.
 *
 * Failure it prevents (INTAFACED/project-state#3374): builders ran bare `npx tsc` 527 times in four days, with no
 * incremental mode, no cache and no lock. One check of apps/customer took 10 s and 7 GB on the Mac, about 57 s and
 * 5 GB on the box; on 19 Nov, 22:17 to 22:57 UTC, one weed's three helpers ran it at once in one worktree and filled
 * the box. Incremental, a one-file change checks in about 2 s at under 2 GB, and three at once run one compiler.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const TSC = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');

/** Flags that mean this is not a one-project check, or that the caller already chose its own build-info. */
const PASS_THROUGH = new Set([
  '--build',
  '-b',
  '--watch',
  '-w',
  '--incremental',
  '-i',
  '--tsBuildInfoFile',
  '--composite',
  '--init',
  '--version',
  '-v',
  '--help',
  '-h',
  '--all',
  '--showConfig',
  '--listFilesOnly',
  '--generateTrace',
]);

/**
 * What to run for these arguments. `{ args }` alone runs tsc as given; `{ args, project, buildInfo }` is a check made
 * incremental and locked.
 */
export function planOf(argv, cwd) {
  if (!argv.includes('--noEmit') || argv.some((a) => PASS_THROUGH.has(a.split('=')[0]))) return { args: argv };
  if (argv.some((a) => !a.startsWith('-') && /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(a))) return { args: argv };
  const at = argv.findIndex((a) => a === '-p' || a === '--project');
  let project = at >= 0 ? argv[at + 1] : 'tsconfig.json';
  if (project === undefined) return { args: argv };
  project = isAbsolute(project) ? project : resolve(cwd, project);
  if (existsSync(project) && statSync(project).isDirectory()) project = join(project, 'tsconfig.json');
  if (!existsSync(project)) return { args: argv };
  const buildInfo = join(dirname(project), 'node_modules', '.cache', 'tsc', `${basename(project, extname(project))}.tsbuildinfo`);
  return { args: [...argv, '--incremental', '--tsBuildInfoFile', buildInfo], project, buildInfo };
}

const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout.trim() : null;
};

/** Where this project's shared seed lives on this machine, or null outside git. */
export function seedOf(project) {
  const cwd = dirname(project);
  const top = git(cwd, 'rev-parse', '--show-toplevel');
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!top || !common) return null;
  const key = relative(realpathSync(top), realpathSync(project)).split(/[\\/]/).join('%');
  return join(common, 'intafaced-tsc-seed', `${key}.tsbuildinfo`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** Takes the lock beside the build-info; waits while a live process holds it. Returns the release function. */
async function lock(buildInfo, project) {
  const dir = `${buildInfo}.lock`;
  mkdirSync(dirname(dir), { recursive: true });
  let said = false;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, 'pid'), `${process.pid}\n`);
      return () => rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let holder = NaN;
    try {
      holder = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    } catch {}
    // A lock with no pid yet is being taken this instant; one whose holder is gone is taken over.
    const fresh = Number.isNaN(holder) && Date.now() - statSync(dir, { throwIfNoEntry: false })?.mtimeMs < 10_000;
    if (!fresh && (Number.isNaN(holder) || !alive(holder))) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (!said) {
      console.error(
        `typecheck: waiting for the check of ${relative(process.cwd(), project) || project} already running in this worktree (pid ${holder})`,
      );
      said = true;
    }
    await sleep(200);
  }
}

/** Copies `from` to `to` so a reader never sees half a file. */
function copyWhole(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  const tmp = `${to}.${process.pid}.tmp`;
  copyFileSync(from, tmp);
  renameSync(tmp, to);
}

/** Runs tsc for these arguments; resolves to its exit code. */
export async function run(argv, { cwd = process.cwd(), stdio = 'inherit' } = {}) {
  const plan = planOf(argv, cwd);
  const release = plan.buildInfo ? await lock(plan.buildInfo, plan.project) : () => {};
  const seed = plan.buildInfo ? seedOf(plan.project) : null;
  try {
    if (seed && !existsSync(plan.buildInfo) && existsSync(seed)) {
      copyWhole(seed, plan.buildInfo);
      console.error('typecheck: started from the last passing check of this project on this machine');
    }
    const child = spawn(process.execPath, [TSC, ...plan.args], { cwd, stdio });
    const forward = (sig) => child.kill(sig);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, forward);
    const code = await new Promise((r) => {
      child.on('error', () => r(1));
      child.on('close', (c, sig) => r(c ?? (sig ? 1 : 0)));
    });
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(sig, forward);
    if (code === 0 && seed && existsSync(plan.buildInfo)) {
      try {
        copyWhole(plan.buildInfo, seed);
      } catch {}
    }
    return code;
  } finally {
    release();
  }
}

/**
 * Points the worktree's `node_modules/.bin/tsc` (the root's and each package's) at this file, so `npx tsc`,
 * `pnpm exec tsc` and a package script's bare `tsc` all come here. pnpm writes those files at install; this runs after.
 */
export function installShims(root = REPO) {
  const shim = `#!/bin/sh\n# Written by tooling/t3/setup-worktree.mjs: every tsc here goes through ${relative(root, fileURLToPath(import.meta.url))}.\nexec node "${fileURLToPath(import.meta.url)}" "$@"\n`;
  const bins = [join(root, 'node_modules', '.bin', 'tsc')];
  for (const area of ['apps', 'packages', 'services', 'tooling']) {
    if (!existsSync(join(root, area))) continue;
    for (const name of readdirSync(join(root, area))) bins.push(join(root, area, name, 'node_modules', '.bin', 'tsc'));
  }
  let n = 0;
  for (const bin of bins) {
    if (!existsSync(bin)) continue;
    writeFileSync(bin, shim, { mode: 0o755 });
    n += 1;
  }
  return n;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  process.exit(await run(process.argv.slice(2)));
