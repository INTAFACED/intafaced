// Run: node --test tooling/scripts/rust-test-roots.test.mjs (also by the tooling-tests gate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestSource, plan, rootSource } from './rust-test-roots.mjs';

const SCRIPT = new URL('./rust-test-roots.mjs', import.meta.url).pathname;
const run = (cwd, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });

const MANIFEST = '[package]\nname = "svc-x"\nedition.workspace = true\n\n[lints]\nworkspace = true\n\n[dependencies]\nurl = "2"\n';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'rust-test-roots-'));
  mkdirSync(join(dir, 'crates', 'svc-x', 'tests', 'support'), { recursive: true });
  mkdirSync(join(dir, 'crates', 'vendor', 'lib', 'tests'), { recursive: true });
  writeFileSync(join(dir, 'crates', 'svc-x', 'Cargo.toml'), MANIFEST);
  writeFileSync(join(dir, 'crates', 'svc-x', 'tests', 'boot.rs'), '');
  writeFileSync(join(dir, 'crates', 'svc-x', 'tests', 'a_pg.rs'), '');
  writeFileSync(join(dir, 'crates', 'svc-x', 'tests', 'support', 'mod.rs'), '');
  mkdirSync(join(dir, 'crates', 'svc-x', 'tests', 'parity'));
  writeFileSync(join(dir, 'crates', 'svc-x', 'tests', 'parity', 'main.rs'), '');
  writeFileSync(join(dir, 'crates', 'vendor', 'lib', 'tests', 'own.rs'), '');
  return dir;
}

test('the repo is current: every crate has its one test root and manifest entry', () => {
  const r = run(process.cwd(), '--check');
  assert.equal(r.status, 0, r.stderr);
});

test('it lists every tests/*.rs file but the root and every tests/*/main.rs, each by #[path], declares each shared helper once, and leaves vendored crates alone', () => {
  const dir = repo();
  try {
    assert.equal(run(dir).status, 0);
    const root = readFileSync(join(dir, 'crates', 'svc-x', 'tests', 'it.rs'), 'utf8');
    assert.match(
      root,
      /#\[path = "a_pg.rs"\]\nmod a_pg;\n#\[path = "boot.rs"\]\nmod boot;\n#\[path = "parity\/main.rs"\]\nmod parity;\n\n/,
    );
    assert.match(root, /never a `mod` of their own\.\nmod support;\n\n/);
    assert.equal(root.match(/mod support;/g).length, 1);
    assert.doesNotMatch(root, /mod it;|"support/);
    assert.equal(plan(dir).length, 2, 'svc-x root and manifest only, nothing under crates/vendor');
    assert.equal(run(dir, '--check').status, 0);
    assert.equal(run(dir).status, 0);
    assert.equal(readFileSync(join(dir, 'crates', 'svc-x', 'tests', 'it.rs'), 'utf8'), root, 'a second run changes nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--check fails, naming the file, on a test file added without rewriting the root (the planted fault)', () => {
  const dir = repo();
  try {
    run(dir);
    writeFileSync(join(dir, 'crates', 'svc-x', 'tests', 'planted.rs'), '');
    const r = run(dir, '--check');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /stale: .*crates\/svc-x\/tests\/it\.rs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--check fails on a manifest that lost autotests = false', () => {
  const dir = repo();
  try {
    run(dir);
    const path = join(dir, 'crates', 'svc-x', 'Cargo.toml');
    writeFileSync(path, readFileSync(path, 'utf8').replace('autotests = false\n', ''));
    const r = run(dir, '--check');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /stale: .*crates\/svc-x\/Cargo\.toml/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the manifest gets autotests = false at the end of [package] and one [[test]] entry, once', () => {
  const once = manifestSource(MANIFEST);
  assert.equal(
    once,
    '[package]\nname = "svc-x"\nedition.workspace = true\nautotests = false\n\n[lints]\nworkspace = true\n\n[dependencies]\nurl = "2"\n\n[[test]]\nname = "it"\npath = "tests/it.rs"\n',
  );
  assert.equal(manifestSource(once), once);
});

test('a file whose name is not a Rust module name is refused by name', () => {
  assert.throws(
    () =>
      rootSource([
        ['ok', 'ok.rs'],
        ['bad-name', 'bad-name.rs'],
      ]),
    /bad-name\.rs/,
  );
});
