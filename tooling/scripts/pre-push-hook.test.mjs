// The pre-push hook on planted repos: a worktree with no node_modules (here or in the main checkout) pushes with one
// line instead of being refused; formatting still refuses when prettier is there; a direct push to main is still refused.
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

function plant({ prettier = null } = {}) {
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
  const push = (ref = 'feat') => {
    const r = spawnSync('git', ['push', 'origin', `HEAD:refs/heads/${ref}`], { cwd: work, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  return { push, done: () => rmSync(dir, { recursive: true, force: true }) };
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
