#!/usr/bin/env node
/**
 * A Real-app journeys run on main that finished without a report is re-run, spaced out, until it has one.
 *
 * Why: every pull request's verdict reads the reports of main's finished journeys runs since the baseline, and a run whose
 * report can't be read fails that verdict closed (journey-verdict.mjs fetchInputs; OWNER 277). Run 4005 (43037279979)
 * died at "Install the browser" during an Ubuntu mirror outage on 11 Nov 2026: its first attempt ended 14:44 UTC, Main
 * trust's one shard re-run ended 15:23 UTC with no report again, and every pull request's verdict failed on it until a
 * person re-ran it at 23:14 UTC. The verdict stays as strict as it is; this only brings the report back.
 *
 * Main trust runs this on its hourly timer and after each CI run on main (main-trust.yml `revive`). It reads main's own journeys runs (push, schedule,
 * dispatch) created in the last WINDOW_HOURS, finished and not cancelled or skipped, that did not succeed (a run still going,
 * or one of its attempts still going, is left alone), and for each one whose `real-app-journeys` artifact has no
 * report.json:
 *   attempt below MAX_ATTEMPT, ended at least WAIT_MINUTES[attempt] ago   re-run its failed jobs
 *   attempt below MAX_ATTEMPT, ended more recently                         wait for a later tick
 *   attempt MAX_ATTEMPT (its last try), or GitHub refuses the re-run        open one issue naming it, once
 * The waits grow (30 min, 1 h, 2 h, 4 h), so the tries outlast an outage of several hours, and the attempts are bounded:
 * at most MAX_ATTEMPT - 1 re-runs per run, ever. A refused request (403, 429) stops the tick, never retried.
 *
 * PULL REQUESTS (prTick). A pull request's journeys run that is red only because the verdict couldn't read main's
 * inputs is re-run once those inputs are back, so one dead main run no longer keeps every open pull request red until a
 * person re-runs each. Run 4005 again: main's run was green at 23:50 UTC on 11 Nov, the open pull requests stayed red,
 * and a person re-ran six of them at 23:52 UTC; four went green. The verdict's judgement is unchanged and still fails
 * closed: this only asks GitHub to run the same verdict again on the same head. A run is re-run when all of these hold:
 *   - it is a pull_request run of this repository, finished `failure`, created in the last WINDOW_HOURS, its attempt
 *     below PR_MAX_ATTEMPT (so at most PR_MAX_ATTEMPT - 1 re-runs per run, and so per head);
 *   - its pull request is open, not a draft, its head is still this run's head, and no newer journeys run is on that head;
 *   - its one red job is JUDGE_JOB and that job's one failed step is JUDGE_STEP (a shard, the stack, the build or the
 *     verdict's own tests red is the pull request's own and stays red);
 *   - every row the verdict printed as red is an `(input)` row about main's inputs (MAIN_INPUTS: the baseline's named
 *     run's report, the pass history, the last set-aside list). One step row, or a row about this run's own report, and
 *     it stays red. No summary found in the log (the verdict threw, or its wording changed) is never re-run;
 *   - main is back (mainBack): no main run's re-run attempt is still going, the baseline's named run has its report, every
 *     other main run a row names has finished (with no report it is skipped by the verdict since 12 Nov, run 4084), and,
 *     when a row says the API rate limit was hit, the budget has VERDICT_CALLS left.
 * It runs after each Real-app journeys run on main ends (main-trust.yml post-merge, `prs`), so it follows main's
 * report coming back within minutes, and on the hourly `revive` tick after the main pass, for any other input outage.
 *
 * A refused request (403, 429) stops the tick, never retried, and opens one issue (REFUSED_TITLE) when GitHub still takes it.
 *
 *   node tooling/ci/journeys-revive.mjs        main runs, then pull requests (GITHUB_REPOSITORY, GH_TOKEN; DRY_RUN=1 writes nothing)
 *   node tooling/ci/journeys-revive.mjs prs    pull requests only
 *   node tooling/ci/journeys-revive.mjs main   main runs only (after each CI run on main: GitHub's cron here runs late or never)
 *   node tooling/ci/journeys-revive.mjs held   open armed pull requests held only by main's reds that main has since lost
 *                                              get a fresh head (heldTick; FACTORY_APP_KEY, after each journeys run on main)
 * Its tests: tooling/ci/journeys-revive.test.mjs.
 */
