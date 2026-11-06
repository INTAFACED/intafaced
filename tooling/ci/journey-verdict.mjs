#!/usr/bin/env node
/**
 * THE JOURNEYS VERDICT: whether a Real-app journeys run is red, read against the list of steps not built yet
 * (docs/runbooks/journey-baseline.json, read by the rules of docs/runbooks/regression-issue-state.md).
 *
 * Why: the run on main runs every written step, built or not, so it was red on every run since 23 Oct 21:09 UTC (run
 * 40024672126) whether or not anything broke, and a red that is always red says nothing. With this verdict the run's
 * own conclusion says it: green when only listed steps fail by the runbook's rules, red when anything else does.
 *
 * Red when any of these holds (green otherwise):
 *   - a step failed and is not in the baseline's `steps` (a step in `notBaselined` counts as failing, as the runbook says);
 *   - a step that passed in the baseline's named run is skipped or missing now (on a targeted run, only steps whose test
 *     file the run named);
 *   - a failing step's entry is listed twice, its `money` disagrees with the money rule at this run's commit, or its
 *     state is not one the runbook allows;
 *   - an `unbuilt` step passed in a finished run on main after the baseline's named run (it was built, so a failure now
 *     is a regression); the runs up to the named run are the baseline's own claim, which its PR proved (`runsRead`);
 *   - a `regression` step is money, or its issue is not an open regression issue whose newest state line, by an owner,
 *     member or collaborator, is `parked` with a blocker;
 *   - an input could not be read: this run's report, the named run's report, the pass history since it, or an issue.
 *     Every unreadable input is red (fail closed), never green.
 * The workflow adds the rest: a shard with no report, and a shard job red for any reason other than its journeys failing
 * (setup, the stack, the time limit, the Content-Security-Policy check), are red too.
 *
 * The rules are ported from the reader that already judged this baseline for the finish plan (project-state
 * tooling/truth/ready-journeys.mjs judgeJourneys and ready.mjs regressionState), so the run and that reader agree.
 *
 *   node tooling/ci/journey-verdict.mjs --report <report.json> [--baseline <file>] [--target "<files>"]
 *        [--named-report <report.json>] [--history-dir <dir of <run number>/report.json>]
 *        [--issues-file <json { "<n>": { issue, comments } }>]                         (offline)
 *   (CI) GH_TOKEN GITHUB_REPOSITORY GITHUB_RUN_ID node tooling/ci/journey-verdict.mjs --report <report.json> --fetch
 *        reads the named run's report, the pass history since it and the regression issues with GET requests only.
 * Exit 0 = green, 1 = red. Writes the verdict to GITHUB_STEP_SUMMARY when it is set.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BASELINE_PATH = 'docs/runbooks/journey-baseline.json';
export const JOURNEYS_FILE = 'real-app-journeys.yml';
export const JOURNEYS_ARTIFACT = 'real-app-journeys';
export const LEDGER_CLIENT = '@intafaced/ledger-client';
/** More finished runs on main than this since the baseline's named run: red, and the baseline is rewritten. */
export const HISTORY_MAX = 150;
const STEP_TITLE = /^(J-[a-z0-9-]+-\d+)\s+#(\d+)\b/;
const MEMBERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const REGRESSION_TITLE = /^(Journey broken on main|Broken on main): /;
const STATE_LINE = /^Regression state: (fixed|reverted|parked)\b/;
const PARKED = /^Regression state: parked\s+[—–-]+\s*(\S.*)$/;
const MAIN_EVENTS = new Set(['push', 'schedule', 'workflow_dispatch']);
const byStep = (a, b) => a.localeCompare(b, 'en', { numeric: true });

/**
 * Each journey step in a Playwright JSON report: { states: { step: "passed"|"failed"|"skipped" }, files: { step: file } }.
 * Main trust's rule (post-merge-trust.mjs stepStates): a step with any test that did not end expected or flaky failed,
 * and a failing duplicate title never hides behind a passing one.
 */
export function readReport(report) {
  const states = {};
  const files = {};
  const walk = (suite, file) => {
    const here = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      const m = STEP_TITLE.exec(spec.title ?? '');
      if (!m) continue;
      const key = `${m[1]}#${Number(m[2])}`;
      const tests = spec.tests ?? [];
      const state =
        tests.length && tests.every((t) => t.status === 'skipped')
          ? 'skipped'
          : tests.length && tests.every((t) => t.status === 'expected' || t.status === 'flaky')
            ? 'passed'
            : 'failed';
      const had = states[key];
      states[key] = had === 'failed' || state === 'failed' ? 'failed' : had === 'passed' || state === 'passed' ? 'passed' : 'skipped';
      const f = spec.file ?? here;
      if (f && !files[key]) files[key] = String(f).split('/').pop();
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const suite of report?.suites ?? []) walk(suite, suite.file);
  return { states, files };
}

