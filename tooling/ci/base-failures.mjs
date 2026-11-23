#!/usr/bin/env node
/**
 * BASE FAILURES — a pull request's Tests job is not held for a unit test that main already fails the same way.
 *
 * The owner's decision of 23 Nov 2026 (project-state#3859), poteto's rule: a problem the pull request's base already has
 * doesn't block it unless the pull request copies it. The look gate already judges this way (look-gate/policy.mjs
 * newFindings). Why: on 22 Nov main was red for about 8.5 hours, and every pull request whose tests reached the red
 * package was held for a failure it did not cause.
 *
 * What it excuses, and only on a pull request (main's own runs fail on every failing test, as before): a failing test
 * whose id (package, file, full name) and reason (its first error's first line) main's own Tests jobs recorded on the
 * commit this pull request merges into (its base: the merge commit's first parent) or, when main has no finished record
 * there, on the nearest commit before it on main's first-parent line that has one (nearestRecord, at most WALK commits
 * back). Main's CI runs one run at a time and a newer push cancels a queued one (ci.yml `concurrency`), so most of main's
 * commits never get a record: on 23 Nov, 11 of 12 pushes in 07:42-08:33 UTC were cancelled. Never excused:
 *   - a failure main did not record, or recorded for another reason;
 *   - a test of money, custody, sign-in or permissions, or a journey test (owner decision d76, ci-review/REVIEW.md):
 *     every test in money code (moneyDirsOf, the repo's money code list, at the head or the base), in packages/auth or
 *     apps/admin, any test whose file or name says money, sign-in or permissions (PROTECTED_WORDS), and any journey test;
 *   - a package whose failure is not read test by test: a run that crashed or reported nothing, an unhandled error, a
 *     command after its tests that did not run, a build or other task that failed, a test script this can't read;
 *   - a failure in a package whose folder a commit of main after that record changed (git diff record..base): what
 *     the record said about that package may no longer hold on the base;
 *   - anything when main's record is unknown: a base not on main, or none of the base and the WALK - 1 commits before it
 *     with a finished record (each has no run of main, a run not finished, cancelled, a Tests job without its record,
 *     or a record for another commit). Only then does it wait, while a run of main on one of those commits is not
 *     finished, up to WAIT_MIN minutes, and only when every failure held waits on that alone (needsMain).
 * It never waits once main's record is known, even when that record passed the test, failed it for another reason, or
 * is older than a change main made to what the test reads: main's CI is busy all day, so a newer run is nearly always
 * going, and a wait there made every pull request's own failure turn red about 20 minutes late, while a newer run
 * turning that record around (main breaking the test itself in its last few commits) is rare (owner decision of
 * 23 Nov 2026, project-state#3859 item 4).
 * The Tests job stays red for anything held, and its output names each failure excused, why, the commit whose record
 * it used, and main's run on it.
 *
 *   node tooling/ci/base-failures.mjs record --results <dir> --turbo <dir> --outcome <success|failure> --shard <s> --out <file>
 *       (every Tests job; GITHUB_SHA, GITHUB_EVENT_NAME, GITHUB_RUN_ATTEMPT): what this job failed, as data. On main it is
 *       kept as the artifact `test-results-<shard>-<attempt>` (artifactName) for pull requests to compare with.
 *   node tooling/ci/base-failures.mjs verdict --record <file>
 *       (a pull request's Tests job, when its tests failed; GH_TOKEN, GITHUB_REPOSITORY, BASE_SHA): exit 0 when every
 *       failure is excused, 1 otherwise. GET requests and `gh run download` only.
 * CI runs main's copy of this file on a pull request (ci.yml), so a pull request can't loosen the rule it is judged by.
 * Its tests: tooling/ci/base-failures.test.mjs.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { countCall } from './api-count.mjs';
import { githubFetch, githubToken } from './github-fetch.mjs';
import { refusalDetail } from './refusal.mjs';
import { runJobs } from './run-jobs.mjs';
import { REPORT_VERSION } from './test-results-reporter.mjs';

export const RECORD_VERSION = 1;
export const WORKFLOW = 'ci.yml';
export const WAIT_MIN = 10;
/** How far back main's first-parent line is read for a finished record: the base and the 39 commits before it. */
export const WALK = 40;
const POLL_MS = 60_000;
const TESTS_JOB = /^Tests \((.+)\)$/;

