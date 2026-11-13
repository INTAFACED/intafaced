#!/usr/bin/env node
/**
 * TEST-DIFF GUARD — a PR may not loosen the tests it is judged by.
 *
 * Reads the diff against origin/main and fails on:
 *   1. a skip, todo, only or fixme added to a test (`.skip(`, `xit(`, `it.todo(`, `test.fixme(` …);
 *   2. a test file deleted while its source file still exists (a journey or harness file, `*.pw.mjs`, has no one
 *      source file, so deleting one always counts, a journey step file included);
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
 * Checks 1 (all but a focus: `.only`, `fit(`, `fdescribe(`, which drops every other test and stays here), 3, 4 and 5 leave an added or modified journey step file (`apps/customer/tests/real-app/J-*.pw.mjs`) to the test
 * judge (the CI review's test part) on a pull request its job runs for (same repository, base main): the seal needs the
 * judge's verdict (the CI review's Test verdict) on the exact head, and the judge reads each changed test against the step it proves, which no line in the description can stand
 * in for (judged-paths.mjs leftToJudge; R3 C6). A deleted journey file, look sweeps, harnesses, configs, unit tests and
 * any pull request the judge doesn't run for stay here: a PR that does one of 1-5 there on purpose says so in its
 * description with a line
 *   Test-change: <the reason a reviewer can check>
 * which turns the failure into a printed notice. The reviewer sees both. A Test-change line never covers 6.
 *
 * Only protected tests keep 2 and 3 as failures (protected-tests.mjs: money, custody, sign-in, permissions, database
 * suites and every `*.pw.mjs`). Elsewhere a deleted test file or a lower assertion count is a notice printed into the
 * job summary that needs no line: a test may be deleted or rewritten when what it guarded is still guarded, by a type,
 * a lint rule, another test or a journey step, and the pull request names which, and the CI review (REVIEW.md item 3)
 * reads that name. 1, 4, 5 and 6 are unchanged everywhere.
 *
 *   7. a test file deleted or loosened (deleted, or any of 1-5 found in it) that failed in a `Tests (…)` job on an
 *      earlier head of the same pull request. Never to get green: a failing test is fixed or its failure explained,
 *      not removed. No line clears 7, and when the earlier heads cannot be read it fails rather than pass unseen.
 *
 * Every run prints each changed test file's assertion count change, so a locator-only rewrite can show it kept them.
 *
 * main-bisect's automatic revert (a `revert/auto-<sha10>` branch the factory App opened, one commit that says it reverts
 * that commit, which main holds, and a diff that undoes exactly what that commit did: exact-revert.mjs) is not judged by
 * 1-5: it returns the tests to main's from before that commit, which main's runs proved (autoRevert below; intafaced
 * #8138 and #8149 were refused here for deleting the tests their culprits had added). 6 still applies to it.
 *
 * Rules come from MAIN: CI runs the copy of this file on origin/main, never the
 * PR's copy, so a PR cannot loosen the guard it is judged by. (CI falls back to
 * the PR copy only while main has none, i.e. the PR that introduces it.)
 *
 *   node tooling/ci/test-diff-guard.mjs                 uses origin/main, PR_BODY env
 *   node tooling/ci/test-diff-guard.mjs --self-test
 */
import { AUTO_REVERT_AUTHOR, AUTO_REVERT_BRANCH, REVERTS_COMMIT, exactReverse, revertTreeMatches } from './exact-revert.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { judgeRunsFor, leftToJudge } from './judged-paths.mjs';
import { BASELINE, roomOf } from './look-baselines.mjs';
import { protectedTest } from './protected-tests.mjs';

