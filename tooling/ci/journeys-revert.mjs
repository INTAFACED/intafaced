#!/usr/bin/env node
/**
 * JOURNEYS REVERT: when main's Real-app journeys turn red, find the one merged pull request that did it and open its
 * revert (workflow: main-bisect.yml, the `Journeys revert` jobs). OWNER 249 (3): "a red main is reverted".
 *
 *   trigger  Main trust's post-merge job, after a Real-app journeys run on main: a step that passed in the run before
 *            and failed outright (every try on this commit, so never a pass on its retry) in this one. It dispatches the
 *            revert jobs at once, with the commit that passed, this one, this run and the broken steps. Waiting for the
 *            next full run as well cost a run of 40 to 55 minutes out of OWNER 180's 2 hours (bisect run 14: the revert
 *            opened 72 minutes after the first red finished). A flaky step never counts: the verdict sets it aside.
 *            A step new to main (absent from the run before) that fails outright on its first run, in a journey file
 *            the commits between the two runs added or changed, is reverted the same way (revertSteps' `changed`).
 *   early    Main's own journeys run, beside its shards (real-app-journeys.yml `early-break`): reads each shard's report as
 *            its job ends and, on a step that passed in the run before and failed outright in that shard, starts the same
 *            revert jobs at once, before the other shards and the whole run end (plant 1, project-state #2065: its failing
 *            shard ended 7 minutes before its run). `trigger` at the run's end starts nothing a run already started.
 *   confirm  After a revert this opened merges (journeys-back.yml, on the push): starts main-bisect.yml's `confirm` job,
 *            which runs the failing journeys alone on main's head in their own group, so the break shows as back in one
 *            journey's time instead of behind main's queue and a full run. Main's full run still runs to its end. A
 *            main journeys run still going on a commit that holds the culprit and not the revert is cancelled, so the
 *            full run on the revert's head starts at once (plant 2: it waited 39 minutes behind such a run).
 *   back     The `confirm` job's result on each journey's break issue. It closes nothing: main trust closes the issue
 *            when main's full run passes the steps.
 *   find     The commits between the good and the bad commit (first parent, oldest first). The red run must show the
 *            named steps failing outright on the bad commit, or nothing is reverted (a known-good state opens nothing).
 *            Only the commits whose changed files can reach a failing journey (journey-touch.mjs with the
 *            touched-journeys map: a full-suite path or a failing journey's file) stay, one commit in the range included.
 *            None left: no commit is blamed. Any left, even one: the probe job runs the failing journey files on them on a
 *            fresh stack (journeys-revert-probe.mjs) and blames only a commit where they fail there. A first red can be
 *            the stack's: of 23 main runs read on 11 Nov 2026 it fired on 4, and 2 cleared in the next run (3465, 3810).
 *            Run 3810's only reaching commit was an innocent one (#7275), so a lone candidate is probed too.
 *   open     With an App token (FACTORY_APP_KEY, the `factory` environment: main only), so the revert's own CI and
 *            merge seal run: a branch `revert/auto-<sha10>` from the base holding `git revert <culprit>`, a pull request
 *            naming the red run, the failing steps and the culprit's pull request, squash auto-merge armed, and a
 *            comment on the culprit's pull request. The token is never printed and is revoked when it ends.
 *
 * Never more than one pull request reverted per red. Never a revert of a revert (a subject starting `Revert`, or a
 * pull request from a revert/ branch). Never a push to the base: the revert goes through the normal seal. A revert that
 * doesn't apply cleanly, a merge commit, or a culprit that changed .github/workflows (the App token has no workflows
 * permission) gets a comment, not a pull request. A revert branch that already exists is left alone.
 *
 *   DRY_RUN=1: reads for real, prints each write instead of sending it
 *   (trigger) GH_TOKEN GITHUB_REPOSITORY WORKFLOW_ID RUN_ID HEAD_SHA
 *   (find)    GH_TOKEN GITHUB_REPOSITORY GOOD BAD STEPS RED_RUN BASE   (writes GITHUB_OUTPUT)
 *   (open)    FACTORY_APP_KEY GITHUB_REPOSITORY CULPRIT BASE RED_RUN STEPS
 *   (early)   GH_TOKEN GITHUB_REPOSITORY WORKFLOW_ID RUN_ID HEAD_SHA
 *   (confirm) GH_TOKEN GITHUB_REPOSITORY HEAD_SHA SUBJECT
 *   (back)    GH_TOKEN GITHUB_REPOSITORY STEPS BAD BACK RUN_URL;  (confirm-files) STEPS BAD   (writes GITHUB_OUTPUT)
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JOURNEYS_ARTIFACT, JOURNEYS_WORKFLOW, stepStates } from './post-merge-trust.mjs';
import { journeyTouch } from './journey-touch.mjs';
import { SUBSCRIBES, loadMap, runsBehind } from './journey-reach-map.mjs';
import { gateFilesTouched } from '../scripts/gate-files.mjs';
import { parseJobs, parseTests } from './bisect-main.mjs';
import { AUTO_REVERT_AUTHOR, AUTO_REVERT_BRANCH } from './exact-revert.mjs';
import { moneyGuardAt } from './journey-verdict.mjs';

const SHA = /^[0-9a-f]{40}$/;
const STEP = /^J-[a-z0-9-]+-\d+#\d+$/;
const STEP_TITLE = /^(J-[a-z0-9-]+-\d+)\s+#(\d+)\b/;
const BASE = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._/-]{1,200}$/;
export const REAL_APP = 'apps/customer/tests/real-app/';
/** The artifact real-app-journeys.yml keeps a push run's leave-out list in ("Keep the leave-out list"). */
export const LEAVE_OUT_ARTIFACT = 'real-app-journeys-leave-out';
export const MAX_COMMITS = 200;
export const BRANCH_PREFIX = 'revert/auto-';
/** The App token `open` writes with: intafaced only, never workflows. */
export const REVERT_TOKEN = { repositories: ['intafaced'], permissions: { contents: 'write', pull_requests: 'write' } };

// ── Pure parts ─────────────────────────────────────────────────────────────

/** Steps that failed outright in a Playwright report: a test of the step ended "unexpected" (failed every try). A
 *  step that passed only on its retry ("flaky") is not here. Returns Map key -> journey file. */
export function outrightFailures(report) {
  const out = new Map();
  const walk = (suite, file) => {
    const f = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      const m = STEP_TITLE.exec(spec.title ?? '');
      if (!m) continue;
      if ((spec.tests ?? []).some((t) => t.status === 'unexpected'))
        out.set(
          `${m[1]}#${Number(m[2])}`,
          String(spec.file ?? f ?? '')
            .split('/')
            .pop(),
        );
    }
    for (const child of suite.suites ?? []) walk(child, f);
  };
  for (const suite of report?.suites ?? []) walk(suite, suite.file);
  return out;
}

/** The outright state of each step: 'failed' when it failed outright, else what stepStates says, with 'failed' from a
 *  pass on the retry turned into 'flaky' (neither a pass nor a break). */
export function outrightStates(report) {
  const states = stepStates(report);
  const failed = outrightFailures(report);
  for (const [k, v] of states) if (v === 'failed' && !failed.has(k)) states.set(k, 'flaky');
  return states;
}

/** The steps to revert for, from the two newest runs' reports (oldest first): passed in `previous`, failed outright in
 *  `now`. Sorted. A step red in `previous` as well started its revert a run ago, so it never starts another.
 *  `changed` (the journey file names the commits between the two runs added or changed, or null): a step absent from
 *  `previous` that fails outright in `now`, in one of those files, is new to main and broke on its first run, so it takes
 *  the same revert; its culprit is the merge that brought it (14 Nov 2026: J-algo-dev-04 #3, new in #8371, failed on
 *  main's first run that held it and nothing started, as it had never passed before). A step that never passed in a file
 *  no commit between the runs touched is not reverted. */
