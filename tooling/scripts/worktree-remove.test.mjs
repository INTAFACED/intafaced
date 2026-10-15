/** Run: node --test tooling/scripts/worktree-remove.test.mjs (local Git only). */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./worktree.mjs', import.meta.url));

function fixture(t) {
  // Keep test work outside /tmp and outside the shared project checkouts.
  const cache = join(homedir(), '.cache');
  mkdirSync(cache, { recursive: true });
  const sandbox = mkdtempSync(join(cache, 'intafaced-worktree-remove-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const repo = join(sandbox, 'repo');
  mkdirSync(repo);
  const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Worktree test']);
  git(['config', 'user.email', 'worktree-test@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'tracked.txt'), 'base\n');
  git(['add', 'tracked.txt']);
  git(['commit', '-m', 'fixture base']);
  const branch = 'docs/removal-fixture';
  const worktree = join(sandbox, 'repo-worktrees', 'docs-removal-fixture');
  git(['worktree', 'add', '-b', branch, worktree]);
  const remove = () => spawnSync(process.execPath, [script, 'remove', branch], { cwd: repo, encoding: 'utf8' });
  return { repo, git, branch, worktree, remove };
}

for (const merged of [true, false]) {
  test(`removal keeps ${merged ? 'merged' : 'unmerged'} branch and its commits`, (t) => {
    const { git, branch, worktree, remove } = fixture(t);
    if (!merged) {
      writeFileSync(join(worktree, 'tracked.txt'), 'unique committed work\n');
      git(['commit', '-am', 'unique work'], worktree);
    }
    const tip = git(['rev-parse', branch]);
    assert.equal(git(['branch', '--merged', 'main', '--list', branch]).length > 0, merged);
    const result = remove();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(worktree), false);
    assert.equal(git(['rev-parse', branch]), tip);
    assert.equal(git(['show', `${branch}:tracked.txt`]), merged ? 'base' : 'unique committed work');
    assert.match(result.stdout, /branch "docs\/removal-fixture" kept/);
    assert.equal(git(['worktree', 'list', '--porcelain']).includes(worktree), false);
  });
}

for (const tracked of [true, false]) {
  test(`removal refuses ${tracked ? 'tracked edits' : 'untracked files'} and preserves work`, (t) => {
    const { git, branch, worktree, remove } = fixture(t);
    const filename = tracked ? 'tracked.txt' : 'untracked.txt';
    writeFileSync(join(worktree, filename), 'uncommitted work\n');
    const tip = git(['rev-parse', branch]);
    const before = git(['status', '--porcelain'], worktree);
    const result = remove();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /has uncommitted changes/);
    assert.equal(existsSync(worktree), true);
    assert.equal(git(['status', '--porcelain'], worktree), before);
    assert.equal(git(['rev-parse', branch]), tip);
  });
}
