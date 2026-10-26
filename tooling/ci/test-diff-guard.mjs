#!/usr/bin/env node
/**
 * TEST-DIFF GUARD — a PR may not loosen the tests it is judged by.
 *
 * Reads the diff against origin/main and fails on:
 *   1. a skip, todo, only or fixme added to a test (`.skip(`, `xit(`, `it.todo(`, `test.fixme(` …);
 *   2. a test file deleted while its source file still exists (a journey or harness file, `*.pw.mjs`, has no one
 *      source file, so deleting one always counts);
 *   3. a modified test file with fewer assertions than before (`expect(` and
 *      `assert*(` calls removed outnumber those added);
 *   4. a matcher swapped for a weaker one on a changed line (toBe/toEqual/toBeVisible →
 *      toBeDefined/toBeTruthy/toBeFalsy/toBeAttached, `toThrow(<msg>)` → `toThrow()`);
 *   5. a screenshot tolerance raised (`maxDiffPixels`, `maxDiffPixelRatio` or `threshold` set higher than before);
 *   6. a look baseline image (`<package>/look-baselines/<room>/…png`) added, changed or deleted without a line
 *        Baseline-change: <room> — <why>
 *      naming its room. A named baseline change still needs the independent review (tooling/ci/review-marker.mjs
 *      asks for it), so the builder cannot approve its own picture.
 *
 * Tests are `.test.`/`.spec.` files, `__tests__/` folders, and the browser journeys and harnesses (`*.pw.mjs`).
 *
 * A PR that does one of 1-5 on purpose says so in its description with a line
 *   Test-change: <the reason a reviewer can check>
 * which turns the failure into a printed notice. The reviewer sees both. A Test-change line never covers 6.
 *
 * Every run prints each changed test file's assertion count change, so a locator-only rewrite can show it kept them.
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
import { BASELINE, roomOf } from './look-baselines.mjs';

const TEST_FILE = /(?:\.(?:test|spec)\.(?:[cm]?[jt]sx?)$|\.pw\.mjs$|\/__tests__\/)/;
const BROWSER_TEST = /\.pw\.mjs$/;
// A Playwright config sets screenshot tolerances for a whole suite; only its tolerance lines are judged.
const PW_CONFIG = /(?:^|\/)(?:[\w.-]+\.)?playwright\.config\.[cm]?[jt]s$/;
const SKIP = /\b(?:(?:it|test|describe|suite)\.(?:skip|todo|only|fixme|skipIf|runIf)\b|x(?:it|describe|test)\s*\(|f(?:it|describe)\s*\()/;
// The repo's journalled no-database branch: `describe.skip('<suite> (Postgres unavailable)', ...)`. The suite
// runs in full when the database is up; the skip-honesty gates account for the skip. Exact title shape only.
const PG_UNAVAILABLE_SKIP = /^\s*describe\.skip\(\s*'[^']+ \(Postgres unavailable\)'\s*,/;
const ASSERT = /\b(?:expect(?:\.\w+)?|assert(?:\.\w+)?|t\.(?:is|equal|deepEqual|throws|true|false|truthy|falsy))\s*\(/g;
const WEAK_MATCHER = /\.(?:toBeDefined|toBeTruthy|toBeFalsy|toBeUndefined|not\.toBeNull|toBeInstanceOf|toBeAttached)\s*\(/;
const STRONG_MATCHER =
  /\.(?:(?:toBe|toEqual|toStrictEqual|toMatchObject|toHaveBeenCalledWith|toHaveLength|toContain|toMatch|rejects\.toThrow|toThrow|toHaveText|toContainText|toHaveValue|toHaveURL|toHaveAttribute|toHaveCount|toHaveScreenshot)\s*\([^)]|toBeVisible\s*\()/;
// `threshold` is a common business word, so it counts only in browser tests and their configs.
const TOLERANCE = /\b(maxDiffPixels|maxDiffPixelRatio)\s*:\s*([\d.]+)/g;
const BROWSER_TOLERANCE = /\b(maxDiffPixels|maxDiffPixelRatio|threshold)\s*:\s*([\d.]+)/g;
const DECLARED = /^\s*Test-change:\s*\S.{7,}$/m;
const BASELINE_DECLARED = /^\s*Baseline-change:\s*(\S+)\s+[—–:-]+\s*(\S.{7,})$/gm;

const count = (lines) => lines.reduce((n, l) => n + (l.match(ASSERT)?.length ?? 0), 0);

/** @param {{path:string, status:string, removed:string[], added:string[], sourceExists:boolean}[]} changes */
export function judge(changes) {
  const problems = [];
  for (const c of changes) {
    if (PW_CONFIG.test(c.path) && c.status === 'M') {
      const raised = toleranceRaised(c.path, c.removed, c.added);
      if (raised) problems.push({ path: c.path, why: `screenshot tolerance raised: ${raised}` });
      continue;
    }
    if (!TEST_FILE.test(c.path)) continue;
    if (c.status === 'D') {
      if (BROWSER_TEST.test(c.path)) problems.push({ path: c.path, why: 'journey or harness file deleted' });
      else if (c.sourceExists) problems.push({ path: c.path, why: 'test file deleted while the code it tests still exists' });
      continue;
    }
    for (const l of c.added) {
      if (SKIP.test(l.replace(PG_UNAVAILABLE_SKIP, '')))
        problems.push({ path: c.path, why: `skip/todo/only added: ${l.trim().slice(0, 100)}` });
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
      const raised = toleranceRaised(c.path, c.removed, c.added);
      if (raised) problems.push({ path: c.path, why: `screenshot tolerance raised: ${raised}` });
    }
  }
  return problems;
}

