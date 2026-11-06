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
 *   7. a journey step's test (a `test(` in a `*.pw.mjs` file titled `J-x-NN #n`) written or loosened by the PR that
 *      builds it (owner decision 2026-11-06: someone other than the builder writes each step's test from the step's
 *      words, and the builder makes it pass). A step's test is added only by a tests-only PR (test files, files
 *      under a `tests/` folder and the journey baseline), and carries a comment line directly above it or inside it
 *        // Test-writer: <who wrote it, from the step's words>
 *      A PR that changes anything else may change a step's test only when that test already has the line on main,
 *      and then may not remove the line or loosen the test (1, 3 and 4 above, judged on that test alone).
 *      PRs numbered below FIRST_STEP_PR were opened before this rule and get 7 as a notice.
 *
 * Tests are `.test.`/`.spec.` files, `__tests__/` folders, and the browser journeys and harnesses (`*.pw.mjs`).
 *
 * A PR that does one of 1-5 on purpose says so in its description with a line
 *   Test-change: <the reason a reviewer can check>
 * which turns the failure into a printed notice. The reviewer sees both. A Test-change line never covers 6 or 7.
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
import { existsSync, readFileSync } from 'node:fs';
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

// 7. Step tests come from a test-writer. STEP_TITLE is the scoreboard's (tooling/ci/journey-verdict.mjs).
/** PRs numbered below this were opened before rule 7 and get it as a notice. */
export const FIRST_STEP_PR = 7300;
const STEP_TITLE = /^(J-[a-z0-9-]+-\d+)\s+#(\d+)\b/;
const TEST_CALL = /^(\s*)test(?:\.(?:only|skip|fixme|fail))?\(\s*(?:`((?:[^`\\]|\\.)*)`|(['"])((?:(?!\3)[^\\]|\\.)*)\3)/;
const JOURNEY_CONST = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])(J-[a-z0-9-]+-\d+)\2\s*;?\s*$/;
const WRITER_MARK = /^\s*\/\/\s*Test-writer:\s*\S/;
/** What a tests-only PR may touch: tests, test folders and the journey baseline. */
const TESTS_ONLY = (p) => TEST_FILE.test(p) || /(?:^|\/)tests\//.test(p) || p === 'docs/runbooks/journey-baseline.json';

/**
 * Each journey step's test in a `*.pw.mjs` file, by step (`J-x-NN #n`): its lines (the comment lines directly above
 * the `test(` line through its closing `});`), and whether it carries the Test-writer line. A title is read with the
 * file's `const J = 'J-x-NN'` filled in; a title that only says "part of #n" is no step's test.
 * @returns {Map<string, {lines: string[], marked: boolean}>}
 */
export function stepTests(text) {
  const lines = String(text ?? '').split('\n');
  const names = new Map();
  for (const l of lines) {
    const m = JOURNEY_CONST.exec(l);
    if (m) names.set(m[1], m[3]);
  }
  const out = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = TEST_CALL.exec(lines[i]);
    if (!m) continue;
    const title = m[2] !== undefined ? m[2].replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (all, n) => names.get(n) ?? all) : m[4];
    const s = STEP_TITLE.exec(title);
    if (!s) continue;
    let start = i;
    while (start > 0 && /^\s*\/\//.test(lines[start - 1])) start--;
    let end = lines.length - 1;
    if (/\)\s*;\s*$/.test(lines[i]) && !/[{(]\s*$/.test(lines[i])) end = i;
    else {
      const close = new RegExp(`^${m[1]}\\}(?:\\)|,\\s*[^=]*\\))\\s*;?\\s*$`);
      for (let j = i + 1; j < lines.length; j++)
        if (close.test(lines[j])) {
          end = j;
          break;
        }
    }
    const key = `${s[1]} #${Number(s[2])}`;
    const block = lines.slice(start, end + 1);
    const had = out.get(key) ?? { lines: [], marked: false };
    out.set(key, { lines: [...had.lines, ...block], marked: had.marked || block.some((l) => WRITER_MARK.test(l)) });
    i = end;
  }
  return out;
}

/** Lines of `a` not in `b`, counted as a multiset. */
function minus(a, b) {
  const left = new Map();
  for (const l of b) left.set(l, (left.get(l) ?? 0) + 1);
  return a.filter((l) => {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    return n === 0;
  });
}

/**
 * Rule 7. `files` are the PR's changed `*.pw.mjs` files with their text on the base and the head ('' when absent);
 * `testsOnly` is whether every changed path is a test path.
 * @param {{path:string, before:string, after:string}[]} files
 */
