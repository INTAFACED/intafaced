#!/usr/bin/env node
/**
 * REVIEW SIGN-OFF — turns the review comment into a commit status that only a known reviewer can create
 * (workflow: review-signoff.yml, which runs from main and never checks out or runs code from a pull request).
 *
 *   issue_comment      a comment `Independent review: PASS <full head sha>` from a login in tooling/ci/reviewers.json,
 *                      for the PR's current head, becomes the success status `Independent review` on that head. A
 *                      comment from anyone else, for another sha, or naming a session on the PR's session-trailer
 *                      commit lines (its author's own session, OWNER 124 (4)) does nothing.
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
import { MARKER, STATUS_CONTEXT, sessionRefusal, sessionsForHead } from './review-marker.mjs';

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

/**
 * Does this comment sign off this PR's current head? Pure, so the policy table is testable. `authorSessions` are the
 * sessions on the PR's session-trailer commit lines, or null when they could not all be read (then nothing signs off).
 */
export function judgeComment({ commenter, body, pr, authorSessions = null }, config) {
  const login = String(commenter ?? '').toLowerCase();
  const sha = markerSha(body);
  if (!sha) return { ok: false, reason: 'no review marker' };
  if (!config.reviewers.includes(login)) return { ok: false, reason: `${commenter} is not a listed reviewer` };
  if (pr.state !== 'open') return { ok: false, reason: 'pull request is not open' };
  if (sha !== String(pr.head.sha).toLowerCase()) return { ok: false, reason: 'the marker is for another head' };
  if (config.requireDistinctFromAuthor && login === String(pr.user.login).toLowerCase()) {
    return { ok: false, reason: 'a reviewer may not sign off their own pull request' };
  }
  const refusal = sessionRefusal(body, authorSessions);
  if (refusal) return { ok: false, reason: refusal };
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

/** The sessions on the PR's session-trailer commit lines, or null when they cannot be read whole for this head. */
async function prAuthorSessions(repo, n, sha) {
  const commits = [];
  for (let page = 1; page <= 3; page++) {
    const { status, json } = await gh('GET', `/repos/${repo}/pulls/${n}/commits?per_page=100&page=${page}`);
    if (status !== 200) return null;
    commits.push(...(json ?? []));
    if ((json ?? []).length < 100) break;
  }
  return sessionsForHead(commits, sha);
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
const SEAL_POLLS = 12; // 4 minutes; review-signoff.yml's timeout leaves room to post the red status after it
const RERUN_CONTEXT = 'Seal re-run';

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
  if (runStatus === undefined) return { act: 'run', msg: `reading run ${runId}`, runId };
  if (runStatus !== 'completed') return { act: 'wait', msg: `run ${runId} is still finishing`, runId };
  return { act: 'rerun', runId };
}

/**
 * Re-run the CI merge seal if it already finished red on this head, so nobody re-runs it by hand. Throws when it
 * cannot find or re-run a red seal; `rerunSealOrFlag` turns that into a status on the PR.
 */
export async function rerunSeal(repo, sha, { api = gh, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log } = {}) {
  for (let poll = 1; ; poll++) {
    const c = await api('GET', `/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(SEAL)}&filter=all&per_page=100`);
    if (c.status !== 200) throw new Error(`could not read the seal's check runs: HTTP ${c.status}`);
    let step = sealStep(c.json?.check_runs, undefined);
    if (step.act === 'run') {
      const r = await api('GET', `/repos/${repo}/actions/runs/${step.runId}`);
      if (r.status !== 200) throw new Error(`could not read CI run ${step.runId}: HTTP ${r.status}`);
      step = sealStep(c.json.check_runs, r.json?.status);
    }
    if (step.act === 'done') return step.msg;
    if (step.act === 'fail') throw new Error(step.msg);
    if (step.act === 'rerun') {
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

/**
 * The sign-off status is already green when this runs, so a seal it could not re-run gets its own red status on the
 * PR. A later sign-off that finds the seal green or re-runs it clears that red status, and only then: a PR that never
 * had one gets no extra status.
 */
async function rerunSealOrFlag(repo, sha) {
  let outcome;
  try {
    outcome = await rerunSeal(repo, sha);
  } catch (e) {
    await gh('POST', `/repos/${repo}/statuses/${sha}`, {
      state: 'failure',
      context: RERUN_CONTEXT,
      description: `Review signed off, seal not re-run: ${e.message}. Re-run the seal's failed jobs.`.slice(0, 140),
    }).catch(() => {});
    throw e;
  }
  console.log(outcome);
  const { json } = await gh('GET', `/repos/${repo}/commits/${sha}/statuses?per_page=100`);
  if ((Array.isArray(json) ? json : []).find((s) => s.context === RERUN_CONTEXT)?.state === 'failure') {
    await gh('POST', `/repos/${repo}/statuses/${sha}`, { state: 'success', context: RERUN_CONTEXT, description: outcome.slice(0, 140) });
  }
}

async function selfTest() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  const head = 'a'.repeat(40);
  const cfg = { reviewers: ['nino', 'phantom'], requireDistinctFromAuthor: false };
  const pr = { state: 'open', head: { sha: head }, user: { login: 'nino' } };
  const none = new Set();
  const body = `Independent review: PASS ${head}`;
  assert(
    judgeComment({ commenter: 'Nino', body, pr, authorSessions: none }, cfg).ok,
    'a listed reviewer, current head, passes (case-insensitive)',
  );
  assert(!judgeComment({ commenter: 'stranger', body, pr, authorSessions: none }, cfg).ok, 'a stranger cannot sign off');
  assert(
    !judgeComment({ commenter: 'nino', body: `Independent review: PASS ${'b'.repeat(40)}`, pr, authorSessions: none }, cfg).ok,
    'another head is refused',
  );
  assert(
    !judgeComment({ commenter: 'nino', body: 'looks good', pr, authorSessions: none }, cfg).ok,
    'a comment without the marker is ignored',
  );
  assert(
    !judgeComment({ commenter: 'nino', body: `Independent review: PASS ${head} but not really`, pr, authorSessions: none }, cfg).ok,
    'trailing text voids the marker',
  );
  assert(
    !judgeComment({ commenter: 'nino', body, pr: { ...pr, state: 'closed' }, authorSessions: none }, cfg).ok,
    'a closed PR is refused',
  );
  const strict = { ...cfg, requireDistinctFromAuthor: true };
  assert(
    !judgeComment({ commenter: 'nino', body, pr, authorSessions: none }, strict).ok,
    'the author may not review their own PR when distinctness is on',
  );
  assert(judgeComment({ commenter: 'phantom', body, pr, authorSessions: none }, strict).ok, 'another listed reviewer may');
  const own = new Set(['session_A1']);
  const named = (s) => `${body}\nReviewer session: https://example.test/code/${s}`;
  assert(judgeComment({ commenter: 'nino', body: named('session_R1'), pr, authorSessions: own }, cfg).ok, 'another session may sign off');
  assert(
    !judgeComment({ commenter: 'nino', body: named('session_A1'), pr, authorSessions: own }, cfg).ok,
    "a PASS naming the PR's own session does not count",
  );
  assert(
    !judgeComment({ commenter: 'nino', body: named('session_R1'), pr, authorSessions: null }, cfg).ok,
    'commits that cannot be read: nothing signs off',
  );

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

  // The loop, against a scripted API: each call takes the next answer for its path.
  const fake = (answers) => {
    const calls = [];
    const api = async (method, path) => {
      calls.push(`${method} ${path.replace(/\?.*/, '')}`);
      const key = Object.keys(answers).find((k) => `${method} ${path}`.includes(k));
      const a = answers[key];
      return Array.isArray(a) ? a.shift() : a;
    };
    return { api, calls, opts: { api, sleep: async () => {}, log: () => {} } };
  };
  const cr = (...runs) => ({ status: 200, json: { check_runs: runs } });
  const running = run({ status: 'in_progress', conclusion: null });
  let f = fake({
    'check-runs': [cr(running), cr(running), cr(run())],
    'GET /repos/o/r/actions/runs/77': { status: 200, json: { status: 'completed' } },
    'rerun-failed-jobs': { status: 201 },
  });
  assert((await rerunSeal('o/r', head, f.opts)) === 're-ran the failed jobs of run 77', 'waits out a running seal, then re-runs it red');
  assert(f.calls.filter((c) => c.includes('rerun')).length === 1, 'one re-run');
  f = fake({
    'check-runs': cr(run()),
    'GET /repos/o/r/actions/runs/77': { status: 200, json: { status: 'completed' } },
    'rerun-failed-jobs': { status: 403 },
  });
  assert((await rerunSeal('o/r', head, f.opts)) === 'run 77 is already re-running', 'someone else re-ran it first');
  const rejects = async (p, msg) => {
    let threw = false;
    await p.catch(() => (threw = true));
    assert(threw, msg);
  };
  await rejects(rerunSeal('o/r', head, fake({ 'check-runs': cr(running) }).opts), 'a seal that never finishes fails the job');
  await rejects(rerunSeal('o/r', head, fake({ 'check-runs': { status: 404, json: {} } }).opts), 'an unreadable check list fails the job');
  await rejects(
    rerunSeal(
      'o/r',
      head,
      fake({
        'check-runs': cr(run()),
        'GET /repos/o/r/actions/runs/77': { status: 200, json: { status: 'completed' } },
        'rerun-failed-jobs': { status: 500 },
      }).opts,
    ),
    'a refused re-run fails the job',
  );
  f = fake({ 'check-runs': cr(run({ conclusion: 'success' })) });
  assert(
    (await rerunSeal('o/r', head, f.opts)) === 'the seal is already green' && f.calls.length === 1,
    'a green seal: one read, nothing else',
  );

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
    const authorSessions = await prAuthorSessions(repo, n, pr.head.sha);
    const verdict = judgeComment({ commenter: payload.comment.user.login, body: payload.comment.body, pr, authorSessions }, config);
    if (!verdict.ok) return console.log(`no sign-off: ${verdict.reason}`);
    const pid = await currentPatchId(repo, n, verdict.sha);
    await postStatus(repo, verdict.sha, `PASS by ${verdict.reviewer}${pid ? `; patch ${pid.slice(0, 12)}` : ''}`);
    console.log(`signed off ${verdict.sha} for #${n} (${verdict.reviewer})`);
    await rerunSealOrFlag(repo, verdict.sha);
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
        await rerunSealOrFlag(repo, pr.head.sha);
      } else console.log('no sign-off to carry (none, or the patch changed)');
    }
  }
}

if (process.argv.includes('--self-test')) {
  selfTest().catch((e) => {
    console.error(`✖ review-signoff --self-test: ${e.message}`);
    process.exit(1);
  });
} else if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`✖ review-signoff: ${e.message}`);
    process.exit(1);
  });
}