/** The artifact a Tests job keeps its record in: one per shard and attempt (a re-run's job writes its own). */
export const artifactName = (shard, attempt) => `test-results-${String(shard).replaceAll('/', '-of-')}-${attempt}`;

// ── a package's test script ─────────────────────────────────────────────────────────────────────────────────────────

const RUN_ALL = /^node\s+\S*tooling\/vitest\/run-all\.mjs((?:\s+\S+)+)$/;
const CONFIG = /config\.[cm]?[jt]s$/;

/**
 * How many vitest runs a `test` script makes when its tests run: { runs } or { why } when this can't tell. A plain `&&`
 * chain only; every command after the first vitest run must be a vitest run too, since a red run stops the chain and a
 * command after it would not have run (tooling/vitest/run-all.mjs runs several configs and always runs them all).
 */
export function vitestRuns(script) {
  const s = String(script ?? '').trim();
  if (!s) return { why: 'it has no test script' };
  if (/\|\||;|`|\$\(|(^|[^&])&([^&]|$)|\||[<>]/.test(s)) return { why: `its test script is not a plain && chain: \`${s}\`` };
  let runs = 0;
  for (const part of s.split('&&').map((p) => p.trim())) {
    const all = RUN_ALL.exec(part);
    const n = /^vitest run(\s|$)/.test(part)
      ? 1
      : all
        ? all[1]
            .trim()
            .split(/\s+/)
            .filter((a) => CONFIG.test(a)).length
        : 0;
    if (n === 0 && runs > 0) return { why: `\`${part}\` comes after its tests and would not have run after a red one` };
    runs += n;
  }
  return runs ? { runs } : { why: `its test script runs no vitest: \`${s}\`` };
}

// ── this job's record ───────────────────────────────────────────────────────────────────────────────────────────────

/** The id a failure is matched by, here and on main. */
export const failureId = (f) => `${f.package} › ${f.file} › ${f.name}`;

/** A reason as compared: colour codes and runs of white space gone. */
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
export const normReason = (s) =>
  String(s ?? '')
    .replace(COLOUR, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Why a failed package can't be read test by test from its reports, or null when it can. */
function unread({ script, reports, failures }) {
  const runs = vitestRuns(script);
  if (runs.why) return runs.why;
  if (reports.some((r) => r.v !== REPORT_VERSION)) return `a report of another version than ${REPORT_VERSION}`;
  if (reports.length !== runs.runs)
    return `${reports.length} of its ${runs.runs} vitest runs reported (a run that crashed, or did not start, reports nothing)`;
  const ended = reports.find((r) => r.reason !== 'passed' && r.reason !== 'failed');
  if (ended) return `a vitest run ended "${ended.reason}"`;
  const loose = reports.find((r) => r.unhandled?.length);
  if (loose) return `vitest caught ${loose.unhandled.length} unhandled error(s): ${loose.unhandled[0]}`;
  const silent = reports
    .flatMap((r) => r.failed ?? [])
    .find((m) => m.state === 'failed' && !m.tests?.length && !m.suites?.length && !m.errors?.length);
  if (silent) return `${silent.file} failed with no failing test or error recorded`;
  if (!failures.length) return 'turbo says its tests failed, but its vitest runs recorded no failure';
  return null;
}

/** One failed package as read from its vitest runs' reports: { explained, why?, failures }. */
export function explainPackage({ name, dir, exit, script, reports }) {
  const failures = [];
  for (const r of reports)
    for (const m of r.failed ?? []) {
      const add = (kind, n, errors) => failures.push({ package: name, dir, file: m.file, kind, name: n, reason: normReason(errors?.[0]) });
      for (const t of m.tests ?? []) add('test', t.name, t.errors);
      for (const s of m.suites ?? []) add('suite', `(suite) ${s.name}`, s.errors);
      if ((m.errors ?? []).length) add('file', '(file)', m.errors);
    }
  const why = unread({ script, reports, failures });
  return why ? { name, dir, exit, explained: false, why, failures } : { name, dir, exit, explained: true, failures };
}

/** The newest turbo run summary in `dir` (`turbo run --summarize` writes `.turbo/runs/<id>.json`), or null. */
export function latestSummary(dir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const newest = files
    .map((f) => ({ f, t: readFileSync(join(dir, f), 'utf8') }))
    .map(({ f, t }) => ({ f, j: JSON.parse(t) }))
    .sort((a, b) => (b.j.execution?.startTime ?? 0) - (a.j.execution?.startTime ?? 0))[0];
  return newest?.j ?? null;
}

/** Every report in `dir`, grouped by package name. */
export function readReports(dir) {
  const by = new Map();
  if (!existsSync(dir)) return by;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (!by.has(r.package)) by.set(r.package, []);
    by.get(r.package).push(r);
  }
  return by;
}

