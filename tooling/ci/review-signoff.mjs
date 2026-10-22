#!/usr/bin/env node
/**
 * REVIEW SIGN-OFF — turns the review comment into a commit status that only a known reviewer can create
 * (workflow: review-signoff.yml, which runs from main and never checks out or runs code from a pull request).
 *
 *   issue_comment      a comment `Independent review: PASS <full head sha>` from a login in tooling/ci/reviewers.json,
 *                      for the PR's current head, becomes the success status `Independent review` on that head. A
 *                      comment from anyone else, or for another sha, does nothing.
 *   pull_request_target on a push, the sign-off of the previous head is carried to the new head when the patch is the
 *                      same (a clean rebase). Any change to the patch needs a new review.
 *
 * The status description carries `patch <12 hex>`, a hash of the changed lines (no line numbers, no context), so a
 * rebase onto a newer main keeps it and a real change does not. After a sign-off the failed `CI merge seal` job is
 * re-run, so nobody does it by hand.
 *
 *   node tooling/ci/review-signoff.mjs --self-test
 *   (CI) GH_TOKEN GITHUB_REPOSITORY GITHUB_EVENT_NAME GITHUB_EVENT_PATH node tooling/ci/review-signoff.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MARKER, STATUS_CONTEXT } from './review-marker.mjs';

const PATCH_RE = /patch ([0-9a-f]{12})/;

export function readConfig(path = new URL('./reviewers.json', import.meta.url)) {
  const c = JSON.parse(readFileSync(path, 'utf8'));
  return {
    reviewers: (c.reviewers ?? []).map((l) => String(l).toLowerCase()),
    requireDistinctFromAuthor: c.requireDistinctFromAuthor === true,
  };
}

/** The sha a review comment passes, or null. Same matcher the seal used to use. */
export function markerSha(body) {
  const m = MARKER.exec(body ?? '');
  return m ? m[1].toLowerCase() : null;
}

/** Does this comment sign off this PR's current head? Pure, so the policy table is testable. */
export function judgeComment({ commenter, body, pr }, config) {
  const login = String(commenter ?? '').toLowerCase();
  const sha = markerSha(body);
  if (!sha) return { ok: false, reason: 'no review marker' };
  if (!config.reviewers.includes(login)) return { ok: false, reason: `${commenter} is not a listed reviewer` };
  if (pr.state !== 'open') return { ok: false, reason: 'pull request is not open' };
  if (sha !== String(pr.head.sha).toLowerCase()) return { ok: false, reason: 'the marker is for another head' };
  if (config.requireDistinctFromAuthor && login === String(pr.user.login).toLowerCase()) {
    return { ok: false, reason: 'a reviewer may not sign off their own pull request' };
  }
  return { ok: true, sha, reviewer: commenter };
}

/**
 * Hash of what a pull request changes: per file section, every header line except `index` (renames, modes, the
 * `---`/`+++` names and `Binary files` lines count), then every added or removed line, with no hunk positions and no
 * context, so a clean rebase keeps it. A binary file adds its blob sha (`blobs`: path -> sha), since the diff text does
 * not show its content. Returns null when a binary file has no blob sha: nothing is carried then.
 */
export function patchId(diff, blobs = {}) {
  const h = createHash('sha1');
  let inHunk = false;
  let section = '';
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      section = (/ b\/(.*)$/.exec(line) ?? [])[1] ?? line;
      h.update(`${line}\n`);
    } else if (line.startsWith('@@')) inHunk = true;
    else if (inHunk) {
      if (/^[+\-\\]/.test(line)) h.update(`${line}\n`);
    } else if (line.startsWith('index ')) continue;
    else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      if (!blobs[section]) return null;
      h.update(`${line}\nblob ${blobs[section]}\n`);
    } else if (line) h.update(`${line}\n`);
  }
  return h.digest('hex');
}

/** Is a previous sign-off for the same patch? Returns the carried description or null. */
export function carryFrom(statuses, newPatch) {
  const prev = statuses.find((s) => s.context === STATUS_CONTEXT && s.state === 'success');
  const old = PATCH_RE.exec(prev?.description ?? '')?.[1];
  return old && old === newPatch.slice(0, 12) ? prev : null;
}

