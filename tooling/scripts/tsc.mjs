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
 *   - the same answer as a full check: an error is printed only from checking its file in this run (the files that
 *     failed last time are checked again), and on the one path where TypeScript 7.0 leaves dependents unchecked (a
 *     changed file that declares globals, skippedDependents below) every file is checked again. On 20 Nov 2026 a check
 *     made before the workspace packages were built kept 4 errors in two unchanged files of apps/customer after the
 *     build, and the pre-push hook refused a push the real compiler passed (INTAFACED/intafaced#9253).
 * Anything else (a build, a watch, files named on the command line, `--version`) runs tsc unchanged.
 *
 * Off CI, that check runs tsrs (oxc-project's Rust port of TypeScript 7, the checker t3code's packages run) in place of
 * tsc, when it is installed: apps/customer cold took 4.97 GB and 42 s with tsc 7.0.2 and 1.31 GB and 9 to 18 s with
 * tsrs, and 0.5 s at 0.43 GB warm (box, 21 Nov 2026, INTAFACED/project-state#3604). CI (`CI` set) keeps tsc, the judge.
 * tsrs also reports declaration-emit errors (TS2883) under --noEmit, which tsc 7.0 does not, so its check turns
 * declaration output off: the same answer as tsc on every package on 21 Nov. Its build-info and seed are its own.
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
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const TSC = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
const TSRS = join(REPO, 'node_modules', 'tsrs', 'bin', 'tsrs');

/** The compiler a one-project check runs: tsc in CI or where tsrs is not installed, else tsrs. */
export const checkerOf = (env = process.env) => (env.CI || !existsSync(TSRS) ? 'tsc' : 'tsrs');

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
export function planOf(argv, cwd, checker = 'tsc') {
  if (!argv.includes('--noEmit') || argv.some((a) => PASS_THROUGH.has(a.split('=')[0]))) return { args: argv };
  if (argv.some((a) => !a.startsWith('-') && /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(a))) return { args: argv };
  const at = argv.findIndex((a) => a === '-p' || a === '--project');
  let project = at >= 0 ? argv[at + 1] : 'tsconfig.json';
  if (project === undefined) return { args: argv };
  project = isAbsolute(project) ? project : resolve(cwd, project);
  if (existsSync(project) && statSync(project).isDirectory()) project = join(project, 'tsconfig.json');
  if (!existsSync(project)) return { args: argv };
  const name = `${basename(project, extname(project))}${checker === 'tsrs' ? '.tsrs' : ''}.tsbuildinfo`;
  const buildInfo = join(dirname(project), 'node_modules', '.cache', 'tsc', name);
  const own = checker === 'tsrs' ? ['--declaration', 'false', '--declarationMap', 'false'] : [];
  return { args: [...argv, ...own, '--incremental', '--tsBuildInfoFile', buildInfo], project, buildInfo, checker };
}

const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout.trim() : null;
};

/** Where this project's shared seed lives on this machine, or null outside git. */
export function seedOf(project, checker = 'tsc') {
  const cwd = dirname(project);
  const top = git(cwd, 'rev-parse', '--show-toplevel');
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!top || !common) return null;
  const key = relative(realpathSync(top), realpathSync(project)).split(/[\\/]/).join('%');
  return join(common, 'intafaced-tsc-seed', `${key}${checker === 'tsrs' ? '.tsrs' : ''}.tsbuildinfo`);
}

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

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Rewrites the build-info so the next check re-checks files instead of repeating their stored answer: the files that
 * had errors (a stored error is never printed again, only a fresh one), or with `every`, all files. A bare file id in
 * `semanticDiagnosticsPerFile` is TypeScript's own "not checked yet".
 */
