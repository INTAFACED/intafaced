#!/usr/bin/env node
/**
 * The CI merge seal's first verdict: CI's jobs on the exact head (C3 piece 2, OWNER 242).
 *
 * The seal runs in its own workflow (.github/workflows/merge-seal.yml, on pull_request_target), so its workflow file and
 * every script it runs are the default branch's, whatever a pull request changes. It can no longer be a `needs:` job
 * of ci.yml, so it reads ci.yml's jobs on the head through the Actions API instead, and decides itself what they must
 * be: it classifies the pull request's changed files with the default branch's ci-affected.mjs (`classify`), and holds
 * the jobs to `sealNeeded`, the rule ci.yml's own seal job applied to its `needs` until now.
 *
 * - The newest ci.yml run of the event on the head decides (a reopen starts a new one and cancels the old).
 * - A run still going fails this verdict with a wait line; CI's last job (START_JOB) starts the seal when it finishes.
 * - Every test shard (`Tests (…)`) must succeed, and there must be one when the change needs tests; when the default
 *   branch says the change needs the full suite, every one of its SHARD_COUNT shards (`Tests (1/16)` …) must be there.
 * - The Look gate (`Look / …`, look-pr.yml) must succeed when the change draws a Customer room (reachesLook), and any
 *   job of the run that finished red fails, whether or not sealNeeded names it (#9920 merged with its Look gate red).
 * - A pull request's own ci.yml may differ from main's: a change to it is a gate file, so the seal's CI review step
 *   holds it to the independent review. This script never runs or reads the pull request's code.
 *
 *   REPO=owner/name HEAD_SHA=<sha> (PR_NUMBER=<n> | MERGE_GROUP_HEAD_SHA=<sha>) node tooling/ci/ci-jobs-seal.mjs
 *   (CI sets GH_TOKEN; run by hand, it reads through the logged-in gh: github-fetch.mjs)
 */
import { fileURLToPath } from 'node:url';
import { runJobs } from './run-jobs.mjs';
import { SHARD_COUNT, classify, narrowCandidates, reachesLook, sealNeeded, shardMatrix } from './ci-affected.mjs';
import { MODEL_JOB, START_JOB, isModelDown, pullFiles } from './journey-seal.mjs';
import { httpMessage, titleFor } from './api-budget.mjs';
import { githubFetch, githubToken } from './github-fetch.mjs';

export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';

/** ci.yml's job names (`name:`), keyed as sealNeeded keys its results. */
export const CI_JOBS = { changes: 'Affected tests', gates: 'Doctrine gates', format: 'Format', build: 'Typecheck & build', rust: 'Rust' };
/** The test matrix's jobs: `Tests (1/16)` … or `Tests (changed)`. */
export const TEST_JOB = /^Tests \(.+\)$/;
/** ci.yml's Look job (look-pr.yml, #9325): a reusable workflow, so its jobs are named `Look / Build (before)`,
 *  `Look / Look gate on the rooms it changes (1/3)` …, and only a Look job skipped by its `if:` is named `Look`. */
export const LOOK_JOB = /^Look( \/ .+)?$/;
/** ci.yml's jobs that are not CI's verdict on the head: its own seal job (`CI jobs` on a pull request, which runs the pull
 *  request's copy and which a factory pause turns red until merge-seal.yml's seal is re-run) and START_JOB. */
const SEAL_JOBS = ['CI merge seal', 'CI jobs'];
/** A finished job's conclusions that are not red. */
const NOT_RED = ['success', 'skipped', 'neutral'];

/** The ci.yml run that decides on `sha` for `event`: the newest by id. null when CI hasn't run there. */
export function ciRunFor(runs, { sha, event }) {
  return (
    (runs ?? []).filter((r) => r?.head_sha === sha && r?.event === event && r?.path === CI_WORKFLOW_PATH).sort((a, b) => b.id - a.id)[0] ??
    null
  );
}

