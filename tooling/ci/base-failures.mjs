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
 * commit this pull request merges into (its base: the merge commit's first parent). Never excused:
 *   - a failure main did not record, or recorded for another reason;
 *   - a test of money, custody, sign-in or permissions, or a journey test (owner decision d76, ci-review/REVIEW.md):
 *     every test in money code (moneyDirsOf, the repo's money code list, at the head or the base), in packages/auth or
 *     apps/admin, any test whose file or name says money, sign-in or permissions (PROTECTED_WORDS), and any journey test;
 *   - a package whose failure is not read test by test: a run that crashed or reported nothing, an unhandled error, a
 *     command after its tests that did not run, a build or other task that failed, a test script this can't read;
 *   - anything when main's record is unknown: no run of main on that commit, a run not finished (waited for up to
 *     WAIT_MIN minutes), cancelled, a Tests job without its record, or a record for another commit.
 * The Tests job stays red for anything held, and its output names each failure excused, why, and main's run.
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
export const WAIT_MIN = 20;
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
      else if (!main?.known) held.push({ f, what: failureId(f), why: `main's result is unknown: ${main?.why ?? 'not read'}` });
      else if (!main.failures.has(failureId(f)))
        held.push({ f, what: failureId(f), why: 'main did not fail it: only this pull request does' });
      else if (main.failures.get(failureId(f)) !== f.reason)
        held.push({ f, what: failureId(f), why: `main failed it for another reason: ${main.failures.get(failureId(f))}` });
      else excused.push({ f, mainReason: main.failures.get(failureId(f)) });
    }
  }
  if (!held.length && !excused.length) held.push({ what: 'this job', why: 'its tests failed and no failure was read' });
  return { pass: held.length === 0, excused, held };
}

/** Whether main's record could still change the verdict: every held item waits only on main. */
export const needsMain = (held) => held.length > 0 && held.every((h) => h.f && h.why.startsWith("main's result is unknown"));

/** The verdict as lines for the log and the step summary. */
export function verdictText({ verdict, base, runUrl }) {
  const out = [];
  const main = runUrl ? `main's run ${runUrl}` : `main's record on ${base}`;
  if (verdict.excused.length) {
    out.push(
      `Excused: ${verdict.excused.length} failure(s) that ${main} recorded the same way on ${base}, the commit this pull request merges into (the owner's decision of 23 Nov 2026: a failure main already has does not hold a pull request; main's own run stays red for it):`,
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

async function readMain(repo, base) {
  const run = await findMainRun(repo, base);
  if (!run || run.status !== 'completed') return { state: mainState({ base, run, jobs: [], records: new Map() }), run };
  const jobs = await runJobs(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest`, getJson);
  return { state: mainState({ base, run, jobs, records: downloadRecords(repo, run.id) }), run };
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
  let verdict = compare({ pr, main: null, moneyDirs });
  let runUrl = null;
  if (needsMain(verdict.held)) {
    const deadline = Date.now() + (Number(process.env.BASE_FAILURES_WAIT_MIN) || WAIT_MIN) * 60_000;
    let read;
    for (;;) {
      try {
        read = await readMain(repo, base);
      } catch (e) {
        read = { state: { known: false, why: e.message } };
      }
      if (!read.state.waiting || Date.now() + POLL_MS > deadline) break;
      console.log(`${read.state.why}: waiting for it (until ${new Date(deadline).toISOString()})`);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (read.run) runUrl = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${read.run.id}`;
    verdict = compare({ pr, main: read.state, moneyDirs });
  }
  for (const e of verdict.excused)
    console.log(`::warning title=Excused: main fails it too::${failureId(e.f)}: ${e.f.reason} (${runUrl ?? base})`);
  for (const h of verdict.held) console.log(`::error title=Held::${h.what}: ${h.why}`);
  say(verdictText({ verdict, base, runUrl }));
  return verdict.pass ? 0 : 1;
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
