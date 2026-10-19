#!/usr/bin/env node
/**
 * TEST-DIFF GUARD — a PR may not loosen the tests it is judged by.
 *
 * Reads the diff against origin/main and fails on:
 *   1. a skip, todo, only or fixme added to a test (`.skip(`, `xit(`, `it.todo(` …);
 *   2. a test file deleted while its source file still exists;
 *   3. a modified test file with fewer assertions than before (`expect(` and
 *      `assert*(` calls removed outnumber those added);
 *   4. a matcher swapped for a weaker one on a changed line (toBe/toEqual →
 *      toBeDefined/toBeTruthy/toBeFalsy/toBeDefined, `toThrow(<msg>)` → `toThrow()`).
 *
 * A PR that does one of these on purpose says so in its description with a line
 *   Test-change: <the reason a reviewer can check>
 * which turns the failure into a printed notice. The reviewer sees both.
 *
 * Rules come from MAIN: CI runs the copy of this file on origin/main, never the
 * PR's copy, so a PR cannot loosen the guard it is judged by. (CI falls back to
 * the PR copy only while main has none, i.e. the PR that introduces it.)
 *
 *   node tooling/ci/test-diff-guard.mjs                 uses origin/main, PR_BODY env
 *   node tooling/ci/test-diff-guard.mjs --self-test
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const TEST_FILE = /(?:\.(?:test|spec)\.(?:[cm]?[jt]sx?)$|\/__tests__\/)/;
const SKIP = /\b(?:(?:it|test|describe|suite)\.(?:skip|todo|only|fixme|skipIf|runIf)\b|x(?:it|describe|test)\s*\(|f(?:it|describe)\s*\()/;
const ASSERT = /\b(?:expect(?:\.\w+)?|assert(?:\.\w+)?|t\.(?:is|equal|deepEqual|throws|true|false|truthy|falsy))\s*\(/g;
const WEAK_MATCHER = /\.(?:toBeDefined|toBeTruthy|toBeFalsy|toBeUndefined|not\.toBeNull|toBeInstanceOf)\s*\(/;
const STRONG_MATCHER =
  /\.(?:toBe|toEqual|toStrictEqual|toMatchObject|toHaveBeenCalledWith|toHaveLength|toContain|toMatch|rejects\.toThrow|toThrow)\s*\([^)]/;
const DECLARED = /^\s*Test-change:\s*\S.{7,}$/m;

const count = (lines) => lines.reduce((n, l) => n + (l.match(ASSERT)?.length ?? 0), 0);

/** @param {{path:string, status:string, removed:string[], added:string[], sourceExists:boolean}[]} changes */
export function judge(changes) {
  const problems = [];
  for (const c of changes) {
    if (!TEST_FILE.test(c.path)) continue;
    if (c.status === 'D') {
      if (c.sourceExists) problems.push({ path: c.path, why: 'test file deleted while the code it tests still exists' });
      continue;
    }
    for (const l of c.added) {
      if (SKIP.test(l)) problems.push({ path: c.path, why: `skip/todo/only added: ${l.trim().slice(0, 100)}` });
    }
    if (c.status === 'M') {
      const lost = count(c.removed) - count(c.added);
      if (lost > 0)
        problems.push({
          path: c.path,
          why: `${lost} fewer assertion(s) than before (${count(c.removed)} removed, ${count(c.added)} added)`,
        });
      const strongGone = c.removed.filter((l) => STRONG_MATCHER.test(l)).length;
      const weakIn = c.added.filter((l) => WEAK_MATCHER.test(l)).length;
      const strongIn = c.added.filter((l) => STRONG_MATCHER.test(l)).length;
      if (weakIn > 0 && strongGone > strongIn)
        problems.push({ path: c.path, why: 'a precise matcher was replaced by a weaker one (toBeDefined/toBeTruthy/…)' });
    }
  }
  return problems;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function sourceFor(path) {
  const src = path.replace(/\.(?:test|spec)(\.[cm]?[jt]sx?)$/, '$1');
  if (src !== path && existsSync(src)) return true;
  const alt = src.replace(/\.tsx?$/, (m) => (m === '.ts' ? '.tsx' : '.ts'));
  return alt !== src && existsSync(alt);
}

function collect(base) {
  const names = git(['diff', '--name-status', '--no-renames', `${base}...HEAD`])
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .filter(([, p]) => TEST_FILE.test(p));
  return names.map(([status, path]) => {
    let removed = [];
    let added = [];
    if (status !== 'D') {
      for (const l of git(['diff', '-U0', '--no-renames', `${base}...HEAD`, '--', path]).split('\n')) {
        if (l.startsWith('+++') || l.startsWith('---')) continue;
        if (l.startsWith('+')) added.push(l.slice(1));
        else if (l.startsWith('-')) removed.push(l.slice(1));
      }
    }
    return { path, status: status[0], removed, added, sourceExists: status === 'D' ? sourceFor(path) : true };
  });
}

function selfTest() {
  const t = (c) => judge([{ path: 'a/x.test.ts', status: 'M', removed: [], added: [], sourceExists: true, ...c }]);
  const eq = (got, want, m) => {
    if (got !== want) throw new Error(`${m}: got ${got}, want ${want}`);
  };
  eq(t({ added: ["  it.skip('x', () => {})"] }).length, 1, 'skip added');
  eq(t({ added: ["  describe.only('x', () => {"] }).length, 1, 'only added');
  eq(t({ added: ["  xit('x', () => {})"] }).length, 1, 'xit added');
  eq(t({ added: ["  it('skips the empty case', () => {"] }).length, 0, 'word skip in a title is fine');
  eq(t({ removed: ['  expect(a).toBe(1);', '  expect(b).toBe(2);'], added: ['  expect(a).toBe(1);'] }).length, 1, 'fewer assertions');
  eq(t({ removed: ['  expect(a).toBe(1);'], added: ['  expect(a).toBe(2);', '  expect(c).toBe(3);'] }).length, 0, 'more assertions fine');
  eq(t({ removed: ['  expect(a).toEqual({ x: 1 });'], added: ['  expect(a).toBeDefined();'] }).length, 1, 'weaker matcher');
  eq(judge([{ path: 'a/x.test.ts', status: 'D', removed: [], added: [], sourceExists: true }]).length, 1, 'deleted with source');
  eq(judge([{ path: 'a/x.test.ts', status: 'D', removed: [], added: [], sourceExists: false }]).length, 0, 'deleted with source gone');
  eq(judge([{ path: 'a/x.ts', status: 'M', removed: ['expect(a)'], added: [], sourceExists: true }]).length, 0, 'non-test ignored');
  eq(DECLARED.test('Why\n\nTest-change: removed the legacy vue snapshot test'), true, 'declared line');
  eq(DECLARED.test('Test-change: n/a'), false, 'declaration needs a real reason');
  console.log('✓ test-diff-guard --self-test OK (12 fixtures)');
}

if (process.argv.includes('--self-test')) {
  selfTest();
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.env.GUARD_BASE || 'origin/main';
  const problems = judge(collect(base));
  if (problems.length === 0) {
    console.log('✓ test-diff-guard clean — no test was deleted, skipped or weakened');
    process.exit(0);
  }
  const declared = DECLARED.test(process.env.PR_BODY || '');
  const head = declared
    ? '⚠ test-diff-guard — declared test change (Test-change: line present); reviewer must check it'
    : '✖ test-diff-guard FAILED';
  console.error(`\n${head} — ${problems.length} finding(s)\n`);
  for (const p of problems) console.error(`  ${p.path}\n    → ${p.why}\n`);
  if (!declared) {
    console.error('  If a change is intended, say why in the PR description on a line starting "Test-change:".');
    process.exit(1);
  }
}