/**
 * The results sealNeeded reads, from a run's latest-attempt jobs. A job that appears twice (should not happen with
 * `filter=latest`) counts by its newest. The test matrix is one result: success only when every shard succeeded.
 */
export function jobResults(jobs) {
  const newest = new Map();
  for (const j of [...(jobs ?? [])].sort((a, b) => a.id - b.id)) newest.set(j?.name, j);
  const result = (j) => (j ? (j.status === 'completed' ? j.conclusion || 'missing' : j.status) : undefined);
  const out = {};
  for (const [key, name] of Object.entries(CI_JOBS)) out[key] = result(newest.get(name));
  // A matrix or reusable workflow is one result: a red job outranks a skipped one, so a failure beside skipped jobs is
  // never read as skipped.
  const oneResult = (pattern) => {
    const results = [...newest.values()].filter((j) => pattern.test(j?.name ?? '')).map(result);
    const bad = results.find((r) => r !== 'success' && r !== 'skipped') ?? results.find((r) => r !== 'success');
    return results.length ? (bad ?? 'success') : undefined;
  };
  out['tests-full'] = oneResult(TEST_JOB);
  out.look = oneResult(LOOK_JOB);
  return out;
}

/** Whether `name` is a job jobResults reads (so sealNeeded judges it). */
const sealRead = (name) => Object.values(CI_JOBS).includes(name) || TEST_JOB.test(name) || LOOK_JOB.test(name);

/**
 * Every other job of the run that finished red, newest attempt of each name (#9920: a job the seal did not read let a
 * red through). A job ci.yml adds later is held this way before anyone teaches sealNeeded its name; the seal jobs and
 * START_JOB are not CI's verdict. Returns lines.
 */
export function otherRedJobs(jobs) {
  const newest = new Map();
  for (const j of [...(jobs ?? [])].sort((a, b) => a.id - b.id)) newest.set(j?.name, j);
  return [...newest.values()]
    .filter((j) => j?.name && !sealRead(j.name) && !SEAL_JOBS.includes(j.name) && j.name !== START_JOB)
    .filter((j) => j.status === 'completed' && !NOT_RED.includes(j.conclusion))
    .map((j) => `${j.name} was ${j.conclusion || 'missing'} (a job that ran red stays red)`);
}

/**
 * The verdict. `files` are the pull request's changed paths, or null when they can't be read whole (the full suite is
 * then needed). `forceFull` for a merge queue's commit (runsEverything). `tree`: the head commit's tree
 * (tooling-reach.mjs commitTree), which a change of tooling alone is narrowed by (ci-affected.mjs narrowed), as ci.yml's
 * changes job narrows it by its checkout; null keeps today's rules. Returns { ok, wait, lines }.
 */
export function judgeCiJobs({ run, jobs, files, forceFull = false, tree = null }) {
  if (!run)
    return { ok: false, wait: true, lines: ['no CI ran for this pull request on this head: merge origin/main if it conflicts, else push'] };
  const id = `CI run ${run.id} (attempt ${run.run_attempt ?? 1})`;
  // A run is judged once every job but ci.yml's own seal has finished: a re-run of that seal alone puts the run back in
  // progress, and must not turn this seal red (the CI review on 7a7eb9a0, 8 Nov 2026). Its last job, START_JOB, is
  // what starts this seal, so it is still going while this reads.
  const pending = (jobs ?? []).filter((j) => !SEAL_JOBS.includes(j?.name) && j?.name !== START_JOB && j?.status !== 'completed');
  if (run.status !== 'completed' && (pending.length || !(jobs ?? []).length))
    return { ok: false, wait: true, lines: [`${id} on this head is ${run.status}; the seal re-runs when it finishes`] };
  const flags = files === null ? { full: true, affected: false } : classify(files, tree ? { forceFull, tree } : { forceFull, reach: null });
  // The look gate, as ci.yml's changes job decides it (ci-affected.mjs main): a pull request's change that draws a
  // Customer room or the kit; files unreadable whole count as drawing one. Never a merge queue's commit (main's look
  // gate is the daily one). classify() leaves it out, so until #9920 this seal never asked for it.
  flags.look = !forceFull && (files === null || reachesLook(files));
  const problems = [...sealNeeded(flags, jobResults(jobs)), ...otherRedJobs(jobs)];
  // The full suite is the whole matrix: a pull request's own ci.yml can't narrow it to one passing shard.
  if (flags.full) {
    const names = new Set((jobs ?? []).map((j) => j?.name));
    const missing = shardMatrix(flags).filter((sh) => !names.has(`Tests (${sh})`));
    if (missing.length)
      problems.push(
        `the change needs the full suite, but ${missing.length} of its ${SHARD_COUNT} shards never ran (Tests (${missing[0]}) …)`,
      );
  }
  if (!problems.length) return { ok: true, wait: false, lines: [`${id}: required jobs succeeded`] };
  return { ok: false, wait: false, lines: problems.map((p) => `${id}: ${p}`) };
}