/**
 * Which tolerance went up, or null. Each key's values on the removed and the added lines are sorted and compared in
 * pairs, so raising one screenshot's tolerance shows even when another touched line has a larger one; a value with no
 * counterpart among the removed lines is new and counts as raised from unset.
 */
function toleranceRaised(path, removed, added) {
  const re = BROWSER_TEST.test(path) || PW_CONFIG.test(path) ? BROWSER_TOLERANCE : TOLERANCE;
  const values = (lines) => {
    const out = new Map();
    for (const l of lines) for (const [, key, v] of l.matchAll(re)) out.set(key, [...(out.get(key) ?? []), Number(v)]);
    for (const list of out.values()) list.sort((a, b) => a - b);
    return out;
  };
  const before = values(removed);
  for (const [key, after] of values(added)) {
    const was = before.get(key) ?? [];
    const extra = after.length - was.length;
    if (extra > 0) return `${key} ${after[after.length - 1]} set on a line that had none`;
    for (let i = 0; i < after.length; i++)
      if (after[i] > was[i + (was.length - after.length)]) return `${key} ${was[i + (was.length - after.length)]} → ${after[i]}`;
  }
  return null;
}

/** The rooms a PR body names on `Baseline-change: <room> — <why>` lines. */
export function declaredRooms(body) {
  return new Set([...String(body ?? '').matchAll(BASELINE_DECLARED)].map((m) => m[1]));
}

/**
 * Baseline images changed in rooms the PR body does not name. A Test-change line does not cover these.
 * @param {{path:string, status:string}[]} changes
 */
export function judgeBaselines(changes, body) {
  const named = declaredRooms(body);
  const problems = [];
  const notices = [];
  for (const c of changes) {
    const room = roomOf(c.path);
    if (!room) continue;
    const verb = c.status === 'A' ? 'added' : c.status === 'D' ? 'deleted' : 'changed';
    if (named.has(room)) notices.push({ path: c.path, why: `baseline ${verb} for room "${room}" (named; needs the independent review)` });
    else problems.push({ path: c.path, why: `baseline ${verb} without a "Baseline-change: ${room} — <why>" line in the PR description` });
  }
  return { problems, notices };
}

