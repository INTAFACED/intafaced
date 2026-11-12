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
 * Main trust runs this on its hourly timer (main-trust.yml `revive`). It reads main's own journeys runs (push, schedule,
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
 *   - main is back (mainBack): every main run a row names, and every red main run in the window, has its report, and no
 *     main run's re-run attempt is still going.
 * It runs after each Real-app journeys run on main ends (main-trust.yml post-merge, `prs`), so it follows main's
 * report coming back within minutes, and on the hourly `revive` tick after the main pass, for any other input outage.
 *
 * A refused request (403, 429) stops the tick, never retried, and opens one issue (REFUSED_TITLE) when GitHub still takes it.
 *
 *   node tooling/ci/journeys-revive.mjs        main runs, then pull requests (GITHUB_REPOSITORY, GH_TOKEN; DRY_RUN=1 writes nothing)
 *   node tooling/ci/journeys-revive.mjs prs    pull requests only
 * Its tests: tooling/ci/journeys-revive.test.mjs.
 */
import { downloadReport, isMainRun, JOURNEYS_FILE } from './journey-verdict.mjs';

export const MAX_ATTEMPT = 5;
/** Minutes to wait after attempt n ended before asking for attempt n + 1. */
export const WAIT_MINUTES = { 1: 30, 2: 60, 3: 120, 4: 240 };
// The whole series (four waits of 30 min to 4 h, five attempts of about an hour) ends within about 13 h of a run starting.
export const WINDOW_HOURS = 24;

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
export async function tick({ repo, now, io }) {
  const out = [];
  for (const run of candidates(await io.listRuns(), { repo, now })) {
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

/** Red only on main's inputs: every row is an `(input)` row MAIN_INPUTS names. Returns the main run ids the rows name. */
export function mainInputOnly(rows) {
  if (!rows?.length) return null;
  const ids = new Set();
  for (const row of rows) {
    const m = row.match(/^\(input\) \(money\): (.*)$/);
    if (!m || !MAIN_INPUTS.some((re) => re.test(m[1]))) return null;
    for (const id of m[1].matchAll(/\b(\d{9,})\b/g)) ids.add(Number(id[1]));
  }
  return { runIds: [...ids] };
}

/** Is main back: no main re-run attempt still going, and every red main run in the window has its report. */
export async function mainBack({ repo, now, io }) {
  const runs = await io.listRuns();
  const going = runs.filter((r) => isMainRun(r, repo) && r.status !== 'completed' && Number(r.run_attempt) > 1);
  if (going.length) return { back: false, why: `main run ${going[0].run_number}'s re-run is still going` };
  for (const r of candidates(runs, { repo, now }))
    if (!(await io.hasReport(r))) return { back: false, why: `main run ${r.run_number} has no report` };
  return { back: true };
}

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
    let missing = null;
    for (const id of input.runIds) if (!(await io.hasReport({ id }))) missing ??= id;
    if (!back.back || missing) {
      out.push(`${name} (#${n}): red only on main's inputs, waiting (${missing ? `run ${missing} has no report yet` : back.why})`);
      continue;
    }
    const r = await io.rerun(run);
    out.push(
      `${name} (#${n}): red only on main's inputs, main is back, ${r.ok ? 're-run of failed jobs requested' : `GitHub did not take its re-run (${r.status})`}`,
    );
  }
  return out;
}

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
  if (res.status === 403 || res.status === 429) throw new Error(`GitHub ${res.status} on ${method} ${path}: stopping, not retrying`);
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
    createIssue: (title, body) => gh('POST', `/repos/${repo}/issues`, { title, body }),
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
    jobLog: async (job) => (await gh('GET', `/repos/${repo}/actions/jobs/${job.id}/logs`, undefined, true)).text,
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
  const prsOnly = process.argv[2] === 'prs';
  (async () => {
    if (!prsOnly) {
      const lines = await tick({ repo, now: Date.now(), io });
      console.log(lines.length ? lines.join('\n') : 'every finished journeys run on main in the window has a report');
    }
    const lines = await prTick({ repo, now: Date.now(), io });
    console.log(lines.length ? lines.join('\n') : 'no pull request journeys run in the window is red only on the verdict');
  })().catch(async (e) => {
    console.error(`✖ journeys-revive: ${e.message}`);
    if (isRefusal(e)) await nameRefusal(io, e);
    process.exit(1);
  });
}