/** The money browser checks' workflow (#8708) and the paths it runs on, as its `pull_request` and `push` triggers list them
 *  (ci-jobs-seal.test.mjs keeps the three lists equal). A pattern ending in `/**` is a folder; any other is one file. */
export const MONEY_WORKFLOW_PATH = '.github/workflows/customer-money-browser.yml';
export const MONEY_JOB = 'Money browser checks';
export const MONEY_PATHS = [
  'apps/customer/**',
  'packages/ui/**',
  'packages/i18n/**',
  'packages/exchange-contract/**',
  'packages/contracts/**',
  '.github/workflows/customer-money-browser.yml',
];
export const touchesMoney = (files) =>
  (files ?? []).some((f) => MONEY_PATHS.some((p) => (p.endsWith('/**') ? f.startsWith(p.slice(0, -2)) : f === p)));

/**
 * The money browser checks on this exact head (#8708): when they ran there, the merge waits for their verdict. The newest
 * pull_request run of MONEY_WORKFLOW_PATH on the head decides, as CI's newest run does: its MONEY_JOB passed is green;
 * still going waits; red, cancelled, skipped or a finished run with no such job fails. With no run on the head nothing
 * waits: a change that touches none of MONEY_PATHS (GitHub's paths filter started none), and a head pushed before the
 * workflow ran on pull requests (open pull requests at this change's merge are not held for a run they never got;
 * checker on #8713). `files` null (unreadable) is read as touching. Returns { ok, wait, lines }. Pure.
 */
export function moneyVerdict({ runs, jobs, files, sha }) {
  if (files !== null && !touchesMoney(files))
    return { ok: true, wait: false, lines: ['the money browser checks: the change touches none of their paths, so none is owed'] };
  const run =
    (runs ?? [])
      .filter((r) => r?.head_sha === sha && r?.event === 'pull_request' && r?.path === MONEY_WORKFLOW_PATH)
      .sort((a, b) => b.id - a.id)[0] ?? null;
  if (!run) return { ok: true, wait: false, lines: ['the money browser checks: no run of them on this head, so nothing waits'] };
  const id = `the money browser checks, run ${run.id} (attempt ${run.run_attempt ?? 1})`;
  const job = (jobs ?? []).filter((j) => j?.name === MONEY_JOB).sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
  if (!job && run.status === 'completed')
    return { ok: false, wait: false, lines: [`${id} finished with no ${MONEY_JOB} job; re-run it or push`] };
  if (!job || job.status !== 'completed')
    return { ok: false, wait: true, lines: [`${id} on this head has not finished; the seal re-runs when it does`] };
  if (job.conclusion === 'success') return { ok: true, wait: false, lines: [`${id}: passed`] };
  return { ok: false, wait: false, lines: [`${id}: ${job.conclusion}; fix the money screen or its check and push`] };
}

/** The Model check's workflow (project-state#2962): it runs on every pull request, and the seal requires its verdict. */
export const MODEL_WORKFLOW_PATH = '.github/workflows/model-check.yml';