export function judgeSteps(files, testsOnly) {
  const problems = [];
  const before = new Map();
  const after = new Map();
  const where = new Map();
  for (const f of files) {
    if (!BROWSER_TEST.test(f.path)) continue;
    for (const [k, v] of stepTests(f.before))
      before.set(k, { lines: [...(before.get(k)?.lines ?? []), ...v.lines], marked: before.get(k)?.marked || v.marked });
    for (const [k, v] of stepTests(f.after)) {
      after.set(k, { lines: [...(after.get(k)?.lines ?? []), ...v.lines], marked: after.get(k)?.marked || v.marked });
      where.set(k, f.path);
    }
    for (const k of stepTests(f.before).keys()) if (!where.has(k)) where.set(k, f.path);
  }
  const builds = 'a PR that also changes code outside tests';
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(key);
    const a = after.get(key);
    const path = where.get(key);
    if (b && a && b.lines.join('\n') === a.lines.join('\n')) continue;
    if (!b) {
      if (!testsOnly)
        problems.push({ path, why: `${key}: its test is added in ${builds}. A test-writer adds it first, in a tests-only PR.` });
      else if (!a.marked) problems.push({ path, why: `${key}: a new step test needs a "// Test-writer: <who>" line above it.` });
      continue;
    }
    if (b.marked && !a?.marked) {
      problems.push({ path, why: `${key}: the test-writer's test ${a ? 'lost its "// Test-writer:" line' : 'was removed'}.` });
      continue;
    }
    if (testsOnly) continue;
    if (!b.marked) {
      problems.push({
        path,
        why: `${key}: its test, which no test-writer wrote, is changed in ${builds}. Change it in a tests-only PR by a test-writer.`,
      });
      continue;
    }
    for (const p of judge([{ path, status: 'M', removed: minus(b.lines, a.lines), added: minus(a.lines, b.lines), sourceExists: true }]))
      problems.push({ path, why: `${key}: the test-writer's test is loosened: ${p.why}` });
  }
  return problems;
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