/** This job's record (pure): what failed, package by package, and what could not be read test by test. */
export function recordOf({ summary, reports, scriptOf, outcome, sha, event, shard, attempt }) {
  const record = { v: RECORD_VERSION, sha, event, shard, attempt: Number(attempt), outcome, problems: [], packages: [] };
  if (outcome !== 'failure') return record;
  if (!summary) {
    record.problems.push('turbo wrote no run summary, so the failed tasks are unknown');
    return record;
  }
  for (const t of summary.tasks ?? []) {
    const code = t.execution?.exitCode;
    if (code === 0) continue;
    if (t.task !== 'test') {
      record.problems.push(`${t.taskId} ${code === undefined ? 'did not run' : `failed (exit ${code})`}: not a test run`);
      continue;
    }
    if (code === undefined || code === null) {
      record.problems.push(`${t.taskId} did not run`);
      continue;
    }
    record.packages.push(
      explainPackage({
        name: t.package,
        dir: t.directory,
        exit: code,
        script: scriptOf(t.directory),
        reports: reports.get(t.package) ?? [],
      }),
    );
  }
  if (!record.problems.length && !record.packages.length) record.problems.push('pnpm test failed, but turbo names no failed task');
  return record;
}

// ── which tests are never excused ───────────────────────────────────────────────────────────────────────────────────

const LEDGER_CLIENT = '@intafaced/ledger-client';
const DEP_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
/** The money code services AGENTS.md names beside the ledger client's dependents. */
export const MONEY_NAMED = ['services/svc-edge', 'services/svc-ops', 'services/svc-protocol', 'services/svc-fix'];

/**
 * The repo's money code, its TypeScript part (`manifests`: folder -> package.json): packages/ledger-client, every package
 * that depends on it directly, and MONEY_NAMED. The same list as journey-verdict.mjs moneyCodeDirs, which the journeys
 * run reads (base-failures.test.mjs fails when they differ); not imported from there, so the Tests job, which runs this
 * file, reaches none of the journeys run's code (tooling-reach.mjs).
 */
export function moneyDirsOf(manifests) {
  const out = new Set(MONEY_NAMED);
  for (const [dir, m] of manifests)
    if (m?.name === LEDGER_CLIENT || DEP_KEYS.some((k) => m?.[k] && Object.hasOwn(m[k], LEDGER_CLIENT))) out.add(dir);
  return out;
}

/** Packages whose every test is a sign-in or permissions test, beside money code (moneyDirsOf). */
export const PROTECTED_DIRS = ['packages/auth', 'apps/admin'];
/**
 * Words in a test's file path or full name that make it a test of money, custody, sign-in or permissions, matched at
 * the start of a word (`pay` is pay, payment or payout; never repay); one ending `$` is that whole word or its plural
 * (`fee$` is fee or fees, never feed). Wide on purpose: a test wrongly held stays red as it was before this rule; a
 * money test wrongly excused would not.
 */