/**
 * The Model check on this exact head (project-state#2962): its newest pull_request run's MODEL_JOB decides. Passed is
 * green (it passes at once when the change touches nothing a model covers); still going waits; a run that could not
 * check (isModelDown: a download, parse or memory failure, no rule broken) is judge down, no verdict, and waits; red,
 * cancelled or skipped fails, and so does no run at all, since the workflow runs on every pull request. Returns
 * { ok, wait, down, lines }. Pure.
 */
export function modelVerdict({ runs, jobs, sha }) {
  const run =
    (runs ?? [])
      .filter((r) => r?.head_sha === sha && r?.event === 'pull_request' && r?.path === MODEL_WORKFLOW_PATH)
      .sort((a, b) => b.id - a.id)[0] ?? null;
  if (!run)
    return {
      ok: false,
      wait: false,
      lines: ['the Model check: no run of it on this head, and it runs on every pull request; push or re-run it'],
    };
  const id = `the Model check, run ${run.id} (attempt ${run.run_attempt ?? 1})`;
  const job = (jobs ?? []).filter((j) => j?.name === MODEL_JOB).sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
  if (!job && run.status === 'completed')
    return { ok: false, wait: false, lines: [`${id} finished with no ${MODEL_JOB} job; re-run it or push`] };
  if (!job || job.status !== 'completed')
    return { ok: false, wait: true, lines: [`${id} on this head has not finished; the seal re-runs when it does`] };
  if (isModelDown(job))
    return {
      ok: false,
      wait: true,
      down: true,
      lines: [`judge down: ${id} could not check a model (no rule broke; its log says why); re-run it once the cause is gone`],
    };
  if (job.conclusion === 'success') return { ok: true, wait: false, lines: [`${id}: passed`] };
  return { ok: false, wait: false, lines: [`${id}: ${job.conclusion}; a model's rule broke or its check failed: the trace is in its log`] };
}

/**
 * What the Doctrine gates judge a change by, as main holds it (project-state#3326). LINT_PATHS, the lint rules and their
 * ceilings (tooling/lint/ratchet.json), are read from main afresh when the Doctrine gates job runs (lint-ratchet.mjs
 * mainRef), so a re-run of that job judges by them. GATE_PATHS, the gate list, is read from the tree the job judges: a
 * Doctrine gates job that ran FRESH_MAIN_STEP judged the pull request's head merged again onto main as it was when the
 * job started, so a re-run of that job alone judges by the gate list main holds now; one without it (a merge commit made
 * before ci.yml had the step) judged the run's merge commit, which a re-run keeps, so only a new head judges by it. The
 * per-file baselines that may only shrink (dead-code,
 * conflict-keys) are left out: a shrink on main can't let through a change CI passed, and they shrink many times a day
 * (#9081 would have stopped three clean merges in the replay). A folder ends in `/`.
 */
export const LINT_PATHS = ['.oxlintrc.json', 'tooling/lint/'];
export const GATE_PATHS = ['tooling/ci/gates.mjs'];
export const RULE_PATHS = [...LINT_PATHS, ...GATE_PATHS];
/** ci.yml's Doctrine gates step that fetches main afresh and merges the pull request's head onto it again before any
 *  gate runs (project-state#3035: on 20 Nov 2026 two gate-list changes on main made #9170, #9171 and #9176 merge main,
 *  push and run everything again, 41 to 97 minutes from their first push). */
export const FRESH_MAIN_STEP = 'Judge on main as it is now';
/** Whether a Doctrine gates job judged on main as it was when the job started: its FRESH_MAIN_STEP succeeded. */
export const judgedOnFreshMain = (job) => (job?.steps ?? []).some((s) => s?.name === FRESH_MAIN_STEP && s?.conclusion === 'success');
/** GitHub makes a pull request's merge commit just before CI's run is created; a gate change merged this close before
 *  the run may not be in it, so it counts as after. */
export const RULE_MARGIN_MS = 60_000;

