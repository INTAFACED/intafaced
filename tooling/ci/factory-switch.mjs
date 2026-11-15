#!/usr/bin/env node
/**
 * The factory switch (owner decision 2026-11-07): the one-line file `FACTORY` on the branch `factory-switch`, `run` or
 * `pause`. Only `run` lets a pull request or a merge queue's commit through the CI merge seal; `pause`, a missing branch
 * or file, an unreadable answer or any other text fails it, whoever opened the pull request.
 *
 * Where it is read, always the default branch's copy:
 *   - the seal step "The factory switch says run" (ci.yml), on every pull request and merge queue commit;
 *   - journey-seal.mjs, which every seal since 2026-11-06 runs from the default branch, so a re-run of a seal whose
 *     workflow predates that step reads the switch too.
 *
 * A flip reaches pull requests that are already green: the branch's own workflow (factory-sweep.yml, copied here as
 * tooling/ci/factory-switch-branch/) runs `--sweep` from the default branch on every push to it. On `pause` it re-runs
 * every open pull request's green seal, which then fails; on `run` it re-runs every seal that failed on the switch.
 *
 * Who lifts it, and how: whoever holds write access to the repo (the OG, on the owner's word), with one call that is a
 * push to the branch, never a pull request, so a pause can never block the change that lifts it:
 *   gh api -X PUT repos/INTAFACED/intafaced/contents/FACTORY -f branch=factory-switch -f message='factory: run' \
 *     -f content="$(printf 'run\n' | base64)" \
 *     -f sha="$(gh api 'repos/INTAFACED/intafaced/contents/FACTORY?ref=factory-switch' --jq .sha)"
 * Builders read it with:
 *   gh api -H 'Accept: application/vnd.github.raw' 'repos/INTAFACED/intafaced/contents/FACTORY?ref=factory-switch'
 *
 * Written limits (what the switch does not close):
 *   A. Anyone with write access can flip it, and every agent pushes as one login, so the branch's history shows when it
 *      flipped, not who flipped it. The branch's sweep workflow is as editable as the switch, which adds no power.
 *   B. Between a push to `pause` and the sweep's re-runs (about 25 seconds in #7361's proof), a green PR can still merge.
 *   C. A seal from before 2026-11-06 07:26 UTC (before the journey-steps step) doesn't read the switch on a re-run; such
 *      a PR needs a new push or a merge from main.
 *   D. The check that the CI review passed is itself a step inside the seal job, so it doesn't catch a PR that rewrites
 *      that job: the PR's own seal can drop both the switch step and the review step.
 *   E. Every agent acts as the admin login, so `gh pr merge --admin` passes a pause through the ruleset's admin bypass.
 *      A bounded identity for agents, without admin (the redesign's B1), closes it.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CI_WORKFLOW, recheckStep, SEAL } from './journey-seal.mjs';

export const SWITCH_BRANCH = 'factory-switch';
export const SWITCH_FILE = 'FACTORY';
/** The seal steps that read the switch: a seal that failed on one of them may pass once it says `run` again. */
export const SWITCH_STEPS = ['The factory switch says run', 'Require the named journey steps on this exact head'];

/** The switch's verdict from the file's text: only `run` (surrounding whitespace allowed) lets a merge through. */
export function judgeSwitch(text) {
  const state = typeof text === 'string' ? text.trim() : '';
  if (state === 'run') return { pass: true, state };
  // Quoted and cut short, so the file's text can't add lines (or workflow commands) to the log.
  return {
    pass: false,
    state,
    why: `${SWITCH_FILE} on branch ${SWITCH_BRANCH} says ${JSON.stringify(state.slice(0, 40))}, not "run"`,
  };
}

/** Reads the file's raw text through the contents API; any non-200 answer throws, so the seal fails closed. */
export async function readSwitch({ repo, token, fetchImpl = fetch }) {
  const path = `/repos/${repo}/contents/${SWITCH_FILE}?ref=${SWITCH_BRANCH}`;
  const res = await fetchImpl(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github.raw' },
  });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.text();
}

/** The seal's problem with the switch, or null when it says `run`. An unreadable switch is a problem (fails closed). */
export async function switchProblem(opts) {
  try {
    const v = judgeSwitch(await readSwitch(opts));
    return v.pass ? null : { title: 'Factory paused', why: `${v.why}, so nothing merges (owner decision 2026-11-07)` };
  } catch (e) {
    return { title: 'Factory switch unreadable', why: `${e.message}; the seal fails closed, so nothing merges` };
  }
}

/**
 * Whether a flip should re-run a finished seal job (with its steps). Paused: every green seal, so it fails. Running:
 * only a seal that failed on a step that reads the switch, so no other red is re-run and nothing else changes.
 */