export function forgetAnswers(buildInfo, info, { every = false } = {}) {
  const ids = every
    ? info.fileNames.map((_, i) => i + 1)
    : (info.semanticDiagnosticsPerFile ?? []).map((e) => (Array.isArray(e) ? e[0] : e));
  const tmp = `${buildInfo}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...info, semanticDiagnosticsPerFile: ids }));
  renameSync(tmp, buildInfo);
}

/**
 * Did this check take TypeScript 7.0's path that leaves dependents unchecked? When a file that declares globals is
 * itself changed (its text, or what its imports resolve to) and its declarations change, TypeScript marks "every file
 * affected" and then re-checks only the changed files; every other file keeps its stored answer, stale errors and
 * stale passes alike (typescript-go v7.0.2, internal/execute/incremental/affectedfileshandler.go, getFilesAffectedBy
 * and handleDtsMayChangeOfAffectedFile). Read from the build-info before and after the check.
 */
export function skippedDependents(before, after) {
  const sig = (fi) => (typeof fi === 'string' ? fi : fi.noSignature ? '' : fi.signature || fi.version);
  const refsOf = (b) => {
    const m = new Map();
    for (const [file, list] of b.referencedMap ?? [])
      m.set(
        b.fileNames[file - 1],
        b.fileIdsList[list - 1]
          .map((i) => b.fileNames[i - 1])
          .sort()
          .join('\n'),
      );
    return m;
  };
  const old = new Map(before.fileNames.map((n, i) => [n, before.fileInfos[i]]));
  let oldRefs, newRefs;
  return after.fileNames.some((name, i) => {
    const now = after.fileInfos[i];
    if (typeof now === 'string' || !now.affectsGlobalScope) return false;
    const was = old.get(name);
    if (was === undefined) return true;
    if (sig(was) === sig(now)) return false;
    if ((typeof was === 'string' ? was : was.version) !== now.version) return true;
    oldRefs ??= refsOf(before);
    newRefs ??= refsOf(after);
    return oldRefs.get(name) !== newRefs.get(name);
  });
}

/** Runs the compiler; resolves to its exit code, and with `capture` to `{ code, out, err }` (its output held back). */
function tsc(args, cwd, { capture = false, checker = 'tsc' } = {}) {
  const child = spawn(process.execPath, [checker === 'tsrs' ? TSRS : TSC, ...args], {
    cwd,
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
  });
  const out = [];
  const err = [];
  child.stdout?.on('data', (d) => out.push(d));
  child.stderr?.on('data', (d) => err.push(d));
  const forward = (sig) => child.kill(sig);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, forward);
  return new Promise((r) => {
    child.on('error', () => r(1));
    child.on('close', (c, sig) => r(c ?? (sig ? 1 : 0)));
  }).then((code) => {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(sig, forward);
    return capture ? { code, out: Buffer.concat(out), err: Buffer.concat(err) } : code;
  });
}

/** Runs tsc for these arguments; resolves to its exit code. */
export async function run(argv, { cwd = process.cwd() } = {}) {
  const plan = planOf(argv, cwd, checkerOf());
  if (!plan.buildInfo) return tsc(plan.args, cwd);
  // The output is held until it is known to be the answer to keep; a terminal still gets tsc's colours.
  const args = process.stdout.isTTY && !argv.some((a) => a.startsWith('--pretty')) ? [...plan.args, '--pretty'] : plan.args;
  const release = await lock(plan.buildInfo, plan.project);
  const seed = seedOf(plan.project, plan.checker);
  try {
    if (seed && !existsSync(plan.buildInfo) && existsSync(seed)) {
      copyWhole(seed, plan.buildInfo);
      console.error('typecheck: started from the last passing check of this project on this machine');
    }
    // Every error printed comes from checking the file now: the files that failed last time are checked again.
    const before = existsSync(plan.buildInfo) ? readJson(plan.buildInfo) : null;
    if (before?.semanticDiagnosticsPerFile?.some(Array.isArray)) forgetAnswers(plan.buildInfo, before);
    let result = await tsc(args, cwd, { capture: true, checker: plan.checker });
    const after = before && readJson(plan.buildInfo);
    if (after && skippedDependents(before, after)) {
      console.error('typecheck: a file that declares globals changed, which TypeScript 7.0 does not follow; checking every file again');
      forgetAnswers(plan.buildInfo, after, { every: true });
      result = await tsc(args, cwd, { capture: true, checker: plan.checker });
    }
    process.stdout.write(result.out);
    process.stderr.write(result.err);
    const code = result.code;
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

// exitCode, not exit(): a held-back report written to a pipe is flushed before the process ends.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  process.exitCode = await run(process.argv.slice(2));