/** The changed journey files' text on the merge base and the head, and whether the PR changes only test paths. */
function collectSteps(base) {
  const since = git(['merge-base', base, 'HEAD']).trim();
  const changed = git(['diff', '--name-only', '--no-renames', `${base}...HEAD`])
    .split('\n')
    .filter(Boolean);
  const read = (ref, path) => {
    try {
      return execFileSync('git', ['show', `${ref}:${path}`], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return '';
    }
  };
  const files = changed.filter((p) => BROWSER_TEST.test(p)).map((path) => ({ path, before: read(since, path), after: read('HEAD', path) }));
  return { files, testsOnly: changed.every(TESTS_ONLY) };
}

/** The PR's number from the Actions event (or PR_NUMBER), or null. */
function prNumber() {
  if (process.env.PR_NUMBER) return Number(process.env.PR_NUMBER);
  try {
    return JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8')).pull_request?.number ?? null;
  } catch {
    return null;
  }
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
  // Rule 7: step tests come from a test-writer.
  const J = 'apps/customer/tests/real-app/J-x-01.pw.mjs';
  const file = (...tests) => ["import { test, expect } from './journey.mjs';", "const J = 'J-x-01';", '', ...tests].join('\n');
  const one = (n, body = ["  await expect(page.getByRole('button', { name: 'Buy' })).toBeVisible();"], mark = false) =>
    [
      ...(mark ? ["// Test-writer: written from the step's words by a thread that did not build it"] : []),
      `test(\`\${J} #${n} buys\`, async ({`,
      '  page,',
      '}) => {',
      "  await page.goto('/buy');",
      ...body,
      '});',
      '',
    ].join('\n');
  const s7 = (before, after, testsOnly = false) => judgeSteps([{ path: J, before, after }], testsOnly).length;
  const legacy = file(one(1), one(2));
  const marked = file(one(1, undefined, true), one(2));
  eq(stepTests(legacy).get('J-x-01 #1').lines.length, 6, 'a wrapped test reads to its closing line');
  eq(stepTests(file(one(1), one(1))).get('J-x-01 #1').lines.length, 12, 'two tests for one step are read together');
  eq(stepTests(marked).get('J-x-01 #1').marked && !stepTests(marked).get('J-x-01 #2').marked, true, 'the mark belongs to its own test');
  eq(stepTests(file('test(`${J} part of #2 buys`, async () => {', '});')).size, 0, '"part of #n" is no step');
  eq(stepTests("test('J-y-02 #3 sells', async () => {\n});").has('J-y-02 #3'), true, 'a literal title');
  eq(stepTests(file(['// Buys one coin.', one(1)].join('\n'))).get('J-x-01 #1').marked, false, 'a plain comment is not the line');
  eq(stepTests(file(['// Test-writer:', one(1)].join('\n'))).get('J-x-01 #1').marked, false, 'the line names who wrote it');
  eq(s7(legacy, legacy), 0, 'step tests untouched');
  eq(s7(legacy, file(one(1), one(2), one(3))), 1, 'planted: a build PR adds a step test');
  eq(s7(legacy, file(one(1), one(2), one(3)), true), 1, 'a tests-only PR adds a step test without the line');
  eq(s7(legacy, file(one(1), one(2), one(3, undefined, true)), true), 0, 'a test-writer adds a step test');
  eq(s7('', file(one(1, undefined, true))), 1, 'planted: a build PR adds a marked test in a new file');
  eq(s7(legacy, file(one(1, ['  await expect(page).toHaveURL(/buy/);']), one(2))), 1, 'planted: a build PR changes a builder-written test');
  eq(
    s7(legacy, file(one(1, ['  await expect(page).toHaveURL(/buy/);']), one(2)), true),
    0,
    'a tests-only PR changes a builder-written test',
  );
  eq(s7(legacy, file(one(1, undefined, true), one(2))), 1, 'planted: a build PR adds the line to a builder-written test');
  const relocated = ["  await expect(page.locator('[data-buy]')).toBeVisible();"];
  eq(s7(marked, file(one(1, relocated, true), one(2))), 0, "a build PR rewrites a test-writer's locator");
  eq(s7(marked, file(one(1, [], true), one(2))), 1, "planted: a build PR drops a test-writer's assertion");
  eq(
    s7(marked, file(one(1, ["  await expect(page.getByRole('button')).toBeAttached();"], true), one(2))),
    1,
    "planted: a build PR weakens a test-writer's matcher",
  );
  eq(s7(marked, file(one(1), one(2))), 1, 'planted: a build PR removes the Test-writer line');
  eq(
    s7(marked, file(['// Test-writer: x y z w', one(1).replace('test(', 'test.fixme(')].join('\n'), one(2))),
    1,
    "planted: a build PR marks a test-writer's test fixme",
  );
  eq(s7(marked, file(one(2))), 1, "planted: a build PR deletes a test-writer's test");
  eq(s7(marked, file(one(2)), true), 1, "a tests-only PR deletes a test-writer's test");
  eq(s7(legacy, legacy.replace("const J = 'J-x-01';", "const J = 'J-x-01';\nconst helper = 1;")), 0, 'a helper change outside step tests');
  eq(TESTS_ONLY('apps/customer/tests/real-app/lib/world.mjs') && TESTS_ONLY('docs/runbooks/journey-baseline.json'), true, 'test paths');
  eq(TESTS_ONLY('services/svc-trade/src/order.ts') || TESTS_ONLY('apps/customer/src/screens/buy.tsx'), false, 'code paths');
  console.log('✓ test-diff-guard --self-test OK (70 fixtures)');
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
  const steps = collectSteps(base);
  const stepFindings = judgeSteps(steps.files, steps.testsOnly);
  const pr = prNumber();
  const before = pr !== null && pr < FIRST_STEP_PR;
  if (before) for (const n of stepFindings) console.log(`⚠ ${n.path}\n    → ${n.why} (a notice: #${pr} was opened before this rule)`);
  const stepProblems = before ? [] : stepFindings;
  const esc = (t) => String(t).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  // One annotation per finding (GitHub keeps 10 per step), so `tooling/ci/why-red.mjs` names them without the job log.
  const annotate = (list) => {
    if (!process.env.GITHUB_ACTIONS) return;
    for (const p of list.slice(0, 10))
      console.log(`::error file=${esc(p.path).replace(/:/g, '%3A').replace(/,/g, '%2C')},title=Test-diff guard::${esc(p.why)}`);
  };
  const declared = DECLARED.test(body);
  // GitHub keeps 10 annotations per step: the test findings the Test-change line does not cover come first.
  annotate([...stepProblems, ...baselines.problems, ...(declared ? [] : problems)]);
  let failed = false;
  if (stepProblems.length > 0) {
    console.error(`\n✖ test-diff-guard FAILED — ${stepProblems.length} step test(s) not from a test-writer\n`);
    for (const p of stepProblems) console.error(`  ${p.path}\n    → ${p.why}\n`);
    console.error(
      "  A journey step's test is written from the step's words by someone other than its builder, in a tests-only PR, under a\n" +
        '  "// Test-writer: <who>" line; the builder makes it pass and may not loosen it. A Test-change line does not cover this.',
    );
    failed = true;
  }
  if (baselines.problems.length > 0) {
    console.error(`\n✖ test-diff-guard FAILED — ${baselines.problems.length} unnamed baseline change(s)\n`);
    for (const p of baselines.problems) console.error(`  ${p.path}\n    → ${p.why}\n`);
    console.error(
      '  Change a baseline only in its own reviewed commit, and name each room on a line "Baseline-change: <room> — <why>" (a reason of 8 or more characters).',
    );
    failed = true;
  }
  if (problems.length === 0) {
    if (!failed)
      console.log(
        `✓ test-diff-guard clean — no test was deleted, skipped or weakened${stepFindings.length ? '' : ', and no step test came from its builder'}`,
      );
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