/** The moment CI's run on the head took main's gate list: its creation, minus RULE_MARGIN_MS. A re-run keeps the first
 *  attempt's merge commit, so its created_at still decides. null when no run. */
export const rulesTakenAt = (run) => (run?.created_at ? new Date(Date.parse(run.created_at) - RULE_MARGIN_MS).toISOString() : null);

/** The newest Doctrine gates job that started. */
const newestGates = (jobs) => [...(jobs ?? [])].filter((j) => j?.name === CI_JOBS.gates && j?.started_at).sort((a, b) => b.id - a.id)[0];

/** The moment the newest Doctrine gates job read main's lint rules: its start (the fetch is a later step of it). Without
 *  one, the run's creation. */
export const lintTakenAt = (run, jobs) => {
  const gates = newestGates(jobs);
  return gates ? new Date(Date.parse(gates.started_at)).toISOString() : rulesTakenAt(run);
};

/**
 * A pull request whose CI judged it before main changed a rule fails (project-state#3326: #8915, #8857 and #8789 passed
 * CI on a head from before a new rule and merged after it, 3 in 170 merges, one turning main red). `changes` are main's
 * commits on RULE_PATHS after rulesTakenAt(run): { path, sha, date, title }. A lint change counts only after the newest
 * Doctrine gates job started (lintTakenAt), and is cleared by re-running that job; a gate-list change counts after the
 * same moment, and is cleared the same way, when that newest job judged on main afresh (judgedOnFreshMain); else it
 * counts after the run was created, and is cleared by merging origin/main and pushing. With no CI run judgeCiJobs
 * already holds the merge. Returns { ok, lines, rerun }: `rerun` ({ runId, jobId }) when every late change is cleared by
 * re-running the newest Doctrine gates job, which the seal then does itself (staleRulesRerun, project-state#3599); else
 * null. Pure.
 */
export function rulesVerdict({ run, jobs, changes }) {
  if (!run) return { ok: true, lines: [], rerun: null };
  const gatesJob = newestGates(jobs);
  const fresh = judgedOnFreshMain(gatesJob);
  const lintAt = lintTakenAt(run, jobs);
  const gateAt = fresh ? lintAt : rulesTakenAt(run);
  const late = (changes ?? []).filter((c) => Date.parse(c.date) > Date.parse(LINT_PATHS.includes(c.path) ? lintAt : gateAt));
  if (!late.length) return { ok: true, lines: [`main's rules: unchanged since CI run ${run.id} judged this head by them`], rerun: null };
  const seen = new Map();
  for (const c of late) seen.set(c.sha, { ...c, paths: [...(seen.get(c.sha)?.paths ?? []), c.path] });
  const needsPush = (c) => !fresh && c.paths.some((p) => GATE_PATHS.includes(p));
  return {
    ok: false,
    rerun: gatesJob?.id && ![...seen.values()].some(needsPush) ? { runId: run.id, jobId: gatesJob.id } : null,
    lines: [...seen.values()].map((c) =>
      needsPush(c)
        ? `main changed ${c.paths.join(', ')} in ${c.sha.slice(0, 10)} at ${c.date} ("${c.title}"), after CI run ${run.id} took main's gate list (${gateAt}): merge origin/main and push, so CI runs the gates main has now (a re-run keeps the old list)`
        : `main changed ${c.paths.join(', ')} in ${c.sha.slice(0, 10)} at ${c.date} ("${c.title}"), after the Doctrine gates job read main's ${fresh ? 'rules' : 'lint rules'} (${lintAt}): re-run it (gh run rerun ${run.id} --job ${gatesJob?.id ?? '<its id>'}); it reads main's rules afresh and starts the seal again`,
    ),
  };
}

/**
 * The one Doctrine gates job the seal re-runs itself (project-state#3599: 17 of the 25 newest failed seals on 21 Nov were
 * only this verdict, each waiting for a hand re-run). Only when every other verdict passed and the rules verdict asks for
 * a re-run alone; any other failure stays red as it is. At most once per change on main: the re-run job starts after
 * every change the verdict saw, so the next seal finds them cleared. Returns { runId, jobId } or null. Pure.
 */