// prettier-ignore
export const PROTECTED_WORDS = {
  money: [
    'ledger', 'money', 'balance', 'pay', 'deposit', 'withdraw', 'transfer', 'wallet', 'custod', 'escrow', 'settle', 'fund',
    'refund', 'fee$', 'bank', 'card', 'p2p', 'price', 'pricing', 'order', 'trade', 'trading', 'tax$', 'taxes$', 'earn',
    'loan', 'lend', 'collateral', 'margin', 'invoice', 'spend', 'swap', 'vault', 'stak', 'usd', 'account', 'limit', 'cash',
    'treasury', 'reserve', 'portfolio', 'venue',
  ],
  'sign-in': [
    'auth', 'sign-in', 'signin', 'sign-up', 'signup', 'login', 'log-in', 'logout', 'session', 'password', 'passkey',
    'webauthn', 'otp$', '2fa', 'mfa', 'totp', 'jwt', 'oauth', 'credential',
  ],
  permissions: [
    'permission', 'grant', 'role', 'rbac', 'acl$', 'polic', 'admin', 'access$', 'deny', 'denied', 'forbid', 'kyc',
    'sanction', 'freeze', 'frozen', 'kill-switch', 'killswitch', 'approv', 'operator', 'identity',
  ],
};
const wordRe = (w) =>
  w.endsWith('$')
    ? `${w.slice(0, -1).replace(/[- ]/g, '[- _]?')}s?(?![a-z0-9])`
    : w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[- ]/g, '[- _]?');
const WORD_RE = Object.fromEntries(
  Object.entries(PROTECTED_WORDS).map(([k, words]) => [k, new RegExp(`(?:^|[^a-z0-9])(${words.map(wordRe).join('|')})`, 'i')]),
);
const JOURNEY = /(^|\/)tests\/real-app\/|\.pw\.[cm]?[jt]sx?$|(^|[^a-z0-9])J-[a-z][a-z0-9-]*-\d+/i;

/** Why a failure is never excused (money, custody, sign-in, permissions, journey), or null. `moneyDirs`: a Set of folders. */
export function protectedWhy(f, { moneyDirs }) {
  if (moneyDirs.has(f.dir)) return `a test in money code (${f.dir})`;
  if (PROTECTED_DIRS.includes(f.dir)) return `a test in ${f.dir}, sign-in and permissions code`;
  const text = `${f.file} ${f.name}`;
  if (JOURNEY.test(text)) return 'a journey test';
  for (const [kind, re] of Object.entries(WORD_RE)) {
    const m = re.exec(text);
    if (m) return `a ${kind} test (its file or name says "${m[1]}")`;
  }
  return null;
}

// ── main's record and the verdict ───────────────────────────────────────────────────────────────────────────────────

/**
 * What main recorded on `base` (pure): { known: true, failures: Map<id, reason> } or { known: false, why, waiting? }.
 * `run` is main's push run on that commit (or null), `jobs` its latest jobs, `records` its artifacts' records by name.
 */
export function mainState({ base, run, jobs, records }) {
  if (!run) return { known: false, why: `main has no CI run on ${base}` };
  if (run.head_sha !== base || run.event !== 'push' || run.head_branch !== 'main')
    return { known: false, why: `run ${run.id} is not main's push run on ${base}` };
  if (run.status !== 'completed') return { known: false, waiting: true, why: `main's run ${run.id} on ${base} is ${run.status}` };
  if (run.conclusion !== 'success' && run.conclusion !== 'failure')
    return { known: false, why: `main's run ${run.id} on ${base} ended ${run.conclusion}` };
  const tests = (jobs ?? []).filter((j) => TESTS_JOB.test(j.name));
  if (!tests.length) return { known: false, why: `main's run ${run.id} has no Tests job` };
  const failures = new Map();
  for (const j of tests) {
    if (j.conclusion !== 'success' && j.conclusion !== 'failure')
      return { known: false, why: `main's ${j.name} ended ${j.conclusion ?? j.status}` };
    const shard = TESTS_JOB.exec(j.name)[1];
    const name = artifactName(shard, j.run_attempt);
    const r = records.get(name);
    if (!r) return { known: false, why: `main's ${j.name} kept no record (${name})` };
    if (r.v !== RECORD_VERSION || r.sha !== base || r.event !== 'push' || r.shard !== shard || r.attempt !== j.run_attempt)
      return { known: false, why: `${name} is not the record of main's ${j.name} on ${base}` };
    if (j.conclusion === 'failure' && r.outcome === 'failure' && !r.packages.length)
      return { known: false, why: `main's ${j.name} failed but its record names no failed package (${r.problems.join('; ')})` };
    for (const p of r.packages) for (const f of p.failures) failures.set(failureId(f), f.reason);
  }
  return { known: true, failures };
}