/** The money rule (regression-issue-state.md "Money"; the same as project-state ready-journeys.mjs moneyRule). */
export const touchRoot = (t) =>
  /^svc-[a-z0-9-]+$/.test(t)
    ? `services/${t}`
    : /^packages\/[a-z0-9-]+$/.test(t)
      ? t
      : t.startsWith('customer: ')
        ? 'apps/customer'
        : t.startsWith('admin: ')
          ? 'apps/admin'
          : null;
export const dependsOnLedgerClient = (m) =>
  ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some((k) => m?.[k] && Object.hasOwn(m[k], LEDGER_CLIENT));
const isMoneyPackage = (m) => m?.name === LEDGER_CLIENT || dependsOnLedgerClient(m);
export function moneyRule({ journeys, slices, manifests }) {
  const money = new Set([...manifests].filter(([, m]) => isMoneyPackage(m)).map(([root]) => root));
  const bySlice = new Map(slices.map((s) => [s.id, s]));
  const sliceMoney = (id) =>
    (bySlice.get(id)?.touches ?? []).some((t) => {
      const root = touchRoot(t);
      return root === null || money.has(root);
    });
  const steps = {};
  for (const j of journeys) for (const st of j.steps ?? []) steps[`${j.id}#${st.n}`] = (st.slices ?? []).some(sliceMoney);
  return steps;
}