// ── GitHub API ────────────────────────────────────────────────────────────
async function gh(method, path, body, accept = 'application/vnd.github+json') {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 403 || res.status === 429) throw new Error(`GitHub ${res.status} on ${method} ${path}: stopping, not retrying`);
  const text = await res.text();
  const json = accept.includes('json') && text ? JSON.parse(text) : null;
  return { status: res.status, json, text };
}

async function prFileList(repo, n) {
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const { json } = await gh('GET', `/repos/${repo}/pulls/${n}/files?per_page=100&page=${page}`);
    files.push(...(json ?? []));
    if ((json ?? []).length < 100) break;
  }
  return files;
}

async function currentPatchId(repo, n, sha) {
  const r = await gh('GET', `/repos/${repo}/pulls/${n}`, undefined, 'application/vnd.github.v3.diff');
  if (r.status !== 200 || !r.text) return null; // too large or unavailable: nothing is carried
  const blobs = {};
  if (/^(Binary files |GIT binary patch)/m.test(r.text)) for (const f of await prFileList(repo, n)) blobs[f.filename] = f.sha;
  const id = patchId(r.text, blobs);
  // The diff is of whatever the head was when it was fetched; a push in between would put another patch's id on this sha.
  const after = (await gh('GET', `/repos/${repo}/pulls/${n}`)).json;
  return after?.head?.sha === sha ? id : null;
}

async function postStatus(repo, sha, description) {
  const r = await gh('POST', `/repos/${repo}/statuses/${sha}`, {
    state: 'success',
    context: STATUS_CONTEXT,
    description: description.slice(0, 140),
  });
  if (r.status !== 201) throw new Error(`could not post the status: HTTP ${r.status}`);
}

const SEAL = 'CI merge seal';
const SEAL_POLL_MS = 20_000;
const SEAL_POLLS = 12; // 4 minutes, inside the job's timeout

/**
 * What to do about the seal after a sign-off, from the seal's check runs on the head and the state of the CI run that
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
  if (runStatus === undefined) return { act: 'run', runId };
  if (runStatus !== 'completed') return { act: 'wait', msg: `run ${runId} is still finishing`, runId };
  return { act: 'rerun', runId };
}

/**
 * Re-run the CI merge seal if it already finished red on this head, so nobody re-runs it by hand. Anything that
 * stops it from finding or re-running a red seal fails this job, so the PR shows a red sign-off instead of staying
 * stuck in silence.
 */
async function rerunSeal(repo, sha, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  for (let poll = 1; ; poll++) {
    const c = await gh('GET', `/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(SEAL)}&filter=all&per_page=100`);
    if (c.status !== 200) throw new Error(`could not read the seal's check runs: HTTP ${c.status}`);
    let step = sealStep(c.json?.check_runs, undefined);
    if (step.act === 'run') {
      const r = await gh('GET', `/repos/${repo}/actions/runs/${step.runId}`);
      if (r.status !== 200) throw new Error(`could not read CI run ${step.runId}: HTTP ${r.status}`);
      step = sealStep(c.json.check_runs, r.json?.status);
    }
    if (step.act === 'done') return step.msg;
    if (step.act === 'fail') throw new Error(step.msg);
    if (step.act === 'rerun') {
      const r = await gh('POST', `/repos/${repo}/actions/runs/${step.runId}/rerun-failed-jobs`);
      if (r.status !== 201) throw new Error(`could not re-run the failed jobs of run ${step.runId}: HTTP ${r.status}`);
      return `re-ran the failed jobs of run ${step.runId}`;
    }
    if (poll >= SEAL_POLLS)
      throw new Error(`${step.msg} after ${(SEAL_POLLS * SEAL_POLL_MS) / 60_000} min; re-run the seal once it finishes`);
    console.log(`${step.msg}; checking again in ${SEAL_POLL_MS / 1000}s`);
    await sleep(SEAL_POLL_MS);
  }
}