export function sweepWants(paused, seal) {
  if (paused) return seal?.conclusion === 'success';
  return seal?.conclusion === 'failure' && (seal.steps ?? []).some((s) => SWITCH_STEPS.includes(s?.name) && s?.conclusion === 'failure');
}

/** One open pull request's head on a flip: wait out a running seal, then re-run it if sweepWants says so. */
export async function sweepHead({ repo, sha, paused, get, post, sleep, polls = 75, pollMs = 20_000 }) {
  for (let poll = 1; ; poll++) {
    const runs = (await get(`/repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${sha}&event=pull_request&per_page=100`))
      ?.workflow_runs;
    if (!Array.isArray(runs)) throw new Error(`${CI_WORKFLOW} runs on ${sha}: not a list`);
    const jobsByRun = new Map();
    let step = recheckStep(runs, jobsByRun);
    while (step.act === 'jobs') {
      const jobs = (await get(`/repos/${repo}/actions/runs/${step.runId}/jobs?filter=latest&per_page=100`))?.jobs;
      if (!Array.isArray(jobs)) throw new Error(`run ${step.runId}'s jobs: not a list`);
      jobsByRun.set(step.runId, jobs);
      step = recheckStep(runs, jobsByRun);
    }
    if (step.act === 'done') return step.msg.replace('read the steps', 'read the switch');
    if (step.act === 'fail') throw new Error(step.msg);
    if (step.act === 'rerun') {
      const seal = jobsByRun.get(step.runId).find((j) => String(j.id) === step.jobId);
      if (!sweepWants(paused, seal)) return `the seal (${seal?.conclusion}) is left as it is`;
      const { status, message = '' } = await post(`/repos/${repo}/actions/jobs/${step.jobId}/rerun`);
      if (status === 403 && /already running/i.test(message)) return `run ${step.runId} is already re-running`;
      if (status !== 201) throw new Error(`could not re-run the seal job ${step.jobId}: HTTP ${status} ${message}`);
      return `re-ran the ${seal.conclusion} seal job ${step.jobId} of run ${step.runId}`;
    }
    if (poll >= polls) throw new Error(`${step.msg} after ${(polls * pollMs) / 60_000} min; push to the switch again`);
    await sleep(pollMs);
  }
}

/** The sweep: every open pull request into the default branch, all at once; any head that couldn't be swept fails it. */
export async function sweep({ repo, base, paused, get, post, sleep, log = console.log }) {
  const pulls = [];
  for (let page = 1; page <= 10; page++) {
    const p = await get(`/repos/${repo}/pulls?state=open&base=${base}&per_page=100&page=${page}`);
    if (!Array.isArray(p)) throw new Error('the open pull requests: not a list');
    pulls.push(...p);
    if (p.length < 100) break;
    if (page === 10) throw new Error('more than 1,000 open pull requests, not whole');
  }
  const results = await Promise.allSettled(pulls.map((p) => sweepHead({ repo, sha: p.head.sha, paused, get, post, sleep })));
  let failed = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') log(`#${pulls[i].number}: ${r.value}`);
    else {
      failed++;
      console.error(`::error title=Not swept::#${pulls[i].number}: ${r.reason?.message ?? r.reason}`);
    }
  });
  log(`FACTORY ${paused ? 'pause' : 'run'}: ${pulls.length} open pull requests swept, ${failed} could not be`);
  return failed === 0;
}

function apiFor(token) {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' };
  return {
    async get(path) {
      const res = await fetch(`https://api.github.com${path}`, { headers });
      if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
      return res.json();
    },
    async post(path) {
      const res = await fetch(`https://api.github.com${path}`, { method: 'POST', headers });
      const text = await res.text();
      let message = text;
      try {
        message = JSON.parse(text)?.message ?? text;
      } catch {}
      return { status: res.status, message: String(message).slice(0, 200) };
    },
  };
}

async function main() {
  const { REPO, GH_TOKEN, BASE = 'main' } = process.env;
  if (!REPO || !GH_TOKEN) throw new Error('factory-switch needs REPO and GH_TOKEN');
  const problem = await switchProblem({ repo: REPO, token: GH_TOKEN });
  if (process.argv.includes('--sweep')) {
    const { get, post } = apiFor(GH_TOKEN);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (!(await sweep({ repo: REPO, base: BASE, paused: Boolean(problem), get, post, sleep }))) process.exit(1);
    return;
  }
  if (problem) {
    console.error(`::error title=${problem.title}::${problem.why}`);
    process.exit(1);
  }
  console.log('FACTORY=run');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main().catch((e) => {
    console.error(`::error title=Factory switch failed::${e.message}`);
    process.exit(1);
  });