export function staleRulesRerun({ ci, money, model, rules }) {
  return ci?.ok && money?.ok && model?.ok && rules && !rules.ok ? (rules.rerun ?? null) : null;
}

/** How long the seal waits for CI's run to finish before re-running a job of it (its last job, START_JOB, may still be
 *  ending while the seal reads; GitHub re-runs a job only in a finished run). */
export const RERUN_POLLS = 18;
export const RERUN_POLL_MS = 10_000;
/** rerunStaleGates's line when GitHub took the re-run. */
export const RERAN = 're-ran Doctrine gates job';
/** How long the seal then waits, in its own job, for the re-run Doctrine gates job to end: 15 minutes (the job's healthy
 *  run is about 4, its timeout 10). */
export const GATES_WAIT_POLLS = 90;
/** At most this many re-runs in one seal job: main may change a rule again while one runs. */
export const RERUN_ROUNDS = 2;

/**
 * Re-runs `step`'s Doctrine gates job once its CI run has finished: `get` reads the run, `post` returns { status, message }.
 * Its dependents, START_JOB among them, run again after it, and START_JOB starts the seal again. Returns the line to print.
 */
export async function rerunStaleGates({ repo, step, get, post, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  for (let i = 0; i < RERUN_POLLS; i++) {
    const r = await get(`/repos/${repo}/actions/runs/${step.runId}`);
    if (r?.status === 'completed') {
      const { status, message = '' } = await post(`/repos/${repo}/actions/jobs/${step.jobId}/rerun`);
      if (status >= 200 && status < 300) return `${RERAN} ${step.jobId} of CI run ${step.runId} on main's rules now; the seal waits for it`;
      return `could not re-run Doctrine gates job ${step.jobId} of CI run ${step.runId} (${status} ${message}); re-run it by hand`;
    }
    await sleep(RERUN_POLL_MS);
  }
  return `CI run ${step.runId} had not finished after ${(RERUN_POLLS * RERUN_POLL_MS) / 1000} s; re-run Doctrine gates job ${step.jobId} by hand`;
}

/**
 * Waits for the Doctrine gates job that replaced `step.jobId` in its CI run to end. Returns { done, line }: done once the
 * newest Doctrine gates job is another job and has completed, whatever its conclusion (the next verdict reads it).
 */
export async function awaitGatesRerun({ repo, step, get, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  for (let i = 0; i < GATES_WAIT_POLLS; i++) {
    await sleep(RERUN_POLL_MS);
    const jobs = await runJobs(`/repos/${repo}/actions/runs/${step.runId}/jobs?filter=latest`, get);
    const gates = (Array.isArray(jobs) ? jobs : []).filter((j) => j?.name === CI_JOBS.gates).sort((a, b) => b.id - a.id)[0];
    if (gates && String(gates.id) !== String(step.jobId) && gates.status === 'completed')
      return {
        done: true,
        line: `Doctrine gates job ${gates.id} of CI run ${step.runId} ended ${gates.conclusion}; the seal judges again`,
      };
  }
  return {
    done: false,
    line: `the re-run Doctrine gates job of CI run ${step.runId} had not ended after ${(GATES_WAIT_POLLS * RERUN_POLL_MS) / 60_000} min; its end starts the seal again`,
  };
}

/**
 * The seal's verdicts, waiting in its own job for the Doctrine gates job it re-runs (project-state#3820). Before this the
 * seal ended red as soon as it had re-run the job, and the red woke the builder, who merged main and pushed: on 22 Nov 2026,
 * 27 of the 38 pushes that merged main after a seal red alone (175 of the day's 323 merged pull requests) came 0.5 to 4
 * minutes after such a red, before the re-run that would have cleared it had ended. Now a stale rule is a running seal,
 * never a red, until the re-run has judged; a change the re-run can't clear (a gate list read before FRESH_MAIN_STEP) is
 * red as before. `judge()` returns { ci, money, model, rules }; `rerun(step)` and `wait(step)` are rerunStaleGates and
 * awaitGatesRerun. Returns the last verdicts.
 */
export async function judgeWaitingOnGates({ judge, rerun, wait, log = console.log }) {
  let v = await judge();
  for (let round = 0; round < RERUN_ROUNDS; round++) {
    const step = staleRulesRerun(v);
    if (!step) break;
    for (const x of [v.ci, v.money, v.model, v.rules]) for (const l of x.lines) log(`${x.ok ? '✓' : '…'} ${l}`);
    const said = await rerun(step);
    log(said);
    if (!said.startsWith(RERAN)) break;
    const waited = await wait(step);
    log(waited.line);
    if (!waited.done) break;
    v = await judge();
  }
  return v;
}

/** main's commits on RULE_PATHS after `since` (and up to `until`, for a replay), one listing per path. */
export async function ruleChanges(get, repo, since, until) {
  const out = [];
  for (const p of RULE_PATHS) {
    const q = `sha=main&path=${encodeURIComponent(p.replace(/\/$/, ''))}&since=${since}${until ? `&until=${until}` : ''}&per_page=20`;
    const list = await get(`/repos/${repo}/commits?${q}`);
    if (!Array.isArray(list)) throw new Error(`main's commits on ${p}: not a list`);
    for (const c of list)
      out.push({ path: p, sha: c.sha, date: c.commit?.committer?.date, title: (c.commit?.message ?? '').split('\n')[0] });
  }
  return out;
}

async function api(path, token) {
  const res = await githubFetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(httpMessage(path, res, (await res.text()).slice(0, 200)));
  return res.json();
}

/** A POST with no body; never throws on an HTTP refusal: { status, message }. */
async function apiPost(path, token) {
  const res = await githubFetch(`https://api.github.com${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  const text = await res.text();
  let message = text.slice(0, 200);
  try {
    message = JSON.parse(text)?.message ?? message;
  } catch {}
  return { status: res.status, message };
}

/** The pull request's changed paths (journey-seal.mjs pullFiles: a renamed file counts by both names), or null when
 *  GitHub can't list them whole (3,000 files or more), which then needs the full suite. */
export async function changedFiles(get, repo, number) {
  try {
    return await pullFiles(get, repo, number);
  } catch (e) {
    if (/3,000 files or more/.test(e.message)) return null;
    throw e;
  }
}

async function main() {
  const { REPO, HEAD_SHA, PR_NUMBER, MERGE_GROUP_HEAD_SHA } = process.env;
  const GH_TOKEN = githubToken();
  const queue = Boolean(MERGE_GROUP_HEAD_SHA);
  const sha = queue ? MERGE_GROUP_HEAD_SHA : HEAD_SHA;
  if (!REPO || !/^[0-9a-f]{40}$/.test(sha ?? '') || (!queue && !/^\d+$/.test(PR_NUMBER ?? ''))) {
    console.error('::error title=CI merge seal::ci-jobs-seal needs REPO, and HEAD_SHA with PR_NUMBER or MERGE_GROUP_HEAD_SHA');
    process.exit(1);
  }
  const get = (p) => api(p, GH_TOKEN);
  const v = await judgeWaitingOnGates({
    judge: () => verdicts({ get, REPO, sha, queue, PR_NUMBER }),
    rerun: (step) => rerunStaleGates({ repo: REPO, step, get, post: (p) => apiPost(p, GH_TOKEN) }),
    wait: (step) => awaitGatesRerun({ repo: REPO, step, get }),
  });
  const { ci, money, model, rules } = v;
  for (const x of [ci, money, model, rules]) for (const l of x.lines) console.log(`${x.ok ? '✓' : '✖'} ${l}`);
  if (ci.ok && money.ok && model.ok && rules.ok) return;
  for (const x of [ci, money, model, rules])
    if (!x.ok) for (const l of x.lines) console.error(`::error title=${x.down ? 'judge down: Model check' : 'CI merge seal'}::${l}`);
  process.exit(1);
}

/** One reading of every verdict the seal gives on the head: { ci, money, model, rules }. */
async function verdicts({ get, REPO, sha, queue, PR_NUMBER }) {
  const event = queue ? 'merge_group' : 'pull_request';
  const runs = (await get(`/repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=${event}&per_page=100`))?.workflow_runs;
  if (!Array.isArray(runs)) throw new Error(`ci.yml runs on ${sha}: not a list`);
  const run = ciRunFor(runs, { sha, event });
  const jobs = run ? await runJobs(`/repos/${REPO}/actions/runs/${run.id}/jobs?filter=latest`, get) : [];
  if (!Array.isArray(jobs)) throw new Error(`run ${run.id}'s jobs: not a list`);
  const files = queue ? [] : await changedFiles(get, REPO, PR_NUMBER);
  // The head's tree, for a change that only tooling could narrow: read through git by main's tooling-reach.mjs. A tree
  // that can't be read leaves today's rules.
  let tree = null;
  if (!queue && files && narrowCandidates(files).length)
    try {
      const { commitTree } = await import('./tooling-reach.mjs');
      tree = commitTree(fileURLToPath(new URL('../..', import.meta.url)), sha);
    } catch (e) {
      console.log(`the head's tree could not be read (${e.message.split('\n')[0]}): today's rules judge`);
    }
  let ci;
  try {
    ci = judgeCiJobs({ run, jobs, files, forceFull: queue, tree });
  } finally {
    tree?.cleanup();
  }
  // The money browser checks (#8708), on a pull request only: read when the change touches their paths.
  let money = { ok: true, lines: [] };
  if (!queue && (files === null || touchesMoney(files))) {
    const mruns = (
      await get(`/repos/${REPO}/actions/workflows/customer-money-browser.yml/runs?head_sha=${sha}&event=pull_request&per_page=100`)
    )?.workflow_runs;
    if (!Array.isArray(mruns)) throw new Error(`customer-money-browser.yml runs on ${sha}: not a list`);
    const newest = mruns.filter((r) => r?.head_sha === sha).sort((a, b) => b.id - a.id)[0];
    const mjobs = newest ? await runJobs(`/repos/${REPO}/actions/runs/${newest.id}/jobs?filter=latest`, get) : [];
    if (!Array.isArray(mjobs)) throw new Error(`run ${newest.id}'s jobs: not a list`);
    money = moneyVerdict({ runs: mruns, jobs: mjobs, files, sha });
  } else if (!queue) money = moneyVerdict({ runs: [], jobs: [], files, sha });
  // The Model check (project-state#2962), on a pull request only: it runs on every one.
  let model = { ok: true, lines: [] };
  if (!queue) {
    const xruns = (await get(`/repos/${REPO}/actions/workflows/model-check.yml/runs?head_sha=${sha}&event=pull_request&per_page=100`))
      ?.workflow_runs;
    if (!Array.isArray(xruns)) throw new Error(`model-check.yml runs on ${sha}: not a list`);
    const newest = xruns.filter((r) => r?.head_sha === sha).sort((a, b) => b.id - a.id)[0];
    const xjobs = newest ? await runJobs(`/repos/${REPO}/actions/runs/${newest.id}/jobs?filter=latest`, get) : [];
    if (!Array.isArray(xjobs)) throw new Error(`run ${newest.id}'s jobs: not a list`);
    model = modelVerdict({ runs: xruns, jobs: xjobs, sha });
  }
  // main's rules as they are now (project-state#3326), on a pull request only: a merge queue's commit is built on main.
  const rules =
    !queue && run ? rulesVerdict({ run, jobs, changes: await ruleChanges(get, REPO, rulesTakenAt(run)) }) : { ok: true, lines: [] };
  return { ci, money, model, rules };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`::error title=${titleFor(e.message, 'CI merge seal')}::${e.message}`);
    process.exit(1);
  });
}