function selfTest() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  const head = 'a'.repeat(40);
  const cfg = { reviewers: ['nino', 'phantom'], requireDistinctFromAuthor: false };
  const pr = { state: 'open', head: { sha: head }, user: { login: 'nino' } };
  const body = `Independent review: PASS ${head}`;
  assert(judgeComment({ commenter: 'Nino', body, pr }, cfg).ok, 'a listed reviewer, current head, passes (case-insensitive)');
  assert(!judgeComment({ commenter: 'stranger', body, pr }, cfg).ok, 'a stranger cannot sign off');
  assert(!judgeComment({ commenter: 'nino', body: `Independent review: PASS ${'b'.repeat(40)}`, pr }, cfg).ok, 'another head is refused');
  assert(!judgeComment({ commenter: 'nino', body: 'looks good', pr }, cfg).ok, 'a comment without the marker is ignored');
  assert(
    !judgeComment({ commenter: 'nino', body: `Independent review: PASS ${head} but not really`, pr }, cfg).ok,
    'trailing text voids the marker',
  );
  assert(!judgeComment({ commenter: 'nino', body, pr: { ...pr, state: 'closed' } }, cfg).ok, 'a closed PR is refused');
  const strict = { ...cfg, requireDistinctFromAuthor: true };
  assert(!judgeComment({ commenter: 'nino', body, pr }, strict).ok, 'the author may not review their own PR when distinctness is on');
  assert(judgeComment({ commenter: 'phantom', body, pr }, strict).ok, 'another listed reviewer may');

  const d1 = 'diff --git a/x.ts b/x.ts\nindex 111..222 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n ctx\n-old\n+new\n';
  const d2 = 'diff --git a/x.ts b/x.ts\nindex 333..444 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -40,3 +52,3 @@\n other ctx\n-old\n+new\n';
  const d3 = d1.replace('+new', '+newer');
  assert(patchId(d1) === patchId(d2), 'a clean rebase (new line numbers, context, index) keeps the patch id');
  assert(patchId(d1) !== patchId(d3), 'a changed line changes the patch id');
  assert(patchId(d1) !== patchId(d1.replace('x.ts', 'y.ts')), 'a different file changes the patch id');

  const section = (extra) => `diff --git a/s.sh b/s.sh\n${extra}`;
  const base0 = patchId(section(''));
  assert(base0 !== patchId(section('old mode 100644\nnew mode 100755\n')), 'a mode change changes the patch id');
  const mv = (to) => `diff --git a/old.ts b/${to}\nsimilarity index 100%\nrename from old.ts\nrename to ${to}\n`;
  assert(patchId(mv('a/x.ts')) !== patchId(mv('evil/x.ts')), 'a pure rename to another path changes the patch id');
  const hunk = (body) => `diff --git a/c.ts b/c.ts\nindex 1..2 100644\n--- a/c.ts\n+++ b/c.ts\n@@ -1 +1 @@\n${body}`;
  assert(patchId(hunk('+x\n')) !== patchId(hunk('+x \n')), 'trailing whitespace counts');
  assert(patchId(hunk('+x\n')) !== patchId(hunk('+x\r\n')), 'a line-ending change counts');
  assert(patchId(hunk('+x\n')) !== patchId(hunk('+x\n+++i;\n')), 'an added "++i;" line counts');
  assert(patchId(hunk('-x\n')) !== patchId(hunk('-x\n---j;\n')), 'a removed "--j;" line counts');
  assert(
    patchId(hunk(' c\n+x\n')) === patchId(hunk(' other\n+x\n').replace('@@ -1 +1 @@', '@@ -9 +9 @@')),
    'context and hunk positions do not count',
  );
  const bin = 'diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n';
  assert(patchId(bin, {}) === null, 'a binary file without a blob sha is not carried');
  assert(patchId(bin, { 'i.png': 'aaa' }) !== patchId(bin, { 'i.png': 'bbb' }), 'a swapped binary changes the patch id');

  const p = patchId(d1).slice(0, 12);
  const prev = { context: STATUS_CONTEXT, state: 'success', description: `PASS by nino; patch ${p}` };
  assert(carryFrom([prev], patchId(d2)) === prev, 'same patch carries');
  assert(carryFrom([prev], patchId(d3)) === null, 'changed patch does not carry');
  assert(carryFrom([{ ...prev, state: 'failure' }], patchId(d2)) === null, 'only a success carries');
  assert(carryFrom([], patchId(d2)) === null, 'nothing to carry');

  const run = (over) => ({
    id: 2,
    name: SEAL,
    status: 'completed',
    conclusion: 'failure',
    details_url: 'https://github.com/o/r/actions/runs/77/job/2',
    ...over,
  });
  assert(sealStep([], undefined).act === 'done', 'no seal yet: it will read the review itself');
  assert(sealStep([run({ status: 'queued', conclusion: null })], undefined).act === 'done', 'a queued seal reads the review itself');
  assert(
    sealStep([run({ status: 'in_progress', conclusion: null })], undefined).act === 'wait',
    'a running seal may have read too early: wait',
  );
  assert(sealStep([run({ conclusion: 'success' })], undefined).act === 'done', 'a green seal needs nothing');
  assert(sealStep([run()], undefined).act === 'run' && sealStep([run()], undefined).runId === '77', 'a red seal names its run');
  assert(sealStep([run()], 'in_progress').act === 'wait', 'a red seal whose run is still finishing: wait');
  assert(sealStep([run()], 'completed').act === 'rerun', 'a red seal in a finished run is re-run');
  assert(sealStep([run({ details_url: '' })], 'completed').act === 'fail', 'a red seal without a run is an error, not silence');
  assert(
    sealStep([run({ id: 1, conclusion: 'success' }), run({ id: 3 })], 'completed').act === 'rerun' &&
      sealStep([run({ id: 3, conclusion: 'success' }), run({ id: 1 })], 'completed').act === 'done',
    'the newest seal check run decides',
  );
  assert(sealStep([run({ name: 'Format' })], undefined).act === 'done', 'other checks are ignored');

  assert(readConfig().reviewers.length > 0, 'reviewers.json lists at least one reviewer');
  console.log('✓ review-signoff --self-test OK');
}

