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
 * - A run still going fails this verdict with a wait line; merge-seal-recheck re-runs the seal when CI finishes.
 * - Every test shard (`Tests (…)`) must succeed, and there must be one when the change needs tests.
 * - A pull request's own ci.yml may differ from main's: a change to it is a gate file, so the seal's CI review step
 *   holds it to the independent review. This script never runs or reads the pull request's code.
 *
 *   GH_TOKEN=... REPO=owner/name HEAD_SHA=<sha> (PR_NUMBER=<n> | MERGE_GROUP_HEAD_SHA=<sha>) node tooling/ci/ci-jobs-seal.mjs
 */
import { classify, sealNeeded } from './ci-affected.mjs';

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
  if (!run) return { ok: false, wait: true, lines: ['CI (ci.yml) has not run on this head yet; the seal re-runs when it finishes'] };
  const id = `CI run ${run.id} (attempt ${run.run_attempt ?? 1})`;
  if (run.status !== 'completed')
    return { ok: false, wait: true, lines: [`${id} on this head is ${run.status}; the seal re-runs when it finishes`] };
  const flags = files === null ? { full: true, affected: false } : classify(files, { forceFull });
  const problems = sealNeeded(flags, jobResults(jobs));
  if (!problems.length) return { ok: true, wait: false, lines: [`${id}: required jobs succeeded`] };
  return { ok: false, wait: false, lines: problems.map((p) => `${id}: ${p}`) };
}

async function api(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** The pull request's changed paths (a renamed file counts by both names), or null at GitHub's 3,000-file limit. */
export async function changedFiles(get, repo, number) {
  const all = [];
  for (let page = 1; page <= 30; page++) {
    const r = await get(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
    if (!Array.isArray(r)) throw new Error(`#${number}'s files: not a list`);
    for (const f of r) all.push(f.filename, ...(f.previous_filename ? [f.previous_filename] : []));
    if (r.length < 100) return all;
  }
  return null;
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
  if (run?.status === 'completed')
    for (let page = 1; page <= 10; page++) {
      const r = (await get(`/repos/${REPO}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`))?.jobs;
      if (!Array.isArray(r)) throw new Error(`run ${run.id}'s jobs: not a list`);
      jobs.push(...r);
      if (r.length < 100) break;
    }
  const files = queue ? [] : await changedFiles(get, REPO, PR_NUMBER);
  const v = judgeCiJobs({ run, jobs, files, forceFull: queue });
  for (const l of v.lines) console.log(`${v.ok ? '✓' : '✖'} ${l}`);
  if (v.ok) return;
  for (const l of v.lines) console.error(`::error title=CI merge seal::${l}`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`::error title=CI merge seal::${e.message}`);
    process.exit(1);
  });
}
