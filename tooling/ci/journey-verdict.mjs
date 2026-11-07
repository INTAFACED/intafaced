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
 * THE SET-ASIDE (owner decision 2026-11-07, project-state OWNER 225 and 227: flaky tests set aside by the machine, money
 * checks never waived). A run on main retries a failed journey test once (JOURNEY_RETRIES in real-app-journeys.yml), so
 * a test that fails and then passes on the same commit ends "flaky" in Playwright's report. The set-aside list is kept
 * by the machine alone: each run on main writes it into its own artifact (set-aside.json, --set-aside-out) and the next
 * run on main reads it from there (--fetch), so no file or issue anyone can edit feeds it:
 *   - a non-money step that is flaky in a run on main is set aside from that run for SET_ASIDE_DAYS; its owner is its
 *     journey's module area (docs/roadmap/journeys.json). Once that ends it is not set aside again for another
 *     SET_ASIDE_DAYS, so the time stays limited;
 *   - a money step is never set aside (setAsideGuard: the money rule above, a wallet, bank, pay or p2p journey,
 *     J-ops-console-27, or a step with no slices or a slice that touches nothing), and neither is a step whose set-aside
 *     ended: a pass only on the retry then counts as a failure, judged by the rules above;
 *   - a set-aside step still runs, and the summary shows its result; while it is set aside, a failure leaves the verdict
 *     green only when the run just before this one on main showed it passing (two failures in a row is broken, not
 *     flaky; a missing or incomplete record of that run excuses nothing). Skipped or missing is never excused;
 *   - its `notProven` names every set-aside step and every step with a test Playwright called flaky, so a count of proven
 *     steps leaves them out, and Main trust opens one issue per set-aside naming its owner and end date
 *     (post-merge-trust.mjs).
 *
 * The rules are ported from the reader that already judged this baseline for the finish plan (project-state
 * tooling/truth/ready-journeys.mjs judgeJourneys and ready.mjs regressionState), so the run and that reader agree.
 *
 *   node tooling/ci/journey-verdict.mjs --report <report.json> [--baseline <file>] [--target "<files>"]
 *        [--named-report <report.json>] [--history-dir <dir of <run number>/report.json>]
 *        [--issues-file <json { "<n>": { issue, comments } }>]
 *        [--prior-set-aside <set-aside.json>] [--run-number <n>] [--now <ISO time>]       (offline)
 *   (CI) GH_TOKEN GITHUB_REPOSITORY GITHUB_RUN_ID node tooling/ci/journey-verdict.mjs --report <report.json> --fetch
 *        reads the named run's report, the pass history since it, the regression issues and the last run on main's
 *        set-aside.json with GET requests only.
 *   Either form takes --set-aside-out <file>: the set-aside list as JSON, written even when the verdict is red.
 * Exit 0 = green, 1 = red. Writes the verdict to GITHUB_STEP_SUMMARY when it is set.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BASELINE_PATH = 'docs/runbooks/journey-baseline.json';
export const JOURNEYS_FILE = 'real-app-journeys.yml';
export const JOURNEYS_ARTIFACT = 'real-app-journeys';
export const LEDGER_CLIENT = '@intafaced/ledger-client';
/** More finished runs on main than this since the baseline's named run: red, and the baseline is rewritten. */
export const HISTORY_MAX = 150;
/** How long the machine sets a flaky step aside, from the first run on main where it was flaky. */
export const SET_ASIDE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const STEP_TITLE = /^(J-[a-z0-9-]+-\d+)\s+#(\d+)\b/;
const MEMBERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const REGRESSION_TITLE = /^(Journey broken on main|Broken on main): /;
const STATE_LINE = /^Regression state: (fixed|reverted|parked)\b/;
const PARKED = /^Regression state: parked\s+[—–-]+\s*(\S.*)$/;
const MAIN_EVENTS = new Set(['push', 'schedule', 'workflow_dispatch']);
const MAIN_REF = 'refs/heads/main';
const byStep = (a, b) => a.localeCompare(b, 'en', { numeric: true });