import { downloadReport, isMainRun, JOURNEYS_FILE } from './journey-verdict.mjs';
import { refusalDetail } from './refusal.mjs';

export const MAX_ATTEMPT = 5;
/** Minutes to wait after attempt n ended before asking for attempt n + 1. */
export const WAIT_MINUTES = { 1: 30, 2: 60, 3: 120, 4: 240 };
// The whole series (four waits of 30 min to 4 h, five attempts of about an hour) ends within about 13 h of a run starting.
export const WINDOW_HOURS = 24;
/** A journeys artifact this large holds a report (main's reports: about 4.6 MB on 11 and 12 Nov 2026; a dead run's: 287 bytes). */
export const REPORT_BYTES = 64 * 1024;

/** The label every issue this opens carries: a run with no report, or a refusal, is a break a builder takes. */
export const ISSUE_LABELS = ['regression'];

export const issueTitle = (run) => `Journeys run on main has no report: run ${run.run_number}`;

/** The runs worth a report check: main's own, finished, not cancelled or skipped, not green, inside the window. */
export function candidates(runs, { repo, now }) {
  const since = now - WINDOW_HOURS * 3600_000;
  return runs
    .filter((r) => isMainRun(r, repo))
    .filter((r) => r.status === 'completed' && !['cancelled', 'skipped', 'success'].includes(r.conclusion))
    .filter((r) => Date.parse(r.created_at) >= since)
    .sort((a, b) => a.run_number - b.run_number);
}

/** What to do with a finished run that has no report: 'rerun', 'wait' or 'name' (its last try is spent). */
export function decide(run, now) {
  const attempt = Number(run.run_attempt || 1);
  if (attempt >= MAX_ATTEMPT) return 'name';
  const endedAgo = (now - Date.parse(run.updated_at)) / 60_000;
  return endedAgo >= WAIT_MINUTES[attempt] ? 'rerun' : 'wait';
}

export function issueBody(run, repo) {
  return [
    `Real-app journeys [run ${run.run_number}](https://github.com/${repo}/actions/runs/${run.id}) on main (\`${String(run.head_sha).slice(0, 10)}\`) has no \`report.json\` after ${run.run_attempt} attempts, the last ending ${run.updated_at}.`,
    '',
    'Until it has one, every pull request\'s journeys verdict fails closed on it ("the pass history couldn\'t be read"; tooling/ci/journey-verdict.mjs). Main trust re-ran its failed jobs with growing waits (tooling/ci/journeys-revive.mjs) and stops here.',
    '',
    "Next: read why its shards died before their tests. When the cause is gone, re-run the run's failed jobs; a run that can never report is settled only by rewriting the baseline from a newer run (docs/runbooks/regression-issue-state.md).",
  ].join('\n');
}

/**
 * One tick. `io` is GitHub: listRuns(), hasReport(run), rerun(run) -> { ok, status }, openIssue(title) -> issue|null,
 * createIssue(title, body). Returns the actions taken, one line per run, for the log and the tests.
 */
export async function tick({ repo, now, io, lazy = false }) {
  const out = [];
  for (const run of candidates(await io.listRuns(), { repo, now })) {
    // `lazy` (after each CI run on main, many times an hour): a run still inside its wait isn't read at all, and a run
    // whose journeys artifact is large (a report is megabytes; run 4005's dead artifact was 287 bytes) costs one read,
    // not a download. The installation's API budget is shared with the merge seal, which fails closed on a 403 (#8038).
    if (lazy && decide(run, now) === 'wait') continue;
    if (lazy && (await io.reportLikely(run))) continue;
    if (await io.hasReport(run)) continue;
    const action = decide(run, now);
    const name = `run ${run.run_number} (${run.id}) attempt ${run.run_attempt}`;
    if (action === 'wait') {
      out.push(`${name}: no report, waiting ${WAIT_MINUTES[run.run_attempt]} min after it ended`);
      continue;
    }
    let why = 'after its last try';
    if (action === 'rerun') {
      const r = await io.rerun(run);
      if (r.ok) {
        out.push(`${name}: no report, re-run of failed jobs requested`);
        continue;
      }
      // GitHub would not re-run it (no failed job to re-run, or the run can't be re-run): asking every hour changes
      // nothing, so it is named now.
      why = `and GitHub did not take its re-run (${r.status})`;
    }
    if (await io.openIssue(issueTitle(run))) out.push(`${name}: no report ${why}, issue already open`);
    else {
      await io.createIssue(issueTitle(run), issueBody(run, repo));
      out.push(`${name}: no report ${why}, issue opened`);
    }
  }
  return out;
}

