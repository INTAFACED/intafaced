/**
 * gates.mjs --changed: a builder's local run leaves the tooling tests to CI only when nothing they read changed.
 * Run: node --test tooling/ci/gates.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GATES, gatesToRun, changedSinceMain } from './gates.mjs';

const ids = (gates) => gates.map((g) => g.id);
const allButTooling = ids(GATES).filter((id) => id !== 'tooling-tests');

test('a full run (no --changed) runs every gate, the tooling tests included', () => {
  assert.deepEqual(ids(gatesToRun(GATES, null)), ids(GATES));
  assert.ok(ids(GATES).includes('tooling-tests'));
});

test('a product-only diff leaves out the tooling tests and nothing else', () => {
  const run = ids(gatesToRun(GATES, ['services/svc-ledger/src/index.ts', 'apps/customer/src/main.tsx', 'docs/x.md']));
  assert.deepEqual(run, allButTooling);
});

test('an empty diff leaves out the tooling tests and nothing else', () => {
  assert.deepEqual(ids(gatesToRun(GATES, [])), allButTooling);
});

test('a diff touching tooling/ or .github/ runs every gate', () => {
  assert.deepEqual(ids(gatesToRun(GATES, ['services/a.ts', 'tooling/scripts/local-test-stack.mjs'])), ids(GATES));
  assert.deepEqual(ids(gatesToRun(GATES, ['.github/workflows/ci.yml'])), ids(GATES));
});

test('a path that only looks like tooling (a service folder named tooling) does not count', () => {
  assert.deepEqual(ids(gatesToRun(GATES, ['services/svc-x/tooling/a.ts', 'xtooling/a.mjs'])), allButTooling);
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'gates-changed-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'services'), { recursive: true });
  mkdirSync(join(dir, 'tooling'), { recursive: true });
  writeFileSync(join(dir, 'services/a.ts'), 'a\n');
  writeFileSync(join(dir, 'tooling/t.mjs'), 't\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-qb', 'work');
  return { dir, git, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the diff is read from the merge-base with origin/main: commits, uncommitted edits and untracked files', () => {
  const r = repo();
  try {
    assert.deepEqual(changedSinceMain(r.dir), []);
    writeFileSync(join(r.dir, 'services/a.ts'), 'b\n');
    r.git('commit', '-qam', 'product');
    assert.deepEqual(changedSinceMain(r.dir), ['services/a.ts']);
    assert.deepEqual(ids(gatesToRun(GATES, changedSinceMain(r.dir))), allButTooling);

    // origin/main moving on with a tooling change of its own is not this branch's change.
    r.git('checkout', '-q', 'main');
    writeFileSync(join(r.dir, 'tooling/t.mjs'), 'main moved\n');
    r.git('commit', '-qam', 'main tooling');
    r.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    r.git('checkout', '-q', 'work');
    assert.deepEqual(changedSinceMain(r.dir), ['services/a.ts']);

    writeFileSync(join(r.dir, 'tooling/t.mjs'), 'edited, not committed\n');
    assert.deepEqual(changedSinceMain(r.dir), ['services/a.ts', 'tooling/t.mjs']);
    assert.deepEqual(ids(gatesToRun(GATES, changedSinceMain(r.dir))), ids(GATES));
    r.git('checkout', '--', 'tooling/t.mjs');

    writeFileSync(join(r.dir, 'tooling/new.test.mjs'), 'untracked\n');
    assert.ok(changedSinceMain(r.dir).includes('tooling/new.test.mjs'));
    assert.deepEqual(ids(gatesToRun(GATES, changedSinceMain(r.dir))), ids(GATES));
    rmSync(join(r.dir, 'tooling/new.test.mjs'));

    // A file moved out of tooling/ counts on both sides.
    r.git('mv', 'tooling/t.mjs', 'services/t.mjs');
    assert.ok(changedSinceMain(r.dir).includes('tooling/t.mjs'));
  } finally {
    r.done();
  }
});

test('an unreadable diff (no origin/main, or not a repo) is null, so every gate runs', () => {
  const r = repo();
  try {
    r.git('update-ref', '-d', 'refs/remotes/origin/main');
    assert.equal(changedSinceMain(r.dir), null);
    assert.deepEqual(ids(gatesToRun(GATES, changedSinceMain(r.dir))), ids(GATES));
  } finally {
    r.done();
  }
  const plain = mkdtempSync(join(tmpdir(), 'gates-norepo-'));
  try {
    assert.equal(changedSinceMain(plain), null);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});
