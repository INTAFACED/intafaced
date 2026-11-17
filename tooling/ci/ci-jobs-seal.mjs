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
import { START_JOB, pullFiles } from './journey-seal.mjs';
import { httpMessage, titleFor } from './api-budget.mjs';

export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';

/** ci.yml's job names (`name:`), keyed as sealNeeded keys its results. */
export const CI_JOBS = { changes: 'Affected tests', gates: 'Doctrine gates', format: 'Format', build: 'Typecheck & build' };
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
 * The money browser checks on this exact head (#8708): the newest pull_request run of MONEY_WORKFLOW_PATH there decides,
 * as CI's newest run does. A change that touches none of MONEY_PATHS owes no run and is not held. One that touches them
 * needs that run finished with its MONEY_JOB passed: still going waits, and none, red, cancelled or skipped fails closed
 * (a pull request's own copy of the workflow could drop its trigger). `files` null (unreadable) counts as touching.
 * Returns { ok, wait, lines }. Pure.
 */
export function moneyVerdict({ runs, jobs, files, sha }) {
  if (files !== null && !touchesMoney(files))
    return { ok: true, wait: false, lines: ['the money browser checks: the change touches none of their paths, so none is owed'] };
  const run =
    (runs ?? [])
      .filter((r) => r?.head_sha === sha && r?.event === 'pull_request' && r?.path === MONEY_WORKFLOW_PATH)
      .sort((a, b) => b.id - a.id)[0] ?? null;
  if (!run)
    return {
      ok: false,
      wait: false,
      lines: ['the money browser checks: the change touches their paths and no run of them is on this head; push again or re-open'],
    };
  const id = `the money browser checks, run ${run.id} (attempt ${run.run_attempt ?? 1})`;
  const job = (jobs ?? []).filter((j) => j?.name === MONEY_JOB).sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
  if (!job || job.status !== 'completed')
    return { ok: false, wait: true, lines: [`${id} on this head has not finished; the seal re-runs when it does`] };
  if (job.conclusion === 'success') return { ok: true, wait: false, lines: [`${id}: passed`] };
  return { ok: false, wait: false, lines: [`${id}: ${job.conclusion}; fix the money screen or its check and push`] };
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
  for (const v of [ci, money]) for (const l of v.lines) console.log(`${v.ok ? '✓' : '✖'} ${l}`);
  if (ci.ok && money.ok) return;
  for (const v of [ci, money]) if (!v.ok) for (const l of v.lines) console.error(`::error title=CI merge seal::${l}`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`::error title=${titleFor(e.message, 'CI merge seal')}::${e.message}`);
    process.exit(1);
  });
}