/**
 * The verdict (pure): { pass, excused: [{ f, mainReason }], held: [{ f?, what, why }] }. `main` is mainState's answer, or
 * null when it was not read (something is held whatever main says).
 */
export function compare({ pr, main, moneyDirs }) {
  const excused = [];
  const held = [];
  for (const p of pr.problems) held.push({ what: 'this job', why: p });
  for (const pkg of pr.packages) {
    if (!pkg.explained) held.push({ what: pkg.name, why: `its failure is not read test by test: ${pkg.why}` });
    for (const f of pkg.failures) {
      const prot = protectedWhy(f, { moneyDirs });
      if (prot) held.push({ f, what: failureId(f), why: `never excused: ${prot}` });
      else if (!pkg.explained) held.push({ f, what: failureId(f), why: 'its package is held (above)' });
      // byMain: only an unknown record of main is waited for (needsMain); a known one is final
      else if (!main?.known)
        held.push({ f, byMain: true, what: failureId(f), why: `main's result is unknown: ${main?.why ?? 'not read'}` });
      else if (!main.failures.has(failureId(f)))
        held.push({ f, what: failureId(f), why: 'main did not fail it: only this pull request does' });
      else if (main.failures.get(failureId(f)) !== f.reason)
        held.push({ f, what: failureId(f), why: `main failed it for another reason: ${main.failures.get(failureId(f))}` });
      else if (main.changed?.has(f.dir))
        held.push({
          f,
          what: failureId(f),
          why: `main changed ${f.dir} after the record it has (${main.sha}), so that record may not hold on the base`,
        });
      else excused.push({ f, mainReason: main.failures.get(failureId(f)) });
    }
  }
  if (!held.length && !excused.length) held.push({ what: 'this job', why: 'its tests failed and no failure was read' });
  return { pass: held.length === 0, excused, held };
}

/** Whether main's record could still change the verdict: every held item waits only on main's record being unknown. */
export const needsMain = (held) => held.length > 0 && held.every((h) => h.f && h.byMain);

/**
 * Main's nearest finished record at or before the base: `line` is the base and the commits before it on main's
 * first-parent line, newest first (at most WALK); `readAt(sha)` is mainState's answer for that commit. Returns the first
 * known one, as mainState gives it, with `sha`, `run` and `behind` (how many commits before the base), or
 * { known: false, why }. Either way `pending` names the newest commit above the record (or anywhere on the line, when
 * none was found) whose run of main is not finished yet, or is null.
 */
export async function nearestRecord({ base, line, readAt }) {
  if (line[0] !== base) return { known: false, pending: null, why: `main's line was not read from ${base}` };
  let pending = null;
  const seen = [];
  for (const [behind, sha] of line.slice(0, WALK).entries()) {
    const { state, run } = await readAt(sha);
    if (state.known) return { ...state, sha, run, behind, pending };
    if (state.waiting && !pending) pending = { sha, run, why: state.why };
    seen.push(state.why);
  }
  const n = Math.min(line.length, WALK);
  return {
    known: false,
    pending,
    why: `none of ${base} and the ${n - 1} commit(s) before it on main has a finished record of main's tests (${seen.slice(0, 3).join('; ')}${seen.length > 3 ? '; …' : ''})`,
  };
}

/** The verdict as lines for the log and the step summary. */
export function verdictText({ verdict, base, runUrl, record = { sha: base, behind: 0 } }) {
  const out = [];
  const main = runUrl ? `main's run ${runUrl}` : `main's record on ${record.sha}`;
  const where =
    record.sha === base
      ? `${base}, the commit this pull request merges into`
      : `${record.sha}, ${record.behind} commit(s) before ${base}, the commit this pull request merges into (the nearest commit of main with a finished record: the commits between have none, their runs cancelled or not finished)`;
  if (verdict.excused.length) {
    out.push(
      `Excused: ${verdict.excused.length} failure(s) that ${main} recorded the same way on ${where} (the owner's decision of 23 Nov 2026: a failure main already has does not hold a pull request; main's own run stays red for it):`,
    );
    for (const e of verdict.excused) out.push(`  - ${failureId(e.f)}: ${e.f.reason}`);
  }
  if (verdict.held.length) {
    out.push(`Held: ${verdict.held.length} failure(s) or problem(s) that fail this job:`);
    for (const h of verdict.held) out.push(`  - ${h.what}: ${h.why}${h.f ? ` (${h.f.reason})` : ''}`);
  }
  out.push(verdict.pass ? 'Verdict: green. Every failure here is one main already has.' : 'Verdict: red.');
  return out;
}

