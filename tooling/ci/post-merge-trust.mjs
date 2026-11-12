#!/usr/bin/env node
/**
 * POST-MERGE TRUST: what Main trust does when a post-merge check on main finishes (workflow: main-trust.yml).
 * It only reads runs and opens, comments on or closes issues. It never blocks a merge and never runs on a schedule of its
 * own; it does compare Real-app journeys' daily scheduled run on main like a push run.
 *
 * Order-path CX-8 and Customer Money browser checks (whole-run checks):
 *   red after a green, first attempt   re-run the failed jobs once
 *   red after a green, re-run attempt  the break is real: open (or comment on) one "Broken on main: <check>" issue
 *                                      naming the commits between the last green run and this one
 *   red after a red                    nothing new while that check's issue is open; with no open issue (a check
 *                                      already red before this job existed, or an issue closed by hand), open one
 *                                      naming the last green run and the commits since, if one is within 100 runs
 *   green                              close that check's issue when this commit includes every red it names
 *
 * Real-app journeys (per journey step; the run's own conclusion is its verdict against the baseline of steps not built
 * yet, tooling/ci/journey-verdict.mjs, and this job compares steps whatever that verdict is):
 *   The run is compared with the finished run before it. This job opens no break issue: a step that passed and then
 *   failed outright starts the journeys revert at once (journeys-revert.mjs trigger), which opens the journey's
 *   "Journey broken on main: <J-id>" issue with the revert, or, when no single merge explains it, runs the step alone
 *   on main's head and opens a `flaky` issue (it passes) or the `regression` break issue (it fails again). The wait for
 *   a second red run is gone (the programme lead, 12 Nov 2026). A journey's issue closes here when every step it names
 *   passes again.
 *   The run summary lists the steps newly passing and newly failing against the run before.
 *   A shard that sent no report (no `real-app-journeys-shard-<n>` artifact: abandoned, cancelled by the platform, or
 *   its stack or browser never started) on a red first attempt, after that attempt's own checks: re-run its failed jobs
 *   once, then judge the next attempt (project-state #1786, 10 Nov). Only when every failed shard job sent no report and
 *   every such shard has a job: a shard that reported keeps its reds, and the whole run is never re-run. A shard with no
 *   report on the re-run, or one not re-run, still counts its journeys as not passing.
 *   A shard that hit its time limit (the job's, or the limit the shard puts on its own journeys so it still reports):
 *   open (or comment on) one "Broken on main: Real-app journeys (time limit)" issue naming the jobs; it closes on the
 *   next run where no job hit its limit.
 *   A step the run's verdict set aside (the artifact's set-aside.json, journey-verdict.mjs: it failed, then passed on its
 *   retry, on main, and it is not money): open one "Set aside on main until <date>: <step>" issue naming its owner and
 *   end date, once per set-aside (never again once closed); its owner may close it with the fix, and it closes itself
 *   on the first run after its end date.
 *   A money step that failed, then passed on its retry, on main (set-aside.json's `moneyFlaky`, project-state OWNER 278):
 *   open one "Flaky money step on main: <step>" issue, labelled `flaky`, naming its area, unless one is open already.
 *   Its owner closes it with the fix; the step never counts as proven meanwhile.
 *
 * A job that hits its time limit ends "cancelled", not "timed_out", like a run replaced by a newer one. A cancelled
 * run whose job carries GitHub's "exceeded the maximum execution time" annotation counts as timed out (red).
 *
 *   node tooling/ci/post-merge-trust.mjs --self-test
 *   DRY_RUN=1 (with the CI env below): reads for real, prints every write instead of sending it
 *   (CI) GH_TOKEN GITHUB_REPOSITORY WORKFLOW_ID WORKFLOW_NAME RUN_ID RUN_ATTEMPT CONCLUSION HEAD_SHA
 *        node tooling/ci/post-merge-trust.mjs
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const JOURNEYS_WORKFLOW = 'Real-app journeys';
export const JOURNEYS_ARTIFACT = 'real-app-journeys';
const STEP_TITLE = /^(J-[a-z0-9-]+-\d+)\s+#(\d+)\b/;
const COUNTED = new Set(['success', 'failure', 'timed_out']);
// GitHub's job limit, or the Real-app journeys shard's own limit on its journeys (the shard step names it this way).
const TIME_LIMIT = /exceeded the maximum execution time|journeys reached their time limit/i;
/** How many cancelled runs to look into for a timeout when walking back (a replaced run has no jobs, one cheap call). */
const CANCELLED_LOOKUPS = 20;

/**
 * Each journey step in a Playwright JSON report: "passed", "failed" or "skipped". The key is "J-<module>-NN#<step>",
 * as in tooling/scripts/roadmap.mjs passedSteps. A step with any test that did not end expected failed: a test that
 * passed only on its retry (Playwright's "flaky", on main since JOURNEY_RETRIES) is not a pass, money step or not, so
 * it never closes a journey's issue nor counts as passing (CI review on #7363, 1fbf031).
 */
export function stepStates(report) {
  const states = new Map();
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const m = STEP_TITLE.exec(spec.title ?? '');
      if (!m) continue;
      const key = `${m[1]}#${Number(m[2])}`;
      const tests = spec.tests ?? [];
      const state =
        tests.length && tests.every((t) => t.status === 'skipped')
          ? 'skipped'
          : tests.length && tests.every((t) => t.status === 'expected')
            ? 'passed'
            : 'failed';
      const had = states.get(key);
      states.set(key, had === 'failed' || state === 'failed' ? 'failed' : had === 'passed' || state === 'passed' ? 'passed' : 'skipped');
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report?.suites ?? []) walk(suite);
  return states;
}

const sortKeys = (keys) => [...keys].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

/** Steps newly passing and newly failing in `now` against `before` (a step absent or skipped in either is neither). */
export function stepChanges(before, now) {
  const newlyPassing = [];
  const newlyFailing = [];
  for (const [key, state] of now) {
    if (state === 'passed' && before.get(key) === 'failed') newlyPassing.push(key);
    if (state === 'failed' && before.get(key) === 'passed') newlyFailing.push(key);
  }
  return { newlyPassing: sortKeys(newlyPassing), newlyFailing: sortKeys(newlyFailing) };
}

