// dead-code.mjs: no change adds a file or an export that nothing uses (project-state#2848).
// Run: node --test tooling/ci/dead-code.test.mjs (also by the tooling-tests gate).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEEPERS, compare, explain, findingsOf } from './dead-code.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const GATE = join(ROOT, 'tooling/ci/dead-code.mjs');

test('a finding the baseline lacks fails; a baseline row knip no longer finds is only printed', () => {
  const report = {
    issues: [
      { file: 'a.mjs', files: [{ name: 'a.mjs' }], exports: [] },
      { file: 'b.mjs', files: [], exports: [{ name: 'B' }, { name: 'C' }] },
    ],
  };
  const found = findingsOf(report);
  assert.deepEqual(found, ['a.mjs', 'b.mjs#B', 'b.mjs#C']);
  assert.deepEqual(compare(found, ['a.mjs', 'b.mjs#B', 'gone.mjs#D']), { added: ['b.mjs#C'], gone: ['gone.mjs#D'] });
  assert.match(explain('b.mjs#C'), /^b\.mjs: export C is imported by no other file/);
  assert.match(explain('a.mjs'), /^a\.mjs: no entry reaches this file/);
});

/** A tiny repo with knip installed from this checkout: an entry, a used module, and the KEEPERS the gate checks first. */
function fixture({ extraExport = false, extraFile = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dead-code-'));
  const put = (path, text) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  put('package.json', JSON.stringify({ name: 'fixture', private: true, type: 'module' }));
  put('knip.jsonc', JSON.stringify({ entry: ['src/main.mjs'], project: ['src/**/*.mjs'] }));
  put('src/main.mjs', "import { used } from './lib.mjs';\nused();\n");
  put('src/lib.mjs', `export function used() { return 1; }\n${extraExport ? 'export const LEFT_OVER = 2;\n' : ''}`);
  if (extraFile) put('src/orphan.mjs', 'export const nobody = 1;\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  spawnSync('ln', ['-s', join(ROOT, 'node_modules/knip'), join(dir, 'node_modules/knip')]);
  for (const k of KEEPERS) put(k, '');
  put('tooling/ci/dead-code-baseline.json', '[]\n');
  return dir;
}

const run = (dir) => spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });

test('the faults it was written for, planted: a new unused export and a new unused file each fail by name', () => {
  const clean = fixture();
  const dirty = fixture({ extraExport: true, extraFile: true });
  try {
    const ok = run(clean);
    assert.equal(ok.status, 0, ok.stderr);
    const bad = run(dirty);
    assert.equal(bad.status, 1, bad.stdout);
    assert.match(bad.stderr, /src\/lib\.mjs: export LEFT_OVER is imported by no other file/);
    assert.match(bad.stderr, /src\/orphan\.mjs: no entry reaches this file/);
  } finally {
    rmSync(clean, { recursive: true, force: true });
    rmSync(dirty, { recursive: true, force: true });
  }
});

test('a deleted keeper fails before knip runs', () => {
  const dir = fixture();
  try {
    rmSync(join(dir, 'services/svc-agents/src/navigator/money-deny-honesty.ts'));
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /DEAD CODE - 1 protected module\(s\) were deleted/);
    assert.match(r.stderr, /navigator\/money-deny-honesty\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