// ── reading main (CI) ───────────────────────────────────────────────────────────────────────────────────────────────

async function getJson(path) {
  const res = await githubFetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${githubToken()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${res.status} on GET ${path}: stopping, not retrying${refusalDetail(res.headers, text)}`);
  return JSON.parse(text);
}

/** Main's push run of ci.yml on `sha`, the newest if several, or null. */
export async function findMainRun(repo, sha, get = getJson) {
  const j = await get(`/repos/${repo}/actions/workflows/${WORKFLOW}/runs?head_sha=${sha}&event=push&branch=main&per_page=20`);
  return (j.workflow_runs ?? []).filter((r) => r.head_sha === sha).sort((a, b) => b.id - a.id)[0] ?? null;
}

/** The records main's run kept, by artifact name (`gh run download`; an empty map when it kept none). */
function downloadRecords(repo, runId) {
  const dir = mkdtempSync(join(tmpdir(), 'base-failures-'));
  const records = new Map();
  try {
    // gh lists the run's artifacts (one page holds a run's sixteen-odd records) and downloads each matching one; the
    // download of each is a call too, counted as the records found.
    countCall();
    try {
      execFileSync('gh', ['run', 'download', String(runId), '-R', repo, '-p', 'test-results-*', '-D', dir], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      const err = String(e.stderr ?? e.message);
      if (!/no artifact matches|no valid artifacts/i.test(err)) throw new Error(`gh run download ${runId}: ${err.trim().split('\n')[0]}`);
    }
    for (const name of readdirSync(dir)) {
      countCall();
      const f = join(dir, name, 'test-record.json');
      if (existsSync(f)) records.set(name, JSON.parse(readFileSync(f, 'utf8')));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return records;
}

/**
 * mainState on one commit of main, read from GitHub: { state, run }. A finished answer is kept in `cache` (a later poll
 * reads again only the commits whose runs were not finished); a run that ended in neither success nor failure, or kept
 * no record, is not read further.
 */
async function readAt(repo, sha, cache, recent) {
  if (cache.has(sha)) return cache.get(sha);
  const run = recent.has(sha) ? recent.get(sha) : await findMainRun(repo, sha);
  const empty = { base: sha, run, jobs: [], records: new Map() };
  let out;
  if (!run || run.status !== 'completed' || (run.conclusion !== 'success' && run.conclusion !== 'failure'))
    out = { state: mainState(empty), run };
  else {
    const records = downloadRecords(repo, run.id);
    if (!records.size) out = { state: { known: false, why: `main's run ${run.id} on ${sha} kept no test record` }, run };
    else {
      const jobs = await runJobs(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest`, getJson);
      out = { state: mainState({ ...empty, jobs, records }), run };
    }
  }
  if (!out.state.waiting) cache.set(sha, out);
  return out;
}

const defaultGit = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });

/** The base and the commits before it on main's first-parent line, newest first, at most WALK; throws when the base is not on main. */
export function mainLine(base, git = defaultGit) {
  try {
    git(['merge-base', '--is-ancestor', base, 'origin/main']);
  } catch {
    throw new Error(`${base} is not on origin/main, so main's records say nothing about it`);
  }
  return git(['rev-list', '--first-parent', `--max-count=${WALK}`, base])
    .split('\n')
    .filter(Boolean);
}

/** The workspace folder a path sits in (`apps/x`, `services/x`, `packages/x`), or null for anything else. */
const WORKSPACE = /^((?:apps|services|packages)\/[^/]+)\//;

/**
 * The folders of `dirs` whose tests a commit after `from`, up to `to`, may have changed. A folder counts as changed when
 * the diff touches it, a workspace package it depends on (directly or not, read from the manifests at `to`), or any
 * path outside apps/, services/ and packages/ (root config, the lockfile, tooling/, .github/), which every test may
 * read. A diff git can't read marks every folder changed.
 */
export function changedDirs(from, to, dirs, git = defaultGit, manifests = null) {
  const out = new Set();
  if (from === to) return out;
  let files;
  try {
    files = git(['diff', '--name-only', from, to]).split('\n').filter(Boolean);
  } catch {
    for (const d of dirs) out.add(d);
    return out;
  }
  if (!files.length) return out;
  const touched = new Set();
  let shared = false;
  for (const f of files) {
    const m = WORKSPACE.exec(f);
    if (m) touched.add(m[1]);
    else shared = true;
  }
  if (shared) {
    for (const d of dirs) out.add(d);
    return out;
  }
  let byName;
  try {
    const man = manifests ?? manifestsAtRev(to, git);
    byName = new Map([...man].map(([dir, j]) => [j.name, { dir, j }]));
    manifests = man;
  } catch {
    for (const d of dirs) out.add(d);
    return out;
  }
  const closure = (d) => {
    const seen = new Set([d]);
    const todo = [d];
    while (todo.length) {
      const j = manifests.get(todo.pop());
      if (!j) continue;
      for (const n of Object.keys({ ...j.dependencies, ...j.devDependencies, ...j.peerDependencies })) {
        const dep = byName.get(n);
        if (dep && !seen.has(dep.dir)) {
          seen.add(dep.dir);
          todo.push(dep.dir);
        }
      }
    }
    return seen;
  };
  for (const d of new Set(dirs)) {
    if (!manifests.has(d)) {
      out.add(d);
      continue;
    }
    for (const t of closure(d)) if (touched.has(t)) out.add(d);
  }
  return out;
}

/**
 * Main's newest push runs of ci.yml, the newest per commit, by commit: one call instead of one per commit of the walk
 * (a Tests job's token has 1,000 calls an hour for the repo, shared by every job). When a commit has a run among the
 * newest RECENT, its newest run is among them too; a commit with none there is asked by itself (findMainRun).
 */
const RECENT = 100;
export async function recentMainRuns(repo, get = getJson) {
  const j = await get(`/repos/${repo}/actions/workflows/${WORKFLOW}/runs?branch=main&event=push&per_page=${RECENT}`);
  const by = new Map();
  for (const r of [...(j.workflow_runs ?? [])].sort((a, b) => b.id - a.id)) if (!by.has(r.head_sha)) by.set(r.head_sha, r);
  return by;
}

/** Main's nearest finished record for `base`, with the folders of `dirs` main changed after it (state.changed). */
export async function readMain(repo, base, dirs, cache, git = defaultGit) {
  const line = mainLine(base, git);
  const recent = await recentMainRuns(repo);
  const state = await nearestRecord({ base, line, readAt: (sha) => readAt(repo, sha, cache, recent) });
  if (state.known) state.changed = changedDirs(state.sha, base, dirs, git);
  return { state, run: state.run ?? null };
}

const PACKAGE_JSON = /^((?:apps|services|packages|tooling)\/[^/]+)\/package\.json$/;

/** Each workspace package's package.json in the checkout at `root`, by folder. */
export function manifestsOf(root) {
  const manifests = new Map();
  for (const top of ['apps', 'services', 'packages', 'tooling']) {
    if (!existsSync(join(root, top))) continue;
    for (const d of readdirSync(join(root, top), { withFileTypes: true })) {
      const f = join(root, top, d.name, 'package.json');
      if (d.isDirectory() && existsSync(f)) manifests.set(`${top}/${d.name}`, JSON.parse(readFileSync(f, 'utf8')));
    }
  }
  return manifests;
}

/** The same at commit `rev`, read through git. */
export function manifestsAtRev(rev, git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 })) {
  const manifests = new Map();
  for (const f of git(['ls-tree', '-r', '--name-only', rev, '--', 'apps', 'services', 'packages', 'tooling']).split('\n')) {
    const m = PACKAGE_JSON.exec(f);
    if (m) manifests.set(m[1], JSON.parse(git(['show', `${rev}:${f}`])));
  }
  return manifests;
}