export function revertSteps(previous, now, changed = null, leftOut = new Set()) {
  const before = stepStates(previous);
  // A step the run before left out (journey-leave-out.mjs) was left out because it is unbuilt and failed in a recent run
  // on main: it counts as red there, as it would have been had it run. It is not new to main (15 Nov 2026, #8535:
  // J-agents-18 #5, red by name since #6990, was left out of run 43735359940; #8518 changed its file, so it ran again,
  // failed as it always does, and was taken for a new step that broke).
  for (const key of leftOut) if (!before.has(key)) before.set(key, 'failed');
  const failed = outrightFailures(now);
  return [...outrightStates(now)]
    .filter(([key, state]) => state === 'failed' && (before.get(key) === 'passed' || (!before.has(key) && changed?.has(failed.get(key)))))
    .map(([key]) => key)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/** The step keys a run's leave-out list (journey-leave-out.mjs testListText: `file › describe › title`, one per line)
 *  names. Pure. */
export function leftOutSteps(text) {
  const out = new Set();
  for (const line of String(text ?? '').split('\n')) {
    const m = STEP_TITLE.exec(line.split(' › ').at(-1)?.trim() ?? '');
    if (m) out.add(`${m[1]}#${Number(m[2])}`);
  }
  return out;
}

/** The journey file names (`J-x.pw.mjs`) among a compare's changed paths, added, changed or renamed to. Pure. */
export function journeyFilesChanged(files) {
  return new Set(
    (files ?? [])
      .filter((f) => f?.status !== 'removed')
      .map((f) => String(f?.filename ?? ''))
      .filter((f) => f.startsWith(REAL_APP) && f.endsWith('.pw.mjs'))
      .map((f) => f.split('/').pop()),
  );
}

export function parseSteps(text) {
  const steps = [
    ...new Set(
      String(text ?? '')
        .split(/[\s,]+/)
        .filter(Boolean),
    ),
  ];
  const bad = steps.filter((s) => !STEP.test(s));
  if (bad.length) throw new Error(`not a journey step (J-x-01#2): ${bad.join(', ')}`);
  return steps.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/** Whether a commit's changed paths can reach any of the failing journey files. */
export function commitReaches(paths, failingFiles, reach, atHead) {
  const t = journeyTouch(paths, atHead, reach);
  if (t.mode === 'full') return { reaches: true, why: t.full[0] ? `${t.full[0].path}: ${t.full[0].why}` : 'full' };
  const hit = t.files.filter((f) => failingFiles.includes(f));
  return hit.length
    ? { reaches: true, why: `reaches ${hit.join(', ')}` }
    : { reaches: false, why: `${t.mode}: ${t.files.join(', ') || 'no journey'}` };
}

/**
 * What the commits (oldest first) leave: { none: why } | { probe: [sha] }, never a culprit unproven. `reachOf(sha)` says
 * whether that commit can reach a failing journey.
 */
export function narrow(commits, reachOf) {
  if (!commits.length) return { none: 'no commit lies between the good and the bad commit, so no commit broke it' };
  const lines = [];
  const kept = [];
  for (const sha of commits) {
    const r = reachOf(sha);
    lines.push(`\`${sha.slice(0, 10)}\`: ${r.reaches ? 'kept' : 'cannot reach the failing journeys'} (${r.why})`);
    if (r.reaches) kept.push(sha);
  }
  if (!kept.length) return { none: 'no commit in the range can reach the failing journeys', lines };
  return { probe: kept, lines };
}

/** The pull request number a squash commit's subject ends with, `(#123)`, or null. */
export const subjectPr = (subject) => Number(/\(#(\d+)\)\s*$/.exec(String(subject ?? ''))?.[1]) || null;

/** Why a commit must not be reverted automatically, or null. */
export function refuseRevert({ subject, parents, files, pr }) {
  if (/^revert\b/i.test(String(subject ?? '').trim())) return 'it is itself a revert, and a revert is never reverted automatically';
  if (pr?.head?.ref?.startsWith('revert/')) return `its pull request #${pr.number} came from a revert branch`;
  if (parents !== 1) return `it has ${parents} parents (a merge commit), and only a squash commit is reverted automatically`;
  if (files.some((f) => f.startsWith('.github/workflows/')))
    return 'it changed .github/workflows, which the revert token may not push; revert it by hand';
  return null;
}

export const revertBranch = (sha) => `${BRANCH_PREFIX}${sha.slice(0, 10)}`;

/** The revert pull request's title: no journey steps in it (the seal would hold the revert to steps the culprit added). */
export function revertTitle({ prNumber, sha, files, redRun, kind = 'journeys' }) {
  const what = prNumber ? `#${prNumber}` : `\`${sha.slice(0, 10)}\``;
  const base = `Revert ${what}, which turned ${kind === 'ci' ? "main's CI" : 'the Real-app journeys'} red (run ${redRun})`;
  return gateFilesTouched(files).length ? `ci: ${base.charAt(0).toLowerCase()}${base.slice(1)}` : base;
}

export function revertBody({ repo, sha, subject, prNumber, redRun, steps, base, failing, control = null }) {
  return [
    `Automatic revert by the revert on main (tooling/ci/journeys-revert.mjs, OWNER 249 (3): "a red main is reverted").`,
    '',
    `- Red run: https://github.com/${repo}/actions/runs/${redRun} on \`${base}\``,
    `- Failing: ${failing ?? steps.map((s) => `\`${s.replace('#', ' #')}\``).join(', ')}`,
    `- Culprit: ${prNumber ? `#${prNumber}` : 'no pull request found'}, commit \`${sha.slice(0, 10)}\` ${subject}`,
    ...(control
      ? [`- Control: \`${control.slice(0, 10)}\`, the last commit where these steps passed, passes again on the same kind of runner`]
      : []),
    '',
    `The commit was found between the last run where these steps passed and the run where they failed. This pull request is \`git revert ${sha.slice(0, 10)}\` and nothing else; it goes through the CI merge seal like any other. To keep the change instead, fix it forward and close this.`,
    '',
    `Revert: close this pull request; the culprit stays on \`${base}\`.`,
  ].join('\n');
}

// ── GitHub ─────────────────────────────────────────────────────────────────

const API = 'https://api.github.com';
function client(token) {
  return async (method, path, body) => {
    if (process.env.DRY_RUN === '1' && method !== 'GET' && !path.endsWith('/access_tokens')) {
      console.log(`DRY_RUN ${method} ${path}${body ? `\n${JSON.stringify(body, null, 2)}` : ''}`);
      return { status: 0, json: null };
    }
    const res = await fetch(path.startsWith('https://') ? path : `${API}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    // AGENTS.md: a 403 or 429 from GitHub is a stop. No retry, no loop.
    if (res.status === 403 || res.status === 429)
      throw new Error(`GitHub ${res.status} on ${method} ${path.split('?')[0]}: stopping, not retrying`);
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, json };
  };
}

/** The shard number in a shard job's or artifact's name, or null. Pure. */
export const shardOf = (name) =>
  Number(
    /^(?:Journeys \(shard (\d+) of \d+\)|real-app-journeys-shard-(\d+))$/
      .exec(String(name ?? ''))
      ?.slice(1)
      .find(Boolean),
  ) || null;

/** One report from several shards' reports: their suites side by side. Pure. */
export const joinReports = (reports) => ({ suites: reports.flatMap((r) => r?.suites ?? []) });

/** A JSON file of a run's journeys artifact, or null when it kept none. `partial` (a run still going): the reports its
 *  finished shards kept (real-app-journeys-shard-<n>), joined, when the run's own report is not there yet; `shards`
 *  reads only those shards' reports. */
async function runReport(gh, repo, runId, token, { partial = false, shards = null } = {}) {
  const { json } = await gh('GET', `/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`);
  const live = (json?.artifacts ?? []).filter((a) => !a.expired);
  const artifact = shards ? null : live.find((a) => a.name === JOURNEYS_ARTIFACT);
  if (artifact) return artifactReport(artifact, runId, token);
  if (!partial && !shards) return null;
  const parts = live.filter((a) => shardOf(a.name) && (!shards || shards.includes(shardOf(a.name))));
  if (!parts.length) return null;
  const reports = [];
  for (const a of parts) reports.push(await artifactReport(a, runId, token));
  return reports.some(Boolean) ? joinReports(reports.filter(Boolean)) : null;
}

/** The step keys run `runId` left out (its `real-app-journeys-leave-out` artifact), or an empty set when it kept none: a
 *  run that left nothing out, or one before the list was kept. */
async function runLeftOut(gh, repo, runId, token) {
  const { json } = await gh('GET', `/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`);
  const artifact = (json?.artifacts ?? []).find((a) => !a.expired && a.name === LEAVE_OUT_ARTIFACT);
  if (!artifact) return new Set();
  const res = await fetch(artifact.archive_download_url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (res.status === 403 || res.status === 429) throw new Error(`GitHub ${res.status} on the leave-out list of run ${runId}: stopping`);
  if (!res.ok) return new Set();
  const dir = mkdtempSync(join(tmpdir(), 'revert-'));
  try {
    const zip = join(dir, 'a.zip');
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    const entry = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' })
      .split('\n')
      .find((e) => e.endsWith('leave-out.txt'));
    return entry ? leftOutSteps(execFileSync('unzip', ['-p', zip, entry], { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 })) : new Set();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function artifactReport(artifact, runId, token) {
  const res = await fetch(artifact.archive_download_url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (res.status === 403 || res.status === 429) throw new Error(`GitHub ${res.status} on the artifact of run ${runId}: stopping`);
  if (!res.ok) return null;
  const dir = mkdtempSync(join(tmpdir(), 'revert-'));
  try {
    const zip = join(dir, 'a.zip');
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    const entry = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' })
      .split('\n')
      .find((e) => e.endsWith('journeys/report.json') || e === 'report.json');
    return entry ? JSON.parse(execFileSync('unzip', ['-p', zip, entry], { encoding: 'utf8', maxBuffer: 256 * 2 ** 20 })) : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function summary(lines) {
  const text = `${lines.join('\n')}\n`;
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}
function output(values) {
  const text = Object.entries(values)
    .map(([k, v]) => `${k}=${v}\n`)
    .join('');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
  else process.stdout.write(text);
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 }).trim();
const need = (env, ...keys) => {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) throw new Error(`${missing.join(', ')} required`);
};

// ── starting the revert once ──────────────────────────────────────────────────

/** main-bisect.yml's run-name for a journeys revert: `Main bisect <bad> <steps>`, so a second start can see the first. */
export const bisectTitle = (bad, steps) => `Main bisect ${bad} ${steps.join(',')}`;

/** The steps earlier main-bisect runs already started for `bad`, from their titles. Pure. */
export function coveredSteps(titles, bad) {
  const out = new Set();
  for (const t of titles ?? []) {
    const m = /^Main bisect ([0-9a-f]{40}) (\S+)$/.exec(String(t ?? ''));
    if (m && m[1] === bad) for (const step of m[2].split(',')) out.add(step);
  }
  return out;
}

/** Start the journeys revert for the steps no earlier run started for `bad`. Returns the steps it started, [] when none
 *  were left, or null on a failed start. */
async function startRevert(gh, repo, { good, bad, steps, redRun, confirm = false, revertPr = null, settle = false }) {
  const { json } = await gh('GET', `/repos/${repo}/actions/workflows/main-bisect.yml/runs?per_page=50`);
  const titles = (json?.workflow_runs ?? []).map((r) => r.display_title ?? r.name);
  const covered = confirm || settle ? new Set() : coveredSteps(titles, bad);
  const left = steps.filter((x) => !covered.has(x));
  if (!left.length) return [];
  const inputs = {
    good,
    bad,
    journeys: left.join(','),
    red_run: String(redRun),
    base: 'main',
    ...(confirm ? { confirm: 'true', revert_pr: String(revertPr) } : {}),
    ...(settle ? { confirm: 'settle' } : {}),
  };
  const r = await gh('POST', `/repos/${repo}/actions/workflows/main-bisect.yml/dispatches`, { ref: 'main', inputs });
  return r.status === 204 || r.status === 0 ? left : null;
}

/** A red no single merge explains is settled by running its steps alone on main's head (main-bisect.yml, confirm:
 *  settle). Returns the steps started, or null when main's head can't be read or the start failed. */
async function startSettle(gh, repo, { steps, redRun }) {
  const { json } = await gh('GET', `/repos/${repo}/commits/main`);
  if (!SHA.test(json?.sha ?? '')) return null;
  return startRevert(gh, repo, { good: json.sha, bad: json.sha, steps, redRun, settle: true });
}

/** The journey files the commits from `base` to `head` added or changed (revertSteps' `changed`), or null when the
 *  compare can't be read, so only steps that passed before count. */
async function changedBetween(gh, repo, base, head) {
  if (base === head) return new Set();
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const { status, json } = await gh('GET', `/repos/${repo}/compare/${base}...${head}?per_page=100&page=${page}`);
    if (status !== 200 || !Array.isArray(json?.files)) return page === 1 ? null : journeyFilesChanged(files);
    files.push(...json.files);
    if (json.files.length < 100) break;
  }
  return journeyFilesChanged(files);
}

/** Main's finished journeys runs before `run`, newest first (the runs post-merge-trust.mjs compares with). */
async function earlierRuns(gh, repo, workflowId, run) {
  const { json } = await gh('GET', `/repos/${repo}/actions/workflows/${workflowId}/runs?branch=main&status=completed&per_page=100`);
  return (json?.workflow_runs ?? [])
    .filter(
      (r) =>
        r.id !== run.id &&
        r.created_at < run.created_at &&
        ['push', 'workflow_dispatch', 'schedule'].includes(r.event) &&
        ['success', 'failure', 'timed_out'].includes(r.conclusion),
    )
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

// ── trigger ────────────────────────────────────────────────────────────────

async function trigger(env) {
  need(env, 'GITHUB_REPOSITORY', 'WORKFLOW_ID', 'RUN_ID', 'HEAD_SHA');
  const repo = env.GITHUB_REPOSITORY;
  const gh = client(env.GH_TOKEN);
  const { json: run } = await gh('GET', `/repos/${repo}/actions/runs/${env.RUN_ID}`);
  if (!run?.created_at) throw new Error(`could not read run ${env.RUN_ID}`);
  if (run.head_branch !== 'main') return summary([`Journeys revert: run ${env.RUN_ID} is not on main; nothing to do.`]);
  // The same earlier runs post-merge-trust.mjs compares with: main's own finished runs before this one; a replaced
  // (cancelled) run is left out.
  const [prevRun] = await earlierRuns(gh, repo, env.WORKFLOW_ID, run);
  if (!prevRun) return summary(['Journeys revert: no earlier finished run on main; nothing to compare.']);
  const [now, prev] = [await runReport(gh, repo, run.id, env.GH_TOKEN), await runReport(gh, repo, prevRun.id, env.GH_TOKEN)];
  if (!now || !prev) return summary(['Journeys revert: one of the two runs kept no journey report; nothing is reverted.']);
  const steps = revertSteps(
    prev,
    now,
    await changedBetween(gh, repo, prevRun.head_sha, run.head_sha),
    await runLeftOut(gh, repo, prevRun.id, env.GH_TOKEN),
  );
  if (!steps.length)
    return summary([
      `Journeys revert: no step passed on \`${prevRun.head_sha.slice(0, 10)}\` (or came new in a journey file changed since) and then failed outright; nothing to revert.`,
    ]);
  if (prevRun.head_sha === run.head_sha) {
    const settled = await startSettle(gh, repo, { steps, redRun: run.id });
    summary([
      `Journeys revert: ${steps.join(', ')} broke with no commit between the runs, so there is nothing to revert. ${settled?.length ? "Started the settle run: the steps run alone on main's head." : 'The settle run did not start.'}`,
    ]);
    if (!settled?.length) return 1;
    return;
  }
  const started = await startRevert(gh, repo, { good: prevRun.head_sha, bad: run.head_sha, steps, redRun: run.id });
  summary([
    `### Journeys revert`,
    '',
    `${steps.join(', ')} passed (or came new) on \`${prevRun.head_sha.slice(0, 10)}\` (run ${prevRun.id}) and failed outright on \`${run.head_sha.slice(0, 10)}\` (run ${run.id}).`,
    started === null
      ? 'Dispatch failed.'
      : started.length
        ? `Dispatched main-bisect.yml for ${started.join(', ')} to find the culprit and open its revert.`
        : 'The early start (as the shards ended) already dispatched main-bisect.yml for these steps; nothing new.',
  ]);
  if (started === null) return 1;
}

// ── find ───────────────────────────────────────────────────────────────────

async function find(env) {
  need(env, 'GITHUB_REPOSITORY', 'GOOD', 'BAD', 'STEPS', 'RED_RUN', 'BASE');
  const repo = env.GITHUB_REPOSITORY;
  if (!SHA.test(env.GOOD) || !SHA.test(env.BAD)) throw new Error('GOOD and BAD must be full commit shas');
  if (!BASE.test(env.BASE)) throw new Error('BASE is not a branch name');
  if (!/^\d+$/.test(env.RED_RUN)) throw new Error('RED_RUN must be a run id');
  const asked = parseSteps(env.STEPS);
  const gh = client(env.GH_TOKEN);
  // `untraced`: a confirmed red that names no single merge (OWNER 289 item 6), so settle-early starts the settle run.
  const none = (why, lines = [], untraced = false) => {
    summary(['### Journeys revert: nothing reverted', '', why, ...(lines.length ? ['', ...lines.map((l) => `- ${l}`)] : [])]);
    output({
      culprit: '',
      probe: 'false',
      ...(untraced ? { unknown: why.replace(/\s+/g, ' ').slice(0, 300), steps: steps.join(',') } : {}),
    });
  };

  const { json: run } = await gh('GET', `/repos/${repo}/actions/runs/${env.RED_RUN}`);
  if (run?.name !== JOURNEYS_WORKFLOW) return none(`Run ${env.RED_RUN} is not a ${JOURNEYS_WORKFLOW} run.`);
  if (run.head_sha !== env.BAD)
    return none(`Run ${env.RED_RUN} ran \`${run.head_sha?.slice(0, 10)}\`, not the bad commit \`${env.BAD.slice(0, 10)}\`.`);
  if (run.head_branch !== env.BASE) return none(`Run ${env.RED_RUN} ran on \`${run.head_branch}\`, not \`${env.BASE}\`.`);
  // A run still going (the early start, as its shards end): the reports its finished shards kept.
  const report = await runReport(gh, repo, env.RED_RUN, env.GH_TOKEN, { partial: run.status !== 'completed' });
  if (!report) return none(`Run ${env.RED_RUN} kept no journey report.`);
  const failed = outrightFailures(report);
  const steps = asked.filter((s) => failed.has(s));
  if (!steps.length) return none(`None of ${asked.join(', ')} failed outright in run ${env.RED_RUN}: a known-good state opens no revert.`);
  const files = [...new Set(steps.map((s) => failed.get(s)).filter(Boolean))].sort();

  git('fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${env.BASE}:refs/remotes/origin/${env.BASE}`);
  try {
    git('merge-base', '--is-ancestor', env.GOOD, env.BAD);
  } catch {
    return none(`\`${env.GOOD.slice(0, 10)}\` is not an ancestor of \`${env.BAD.slice(0, 10)}\`.`);
  }
  const commits = git('rev-list', '--first-parent', '--reverse', `${env.GOOD}..${env.BAD}`).split('\n').filter(Boolean);
  if (commits.length > MAX_COMMITS) return none(`${commits.length} commits lie between them, more than ${MAX_COMMITS}.`, [], true);

  let reach = null;
  const map = loadMap();
  if (map) {
    const { json: runs } = await gh(
      'GET',
      `/repos/${repo}/actions/workflows/real-app-journeys.yml/runs?branch=main&status=completed&per_page=30`,
    );
    const atBad = new Set(
      git('ls-tree', '--name-only', `${env.BAD}:${REAL_APP.slice(0, -1)}`)
        .split('\n')
        .filter((f) => f.endsWith('.pw.mjs')),
    );
    reach = {
      map,
      behind: runsBehind(map, runs?.workflow_runs, repo),
      journeyFiles: atBad,
      subscribes: (p) => {
        try {
          return SUBSCRIBES.test(git('show', `${env.BAD}:${p}`));
        } catch {
          return false;
        }
      },
    };
  }
  const atHead = (p) => {
    try {
      git('cat-file', '-e', `${env.BAD}:${p}`);
      return true;
    } catch {
      return false;
    }
  };
  const result = narrow(commits, (sha) =>
    commitReaches(git('diff-tree', '--no-commit-id', '--name-only', '-r', sha).split('\n').filter(Boolean), files, reach, atHead),
  );
  const head = [
    '### Journeys revert',
    '',
    `Failing outright in [run ${env.RED_RUN}](https://github.com/${repo}/actions/runs/${env.RED_RUN}): ${steps.join(', ')} (${files.join(', ')}).`,
    `Commits between \`${env.GOOD.slice(0, 10)}\` and \`${env.BAD.slice(0, 10)}\`: ${commits.length}.`,
    ...(result.lines?.length ? ['', ...result.lines.map((l) => `- ${l}`)] : []),
    '',
  ];
  if (result.none) return none(result.none, result.lines, true);
  summary([...head, `${result.probe.length} commit(s) can reach them: the probe runs ${files.join(', ')} on them.`]);
  output({ culprit: '', probe: 'true', candidates: result.probe.join(' '), files: files.join(' '), steps: steps.join(',') });
}

// ── open ───────────────────────────────────────────────────────────────────

/** What failed, as the revert's comments and body say it: journey steps, or a CI run's test files and jobs. Pure. */
export function failingText({ kind, steps = [], tests = [], jobs = [] }) {
  if (kind !== 'ci') return steps.map((s) => `\`${s.replace('#', ' #')}\``).join(', ');
  return [...tests.map((t) => `\`${t}\``), ...jobs.map((j) => `the ${j} job`)].join(', ');
}

// ── the break issue (OWNER 289 item 6) ────────────────────────────────────────

/**
 * Main trust's one issue per broken journey (post-merge-trust.mjs journeyIssueTitle). A revert starts on the first red
 * and main trust opens the issue on the second, so the revert opens that same issue when it is not there yet, labelled
 * from the moment it exists; main trust then comments on it, and there is never a second one.
 */
export const BREAK_ISSUE_PREFIX = 'Journey broken on main: ';
export const UNKNOWN_LABEL = 'main-unknown-red';

/** The journeys of the failing steps, each once, in their order. Pure. */
export function journeysOf(steps) {
  return [...new Set(steps.map((s) => s.split('#')[0]))];
}

/**
 * What goes on each failing journey's break issue: the revert's link and `regression`; when the culprit's `git revert`
 * conflicts (`conflict`: its pull request's link or sha), that and `regression`, for the culprit is named but nothing is
 * resolved by hand (the programme lead's rule, 13 Nov 2026); or, when the red traces to no single merge, why and
 * `main-unknown-red` (a builder takes only that while it is open: project-state BUILDER.md). Pure.
 */
export function breakIssueNotes({ steps, revertUrl, conflict, reason, redRunUrl }) {
  const named = Boolean(revertUrl || conflict);
  return journeysOf(steps).map((journey) => ({
    title: `${BREAK_ISSUE_PREFIX}${journey}`,
    labels: named ? ['regression'] : [UNKNOWN_LABEL],
    // Only a traced red opens its issue: an untraced one may be the stack's own, and main-unknown-red stops every builder.
    opens: named,
    body:
      conflict && !revertUrl
        ? `The revert on main traced this break ([red run](${redRunUrl})) to ${conflict}, but its \`git revert\` conflicts with main, so no revert was opened and none is resolved by hand: fix it forward. When the steps pass again on main, this issue closes itself.\n\n<!-- steps: ${steps.filter((s) => s.split('#')[0] === journey).join(', ')} -->\n_Posted by tooling/ci/journeys-revert.mjs._`
        : revertUrl
          ? `The revert on main opened ${revertUrl} for this break ([red run](${redRunUrl})). When it merges and the steps pass again on main, this issue closes itself.\n\n<!-- steps: ${steps.filter((s) => s.split('#')[0] === journey).join(', ')} -->\n_Posted by tooling/ci/journeys-revert.mjs._`
          : `The revert on main traced this red ([red run](${redRunUrl})) to no single merge: ${reason}. Nothing was reverted, so a person or a builder finds the cause.\n\n_Posted by tooling/ci/journeys-revert.mjs._`,
  }));
}

/** Comments on and labels each note's open break issue with the workflow's own token, or opens it where the note says. */
async function noteBreakIssues(token, repo, notes) {
  if (!token) return ['- No issues token, so no break issue was noted.'];
  const gh = client(token);
  const lines = [];
  for (const note of notes) {
    const q = encodeURIComponent(`repo:${repo} is:issue is:open in:title "${note.title}"`);
    const { json } = await gh('GET', `/search/issues?q=${q}&per_page=5`);
    const issue = (json?.items ?? []).find((i) => i.title === note.title);
    if (!issue) {
      if (!note.opens) {
        lines.push(`- ${note.title}: no open issue, so none is noted (main trust opens it)`);
        continue;
      }
      const made = await gh('POST', `/repos/${repo}/issues`, { title: note.title, body: note.body, labels: note.labels });
      lines.push(`- ${note.title}: opened #${made.json?.number} (${note.labels.join(', ')})`);
      continue;
    }
    await gh('POST', `/repos/${repo}/issues/${issue.number}/comments`, { body: note.body });
    if (note.labels.length) await gh('POST', `/repos/${repo}/issues/${issue.number}/labels`, { labels: note.labels });
    lines.push(`- #${issue.number}: ${note.labels.join(', ') || 'noted'}`);
  }
  return lines;
}

/** A confirmed journeys red (revert-find named its steps): start the settle run at once, beside the probe and the control
 *  (main-bisect.yml settle-early). Only when it can't start does each journey's break issue open, as `main-unknown-red`. */
async function settle(env) {
  need(env, 'GITHUB_REPOSITORY', 'STEPS', 'RED_RUN', 'REASON');
  if (!/^\d+$/.test(env.RED_RUN)) throw new Error('RED_RUN must be a run id');
  const repo = env.GITHUB_REPOSITORY;
  const reason = String(env.REASON);
  const steps = parseSteps(env.STEPS);
  const started = await startSettle(client(env.GH_TOKEN), repo, { steps, redRun: env.RED_RUN });
  if (started?.length)
    return summary([
      '### Journeys revert: the steps run alone on main',
      '',
      reason,
      '',
      `Started the settle run: ${steps.join(', ')} run alone on main's head. Passing, each gets a \`flaky\` issue unless the probe names a merge; failing again, its journey gets a \`regression\` issue.`,
    ]);
  const notes = breakIssueNotes({
    steps,
    reason: `${reason.slice(0, 300)}; and the run of the steps alone on main's head did not start`,
    redRunUrl: `https://github.com/${repo}/actions/runs/${env.RED_RUN}`,
  }).map((n) => ({ ...n, opens: true }));
  summary(['### Journeys revert: the steps run alone on main', '', reason, '', ...(await noteBreakIssues(env.GH_TOKEN, repo, notes))]);
  return 1;
}

/** The automatic revert opened for red run `redRun`, among pull requests (newest first): one the App opened on a
 *  revert/auto- branch, open or merged, whose body names that run. A revert closed unmerged is no longer the cause. Pure. */
export function revertForRun(pulls, redRun) {
  return (
    (pulls ?? []).find(
      (p) =>
        p?.user?.login === APP_LOGIN &&
        String(p?.head?.ref ?? '').startsWith(BRANCH_PREFIX) &&
        (p.state === 'open' || p.merged_at) &&
        new RegExp(`/actions/runs/${redRun}\\b`).test(String(p.body ?? '')),
    ) ?? null
  );
}

/** Whether an issue's texts ({ user, body }) hold the workflow's settle record for red run `redRun`. Pure. */
export function settledFor(texts, redRun) {
  return (texts ?? []).some((t) => t?.user?.login === 'github-actions[bot]' && parseSettle(t.body)?.red_run === Number(redRun));
}

/** A merge was named after the settle passed: close each step's open `flaky` issue that this red's settle opened. */
async function closeSettledFlaky(token, repo, { steps, redRun, revertUrl }) {
  if (!token) return ['- No issues token, so no flaky issue was checked.'];
  const gh = client(token);
  const lines = [];
  for (const step of steps) {
    const title = flakyStepTitle(step);
    const q = encodeURIComponent(`repo:${repo} is:issue is:open in:title "${title}"`);
    const { json } = await gh('GET', `/search/issues?q=${q}&per_page=5`);
    const issue = (json?.items ?? []).find((i) => i.title === title);
    if (!issue) continue;
    const { json: comments } = await gh('GET', `/repos/${repo}/issues/${issue.number}/comments?per_page=100`);
    if (!settledFor([issue, ...(comments ?? [])], redRun)) continue;
    await gh('POST', `/repos/${repo}/issues/${issue.number}/comments`, {
      body: `The revert on main has since named the merge that broke this step in the same red and opened ${revertUrl}. The step is broken, not flaky: its journey's break issue tracks it, so this one closes.\n\n_Posted by tooling/ci/journeys-revert.mjs._`,
    });
    await gh('PATCH', `/repos/${repo}/issues/${issue.number}`, { state: 'closed', state_reason: 'not_planned' });
    lines.push(`- Closed #${issue.number}: ${title} (a merge was named)`);
  }
  return lines;
}

/** The error `open` ends with: the earlier one, kept whole, and the revoke's problem beside it. A throw inside
 *  `finally` would replace the earlier error, so the reason the revert failed would be lost. Pure. */
export function afterRevoke(earlier, problem) {
  if (!problem) return earlier ?? null;
  if (!earlier) return new Error(problem);
  return new Error(`${earlier.message}; and ${problem}`, { cause: earlier });
}

async function open(env) {
  const revoke = { problem: null };
  let failed = null;
  let out;
  try {
    out = await openRevert(env, revoke);
  } catch (e) {
    failed = e;
  }
  const err = afterRevoke(failed, revoke.problem);
  if (err) throw err;
  return out;
}

async function openRevert(env, revoke) {
  const kind = env.KIND === 'ci' ? 'ci' : 'journeys';
  need(env, 'GITHUB_REPOSITORY', 'CULPRIT', 'BASE', 'RED_RUN', ...(kind === 'ci' ? [] : ['STEPS']));
  const repo = env.GITHUB_REPOSITORY;
  if (!SHA.test(env.CULPRIT)) throw new Error('CULPRIT must be a full commit sha');
  if (!BASE.test(env.BASE) || !/^\d+$/.test(env.RED_RUN)) throw new Error('BASE or RED_RUN is malformed');
  const steps = kind === 'ci' ? [] : parseSteps(env.STEPS);
  const tests = kind === 'ci' ? parseTests(env.TESTS) : [];
  const jobs = kind === 'ci' ? parseJobs(env.JOBS) : [];
  if (kind === 'ci' && !tests.length && !jobs.length) throw new Error('a CI revert needs the failing TESTS or JOBS');
  const what = kind === 'ci' ? 'CI' : 'Real-app journeys';
  const sha = env.CULPRIT;
  const branch = revertBranch(sha);
  git('fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${env.BASE}:refs/remotes/origin/${env.BASE}`);
  try {
    git('merge-base', '--is-ancestor', sha, `origin/${env.BASE}`);
  } catch {
    return summary([`Journeys revert: \`${sha.slice(0, 10)}\` is not on \`${env.BASE}\` any more; nothing reverted.`]);
  }
  const subject = git('log', '-1', '--format=%s', sha);
  const parents = git('log', '-1', '--format=%P', sha).split(' ').filter(Boolean).length;
  const files = git('diff-tree', '--no-commit-id', '--name-only', '-r', '-m', '--first-parent', sha).split('\n').filter(Boolean);

  const { mintToken } = await import('./app-token.mjs');
  const dry = process.env.DRY_RUN === '1';
  if (!dry) need(env, 'FACTORY_APP_KEY');
  const token = dry ? env.GH_TOKEN : await mintToken({ pem: env.FACTORY_APP_KEY, repo, spec: REVERT_TOKEN });
  if (token && !dry) console.log(`::add-mask::${token}`);
  const gh = client(token);
  try {
    // The culprit's pull request: the subject's (#n) when that pull request merged as this commit, else the API's.
    let pr = null;
    const n = subjectPr(subject);
    if (n) {
      const { json } = await gh('GET', `/repos/${repo}/pulls/${n}`);
      if (json?.merge_commit_sha === sha) pr = json;
    }
    if (!pr) {
      const { json } = await gh('GET', `/repos/${repo}/commits/${sha}/pulls`);
      pr = (json ?? []).find((p) => p.merge_commit_sha === sha) ?? null;
    }
    const comment = async (body) => pr && (await gh('POST', `/repos/${repo}/issues/${pr.number}/comments`, { body }));
    const runUrl = `https://github.com/${repo}/actions/runs/${env.RED_RUN}`;
    const stepText = failingText({ kind, steps, tests, jobs });

    const refused = refuseRevert({ subject, parents, files, pr });
    if (refused) {
      await comment(
        `The ${what} [run ${env.RED_RUN}](${runUrl}) on \`${env.BASE}\` failed ${stepText}, and the revert on main found this pull request's commit \`${sha.slice(0, 10)}\` as the cause. It opened no revert: ${refused}. Fix it forward or revert it by hand.\n\n_Posted by tooling/ci/journeys-revert.mjs._`,
      );
      return summary([`Journeys revert: no revert of \`${sha.slice(0, 10)}\`: ${refused}.`]);
    }
    const exists = await gh('GET', `/repos/${repo}/branches/${encodeURIComponent(branch)}`);
    if (exists.status === 200)
      return summary([`Journeys revert: \`${branch}\` already exists, so its revert was opened before; nothing new.`]);

    git('checkout', '--quiet', '-B', branch, `origin/${env.BASE}`);
    try {
      execFileSync(
        'git',
        [
          '-c',
          'user.name=intafaced-mac-agents[bot]',
          '-c',
          'user.email=intafaced-mac-agents[bot]@users.noreply.github.com',
          'revert',
          '--no-edit',
          sha,
        ],
        { stdio: 'pipe' },
      );
    } catch {
      execFileSync('git', ['revert', '--abort'], { stdio: 'ignore' });
      await comment(
        `The ${what} [run ${env.RED_RUN}](${runUrl}) on \`${env.BASE}\` failed ${stepText}, and the revert on main found this pull request's commit \`${sha.slice(0, 10)}\` as the cause. Its revert doesn't apply cleanly on \`${env.BASE}\`, so no revert was opened, and none is resolved by hand: fix it forward. Each broken journey's issue is marked \`regression\`.\n\n_Posted by tooling/ci/journeys-revert.mjs._`,
      );
      if (kind === 'journeys' && !dry) {
        const conflict = pr ? `#${pr.number} (\`${sha.slice(0, 10)}\`)` : `\`${sha.slice(0, 10)}\``;
        const notes = breakIssueNotes({ steps, conflict, redRunUrl: runUrl });
        summary(['', ...(await noteBreakIssues(env.ISSUES_TOKEN, repo, notes).catch((e) => [`- Break issue not noted: ${e.message}`]))]);
      }
      return summary([`Journeys revert: \`git revert ${sha.slice(0, 10)}\` doesn't apply cleanly; commented instead.`]);
    }
    if (dry) {
      console.log(`DRY_RUN push ${branch}: ${git('log', '-1', '--format=%h %s')}`);
    } else {
      // The token goes to git through its environment, never its arguments or the log.
      execFileSync('git', ['push', '--quiet', `https://github.com/${repo}.git`, `HEAD:refs/heads/${branch}`], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
        },
      });
    }
    const title = revertTitle({ prNumber: pr?.number, sha, files, redRun: env.RED_RUN, kind });
    const made = await gh('POST', `/repos/${repo}/pulls`, {
      title,
      head: branch,
      base: env.BASE,
      body: revertBody({
        repo,
        sha,
        subject,
        prNumber: pr?.number,
        redRun: env.RED_RUN,
        steps,
        base: env.BASE,
        failing: stepText,
        control: SHA.test(env.CONTROL ?? '') ? env.CONTROL : null,
      }),
    });
    if (!dry && made.status !== 201) throw new Error(`could not open the revert pull request: HTTP ${made.status}`);
    const number = made.json?.number;
    let armed = 'not armed (dry run)';
    if (!dry) {
      const q = await gh('POST', '/graphql', {
        query: 'mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { clientMutationId } }',
        variables: { id: made.json.node_id },
      });
      armed = q.json?.errors?.length ? `not armed: ${String(q.json.errors[0].message).slice(0, 200)}` : 'armed (squash)';
    }
    await comment(
      `The ${what} [run ${env.RED_RUN}](${runUrl}) on \`${env.BASE}\` failed ${stepText}, and the revert on main found this pull request's commit \`${sha.slice(0, 10)}\` as the cause. Its revert is #${number ?? '(dry run)'}, with auto-merge ${armed.startsWith('armed') ? 'on' : 'off'}. To keep this change, fix it forward and close the revert.\n\n_Posted by tooling/ci/journeys-revert.mjs._`,
    );
    summary([
      `### Journeys revert`,
      '',
      `Opened #${number ?? '(dry run)'}: ${title}`,
      `Auto-merge: ${armed}.`,
      `Culprit: ${pr ? `#${pr.number}` : 'no pull request'} \`${sha.slice(0, 10)}\` ${subject}`,
    ]);
    if (kind === 'journeys' && number && !dry) {
      // A failed note never undoes an opened revert: it is said in the summary.
      const revertUrl = `https://github.com/${repo}/pull/${number}`;
      const notes = breakIssueNotes({ steps, revertUrl, redRunUrl: runUrl });
      summary(['', ...(await noteBreakIssues(env.ISSUES_TOKEN, repo, notes).catch((e) => [`- Break issue not noted: ${e.message}`]))]);
      // The settle ran beside the probe and may have passed first: its flaky issue for this red gives way to the revert.
      summary([
        ...(await closeSettledFlaky(env.ISSUES_TOKEN, repo, { steps, redRun: env.RED_RUN, revertUrl }).catch((e) => [
          `- Flaky issues not checked: ${e.message}`,
        ])),
      ]);
    }
  } finally {
    // Never a throw here (it would hide the try's own error): the problem goes to `open`, which throws both.
    if (token && !dry) {
      // Revoke, then prove it: GitHub must refuse the token afterwards (401). A revoke takes a moment to reach every
      // GitHub front end (run 42748252246: revoke 204, then 200 at once), so the refusal is asked for a few times.
      const end = await fetch(`${API}/installation/token`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
      const after =
        end.status === 204
          ? await refusedAfterRevoke(
              async () => (await fetch(`${API}/repos/${repo}`, { headers: { authorization: `Bearer ${token}` } })).status,
            )
          : { refused: false, status: 'not asked', tries: 0 };
      if (end.status !== 204 || !after.refused)
        revoke.problem = `the revert token may still be live (revoke ${end.status}, then ${after.status} after ${after.tries} tries)`;
      else console.log(`the revert token is revoked: GitHub now refuses it (401, after ${after.tries} tries)`);
    }
  }
}

// ── refresh: an open revert's red checks run again on main's newer rules ──────

/** At most this many rebases of one revert by `refresh`: one per merge into main while its checks stay red. */
export const REFRESH_MAX = 4;
/** The workflows whose newest run on a revert's head decides a refresh, with the event each runs on. */
export const REFRESH_WORKFLOWS = [
  { file: 'ci.yml', event: 'pull_request' },
  { file: 'ci-review.yml', event: 'pull_request_target' },
];

/**
 * Whether `refresh` rebases this open pull request onto main, or why not. Pure. Only main-bisect's own revert (its
 * revert/auto- branch in this repository, opened by the App as a Bot, not a draft); only when the newest run of a
 * REFRESH_WORKFLOWS workflow on its head failed and started before main's head commit (`mainAt`, ms), with none of them
 * still going; at most REFRESH_MAX times (`rebased`: its earlier rebases, the timeline's head_ref_force_pushed events).
 * A re-run can't do it: a pull_request run's re-run keeps its merge commit and that commit's workflow file, so it
 * never reads main's newer check (intafaced #8138 after #8166: its re-run guard couldn't import exact-revert.mjs).
 */
export function refreshWhy(pr, { repo, runs, mainAt, rebased }) {
  const ok =
    AUTO_REVERT_BRANCH.test(String(pr?.head?.ref ?? '')) &&
    pr?.user?.login === AUTO_REVERT_AUTHOR &&
    pr?.user?.type === 'Bot' &&
    pr?.head?.repo?.full_name === repo &&
    !pr?.draft;
  if (!ok) return { refresh: false, why: "not main-bisect's revert" };
  const newest = REFRESH_WORKFLOWS.map(
    ({ file, event }) =>
      (runs[file] ?? []).filter((r) => r.event === event && r.conclusion !== 'skipped').sort((a, b) => b.run_number - a.run_number)[0],
  ).filter(Boolean);
  if (newest.some((r) => r.status !== 'completed')) return { refresh: false, why: 'a check is still going' };
  const red = newest.filter((r) => r.conclusion === 'failure');
  if (!red.length) return { refresh: false, why: 'no check red' };
  if (!red.some((r) => Date.parse(r.run_started_at ?? r.created_at) < mainAt))
    return { refresh: false, why: "its checks ran after main's head" };
  if (rebased >= REFRESH_MAX) return { refresh: false, why: `rebased ${rebased} times already, the most` };
  return { refresh: true, why: `${red.map((r) => r.name ?? r.id).join(', ')} red before main's head` };
}

/**
 * After each CI run on main (main-trust.yml revert-refresh): rebase each open automatic revert that refreshWhy picks
 * onto main, with the App's token, so its head is new and every check runs again on main's rules, with no hand. GitHub
 * refuses a rebase that conflicts; that is said, and nothing is resolved (the programme lead's rule, 13 Nov 2026). Reads
 * go with GH_TOKEN; the App token is minted only when something is rebased, and revoked at the end.
 */
async function refresh(env) {
  need(env, 'GITHUB_REPOSITORY', 'GH_TOKEN');
  const repo = env.GITHUB_REPOSITORY;
  const read = client(env.GH_TOKEN);
  const lines = ['### Refresh of open automatic reverts', ''];
  const pulls = (await read('GET', `/repos/${repo}/pulls?state=open&per_page=100`)).json ?? [];
  const mainAt = Date.parse((await read('GET', `/repos/${repo}/commits/main`)).json?.commit?.committer?.date ?? '');
  const picked = [];
  for (const pr of pulls) {
    if (!AUTO_REVERT_BRANCH.test(String(pr?.head?.ref ?? ''))) continue;
    const runs = {};
    for (const w of REFRESH_WORKFLOWS)
      runs[w.file] =
        (await read('GET', `/repos/${repo}/actions/workflows/${w.file}/runs?head_sha=${pr.head.sha}&per_page=100`)).json?.workflow_runs ??
        [];
    const events = (await read('GET', `/repos/${repo}/issues/${pr.number}/timeline?per_page=100`)).json ?? [];
    const rebased = events.filter((e) => e.event === 'head_ref_force_pushed').length;
    const d = refreshWhy(pr, { repo, runs, mainAt, rebased });
    lines.push(`- #${pr.number}: ${d.refresh ? 'rebase' : 'left'} (${d.why})`);
    if (d.refresh) picked.push(pr);
  }
  if (picked.length) {
    if (process.env.DRY_RUN !== '1') need(env, 'FACTORY_APP_KEY');
    const { mintToken } = await import('./app-token.mjs');
    const dry = process.env.DRY_RUN === '1';
    const token = dry ? env.GH_TOKEN : await mintToken({ pem: env.FACTORY_APP_KEY, repo, spec: REVERT_TOKEN });
    if (token && !dry) console.log(`::add-mask::${token}`);
    const gh = client(token);
    try {
      for (const pr of picked) {
        const r = await gh('POST', `${API}/graphql`, {
          query:
            'mutation($id: ID!, $oid: GitObjectID!) { updatePullRequestBranch(input: { pullRequestId: $id, expectedHeadOid: $oid, updateMethod: REBASE }) { pullRequest { headRefOid } } }',
          variables: { id: pr.node_id, oid: pr.head.sha },
        });
        const head = r.json?.data?.updatePullRequestBranch?.pullRequest?.headRefOid;
        lines.push(
          head
            ? `- #${pr.number}: rebased onto main, head ${head.slice(0, 10)}; its checks run again`
            : `- #${pr.number}: not rebased (${String(r.json?.errors?.[0]?.message ?? `HTTP ${r.status}`).slice(0, 200)}); a conflict is left for a fix forward, never resolved by hand`,
        );
      }
    } finally {
      if (token && !dry) {
        const end = await fetch(`${API}/installation/token`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
        lines.push(`- the App token: revoke ${end.status}`);
      }
    }
  }
  summary(lines);
}

/** How many times, and how long apart, a revoked token's refusal is asked for: about 20 s in all. */
export const REVOKE_PROBES = [0, 1000, 2000, 3000, 5000, 8000];
/**
 * Whether GitHub refuses a revoked token: `probe()` answers the HTTP status of a read made with it. Only a 401 counts as
 * refused; any other answer (200, a 5xx) is asked again after the next wait, and still not 401 after the last one is not
 * refused. `sleep` stands in for setTimeout in the tests.
 */
export async function refusedAfterRevoke(probe, { waits = REVOKE_PROBES, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let status;
  for (let i = 0; i < waits.length; i++) {
    if (waits[i]) await sleep(waits[i]);
    status = await probe();
    if (status === 401) return { refused: true, status, tries: i + 1 };
  }
  return { refused: false, status, tries: waits.length };
}

// ── early: as each shard of main's run ends ─────────────────────────────────

/** How long `early` waits between reads of the run's jobs, and at most in all (the shards' own limit is 90 minutes). */
export const EARLY_POLL_MS = 30_000;
export const EARLY_MAX_MS = 100 * 60_000;

/** The shard jobs that ended and were not read yet: [{ shard, conclusion }]. Pure. */
export function endedShards(jobs, seen) {
  return (jobs ?? [])
    .map((j) => ({ shard: shardOf(j.name), status: j.status, conclusion: j.conclusion }))
    .filter((j) => j.shard && j.status === 'completed' && !seen.has(j.shard));
}

async function early(env, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  need(env, 'GITHUB_REPOSITORY', 'WORKFLOW_ID', 'RUN_ID', 'HEAD_SHA');
  const repo = env.GITHUB_REPOSITORY;
  const gh = client(env.GH_TOKEN);
  const { json: run } = await gh('GET', `/repos/${repo}/actions/runs/${env.RUN_ID}`);
  if (run?.head_branch !== 'main') return summary([`Journeys revert, early: run ${env.RUN_ID} is not on main; nothing to do.`]);
  const [prevRun] = await earlierRuns(gh, repo, env.WORKFLOW_ID, run);
  if (!prevRun || prevRun.head_sha === env.HEAD_SHA)
    return summary(['Journeys revert, early: no earlier finished run on another commit to compare with; the run-end start decides.']);
  const prev = await runReport(gh, repo, prevRun.id, env.GH_TOKEN);
  if (!prev) return summary([`Journeys revert, early: run ${prevRun.id} kept no report; the run-end start decides.`]);
  const changed = await changedBetween(gh, repo, prevRun.head_sha, env.HEAD_SHA);
  const leftOut = await runLeftOut(gh, repo, prevRun.id, env.GH_TOKEN);
  const seen = new Set();
  const lines = ['### Journeys revert, as each shard ends', ''];
  const start = now();
  for (;;) {
    const { json } = await gh('GET', `/repos/${repo}/actions/runs/${env.RUN_ID}/jobs?filter=latest&per_page=100`);
    const jobs = json?.jobs ?? [];
    for (const { shard } of endedShards(jobs, seen)) {
      seen.add(shard);
      const report = await runReport(gh, repo, env.RUN_ID, env.GH_TOKEN, { shards: [shard] });
      if (!report) {
        lines.push(`- shard ${shard}: no report kept`);
        continue;
      }
      const steps = revertSteps(prev, report, changed, leftOut);
      if (!steps.length) continue;
      const started = await startRevert(gh, repo, { good: prevRun.head_sha, bad: env.HEAD_SHA, steps, redRun: env.RUN_ID });
      lines.push(
        `- shard ${shard}: ${steps.join(', ')} passed (or came new) on \`${prevRun.head_sha.slice(0, 10)}\` and failed outright here: ${started === null ? 'dispatch failed' : started.length ? `main-bisect.yml started for ${started.join(', ')}` : 'already started'}`,
      );
    }
    const shards = jobs.filter((j) => shardOf(j.name));
    if (shards.length && shards.every((j) => j.status === 'completed')) break;
    if (now() - start > EARLY_MAX_MS) {
      lines.push('- stopped waiting after 100 minutes; the run-end start decides the rest');
      break;
    }
    await sleep(EARLY_POLL_MS);
  }
  summary([...lines, '', `Read ${seen.size} shard(s).`]);
}

// ── confirm and back: the break is back when its journey passes on main's head ──

/** The automatic revert's squash commit: `Revert #<culprit>, which turned the Real-app journeys red (run <id>) (#<pr>)`,
 *  `ci: revert …` for a gate file. The revert's own pull request number, or null. Pure. */
export function revertMergePull(subject) {
  const m = /^(?:ci: r|R)evert #\d+, which turned the Real-app journeys red \(run \d+\) \(#(\d+)\)$/.exec(
    String(subject ?? '').split('\n')[0],
  );
  return m ? Number(m[1]) : null;
}

/** The failing steps a revert's body names on its `- Failing:` line (revertBody), as J-x-01#2. Pure. */
export function failingSteps(body) {
  const line = /^- Failing: (.+)$/m.exec(String(body ?? '').replace(/\r/g, ''))?.[1] ?? '';
  return [...line.matchAll(/`(J-[a-z0-9-]+-\d+) #(\d+)`/g)].map((m) => `${m[1]}#${Number(m[2])}`);
}

/** The journey files of the steps' journeys among the head's files: `J-x-01.pw.mjs` and `J-x-01-<part>.pw.mjs`. Pure. */
export function journeyFilesOf(steps, files) {
  const journeys = journeysOf(steps);
  return [...files]
    .filter((f) =>
      journeys.some((j) => f === `${j}.pw.mjs` || (f.startsWith(`${j}-`) && /^[a-z]/.test(f.slice(j.length + 1)) && f.endsWith('.pw.mjs'))),
    )
    .sort();
}

const APP_LOGIN = 'intafaced-mac-agents[bot]';

/** The culprit's commit a revert's body names on its `- Culprit:` line (revertBody), short or full, or null. Pure. */
export function culpritOf(body) {
  return /^- Culprit: .*?commit `([0-9a-f]{7,40})`/m.exec(String(body ?? '').replace(/\r/g, ''))?.[1] ?? null;
}

/** Main's journeys runs still going on another commit than the revert's: the ones that may hold the culprit. Pure. */
export function goingElsewhere(runs, headSha) {
  return (runs ?? []).filter(
    (r) => r.head_branch === 'main' && r.event !== 'pull_request' && r.status !== 'completed' && r.head_sha !== headSha,
  );
}

/**
 * When the automatic revert merges, main's journeys run still going on a commit that holds the culprit and not the
 * revert can only end red on the reverted steps, and the run on the revert's head waits behind it in main's one group.
 * Plant 2 (#7957, 11 Nov 2026): #7980 merged 13:39:12 UTC and its head's full run waited until 14:18 behind run 3970 on
 * `671421a0f`. Those runs are cancelled; a cancelled run says nothing (post-merge-trust.mjs, journey-verdict.mjs), and
 * the run on the revert's head (or a newer one) runs every journey. A run whose head the compare can't place is left.
 */
export async function cancelDoomed(gh, repo, { headSha, culprit }) {
  const lines = [];
  const going = [];
  for (const status of ['in_progress', 'queued']) {
    const { json } = await gh(
      'GET',
      `/repos/${repo}/actions/workflows/real-app-journeys.yml/runs?branch=main&status=${status}&per_page=50`,
    );
    going.push(...goingElsewhere(json?.workflow_runs, headSha));
  }
  for (const run of going) {
    const holds = (await gh('GET', `/repos/${repo}/compare/${culprit}...${run.head_sha}`)).json?.status;
    const before = (await gh('GET', `/repos/${repo}/compare/${run.head_sha}...${headSha}`)).json?.status;
    const name = `run ${run.run_number} on \`${run.head_sha.slice(0, 10)}\``;
    if (!['ahead', 'identical'].includes(holds) || before !== 'ahead') {
      lines.push(`${name}: left (holds the culprit: ${holds ?? 'unknown'}; before the revert: ${before ?? 'unknown'})`);
      continue;
    }
    const r = await gh('POST', `/repos/${repo}/actions/runs/${run.id}/cancel`);
    lines.push(
      `${name}: holds the culprit and not the revert, ${r.status === 202 || r.status === 0 ? 'cancelled' : `cancel not taken (${r.status})`}`,
    );
  }
  return lines;
}

async function confirm(env) {
  need(env, 'GITHUB_REPOSITORY', 'HEAD_SHA', 'SUBJECT');
  const repo = env.GITHUB_REPOSITORY;
  if (!SHA.test(env.HEAD_SHA)) throw new Error('HEAD_SHA must be a full commit sha');
  const n = revertMergePull(env.SUBJECT);
  if (!n) return summary(['Journeys revert, confirm: this push is not an automatic revert; nothing to do.']);
  const gh = client(env.GH_TOKEN);
  const { json: pr } = await gh('GET', `/repos/${repo}/pulls/${n}`);
  // Only the revert this job opened: the App's revert/auto- branch, merged as this very commit.
  if (pr?.user?.login !== APP_LOGIN || !String(pr?.head?.ref ?? '').startsWith(BRANCH_PREFIX) || pr?.merge_commit_sha !== env.HEAD_SHA)
    return summary([
      `Journeys revert, confirm: #${n} is not an automatic revert merged as \`${env.HEAD_SHA.slice(0, 10)}\`; nothing to do.`,
    ]);
  const steps = parseSteps(failingSteps(pr.body).join(','));
  const redRun = /actions\/runs\/(\d+)/.exec(String(pr.body ?? ''))?.[1];
  if (!steps.length || !redRun) return summary([`Journeys revert, confirm: #${n} names no failing step or red run; nothing to do.`]);
  const started = await startRevert(gh, repo, { good: env.HEAD_SHA, bad: env.HEAD_SHA, steps, redRun, confirm: true, revertPr: n });
  const culprit = culpritOf(pr.body);
  const cancelled = culprit
    ? await cancelDoomed(gh, repo, { headSha: env.HEAD_SHA, culprit })
    : ['no culprit commit in the body; no run cancelled'];
  summary([
    `### Journeys revert, confirm`,
    '',
    started?.length
      ? `#${n} merged as \`${env.HEAD_SHA.slice(0, 10)}\`: main-bisect.yml runs ${steps.join(', ')} alone on it.`
      : 'Dispatch failed.',
    '',
    `Main's journeys runs still going: ${cancelled.length ? cancelled.join('; ') : 'none on another commit'}.`,
  ]);
  if (!started?.length) return 1;
}

/** The confirm run's result on each failing journey's break issue: a comment, never a close. `back` is true (the steps
 *  pass), false (they still fail) or null (the run broke before it said). Pure. */
export function backNotes({ steps, back, sha, runUrl }) {
  const at = `main's head \`${sha.slice(0, 10)}\``;
  const link = `([confirm run](${runUrl}))`;
  return journeysOf(steps).map((journey) => {
    const list = steps
      .filter((x) => x.split('#')[0] === journey)
      .map((x) => `\`${x.replace('#', ' #')}\``)
      .join(', ');
    const said =
      back === true
        ? `${list} pass again on ${at}, run alone after the revert merged ${link}: the break is back. Main's full run still has to pass them, and this issue closes when it does.`
        : back === false
          ? `The revert merged, but ${list} still fail on ${at}, run alone ${link}. The break is not back.`
          : `The revert merged, but the run of ${list} alone on ${at} did not finish ${link}, so it says nothing; main's full run decides.`;
    return {
      title: `${BREAK_ISSUE_PREFIX}${journey}`,
      labels: [],
      opens: false,
      body: `${said}\n\n_Posted by tooling/ci/journeys-revert.mjs._`,
    };
  });
}

/** The settle record (v1): a red no single merge explains, run alone on main's head. One JSON line in each note, which
 *  project-state tooling/board/event.mjs can read for "settled by code". Pure. */
export const SETTLE_MARK = 'journeys-settle v1';
export const flakyStepTitle = (step) => `Flaky step on main: ${step.replace('#', ' #')}`;

/**
 * What the settle run's result opens (programme lead, 12 Nov 2026: "A red main means a step that fails again when run
 * alone on main's head"). `back` true: each step passed alone, one `flaky` issue per step, and the red is settled.
 * false: the steps fail again, one `regression` break issue per journey at once, closed by Main trust when they pass.
 * null: the run broke before it said, one `main-unknown-red` break issue per journey. Pure.
 */
export function settleNotes({ steps, back, sha, runUrl, redRunUrl, at, money = {} }) {
  const record = (list) =>
    `<!-- ${SETTLE_MARK} ${JSON.stringify({ v: 1, steps: list, red_run: Number(/runs\/(\d+)/.exec(redRunUrl)?.[1]) || null, sha, run: runUrl, result: back === true ? 'pass' : back === false ? 'fail' : 'unfinished', at })} -->`;
  const head = `main's head \`${sha.slice(0, 10)}\``;
  const tail = '_Posted by tooling/ci/journeys-revert.mjs._';
  if (back === true)
    return steps.map((step) => ({
      title: flakyStepTitle(step),
      labels: ['flaky'],
      opens: true,
      body: `\`${step.replace('#', ' #')}\` failed on main ([red run](${redRunUrl})), traced to no single merge, and passed run alone on ${head} ([settle run](${runUrl})). It is flaky, not broken: main counts it green, and it never counts as proven from the red run. Fix the race in the test or the code it checks, never by weakening the test.\n\n<!-- flaky: ${step} -->\n${(money[step] ?? true) ? `<!-- money-flaky: ${step} -->\n` : ''}${record([step])}\n${tail}`,
    }));
  return journeysOf(steps).map((journey) => {
    const list = steps.filter((s) => s.split('#')[0] === journey);
    const named = list.map((s) => `\`${s.replace('#', ' #')}\``).join(', ');
    return {
      title: `${BREAK_ISSUE_PREFIX}${journey}`,
      labels: back === false ? ['regression'] : [UNKNOWN_LABEL],
      opens: true,
      body: `${
        back === false
          ? `${named} failed on main ([red run](${redRunUrl})), traced to no single merge, and fail again run alone on ${head} ([settle run](${runUrl})): broken on main. This issue closes itself when main's full run passes them.`
          : `${named} failed on main ([red run](${redRunUrl})), traced to no single merge, and the run of them alone on ${head} did not finish ([settle run](${runUrl})), so nothing settled it.`
      }\n\n<!-- steps: ${list.join(', ')} -->\n${record(list)}\n${tail}`,
    };
  });
}

export function parseSettle(body) {
  const m = new RegExp(`<!-- ${SETTLE_MARK} (\\{.*?\\}) -->`).exec(String(body ?? ''));
  try {
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
}

/** The recovery record (v1): what the repair did, one JSON line in a marked comment on the automatic revert, which
 *  project-state tooling/board/event.mjs reads. The full run's result is not in it: event.mjs reads that from the runs.
 *  Pure. */
export const RECORD_MARK = 'journeys-recovery v1';
export function recoveryRecord({ revertPr, revertBody: body, steps, repair, confirmRun, back, at }) {
  const text = String(body ?? '');
  const blamed = /^- Culprit: (?:#(\d+)|no pull request found), commit `([0-9a-f]{7,40})`/m.exec(text);
  const control = /^- Control: `([0-9a-f]{7,40})`/m.exec(text);
  return {
    v: 1,
    revert_pr: revertPr,
    steps,
    red_run: Number(/actions\/runs\/(\d+)/.exec(text)?.[1]) || null,
    blamed: blamed ? { pr: blamed[1] ? Number(blamed[1]) : null, sha: blamed[2] } : null,
    control: control ? { sha: control[1], passed: true } : null,
    repair,
    confirm: { run: confirmRun, result: back === true ? 'pass' : back === false ? 'fail' : 'unfinished', at },
  };
}
export const recoveryComment = (record) =>
  `<!-- ${RECORD_MARK} ${JSON.stringify(record)} -->\nRecovery: ${record.steps.map((x) => `\`${x.replace('#', ' #')}\``).join(', ')} ${record.confirm.result === 'pass' ? 'pass' : record.confirm.result === 'fail' ? 'still fail' : 'were not shown either way'} alone on \`${String(record.repair).slice(0, 10)}\` ([confirm run](${record.confirm.run})). Main's full run decides the break issue.\n\n_Posted by tooling/ci/journeys-revert.mjs._`;
export function parseRecord(body) {
  const m = new RegExp(`<!-- ${RECORD_MARK} (\\{.*?\\}) -->`).exec(String(body ?? ''));
  try {
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
}

/** The money guard at this checkout; when it can't be read, every step counts as money ({}: unknown means money). */
function guardOrAllMoney() {
  try {
    return moneyGuardAt('.');
  } catch (e) {
    console.error(`the money guard could not be read (${e.message}): every step counts as money`);
    return {};
  }
}

async function back(env) {
  need(env, 'GITHUB_REPOSITORY', 'STEPS', 'BAD', 'RUN_URL');
  if (!SHA.test(env.BAD)) throw new Error('BAD must be a full commit sha');
  const back = env.BACK === 'true' ? true : env.BACK === 'false' ? false : null;
  if (env.SETTLE === 'true') {
    if (!/^\d+$/.test(env.RED_RUN ?? '')) throw new Error('RED_RUN must be a run id');
    const steps = parseSteps(env.STEPS);
    if (back === true) {
      // The probe beside this run named a merge first: its revert decides, so the pass opens no flaky issue.
      const { json: pulls } = await client(env.GH_TOKEN)(
        'GET',
        `/repos/${env.GITHUB_REPOSITORY}/pulls?state=all&sort=created&direction=desc&per_page=50`,
      );
      const revert = revertForRun(pulls, env.RED_RUN);
      if (revert)
        return summary([
          '### Journeys settle: passed alone, but a merge was named',
          '',
          `${steps.join(', ')} passed alone on \`${env.BAD.slice(0, 10)}\`, and the revert on main opened #${revert.number} for this red, so no \`flaky\` issue opens: the revert and its break issue decide.`,
        ]);
    }
    const notes = settleNotes({
      steps,
      back,
      sha: env.BAD,
      runUrl: env.RUN_URL,
      redRunUrl: `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.RED_RUN}`,
      at: new Date().toISOString(),
      // The set-aside's money guard at this checkout (main): a money step's flaky issue carries `money-flaky`.
      money: guardOrAllMoney(),
    });
    summary([
      `### Journeys settle: ${back === true ? 'flaky, main counts green' : back === false ? 'broken on main' : 'did not finish'}`,
      '',
      ...(await noteBreakIssues(env.GH_TOKEN, env.GITHUB_REPOSITORY, notes)),
    ]);
    return;
  }
  const notes = backNotes({ steps: parseSteps(env.STEPS), back, sha: env.BAD, runUrl: env.RUN_URL });
  const record = [];
  if (/^\d+$/.test(env.REVERT_PR ?? '')) {
    const gh = client(env.GH_TOKEN);
    const { json: pr } = await gh('GET', `/repos/${env.GITHUB_REPOSITORY}/pulls/${env.REVERT_PR}`);
    const rec = recoveryRecord({
      revertPr: Number(env.REVERT_PR),
      revertBody: pr?.body,
      steps: parseSteps(env.STEPS),
      repair: env.BAD,
      confirmRun: env.RUN_URL,
      back,
      at: new Date().toISOString(),
    });
    const r = await gh('POST', `/repos/${env.GITHUB_REPOSITORY}/issues/${env.REVERT_PR}/comments`, { body: recoveryComment(rec) });
    record.push(`- recovery record on #${env.REVERT_PR}: ${r.status === 201 || r.status === 0 ? 'written' : `HTTP ${r.status}`}`);
  }
  summary([
    `### Journeys revert, confirm: ${back === true ? 'back' : back === false ? 'still red' : 'did not finish'}`,
    '',
    ...(await noteBreakIssues(env.GH_TOKEN, env.GITHUB_REPOSITORY, notes)),
    ...record,
  ]);
  if (back !== true) return 1;
}

/** Files for the confirm run: the journey files of the steps at main's head (BAD). */
async function confirmFiles(env) {
  need(env, 'STEPS', 'BAD');
  if (!SHA.test(env.BAD)) throw new Error('BAD must be a full commit sha');
  const files = journeyFilesOf(
    parseSteps(env.STEPS),
    git('ls-tree', '--name-only', `${env.BAD}:${REAL_APP.slice(0, -1)}`)
      .split('\n')
      .filter((f) => f.endsWith('.pw.mjs')),
  );
  if (!files.length) throw new Error(`no journey file for ${env.STEPS}`);
  output({ files: files.join(' '), steps: parseSteps(env.STEPS).join(',') });
}

const COMMANDS = { trigger, find, open, settle, early, confirm, back, 'confirm-files': confirmFiles, refresh };
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const cmd = COMMANDS[process.argv[2]];
  if (!cmd) {
    console.error('usage: journeys-revert.mjs trigger|find|open|settle');
    process.exit(2);
  }
  cmd(process.env)
    .then((code) => process.exit(code ?? 0))
    .catch((e) => {
      console.error(`✖ journeys-revert ${process.argv[2]}: ${e.message}`);
      process.exit(1);
    });
}
