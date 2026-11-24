#!/usr/bin/env node
/**
 * A change to the judges alone (merge-seal.yml's first seal step, REPAIR_STEP). A pull request that changes only the CI
 * review's or the merge seal's own files (JUDGE_FILES) passes the seal when every other check on its exact head is
 * green and the CI review PASSed it with no FAIL standing, or, for the review's own code alone, the judge is down; else
 * the seal judges it as any other change, by the steps after this one.
 * It replaces the floor's one admin merge (project-state#4001: agents get a GitHub App login that can add no bypass
 * actor), and it is narrower than that merge, which needed only "every other check green" and any file list:
 *   - every changed path, and each renamed one's old path, is in JUDGE_FILES (main's copy: a pull request can't widen it);
 *   - every Actions workflow's newest run on the head is green (success, skipped or neutral), CI's among them, except this
 *     seal's own workflow and the CI review's, which is read by its job;
 *   - the CI review's newest `CI review` job on the head has finished, and no FAIL stands for this code: no attempt of any
 *     CI review run on this head, or on any other head whose commit has the same tree (found by the review's tree index,
 *     review-marker.mjs reviewIndexName), failed its `Verdict` or `Test verdict` (or the retired `Test judge` job's
 *     `Verdict`), as review-marker.mjs ciReviewVerdict holds. So re-running the review, an empty commit or a new run that
 *     fails before it judges can't ask again. A head whose merge base is older than FRESH_MS passes nothing here.
 *     Any change needs the newest job's PASS (`Verdict` success), but one to the review's own code alone (REVIEW_FILES),
 *     which may pass with the judge down instead: the job ended success with its `Judge down` step run and no verdict
 *     (review-marker.mjs isJudgeDown), since a review that can't reach its model can't judge its own repair; that is
 *     the deadlock the admin merge was for. A job cancelled, or failing before it judged, is no PASS and no judge down.
 *   - the factory switch says `run` (read here, so a broken factory-switch.mjs can be repaired too);
 *   - the pull request is open, in this repository, into main, and its head is still HEAD_SHA.
 * It imports none of the scripts it can repair (only run-jobs.mjs, the one way to read a run's jobs), so a bug in them
 * never stops it. Any error here passes nothing: the
 * step is continue-on-error, prints why, and the seal's other steps judge the change as before.
 */
import { appendFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runJobs } from './run-jobs.mjs';

/** The CI review's own code: a change here alone may pass while the judge is down. Its briefs are not here. */
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
  'tooling/ci/step-pictures.mjs',
];

/** The test judge's and the proof reader's code (checks on weakened tests and on the proof count): needs the PASS. */
export const PROOF_FILES = [
  'tooling/ci/test-judge.mjs',
  'tooling/ci/test-judge.test.mjs',
  'tooling/ci/step-read.mjs',
  'tooling/ci/step-read.test.mjs',
];

/** The merge seal's own code: needs the CI review's PASS. */
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

export const JUDGE_FILES = [...REVIEW_FILES, ...PROOF_FILES, ...SEAL_FILES];

/** merge-seal.yml's step that runs this file; journey-seal.mjs recheckStep leaves a seal still in it alone. */
export const REPAIR_STEP = 'A change to the judges alone: every other check green, and no FAIL from the CI review';

const SEAL_WORKFLOW = '.github/workflows/merge-seal.yml';
const REVIEW_WORKFLOW = '.github/workflows/ci-review.yml';
const CI_WORKFLOW = '.github/workflows/ci.yml';
const GREEN = ['success', 'skipped', 'neutral'];
/** The review's tree index (review-marker.mjs REVIEW_INDEX_PREFIX; ci-review.yml uploads it before any verdict). */
const INDEX_PREFIX = 'ci-review-tree-';
/**
 * The oldest merge base with main this step reads: the tree index went live on 4 Nov 2026 and keeps 90 days, so a base
 * this recent has every same-tree FAIL indexed. A judge repair is new code on a fresh main; an older one updates its branch.
 */