async function main() {
  const { GITHUB_REPOSITORY: repo, GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: path } = process.env;
  const payload = JSON.parse(readFileSync(path, 'utf8'));
  const config = readConfig();

  if (event === 'issue_comment') {
    if (!payload.issue?.pull_request || payload.action !== 'created') return console.log('not a new comment on a pull request');
    const n = payload.issue.number;
    const pr = (await gh('GET', `/repos/${repo}/pulls/${n}`)).json;
    const verdict = judgeComment({ commenter: payload.comment.user.login, body: payload.comment.body, pr }, config);
    if (!verdict.ok) return console.log(`no sign-off: ${verdict.reason}`);
    const pid = await currentPatchId(repo, n, verdict.sha);
    await postStatus(repo, verdict.sha, `PASS by ${verdict.reviewer}${pid ? `; patch ${pid.slice(0, 12)}` : ''}`);
    console.log(`signed off ${verdict.sha} for #${n} (${verdict.reviewer})`);
    console.log(await rerunSeal(repo, verdict.sha));
    return;
  }

  if (event === 'pull_request_target') {
    const n = payload.pull_request.number;
    const pr = (await gh('GET', `/repos/${repo}/pulls/${n}`)).json;
    if (payload.action === 'synchronize' && payload.before) {
      const { json } = await gh('GET', `/repos/${repo}/commits/${payload.before}/statuses?per_page=100`);
      const pid = await currentPatchId(repo, n, pr.head.sha);
      const prev = pid ? carryFrom(json ?? [], pid) : null;
      if (prev) {
        await postStatus(
          repo,
          pr.head.sha,
          `${prev.description.split(';')[0]}; carried from ${payload.before.slice(0, 7)}; patch ${pid.slice(0, 12)}`,
        );
        console.log(`carried the sign-off from ${payload.before.slice(0, 7)} to ${pr.head.sha.slice(0, 7)} (same patch)`);
        console.log(await rerunSeal(repo, pr.head.sha));
      } else console.log('no sign-off to carry (none, or the patch changed)');
    }
  }
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`✖ review-signoff: ${e.message}`);
    process.exit(1);
  });
}