/** A body's lines outside fenced or indented code (as ready.mjs outsideCode reads them). */
export function outsideCode(body) {
  const out = [];
  let fence = null;
  for (const line of String(body ?? '')
    .replace(/\r/g, '')
    .split('\n')) {
    const indent = /^[ \t]*/.exec(line)[0].replace(/\t/g, '    ').length;
    const m = /^(`{3,}|~{3,})(.*)$/.exec(line.trimStart());
    if (fence && line.trim() && fence.indent >= 4 && indent < fence.indent) fence = null;
    if (fence) {
      if (m && m[1][0] === fence.run[0] && m[1].length >= fence.run.length && indent <= fence.indent + 3 && !m[2].trim()) fence = null;
    } else if (m && !(m[1][0] === '`' && m[2].includes('`'))) fence = { run: m[1], indent };
    else if (indent < 4) out.push(line);
  }
  return out;
}

/** A regression issue's state: { kind, line } from its newest member comment with a state line, or null (none, or a
 *  `parked` line with no blocker). The runbook's "Reading it". */
export function regressionState(comments) {
  let state = null;
  for (const c of [...comments].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    if (!MEMBERS.has(c.author_association)) continue;
    const line = outsideCode(c.body).find((l) => STATE_LINE.test(l));
    if (line) state = { kind: STATE_LINE.exec(line)[1], line };
  }
  if (state?.kind === 'parked' && !PARKED.test(state.line)) return null;
  return state;
}

/** Why a regression entry's issue doesn't hold, or null when it does. `read` is { issue, comments } or { problem }. */
export function issueProblem(n, read) {
  if (!Number.isInteger(n)) return 'names no issue';
  if (!read) return `#${n} wasn't read`;
  if (read.problem) return `#${n} couldn't be read (${read.problem})`;
  const { issue, comments } = read;
  if (issue.pull_request) return `#${n} is a pull request`;
  if (issue.state !== 'open') return `#${n} is ${issue.state}`;
  if (!REGRESSION_TITLE.test(issue.title ?? '')) return `#${n} is not a regression issue (its title)`;
  const s = regressionState(comments ?? []);
  if (s?.kind !== 'parked') return `#${n}'s state is ${s ? s.kind : 'unset'}, not parked with a blocker`;
  return null;
}

/**
 * The verdict. `newest` and `named` are readReport() results for this run and the baseline's named run; `passedSince`
 * maps a step to the newest run on main after the named run that passed it; `issues` maps an issue number to its read;
 * `target` is the set of journey file names a targeted run ran, or null for a full run. Returns { failing, red }.
 */
export function judge({ newest, named, baseline, money, passedSince = {}, issues = {}, target = null }) {
  const inScope = (step, files) => !target || target.has(files[step]);
  const failing = new Set(
    Object.entries(newest.states)
      .filter(([, s]) => s === 'failed')
      .map(([k]) => k),
  );
  for (const [step, s] of Object.entries(named.states))
    if (s === 'passed' && newest.states[step] !== 'passed' && newest.states[step] !== 'failed' && inScope(step, named.files))
      failing.add(step);
  const entries = new Map();
  const dupes = new Set();
  for (const e of baseline?.steps ?? []) entries.has(e.step) ? dupes.add(e.step) : entries.set(e.step, e);
  const notBaselined = new Set((baseline?.notBaselined ?? []).map((e) => e.step));
  const runNo = baseline?.run?.number;
  const red = [];
  for (const step of [...failing].sort(byStep)) {
    const isMoney = money[step] ?? true; // a step missing from journeys.json counts as money
    const e = entries.get(step);
    const no = (why) => red.push({ step, why, money: isMoney });
    if (!e) {
      if (notBaselined.has(step)) no(`listed as notBaselined in run ${runNo}'s baseline, so it counts as failing`);
      else
        no(
          newest.states[step] === 'failed'
            ? 'failing, not in the baseline'
            : `passed in run ${runNo}, ${newest.states[step] ?? 'missing'} now`,
        );
    } else if (dupes.has(step)) no('listed more than once in the baseline');
    else if (e.money !== isMoney) no(`the baseline says money ${e.money}, the money rule at this commit says ${isMoney}`);
    else if (e.state === 'unbuilt') {
      if (passedSince[step] !== undefined)
        no(`called unbuilt, but passed on main in run ${passedSince[step]}, after the baseline's run ${runNo}`);
    } else if (e.state === 'regression') {
      if (isMoney) no('a money step may be in the baseline only as unbuilt');
      else {
        const why = issueProblem(e.issue, issues[e.issue]);
        if (why) no(`regression: ${why}`);
      }
    } else no(`state "${e.state}" is not one the baseline allows`);
  }
  return { failing: failing.size, red };
}

/** The pass history after the named run: for each step, the newest run number that passed it. `reports` is
 *  [[runNumber, readReport() result]]. */
export function passesSince(reports) {
  const out = {};
  for (const [n, r] of reports) for (const [step, s] of Object.entries(r.states)) if (s === 'passed' && !(out[step] >= n)) out[step] = n;
  return out;
}

/** The finished runs on main to read for the history: after the named run, before this one, never cancelled or skipped,
 *  only main's own (a fork's branch named main reports head_branch "main" too). */
export function historyRuns(runs, { repo, namedCreated, thisCreated, thisId }) {
  return runs
    .filter((r) => r.id !== thisId && r.head_branch === 'main' && r.head_repository?.full_name === repo && MAIN_EVENTS.has(r.event))
    .filter((r) => r.status === 'completed' && !['cancelled', 'skipped'].includes(r.conclusion))
    .filter((r) => r.created_at > namedCreated && r.created_at < thisCreated)
    .sort((a, b) => a.run_number - b.run_number);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const json = (f) => JSON.parse(readFileSync(f, 'utf8'));
/** GET only. A refusal (403, 429) is thrown, never retried: the verdict is then red. */
const ghApi = (path) =>
  JSON.parse(execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github+json', path], { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 }));
const ghPages = (path, key) => {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const body = ghApi(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const items = key ? body[key] : body;
    out.push(...items);
    if (items.length < 100) return out;
  }
  throw new Error(`${path}: more than 20 pages`);
};
function downloadReport(repo, runId) {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-'));
  try {
    execFileSync('gh', ['run', 'download', String(runId), '--repo', repo, '--name', JOURNEYS_ARTIFACT, '--dir', dir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const f = join(dir, 'report.json');
    if (!existsSync(f)) throw new Error(`run ${runId}'s ${JOURNEYS_ARTIFACT} artifact has no report.json`);
    return json(f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function manifestsAt(root) {
  const manifests = new Map();
  for (const parent of ['apps', 'services', 'packages', 'tooling']) {
    const dir = join(root, parent);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, name.name, 'package.json');
      if (name.isDirectory() && existsSync(f)) manifests.set(`${parent}/${name.name}`, json(f));
    }
  }
  return manifests;
}

function main() {
  const root = process.cwd();
  const red = [];
  const problem = (why) => red.push({ step: '(input)', why, money: true });
  const reportFile = arg('--report');
  const baseline = json(arg('--baseline') ?? join(root, BASELINE_PATH));
  const money = moneyRule({
    journeys: json(join(root, 'docs/roadmap/journeys.json')),
    slices: json(join(root, 'docs/roadmap/slices.json')),
    manifests: manifestsAt(root),
  });
  const targetText = arg('--target') ?? process.env.JOURNEYS_TARGET ?? '';
  const target = targetText.trim()
    ? new Set(
        targetText
          .split(/[\s,]+/)
          .filter(Boolean)
          .map((f) => f.split('/').pop()),
      )
    : null;
  const repo = process.env.GITHUB_REPOSITORY;
  const fetch = process.argv.includes('--fetch');

  let newest = null;
  if (!reportFile || !existsSync(reportFile)) problem('this run kept no merged journey report');
  else newest = readReport(json(reportFile));

  let named = null;
  let passedSince = {};
  let issues = {};
  try {
    if (arg('--named-report')) named = readReport(json(arg('--named-report')));
    else if (fetch) named = readReport(downloadReport(repo, baseline.run.id));
    else problem("no report of the baseline's named run was given");
  } catch (e) {
    problem(`the baseline's named run ${baseline?.run?.number} (${baseline?.run?.id}) report couldn't be read: ${e.message}`);
  }
  try {
    if (arg('--history-dir')) {
      const dir = arg('--history-dir');
      const reports = readdirSync(dir)
        .filter((n) => /^\d+$/.test(n) && existsSync(join(dir, n, 'report.json')))
        .map((n) => [Number(n), readReport(json(join(dir, n, 'report.json')))])
        .filter(([n]) => n > baseline.run.number);
      passedSince = passesSince(reports);
    } else if (fetch) {
      const namedRun = ghApi(`/repos/${repo}/actions/runs/${baseline.run.id}`);
      const thisRun = ghApi(`/repos/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`);
      const all = ghPages(
        `/repos/${repo}/actions/workflows/${JOURNEYS_FILE}/runs?branch=main&status=completed&created=${encodeURIComponent(`>=${namedRun.created_at}`)}`,
        'workflow_runs',
      );
      const runs = historyRuns(all, { repo, namedCreated: namedRun.created_at, thisCreated: thisRun.created_at, thisId: thisRun.id });
      if (runs.length > HISTORY_MAX)
        throw new Error(
          `${runs.length} finished runs on main since run ${baseline.run.number}, more than ${HISTORY_MAX}: rewrite the baseline from a newer run`,
        );
      const reports = [];
      for (const r of runs) {
        try {
          reports.push([r.run_number, readReport(downloadReport(repo, r.id))]);
        } catch (e) {
          throw new Error(
            `run ${r.run_number}'s report couldn't be read (${e.message.split('\n')[0]}), so a pass in it can't be ruled out`,
          );
        }
      }
      console.log(`pass history: ${reports.length} finished run(s) on main after run ${baseline.run.number}`);
      passedSince = passesSince(reports);
    } else problem("no pass history since the baseline's named run was given");
  } catch (e) {
    problem(`the pass history couldn't be read: ${e.message}`);
  }
  const wanted = [...new Set((baseline.steps ?? []).filter((e) => e.state === 'regression').map((e) => e.issue))];
  if (arg('--issues-file')) issues = json(arg('--issues-file'));
  else if (fetch)
    for (const n of wanted) {
      try {
        issues[n] = { issue: ghApi(`/repos/${repo}/issues/${n}`), comments: ghPages(`/repos/${repo}/issues/${n}/comments`) };
      } catch (e) {
        issues[n] = { problem: e.message.split('\n')[0] };
      }
    }

  const verdict = newest && named ? judge({ newest, named, baseline, money, passedSince, issues, target }) : { failing: 0, red: [] };
  verdict.red.unshift(...red);
  const lines = [
    '### Verdict against the list of steps not built yet',
    '',
    `Baseline: run ${baseline.run?.number} (\`${BASELINE_PATH}\`).${target ? ` Targeted run: ${[...target].join(', ')}.` : ''}`,
    `Failing or missing steps: ${verdict.failing}; outside the list or against its rules: **${verdict.red.length}**.`,
    '',
    ...(verdict.red.length
      ? verdict.red.map((r) => `- ${r.step}${r.money ? ' (money)' : ''}: ${r.why}`)
      : ['Every failing step is on the list by its rules, so this run is green.']),
  ];
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  process.exit(verdict.red.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
