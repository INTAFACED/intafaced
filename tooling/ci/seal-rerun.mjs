#!/usr/bin/env node
/**
 * SEAL RE-RUN: after the CI review passes on a head, re-run that head's red `CI merge seal` job, so nobody re-runs it
 * by hand (ci-review.mjs `rerun-seal`, from ci-review.yml). Moved here unchanged from review-signoff.mjs when the
 * comment sign-off it served retired (U4 C5; project-state research/factory-2026-11-08 R3 C5): the seal reads only the
 * CI review's Verdict.
 */

export async function gh(method, path, body, accept = 'application/vnd.github+json') {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  // A re-run refused because the run is already running means someone re-ran it first: the caller handles that one.
  const alreadyRunning = res.status === 403 && /already running/i.test(text);
  if ((res.status === 403 && !alreadyRunning) || res.status === 429) {
    throw new Error(`GitHub ${res.status} on ${method} ${path}: stopping, not retrying`);
  }
  const json = accept.includes('json') && text ? JSON.parse(text) : null;
  return { status: res.status, json, text };
}

const SEAL = 'CI merge seal';
const runOf = (url) => /\/actions\/runs\/(\d+)/.exec(url ?? '')?.[1];
const sameRun = (a, b) => runOf(a) !== undefined && runOf(a) === runOf(b);
const SEAL_POLL_MS = 20_000;
const SEAL_POLLS = 12; // 4 minutes, inside ci-review.yml's job limit

/**
 * What to do about the seal after the CI review passes, from the seal's check runs on the head and the state of the CI run that
 * holds the newest one. Pure, so the table is testable. The check runs of a commit are read directly; the filtered
 * runs listing this used before can come back empty for a run that exists, which stranded #5889 without a word.
 */
export function sealStep(checkRuns, runStatus) {
  const seal = (checkRuns ?? []).filter((c) => c.name === SEAL).sort((a, b) => b.id - a.id)[0];
  if (!seal || seal.status === 'queued') return { act: 'done', msg: 'the seal has not started; it will read the review itself' };
  if (seal.status !== 'completed') return { act: 'wait', msg: 'the seal is running and may have read the head before the review' };
  if (seal.conclusion === 'success') return { act: 'done', msg: 'the seal is already green' };
  const runId = /\/actions\/runs\/(\d+)/.exec(seal.details_url ?? '')?.[1];
  if (!runId) return { act: 'fail', msg: `the red seal check run ${seal.id} names no workflow run` };
  if (runStatus === undefined) return { act: 'run', msg: `reading run ${runId}`, runId };
  if (runStatus !== 'completed') return { act: 'wait', msg: `run ${runId} is still finishing`, runId };
  return { act: 'rerun', runId };
}

/**
 * The seal's check runs on a head grouped by the workflow run that holds each (ci.yml's and merge-seal.yml's, R3 C3
 * piece 2), the newest per run. Every `CI merge seal` on a head must pass (probe #7547), so each is judged and re-run.
 */
export function sealsByRun(checkRuns) {
  const newest = new Map();
  for (const c of (checkRuns ?? []).filter((x) => x?.name === SEAL)) {
    const key = /\/actions\/runs\/(\d+)/.exec(c.details_url ?? '')?.[1] ?? `check-${c.id}`;
    if (!newest.has(key) || newest.get(key).id < c.id) newest.set(key, c);
  }
  return [...newest.values()];
}

/**
 * Re-run each CI merge seal that already finished red on this head (sealsByRun), so nobody re-runs one by hand.
 * Throws when it cannot find or re-run a red seal, which fails the CI review job's re-run step.
 */
export async function rerunSeal(repo, sha, opts = {}) {
  const { api = gh } = opts;
  const c = await api('GET', `/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(SEAL)}&filter=all&per_page=100`);
  if (c.status !== 200) throw new Error(`could not read the seal's check runs: HTTP ${c.status}`);
  const seals = sealsByRun(c.json?.check_runs);
  if (seals.length <= 1) return rerunOneSeal(repo, sha, { ...opts, first: c });
  const out = [];
  for (const [i, seal] of seals.entries())
    out.push(await rerunOneSeal(repo, sha, { ...opts, only: seal.details_url, first: i === 0 ? c : undefined }));
  return out.join('; ');
}

async function rerunOneSeal(
  repo,
  sha,
  { api = gh, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, only, first, number } = {},
) {
  // A re-run is a new attempt of its run and joins ci.yml's per-pull-request concurrency group, so re-running an old
  // head's seal cancels the new head's CI (8 Nov 2026: CI on 3dbe29e7 cancelled at 10:32 UTC by a re-run on e888920f).
  // Only a pull request still open on this head is re-sealed; a moved head gets its own seal. Read just before the
  // re-run, never earlier: the head can move while a running seal is waited out (review 7553-R1).
  const moved = async () => {
    if (number === undefined) return null;
    const p = await api('GET', `/repos/${repo}/pulls/${number}`);
    if (p.status !== 200) throw new Error(`could not read #${number}: HTTP ${p.status}`);
    if (p.json?.state === 'open' && p.json?.head?.sha === sha) return null;
    return `not re-run: #${number} is ${p.json?.state} on ${String(p.json?.head?.sha).slice(0, 10)}, not on ${sha.slice(0, 10)}`;
  };
  for (let poll = 1; ; poll++) {
    // The first read is rerunSeal's own; each poll after reads again.
    const c =
      poll === 1 && first
        ? first
        : await api('GET', `/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(SEAL)}&filter=all&per_page=100`);
    if (c.status !== 200) throw new Error(`could not read the seal's check runs: HTTP ${c.status}`);
    // One seal's run when several seals are on the head (rerunSeal), else every seal check run, newest first (sealStep).
    const pick = (runs) => (only ? sealsByRun(runs).filter((x) => sameRun(x.details_url, only)) : runs);
    let step = sealStep(pick(c.json?.check_runs), undefined);
    if (step.act === 'run') {
      const r = await api('GET', `/repos/${repo}/actions/runs/${step.runId}`);
      if (r.status !== 200) throw new Error(`could not read CI run ${step.runId}: HTTP ${r.status}`);
      step = sealStep(pick(c.json.check_runs), r.json?.status);
    }
    if (step.act === 'done') return step.msg;
    if (step.act === 'fail') throw new Error(step.msg);
    if (step.act === 'rerun') {
      const why = await moved();
      if (why) return why;
      const r = await api('POST', `/repos/${repo}/actions/runs/${step.runId}/rerun-failed-jobs`);
      if (r.status === 403) return `run ${step.runId} is already re-running`;
      if (r.status !== 201) throw new Error(`could not re-run the failed jobs of run ${step.runId}: HTTP ${r.status}`);
      return `re-ran the failed jobs of run ${step.runId}`;
    }
    if (poll >= SEAL_POLLS)
      throw new Error(`${step.msg} after ${(SEAL_POLLS * SEAL_POLL_MS) / 60_000} min; re-run the seal once it finishes`);
    log(`${step.msg}; checking again in ${SEAL_POLL_MS / 1000}s`);
    await sleep(SEAL_POLL_MS);
  }
}