/** What to do with a finished whole-run check. `previous` is the conclusion of the finished run before it. */
export function decideCheck({ conclusion, attempt, previous }) {
  if (conclusion === 'success') return 'green';
  if (conclusion !== 'failure' && conclusion !== 'timed_out') return 'ignore';
  if (previous !== 'success') return 'still-red';
  return attempt <= 1 ? 'rerun' : 'broken';
}

/** The jobs that hit their time limit, from each job's annotations. */
export function timedOutJobNames(jobs) {
  return jobs.filter((j) => (j.annotations ?? []).some((a) => TIME_LIMIT.test(a.message ?? ''))).map((j) => j.name);
}

/** A run's conclusion with a time-limit cancel read as "timed_out". */
export const runConclusion = (conclusion, timedOut) => (conclusion === 'cancelled' && timedOut.length ? 'timed_out' : conclusion);

/** Checks a commit can break without touching their code: the issue says so, so nobody reverts an innocent commit. */
const OUTSIDE_CAUSES = {
  'PR checks':
    'If the red job is Dependency audit, the cause is usually a new advisory on a dependency nobody changed: the job log names it. Fix that with a dependency update (or a KNOWN entry with its reason), not a revert. A red Gitleaks is the commit: revert or fix it.',
};
export const outsideCause = (check) => (OUTSIDE_CAUSES[check] ? ['', OUTSIDE_CAUSES[check]] : []);

export const checkIssueTitle = (check) => `Broken on main: ${check}`;
export const timeLimitIssueTitle = (check) => `Broken on main: ${check} (time limit)`;
export const journeyIssueTitle = (journey) => `Journey broken on main: ${journey}`;
export const setAsideIssueTitle = (row) => `Set aside on main until ${String(row.until).slice(0, 10)}: ${row.step.replace('#', ' #')}`;

/** The issue for a step the verdict set aside (a row of set-aside.json). */
export function setAsideIssueBody(row, runUrl) {
  const until = String(row.until).slice(0, 16).replace('T', ' ');
  return [
    `\`${row.step.replace('#', ' #')}\` failed, then passed on its retry, on main (first in run ${row.since}; this issue comes from [this run](${runUrl})), so the machine set it aside until ${until} UTC (tooling/ci/journey-verdict.mjs).`,
    '',
    `- Owner: ${row.owner} (its journey's module in docs/roadmap/journeys.json).`,
    '- Until then it still runs and each run shows its result, it does not count as proven, and its failure does not turn main red, unless it fails outright in two runs in a row (broken, not flaky).',
    `- After ${until} UTC, a failure, or a pass only on its retry, turns main's journeys verdict red again.`,
    `- Fix the test or the code it checks, never by weakening the test${row.file ? `: apps/customer/tests/real-app/${row.file}` : ''}.`,
    '',
    `<!-- set-aside: ${row.step} -->`,
    '_Opened by tooling/ci/post-merge-trust.mjs. A money step is never set aside._',
  ].join('\n');
}

/**
 * What to do with the set-aside issues: `rows` is set-aside.json's steps, `issues` every set-aside issue (open or closed,
 * by title). Opens one for each active row that has none yet; closes the open one of each row whose set-aside ended.
 */
export function setAsideIssueActions(rows, issues) {
  const byTitle = new Map((issues ?? []).map((i) => [i.title, i]));
  const ok = (rows ?? []).filter((r) => typeof r?.step === 'string');
  return {
    open: ok.filter((r) => r.active && !byTitle.has(setAsideIssueTitle(r))),
    close: ok
      .filter((r) => !r.active && byTitle.get(setAsideIssueTitle(r))?.state === 'open')
      .map((r) => ({ row: r, issue: byTitle.get(setAsideIssueTitle(r)) })),
  };
}
export const moneyFlakyIssueTitle = (row) => `Flaky money step on main: ${row.step.replace('#', ' #')}`;

/** The issue for a money step that failed, then passed on its retry, on main (a row of set-aside.json's moneyFlaky). */
export function moneyFlakyIssueBody(row, runUrl) {
  return [
    `\`${row.step.replace('#', ' #')}\` is a money step. It failed, then passed on its retry, on main in [this run](${runUrl}) (tooling/ci/journey-verdict.mjs).`,
    '',
    `- Owner: ${row.owner ?? 'no area named: its journey names no module in docs/roadmap/journeys.json'}.`,
    '- It stops only its own journeys (project-state OWNER 278): it stays red on main, never counts as proven and is never set aside, and the merge seal holds only the pull requests in its area.',
    '- Failing outright on main, on every try, still bisects and reverts the commit that broke it.',
    `- Fix the race in the test or the code it checks, never by weakening the test${row.file ? `: apps/customer/tests/real-app/${row.file}` : ''}. A rare real money bug can look like this.`,
    '',
    `<!-- money-flaky: ${row.step} -->`,
    '_Opened by tooling/ci/post-merge-trust.mjs._',
  ].join('\n');
}

/** Which money-flaky rows get an issue: `rows` is set-aside.json's moneyFlaky, `issues` the open ones (by title). */
export function moneyFlakyIssueActions(rows, issues) {
  const open = new Set((issues ?? []).filter((i) => i.state === 'open').map((i) => i.title));
  const seen = new Set();
  return (rows ?? []).filter((r) => {
    if (typeof r?.step !== 'string' || seen.has(r.step)) return false;
    seen.add(r.step);
    return !open.has(moneyFlakyIssueTitle(r));
  });
}

const CHECK_RED = /failed twice on `([0-9a-f]{7,40})`/g;
const STEPS_MARK = /<!-- steps: ([^>]*) -->/g;

/** The commits a check's open issue names as red, from its body and later comments. */
export function checkRedShas(texts) {
  return [...new Set(texts.flatMap((t) => [...(t ?? '').matchAll(CHECK_RED)].map((m) => m[1])))];
}

