// T3's worktree setup (t3.json, runOnWorktreeCreate): install a new worktree once, in the background, so agents don't
// each run their own install at the same time. Node built-ins only: it runs before node_modules exists.
// Markers in the worktree's node_modules/.t3-setup/: `setup-running` holds this PID while it works, then `setup-done` or
// `setup-failed` (with the install's last lines). See CONTRIBUTING.md, "Worktrees". They live under node_modules/ because
// T3's worktree cleanup ("keep when any local files") skips node_modules/ but keeps a worktree holding any other ignored
// file, so markers in an ignored .t3/ kept every finished worktree on disk. pnpm install leaves the folder in place.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const worktree = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(worktree, 'node_modules', '.t3-setup');
const running = join(dir, 'setup-running');
const done = join(dir, 'setup-done');
const failed = join(dir, 'setup-failed');
rmSync(done, { force: true });
rmSync(failed, { force: true });
mkdirSync(dir, { recursive: true });
writeFileSync(running, `${process.pid}\n`);

let detail = '';
process.on('uncaughtExceptionMonitor', (e) => {
  detail = e.stack ?? String(e);
});
process.on('exit', (code) => {
  if (code === 0) writeFileSync(done, '');
  else writeFileSync(failed, `Setup exited with code ${code}.\n${detail}\n`);
  rmSync(running, { force: true });
});
// A cancelled setup still leaves a marker, so nobody waits for it forever.
let child;
let cancelled;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    cancelled = sig;
    if (child) child.kill(sig);
    else process.exit(1);
  });
}

// The lockfile as it is (a stale one fails rather than being rewritten), from the shared store where it can,
// at low priority so it never crowds out the agents already working; stdin closed so no prompt can hang it.
child = spawn('nice', ['-n', '10', 'pnpm', 'install', '--frozen-lockfile', '--prefer-offline'], {
  cwd: worktree,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CI: '1' },
});
let tail = '';
for (const [from, to] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
]) {
  from.setEncoding('utf8');
  from.on('data', (s) => {
    to.write(s);
    tail = (tail + s).slice(-8000);
  });
}
const status = await new Promise((resolve) => {
  child.on('error', (e) => {
    tail += String(e);
    resolve(1);
  });
  child.on('close', resolve);
});
child = undefined;
if (status !== 0 || cancelled) {
  detail = cancelled ? `Cancelled by ${cancelled}.` : tail.trimEnd().split('\n').slice(-30).join('\n');
  process.exit(status || 1);
}
