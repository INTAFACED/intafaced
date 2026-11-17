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
 * The owner's decision of 12 Nov 2026 (REVIEW.md, project-state row d76), that a test may be deleted or rewritten when
 * what it guarded is still guarded and the pull request names which, is carried by that line: for 2 and 3 its reason
 * names what still guards the test (a type, a lint rule id, a test path or a journey step id), and the CI review judges
 * it. Every test keeps 1-6. (A list of which tests could go without a line was tried on #8252 and dropped: three CI
 * reviews in a row found a money, sign-in or permission test it freed.)
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
 */
import { AUTO_REVERT_AUTHOR, AUTO_REVERT_BRANCH, REVERTS_COMMIT, exactReverse, revertTreeMatches } from './exact-revert.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { judgeRunsFor, leftToJudge } from './judged-paths.mjs';
import { BASELINE, roomOf } from './look-baselines.mjs';

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
// The same branch through `packages/db`'s one sanctioned probe, `postgresAvailable`, which throws on CI
// (`postgresRequired`), so the suite can't skip there: `describe.skipIf(!ready)(…)` / `describe.runIf(ready)(…)` on a
// name the file assigns from `await postgresAvailable(…)`, or `describe.skip('<suite> (Postgres unavailable — <hint>)', …)`
// in a file that calls it. Any other condition, title or file stays a finding. (project-state#2512: intafaced #8404,
// #8387 and #8377 lost five pushes to these shapes, all already gated by the probe.)
const PROBED = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+postgresAvailable\s*\(/g;
const PROBED_SKIP = /^\s*describe\.(?:skipIf\(\s*!\s*([A-Za-z_$][\w$]*)\s*\)|runIf\(\s*([A-Za-z_$][\w$]*)\s*\))\s*\(/;
const PROBED_TITLE_SKIP = /^\s*describe\.skip\(\s*(['"`])[^'"`]+ \(Postgres unavailable[^)'"`]*\)\1\s*,/;

/** The part of a skip line the probe accounts for removed, so what is left is judged; `file` is the test file at HEAD. */
export function withoutProbedSkip(line, file) {
  const l = line.replace(PG_UNAVAILABLE_SKIP, '');
  if (l !== line || !/\bpostgresAvailable\s*\(/.test(file ?? '')) return l;
  const names = new Set([...(file ?? '').matchAll(PROBED)].map((m) => m[1]));
  const m = PROBED_SKIP.exec(line);
  if (m && names.has(m[1] ?? m[2])) return line.slice(m[0].length);
  return line.replace(PROBED_TITLE_SKIP, '');
}
const ASSERT = /\b(?:expect(?:\.\w+)?|assert(?:\.\w+)?|t\.(?:is|equal|deepEqual|throws|true|false|truthy|falsy))\s*\(/g;
const WEAK_MATCHER = /\.(?:toBeDefined|toBeTruthy|toBeFalsy|toBeUndefined|not\.toBeNull|toBeInstanceOf|toBeAttached)\s*\(/;
const STRONG_MATCHER =
  /\.(?:(?:toBe|toEqual|toStrictEqual|toMatchObject|toHaveBeenCalledWith|toHaveLength|toContain|toMatch|rejects\.toThrow|toThrow|toHaveText|toContainText|toHaveValue|toHaveURL|toHaveAttribute|toHaveCount|toHaveScreenshot)\s*\([^)]|toBeVisible\s*\()/;
// `threshold` is a common business word, so it counts only in browser tests and their configs.
const TOLERANCE = /\b(maxDiffPixels|maxDiffPixelRatio)\s*:\s*([\d.]+)/g;
const BROWSER_TOLERANCE = /\b(maxDiffPixels|maxDiffPixelRatio|threshold)\s*:\s*([\d.]+)/g;
export const DECLARED = /^\s*Test-change:\s*\S.{7,}$/m;
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
    if (c.status === 'D') {
      if (BROWSER_TEST.test(c.path)) problems.push({ path: c.path, why: 'journey or harness file deleted' });
      else if (c.sourceExists) problems.push({ path: c.path, why: 'test file deleted while the code it tests still exists' });
      continue;
    }
    for (const l of c.added) {
      if (SKIP.test(withoutProbedSkip(l, c.text ?? c.added.join('\n'))))
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

/**
 * Whether the code a deleted test file tests still exists: `x.test.ts` tests `x.ts` (or `x.tsx`), and a suite-named
 * test (`x.money.test.ts`, `x.db.test.ts`, `x.pg.test.ts`, …) tests `x.ts` when no `x.money.ts` exists. (Failure it
 * prevents: deleting `packages/ledger-client/src/recipes/builder-fee.money.test.ts` while `builder-fee.ts` stayed
 * passed the guard clean, because only `builder-fee.money.ts` was looked for.)
 */
export function sourceFor(path, exists = existsSync) {
  const src = path.replace(/\.(?:test|spec)(\.[cm]?[jt]sx?)$/, '$1');
  if (src === path) return false;
  const withAlt = (p) => [p, p.replace(/\.tsx?$/, (m) => (m === '.ts' ? '.tsx' : '.ts'))];
  const suite = src.replace(/\.[a-z][a-z0-9-]*(\.[cm]?[jt]sx?)$/, '$1');
  const candidates = [...withAlt(src), ...(suite !== src ? withAlt(suite) : [])];
  return candidates.some((p) => exists(p));
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
    // The file at HEAD, so a Postgres skip can be read against the probe it is gated by (withoutProbedSkip).
    const text = status === 'D' || BASELINE.test(path) ? '' : git(['show', `HEAD:${path}`]);
    return { path, status: status[0], removed, added, text, sourceExists: status === 'D' ? sourceFor(path) : true };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
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
  const problems = found;
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
