#!/usr/bin/env node
/**
 * MAIN AUTO-REVERT: when a merge turns a CI job on main from green to red, revert the commit that did it.
 *
 *   node tooling/scripts/main-auto-revert.mjs --run-id <id|latest> [--dry-run] [--no-rerun-confirm] [--repo owner/name]
 *
 * Called by .github/workflows/main-auto-revert.yml after CI completes on a push to main (and by hand, with --dry-run,
 * to see what it would do). It uses plain `gh` and `git` with the workflow's GITHUB_TOKEN. Nothing here uses
 * `pull_request_target`, and nothing here retries a 403 or 429 (they stop the run).
 *
 * WHEN IT ACTS (all of these must hold)
 *   1. The run is a completed, FAILED push run of ci.yml on main.
 *   2. A job in it is red now and was GREEN in the previous completed, non-cancelled push run that actually ran jobs
 *      ("green to red"). A job that was already red there is main's existing problem, not this commit's, and is left alone.
 *      This is also the loop guard: after a revert the job is green again, and a job that is still red can never trigger.
 *   3. The failure is CONFIRMED: attempt 1 only re-runs the failed jobs and stops; the re-run produces a second
 *      completed event (attempt 2), and only a job red in that attempt counts. A flaky test therefore cannot revert a good
 *      commit. (--no-rerun-confirm skips this.)
 *   4. The culprit is ONE commit. The baseline is the previous completed run that ran jobs, so every commit merged between
 *      the baseline and the red run had its own run cancelled or superseded (main's CI is cancelled when merges arrive in a
 *      burst: 21 of the last 60 runs on 2026-10-13). Then `bisect()` asks, for each commit in that range, whether any
 *      run (even a manually cancelled one, job by job) recorded the job passing or failing. Usually none did, and the range
 *      is a batch: when it is exactly one commit that commit is the culprit; when it is longer the culprit is AMBIGUOUS,
 *      nothing is reverted, and an issue listing the candidates is opened. Telling them apart for real would mean running CI
 *      on mid-range commits (about an hour each); that is deliberately not done here.
 *   5. Guards: never revert a revert (or an [auto-revert] commit); never revert a commit already reverted; at most one
 *      auto-revert PR in flight; at most MAX_PER_DAY auto-reverts in 24 hours (a circuit breaker for a runaway loop).
 *
 * WHAT IT DOES
 *   Branch auto-revert/<sha7> from main's tip, `git revert` of the squash commit, a PR naming the failing jobs and runs,
 *   the always-on required checks dispatched on the branch (a PR opened with GITHUB_TOKEN does not trigger them by itself),
 *   then a plain `gh pr merge --squash --match-head-commit`. If any step is refused it stops and leaves the PR open.
 *
 * KNOWN LIMITS (also in the workflow header and the hand-off report)
 *   - A merge made with GITHUB_TOKEN does not trigger a push run of CI, so the revert itself is not verified by CI until the
 *     next merge. The workflow does not dispatch one: a dispatch run is not a push run and would not be a baseline.
 *   - Opening and merging the PR needs repo settings only an admin can see or change ("Allow GitHub Actions to create and
 *     approve pull requests") and branch protection that lets this token merge. Untested live; use --dry-run first.
 *
 * Exit codes: 0 nothing to do or done, 1 an action failed (the PR may be left open), 2 bad input, 3 GitHub refused (403/429).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GitHubRefusalError, ghJson, makeGh } from './gate-gh.mjs';

export const REPO = 'Phantom-X-007/intafaced';
export const MARKER = '[auto-revert]';
export const BRANCH_PREFIX = 'auto-revert/';
export const MAX_PER_DAY = 3;
/** Workflows that produce the always-on required checks; dispatched on the revert branch (see header). */
export const REQUIRED_WORKFLOWS = ['gitleaks.yml', 'supply-chain.yml'];
export const REQUIRED_CHECKS = ['Gitleaks', 'Dependency audit'];

const RED = new Set(['failure', 'timed_out']);

/** A run "ran jobs" when at least one job really passed or failed (a superseded run lists none, or only skipped). */
export const ranJobs = (jobs) => jobs.some((j) => j.conclusion === 'success' || j.conclusion === 'failure');

/**
 * Compare the jobs of the red run with the previous comparable run.
 * @returns {{ newlyRed: string[], alreadyRed: string[], unknown: string[] }}
 */
