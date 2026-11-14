// The pre-push hook on planted repos: a worktree with no node_modules (here or in the main checkout) pushes with one
// line instead of being refused; formatting still refuses when prettier is there; a direct push to main is still refused;
// CI's checks (tooling/scripts/ci-checks.mjs) never run here: they run on GitHub, on the branch and then on the PR.
// Each case is a throwaway repo holding the real .githooks/pre-push, pushing to a local bare remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// The hook prints its pointer to GitHub's branch run only when CI is unset, so each push here runs as on a builder's
// machine, even when this file runs inside CI.
const BUILDER = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CI'));

function plant({ prettier = null, ciChecks = 'process.exit(0);' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pre-push-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, 'config', 'user.email', 't@example.invalid');
  git(work, 'config', 'user.name', 't');
  mkdirSync(join(work, '.githooks'), { recursive: true });
  copyFileSync(join(ROOT, '.githooks', 'pre-push'), join(work, '.githooks', 'pre-push'));
  chmodSync(join(work, '.githooks', 'pre-push'), 0o755);
  mkdirSync(join(work, 'tooling', 'scripts'), { recursive: true });
  writeFileSync(join(work, 'tooling', 'scripts', 'truth-check.mjs'), 'process.exit(0);\n');
  // CI's checks (tooling/scripts/ci-checks.mjs), planted: the real one builds and tests the whole repo.
  writeFileSync(join(work, 'tooling', 'scripts', 'ci-checks.mjs'), `${ciChecks}\n`);
  writeFileSync(join(work, '.gitignore'), 'node_modules\n');
  writeFileSync(join(work, 'README.md'), 'base\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'fetch', '-q', 'origin');
  git(work, 'config', 'core.hooksPath', '.githooks');
  if (prettier !== null) {
    mkdirSync(join(work, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(work, 'node_modules', '.bin', 'prettier'), `#!/bin/sh\n${prettier}\n`);
    chmodSync(join(work, 'node_modules', '.bin', 'prettier'), 0o755);
  }
  git(work, 'checkout', '-q', '-b', 'feat');
  mkdirSync(join(work, 'src'), { recursive: true });
  writeFileSync(join(work, 'src', 'a.ts'), 'export const a = 1;\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'change');
  const push = (ref = 'feat', env = BUILDER) => {
    const r = spawnSync('git', ['push', 'origin', `HEAD:refs/heads/${ref}`], { cwd: work, encoding: 'utf8', env });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  return { push, work, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('no node_modules here or in the main checkout: one line, the push goes through', () => {
  const p = plant();
  try {
    const r = p.push();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /no prettier in this worktree; skipped/);
  } finally {
    p.done();
  }
});

test('formatting still refuses when prettier is there', () => {
  const p = plant({ prettier: 'echo "[warn] src/a.ts"; exit 1' });
  try {
    const r = p.push();
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /format:check failed/);
  } finally {
    p.done();
  }
});

test('a formatted push with prettier there goes through', () => {
  const p = plant({ prettier: 'exit 0' });
  try {
    const r = p.push();
    assert.equal(r.code, 0, r.out);
  } finally {
    p.done();
  }
});

test('a direct push to main is still refused', () => {
  const p = plant({ prettier: 'exit 0' });
  try {
    const r = p.push('main');
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /Direct push to main refused/);
  } finally {
    p.done();
  }
});

test("CI's checks never run here: a red planted in them leaves the push alone, and the hook names GitHub's branch run", () => {
  const p = plant({ prettier: 'exit 0', ciChecks: "console.log('ran'); process.exit(1);" });
  try {
    const r = p.push();
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /\bran\b/);
    assert.match(r.out, /gh workflow run ci\.yml -R INTAFACED\/intafaced --ref <branch>/);
  } finally {
    p.done();
  }
});

test('a push that only deletes a branch runs no checks', () => {
  const p = plant({ prettier: 'exit 0', ciChecks: "console.log('ran'); process.exit(1);" });
  try {
    // The branch exists on the remote (pushed here without the hook), so the delete reaches the hook.
    git(p.work, 'push', '-q', '--no-verify', 'origin', 'HEAD:refs/heads/gone');
    const r = spawnSync('git', ['push', 'origin', ':refs/heads/gone'], { cwd: p.work, encoding: 'utf8', env: BUILDER });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /\bran\b|gh workflow run/);
  } finally {
    p.done();
  }
});
