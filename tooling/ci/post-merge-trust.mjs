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
 * Real-app journeys (per journey step; most journeys do not pass yet, so the job is red either way):
 *   The run is compared with the two finished runs before it. A step that passed two runs ago and failed in both the
 *   run before and this one is broken for real (the next run is the re-run, at no extra cost): open (or comment on)
 *   one "Journey broken on main: <J-id>" issue per journey, naming the commits between the last run it passed and the
 *   first run it failed. A journey's issue closes when every step it names passes again.
 *   The run summary lists the steps newly passing and newly failing against the run before.
 *   A shard that hit its time limit (the job's, or the limit the shard puts on its own journeys so it still reports):
 *   open (or comment on) one "Broken on main: Real-app journeys (time limit)" issue naming the jobs; it closes on the
 *   next run where no job hit its limit.
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
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
 * as in tooling/scripts/roadmap.mjs passedSteps. A step with any test that did not end expected or flaky failed.
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
          : tests.length && tests.every((t) => t.status === 'expected' || t.status === 'flaky')
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

/** Steps that passed in `older`, then failed in both `previous` and `now`: confirmed breaks, grouped by journey. */
export function confirmedBreaks(older, previous, now) {
  const byJourney = new Map();
  for (const [key, state] of now) {
    if (state !== 'failed' || previous.get(key) !== 'failed' || older.get(key) !== 'passed') continue;
    const journey = key.split('#')[0];
    byJourney.set(journey, sortKeys([...(byJourney.get(journey) ?? []), key]));
  }
  return new Map([...byJourney].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
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

async function upsertIssue(repo, title, body) {
  const existing = await findOpenIssue(repo, title);
  if (existing) {
    await gh('POST', `/repos/${repo}/issues/${existing.number}/comments`, { body });
    return `commented on #${existing.number}`;
  }
  const { json } = await gh('POST', `/repos/${repo}/issues`, { title, body });
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

/** The journeys report of a run, or null when the run kept none (the stack or browser did not start). */
async function journeyReport(repo, runId) {
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
      .find((e) => e.endsWith('journeys/report.json') || e === 'report.json');
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
    console.log(await upsertIssue(repo, checkIssueTitle(name), body));
    return;
  }
  if (action === 'still-red') {
    if (!prev) return;
    const open = await findOpenIssue(repo, checkIssueTitle(name));
    if (open) return console.log(`#${open.number} already tracks it`);
    const lastGreen = (await earlierRuns(repo, ctx.workflowId, runId, ctx.createdAt, 100)).find((r) => r.conclusion === 'success');
    const range = lastGreen ? await between(repo, lastGreen.head_sha, sha) : null;
    console.log(await upsertIssue(repo, checkIssueTitle(name), untrackedRedBody({ name, sha, runId, runUrl, prev, lastGreen, range })));
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
    return `- Time limit: ${timedOut.join(', ')}: ${await upsertIssue(repo, title, body)}`;
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

async function journeysCheck(ctx) {
  const timeLine = await timeLimitCheck(ctx);
  if (timeLine) summary(['### Journeys time limit', '', timeLine]);
  const { repo, runId, sha, runUrl, earlier } = ctx;
  const now = await journeyReport(repo, runId);
  if (!now)
    return summary([`### Journeys against earlier runs`, '', `Run ${runId} kept no journey report, so there is nothing to compare.`]);
  const nowStates = stepStates(now);
  const [prevRun, olderRun] = earlier;
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
    `- Newly broken (${newlyFailing.length}): ${newlyFailing.join(', ') || 'none'}${newlyFailing.length ? ' (an issue opens if the next run fails them too)' : ''}`,
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

  const older = olderRun ? await journeyReport(repo, olderRun.id) : null;
  if (!older) {
    lines.push('', 'No third finished run kept a report, so no break can be confirmed yet.');
    return summary(lines);
  }
  const breaks = confirmedBreaks(stepStates(older), prevStates, nowStates);
  if (breaks.size) {
    const { commits, url } = await between(repo, olderRun.head_sha, prevRun.head_sha);
    for (const [journey, steps] of breaks) {
      const body = [
        `${steps.join(', ')} passed on \`${olderRun.head_sha.slice(0, 10)}\` ([run ${olderRun.id}](${olderRun.html_url})), then failed on \`${prevRun.head_sha.slice(0, 10)}\` ([run ${prevRun.id}](${prevRun.html_url})) and again on \`${sha.slice(0, 10)}\` ([run ${runId}](${runUrl})).`,
        '',
        ...breakingCommitLines(commits, url),
        '',
        `<!-- steps: ${steps.join(', ')} -->`,
        '_Opened by tooling/ci/post-merge-trust.mjs. It closes itself when these steps pass again._',
      ].join('\n');
      lines.push(`- Confirmed broken: ${steps.join(', ')}: ${await upsertIssue(repo, journeyIssueTitle(journey), body)}`);
    }
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
  eq([...stepStates(report(spec('J-a-01 #1 x', 'flaky')))], [['J-a-01#1', 'passed']], 'flaky counts as passed');
  const m = (o) => new Map(Object.entries(o));
  eq(
    stepChanges(
      m({ 'J-a-01#1': 'failed', 'J-a-01#2': 'passed', 'J-a-01#3': 'passed', 'J-a-01#10': 'passed' }),
      m({ 'J-a-01#1': 'passed', 'J-a-01#2': 'failed', 'J-a-01#3': 'skipped', 'J-a-01#10': 'failed', 'J-c-01#1': 'failed' }),
    ),
    { newlyPassing: ['J-a-01#1'], newlyFailing: ['J-a-01#2', 'J-a-01#10'] },
    'newly passing and failing; skipped and new steps are neither; numeric order',
  );
  eq(
    [
      ...confirmedBreaks(
        m({ 'J-a-01#1': 'passed', 'J-a-01#2': 'passed', 'J-b-01#1': 'passed', 'J-c-01#1': 'failed' }),
        m({ 'J-a-01#1': 'failed', 'J-a-01#2': 'failed', 'J-b-01#1': 'failed', 'J-c-01#1': 'failed' }),
        m({ 'J-a-01#1': 'failed', 'J-a-01#2': 'passed', 'J-b-01#1': 'failed', 'J-c-01#1': 'failed' }),
      ),
    ],
    [
      ['J-a-01', ['J-a-01#1']],
      ['J-b-01', ['J-b-01#1']],
    ],
    'a break is confirmed only after passing, then failing twice in a row; never-passed steps open nothing',
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
  console.log('✓ post-merge-trust --self-test OK (28 fixtures)');
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
  const earlier = await earlierRuns(repo, workflowId, runId, run.created_at, journeys ? 2 : 1);
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
