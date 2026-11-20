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
 * - A pull request's own ci.yml may differ from main's: a change to it is a gate file, so the seal's CI review step
 *   holds it to the independent review. This script never runs or reads the pull request's code.
 *
 *   GH_TOKEN=... REPO=owner/name HEAD_SHA=<sha> (PR_NUMBER=<n> | MERGE_GROUP_HEAD_SHA=<sha>) node tooling/ci/ci-jobs-seal.mjs
 */
import { SHARD_COUNT, classify, sealNeeded, shardMatrix } from './ci-affected.mjs';
import { MODEL_JOB, START_JOB, isModelDown, pullFiles } from './journey-seal.mjs';
import { httpMessage, titleFor } from './api-budget.mjs';

export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';

/** ci.yml's job names (`name:`), keyed as sealNeeded keys its results. */
export const CI_JOBS = { changes: 'Affected tests', gates: 'Doctrine gates', format: 'Format', build: 'Typecheck & build', rust: 'Rust' };
/** The test matrix's jobs: `Tests (1/16)` … or `Tests (changed)`. */
export const TEST_JOB = /^Tests \(.+\)$/;

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
  const tests = [...newest.values()].filter((j) => TEST_JOB.test(j?.name ?? ''));
  const bad = tests.map(result).find((r) => r !== 'success');
  out['tests-full'] = tests.length ? (bad ?? 'success') : undefined;
  return out;
}

/**
 * The verdict. `files` are the pull request's changed paths, or null when they can't be read whole (the full suite is
 * then needed). `forceFull` for a merge queue's commit (runsEverything). Returns { ok, wait, lines }.
 */