export const FRESH_MS = 14 * 24 * 60 * 60_000;
/** The verdict steps whose failure is a FAIL that stands for its code: [job, step]. */
const FAIL_STEPS = [
  ['CI review', 'Verdict'],
  ['CI review', 'Test verdict'],
  ['Test judge', 'Verdict'],
];

/**
 * The first FAIL in `reviewRuns` ([{ run, attempts }], attempts the jobs of each attempt, oldest first), or null. Any
 * attempt counts, whatever came after it. Pure.
 */
export function standingFail(reviewRuns) {
  for (const { run, attempts } of reviewRuns ?? [])
    for (const [i, jobs] of (attempts ?? []).entries())
      for (const job of jobs ?? [])
        for (const [name, step] of FAIL_STEPS)
          if (job?.name === name && (job.steps ?? []).find((s) => s?.name === step)?.conclusion === 'failure')
            return `run ${run.id} attempt ${i + 1} on ${String(run.head_sha).slice(0, 10)}: ${name} ${step} failed`;
  return null;
}

/**
 * Whether `files` (the pull request's files API entries) are the judges' alone, and whether all are the review's code
 * (`review`: it may pass with the judge down). An empty or unreadable list is not. Pure.
 */
export function judgeOnly(files) {
  const paths = (files ?? []).flatMap((f) => [f?.filename, f?.previous_filename].filter((p) => p !== undefined));
  if (!paths.length) return { judge: false, why: 'the change lists no files' };
  const other = paths.find((p) => typeof p !== 'string' || !JUDGE_FILES.includes(p));
  if (other !== undefined) return { judge: false, why: `${other} is not one of the judges' own files` };
  return { judge: true, review: paths.every((p) => REVIEW_FILES.includes(p)) };
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
export function judge({ sha, runs, reviewJob, review, factory, fail = null }) {
  if (fail) return { act: 'refuse', why: `the CI review FAILed this code (${fail}); a FAIL stands for this code, so push a fix` };
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
    return { act: 'refuse', why: `the CI review FAILed this code (job ${reviewJob.id}); a FAIL stands for this code` };
  const passed = reviewJob.conclusion === 'success' && step('Verdict') === 'success';
  // The judge down, as the review records it (review-marker.mjs isJudgeDown): never a cancel or an unexplained failure.
  const down =
    reviewJob.conclusion === 'success' &&
    step('Judge down') === 'success' &&
    !['success', 'failure'].includes(step('Verdict')) &&
    !['success', 'failure'].includes(step('Test verdict'));
  if (!passed && !(review && down))
    return {
      act: 'refuse',
      why: `${review ? "a change to the review's own code needs the CI review's PASS or the judge down" : "this change needs the CI review's PASS"}; job ${reviewJob.id} ended ${reviewJob.conclusion} with its Verdict ${step('Verdict') ?? 'not run'}`,
    };
  if (String(factory ?? '').trim() !== 'run') return { act: 'refuse', why: 'the factory switch does not say run' };
  return {
    act: 'pass',
    why: review
      ? `every other check is green on this head and the CI review did not FAIL it (job ${reviewJob.id}: ${passed ? 'PASS' : 'judge down'})`
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

/** Every attempt's jobs of one run, oldest attempt first. */
async function attemptsOf(repo, run, opts) {
  const out = [];
  for (let n = 1; n <= Math.max(1, Number(run.run_attempt) || 1); n++) {
    const jobs = await runJobs(`repos/${repo}/actions/runs/${run.id}/attempts/${n}/jobs`, (page) => api(page, opts));
    if (!jobs) throw new Error(`run ${run.id} attempt ${n}: no jobs list`);
    out.push(jobs);
  }
  return out;
}

const isReviewRun = (r) => r?.path === REVIEW_WORKFLOW && r?.event === 'pull_request_target';

/**
 * The CI review runs on other heads with this head's code: those the tree index names, read by id, kept when their
 * head's tree is this one. Refuses (throws) when the merge base is older than FRESH_MS, as the index may miss a FAIL.
 */
async function sameTreeRuns({ repo, sha, ...opts }) {
  const tree = (await api(`repos/${repo}/git/commits/${sha}`, opts))?.tree?.sha;
  if (!/^[0-9a-f]{40}$/.test(tree ?? '')) throw new Error(`the tree of ${sha.slice(0, 10)} could not be read`);
  const base = await api(`repos/${repo}/compare/main...${sha}?per_page=1`, opts);
  const based = Date.parse(base?.merge_base_commit?.commit?.committer?.date ?? '');
  if (!Number.isFinite(based)) throw new Error(`the merge base of ${sha.slice(0, 10)} could not be read`);
  if (based < Date.now() - FRESH_MS) return { stale: new Date(based).toISOString() };
  const named = await pages(`repos/${repo}/actions/artifacts?name=${INDEX_PREFIX}${tree}`, 'artifacts', opts);
  const runs = [];
  for (const id of new Set(named.filter((a) => a?.name === `${INDEX_PREFIX}${tree}`).map((a) => a?.workflow_run?.id))) {
    if (!Number.isSafeInteger(id)) continue;
    const run = await api(`repos/${repo}/actions/runs/${id}`, opts);
    if (!isReviewRun(run) || run.head_sha === sha) continue;
    const theirs = /^[0-9a-f]{40}$/.test(run?.head_commit?.tree_id ?? '')
      ? run.head_commit.tree_id
      : (await api(`repos/${repo}/git/commits/${run.head_sha}`, opts))?.tree?.sha;
    if (theirs === tree) runs.push(run);
  }
  return { runs };
}

/**
 * Reads the runs on the head and every attempt of the CI review's runs there, then, once the rest passes, the review's
 * runs on other heads with the same code and the switch, and judges.
 */
export async function readAndJudge({ repo, sha, pr, review, ...opts }) {
  const runs = await pages(`repos/${repo}/actions/runs?head_sha=${sha}`, 'workflow_runs', opts);
  const own = [];
  for (const run of runs.filter((r) => isReviewRun(r) && r?.head_sha === sha).sort((a, b) => Number(b.id) - Number(a.id)))
    own.push({ run, attempts: await attemptsOf(repo, run, opts) });
  // The newest run of this pull request into main (a review against another base saw another diff, review-marker.mjs
  // ciReviewVerdict), its newest attempt that ran the job (an edit's run skips it), is the head's verdict now.
  const intoMain = (r) => (r?.pull_requests ?? []).some((p) => p?.base?.ref === 'main' && String(p?.number) === String(pr));
  let reviewJob = null;
  for (const { run, attempts } of own) {
    if (!intoMain(run)) continue;
    for (const jobs of [...attempts].reverse()) if ((reviewJob = reviewJobOf(jobs))) break;
    if (reviewJob) break;
  }
  const first = judge({ sha, runs, reviewJob, review, factory: 'run', fail: standingFail(own) });
  if (first.act !== 'pass') return first;
  const other = await sameTreeRuns({ repo, sha, ...opts });
  if (other.stale)
    return { act: 'refuse', why: `the merge base with main is from ${other.stale}, older than this step reads; update the branch` };
  const theirs = [];
  for (const run of other.runs) theirs.push({ run, attempts: await attemptsOf(repo, run, opts) });
  const factory = await api(`repos/${repo}/contents/FACTORY?ref=factory-switch`, { ...opts, raw: true });
  return judge({ sha, runs, reviewJob, review, factory, fail: standingFail([...own, ...theirs]) });
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
    const v = await readAndJudge({ repo, sha, pr, review: change.review, token, fetchImpl });
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