// ── Pull requests red only on main's inputs ───────────────────────────────
/** At most PR_MAX_ATTEMPT - 1 re-runs of one pull request's run, whose head it is. */
export const PR_MAX_ATTEMPT = 3;
/** The scoreboard job and its verdict step (real-app-journeys.yml): rename them together. */
export const JUDGE_JOB = 'Real-app journeys';
export const JUDGE_STEP = 'Verdict against the list of steps not built yet';
/** The verdict's `(input)` rows that are about main's runs, never this run's own work (journey-verdict.mjs main). */
export const MAIN_INPUTS = [
  /^the pass history couldn't be read: /,
  /^the baseline's named run .* report couldn't be read: /,
  /^the last run on main's set-aside list couldn't be read: /,
];
export const REFUSED_TITLE = 'Journeys re-runs stopped: GitHub refused a request';

/**
 * The verdict's red rows from its job log: the `- ` lines after "outside the list or against its rules: **N**.", N of
 * them. null when the summary isn't there or the count doesn't match (the verdict threw, or its wording changed): never
 * read as input-only.
 */
export function verdictReds(log) {
  const lines = String(log)
    .split('\n')
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, '').replace(/\r$/, ''));
  const at = lines.findIndex((l) => /outside the list or against its rules: \*\*\d+\*\*\./.test(l));
  if (at < 0) return null;
  const n = Number(lines[at].match(/\*\*(\d+)\*\*/)[1]);
  const rows = [];
  for (const l of lines.slice(at + 1)) {
    if (l.startsWith('- ')) rows.push(l.slice(2));
    else if (l.trim() === '' && rows.length === 0) continue;
    else break;
  }
  return rows.length === n ? rows : null;
}

/**
 * Red only on main's inputs: every row is an `(input)` row MAIN_INPUTS names. Returns the main run ids the rows name
 * (`runIds`), the baseline's named run among them (`namedIds`: the verdict needs its report), and whether a row says the
 * API budget was spent (`rateLimited`).
 */