export function judgeCiJobs({ run, jobs, files, forceFull = false }) {
  if (!run)
    return { ok: false, wait: true, lines: ['no CI ran for this pull request on this head: merge origin/main if it conflicts, else push'] };
  const id = `CI run ${run.id} (attempt ${run.run_attempt ?? 1})`;
  // A run is judged once every job but ci.yml's own seal has finished: a re-run of that seal alone puts the run back in
  // progress, and must not turn this seal red (the CI review on 7a7eb9a0, 8 Nov 2026). Its last job, START_JOB, is
  // what starts this seal, so it is still going while this reads.
  const pending = (jobs ?? []).filter(
    (j) => j?.name !== 'CI merge seal' && j?.name !== 'CI jobs' && j?.name !== START_JOB && j?.status !== 'completed',
  );
  if (run.status !== 'completed' && (pending.length || !(jobs ?? []).length))
    return { ok: false, wait: true, lines: [`${id} on this head is ${run.status}; the seal re-runs when it finishes`] };
  const flags = files === null ? { full: true, affected: false } : classify(files, { forceFull });
  const problems = sealNeeded(flags, jobResults(jobs));
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
 * mainRef), so a re-run of that job judges by them. GATE_PATHS, the gate list, is read from the run's merge commit, which
 * a re-run keeps, so only a new head judges by it. The per-file baselines that may only shrink (dead-code,
 * conflict-keys) are left out: a shrink on main can't let through a change CI passed, and they shrink many times a day
 * (#9081 would have stopped three clean merges in the replay). A folder ends in `/`.
 */
export const LINT_PATHS = ['.oxlintrc.json', 'tooling/lint/'];
export const GATE_PATHS = ['tooling/ci/gates.mjs'];
export const RULE_PATHS = [...LINT_PATHS, ...GATE_PATHS];
/** GitHub makes a pull request's merge commit just before CI's run is created; a gate change merged this close before
 *  the run may not be in it, so it counts as after. */
export const RULE_MARGIN_MS = 60_000;

/** The moment CI's run on the head took main's gate list: its creation, minus RULE_MARGIN_MS. A re-run keeps the first
 *  attempt's merge commit, so its created_at still decides. null when no run. */
export const rulesTakenAt = (run) => (run?.created_at ? new Date(Date.parse(run.created_at) - RULE_MARGIN_MS).toISOString() : null);

/** The moment the newest Doctrine gates job read main's lint rules: its start (the fetch is a later step of it). Without
 *  one, the run's creation. */
export const lintTakenAt = (run, jobs) => {
  const gates = [...(jobs ?? [])].filter((j) => j?.name === CI_JOBS.gates && j?.started_at).sort((a, b) => b.id - a.id)[0];
  return gates ? new Date(Date.parse(gates.started_at)).toISOString() : rulesTakenAt(run);
};

/**
 * A pull request whose CI judged it before main changed a rule fails (project-state#3326: #8915, #8857 and #8789 passed
 * CI on a head from before a new rule and merged after it, 3 in 170 merges, one turning main red). `changes` are main's
 * commits on RULE_PATHS after rulesTakenAt(run): { path, sha, date, title }. A lint change counts only after the newest
 * Doctrine gates job started (lintTakenAt), and is cleared by re-running that job; a gate-list change counts after the
 * run was created, and is cleared by merging origin/main and pushing. With no CI run judgeCiJobs already holds the
 * merge. Returns { ok, lines }. Pure.
 */
export function rulesVerdict({ run, jobs, changes }) {
  if (!run) return { ok: true, lines: [] };
  const gateAt = rulesTakenAt(run);
  const lintAt = lintTakenAt(run, jobs);
  const late = (changes ?? []).filter((c) => Date.parse(c.date) > Date.parse(LINT_PATHS.includes(c.path) ? lintAt : gateAt));
  if (!late.length) return { ok: true, lines: [`main's rules: unchanged since CI run ${run.id} judged this head by them`] };
  const seen = new Map();
  for (const c of late) seen.set(c.sha, { ...c, paths: [...(seen.get(c.sha)?.paths ?? []), c.path] });
  const gatesJob = [...(jobs ?? [])].filter((j) => j?.name === CI_JOBS.gates).sort((a, b) => b.id - a.id)[0];
  return {
    ok: false,
    lines: [...seen.values()].map((c) =>
      c.paths.some((p) => GATE_PATHS.includes(p))
        ? `main changed ${c.paths.join(', ')} in ${c.sha.slice(0, 10)} at ${c.date} ("${c.title}"), after CI run ${run.id} took main's gate list (${gateAt}): merge origin/main and push, so CI runs the gates main has now (a re-run keeps the old list)`
        : `main changed ${c.paths.join(', ')} in ${c.sha.slice(0, 10)} at ${c.date} ("${c.title}"), after the Doctrine gates job read main's lint rules (${lintAt}): re-run it (gh run rerun ${run.id} --job ${gatesJob?.id ?? '<its id>'}); it reads main's rules afresh and starts the seal again`,
    ),
  };
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
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(httpMessage(path, res, (await res.text()).slice(0, 200)));
  return res.json();
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
  const { GH_TOKEN, REPO, HEAD_SHA, PR_NUMBER, MERGE_GROUP_HEAD_SHA } = process.env;
  const queue = Boolean(MERGE_GROUP_HEAD_SHA);
  const sha = queue ? MERGE_GROUP_HEAD_SHA : HEAD_SHA;
  if (!GH_TOKEN || !REPO || !/^[0-9a-f]{40}$/.test(sha ?? '') || (!queue && !/^\d+$/.test(PR_NUMBER ?? ''))) {
    console.error('::error title=CI merge seal::ci-jobs-seal needs GH_TOKEN, REPO, and HEAD_SHA with PR_NUMBER or MERGE_GROUP_HEAD_SHA');
    process.exit(1);
  }
  const get = (p) => api(p, GH_TOKEN);
  const event = queue ? 'merge_group' : 'pull_request';
  const runs = (await get(`/repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=${event}&per_page=100`))?.workflow_runs;
  if (!Array.isArray(runs)) throw new Error(`ci.yml runs on ${sha}: not a list`);
  const run = ciRunFor(runs, { sha, event });
  const jobs = [];
  if (run)
    for (let page = 1; page <= 10; page++) {
      const r = (await get(`/repos/${REPO}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`))?.jobs;
      if (!Array.isArray(r)) throw new Error(`run ${run.id}'s jobs: not a list`);
      jobs.push(...r);
      if (r.length < 100) break;
    }
  const files = queue ? [] : await changedFiles(get, REPO, PR_NUMBER);
  const ci = judgeCiJobs({ run, jobs, files, forceFull: queue });
  // The money browser checks (#8708), on a pull request only: read when the change touches their paths.
  let money = { ok: true, lines: [] };
  if (!queue && (files === null || touchesMoney(files))) {
    const mruns = (
      await get(`/repos/${REPO}/actions/workflows/customer-money-browser.yml/runs?head_sha=${sha}&event=pull_request&per_page=100`)
    )?.workflow_runs;
    if (!Array.isArray(mruns)) throw new Error(`customer-money-browser.yml runs on ${sha}: not a list`);
    const newest = mruns.filter((r) => r?.head_sha === sha).sort((a, b) => b.id - a.id)[0];
    const mjobs = newest ? (await get(`/repos/${REPO}/actions/runs/${newest.id}/jobs?filter=latest&per_page=100`))?.jobs : [];
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
    const xjobs = newest ? (await get(`/repos/${REPO}/actions/runs/${newest.id}/jobs?filter=latest&per_page=100`))?.jobs : [];
    if (!Array.isArray(xjobs)) throw new Error(`run ${newest.id}'s jobs: not a list`);
    model = modelVerdict({ runs: xruns, jobs: xjobs, sha });
  }
  // main's rules as they are now (project-state#3326), on a pull request only: a merge queue's commit is built on main.
  const rules =
    !queue && run ? rulesVerdict({ run, jobs, changes: await ruleChanges(get, REPO, rulesTakenAt(run)) }) : { ok: true, lines: [] };
  for (const v of [ci, money, model, rules]) for (const l of v.lines) console.log(`${v.ok ? '✓' : '✖'} ${l}`);
  if (ci.ok && money.ok && model.ok && rules.ok) return;
  for (const v of [ci, money, model, rules])
    if (!v.ok) for (const l of v.lines) console.error(`::error title=${v.down ? 'judge down: Model check' : 'CI merge seal'}::${l}`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`::error title=${titleFor(e.message, 'CI merge seal')}::${e.message}`);
    process.exit(1);
  });
}