/**
 * Each journey step in a Playwright JSON report: { states: { step: "passed"|"flaky"|"failed"|"skipped" }, files: { step: file } }.
 * Main trust's rule (post-merge-trust.mjs stepStates): a step with any test that did not end expected or flaky failed,
 * and a failing duplicate title never hides behind a passing one. A step whose tests all passed, at least one only on its
 * retry, is "flaky": a test Playwright calls flaky counts only when an attempt failed (or timed out) and a later attempt
 * passed. Playwright also calls a failed test whose retry was skipped flaky; that is a failure. `retried` holds every
 * step with a test Playwright called flaky, which a count of proven steps must leave out whatever its state.
 */
const FAILED_ATTEMPT = new Set(['failed', 'timedOut']);
export const passedAfterFailing = (t) => {
  const r = (t.results ?? []).map((x) => x.status);
  const firstFail = r.findIndex((x) => FAILED_ATTEMPT.has(x));
  return firstFail !== -1 && r.slice(firstFail + 1).includes('passed');
};
export function readReport(report) {
  const states = {};
  const files = {};
  const retried = new Set();
  const walk = (suite, file) => {
    const here = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      const m = STEP_TITLE.exec(spec.title ?? '');
      if (!m) continue;
      const key = `${m[1]}#${Number(m[2])}`;
      const tests = spec.tests ?? [];
      if (tests.some((t) => t.status === 'flaky')) retried.add(key);
      const state =
        tests.length && tests.every((t) => t.status === 'skipped')
          ? 'skipped'
          : tests.length && tests.every((t) => t.status === 'expected' || (t.status === 'flaky' && passedAfterFailing(t)))
            ? tests.some((t) => t.status === 'flaky')
              ? 'flaky'
              : 'passed'
            : 'failed';
      const had = states[key];
      states[key] = ['failed', 'flaky', 'passed'].find((s) => had === s || state === s) ?? 'skipped';
      const f = spec.file ?? here;
      if (f && !files[key]) files[key] = String(f).split('/').pop();
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const suite of report?.suites ?? []) walk(suite, suite.file);
  return { states, files, retried };
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

/**
 * The set-aside's own money guard, wider than the money rule (which stays the baseline's): a step is never set aside
 * when the money rule calls it money, its journey is a wallet, bank, pay or p2p journey (p2p: escrow and settlement)
 * or J-ops-console-27 (the money journeys of project-state's proof definition, plus p2p), it has no slices, or any of its slices touches nothing or is unknown.
 * Unknown means money, as a step missing from journeys.json already does. Returns { step: true when guarded }.
 */
export function setAsideGuard({ journeys, slices, money }) {
  const touches = new Map(slices.map((x) => [x.id, x.touches ?? []]));
  const out = {};
  for (const j of journeys)
    for (const st of j.steps ?? []) {
      const key = `${j.id}#${st.n}`;
      const ids = st.slices ?? [];
      out[key] =
        (money[key] ?? true) ||
        /^J-(wallet|bank|pay|p2p)-/.test(j.id) ||
        j.id === 'J-ops-console-27' ||
        ids.length === 0 ||
        ids.some((id) => !(touches.get(id)?.length > 0));
    }
  return out;
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

const RAN = new Set(['passed', 'flaky', 'failed']);
const PASSED_BEFORE = new Set(['passed', 'flaky']);

/**
 * The set-aside list after this run: { step: { since, sinceAt, until, active, owner, before } }. `prior` is the rows of
 * the last run on main's set-aside.json ([{ step, since, sinceAt, until, state }]); `states` is this run's readReport()
 * states (only on main: a branch run never retries); `run` is { number, at } for this run; `money` is the set-aside's
 * guard (setAsideGuard: true means never set aside); `owners` maps a journey id to
 * its module area. A prior entry stays until SET_ASIDE_DAYS after its end (`active` while before the end), so a step
 * gets one set-aside at a time; a non-money step flaky in this run with no entry gets a new one. A money step never.
 * `before` is the step's state in the run just before this one, or null when `prior` is not that run's complete list
 * (`priorIsPrevious` false): then no failure is excused this run (fail closed).
 */
export function setAsideSteps({ prior = [], priorIsPrevious = true, states = {}, money, owners = {}, run, days = SET_ASIDE_DAYS }) {
  const now = Date.parse(run.at);
  const owner = (step) => (owners[step.split('#')[0]] ? `the ${owners[step.split('#')[0]]} area` : 'unknown');
  const out = {};
  for (const e of prior) {
    // The end date is re-derived from the start, never taken as written; a start that is missing or after now carries nothing.
    const start = Date.parse(e?.sinceAt);
    if (typeof e?.step !== 'string' || (money[e.step] ?? true) || !(start <= now)) continue;
    const until = new Date(start + days * DAY_MS).toISOString();
    if (!(now < Date.parse(until) + days * DAY_MS)) continue;
    out[e.step] = {
      since: e.since,
      sinceAt: e.sinceAt,
      until,
      active: now < Date.parse(until),
      owner: owner(e.step),
      before: priorIsPrevious ? (e.state ?? null) : null,
    };
  }
  for (const [step, s] of Object.entries(states))
    if (s === 'flaky' && !out[step] && !(money[step] ?? true))
      out[step] = {
        since: run.number,
        sinceAt: run.at,
        until: new Date(now + days * DAY_MS).toISOString(),
        active: true,
        owner: owner(step),
      };
  return out;
}

/**
 * The verdict. `newest` and `named` are readReport() results for this run and the baseline's named run; `passedSince`
 * maps a step to the newest run on main after the named run that passed it; `issues` maps an issue number to its read;
 * `target` is the set of journey file names a targeted run ran, or null for a full run; `setAside` is setAsideSteps();
 * `guard` is setAsideGuard() (the money rule when not given): a guarded step is never set aside.
 * Returns { failing, red, setAside } (setAside: the steps a set-aside kept out of the red, with their state this run).
 */
export function judge({ newest, named, baseline, money, guard = money, passedSince = {}, issues = {}, target = null, setAside = {} }) {
  const inScope = (step, files) => !target || target.has(files[step]);
  // A pass only on the retry counts as a failure unless the step is set aside (a money step never is).
  const asideNow = (step) => setAside[step]?.active && !(guard[step] ?? true);
  const failing = new Set(
    Object.entries(newest.states)
      .filter(([k, s]) => s === 'failed' || (s === 'flaky' && !asideNow(k)))
      .map(([k]) => k),
  );
  for (const [step, s] of Object.entries(named.states))
    if ((s === 'passed' || s === 'flaky') && !RAN.has(newest.states[step]) && inScope(step, named.files)) failing.add(step);
  const entries = new Map();
  const dupes = new Set();
  for (const e of baseline?.steps ?? []) entries.has(e.step) ? dupes.add(e.step) : entries.set(e.step, e);
  const notBaselined = new Set((baseline?.notBaselined ?? []).map((e) => e.step));
  const runNo = baseline?.run?.number;
  const red = [];
  const kept = [];
  for (const step of [...failing].sort(byStep)) {
    const isMoney = money[step] ?? true; // a step missing from journeys.json counts as money
    const e = entries.get(step);
    const flaky = newest.states[step] === 'flaky';
    const no = (why) =>
      red.push({
        step,
        why: flaky
          ? `failed, then passed on its retry, and ${(guard[step] ?? true) ? 'a money step is never set aside' : 'it is not set aside now'}: ${why}`
          : why,
        money: isMoney,
      });
    // Set aside by the machine: it ran and failed, it is not money, its set-aside lasts, the run just before this one
    // showed it passing (two failures in a row is broken; an unknown previous result excuses nothing), and its baseline
    // entry (if any) is well formed. Skipped or missing never.
    if (
      asideNow(step) &&
      newest.states[step] === 'failed' &&
      PASSED_BEFORE.has(setAside[step].before) &&
      !dupes.has(step) &&
      (!e || e.money === isMoney)
    ) {
      kept.push(step);
      continue;
    }
    if (!e) {
      if (notBaselined.has(step)) no(`listed as notBaselined in run ${runNo}'s baseline, so it counts as failing`);
      else
        no(
          newest.states[step] === 'failed' || flaky
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
  return { failing: failing.size, red, setAside: kept };
}

/** Whether `sha` is this checkout's HEAD or an ancestor of it (the journeys job checks out with full history). */
const isAncestor = (sha) => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', String(sha), 'HEAD'], { stdio: 'ignore' });
    return /^[0-9a-f]{40}$/i.test(String(sha));
  } catch {
    return false;
  }
};

/** How many of main's newest finished runs to look through for the last complete set-aside list. */
export const PRIOR_LOOKBACK = 5;

/**
 * The last complete set-aside list on main: `runs` is historyRuns() (oldest first), `read(id)` a run's set-aside.json or
 * null (read(id, run) also gets the run). The newest run whose list is there, complete and written on `refs/heads/main`
 * (never a tag named main) wins, so the end dates carry on; a run before the set-aside
 * existed has none. `previous` is true only when that list is the run just before this one's: otherwise the step's
 * previous result is unknown and no failure is excused (setAsideSteps priorIsPrevious). Returns { steps, from, previous }.
 */
export function priorSetAside(runs, read) {
  const newest = runs.at(-1);
  for (const r of [...runs].reverse().slice(0, PRIOR_LOOKBACK)) {
    const list = read(r.id, r);
    if (list && list.ref === MAIN_REF && !list.incomplete && Array.isArray(list.steps))
      return { steps: list.steps, from: r.run_number, previous: r === newest };
  }
  return { steps: [], from: null, previous: false };
}

/** The pass history after the named run: for each step, the newest run number that passed it. `reports` is
 *  [[runNumber, readReport() result]]. */
export function passesSince(reports) {
  const out = {};
  for (const [n, r] of reports)
    for (const [step, s] of Object.entries(r.states)) if ((s === 'passed' || s === 'flaky') && !(out[step] >= n)) out[step] = n;
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
/** A JSON file from a run's journeys artifact (report.json by default). When `optional`, a run with no such artifact, or an
 *  artifact without the file, gives null (a malformed file still throws). */
function downloadReport(repo, runId, file = 'report.json', optional = file !== 'report.json') {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-'));
  try {
    try {
      execFileSync('gh', ['run', 'download', String(runId), '--repo', repo, '--name', JOURNEYS_ARTIFACT, '--dir', dir], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      if (optional) return null;
      throw e;
    }
    const f = join(dir, file);
    if (!existsSync(f)) {
      if (optional) return null;
      throw new Error(`run ${runId}'s ${JOURNEYS_ARTIFACT} artifact has no ${file}`);
    }
    return json(f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
export function manifestsAt(root) {
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
  const journeys = json(join(root, 'docs/roadmap/journeys.json'));
  const money = moneyRule({ journeys, slices: json(join(root, 'docs/roadmap/slices.json')), manifests: manifestsAt(root) });
  const owners = Object.fromEntries(journeys.map((j) => [j.id, j.module]));
  const guard = setAsideGuard({ journeys, slices: json(join(root, 'docs/roadmap/slices.json')), money });
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
  let thisRun = {
    number: Number(arg('--run-number') ?? process.env.GITHUB_RUN_NUMBER) || null,
    at: arg('--now') ?? new Date().toISOString(),
  };
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
      const current = ghApi(`/repos/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`);
      const all = ghPages(
        `/repos/${repo}/actions/workflows/${JOURNEYS_FILE}/runs?branch=main&status=completed&created=${encodeURIComponent(`>=${namedRun.created_at}`)}`,
        'workflow_runs',
      );
      const runs = historyRuns(all, { repo, namedCreated: namedRun.created_at, thisCreated: current.created_at, thisId: current.id });
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

  // The set-aside list: the last run on main's, carried on, plus this run's own flaky steps when it ran on main (a
  // targeted run on a branch never retries). An unreadable list is red, and this run's list says it is incomplete, so
  // the next run reads an earlier one instead of starting over.
  let prior = [];
  let priorIsPrevious = false;
  let incomplete = false;
  try {
    if (arg('--prior-set-aside')) {
      // Offline: the file stands for the run just before this one, so an incomplete one excuses nothing.
      const list = json(arg('--prior-set-aside'));
      prior = list.steps ?? [];
      priorIsPrevious = !list.incomplete;
    } else if (fetch) {
      const current = ghApi(`/repos/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`);
      thisRun = { number: current.run_number, at: current.created_at };
      const recent = ghApi(`/repos/${repo}/actions/workflows/${JOURNEYS_FILE}/runs?branch=main&status=completed&per_page=30`).workflow_runs;
      const found = priorSetAside(
        historyRuns(recent, { repo, namedCreated: '', thisCreated: current.created_at, thisId: current.id }),
        // Only a run whose commit is in this run's history: a run on anything else named main never feeds the list.
        (id, r) => (isAncestor(r.head_sha) ? downloadReport(repo, id, 'set-aside.json') : null),
      );
      prior = found.steps;
      priorIsPrevious = found.previous;
      console.log(
        found.from
          ? `set-aside list carried on from run ${found.from}${found.previous ? '' : ', not the run just before this one: no failure is excused this run'}`
          : 'no earlier set-aside list on main: it starts from this run',
      );
    }
  } catch (e) {
    incomplete = true;
    problem(`the last run on main's set-aside list couldn't be read: ${e.message.split('\n')[0]}`);
  }
  const onMain = !target && (!fetch || process.env.GITHUB_REF === MAIN_REF);
  const setAside = newest
    ? setAsideSteps({ prior, priorIsPrevious, states: onMain ? newest.states : {}, money: guard, owners, run: thisRun })
    : {};
  const verdict =
    newest && named
      ? judge({ newest, named, baseline, money, guard, passedSince, issues, target, setAside })
      : { failing: 0, red: [], setAside: [] };
  verdict.red.unshift(...red);
  const asideRows = Object.entries(setAside)
    .sort(([a], [b]) => byStep(a, b))
    .map(([step, { before, ...a }]) => ({ step, file: newest?.files[step] ?? null, state: newest?.states[step] ?? 'missing', ...a }));
  if (arg('--set-aside-out')) {
    // Not proven from this run: every set-aside step, and every step with a test Playwright called flaky (a pass only on
    // its retry, or a failure whose retry was skipped), money or not.
    const flakyNow = [...(newest?.retried ?? [])];
    const notProven = [...new Set([...asideRows.filter((r) => r.active).map((r) => r.step), ...flakyNow])].sort(byStep);
    // The ref it ran on: the next run takes the list only from refs/heads/main.
    const out = {
      days: SET_ASIDE_DAYS,
      run: thisRun,
      ref: process.env.GITHUB_REF ?? null,
      ...(incomplete || !newest ? { incomplete: true } : {}),
      steps: asideRows,
      notProven,
    };
    writeFileSync(arg('--set-aside-out'), `${JSON.stringify(out, null, 2)}\n`);
  }
  const lines = [
    '### Verdict against the list of steps not built yet',
    '',
    `Baseline: run ${baseline.run?.number} (\`${BASELINE_PATH}\`).${target ? ` Targeted run: ${[...target].join(', ')}.` : ''}`,
    `Failing or missing steps: ${verdict.failing}; outside the list or against its rules: **${verdict.red.length}**.`,
    '',
    ...(verdict.red.length
      ? verdict.red.map((r) => `- ${r.step}${r.money ? ' (money)' : ''}: ${r.why}`)
      : ['Every failing step is on the list by its rules, so this run is green.']),
    '',
    `### Set aside by the machine: ${asideRows.filter((r) => r.active).length}`,
    '',
    `A step that failed, then passed on its retry, on main, is set aside for ${SET_ASIDE_DAYS} days from the first such run. It still runs and its result is below; it doesn't count as proven; its failure doesn't turn this verdict red. A money step is never set aside.`,
    '',
    ...(asideRows.length
      ? asideRows.map(
          (r) =>
            `- ${r.step}: ${r.state} in this run; ${r.active ? `set aside until ${r.until}` : `set-aside ended ${r.until}, so it blocks again`} (first flaky in run ${r.since}); owner: ${r.owner}${verdict.setAside.includes(r.step) ? '; its failure was kept out of the red' : ''}`,
        )
      : ['None.']),
  ];
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  process.exit(verdict.red.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