export function mainInputOnly(rows) {
  if (!rows?.length) return null;
  const ids = new Set();
  const named = new Set();
  let rateLimited = false;
  for (const row of rows) {
    const m = row.match(/^\(input\) \(money\): (.*)$/);
    if (!m || !MAIN_INPUTS.some((re) => re.test(m[1]))) return null;
    for (const id of m[1].matchAll(/\b(\d{9,})\b/g)) ids.add(Number(id[1]));
    const n = m[1].match(/^the baseline's named run \S+ \((\d{9,})\)/);
    if (n) named.add(Number(n[1]));
    if (/rate limit/i.test(m[1])) rateLimited = true;
  }
  return { runIds: [...ids], namedIds: [...named], rateLimited };
}

/**
 * Is main back: no main re-run attempt still going. A finished main run with no report no longer holds the pull requests:
 * the verdict skips it in the pass history (journey-verdict.mjs readHistory), so re-running their verdict is enough. Until
 * 12 Nov this also waited for every red main run in the window to get its report, and run 4084, whose re-run was then
 * cancelled, would never have had one.
 */
export async function mainBack({ repo, io }) {
  const runs = await io.listRuns();
  const going = runs.filter((r) => isMainRun(r, repo) && r.status !== 'completed' && Number(r.run_attempt) > 1);
  if (going.length) return { back: false, why: `main run ${going[0].run_number}'s re-run is still going`, runs };
  return { back: true, runs };
}

/** API calls one verdict's inputs spend, with room (98 history runs read on 12 Nov 2026: 208 calls; it grows by two
 *  per main run until the baseline is rewritten, HISTORY_MAX 150 runs). A re-run asked with less left would only spend
 *  one of the run's re-runs on the same limit. */
export const VERDICT_CALLS = 400;

/** The pull request runs worth reading: this repository's, finished red, in the window, attempts left. */
export function prCandidates(runs, { repo, now }) {
  const since = now - WINDOW_HOURS * 3600_000;
  return runs
    .filter((r) => r.event === 'pull_request' && r.head_repository?.full_name === repo)
    .filter((r) => r.status === 'completed' && r.conclusion === 'failure')
    .filter((r) => Date.parse(r.created_at) >= since)
    .filter((r) => Number(r.run_attempt || 1) < PR_MAX_ATTEMPT)
    .sort((a, b) => a.run_number - b.run_number);
}

/** Why a run's red is its own (a string), or null when its only red is the verdict step. */
export function ownRed(jobs) {
  const red = jobs.filter((j) => !['success', 'skipped', 'neutral'].includes(j.conclusion));
  if (red.length !== 1 || red[0].name !== JUDGE_JOB) return `red jobs: ${red.map((j) => j.name).join(', ') || 'none'}`;
  const steps = (red[0].steps ?? []).filter((s) => !['success', 'skipped', 'neutral'].includes(s.conclusion));
  if (steps.length !== 1 || steps[0].name !== JUDGE_STEP) return `red steps: ${steps.map((s) => s.name).join(', ') || 'none'}`;
  return null;
}

/**
 * One pass over the pull requests. `io` adds to the main tick's: listPrRuns(), pull(n) -> { state, draft, head: { sha } },
 * headRuns(sha) -> runs, jobs(run) -> jobs of its latest attempt, jobLog(job) -> text. Returns one line per run read.
 */
export async function prTick({ repo, now, io }) {
  const out = [];
  let back = null;
  for (const run of prCandidates(await io.listPrRuns(), { repo, now })) {
    const name = `pull request run ${run.run_number} (${run.id}) attempt ${run.run_attempt}`;
    const n = run.pull_requests?.[0]?.number;
    if (!n) continue;
    const pr = await io.pull(n);
    if (pr.state !== 'open' || pr.draft || pr.head?.sha !== run.head_sha) continue;
    const newer = (await io.headRuns(run.head_sha)).some((r) => r.run_number > run.run_number);
    if (newer) continue;
    const jobs = await io.jobs(run);
    const own = ownRed(jobs);
    if (own) {
      out.push(`${name} (#${n}): its own red (${own}), left red`);
      continue;
    }
    const rows = verdictReds(await io.jobLog(jobs.find((j) => j.name === JUDGE_JOB)));
    const input = mainInputOnly(rows);
    if (!input) {
      out.push(`${name} (#${n}): its own red (${rows ? rows.join(' | ').slice(0, 300) : 'no verdict summary in the log'}), left red`);
      continue;
    }
    back ??= await mainBack({ repo, now, io });
    // The baseline's named run must have its report; any other run a row names need only have finished: one with no
    // report is skipped by the verdict now, and one cancelled has left the history.
    let missing = null;
    for (const id of input.namedIds) if (!(await io.hasReport({ id }))) missing ??= `run ${id} has no report yet`;
    for (const id of input.runIds) {
      const r = back.runs.find((x) => x.id === id);
      if (r && r.status !== 'completed') missing ??= `run ${r.run_number} is still going`;
    }
    if (!missing && input.rateLimited) {
      const b = await io.budget();
      if (b.remaining < VERDICT_CALLS)
        missing = `the API budget has ${b.remaining} of ${b.limit} calls left, under ${VERDICT_CALLS}, until ${new Date(b.reset * 1000).toISOString()}`;
    }
    if (!back.back || missing) {
      out.push(`${name} (#${n}): red only on main's inputs, waiting (${back.back ? missing : back.why})`);
      continue;
    }
    const r = await io.rerun(run);
    out.push(
      `${name} (#${n}): red only on main's inputs, main is back, ${r.ok ? 're-run of failed jobs requested' : `GitHub did not take its re-run (${r.status})`}`,
    );
  }
  return out;
}

// ── Pull requests held by main's reds that main has since lost ────────────
/** At most this many of main's red runs in the window are read for the steps main was red on. */
export const HELD_MAIN_RUNS = 12;
/** The step a verdict row is about (`J-campaigns-01#3 (money): failing, …` → `J-campaigns-01#3`), or null for an
 *  `(input)` row or a row in another shape. */
export const rowStep = (row) => /^(J-[A-Za-z0-9-]+#\d+[a-z]?)(?: \(money\))?: /.exec(String(row))?.[1] ?? null;

/**
 * Main's newest finished journeys run (not cancelled or skipped) and the steps it is red on, with every earlier red
 * main run's steps in the window: `before`, the steps main was red on; `now`, the steps it is red on today. null when
 * main's newest run has no readable verdict summary or an `(input)` row (it can't say what main has).
 */
export async function mainSteps({ repo, now, io }) {
  const since = now - WINDOW_HOURS * 3600_000;
  const done = (await io.listRuns())
    .filter((r) => isMainRun(r, repo) && r.status === 'completed' && !['cancelled', 'skipped'].includes(r.conclusion))
    .filter((r) => Date.parse(r.created_at) >= since)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.run_number - a.run_number);
  if (!done.length) return null;
  const stepsOf = async (r) => {
    const jobs = await io.jobs(r);
    const judge = jobs.find((j) => j.name === JUDGE_JOB);
    const rows = judge ? verdictReds(await io.jobLog(judge)) : null;
    if (!rows || rows.some((x) => !rowStep(x))) return null;
    return new Set(rows.map(rowStep));
  };
  const newest = done[0];
  const nowSteps = await stepsOf(newest);
  if (!nowSteps) return null;
  const before = new Set();
  for (const r of done
    .slice(1)
    .filter((x) => x.conclusion !== 'success')
    .slice(0, HELD_MAIN_RUNS))
    for (const s of (await stepsOf(r)) ?? []) before.add(s);
  return { newest, now: nowSteps, before };
}

/**
 * Whether an open pull request is held only by main's reds that main has since lost: { held, why } (why for the log).
 * `pr` is GitHub's pull request, `run` the newest journeys run on its head, `rows` that run's verdict reds, `main`
 * mainSteps(). Held: armed (auto-merge on), not a draft, a branch of this repository; its run finished red only on the
 * verdict step (ownRed) and before main's newest run started; every red row a step main was red on and is not red on
 * any more. Anything else (an `(input)` row, a step main never had red, a step still red on main) is its own and
 * stays red.
 */
export function heldOnly({ repo, pr, run, jobs, rows, main }) {
  if (pr.state !== 'open' || pr.draft || !pr.auto_merge || pr.head?.repo?.full_name !== repo)
    return { why: 'not an open armed pull request of this repository' };
  if (!run || run.head_sha !== pr.head?.sha || run.status !== 'completed' || run.conclusion !== 'failure')
    return { why: 'its head has no finished red journeys run' };
  const own = ownRed(jobs);
  if (own) return { why: `its own red (${own})` };
  if (!rows?.length) return { why: 'its own red (no verdict summary in the log)' };
  if (!main) return { why: "main's newest run has no readable verdict" };
  if (Date.parse(run.created_at) >= Date.parse(main.newest.created_at))
    return { why: `its run started after main's newest run ${main.newest.run_number}` };
  const steps = rows.map(rowStep);
  const own2 = rows.filter((_, i) => !steps[i] || !main.before.has(steps[i]));
  if (own2.length) return { why: `its own red (${own2.join(' | ').slice(0, 200)})` };
  const still = steps.filter((s) => main.now.has(s));
  if (still.length) return { why: `held by ${still.join(', ')}, still red on main's newest run ${main.newest.run_number}` };
  return { held: true, why: `red only on ${steps.join(', ')}, which main's newest run ${main.newest.run_number} is no longer red on` };
}

/**
 * One pass after each Real-app journeys run on main ends: every open, armed pull request held only by main's reds that
 * main has since lost is brought onto a fresh head (the branch updated from main, a merge commit, never a force-push),
 * so its own checks, journeys and seal run again on code that holds the fix and it merges if it is otherwise green. A
 * re-run can't do this: it keeps its old merge commit, which still holds the break, and a run made before a change to
 * CI fails on main's newer guard (fix-01's read of 13 Nov 2026, 01:10 UTC). Bounded: the update gives the pull request a
 * new head, whose run is newer than main's run, so it is acted on at most once per main recovery. `io` adds to prTick's:
 * openPulls(), updateBranch(pr) -> { ok, status }. A refused request (403, 429) throws and stops the pass.
 */
export async function heldTick({ repo, now, io }) {
  const out = [];
  let main;
  for (const pr of await io.openPulls()) {
    if (pr.draft || !pr.auto_merge || pr.head?.repo?.full_name !== repo) continue;
    const runs = (await io.headRuns(pr.head.sha)).sort((a, b) => b.run_number - a.run_number);
    const run = runs[0];
    if (!run || run.status !== 'completed' || run.conclusion !== 'failure') continue;
    const jobs = await io.jobs(run);
    if (ownRed(jobs)) continue;
    const rows = verdictReds(await io.jobLog(jobs.find((j) => j.name === JUDGE_JOB)));
    if (main === undefined) main = await mainSteps({ repo, now, io });
    if (main === null) return [...out, "main's newest journeys run has no readable verdict: nothing moved"];
    const { held, why } = heldOnly({ repo, pr, run, jobs, rows, main });
    if (!held) {
      out.push(`#${pr.number}: run ${run.run_number}: ${why}, left as it is`);
      continue;
    }
    const r = await io.updateBranch(pr);
    out.push(
      `#${pr.number}: run ${run.run_number} ${why}; ${r.ok ? 'branch updated from main, a fresh head' : `GitHub did not update it (${r.status})`}`,
    );
  }
  return out;
}

/** The App token the held pass writes with: update a branch (contents), read pull requests and runs; workflows so a
 *  merge from main that carries main's own workflow changes is not refused. */
export const HELD_TOKEN = {
  repositories: ['intafaced'],
  permissions: { actions: 'read', contents: 'write', pull_requests: 'write', workflows: 'write' },
};

// ── GitHub ─────────────────────────────────────────────────────────────────
async function gh(method, path, body, raw = false) {
  if (process.env.DRY_RUN === '1' && method !== 'GET') {
    console.log(`DRY_RUN ${method} ${path}`);
    return { status: 0, json: null };
  }
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  // AGENTS.md's one exception: "already running" on a re-run only means a re-run is in progress.
  if (res.status === 403 && /already running/i.test(text)) return { status: 403, json: null, alreadyRunning: true };
  if (res.status === 403 || res.status === 429)
    throw new Error(`GitHub ${res.status} on ${method} ${path}: stopping, not retrying${refusalDetail(res.headers, text)}`);
  if (method === 'GET' && !res.ok) throw new Error(`GitHub ${res.status} on GET ${path}`);
  if (raw) return { status: res.status, text };
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** A refused request (gh above): it stops the tick. */
export const isRefusal = (e) => /^GitHub (403|429) on /.test(e?.message ?? '');

export function githubIo(repo) {
  return {
    listRuns: async () =>
      (await gh('GET', `/repos/${repo}/actions/workflows/${JOURNEYS_FILE}/runs?branch=main&per_page=100`)).json.workflow_runs,
    // At least REPORT_BYTES in the newest journeys artifact: one read, for the lazy tick.
    reportLikely: async (run) => {
      const a =
        (await gh('GET', `/repos/${repo}/actions/runs/${run.id}/artifacts?name=real-app-journeys&per_page=20`)).json.artifacts ?? [];
      const newest = a.filter((x) => !x.expired).sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at))[0];
      return Boolean(newest && newest.size_in_bytes >= REPORT_BYTES);
    },
    // The verdict's own reader: no artifact, or an artifact without report.json, is null; any other failure throws.
    hasReport: async (run) => downloadReport(repo, run.id, 'report.json', true) !== null,
    rerun: async (run) => {
      const r = await gh('POST', `/repos/${repo}/actions/runs/${run.id}/rerun-failed-jobs`);
      return { ok: r.alreadyRunning || r.status === 0 || (r.status >= 200 && r.status < 300), status: r.status };
    },
    openIssue: async (title) => {
      const q = encodeURIComponent(`repo:${repo} is:issue is:open in:title "${title}"`);
      return (await gh('GET', `/search/issues?q=${q}`)).json.items.find((i) => i.title === title) ?? null;
    },
    // Labelled from the moment it exists, so a builder's pick reads it (the lead's decision of 12 Nov 2026, item 4).
    createIssue: (title, body) => gh('POST', `/repos/${repo}/issues`, { title, body, labels: ISSUE_LABELS }),
    listPrRuns: async () => {
      const since = new Date(Date.now() - WINDOW_HOURS * 3600_000).toISOString();
      const q = `event=pull_request&status=failure&created=${encodeURIComponent(`>=${since}`)}&per_page=100`;
      return (await gh('GET', `/repos/${repo}/actions/workflows/${JOURNEYS_FILE}/runs?${q}`)).json.workflow_runs;
    },
    pull: async (n) => (await gh('GET', `/repos/${repo}/pulls/${n}`)).json,
    headRuns: async (sha) =>
      (await gh('GET', `/repos/${repo}/actions/workflows/${JOURNEYS_FILE}/runs?head_sha=${sha}&per_page=100`)).json.workflow_runs,
    jobs: async (run) =>
      (await gh('GET', `/repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt || 1}/jobs?per_page=100`)).json.jobs,
    // GET /rate_limit spends no budget.
    budget: async () => (await gh('GET', '/rate_limit')).json.resources.core,
    jobLog: async (job) => (await gh('GET', `/repos/${repo}/actions/jobs/${job.id}/logs`, undefined, true)).text,
    openPulls: async () => (await gh('GET', `/repos/${repo}/pulls?state=open&per_page=100`)).json,
    // A merge commit from main onto the branch; expected_head_sha so a head that moved since is not touched (422).
    updateBranch: async (pr) => {
      const r = await gh('PUT', `/repos/${repo}/pulls/${pr.number}/update-branch`, { expected_head_sha: pr.head.sha });
      return { ok: r.status === 0 || (r.status >= 200 && r.status < 300), status: r.status };
    },
  };
}

