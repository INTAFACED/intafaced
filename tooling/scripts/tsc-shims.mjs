#!/usr/bin/env node
// Runs after every `pnpm install` off CI (root package.json, postinstall). pnpm rewrites each node_modules/.bin/tsc at
// install, so a builder's own install (after a `git switch`, say) undid the worktree setup's shims (tsc.mjs,
// installShims) and `npx tsc` ran TypeScript 7's native checker again: on 22 Nov 2026, 47 of 84 worktrees on the box had
// lost them, and their checks held 1.3 to 2.5 GB and up to 137 threads each at load 125 (INTAFACED/project-state d99).
//
// pnpm 10 links each workspace package's .bin just before that package's own install scripts, in dependency order
// (runLifecycleHooksConcurrently), so the packages it reaches after this root script get pnpm's tsc back. The shims are
// written now, and once more by a detached copy of this script when that pnpm process has exited.
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { installShims } from './tsc.mjs';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const parentOf = (pid) => Number(spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());

const at = process.argv.indexOf('--after');
if (at > 0) {
  const pnpm = Number(process.argv[at + 1]);
  for (const end = Date.now() + 30 * 60_000; alive(pnpm) && Date.now() < end;) await sleep(25);
  installShims();
} else {
  console.log(`tsc: ${installShims()} node_modules/.bin/tsc files point at tooling/scripts/tsc.mjs`);
  // This script's parent is the `sh -c` pnpm runs a script in; pnpm is that shell's parent.
  const pnpm = parentOf(process.ppid);
  if (pnpm > 1)
    spawn(process.execPath, [fileURLToPath(import.meta.url), '--after', String(pnpm)], { detached: true, stdio: 'ignore' }).unref();
}