const TEST_FILE = /(?:\.(?:test|spec)\.(?:[cm]?[jt]sx?)$|\.pw\.mjs$|\/__tests__\/)/;
const BROWSER_TEST = /\.pw\.mjs$/;
// A Playwright config sets screenshot tolerances for a whole suite; only its tolerance lines are judged.
const PW_CONFIG = /(?:^|\/)(?:[\w.-]+\.)?playwright\.config\.[cm]?[jt]s$/;
// A focus marker runs one test and drops every other test in the run. The test judge reads only the steps a change
// touches, and a focused step still proves itself, so a focus stays the guard's in every file (review 7550-R1).
// Any `.only` member at all (`test.describe.serial.only(`, `test.only.each(`, a chained `.only(` on its own line,
// `test.only` with its `(` on the next line, an alias `const t = test.only;`), a bracketed one (`test['only'](`),
// `fit(` and `fdescribe(` (reviews 7550-R3 and the CI review on 6a5f1389): every form SKIP caught and more. The
// journeys config's forbidOnly backs it up.
const FOCUS = /\.only\b|\[\s*['"`]only['"`]\s*\]|\bf(?:it|describe)\s*\(/;
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
/** `judgeRuns`: the CI review job, which carries the test judge, runs for this pull request (judged-paths.mjs leftToJudge). */
export function judge(changes, { judgeRuns = false } = {}) {
  const problems = [];
  for (const c of changes) {
    // The test judge always rules on these, and the seal needs its verdict: neither these findings nor a Test-change line.
    if (leftToJudge(c, { judgeRuns })) {
      for (const l of c.added)
        if (FOCUS.test(l)) problems.push({ path: c.path, why: `focus added (runs this test alone): ${l.trim().slice(0, 100)}` });
      continue;
    }
    if (PW_CONFIG.test(c.path) && c.status === 'M') {
      const raised = toleranceRaised(c.path, c.removed, c.added);
      if (raised) problems.push({ path: c.path, why: `screenshot tolerance raised: ${raised}` });
      continue;
    }
    if (!TEST_FILE.test(c.path)) continue;
    // Outside the protected tests a deletion or a lower assertion count is a notice (`free`), not a failure.
    const free = !protectedTest(c.path);
    if (c.status === 'D') {
      if (BROWSER_TEST.test(c.path)) problems.push({ path: c.path, why: 'journey or harness file deleted' });
      else if (c.sourceExists) problems.push({ path: c.path, why: 'test file deleted while the code it tests still exists', free });
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
          free,
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

/**
 * The test files a `Tests (…)` job log says failed: vitest's ` FAIL  <file relative to its package> …` lines, with the
 * packages from turbo's `Failed: <pkg>#test, …` line. Escape codes and the runner's timestamps are stripped first.
 * @returns {{ packages: string[], files: string[] }}
 */
export function failedInLog(log) {
  const packages = new Set();
  const files = new Set();
  for (const raw of String(log ?? '').split('\n')) {
    const l = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '');
    const failed = /^\s*Failed:\s+(.+)$/.exec(l);
    if (failed) for (const t of failed[1].split(/[\s,]+/)) if (t.endsWith('#test')) packages.add(t.slice(0, -5).replace(/^@[^/]+\//, ''));
    const fail = /(?:^|[: ])FAIL {2}(\S+)/.exec(l);
    if (fail && TEST_FILE.test(fail[1])) files.add(fail[1].replace(/^\.\//, ''));
  }
  return { packages: [...packages], files: [...files] };
}

/** Whether repository path `path` is one of the failed files (package-relative) in one of the failed packages. */
export function failedEarlier(path, failures) {
  for (const f of failures) {
    if (!(path === f.file || path.endsWith(`/${f.file}`))) continue;
    const root = path.slice(0, path.length - f.file.length);
    // A log with no `Failed:` line names no package: then the file name alone decides (it can only fail more).
    if (f.packages.length === 0 || f.packages.some((p) => root.endsWith(`/${p}/`) || root === `${p}/`)) return f;
  }
  return null;
}

/**
 * Check 7: each test file the pull request deletes or loosens that failed on an earlier head. `loosened` are the
 * changed test paths with a deletion or a finding; `failures` come from earlierFailures().
 */
export function gotGreen(loosened, failures) {
  const out = [];
  for (const path of loosened) {
    const f = failedEarlier(path, failures);
    if (f)
      out.push({
        path,
        why: `deleted or loosened after it failed on an earlier head (${f.sha.slice(0, 10)}, ${f.job}): fix the test or explain its failure, never remove it to get green`,
      });
  }
  return out;
}

/**
 * The failed test files of every earlier head of this pull request: the CI workflow's pull_request runs on its branch
 * from its head repository, other than the current head, newest 20, and in each the failed `Tests (…)` jobs' logs.
 * `api(path)` returns parsed JSON for a REST path; `text(path)` a log's text. Either throws on a refusal, which the
 * caller turns into a failure.
 */
export async function earlierFailures({ repo, headRepo = repo, branch, headSha }, { api, text }) {
  const runs =
    (await api(`/repos/${repo}/actions/workflows/ci.yml/runs?branch=${encodeURIComponent(branch)}&event=pull_request&per_page=20`))
      .workflow_runs ?? [];
  const out = [];
  for (const run of runs) {
    if (run.head_sha === headSha || run.head_repository?.full_name !== headRepo) continue;
    const jobs = (await api(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`)).jobs ?? [];
    for (const job of jobs) {
      if (!/^Tests \(/.test(job.name) || job.conclusion !== 'failure') continue;
      const { packages, files } = failedInLog(await text(`/repos/${repo}/actions/jobs/${job.id}/logs`));
      for (const file of files) out.push({ sha: run.head_sha, job: job.name, packages, file });
    }
  }
  return out;
}

/** A REST reader on GITHUB_TOKEN; a refusal or a limit throws with the exact status, never retried. */
function restReader(token) {
  const get = async (path) => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} ${res.statusText} on ${path}`);
    return res;
  };
  return { api: async (p) => (await get(p)).json(), text: async (p) => (await get(p)).text() };
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

/**
 * The commit this pull request reverts, when it is main-bisect's automatic revert by every proof above; else null.
 * `pr`: { ref, author, authorType, commits, headRepo, repo, headSha }; `read(args)`: git's output, throwing on a failure.
 */
export function autoRevert(pr, base, read) {
  const branch = AUTO_REVERT_BRANCH.exec(String(pr?.ref ?? ''));
  if (!branch || pr.author !== AUTO_REVERT_AUTHOR || pr.authorType !== 'Bot' || String(pr.commits) !== '1') return null;
  if (!pr.repo || pr.headRepo !== pr.repo || !/^[0-9a-f]{40}$/.test(String(pr.headSha ?? ''))) return null;
  try {
    const culprit = REVERTS_COMMIT.exec(read(['log', '-1', '--format=%B', pr.headSha]))?.[1];
    if (!culprit || !culprit.startsWith(branch[1])) return null;
    if (read(['rev-list', '--parents', '-n', '1', culprit]).trim().split(' ').length !== 2) return null;
    read(['merge-base', '--is-ancestor', culprit, base]);
    const diff = read(['diff', '--no-renames', `${base}...${pr.headSha}`]);
    const was = read(['diff', '--no-renames', `${culprit}^`, culprit]);
    return exactReverse(diff, was) || revertTreeMatches(read, { culprit, head: pr.headSha }) ? culprit : null;
  } catch {
    return null;
  }
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

async function selfTest() {
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
  // Browser tests and harnesses outside the judged paths (a room's look sweep): the guard still holds them.
  const pw = (c) =>
    judge([{ path: 'apps/customer/src/screens/home/home.pw.mjs', status: 'M', removed: [], added: [], sourceExists: true, ...c }]);
  // A journey step file changed on a pull request the judge runs for is the judge's (judged-paths.mjs leftToJudge, R3 C6).
  const runs = { judgeRuns: true };
  const jf = (c, opts = runs, path = 'apps/customer/tests/real-app/J-x-01.pw.mjs') =>
    judge([{ path, status: 'M', removed: [], added: [], sourceExists: true, ...c }], opts);
  const skipLine = ["  test.skip(!process.env.X, 'no stack');"];
  eq(jf({ added: skipLine }).length, 0, 'journey step file: left to the test judge');
  eq(jf({ removed: ["  await expect(page.getByRole('button')).toBeVisible();"] }).length, 0, 'journey assertion: the judge');
  // Planted (review 7550-R1): a focus in a journey step file drops every other test, which the judge can't see.
  eq(jf({ added: ['test.only(`${J} #2 pays`, async ({ page }) => {'] }).length, 1, 'journey test.only: the guard');
  eq(jf({ added: ["test.describe.only('J-x-01', () => {"] }).length, 1, 'journey describe.only: the guard');
  for (const line of [
    "test.describe.serial.only('x', () => {",
    "test.describe.parallel.only('x', () => {",
    '  .only(',
    "test['only']('x', () => {",
    'test.only.each(rows)(',
    'test.only',
    'const t = test.only;',
    "describe.only ('x', () => {",
  ])
    eq(jf({ added: [line] }).length, 1, `journey focus ${line.trim()}: the guard`);
  eq(jf({ added: ["  test('only the owner sees it', async () => {"] }).length, 0, 'the word only in a title is fine');
  // Planted: everything the judge does not always rule on stays the guard's.
  eq(jf({ added: skipLine }, {}).length, 1, 'no judge job (a fork, another base): the guard');
  eq(jf({ status: 'D', sourceExists: false }).length, 1, 'a deleted journey file: the guard');
  eq(jf({ added: skipLine }, runs, 'apps/customer/tests/real-app/look-sweep-390.pw.mjs').length, 1, 'a look sweep in real-app: the guard');
  eq(
    jf({ added: ["  it.skip('x', () => {})"] }, runs, 'apps/customer/tests/real-app/harness.test.mjs').length,
    1,
    'a unit test in real-app: the guard',
  );
  eq(
    jf(
      { removed: ['  use: { maxDiffPixelRatio: 0.01 },'], added: ['  use: { maxDiffPixelRatio: 0.5 },'] },
      runs,
      'apps/customer/tests/real-app/real-app.playwright.config.mjs',
    ).length,
    1,
    'the journeys config tolerance: the guard',
  );
  eq(
    judge([
      { path: 'tooling/scripts/journey-shards.test.mjs', status: 'M', removed: ['assert.equal(a, 1)'], added: [], sourceExists: true },
    ]).length,
    1,
    "a unit test under tooling/scripts/, which the judge skips, is still the guard's",
  );
  eq(
    judge([{ path: 'services/svc-pay/src/a.test.ts', status: 'M', removed: [], added: ["  it.skip('x', () => {})"], sourceExists: true }])
      .length,
    1,
    "a service unit test is still the guard's",
  );
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
    judge([{ path: 'apps/customer/src/screens/home/stack.mjs', status: 'M', removed: ['expect(a)'], added: [], sourceExists: true }])
      .length,
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
  // main-bisect's automatic revert (intafaced #8138, #8149): every proof, and each one missing.
  const C = 'c'.repeat(40);
  const H = 'd'.repeat(40);
  const was = 'diff --git a/t.test.ts b/t.test.ts\n--- a/t.test.ts\n+++ b/t.test.ts\n@@ -1,2 +1,3 @@\n a\n+expect(x).toBe(1);\n b\n';
  const back = 'diff --git a/t.test.ts b/t.test.ts\n--- a/t.test.ts\n+++ b/t.test.ts\n@@ -1,3 +1,2 @@\n a\n-expect(x).toBe(1);\n b\n';
  const pr = {
    ref: `revert/auto-${C.slice(0, 10)}`,
    author: 'intafaced-mac-agents[bot]',
    authorType: 'Bot',
    commits: '1',
    headRepo: 'o/r',
    repo: 'o/r',
    headSha: H,
  };
  const reader =
    ({ diff = back, msg = `Revert x\n\nThis reverts commit ${C}.\n`, onMain = true, parents = `${C} p` } = {}) =>
    (args) => {
      if (args[0] === 'log') return msg;
      if (args[0] === 'rev-list') return parents;
      if (args[0] === 'merge-base') {
        if (!onMain) throw new Error('not an ancestor');
        return '';
      }
      if (args[0] === 'diff') return args[2] === `${C}^` ? was : diff;
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
  eq(autoRevert(pr, 'origin/main', reader()), C, 'an automatic revert by every proof');
  eq(autoRevert({ ...pr, author: 'someone' }, 'origin/main', reader()), null, 'not opened by the App');
  eq(autoRevert({ ...pr, authorType: 'User' }, 'origin/main', reader()), null, 'not a Bot');
  eq(autoRevert({ ...pr, ref: 'fix/x' }, 'origin/main', reader()), null, 'not a revert/auto- branch');
  eq(autoRevert({ ...pr, commits: '2' }, 'origin/main', reader()), null, 'more than one commit');
  eq(autoRevert({ ...pr, headRepo: 'fork/r' }, 'origin/main', reader()), null, 'from a fork');
  eq(autoRevert(pr, 'origin/main', reader({ msg: 'no revert line' })), null, 'its commit says no revert');
  eq(autoRevert(pr, 'origin/main', reader({ onMain: false })), null, 'the commit is not on main');
  eq(autoRevert(pr, 'origin/main', reader({ parents: `${C} p q` })), null, 'a merge commit');
  eq(
    autoRevert(pr, 'origin/main', reader({ diff: back.replace('-expect(x).toBe(1);', '-expect(x).toBe(2);') })),
    null,
    'planted fault: not exactly its reverse',
  );
  eq(
    autoRevert(pr, 'origin/main', reader({ diff: `${back}diff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-a\n+b\n` })),
    null,
    'planted fault: one more file',
  );
  await protectedSelfTest(eq);
  console.log('✓ test-diff-guard --self-test OK (99 fixtures)');
}

/** Planted cases for the protected tests (protected-tests.mjs) and check 7. */
async function protectedSelfTest(eq) {
  const blocking = (changes, opts) => judge(changes, opts).filter((p) => !p.free).length;
  const freed = (changes, opts) => judge(changes, opts).filter((p) => p.free).length;
  const del = (path) => [{ path, status: 'D', removed: [], added: [], sourceExists: true }];
  const fewer = (path) => [{ path, status: 'M', removed: ["  it('x', () => { expect(a).toBe(1); });"], added: [], sourceExists: true }];
  // Planted: a placeholder test deleted outside the protected tests passes with no line, as a notice.
  eq(blocking(del('apps/customer/src/screens/home/home-card.test.tsx')), 0, 'placeholder file deleted, not protected: no failure');
  eq(freed(del('apps/customer/src/screens/home/home-card.test.tsx')), 1, 'placeholder file deleted, not protected: a notice');
  eq(blocking(fewer('packages/i18n/src/keys.test.ts')), 0, 'a case removed, not protected: no failure');
  // Planted: protected tests fail as today.
  eq(blocking(fewer('services/svc-academy/src/paper/real-money-ban.money.test.ts')), 1, 'a *.money.test.ts case removed: fails as today');
  eq(blocking(del('services/svc-academy/src/paper/real-money-ban.money.test.ts')), 1, 'a *.money.test.ts file deleted: fails as today');
  eq(blocking(fewer('services/svc-ledger/src/posting.test.ts')), 1, 'a money root (MONEY_PATH_ROOTS): fails as today');
  eq(blocking(fewer('services/svc-tax/src/a.db.test.ts')), 1, 'a *.db.test.ts: fails as today');
  eq(blocking(fewer('services/svc-tax/src/a.pg.test.ts')), 1, 'a *.pg.test.ts: fails as today');
  eq(blocking(fewer('services/svc-identity/src/x.test.ts')), 1, 'svc-identity: fails as today');
  eq(blocking(fewer('packages/auth/src/x.test.ts')), 1, 'packages/auth: fails as today');
  eq(blocking(fewer('apps/customer/src/features/public/AuthForm.test.tsx')), 1, 'a sign-in test by name: fails as today');
  eq(blocking(fewer('apps/admin/src/lib/operator-access.test.ts')), 1, 'a permissions test by name: fails as today');
  eq(blocking(fewer('apps/admin/src/lib/custody-ops/model.test.ts')), 1, 'a custody test by folder: fails as today');
  eq(blocking(fewer('apps/customer/src/features/protocol/wallet/SessionKeysPanel.test.tsx')), 1, 'camelCase split: SessionKeys');
  eq(blocking(del('apps/customer/src/screens/home/home.pw.mjs')), 1, 'a harness deleted: fails as today');
  eq(
    blocking([
      {
        path: 'apps/customer/tests/real-app/J-x-01.pw.mjs',
        status: 'M',
        removed: ['  await expect(a).toBeVisible();'],
        added: [],
        sourceExists: true,
      },
    ]),
    1,
    'a journey test edit, no judge job: fails as today',
  );
  eq(
    blocking([{ path: 'apps/customer/tests/real-app/J-x-01.pw.mjs', status: 'D', removed: [], added: [], sourceExists: false }], {
      judgeRuns: true,
    }),
    1,
    'a journey test deleted: fails as today',
  );
  // Unchanged outside the protected tests: a skip, a weaker matcher.
  eq(
    blocking([{ ...fewer('packages/i18n/src/keys.test.ts')[0], removed: [], added: ["  it.skip('x', () => {})"] }]),
    1,
    'skip added anywhere: fails',
  );
  eq(
    blocking([
      { ...fewer('packages/i18n/src/keys.test.ts')[0], removed: ['  expect(a).toEqual(1);'], added: ['  expect(a).toBeDefined();'] },
    ]),
    1,
    'weaker matcher anywhere: fails',
  );
  // Check 7: the log reader and the match.
  const log = [
    '2026-11-13T05:17:14.7515515Z \x1b[31m FAIL \x1b[39m src/edge-trust.test.ts [ src/edge-trust.test.ts ]',
    '2026-11-13T05:17:14.7523672Z  FAIL  src/engine/checks.test.ts > checks > refuses a stale bar',
    '2026-11-13T05:17:20.0000000Z  Failed:    @intafaced/svc-quant#test',
    '2026-11-13T05:17:20.0000000Z  FAIL  is the word in a sentence about nothing',
  ].join('\n');
  const read = failedInLog(log);
  eq(read.packages.join(), 'svc-quant', 'failed packages read');
  eq(read.files.sort().join(), 'src/edge-trust.test.ts,src/engine/checks.test.ts', 'failed files read');
  const failures = read.files.map((file) => ({ sha: 'a'.repeat(40), job: 'Tests (changed)', packages: read.packages, file }));
  eq(gotGreen(['services/svc-quant/src/edge-trust.test.ts'], failures).length, 1, 'planted: deleted after it failed: fails');
  eq(gotGreen(['services/svc-tax/src/edge-trust.test.ts'], failures).length, 0, 'same name, another package: not this failure');
  eq(gotGreen(['services/svc-quant/src/engine/bars.test.ts'], failures).length, 0, 'a test that did not fail: no finding');
  // earlierFailures reads only earlier heads of this branch from the head repository, and only failed Tests jobs.
  const H = 'h'.repeat(40);
  const api = async (path) => {
    if (path.includes('/workflows/ci.yml/runs'))
      return {
        workflow_runs: [
          { id: 1, head_sha: H, head_repository: { full_name: 'o/r' } },
          { id: 2, head_sha: 'a'.repeat(40), head_repository: { full_name: 'o/r' } },
          { id: 3, head_sha: 'b'.repeat(40), head_repository: { full_name: 'fork/r' } },
        ],
      };
    if (path.endsWith('/runs/2/jobs?per_page=100'))
      return {
        jobs: [
          { id: 20, name: 'Tests (changed)', conclusion: 'failure' },
          { id: 21, name: 'Doctrine gates', conclusion: 'failure' },
          { id: 22, name: 'Tests (3/16)', conclusion: 'success' },
        ],
      };
    throw new Error(`unexpected ${path}`);
  };
  const text = async (path) => {
    if (path.endsWith('/jobs/20/logs')) return log;
    throw new Error(`unexpected ${path}`);
  };
  const got = await earlierFailures({ repo: 'o/r', branch: 'x', headSha: H }, { api, text });
  eq(got.length, 2, 'earlier failures: one failed Tests job on one earlier head');
  let refused = '';
  await earlierFailures(
    { repo: 'o/r', branch: 'x', headSha: H },
    {
      api: async () => {
        throw new Error('GitHub 403 Forbidden');
      },
      text,
    },
  ).catch((e) => (refused = e.message));
  eq(refused, 'GitHub 403 Forbidden', 'a refusal is thrown, never read as no failures');
}

if (process.argv.includes('--self-test')) {
  await selfTest();
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
  // ci-review.yml's judge job runs for a same-repository pull request into main (its `judge` job condition).
  const judgeRuns = judgeRunsFor({
    baseRef: process.env.GITHUB_BASE_REF,
    headRepo: process.env.PR_HEAD_REPO,
    repo: process.env.GITHUB_REPOSITORY,
  });
  if (judgeRuns) console.log("journey step files (J-*.pw.mjs) changed here are the test judge's (its verdict is required by the seal)");
  const reverted = autoRevert(
    {
      ref: process.env.PR_HEAD_REF,
      author: process.env.PR_AUTHOR,
      authorType: process.env.PR_AUTHOR_TYPE,
      commits: process.env.PR_COMMITS,
      headRepo: process.env.PR_HEAD_REPO,
      repo: process.env.GITHUB_REPOSITORY,
      headSha: process.env.PR_HEAD_SHA,
    },
    base,
    git,
  );
  if (reverted)
    console.log(
      `main-bisect's automatic revert of ${reverted.slice(0, 10)}: its diff undoes exactly that commit, which main holds, so checks 1-5 don't judge it (its tests return to main's from before it)`,
    );
  const found = reverted ? [] : judge(changes, { judgeRuns });
  // Outside the protected tests a deletion or a lower assertion count is printed into the job summary, needing no line.
  const notes = found.filter((p) => p.free);
  const problems = found.filter((p) => !p.free);
  for (const n of notes) console.log(`ℹ ${n.path}\n    → ${n.why} (not a protected test: the pull request names what still guards it)`);
  if (notes.length && process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Tests deleted or with fewer assertions (not protected tests)\n\nThe pull request names, by a rule id, a test path or a step id, what still guards each; the CI review reads it.\n\n${notes.map((n) => `- \`${n.path}\`: ${n.why}`).join('\n')}\n`,
    );
  }
  // Check 7: a test deleted or loosened after it failed on an earlier head of this pull request. No line clears it.
  const loosened = reverted
    ? []
    : [...new Set([...changes.filter((c) => c.status === 'D' && TEST_FILE.test(c.path)).map((c) => c.path), ...found.map((p) => p.path)])];
  let green = [];
  if (loosened.length && process.env.PR_HEAD_REF && process.env.GITHUB_REPOSITORY) {
    try {
      const failures = await earlierFailures(
        {
          repo: process.env.GITHUB_REPOSITORY,
          headRepo: process.env.PR_HEAD_REPO || process.env.GITHUB_REPOSITORY,
          branch: process.env.PR_HEAD_REF,
          headSha: process.env.PR_HEAD_SHA,
        },
        restReader(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''),
      );
      green = gotGreen(loosened, failures);
      console.log(
        `earlier heads read: ${new Set(failures.map((f) => f.sha)).size} with a failed Tests job; ${green.length} deleted or loosened test(s) failed there`,
      );
    } catch (e) {
      green = [
        {
          path: loosened[0],
          why: `could not read this pull request's earlier heads to check a deleted or loosened test did not fail there: ${e.message}`,
        },
      ];
    }
  }
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
  annotate([...green, ...(declared ? [] : problems), ...baselines.problems]);
  let failed = false;
  if (green.length > 0) {
    console.error(`\n✖ test-diff-guard FAILED — ${green.length} test(s) removed or loosened after failing (no line clears this)\n`);
    for (const p of green) console.error(`  ${p.path}\n    → ${p.why}\n`);
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
        notes.length
          ? `✓ test-diff-guard clean — ${notes.length} notice(s) above on tests that are not protected, none on a protected test`
          : '✓ test-diff-guard clean — no test was deleted, skipped or weakened',
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