/** After a refusal: one issue, if GitHub still takes it; its own failure is only logged. */
async function nameRefusal(io, e) {
  try {
    if (await io.openIssue(REFUSED_TITLE)) return;
    await io.createIssue(
      REFUSED_TITLE,
      `Main trust's journeys re-runs (tooling/ci/journeys-revive.mjs) stopped on a refusal and did not retry it:\n\n\`${e.message}\`\n\nThe next tick tries again from scratch; read the refusal before anything else re-runs by hand.`,
    );
  } catch (e2) {
    console.error(`✖ journeys-revive: the refusal issue could not be opened either: ${e2.message}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !process.env.GH_TOKEN) {
    console.error('✖ journeys-revive: GITHUB_REPOSITORY and GH_TOKEN are required');
    process.exit(1);
  }
  const io = githubIo(repo);
  const issuesToken = process.env.GH_TOKEN;
  const mode = process.argv[2] ?? 'all';
  if (!['all', 'main', 'prs', 'held'].includes(mode)) {
    console.error(`✖ journeys-revive: unknown mode ${mode} (all, main, prs or held)`);
    process.exit(1);
  }
  (async () => {
    if (mode === 'held') {
      // An App token: a branch updated with GITHUB_TOKEN starts no workflow, so its checks and seal would never run.
      if (process.env.DRY_RUN !== '1') {
        if (!process.env.FACTORY_APP_KEY) throw new Error('FACTORY_APP_KEY is required for held');
        const { mintToken } = await import('./factory-builder.mjs');
        process.env.GH_TOKEN = await mintToken({ pem: process.env.FACTORY_APP_KEY, repo, spec: HELD_TOKEN });
        console.log(`::add-mask::${process.env.GH_TOKEN}`);
      }
      const lines = await heldTick({ repo, now: Date.now(), io });
      console.log(lines.length ? lines.join('\n') : 'no open armed pull request is held by a red main has since lost');
      return;
    }
    if (mode !== 'prs') {
      const lines = await tick({ repo, now: Date.now(), io, lazy: mode === 'main' });
      console.log(lines.length ? lines.join('\n') : 'every finished journeys run on main in the window has a report');
    }
    if (mode === 'main') return;
    const lines = await prTick({ repo, now: Date.now(), io });
    console.log(lines.length ? lines.join('\n') : 'no pull request journeys run in the window is red only on the verdict');
  })().catch(async (e) => {
    console.error(`✖ journeys-revive: ${e.message}`);
    process.env.GH_TOKEN = issuesToken; // the held pass's App token can't write issues
    if (isRefusal(e)) await nameRefusal(io, e);
    process.exit(1);
  });
}
