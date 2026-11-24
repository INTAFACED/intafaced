#!/usr/bin/env node
/**
 * A change to the judges alone (merge-seal.yml's first seal step, REPAIR_STEP). A pull request that changes only the CI
 * review's or the merge seal's own files (JUDGE_FILES) passes the seal when every other check on its exact head is
 * green and the CI review did not FAIL it; else the seal judges it as any other change, by the steps after this one.
 * It replaces the floor's one admin merge (project-state#4001: agents get a GitHub App login that can add no bypass
 * actor), and it is narrower than that merge, which needed only "every other check green" and any file list:
 *   - every changed path, and each renamed one's old path, is in JUDGE_FILES (main's copy: a pull request can't widen it);
 *   - every Actions workflow's newest run on the head is green (success, skipped or neutral), CI's among them, except this
 *     seal's own workflow and the CI review's, which is read by its job;
 *   - the CI review's newest `CI review` job on the head has finished, and neither its `Verdict` nor its `Test verdict`
 *     failed: a FAIL blocks whatever files changed. A change to the seal's files alone needs its PASS (`Verdict` success).
 *     Only a change to the review's own code may pass with the review giving no verdict (down, or failing before it
 *     judged), since a broken review can't judge its own repair; that is the deadlock the admin merge was for.
 *   - the factory switch says `run` (read here, so a broken factory-switch.mjs can be repaired too);
 *   - the pull request is open, in this repository, into main, and its head is still HEAD_SHA.
 * It imports nothing from the scripts it can repair, so a bug in them never stops it. Any error here passes nothing: the
 * step is continue-on-error, prints why, and the seal's other steps judge the change as before.
 */
import { appendFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The CI review's own code: a change here alone may pass while the review gives no verdict. Its briefs are not here. */
export const REVIEW_FILES = [
  '.github/workflows/ci-review.yml',
  '.github/workflows/ci-review/package.json',
  '.github/workflows/ci-review/package-lock.json',
  'tooling/ci/ci-review.mjs',
  'tooling/ci/ci-review.test.mjs',
  'tooling/ci/ci-review-parts.test.mjs',
  'tooling/ci/reviewer-error.mjs',
  'tooling/ci/reviewer-error.test.mjs',
  'tooling/ci/judge-down.mjs',
  'tooling/ci/judge-down.test.mjs',
  'tooling/ci/test-judge.mjs',
  'tooling/ci/test-judge.test.mjs',
  'tooling/ci/step-read.mjs',
  'tooling/ci/step-read.test.mjs',
  'tooling/ci/step-pictures.mjs',
];

/** The merge seal's own code: a change here alone needs the CI review's PASS. */
export const SEAL_FILES = [
  '.github/workflows/merge-seal.yml',
  'tooling/ci/judge-repair.mjs',
  'tooling/ci/judge-repair.test.mjs',
  'tooling/ci/journey-seal.mjs',
  'tooling/ci/journey-seal.test.mjs',
  'tooling/ci/ci-jobs-seal.mjs',
  'tooling/ci/ci-jobs-seal.test.mjs',
  'tooling/ci/review-marker.mjs',
  'tooling/ci/review-marker.test.mjs',
  'tooling/ci/factory-switch.mjs',
  'tooling/ci/factory-switch.test.mjs',
  'tooling/ci/api-budget.mjs',
  'tooling/ci/api-budget.test.mjs',
];

export const JUDGE_FILES = [...REVIEW_FILES, ...SEAL_FILES];

/** merge-seal.yml's step that runs this file; journey-seal.mjs recheckStep leaves a seal still in it alone. */
export const REPAIR_STEP = 'A change to the judges alone: every other check green, and no FAIL from the CI review';

const SEAL_WORKFLOW = '.github/workflows/merge-seal.yml';
const REVIEW_WORKFLOW = '.github/workflows/ci-review.yml';
const CI_WORKFLOW = '.github/workflows/ci.yml';
const GREEN = ['success', 'skipped', 'neutral'];

/**
 * Whether `files` (the pull request's files API entries) are the judges' alone, and whether any is the review's code.
 * An empty or unreadable list is not. Pure.
 */
export function judgeOnly(files) {
  const paths = (files ?? []).flatMap((f) => [f?.filename, f?.previous_filename].filter((p) => p !== undefined));
  if (!paths.length) return { judge: false, why: 'the change lists no files' };
  const other = paths.find((p) => typeof p !== 'string' || !JUDGE_FILES.includes(p));
  if (other !== undefined) return { judge: false, why: `${other} is not one of the judges' own files` };
  return { judge: true, review: paths.some((p) => REVIEW_FILES.includes(p)) };
}

/** The `CI review` job that judged the head: the newest one that ran (an edit's run skips it). Pure. */
export function reviewJobOf(jobsNewestFirst) {
  return (
    (jobsNewestFirst ?? []).find((j) => j?.name === 'CI review' && !(j?.status === 'completed' && j?.conclusion === 'skipped')) ?? null
  );
}

/**
 * The verdict, from what the API returned. `runs` are the Actions runs on the head; `reviewJob` reviewJobOf's answer;
 * `review` whether a review file changed; `factory` the switch's text. Returns { act: 'pass' | 'wait' | 'refuse', why }.
 * Pure, so the table is testable.
 */
export function judge({ sha, runs, reviewJob, review, factory }) {
  const newest = new Map();
  for (const r of runs ?? []) {
    if (r?.head_sha !== sha || !['pull_request', 'pull_request_target'].includes(r?.event)) continue;
    const had = newest.get(r.path);
    if (!had || Number(r.id) > Number(had.id)) newest.set(r.path, r);
  }
  if (!newest.has(CI_WORKFLOW)) return { act: 'wait', why: 'CI has not run on this head' };
  const going = [];
  for (const [path, r] of newest) {
    if (path === SEAL_WORKFLOW || path === REVIEW_WORKFLOW) continue;
    if (r.status !== 'completed') going.push(`${path} run ${r.id} (${r.status})`);
    else if (!GREEN.includes(r.conclusion)) return { act: 'refuse', why: `${path} run ${r.id} ended ${r.conclusion}` };
  }
  if (!reviewJob) going.push('the CI review (no run of its job on this head yet)');
  else if (reviewJob.status !== 'completed') going.push(`the CI review job ${reviewJob.id} (${reviewJob.status})`);
  if (going.length) return { act: 'wait', why: `still going: ${going.join(', ')}` };
  const step = (name) => (reviewJob.steps ?? []).find((s) => s?.name === name)?.conclusion;
  if (step('Verdict') === 'failure' || step('Test verdict') === 'failure')
    return { act: 'refuse', why: `the CI review FAILed this head (job ${reviewJob.id}); a FAIL stands for this code` };
  if (!review && !(reviewJob.conclusion === 'success' && step('Verdict') === 'success'))
    return {
      act: 'refuse',
      why: `a change to the seal's files alone needs the CI review's PASS; job ${reviewJob.id} ended ${reviewJob.conclusion} with its Verdict ${step('Verdict') ?? 'not run'}`,
    };
  if (String(factory ?? '').trim() !== 'run') return { act: 'refuse', why: 'the factory switch does not say run' };
  return {
    act: 'pass',
    why: review
      ? `every other check is green on this head and the CI review did not FAIL it (job ${reviewJob.id}: ${step('Verdict') === 'success' ? 'PASS' : 'no verdict'})`
      : `every other check is green on this head and the CI review PASSed it (job ${reviewJob.id})`,
  };
}

async function api(path, { token, raw = false, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://api.github.com/${path}`, {
    headers: {
      accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GET ${path.split('?')[0]}: HTTP ${res.status}`);
  return raw ? res.text() : res.json();
}

async function pages(path, key, opts) {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const body = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, opts);
    const items = key ? body?.[key] : body;
    if (!Array.isArray(items)) throw new Error(`GET ${path.split('?')[0]}: no list`);
    out.push(...items);
    if (items.length < 100) return out;
  }
  throw new Error(`GET ${path.split('?')[0]}: more than 3,000 entries`);
}

/** Whether the pull request is the judges' alone: { judge, review, why }. Read once. `opts`: token, fetchImpl. */
export async function readChange({ repo, sha, pr, ...opts }) {
  const pull = await api(`repos/${repo}/pulls/${pr}`, opts);
  if (pull?.state !== 'open' || pull?.base?.ref !== 'main' || pull?.head?.repo?.full_name !== repo || pull?.head?.sha !== sha)
    return { judge: false, why: `#${pr} is not an open pull request from this repository into main at ${sha.slice(0, 10)}` };
  // A draft gets no CI review and can't merge; marked ready, its review's Start the seal re-runs this seal.
  if (pull?.draft) return { judge: false, why: `#${pr} is a draft` };
  return judgeOnly(await pages(`repos/${repo}/pulls/${pr}/files`, null, opts));
}

/** Reads the runs on the head and the review job, then the switch once the rest passes, and judges. */
export async function readAndJudge({ repo, sha, review, ...opts }) {
  const runs = await pages(`repos/${repo}/actions/runs?head_sha=${sha}`, 'workflow_runs', opts);
  let reviewJob = null;
  const reviews = runs
    .filter((r) => r?.path === REVIEW_WORKFLOW && r?.event === 'pull_request_target' && r?.head_sha === sha)
    .sort((a, b) => Number(b.id) - Number(a.id));
  for (const r of reviews) {
    reviewJob = reviewJobOf((await api(`repos/${repo}/actions/runs/${r.id}/jobs?filter=latest&per_page=100`, opts))?.jobs);
    if (reviewJob) break;
  }
  const first = judge({ sha, runs, reviewJob, review, factory: 'run' });
  if (first.act !== 'pass') return first;
  const factory = await api(`repos/${repo}/contents/FACTORY?ref=factory-switch`, { ...opts, raw: true });
  return judge({ sha, runs, reviewJob, review, factory });
}

/** Judges until it can say pass or refuse, waiting while a check is still going (WAIT_POLLS, POLL_MS apart). */
export async function main({
  env = process.env,
  log = console.log,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchImpl,
} = {}) {
  const { GH_TOKEN: token, REPO: repo, HEAD_SHA: sha, PR_NUMBER: pr, GITHUB_OUTPUT: out } = env;
  if (!token || !repo || !/^[0-9a-f]{40}$/.test(sha ?? '') || !/^\d+$/.test(pr ?? ''))
    throw new Error('needs GH_TOKEN, REPO, HEAD_SHA and PR_NUMBER');
  const polls = Number(env.WAIT_POLLS ?? 25);
  const ms = Number(env.POLL_MS ?? 120_000);
  const change = await readChange({ repo, sha, pr, token, fetchImpl });
  if (!change.judge) {
    log(`not a change to the judges alone (${change.why}); the seal's other steps judge it`);
    return { act: 'skip', why: change.why };
  }
  for (let i = 0; ; i++) {
    const v = await readAndJudge({ repo, sha, review: change.review, token, fetchImpl });
    if (v.act === 'wait' && i < polls) {
      log(`waiting: ${v.why}`);
      await sleep(ms);
      continue;
    }
    if (v.act === 'pass') {
      log(`PASS: a change to the judges alone; ${v.why}. The seal's other steps are skipped.`);
      if (out) appendFileSync(out, 'pass=true\n');
    } else
      log(
        `::warning::a change to the judges alone, not passed here (${v.act === 'wait' ? `waited too long: ${v.why}` : v.why}); the seal's other steps judge it`,
      );
    return v;
  }
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
})();
if (isMain)
  main().catch((e) => {
    console.log(`::warning::judge-repair.mjs could not judge (${e.message}); the seal's other steps judge the change`);
    process.exitCode = 1;
  });
