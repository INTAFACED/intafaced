// coverage-check reads the law's structure from tooling/coverage-law-index.json, because the law itself
// (INTAFACED_DEFINITIVE_BUILD.md) is private, in INTAFACED/project-state:product/. These runs prove the gate passes
// on the committed index and fails on each planted fault in it. Each run is in a scratch tree whose entries link
// back to this checkout, except the files a case changes, which are copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const INDEX = 'tooling/coverage-law-index.json';
const YAML = 'tooling/coverage.yaml';

/** A scratch tree: every entry links to ROOT, except tooling/, which is rebuilt so the index and the YAML are copies. */
function scratch(mutate = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-check-'));
  for (const e of readdirSync(ROOT)) if (e !== 'tooling') symlinkSync(join(ROOT, e), join(dir, e));
  mkdirSync(join(dir, 'tooling'));
  for (const e of readdirSync(join(ROOT, 'tooling'))) {
    const rel = `tooling/${e}`;
    if (rel === INDEX || rel === YAML) continue;
    symlinkSync(join(ROOT, rel), join(dir, rel));
  }
  for (const rel of [INDEX, YAML]) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    const out = mutate[rel] ? mutate[rel](text) : text;
    if (out !== null) writeFileSync(join(dir, rel), out);
  }
  return dir;
}

function run(dir, args = []) {
  const r = spawnSync(process.execPath, [join(ROOT, 'tooling/ci/coverage-check.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const editIndex = (fn) => ({
  [INDEX]: (t) => {
    const j = JSON.parse(t);
    fn(j);
    return JSON.stringify(j, null, 2) + '\n';
  },
});

test('passes on the committed index', () => {
  const r = run(scratch());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /coverage-check clean/);
});

test('fails (planted): a chapter moved in the index, so cites leave their section', () => {
  const r = run(scratch(editIndex((j) => (j.chapters.find((c) => c.id === 23).line += 40))));
  assert.equal(r.code, 1, r.out);
});

test('fails (planted): a chapter dropped from the index', () => {
  const r = run(scratch(editIndex((j) => (j.chapters = j.chapters.filter((c) => c.id !== 30)))));
  assert.equal(r.code, 1, r.out);
});

test('fails (planted): a cited line marked blank', () => {
  const r = run(scratch(editIndex((j) => j.blankLines.push(94))));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /:94, which is a blank line/);
});

test('fails (planted): a coverage.yaml title that is not a prefix of the indexed one', () => {
  const r = run(scratch({ [YAML]: (t) => t.replace(/^ {4}title: STACK$/m, '    title: STACKS') }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /§1 title drifted/);
});

test('fails: the index is missing', () => {
  const r = run(scratch({ [INDEX]: () => null }));
  assert.equal(r.code, 1, r.out);
});

test('fails: an empty index opens nothing', () => {
  const r = run(scratch({ [INDEX]: () => '{"lines":0,"chapters":[],"blankLines":[]}\n' }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /OPENED NOTHING/);
});

test('fails: --law with a law the index was not written from', () => {
  const dir = scratch();
  const law = join(dir, 'not-the-law.md');
  writeFileSync(law, '# not the law\n\n## 0 · DOCTRINE\n\ntext\n');
  const r = run(dir, ['--law', law]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /law-index/);
});

test('fails: --law followed by a flag instead of a path', () => {
  const r = run(scratch(), ['--law', '--write-index']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /--law needs the path/);
});