async function verdictMain(args) {
  const repo = process.env.GITHUB_REPOSITORY;
  const base = process.env.BASE_SHA;
  const pr = JSON.parse(readFileSync(args.record, 'utf8'));
  const summary = process.env.GITHUB_STEP_SUMMARY;
  const say = (lines) => {
    for (const l of lines) console.log(l);
    if (summary)
      appendFileSync(
        summary,
        `## Failures main already has\n\n${lines.map((l) => (l.startsWith('  - ') ? l.slice(2) : `\n${l}\n`)).join('\n')}\n`,
      );
  };
  if (!repo || !/^[0-9a-f]{40}$/.test(base ?? '')) {
    say([`Verdict: red. No base commit to compare with (BASE_SHA=${base ?? ''}), so nothing is excused.`]);
    return 1;
  }
  const moneyDirs = new Set([...moneyDirsOf(manifestsOf(process.cwd())), ...moneyDirsOf(manifestsAtRev(base))]);
  const { verdict, runUrl, record } = await judge({ repo, base, pr, moneyDirs });
  for (const e of verdict.excused)
    console.log(`::warning title=Excused: main fails it too::${failureId(e.f)}: ${e.f.reason} (${runUrl ?? record.sha})`);
  for (const h of verdict.held) console.log(`::error title=Held::${h.what}: ${h.why}`);
  say(verdictText({ verdict, base, runUrl, record }));
  return verdict.pass ? 0 : 1;
}