/** Each changed test file's assertion count change, for the log. */
export function assertionDeltas(changes) {
  return changes
    .filter((c) => TEST_FILE.test(c.path) && c.status === 'M')
    .map((c) => ({ path: c.path, removed: count(c.removed), added: count(c.added) }))
    .filter((d) => d.removed || d.added);
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
    .filter(([, p]) => TEST_FILE.test(p) || PW_CONFIG.test(p) || BASELINE.test(p));
  return names.map(([status, path]) => {
    let removed = [];
    let added = [];
    if (status !== 'D' && !BASELINE.test(path)) {
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
  eq(t({ added: ["  describe.skip('account closure (Postgres unavailable)', () => {"] }).length, 0, 'journalled no-database skip is fine');
  eq(
    t({ added: ["  describe.skip('a (Postgres unavailable)', () => { it.skip('x', () => {}); });"] }).length,
    1,
    'second skip on the same line still flagged',
  );
  eq(t({ added: ["  describe.skip('account closure', () => {"] }).length, 1, 'other describe.skip still flagged');
  eq(t({ added: ["  it.skip('x (Postgres unavailable)', () => {})"] }).length, 1, 'it.skip still flagged');
  eq(t({ added: ["  it('skips the empty case', () => {"] }).length, 0, 'word skip in a title is fine');
  eq(t({ removed: ['  expect(a).toBe(1);', '  expect(b).toBe(2);'], added: ['  expect(a).toBe(1);'] }).length, 1, 'fewer assertions');
  eq(t({ removed: ['  expect(a).toBe(1);'], added: ['  expect(a).toBe(2);', '  expect(c).toBe(3);'] }).length, 0, 'more assertions fine');
  eq(t({ removed: ['  expect(a).toEqual({ x: 1 });'], added: ['  expect(a).toBeDefined();'] }).length, 1, 'weaker matcher');
  eq(judge([{ path: 'a/x.test.ts', status: 'D', removed: [], added: [], sourceExists: true }]).length, 1, 'deleted with source');
  eq(judge([{ path: 'a/x.test.ts', status: 'D', removed: [], added: [], sourceExists: false }]).length, 0, 'deleted with source gone');
  eq(judge([{ path: 'a/x.ts', status: 'M', removed: ['expect(a)'], added: [], sourceExists: true }]).length, 0, 'non-test ignored');
  eq(DECLARED.test('Why\n\nTest-change: removed the legacy vue snapshot test'), true, 'declared line');
  eq(DECLARED.test('Test-change: n/a'), false, 'declaration needs a real reason');
  // Browser journeys and harnesses.
  const pw = (c) =>
    judge([{ path: 'apps/customer/tests/real-app/J-x-01.pw.mjs', status: 'M', removed: [], added: [], sourceExists: true, ...c }]);
  eq(pw({ added: ["  test.skip(!process.env.X, 'no stack');"] }).length, 1, 'journey skip added');
  eq(pw({ added: ["test.describe.fixme('J-x-01', () => {"] }).length, 1, 'journey fixme added');
  eq(pw({ removed: ["  await expect(page.getByRole('button')).toBeVisible();"], added: [] }).length, 1, 'journey assertion removed');
  eq(
    pw({
      removed: ["  await expect(page.locator('.cta')).toBeVisible();"],
      added: ["  await expect(page.getByRole('button', { name: 'Buy' })).toBeVisible();"],
    }).length,
    0,
    'locator rewrite keeps the assertion',
  );
  eq(
    pw({ removed: ["  await expect(row).toHaveText('£1.00');"], added: ['  await expect(row).toBeAttached();'] }).length,
    1,
    'journey matcher weakened',
  );
  eq(
    pw({ removed: ['  await expect(btn).toBeVisible();'], added: ['  await expect(btn).toBeAttached();'] }).length,
    1,
    'visible → attached',
  );
  eq(
    judge([{ path: 'apps/customer/src/screens/home/home.pw.mjs', status: 'D', removed: [], added: [], sourceExists: false }]).length,
    1,
    'harness deleted',
  );
  eq(
    pw({
      removed: ['  await expect(page).toHaveScreenshot({ maxDiffPixels: 10 });'],
      added: ['  await expect(page).toHaveScreenshot({ maxDiffPixels: 900 });'],
    }).length,
    1,
    'tolerance raised',
  );
  eq(pw({ added: ['  await expect(page).toHaveScreenshot({ maxDiffPixelRatio: 0.2 });'] }).length, 1, 'tolerance set where none was');
  eq(
    pw({
      removed: ['  await expect(page).toHaveScreenshot({ threshold: 0.2 });'],
      added: ['  await expect(page).toHaveScreenshot({ threshold: 0.1 });'],
    }).length,
    0,
    'tolerance tightened is fine',
  );
  eq(
    judge([
      { path: 'a/J.pw.mjs', status: 'A', removed: [], added: ['expect(page).toHaveScreenshot({ maxDiffPixels: 4 })'], sourceExists: true },
    ]).length,
    0,
    'a new file may set its tolerance',
  );
  eq(
    judge([{ path: 'apps/customer/tests/real-app/stack.mjs', status: 'M', removed: ['expect(a)'], added: [], sourceExists: true }]).length,
    0,
    'helper ignored',
  );
  // Baselines.
  const shot = (path, status = 'M') => ({ path, status });
  const b = (changes, body) => judgeBaselines(changes, body);
  eq(b([shot('apps/customer/look-baselines/home/390x844.png')], '').problems.length, 1, 'unnamed baseline change');
  eq(
    b([shot('apps/customer/look-baselines/home/390x844.png')], 'Test-change: the whole home room was redrawn').problems.length,
    1,
    'Test-change does not cover a baseline',
  );
  eq(
    b([shot('apps/customer/look-baselines/home/390x844.png')], 'x\nBaseline-change: home — new hero card\n').problems.length,
    0,
    'named room',
  );
  eq(
    b([shot('apps/customer/look-baselines/home/390x844.png')], 'Baseline-change: home — hero card redrawn').notices.length,
    1,
    'named room is a notice',
  );
  eq(
    b([shot('apps/customer/look-baselines/home/390x844.png')], 'Baseline-change: money — chart moved up').problems.length,
    1,
    'other room named',
  );
  eq(
    b([shot('packages/ui/look-baselines/kit-buttons/phone/1.png', 'A')], 'Baseline-change: kit-buttons — first pictures').problems.length,
    0,
    'new baseline, room named, nested',
  );
  eq(b([shot('apps/customer/look-baselines/home/a.png')], 'Baseline-change: home').problems.length, 1, 'a bare room name is not enough');
  eq(b([shot('apps/customer/look-baselines/home/a.png')], 'Baseline-change: home — x').problems.length, 1, 'the reason needs 8 characters');
  eq(b([shot('apps/customer/look-baselines/trade desk/a.jpeg')], '').problems.length, 1, 'any room folder and format');
  eq(b([shot('packages/ui/look-baselines/kit-buttons/1.png', 'D')], '').problems.length, 1, 'deleted baseline unnamed');
  eq(b([shot('apps/customer/src/assets/logo.png')], '').problems.length, 0, 'other image ignored');
  eq(
    [...declaredRooms('Baseline-change: home\nBaseline-change: trade-desk — moved the chart\n')].join(','),
    'trade-desk',
    'rooms read (a bare name does not count)',
  );
  eq(
    assertionDeltas([
      { path: 'a/J.pw.mjs', status: 'M', removed: ['expect(a).toBe(1)'], added: ['expect(a).toBe(1); expect(b).toBe(2)'] },
    ])[0].added,
    2,
    'assertion delta counted',
  );
  console.log('✓ test-diff-guard --self-test OK (45 fixtures)');
}

if (process.argv.includes('--self-test')) {
  selfTest();
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.env.GUARD_BASE || 'origin/main';
  const body = process.env.PR_BODY || '';
  const changes = collect(base);
  for (const d of assertionDeltas(changes))
    console.log(
      `  assertions ${d.path}: ${d.removed} removed, ${d.added} added (net ${d.added - d.removed >= 0 ? '+' : ''}${d.added - d.removed})`,
    );
  const problems = judge(changes);
  const baselines = judgeBaselines(changes, body);
  for (const n of baselines.notices) console.log(`⚠ ${n.path}\n    → ${n.why}`);
  const esc = (t) => String(t).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  // One annotation per finding (GitHub keeps 10 per step), so `tooling/ci/why-red.mjs` names them without the job log.
  const annotate = (list) => {
    if (!process.env.GITHUB_ACTIONS) return;
    for (const p of list.slice(0, 10))
      console.log(`::error file=${esc(p.path).replace(/:/g, '%3A').replace(/,/g, '%2C')},title=Test-diff guard::${esc(p.why)}`);
  };
  const declared = DECLARED.test(body);
  // GitHub keeps 10 annotations per step: the test findings the Test-change line does not cover come first.
  annotate([...(declared ? [] : problems), ...baselines.problems]);
  let failed = false;
  if (baselines.problems.length > 0) {
    console.error(`\n✖ test-diff-guard FAILED — ${baselines.problems.length} unnamed baseline change(s)\n`);
    for (const p of baselines.problems) console.error(`  ${p.path}\n    → ${p.why}\n`);
    console.error(
      '  Change a baseline only in its own reviewed commit, and name each room on a line "Baseline-change: <room> — <why>" (a reason of 8 or more characters).',
    );
    failed = true;
  }
  if (problems.length === 0) {
    if (!failed) console.log('✓ test-diff-guard clean — no test was deleted, skipped or weakened');
    process.exit(failed ? 1 : 0);
  }
  const head = declared
    ? '⚠ test-diff-guard — declared test change (Test-change: line present); reviewer must check it'
    : '✖ test-diff-guard FAILED';
  console.error(`\n${head} — ${problems.length} finding(s)\n`);
  for (const p of problems) console.error(`  ${p.path}\n    → ${p.why}\n`);
  if (!declared) {
    console.error('  If a change is intended, say why in the PR description on a line starting "Test-change:".');
    failed = true;
  }
  process.exit(failed ? 1 : 0);
}