/** The steps a journey's open issue names, from its body and later comments. */
export function issueSteps(texts) {
  return sortKeys(
    new Set(
      texts.flatMap((t) =>
        [...(t ?? '').matchAll(STEPS_MARK)].flatMap((m) =>
          m[1]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ),
    ),
  );
}

/** Markdown lines for the commits between two runs, newest last; at most `max`, then a count of the rest. */
export function commitLines(commits, max = 30) {
  const lines = commits.slice(-max).map((c) => {
    const subject = (c.commit?.message ?? '').split('\n')[0];
    const who = c.author?.login ? ` by ${c.author.login}` : '';
    return `- \`${c.sha.slice(0, 10)}\` ${subject}${who}`;
  });
  if (commits.length > max) lines.unshift(`- … ${commits.length - max} older commits (see the compare link)`);
  return lines;
}

/**
 * The "breaking commit" lines of a break issue. Two runs on the same commit (the daily scheduled journeys run, or a
 * manual run) have no commit between them: then the break is not a code change, and the issue says so.
 */
export function breakingCommitLines(commits, url) {
  if (commits.length === 0)
    return ['No commit changed between these runs, so no commit broke it: the step is flaky or something outside the code changed.'];
  return [
    commits.length === 1 ? 'The breaking commit:' : `The breaking commit is one of these ${commits.length} ([compare](${url})):`,
    ...commitLines(commits),
  ];
}

// ── GitHub API ────────────────────────────────────────────────────────────
const API = 'https://api.github.com';
async function gh(method, path, body, { alreadyRunningOk = false } = {}) {
  if (process.env.DRY_RUN === '1' && method !== 'GET') {
    console.log(`DRY_RUN ${method} ${path}${body ? `\n${JSON.stringify(body, null, 2)}` : ''}`);
    return { status: 0, json: null };
  }
  const res = await fetch(path.startsWith('https://') ? path : `${API}${path}`, {
    method,
    headers: {
      ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  // AGENTS.md's one exception: "403 This workflow is already running" on a re-run only means the run is in progress.
  if (alreadyRunningOk && res.status === 403 && /already running/i.test(text)) return { status: 403, json: null, alreadyRunning: true };
  if (res.status === 403 || res.status === 429) {
    // AGENTS.md: a 403 or 429 from GitHub is a stop. No retry, no loop.
    throw new Error(`GitHub ${res.status} on ${method} ${path}: stopping, not retrying`);
  }
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const SHARD_JOB = /^Journeys \(shard (\d+) of (\d+)\)$/;
const SHARD_ARTIFACT = /^real-app-journeys-shard-(\d+)$/;

/**
 * The shards with no report: `jobs` the run's latest jobs, `artifacts` its artifact names. Every shard 1..N counts, N
 * from the shard jobs' "of N", since a shard GitHub abandoned may have no job at all (run 42669837919: 25 of 32 jobs).
 * Returns "shard <n> of <N>" for each shard whose `real-app-journeys-shard-<n>` artifact is missing.
 */
export function shardsWithoutReport(jobs, artifacts) {
  const totals = (jobs ?? []).map((j) => SHARD_JOB.exec(j?.name ?? '')?.[2]).filter(Boolean);
  if (!totals.length) return [];
  const total = Math.max(...totals.map(Number));
  const sent = new Set((artifacts ?? []).map((n) => SHARD_ARTIFACT.exec(n)?.[1]).filter(Boolean));
  return Array.from({ length: total }, (_, i) => String(i + 1))
    .filter((n) => !sent.has(n))
    .map((n) => `shard ${n} of ${total}`);
}

/** Whether GitHub took a re-run request: a 2xx, or the "already running" 403 that gh() lets through. */
export const rerunTaken = (r) => Boolean(r?.alreadyRunning) || (Number.isInteger(r?.status) && r.status >= 200 && r.status < 300);

/**
 * Whether to re-run a red journeys run's failed jobs once because a shard sent no report. Only on its first attempt, and
 * only when that re-run can bring back nothing but the missing reports: every shard with no report has a job (an
 * abandoned shard with none may not come back with "re-run failed jobs", and re-running the whole run would retry shards
 * that reported reds), and every failed shard job is one with no report (a failed shard that did report keeps its
 * result; a shard whose journeys failed passes its job, so it is never re-run). `jobs` the run's latest jobs, `missing`
 * shardsWithoutReport(). Otherwise its red stands as reported. Returns { rerun, why }.
 */
export function shardRerun({ attempt, conclusion, jobs, missing }) {
  if (!(attempt <= 1 && conclusion === 'failure' && missing.length > 0)) return { rerun: false };
  const shardName = (j) => {
    const m = SHARD_JOB.exec(j?.name ?? '');
    return m ? `shard ${m[1]} of ${m[2]}` : null;
  };
  const withJob = new Set((jobs ?? []).map(shardName).filter(Boolean));
  if (!missing.every((m) => withJob.has(m)))
    return { rerun: false, why: 'a shard with no report has no job (abandoned), so only a person may re-run the whole run' };
  const failed = (jobs ?? []).filter((j) => shardName(j) && j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'skipped');
  if (!failed.every((j) => missing.includes(shardName(j))))
    return { rerun: false, why: 'a failed shard also sent a report, and a re-run would replace it' };
  return { rerun: true };
}

async function missingShardReports(repo, runId) {
  const { json: jobs } = await gh('GET', `/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
  const { json: arts } = await gh('GET', `/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`);
  if (!Array.isArray(jobs?.jobs) || !Array.isArray(arts?.artifacts)) throw new Error(`could not read run ${runId}'s jobs or artifacts`);
  const missing = shardsWithoutReport(
    jobs.jobs,
    arts.artifacts.filter((a) => !a.expired).map((a) => a.name),
  );
  return { missing, jobs: jobs.jobs };
}

/** The names of a run's jobs (latest attempt) that hit their time limit. */
async function timedOutJobs(repo, runId) {
  const { json } = await gh('GET', `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`);
  const jobs = [];
  for (const job of json?.jobs ?? []) {
    if (job.conclusion === 'success' || job.conclusion === 'skipped') continue;
    const { json: annotations } = await gh('GET', `/repos/${repo}/check-runs/${job.id}/annotations?per_page=50`);
    jobs.push({ name: job.name, annotations: annotations ?? [] });
  }
  return timedOutJobNames(jobs);
}

/**
 * Finished runs of this workflow on main created before `runId`, newest first, at most `want` of them. Skipped runs and
 * runs replaced by a newer one are left out; a run cancelled by a time limit counts as "timed_out".
 */
async function earlierRuns(repo, workflowId, runId, createdAt, want) {
  const { json } = await gh('GET', `/repos/${repo}/actions/workflows/${workflowId}/runs?branch=main&status=completed&per_page=100`);
  const runs = (json?.workflow_runs ?? [])
    // A pull request from a fork's own `main` branch reports head_branch "main" too; only main's own runs count.
    .filter((r) => r.id !== Number(runId) && r.created_at < createdAt && ['push', 'workflow_dispatch', 'schedule'].includes(r.event))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const out = [];
  let lookups = 0;
  for (const r of runs) {
    if (out.length >= want) break;
    if (COUNTED.has(r.conclusion)) out.push(r);
    else if (r.conclusion === 'cancelled' && lookups++ < CANCELLED_LOOKUPS && (await timedOutJobs(repo, r.id)).length)
      out.push({ ...r, conclusion: 'timed_out' });
  }
  return out;
}

async function findOpenIssue(repo, title) {
  const q = encodeURIComponent(`repo:${repo} is:issue is:open in:title "${title}"`);
  const { json } = await gh('GET', `/search/issues?q=${q}&per_page=5`);
  return (json?.items ?? []).find((i) => i.title === title) ?? null;
}

/** Open issues whose title starts with `prefix`. */
async function openIssuesTitled(repo, prefix) {
  const q = encodeURIComponent(`repo:${repo} is:issue is:open in:title "${prefix.trim()}"`);
  const { json } = await gh('GET', `/search/issues?q=${q}&per_page=100`);
  return (json?.items ?? []).filter((i) => i.title.startsWith(prefix));
}

async function issueTexts(repo, issue) {
  const { json: comments } = await gh('GET', `/repos/${repo}/issues/${issue.number}/comments?per_page=100`);
  return [issue.body, ...(comments ?? []).map((c) => c.body)];
}

/**
 * The labels a builder's pick rule reads (project-state BUILDER.md, pick 1; OWNER 289 item 6): a journey's break issue
 * is a `regression`, as is a whole check's or a time limit's (#7910 opened bare and no builder could see it), a step that failed then passed on its retry is `flaky`. The bisect adds `main-unknown-red` when it
 * can trace a red to no single merge (journeys-revert.mjs). Every issue stays the one main trust opens: no second issue.
 */
export const ISSUE_LABELS = { break: ['regression'], setAside: ['flaky'] };

/** The POST /issues payload: the title, the body and the issue's labels, when it has any. Pure. */
export const newIssuePayload = (title, body, labels = []) => ({ title, body, ...(labels.length ? { labels } : {}) });

async function upsertIssue(repo, title, body, labels = []) {
  const existing = await findOpenIssue(repo, title);
  if (existing) {
    await gh('POST', `/repos/${repo}/issues/${existing.number}/comments`, { body });
    // An issue opened before the labels existed gets them on its next comment.
    if (labels.length) await gh('POST', `/repos/${repo}/issues/${existing.number}/labels`, { labels });
    return `commented on #${existing.number}`;
  }
  const { json } = await gh('POST', `/repos/${repo}/issues`, newIssuePayload(title, body, labels));
  return `opened #${json?.number}`;
}

async function closeIssue(repo, issue, body) {
  await gh('POST', `/repos/${repo}/issues/${issue.number}/comments`, { body });
  await gh('PATCH', `/repos/${repo}/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });
}

async function between(repo, from, to) {
  const { json } = await gh('GET', `/repos/${repo}/compare/${from}...${to}`);
  return { commits: json?.commits ?? [], url: `https://github.com/${repo}/compare/${from.slice(0, 10)}...${to.slice(0, 10)}` };
}

/** A JSON file of a run's journeys artifact (its report by default), or null when the run kept none (the stack or browser
 *  did not start). */
async function journeyReport(repo, runId, file = 'report.json') {
  const { json } = await gh('GET', `/repos/${repo}/actions/runs/${runId}/artifacts?name=${JOURNEYS_ARTIFACT}&per_page=5`);
  const artifact = (json?.artifacts ?? []).find((a) => a.name === JOURNEYS_ARTIFACT && !a.expired);
  if (!artifact) return null;
  const res = await fetch(artifact.archive_download_url, {
    headers: process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {},
  });
  if (res.status === 403 || res.status === 429) throw new Error(`GitHub ${res.status} on the artifact of run ${runId}: stopping`);
  if (!res.ok) return null;
  const dir = mkdtempSync(join(tmpdir(), 'journeys-'));
  try {
    const zip = join(dir, 'a.zip');
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    const entry = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' })
      .split('\n')
      .find((e) => e.endsWith(`journeys/${file}`) || e === file);
    if (!entry) return null;
    return JSON.parse(execFileSync('unzip', ['-p', zip, entry], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function summary(lines) {
  const text = `${lines.join('\n')}\n`;
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

async function wholeRunCheck(ctx) {
  const { repo, name, runId, attempt, conclusion, sha, runUrl, earlier } = ctx;
  const prev = earlier[0];
  const action = decideCheck({ conclusion, attempt, previous: prev?.conclusion });
  console.log(`${name} run ${runId} attempt ${attempt}: ${conclusion} (previous: ${prev?.conclusion ?? 'none'}) -> ${action}`);
  if (action === 'rerun') {
    const r = await gh('POST', `/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`, undefined, { alreadyRunningOk: true });
    console.log(
      r.alreadyRunning
        ? 'a re-run of this run is already in progress; no further action until it finishes'
        : `re-run of failed jobs requested (${r.status}); no further action until it finishes`,
    );
    return;
  }
  if (action === 'broken') {
    const { commits, url } = await between(repo, prev.head_sha, sha);
    const body = [
      `\`${name}\` failed twice on \`${sha.slice(0, 10)}\` (the failed jobs were re-run once): [run ${runId}](${runUrl}). It passed on \`${prev.head_sha.slice(0, 10)}\` ([run ${prev.id}](${prev.html_url})).`,
      '',
      ...breakingCommitLines(commits, url),
      ...outsideCause(name),
      '',
      '_Opened by tooling/ci/post-merge-trust.mjs. Nothing is skipped or blocked; fix or revert the commit._',
    ].join('\n');
    console.log(await upsertIssue(repo, checkIssueTitle(name), body, ISSUE_LABELS.break));
    return;
  }
  if (action === 'still-red') {
    if (!prev) return;
    const open = await findOpenIssue(repo, checkIssueTitle(name));
    if (open) return console.log(`#${open.number} already tracks it`);
    const lastGreen = (await earlierRuns(repo, ctx.workflowId, runId, ctx.createdAt, 100)).find((r) => r.conclusion === 'success');
    const range = lastGreen ? await between(repo, lastGreen.head_sha, sha) : null;
    console.log(
      await upsertIssue(
        repo,
        checkIssueTitle(name),
        untrackedRedBody({ name, sha, runId, runUrl, prev, lastGreen, range }),
        ISSUE_LABELS.break,
      ),
    );
  }
  if (action === 'green') {
    const issue = await findOpenIssue(repo, checkIssueTitle(name));
    if (!issue) return console.log(`no open "${checkIssueTitle(name)}" issue`);
    const reds = checkRedShas(await issueTexts(repo, issue));
    const statuses = [];
    for (const red of reds) statuses.push((await gh('GET', `/repos/${repo}/compare/${red}...${sha}`)).json?.status);
    if (!statuses.length || !statuses.every((s) => s === 'ahead' || s === 'identical'))
      return console.log(`#${issue.number} stays open (${reds.join(', ') || 'no red commit named'}: ${statuses.join(', ')})`);
    await closeIssue(
      repo,
      issue,
      `\`${name}\` passes again on \`${sha.slice(0, 10)}\` ([run ${runId}](${runUrl})). Closing.\n\n_Closed by tooling/ci/post-merge-trust.mjs._`,
    );
    console.log(`closed #${issue.number}`);
  }
}

/** The issue body for a check red on two runs in a row that no open issue tracks. */
export function untrackedRedBody({ name, sha, runId, runUrl, prev, lastGreen, range }) {
  return [
    `\`${name}\` failed twice on \`${sha.slice(0, 10)}\`: [run ${runId}](${runUrl}), and the run before it on \`${prev.head_sha.slice(0, 10)}\` ([run ${prev.id}](${prev.html_url})). No open issue tracked it.`,
    '',
    ...(lastGreen
      ? [
          `It last passed on \`${lastGreen.head_sha.slice(0, 10)}\` ([run ${lastGreen.id}](${lastGreen.html_url})). The breaking commit is one of these ${range.commits.length} ([compare](${range.url})):`,
          ...commitLines(range.commits),
        ]
      : ['No green run in the last 100 finished runs on main, so no commit range can be named.']),
    ...outsideCause(name),
    '',
    '_Opened by tooling/ci/post-merge-trust.mjs. Nothing is skipped or blocked; it closes itself when the check passes again._',
  ].join('\n');
}

/** Opens (or comments on) the time-limit issue when jobs hit their limit; closes it on a run where none did. */
async function timeLimitCheck({ repo, name, runId, sha, runUrl, timedOut }) {
  const title = timeLimitIssueTitle(name);
  if (timedOut.length) {
    const body = [
      `${timedOut.map((j) => `\`${j}\``).join(', ')} hit a time limit on \`${sha.slice(0, 10)}\` ([run ${runId}](${runUrl})), so ${timedOut.length === 1 ? 'its' : 'their'} journeys did not finish and count as not passing.`,
      '',
      'Find the step that hangs, or give the journeys more shards (MAX_SHARDS in tooling/scripts/journey-shards.mjs); never shorten or skip a journey to fit.',
      '',
      '_Opened by tooling/ci/post-merge-trust.mjs. It closes itself on the next run where no job hits its limit._',
    ].join('\n');
    return `- Time limit: ${timedOut.join(', ')}: ${await upsertIssue(repo, title, body, ISSUE_LABELS.break)}`;
  }
  const issue = await findOpenIssue(repo, title);
  if (!issue) return null;
  await closeIssue(
    repo,
    issue,
    `No job hit its time limit on \`${sha.slice(0, 10)}\` ([run ${runId}](${runUrl})). Closing.\n\n_Closed by tooling/ci/post-merge-trust.mjs._`,
  );
  return `- Closed #${issue.number} (no job hit its time limit)`;
}

/** One issue per step the run's verdict set aside, naming its owner and end date. */
async function setAsideCheck({ repo, runId, runUrl }) {
  const list = await journeyReport(repo, runId, 'set-aside.json');
  if (!list?.steps?.length) return null;
  const q = encodeURIComponent(`repo:${repo} is:issue in:title "Set aside on main until"`);
  const { json: found } = await gh('GET', `/search/issues?q=${q}&per_page=100`);
  const { open, close } = setAsideIssueActions(list.steps, found?.items ?? []);
  const lines = [];
  for (const row of open) {
    const { json } = await gh(
      'POST',
      `/repos/${repo}/issues`,
      newIssuePayload(setAsideIssueTitle(row), setAsideIssueBody(row, runUrl), ISSUE_LABELS.setAside),
    );
    lines.push(`- ${row.step} set aside until ${row.until} (owner: ${row.owner}): opened #${json?.number}`);
  }
  for (const { row, issue } of close) {
    await closeIssue(
      repo,
      issue,
      `The set-aside of ${row.step.replace('#', ' #')} ended on ${row.until}: a failure, or a pass only on its retry, now turns main's journeys verdict red ([run](${runUrl})).\n\n_Closed by tooling/ci/post-merge-trust.mjs._`,
    );
    lines.push(`- ${row.step}: set-aside ended, closed #${issue.number}`);
  }
  return lines;
}

/** One open `flaky` issue per money step that passed only on its retry in this run (OWNER 278). */
async function moneyFlakyCheck({ repo, runId, runUrl }) {
  const list = await journeyReport(repo, runId, 'set-aside.json');
  if (!list?.moneyFlaky?.length) return null;
  const q = encodeURIComponent(`repo:${repo} is:issue is:open in:title "Flaky money step on main"`);
  const { json: found } = await gh('GET', `/search/issues?q=${q}&per_page=100`);
  const lines = [];
  for (const row of moneyFlakyIssueActions(list.moneyFlaky, found?.items ?? [])) {
    const { json } = await gh('POST', `/repos/${repo}/issues`, {
      title: moneyFlakyIssueTitle(row),
      body: moneyFlakyIssueBody(row, runUrl),
      labels: ['flaky'],
    });
    lines.push(`- ${row.step} (money) passed only on its retry (owner: ${row.owner ?? 'none named'}): opened #${json?.number}`);
  }
  return lines;
}

async function journeysCheck(ctx) {
  const timeLine = await timeLimitCheck(ctx);
  if (timeLine) summary(['### Journeys time limit', '', timeLine]);
  const asideLines = await setAsideCheck(ctx);
  if (asideLines?.length) summary(['### Set aside by the machine', '', ...asideLines]);
  const flakyLines = await moneyFlakyCheck(ctx);
  if (flakyLines?.length) summary(['### Money steps that passed only on their retry', '', ...flakyLines]);
  // A shard that sent no report: re-run its failed jobs once, after this attempt's own checks above, and judge the next
  // attempt instead (project-state #1786, 10 Nov). Never a shard that reported, and never the whole run.
  const { missing, jobs } = await missingShardReports(ctx.repo, ctx.runId);
  const again = shardRerun({ attempt: ctx.attempt, conclusion: ctx.conclusion, jobs, missing });
  if (again.rerun) {
    const r = await gh('POST', `/repos/${ctx.repo}/actions/runs/${ctx.runId}/rerun-failed-jobs`, undefined, { alreadyRunningOk: true });
    // Hand the verdict to the next attempt only when GitHub took the re-run (or one is already going); a refused or
    // failed request falls through, so this attempt's red is still judged and reported (CI review note on 65c75ec16).
    if (rerunTaken(r))
      return summary([
        '### Shards with no report',
        '',
        `${missing.length} shard(s) sent no report on attempt ${ctx.attempt}: ${missing.join(', ')}. Re-ran the failed jobs once (${r.status}); no shard that reported is re-run, and the next attempt is judged instead.`,
      ]);
    summary([
      '### Shards with no report',
      '',
      `${missing.length} shard(s) sent no report on attempt ${ctx.attempt}: ${missing.join(', ')}. GitHub didn't take the re-run (${r.status}), so this attempt is judged as it is: their journeys count as not passing.`,
    ]);
  } else if (missing.length)
    summary([
      '### Shards with no report',
      '',
      `${missing.length} shard(s) sent no report on attempt ${ctx.attempt}: ${missing.join(', ')}. Their journeys count as not passing${again.why ? `; not re-run: ${again.why}` : ''}.`,
    ]);
  const { repo, runId, sha, runUrl, earlier } = ctx;
  const now = await journeyReport(repo, runId);
  if (!now)
    return summary([`### Journeys against earlier runs`, '', `Run ${runId} kept no journey report, so there is nothing to compare.`]);
  const nowStates = stepStates(now);
  const [prevRun] = earlier;
  const prev = prevRun ? await journeyReport(repo, prevRun.id) : null;
  const lines = ['### Journeys against earlier runs', ''];
  if (!prev) {
    lines.push('No earlier finished run kept a journey report, so nothing is compared yet.');
    return summary(lines);
  }
  const prevStates = stepStates(prev);
  const { newlyPassing, newlyFailing } = stepChanges(prevStates, nowStates);
  lines.push(`Against [run ${prevRun.id}](${prevRun.html_url}) (\`${prevRun.head_sha.slice(0, 10)}\`):`, '');
  lines.push(`- Newly passing (${newlyPassing.length}): ${newlyPassing.join(', ') || 'none'}`);
  lines.push(
    `- Newly broken (${newlyFailing.length}): ${newlyFailing.join(', ') || 'none'}${newlyFailing.length ? ' (the journeys revert decides each one)' : ''}`,
  );

  // Close journey issues whose named steps all pass now. One search for all of them (search allows 30 calls a minute).
  for (const issue of await openIssuesTitled(repo, journeyIssueTitle(''))) {
    const journey = issue.title.slice(journeyIssueTitle('').length);
    const steps = issueSteps(await issueTexts(repo, issue));
    if (!steps.length || !steps.every((s) => nowStates.get(s) === 'passed')) continue;
    await closeIssue(
      repo,
      issue,
      `${steps.join(', ')} pass again on \`${sha.slice(0, 10)}\` ([run ${runId}](${runUrl})). Closing.\n\n_Closed by tooling/ci/post-merge-trust.mjs._`,
    );
    lines.push(`- Closed #${issue.number} (${journey} passes again)`);
  }

  summary(lines);
}

function selfTest() {
  const eq = (got, want, m) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${m}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  };
  const spec = (title, ...statuses) => ({ title, tests: statuses.map((status) => ({ status })) });
  const report = (...specs) => ({ suites: [{ title: 'a.pw.mjs', specs: specs.slice(0, 2), suites: [{ specs: specs.slice(2) }] }] });
  const r1 = report(
    spec('J-a-01 #1 x', 'expected'),
    spec('J-a-01 #2 y', 'unexpected'),
    spec('J-b-02 #1 z', 'skipped'),
    spec('not a journey', 'unexpected'),
  );
  eq(
    [...stepStates(r1)],
    [
      ['J-a-01#1', 'passed'],
      ['J-a-01#2', 'failed'],
      ['J-b-02#1', 'skipped'],
    ],
    'step states, nested suites',
  );
  eq(
    [...stepStates(report(spec('J-a-01 #1 x', 'expected'), spec('J-a-01 #1 dup', 'unexpected')))],
    [['J-a-01#1', 'failed']],
    'a failing duplicate title wins',
  );
  eq([...stepStates(report(spec('J-a-01 #1 x', 'flaky')))], [['J-a-01#1', 'failed']], 'a pass only on the retry is not a pass');
  eq(
    [...stepStates(report(spec('J-a-01 #1 x', 'expected'), spec('J-a-01 #1 y', 'flaky')))],
    [['J-a-01#1', 'failed']],
    'one test passing only on its retry fails the step',
  );
  const m = (o) => new Map(Object.entries(o));
  eq(
    stepChanges(
      m({ 'J-a-01#1': 'failed', 'J-a-01#2': 'passed', 'J-a-01#3': 'passed', 'J-a-01#10': 'passed' }),
      m({ 'J-a-01#1': 'passed', 'J-a-01#2': 'failed', 'J-a-01#3': 'skipped', 'J-a-01#10': 'failed', 'J-c-01#1': 'failed' }),
    ),
    { newlyPassing: ['J-a-01#1'], newlyFailing: ['J-a-01#2', 'J-a-01#10'] },
    'newly passing and failing; skipped and new steps are neither; numeric order',
  );
  eq(decideCheck({ conclusion: 'failure', attempt: 1, previous: 'success' }), 'rerun', 'first red after green re-runs');
  eq(decideCheck({ conclusion: 'failure', attempt: 2, previous: 'success' }), 'broken', 'red after re-run is a break');
  eq(decideCheck({ conclusion: 'timed_out', attempt: 2, previous: 'success' }), 'broken', 'a timeout counts as red');
  eq(decideCheck({ conclusion: 'failure', attempt: 1, previous: 'failure' }), 'still-red', 'red after red opens nothing new');
  eq(decideCheck({ conclusion: 'failure', attempt: 1, previous: undefined }), 'still-red', 'no earlier run: nothing to blame');
  eq(decideCheck({ conclusion: 'success', attempt: 1, previous: 'failure' }), 'green', 'green');
  eq(decideCheck({ conclusion: 'cancelled', attempt: 1, previous: 'success' }), 'ignore', 'cancelled ignored');
  const run = (id, sha) => ({ id, head_sha: sha, html_url: `https://x/runs/${id}` });
  const untracked = untrackedRedBody({
    name: 'Order-path CX-8',
    sha: 'c'.repeat(40),
    runId: 3,
    runUrl: 'https://x/runs/3',
    prev: run(2, 'b'.repeat(40)),
    lastGreen: run(1, 'a'.repeat(40)),
    range: { commits: [{ sha: 'b'.repeat(40), commit: { message: 'feat: x (#9)' }, author: null }], url: 'https://x/compare' },
  });
  eq(checkRedShas([untracked]), ['cccccccccc'], 'an untracked red names its sha, so a later green closes it');
  eq(untracked.includes('`bbbbbbbbbb` feat: x (#9)'), true, 'an untracked red lists the commits since the last green');
  eq(untracked.includes('new advisory'), false, 'a code check carries no outside-cause line');
  eq(
    untrackedRedBody({
      name: 'PR checks',
      sha: 'c'.repeat(40),
      runId: 3,
      runUrl: 'u',
      prev: run(2, 'b'.repeat(40)),
      lastGreen: null,
    }).includes('not a revert'),
    true,
    'a Dependency audit red says the cause can be outside the commits',
  );
  eq(
    untrackedRedBody({ name: 'x', sha: 'c'.repeat(40), runId: 3, runUrl: 'u', prev: run(2, 'b'.repeat(40)), lastGreen: null }).includes(
      'No green run',
    ),
    true,
    'no green in reach: says so',
  );
  const limitJobs = [
    { name: 'Journeys (shard 3 of 8)', annotations: [{ message: 'The job has exceeded the maximum execution time of 1h0m0s' }] },
    { name: 'Journeys (shard 4 of 8)', annotations: [{ message: 'The operation was canceled.' }] },
    { name: 'Real-app journeys', annotations: [] },
  ];
  eq(timedOutJobNames(limitJobs), ['Journeys (shard 3 of 8)'], 'a time-limit annotation marks the job');
  eq(
    timedOutJobNames([
      {
        name: 'Journeys (shard 9 of 12)',
        annotations: [
          { message: "this shard's journeys reached their time limit (60 minutes); the journeys it did not reach count as not run" },
        ],
      },
    ]),
    ['Journeys (shard 9 of 12)'],
    "a shard's own journey limit marks the job",
  );
  eq(runConclusion('cancelled', timedOutJobNames(limitJobs)), 'timed_out', 'a time-limit cancel is a timeout');
  eq(runConclusion('cancelled', []), 'cancelled', 'a replaced run stays cancelled');
  eq(runConclusion('failure', ['x']), 'failure', 'a red run with a timed-out job stays red');
  eq(
    decideCheck({ conclusion: runConclusion('cancelled', ['x']), attempt: 2, previous: 'success' }),
    'broken',
    'a time-limit cancel after a green re-run is a break',
  );
  eq(
    checkRedShas([
      '`Order-path CX-8` failed twice on `46b3f74801` (x)',
      null,
      'failed twice on `46b3f74801`, failed twice on `abcdef1234`',
    ]),
    ['46b3f74801', 'abcdef1234'],
    'red shas, deduped',
  );
  eq(
    issueSteps(['x <!-- steps: J-a-01#2, J-a-01#1 -->', 'y <!-- steps: J-a-01#1 -->', null]),
    ['J-a-01#1', 'J-a-01#2'],
    'issue steps, merged',
  );
  const c = (sha, message, login) => ({ sha, commit: { message }, author: login ? { login } : null });
  eq(
    commitLines([c('a'.repeat(40), 'feat: one (#1)\n\nbody', 'alice'), c('b'.repeat(40), 'fix: two (#2)')]),
    ['- `aaaaaaaaaa` feat: one (#1) by alice', '- `bbbbbbbbbb` fix: two (#2)'],
    'commit lines',
  );
  eq(
    commitLines([c('a'.repeat(40), 'x'), c('b'.repeat(40), 'y'), c('c'.repeat(40), 'z')], 2)[0],
    '- … 1 older commits (see the compare link)',
    'long ranges are cut',
  );
  eq(breakingCommitLines([], 'u')[0].startsWith('No commit changed between these runs'), true, 'same commit: no breaking commit named');
  eq(breakingCommitLines([c('a'.repeat(40), 'x')], 'u'), ['The breaking commit:', '- `aaaaaaaaaa` x'], 'one breaking commit');
  const row = {
    step: 'J-a-01#3',
    until: '2026-11-14T06:00:00.000Z',
    since: 1700,
    active: true,
    owner: 'the alpha area',
    file: 'J-a-01.pw.mjs',
  };
  eq(setAsideIssueTitle(row), 'Set aside on main until 2026-11-14: J-a-01 #3', 'set-aside issue title');
  const mf = { step: 'J-a-05#1', file: 'J-a-05.pw.mjs', owner: 'the alpha area' };
  eq(moneyFlakyIssueTitle(mf), 'Flaky money step on main: J-a-05 #1', 'money-flaky issue title');
  eq(
    moneyFlakyIssueActions(
      [mf, mf, { ...mf, step: 'J-a-05#2' }, { ...mf, step: 'J-a-05#3' }, { file: 'x' }],
      [
        { title: moneyFlakyIssueTitle({ step: 'J-a-05#2' }), state: 'open' },
        { title: moneyFlakyIssueTitle({ step: 'J-a-05#3' }), state: 'closed' },
      ],
    ).map((r) => r.step),
    ['J-a-05#1', 'J-a-05#3'],
    'a money-flaky step gets one issue while none is open: once per step, again after its last one closed',
  );
  if (!/never counts as proven/.test(moneyFlakyIssueBody(mf, 'u'))) throw new Error('the money-flaky issue says it is never proven');
  const shardJobs = [1, 2, 3, 4].map((n) => ({ name: `Journeys (shard ${n} of 4)` })).concat([{ name: 'Real-app journeys' }]);
  eq(
    shardsWithoutReport(shardJobs, ['real-app-journeys-shard-1', 'real-app-journeys-shard-3', 'real-app-journeys', 'x-shard-2']),
    ['shard 2 of 4', 'shard 4 of 4'],
    'the shards that sent no report, by their own artifact only',
  );
  eq(
    shardsWithoutReport(shardJobs.slice(0, 2), ['real-app-journeys-shard-1', 'real-app-journeys-shard-2']),
    ['shard 3 of 4', 'shard 4 of 4'],
    'a shard with no job at all (abandoned) still counts as sending no report',
  );
  eq(shardsWithoutReport([{ name: 'Real-app journeys' }], []), [], 'no shard job: nothing ran to count');
  eq(
    shardsWithoutReport(
      shardJobs,
      [1, 2, 3, 4].map((n) => `real-app-journeys-shard-${n}`),
    ),
    [],
    'every shard reported',
  );
  const jobsOf = (states) => Object.entries(states).map(([n, c]) => ({ name: `Journeys (shard ${n} of 4)`, conclusion: c }));
  const shardsOk = jobsOf({ 1: 'success', 2: 'failure', 3: 'success', 4: 'success' });
  eq(rerunTaken({ status: 201, json: null }), true, 'a 201 re-run is taken');
  eq(rerunTaken({ status: 403, json: null, alreadyRunning: true }), true, 'already running is taken');
  for (const status of [404, 422, 500, 0]) eq(rerunTaken({ status, json: null }), false, `a ${status} re-run is not taken`);
  const go = (o) => shardRerun({ attempt: 1, conclusion: 'failure', jobs: shardsOk, missing: ['shard 2 of 4'], ...o }).rerun;
  eq(go({}), true, 'a red first attempt whose only failed shard sent no report re-runs its failed jobs');
  eq(go({ attempt: 2 }), false, 'once only: the re-run is judged as it is');
  eq(go({ missing: [] }), false, 'every shard reported: no re-run');
  eq(go({ conclusion: 'success' }), false, 'a green run is not re-run');
  eq(
    go({ jobs: jobsOf({ 1: 'failure', 2: 'failure', 3: 'success', 4: 'success' }) }),
    false,
    'a failed shard that sent its report is never re-run: its reds stand',
  );
  eq(go({ jobs: jobsOf({ 1: 'success', 3: 'success', 4: 'success' }) }), false, 'a missing shard with no job: no re-run of the whole run');
  const ended = { ...row, step: 'J-a-01#4', active: false };
  const acts = setAsideIssueActions(
    [row, ended, { ...row, step: 'J-a-01#5' }, { ...row, step: 'J-a-01#6' }],
    [
      { title: setAsideIssueTitle(ended), state: 'open', number: 4 },
      { title: setAsideIssueTitle({ ...row, step: 'J-a-01#5' }), state: 'open', number: 5 },
      { title: setAsideIssueTitle({ ...row, step: 'J-a-01#6' }), state: 'closed', number: 6 },
    ],
  );
  eq(
    acts.open.map((r) => r.step),
    ['J-a-01#3'],
    'an issue opens once per active set-aside, never again once closed',
  );
  eq(
    acts.close.map((c) => c.issue.number),
    [4],
    'an ended set-aside closes its open issue',
  );
  const body = setAsideIssueBody(row, 'https://x/runs/9');
  eq(
    ['Owner: the alpha area', '2026-11-14 06:00 UTC', 'J-a-01.pw.mjs', 'does not count as proven'].every((t) => body.includes(t)),
    true,
    'set-aside issue names owner, end date and file',
  );
  // OWNER 289 item 6: the break issue is a regression and the set-aside issue is flaky, so a builder's pick finds them.
  eq(
    newIssuePayload('Journey broken on main: J-a-01', 'b', ISSUE_LABELS.break),
    { title: 'Journey broken on main: J-a-01', body: 'b', labels: ['regression'] },
    'a break issue opens labelled regression',
  );
  eq(
    newIssuePayload('Set aside on main until x: J-a-01 #1', 'b', ISSUE_LABELS.setAside).labels,
    ['flaky'],
    'a set-aside issue opens labelled flaky',
  );
  eq(newIssuePayload('Broken on main: CI', 'b'), { title: 'Broken on main: CI', body: 'b' }, 'no labels asked, none sent');
  // Every path that opens an issue for a red main passes its labels (RULING 7 item 1: no path opens one bare; #7910 did).
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  const bare = [...src.matchAll(/upsertIssue\(repo, (?:[^()]|\([^()]*\)|\{[^}]*\})*\)/g)]
    .map((m) => m[0])
    .filter((c) => !c.includes('ISSUE_LABELS.') && !c.includes('labels = []'));
  eq(bare, [], 'no caller opens an issue without labels');
  console.log('✓ post-merge-trust --self-test OK (36 fixtures)');
}

async function main() {
  const {
    GITHUB_REPOSITORY: repo,
    WORKFLOW_ID: workflowId,
    WORKFLOW_NAME: name,
    RUN_ID: runId,
    RUN_ATTEMPT,
    CONCLUSION: rawConclusion,
    HEAD_SHA: sha,
  } = process.env;
  if (!repo || !workflowId || !name || !runId || !rawConclusion || !sha)
    throw new Error('GITHUB_REPOSITORY, WORKFLOW_ID, WORKFLOW_NAME, RUN_ID, CONCLUSION and HEAD_SHA are required');
  const attempt = Number(RUN_ATTEMPT || 1);
  const runUrl = `https://github.com/${repo}/actions/runs/${runId}`;
  const { json: run } = await gh('GET', `/repos/${repo}/actions/runs/${runId}`);
  if (!run?.created_at) throw new Error(`could not read run ${runId}`);
  const timedOut = COUNTED.has(rawConclusion) || rawConclusion === 'cancelled' ? await timedOutJobs(repo, runId) : [];
  const conclusion = runConclusion(rawConclusion, timedOut);
  if (!COUNTED.has(conclusion)) return console.log(`${name} run ${runId}: ${conclusion}, nothing to compare`);
  const journeys = name === JOURNEYS_WORKFLOW;
  const earlier = await earlierRuns(repo, workflowId, runId, run.created_at, 1);
  const ctx = { repo, name, runId, attempt, conclusion, sha, runUrl, earlier, timedOut, workflowId, createdAt: run.created_at };
  return journeys ? journeysCheck(ctx) : wholeRunCheck(ctx);
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`✖ post-merge-trust: ${e.message}`);
    process.exit(1);
  });
}