/**
 * The verdict on `pr` (a record) against main's nearest finished record for `base`, reading GitHub and git; waits only
 * while main has no known record and a run of main near the base is still going (WAIT_MIN). { verdict, runUrl, record: { sha, behind } }.
 */
export async function judge({
  repo,
  base,
  pr,
  moneyDirs,
  waitMin = Number(process.env.BASE_FAILURES_WAIT_MIN) || WAIT_MIN,
  read: readFn = (dirs, cache) => readMain(repo, base, dirs, cache),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let verdict = compare({ pr, main: null, moneyDirs });
  let runUrl = null;
  let record = { sha: base, behind: 0 };
  if (!needsMain(verdict.held)) return { verdict, runUrl, record };
  const dirs = pr.packages.map((p) => p.dir);
  const cache = new Map();
  const deadline = Date.now() + waitMin * 60_000;
  for (;;) {
    let read;
    try {
      read = await readFn(dirs, cache);
    } catch (e) {
      read = { state: { known: false, why: e.message } };
    }
    verdict = compare({ pr, main: read.state, moneyDirs });
    runUrl = read.run ? `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${read.run.id}` : null;
    record = read.state.known ? { sha: read.state.sha, behind: read.state.behind } : { sha: base, behind: 0 };
    const pending = read.state.pending;
    // needsMain is false once nothing is held or main's record is known, so either ends it without a wait
    if (!needsMain(verdict.held) || !pending || Date.now() + POLL_MS > deadline) break;
    console.log(`${pending.why}, and main has no record near the base yet: waiting for it (until ${new Date(deadline).toISOString()})`);
    await sleep(POLL_MS);
  }
  if (record.sha !== base) console.log(`main's record used: ${record.sha}, ${record.behind} commit(s) before the base ${base} (${runUrl})`);
  return { verdict, runUrl, record };
}

function recordMain(args) {
  const scriptOf = (dir) => {
    try {
      return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts?.test ?? '';
    } catch {
      return '';
    }
  };
  const record = recordOf({
    summary: latestSummary(args.turbo),
    reports: readReports(args.results),
    scriptOf,
    outcome: args.outcome,
    sha: process.env.GITHUB_SHA,
    event: process.env.GITHUB_EVENT_NAME,
    shard: args.shard,
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? 1,
  });
  writeFileSync(args.out, `${JSON.stringify(record, null, 1)}\n`);
  const failures = record.packages.reduce((n, p) => n + p.failures.length, 0);
  console.log(
    `recorded ${failures} failure(s) in ${record.packages.length} package(s)${record.problems.length ? `; ${record.problems.join('; ')}` : ''}`,
  );
  return 0;
}

function parseArgs(argv) {
  const args = { mode: argv[0] };
  for (let i = 1; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  const run = args.mode === 'record' ? async () => recordMain(args) : args.mode === 'verdict' ? () => verdictMain(args) : null;
  if (!run) {
    console.error('usage: base-failures.mjs record|verdict ... (see the header)');
    process.exit(2);
  }
  run().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`::error title=Failures main already has::${e.stack ?? e}`);
      process.exit(1);
    },
  );
}