export function classifyTransition(newJobs, prevJobs) {
  const prev = new Map(prevJobs.map((j) => [j.name, j.conclusion]));
  const out = { newlyRed: [], alreadyRed: [], unknown: [] };
  for (const j of newJobs) {
    if (!RED.has(j.conclusion)) continue;
    const p = prev.get(j.name);
    if (p === 'success') out.newlyRed.push(j.name);
    else if (p === 'failure' || p === 'timed_out') out.alreadyRed.push(j.name);
    else out.unknown.push(j.name); // not in the previous run, or skipped/cancelled there: cannot call it a transition
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort();
  return out;
}

/** Revert commits, and our own, are never reverted: that is the loop guard of last resort. */
export function isRevertCommit(subject) {
  const s = String(subject ?? '');
  return /^Revert "/.test(s) || /^revert(\([^)]*\))?!?:/i.test(s) || s.includes(MARKER);
}

export function prNumberFromSubject(subject) {
  return /\(#(\d+)\)\s*$/.exec(String(subject ?? ''))?.[1] ?? null;
}

/**
 * Binary-search the first red commit between a green run and a red run.
 *
 * @param {string[]} commits shas oldest to newest, EXCLUDING the green run's commit and INCLUDING the red run's (the last)
 * @param {(sha: string) => Promise<'pass'|'fail'|'unknown'>} probe the verdict of the job at that commit's own completed run
 * @returns {Promise<{ kind: 'culprit', sha: string } | { kind: 'ambiguous', batch: string[] }>}
 *   `ambiguous` means commits without a usable run sit between the last known pass and the first known fail.
 */
export async function bisect(commits, probe) {
  if (!commits.length) throw new Error('bisect: empty range');
  const cache = new Map();
  const look = async (i) => {
    if (i === commits.length - 1) return 'fail'; // the red run itself
    if (!cache.has(i)) cache.set(i, await probe(commits[i]));
    return cache.get(i);
  };
  let lo = -1; // everything at or before lo is known good (the green run's commit sits at -1)
  let hi = commits.length - 1; // known bad
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    // Find the known commit nearest the middle; commits without a run cannot be asked.
    let pick = -1;
    let verdict = 'unknown';
    for (let d = 0; mid - d > lo || mid + d < hi; d++) {
      for (const i of d === 0 ? [mid] : [mid - d, mid + d]) {
        if (i <= lo || i >= hi) continue;
        const v = await look(i);
        if (v !== 'unknown') {
          pick = i;
          verdict = v;
          break;
        }
      }
      if (pick !== -1) break;
    }
    if (pick === -1) break; // nothing known between lo and hi
    if (verdict === 'pass') lo = pick;
    else hi = pick;
  }
  const batch = commits.slice(lo + 1, hi + 1);
  return batch.length === 1 ? { kind: 'culprit', sha: batch[0] } : { kind: 'ambiguous', batch };
}

export function buildRevertMessage({ sha, subject, jobs, run, baseline }) {
  return (
    `Revert "${subject.replace(/^Revert "(.*)"$/, '$1')}" ${MARKER}\n\n` +
    `This reverts commit ${sha}.\n\n` +
    `Main went red on: ${jobs.join(', ')}.\n` +
    `Red CI run: ${run.url} (${run.headSha.slice(0, 10)}).\n` +
    `Last green for those jobs: ${baseline.url} (${baseline.headSha.slice(0, 10)}).\n` +
    `Found automatically by tooling/scripts/main-auto-revert.mjs: the job was green in the earlier run, red in the later one,\n` +
    `and this is the first commit with a red run (confirmed by a re-run of the failed jobs).\n`
  );
}

export function buildPrBody({ sha, subject, pr, jobs, run, baseline, jobLinks }) {
  const links = jobs.map((j) => (jobLinks[j] ? `[${j}](${jobLinks[j]})` : j)).join(', ');
  return (
    `${MARKER} Automatic revert of ${sha}${pr ? ` (#${pr})` : ''}: \`${subject}\`.\n\n` +
    `**Why:** main went from green to red on ${links}.\n\n` +
    `- Red run: ${run.url}\n- Last green run for these jobs: ${baseline.url}\n\n` +
    `**How it was chosen:** the jobs were green in the earlier run and red in the later one, the failure survived a re-run of ` +
    `the failed jobs, and this is the first commit in between whose own CI run was red.\n\n` +
    `**To keep the change:** fix forward and re-land it. This revert is mechanical; merging it does not judge the change.\n`
  );
}

function makeGit(cwd, spawn = spawnSync) {
  return (args, { allowFail = false, input } = {}) => {
    const r = spawn('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 && !allowFail)
      throw new Error(`git ${args.slice(0, 3).join(' ')} failed (${r.status}): ${String(r.stderr).trim().slice(0, 400)}`);
    return { status: r.status ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
  };
}

const RUN_FIELDS = 'databaseId,headSha,conclusion,createdAt,url,attempt,event,headBranch,workflowName,status';

/**
 * @param {object} o
 * @param {string|number} o.runId a run id or 'latest' (newest failed push run of ci.yml on main)
 * @param {boolean} o.dryRun
 * @param {boolean} o.confirmRerun
 * @returns {Promise<{ outcome: string, [k: string]: any }>}
 */
export async function runAutoRevert(o, { gh, git, log = () => {}, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const repo = o.repo ?? REPO;
  const listed = ghJson(gh, [
    'run',
    'list',
    '-R',
    repo,
    '--branch',
    'main',
    '--workflow',
    'ci.yml',
    '--event',
    'push',
    '--status',
    'completed',
    '-L',
    '100',
    '--json',
    RUN_FIELDS,
  ]);
  const run =
    o.runId === 'latest' ? listed.find((r) => r.conclusion === 'failure') : listed.find((r) => String(r.databaseId) === String(o.runId));
  if (!run)
    return { outcome: 'skip', reason: `run ${o.runId} is not among the last 100 completed push runs of ci.yml on main (or none failed)` };
  if (run.event !== 'push' || run.headBranch !== 'main' || run.conclusion !== 'failure') {
    return {
      outcome: 'skip',
      reason: `run ${run.databaseId} is ${run.event}/${run.headBranch}/${run.conclusion}, not a failed push run on main`,
    };
  }

  const jobsOf = new Map();
  const getJobs = (id) => {
    if (!jobsOf.has(id)) jobsOf.set(id, ghJson(gh, ['run', 'view', String(id), '-R', repo, '--json', 'jobs']).jobs);
    return jobsOf.get(id);
  };

  // Previous COMPLETED run, not cancelled, that actually ran jobs: the baseline for "was it green?".
  const idx = listed.indexOf(run);
  let baseline = null;
  for (const cand of listed.slice(idx + 1)) {
    if (cand.conclusion !== 'success' && cand.conclusion !== 'failure') continue;
    if (!ranJobs(getJobs(cand.databaseId))) continue;
    baseline = cand;
    break;
  }
  if (!baseline) return { outcome: 'skip', reason: 'no earlier completed push run that ran jobs to compare with' };

  const t = classifyTransition(getJobs(run.databaseId), getJobs(baseline.databaseId));
  if (!t.newlyRed.length) {
    return {
      outcome: 'skip',
      reason: 'no green-to-red transition: every red job was already red (or not comparable) on the previous run',
      transition: t,
      run: run.databaseId,
      baseline: baseline.databaseId,
    };
  }

  if (o.confirmRerun && (run.attempt ?? 1) < 2) {
    if (o.dryRun) return { outcome: 'would-rerun', transition: t, run: run.databaseId };
    gh(['run', 'rerun', String(run.databaseId), '-R', repo, '--failed']);
    return {
      outcome: 'rerun-requested',
      reason: 'attempt 1 failed; re-running the failed jobs. The next completion event decides.',
      transition: t,
      run: run.databaseId,
    };
  }

  // Guards that need the repository.
  const openAuto = ghJson(gh, ['pr', 'list', '-R', repo, '--state', 'open', '-L', '100', '--json', 'number,headRefName']).filter((p) =>
    p.headRefName.startsWith(BRANCH_PREFIX),
  );
  if (openAuto.length) return { outcome: 'skip', reason: `an auto-revert PR is already open (#${openAuto[0].number})`, transition: t };
  const recent = git(['log', 'origin/main', '--since=24 hours ago', '--fixed-strings', `--grep=${MARKER}`, '--format=%H'])
    .stdout.split('\n')
    .filter(Boolean);
  if (recent.length >= MAX_PER_DAY)
    return { outcome: 'skip', reason: `circuit breaker: ${recent.length} auto-reverts in the last 24 hours`, transition: t };

  // The commits between the green run and the red run, oldest first (squash merges: main is linear).
  if (git(['merge-base', '--is-ancestor', baseline.headSha, run.headSha], { allowFail: true }).status !== 0) {
    return { outcome: 'skip', reason: `${baseline.headSha.slice(0, 10)} is not an ancestor of ${run.headSha.slice(0, 10)}` };
  }
  const range = git(['rev-list', '--reverse', '--first-parent', `${baseline.headSha}..${run.headSha}`])
    .stdout.split('\n')
    .filter(Boolean);
  if (!range.length || range.length > 250)
    return { outcome: 'skip', reason: `range of ${range.length} commits is empty or too large to bisect` };

  const runBySha = new Map();
  // A cancelled run still tells the truth for any job that finished before the cancel; the probe reads job by job.
  for (const r of listed)
    if (['success', 'failure', 'cancelled'].includes(r.conclusion) && !runBySha.has(r.headSha)) runBySha.set(r.headSha, r);
  const subjectOf = (sha) => git(['log', '-1', '--format=%s', sha]).stdout.trim();

  // One bisect per newly red job; group jobs by the commit they point to.
  const groups = new Map(); // key: culprit sha or 'ambiguous:...' -> { result, jobs[] }
  for (const job of t.newlyRed) {
    const probe = async (sha) => {
      const r = runBySha.get(sha);
      if (!r) return 'unknown';
      const j = getJobs(r.databaseId).find((x) => x.name === job);
      if (!j) return 'unknown';
      if (j.conclusion === 'success') return 'pass';
      return RED.has(j.conclusion) ? 'fail' : 'unknown';
    };
    const result = await bisect(range, probe);
    const key = result.kind === 'culprit' ? result.sha : `ambiguous:${result.batch.join(',')}`;
    if (!groups.has(key)) groups.set(key, { result, jobs: [] });
    groups.get(key).jobs.push(job);
  }

  const jobLinks = Object.fromEntries(getJobs(run.databaseId).map((j) => [j.name, j.url]));
  const plan = { outcome: 'plan', run: run.databaseId, baseline: baseline.databaseId, transition: t, actions: [] };
  for (const { result, jobs } of groups.values()) {
    if (result.kind === 'ambiguous') {
      plan.actions.push({
        type: 'issue',
        jobs,
        batch: result.batch.map((s) => ({ sha: s, subject: subjectOf(s), hasRun: runBySha.has(s) })),
      });
      continue;
    }
    const subject = subjectOf(result.sha);
    if (isRevertCommit(subject)) {
      plan.actions.push({ type: 'skip', sha: result.sha, jobs, reason: `never revert a revert: "${subject}"` });
      continue;
    }
    const already = git(['log', 'origin/main', '--fixed-strings', `--grep=This reverts commit ${result.sha}`, '--format=%H']).stdout.trim();
    if (already) {
      plan.actions.push({ type: 'skip', sha: result.sha, jobs, reason: `already reverted by ${already.split('\n')[0].slice(0, 10)}` });
      continue;
    }
    plan.actions.push({ type: 'revert', sha: result.sha, subject, pr: prNumberFromSubject(subject), jobs, run, baseline, jobLinks });
  }
  if (o.dryRun) return { ...plan, outcome: 'dry-run' };

  const done = [];
  for (const a of plan.actions) {
    if (a.type === 'revert') done.push(await performRevert(a, { gh, git, repo, log, now, sleep }));
    else if (a.type === 'issue') done.push(openIssue(a, { gh, repo, run, baseline }));
    else done.push({ ...a, done: false });
  }
  return { ...plan, outcome: 'done', done };
}

function openIssue(a, { gh, repo, run, baseline }) {
  const title = `main went red on ${a.jobs.join(', ')}: culprit is one of ${a.batch.length} commits`;
  const existing = ghJson(gh, [
    'issue',
    'list',
    '-R',
    repo,
    '--state',
    'open',
    '--search',
    `"main went red on" in:title ${a.jobs[0]}`,
    '--json',
    'number,title',
    '-L',
    '20',
  ]);
  if (existing.some((i) => i.title.startsWith('main went red on'))) return { type: 'issue', skipped: 'an open issue already tracks this' };
  const body =
    `${MARKER} main went red, but CI was cancelled for some of the commits in between, so the culprit cannot be named from the runs alone. Nothing was reverted.\n\n` +
    `- Red run: ${run.url}\n- Last green run: ${baseline.url}\n- Jobs: ${a.jobs.join(', ')}\n\nCandidates (oldest first; "no run" means CI never completed for that commit):\n` +
    a.batch.map((c) => `- ${c.sha.slice(0, 10)} ${c.subject}${c.hasRun ? '' : ' (no run)'}`).join('\n') +
    '\n';
  const out = gh(['issue', 'create', '-R', repo, '--title', title, '--body-file', '-'], { input: body });
  return { type: 'issue', url: out.stdout.trim() };
}

/** Wait (bounded) for the two required checks on the revert PR. Returns which failed; a timeout is not a failure, merge decides. */
export async function waitForRequired(gh, repo, pr, { now, sleep, timeoutMs = 15 * 60_000, pollMs = 30_000 }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const r = gh(['pr', 'checks', String(pr), '-R', repo, '--json', 'name,bucket'], { allowFail: true });
    const checks = r.stdout.trim() ? JSON.parse(r.stdout) : [];
    const state = (name) => checks.find((c) => c.name === name)?.bucket ?? 'missing';
    const failed = REQUIRED_CHECKS.filter((n) => ['fail', 'cancel'].includes(state(n)));
    if (failed.length || REQUIRED_CHECKS.every((n) => state(n) === 'pass') || now() >= deadline) return { failed };
    await sleep(pollMs);
  }
}

async function performRevert(a, { gh, git, repo, log, now, sleep }) {
  const branch = `${BRANCH_PREFIX}${a.sha.slice(0, 7)}`;
  const id = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];
  git(['fetch', '-q', 'origin', 'main']);
  git(['checkout', '-q', '-B', branch, 'origin/main']);
  const rev = git(['revert', '--no-commit', a.sha], { allowFail: true });
  if (rev.status !== 0) {
    git(['revert', '--abort'], { allowFail: true });
    git(['reset', '-q', '--hard'], { allowFail: true });
    return {
      type: 'revert',
      sha: a.sha,
      done: false,
      reason: `git revert conflicts with later commits: ${rev.stderr.trim().slice(0, 200)}. Nothing pushed.`,
    };
  }
  git([...id, 'commit', '-q', '-F', '-'], { input: buildRevertMessage(a) });
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
  const title = `Revert "${a.subject.replace(/ \(#\d+\)$/, '')}" ${MARKER}`;
  const prUrl = gh(['pr', 'create', '-R', repo, '--base', 'main', '--head', branch, '--title', title, '--body-file', '-'], {
    input: buildPrBody(a),
  }).stdout.trim();
  const n = prUrl.split('/').pop();
  log(`opened ${prUrl}`);
  // A PR opened with GITHUB_TOKEN triggers no pull_request workflows; workflow_dispatch is the exception.
  for (const wf of REQUIRED_WORKFLOWS) gh(['workflow', 'run', wf, '-R', repo, '--ref', branch], { allowFail: true });
  const waited = await waitForRequired(gh, repo, n, { now, sleep });
  if (waited.failed.length) {
    return {
      type: 'revert',
      sha: a.sha,
      done: false,
      pr: prUrl,
      reason: `required check(s) failed on the revert PR: ${waited.failed.join(', ')}. Left open.`,
    };
  }
  const merged = gh(['pr', 'merge', n, '-R', repo, '--squash', '--match-head-commit', head], { allowFail: true });
  if (merged.status !== 0) {
    return {
      type: 'revert',
      sha: a.sha,
      done: false,
      pr: prUrl,
      reason: `PR opened but not merged: ${merged.stderr.trim().slice(0, 300)}. Left open for a person.`,
    };
  }
  return { type: 'revert', sha: a.sha, done: true, pr: prUrl };
}

function parseArgs(argv) {
  const o = { repo: REPO, dryRun: false, confirmRerun: true, runId: 'latest', cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-id') o.runId = argv[++i] || 'latest';
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--no-rerun-confirm') o.confirmRerun = false;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (o.runId !== 'latest' && !/^\d+$/.test(o.runId)) throw new Error('--run-id must be a number or "latest"');
  return o;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`main-auto-revert: ${e.message}`);
    return 2;
  }
  try {
    const result = await runAutoRevert(o, { gh: makeGh(), git: makeGit(o.cwd), log: (m) => console.error(`main-auto-revert: ${m}`) });
    console.log(JSON.stringify(result, null, 2));
    if (result.done?.some((d) => d.done === false && d.type === 'revert')) {
      console.error('::error title=Auto-revert incomplete::a revert was needed but could not be completed; see the JSON above.');
      return 1;
    }
    return 0;
  } catch (e) {
    console.error(`main-auto-revert: ${e.message}`);
    return e instanceof GitHubRefusalError ? 3 : 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main());
}
