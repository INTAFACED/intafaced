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
 *   early    Main's own journeys run, beside its shards (real-app-journeys.yml `early-break`): reads each shard's report as
 *            its job ends and, on a step that passed in the run before and failed outright in that shard, starts the same
 *            revert jobs at once, before the other shards and the whole run end (plant 1, project-state #2065: its failing
 *            shard ended 7 minutes before its run). `trigger` at the run's end starts nothing a run already started.
 *   confirm  After a revert this opened merges (journeys-back.yml, on the push): starts main-bisect.yml's `confirm` job,
 *            which runs the failing journeys alone on main's head in their own group, so the break shows as back in one
 *            journey's time instead of behind main's queue and a full run. Main's full run still runs to its end.
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
 *   node tooling/ci/journeys-revert.mjs --self-test
 *   DRY_RUN=1: reads for real, prints each write instead of sending it
 *   (trigger) GH_TOKEN GITHUB_REPOSITORY WORKFLOW_ID RUN_ID HEAD_SHA
 *   (find)    GH_TOKEN GITHUB_REPOSITORY GOOD BAD STEPS RED_RUN BASE   (writes GITHUB_OUTPUT)
 *   (open)    FACTORY_APP_KEY GITHUB_REPOSITORY CULPRIT BASE RED_RUN STEPS
 *   (early)   GH_TOKEN GITHUB_REPOSITORY WORKFLOW_ID RUN_ID HEAD_SHA
 *   (confirm) GH_TOKEN GITHUB_REPOSITORY HEAD_SHA SUBJECT
 *   (back)    GH_TOKEN GITHUB_REPOSITORY STEPS BAD BACK RUN_URL;  (confirm-files) STEPS BAD   (writes GITHUB_OUTPUT)
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JOURNEYS_ARTIFACT, JOURNEYS_WORKFLOW, stepStates } from './post-merge-trust.mjs';
import { journeyTouch } from './journey-touch.mjs';
import { SUBSCRIBES, loadMap, runsBehind } from './journey-reach-map.mjs';
import { evaluateGateFileRule } from '../scripts/gate-file-guard.mjs';
import { parseJobs, parseTests } from './bisect-main.mjs';

const SHA = /^[0-9a-f]{40}$/;
const STEP = /^J-[a-z0-9-]+-\d+#\d+$/;
const STEP_TITLE = /^(J-[a-z0-9-]+-\d+)\s+#(\d+)\b/;
const BASE = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._/-]{1,200}$/;
const REAL_APP = 'apps/customer/tests/real-app/';
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
 *  `now`. Sorted. A step red in `previous` as well started its revert a run ago, so it never starts another. */
export function revertSteps(previous, now) {
  const before = stepStates(previous);
  return [...outrightStates(now)]
    .filter(([key, state]) => state === 'failed' && before.get(key) === 'passed')
    .map(([key]) => key)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
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
  return evaluateGateFileRule('', files).gateFiles.length ? `ci: ${base.charAt(0).toLowerCase()}${base.slice(1)}` : base;
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
async function startRevert(gh, repo, { good, bad, steps, redRun, confirm = false, revertPr = null }) {
  const { json } = await gh('GET', `/repos/${repo}/actions/workflows/main-bisect.yml/runs?per_page=50`);
  const titles = (json?.workflow_runs ?? []).map((r) => r.display_title ?? r.name);
  const covered = confirm ? new Set() : coveredSteps(titles, bad);
  const left = steps.filter((x) => !covered.has(x));
  if (!left.length) return [];
  const inputs = {
    good,
    bad,
    journeys: left.join(','),
    red_run: String(redRun),
    base: 'main',
    ...(confirm ? { confirm: 'true', revert_pr: String(revertPr) } : {}),
  };
  const r = await gh('POST', `/repos/${repo}/actions/workflows/main-bisect.yml/dispatches`, { ref: 'main', inputs });
  return r.status === 204 || r.status === 0 ? left : null;
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
  const steps = revertSteps(prev, now);
  if (!steps.length)
    return summary([
      `Journeys revert: no step passed on \`${prevRun.head_sha.slice(0, 10)}\` and then failed outright; nothing to revert.`,
    ]);
  if (prevRun.head_sha === run.head_sha)
    return summary([
      `Journeys revert: ${steps.join(', ')} broke with no commit between the runs (flaky or outside the code); nothing to revert.`,
    ]);
  const started = await startRevert(gh, repo, { good: prevRun.head_sha, bad: run.head_sha, steps, redRun: run.id });
  summary([
    `### Journeys revert`,
    '',
    `${steps.join(', ')} passed on \`${prevRun.head_sha.slice(0, 10)}\` (run ${prevRun.id}) and failed outright on \`${run.head_sha.slice(0, 10)}\` (run ${run.id}).`,
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
  // `untraced`: a confirmed red that names no single merge (OWNER 289 item 6), so revert-unknown labels its issue.
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
 * What goes on each failing journey's break issue: the revert's link and `regression`, or, when the red traces to no
 * single merge, why and `main-unknown-red` (a builder takes only that while it is open: project-state BUILDER.md). Pure.
 */
export function breakIssueNotes({ steps, revertUrl, reason, redRunUrl }) {
  return journeysOf(steps).map((journey) => ({
    title: `${BREAK_ISSUE_PREFIX}${journey}`,
    labels: revertUrl ? ['regression'] : [UNKNOWN_LABEL],
    // Only a traced red opens its issue: an untraced one may be the stack's own, and main-unknown-red stops every builder.
    opens: Boolean(revertUrl),
    body: revertUrl
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

/** The red traced to no single merge (revert-find or the probe named none): note it on each journey's break issue. */
/** Why no one is blamed. CONTROL_FAILED: the probe saw a candidate fail, but the control (the last passing commit, run
 *  again beside it) failed or did not run too. Pure. */
export function unknownReason({ REASON, PROBED, GOOD }) {
  if (REASON !== 'CONTROL_FAILED') return String(REASON);
  const at = (x) => (SHA.test(x ?? '') ? `\`${x.slice(0, 10)}\`` : 'an unnamed commit');
  return `the steps fail on ${at(PROBED)}, but also fail (or did not run) on ${at(GOOD)}, the last commit where they passed, run again on the same kind of runner: the red is not that merge's, so no one is blamed`;
}

async function unknown(env) {
  need(env, 'GITHUB_REPOSITORY', 'STEPS', 'RED_RUN', 'REASON');
  if (!/^\d+$/.test(env.RED_RUN)) throw new Error('RED_RUN must be a run id');
  const repo = env.GITHUB_REPOSITORY;
  const reason = unknownReason(env);
  const notes = breakIssueNotes({
    steps: parseSteps(env.STEPS),
    reason: reason.slice(0, 300),
    redRunUrl: `https://github.com/${repo}/actions/runs/${env.RED_RUN}`,
  });
  summary(['### Journeys revert: no single merge found', '', reason, '', ...(await noteBreakIssues(env.GH_TOKEN, repo, notes))]);
}

async function open(env) {
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

  const { mintToken } = await import('./factory-builder.mjs');
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
        `The ${what} [run ${env.RED_RUN}](${runUrl}) on \`${env.BASE}\` failed ${stepText}, and the revert on main found this pull request's commit \`${sha.slice(0, 10)}\` as the cause. Its revert doesn't apply cleanly on \`${env.BASE}\`, so no revert was opened. Fix it forward or revert it by hand.\n\n_Posted by tooling/ci/journeys-revert.mjs._`,
      );
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
      const notes = breakIssueNotes({ steps, revertUrl: `https://github.com/${repo}/pull/${number}`, redRunUrl: runUrl });
      summary(['', ...(await noteBreakIssues(env.ISSUES_TOKEN, repo, notes).catch((e) => [`- Break issue not noted: ${e.message}`]))]);
    }
  } finally {
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
        throw new Error(`the revert token may still be live (revoke ${end.status}, then ${after.status} after ${after.tries} tries)`);
      console.log(`the revert token is revoked: GitHub now refuses it (401, after ${after.tries} tries)`);
    }
  }
}

/** How many times, and how long apart, a revoked token's refusal is asked for: about 20 s in all. */
export const REVOKE_PROBES = [0, 1000, 2000, 3000, 5000, 8000];
/**
 * Whether GitHub refuses a revoked token: `probe()` answers the HTTP status of a read made with it. Only a 401 counts as
 * refused; any other answer (200, a 5xx) is asked again after the next wait, and still not 401 after the last one is not
 * refused. `sleep` stands in for setTimeout in the self-test.
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

// ── self-test ──────────────────────────────────────────────────────────────

function selfTest() {
  const eq = (got, want, m) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${m}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  };
  const spec = (title, ...statuses) => ({ title, file: 'J-a-01.pw.mjs', tests: statuses.map((status) => ({ status })) });
  const report = (...specs) => ({ suites: [{ title: 'J-a-01.pw.mjs', file: 'J-a-01.pw.mjs', specs }] });
  const pass = report(spec('J-a-01 #1 x', 'expected'), spec('J-a-01 #2 y', 'expected'));
  const red = report(spec('J-a-01 #1 x', 'expected'), spec('J-a-01 #2 y', 'unexpected'));
  const flaky = report(spec('J-a-01 #1 x', 'expected'), spec('J-a-01 #2 y', 'flaky'));
  eq([...outrightFailures(red)], [['J-a-01#2', 'J-a-01.pw.mjs']], 'an unexpected test fails its step outright, with its file');
  eq([...outrightFailures(flaky)], [], 'a pass on the retry is not an outright failure');
  eq(revertSteps(pass, red), ['J-a-01#2'], 'passed, then failed outright: revert at once');
  eq(revertSteps(pass, flaky), [], 'planted fault: a pass on the retry reverts nothing (the verdict sets it aside)');
  eq(revertSteps(pass, pass), [], 'known-good: green runs revert nothing');
  eq(revertSteps(red, red), [], 'a step already red started its revert a run ago, so it never starts another');
  eq(parseSteps('J-a-01#2, J-a-01#10 J-a-01#2'), ['J-a-01#2', 'J-a-01#10'], 'steps parse, dedupe, numeric order');
  let threw = false;
  try {
    parseSteps('J-a-01#2;rm -rf /');
  } catch {
    threw = true;
  }
  eq(threw, true, 'a malformed step input is refused');
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const C = 'c'.repeat(40);
  eq(narrow([], () => ({})).none.startsWith('no commit'), true, 'no commit: nothing blamed');
  eq(narrow([A], () => ({ reaches: true, why: 'x' })).probe, [A], 'one commit that can reach the journey is probed, never blamed unproven');
  eq(
    narrow([A], () => ({ reaches: false, why: 'x' })).none?.startsWith('no commit in the range'),
    true,
    'one commit that cannot is blamed for nothing',
  );
  const reach = { [A]: { reaches: false, why: 'none' }, [B]: { reaches: true, why: 'x' }, [C]: { reaches: false, why: 'none' } };
  eq(narrow([A, B, C], (s) => reach[s]).probe, [B], 'the one commit of several that can reach the journey is probed');
  eq(narrow([A, B, C], () => ({ reaches: false, why: '' })).none?.startsWith('no commit in the range'), true, 'none can reach');
  eq(narrow([A, B, C], () => ({ reaches: true, why: '' })).probe, [A, B, C], 'several can reach: probe');
  const atHead = () => true;
  eq(commitReaches(['tooling/ci/gates.mjs'], ['J-a-01.pw.mjs'], null, atHead).reaches, false, 'a CI-only commit cannot reach a journey');
  eq(commitReaches(['services/svc-x/src/a.ts'], ['J-a-01.pw.mjs'], null, atHead).reaches, true, 'product code without a map reaches all');
  eq(commitReaches([`${REAL_APP}J-a-01.pw.mjs`], ['J-a-01.pw.mjs'], null, atHead).reaches, true, "a failing journey's own file reaches it");
  eq(commitReaches([`${REAL_APP}J-b-02.pw.mjs`], ['J-a-01.pw.mjs'], null, atHead).reaches, false, "another journey's file does not");
  eq(subjectPr('feat: x (#7602)'), 7602, 'squash subject names its pull request');
  eq(subjectPr('feat: x'), null, 'no number');
  const ok = { subject: 'feat: x (#1)', parents: 1, files: ['apps/x.ts'], pr: { number: 1, head: { ref: 'feat/x' } } };
  eq(refuseRevert(ok), null, 'a squash commit reverts');
  eq(refuseRevert({ ...ok, subject: 'Revert "feat: x" (#2)' }) !== null, true, 'never revert a revert (subject)');
  eq(refuseRevert({ ...ok, pr: { number: 2, head: { ref: 'revert/auto-abc' } } }) !== null, true, 'never revert a revert (branch)');
  eq(refuseRevert({ ...ok, parents: 2 }) !== null, true, 'a merge commit is not reverted');
  eq(refuseRevert({ ...ok, files: ['.github/workflows/ci.yml'] }) !== null, true, 'a workflow change is not reverted by the App');
  eq(revertBranch(A), 'revert/auto-aaaaaaaaaa', 'branch name');
  eq(
    revertTitle({ prNumber: 7, sha: A, files: ['apps/x.ts'], redRun: 9 }),
    'Revert #7, which turned the Real-app journeys red (run 9)',
    'title',
  );
  eq(
    revertTitle({ prNumber: 7, sha: A, files: ['tooling/ci/gates.mjs'], redRun: 9 }).startsWith('ci: revert #7'),
    true,
    'a gate revert says ci:',
  );
  eq(/J-[a-z]/.test(revertTitle({ prNumber: 7, sha: A, files: [], redRun: 9 })), false, 'no journey step in the title');
  const body = revertBody({ repo: 'o/r', sha: A, subject: 's (#7)', prNumber: 7, redRun: 9, steps: ['J-a-01#2'], base: 'main' });
  eq(
    ['actions/runs/9', '`J-a-01 #2`', '#7'].every((t) => body.includes(t)),
    true,
    'body names the red run, the steps and the culprit',
  );
  // One revert for both reds: a CI red names its run, its test files and its probed jobs, and its title says CI.
  eq(
    revertTitle({ prNumber: 7, sha: A, files: ['apps/x.ts'], redRun: 9, kind: 'ci' }),
    "Revert #7, which turned main's CI red (run 9)",
    'a CI revert title',
  );
  const ciText = failingText({ kind: 'ci', tests: ['tooling/ci/journey-reach-map.test.mjs'], jobs: ['Doctrine gates'] });
  eq(ciText, '`tooling/ci/journey-reach-map.test.mjs`, the Doctrine gates job', 'a CI red names its files and jobs');
  const ciBody = revertBody({ repo: 'o/r', sha: A, subject: 's (#7)', prNumber: 7, redRun: 9, steps: [], base: 'main', failing: ciText });
  eq(
    ['actions/runs/9', 'the Doctrine gates job', '#7'].every((t) => ciBody.includes(t)),
    true,
    'a CI body names the run, the job and the culprit',
  );
  eq(failingText({ kind: 'journeys', steps: ['J-a-01#2'] }), '`J-a-01 #2`', 'a journeys red names its steps');
  // OWNER 289 item 6: the one break issue per journey gets the revert's link and `regression`, or `main-unknown-red`.
  eq(journeysOf(['J-a-01#2', 'J-a-01#3', 'J-b-02#1']), ['J-a-01', 'J-b-02'], 'each failing journey once, in order');
  const linked = breakIssueNotes({ steps: ['J-a-01#2', 'J-a-01#3'], revertUrl: 'https://github.com/o/r/pull/9', redRunUrl: 'u' });
  eq(
    linked.map((n) => [n.title, n.labels]),
    [['Journey broken on main: J-a-01', ['regression']]],
    "a revert notes the journey's one issue as a regression",
  );
  eq(linked[0].body.includes('https://github.com/o/r/pull/9'), true, 'the note links the revert');
  eq(linked[0].opens, true, 'a traced red opens its journey issue when main trust has not yet');
  eq(linked[0].body.includes('<!-- steps: J-a-01#2, J-a-01#3 -->'), true, 'the opened issue names its steps, so main trust can close it');
  const untraced = breakIssueNotes({ steps: ['J-b-02#1'], reason: 'no commit between them can reach J-b-02', redRunUrl: 'u' });
  eq(
    untraced.map((n) => n.labels),
    [['main-unknown-red']],
    'a red traced to no single merge is main-unknown-red',
  );
  eq(untraced[0].body.includes('no commit between them can reach J-b-02'), true, 'the note says why');
  eq(untraced[0].opens, false, 'an untraced red opens no issue: main-unknown-red stops every builder');
  // fix-01, act on the job: an early start, once; the break back when its journey passes alone on main's head.
  eq(
    [shardOf('Journeys (shard 17 of 32)'), shardOf('real-app-journeys-shard-3'), shardOf('Journeys revert'), shardOf('real-app-journeys')],
    [17, 3, null, null],
    'shard numbers',
  );
  eq(
    joinReports([report(spec('J-a-01 #1 x', 'expected')), report(spec('J-a-01 #2 y', 'unexpected'))]).suites.length,
    2,
    'shard reports join',
  );
  eq(revertSteps(pass, joinReports([red])), ['J-a-01#2'], "a shard's report alone starts the revert");
  eq(bisectTitle(A, ['J-a-01#2', 'J-b-02#1']), `Main bisect ${A} J-a-01#2,J-b-02#1`, 'the run name');
  eq(
    [...coveredSteps([bisectTitle(A, ['J-a-01#2']), bisectTitle(B, ['J-c-03#1']), 'Main bisect', null], A)],
    ['J-a-01#2'],
    "only that commit's started steps",
  );
  eq(
    endedShards(
      [
        { name: 'Journeys (shard 1 of 2)', status: 'completed' },
        { name: 'Journeys (shard 2 of 2)', status: 'in_progress' },
        { name: 'What this run runs', status: 'completed' },
      ],
      new Set(),
    ).map((j) => j.shard),
    [1],
    'only shard jobs that ended',
  );
  eq(endedShards([{ name: 'Journeys (shard 1 of 2)', status: 'completed' }], new Set([1])), [], 'a shard is read once');
  eq(
    revertMergePull('Revert #7929, which turned the Real-app journeys red (run 42970678172) (#7936)'),
    7936,
    "the revert's own pull request",
  );
  eq(revertMergePull('ci: revert #7, which turned the Real-app journeys red (run 9) (#8)'), 8, 'a gate revert');
  eq(
    [
      revertMergePull('Revert #7929, which turned the Real-app journeys red (run 1)'),
      revertMergePull('Revert "x" (#5)'),
      revertMergePull("Revert #7, which turned main's CI red (run 9) (#8)"),
    ],
    [null, null, null],
    'anything else is not one',
  );
  eq(failingSteps('x\n- Failing: `J-home-ia-07 #4`, `J-a-01 #12`\n- Culprit: #1'), ['J-home-ia-07#4', 'J-a-01#12'], 'the failing steps');
  eq(
    journeyFilesOf(['J-a-01#2'], ['J-a-01.pw.mjs', 'J-a-01-lookup.pw.mjs', 'J-a-010.pw.mjs', 'J-a-02.pw.mjs']),
    ['J-a-01-lookup.pw.mjs', 'J-a-01.pw.mjs'],
    "the journey's own files",
  );
  const backed = backNotes({ steps: ['J-a-01#2'], back: true, sha: A, runUrl: 'u' });
  eq(
    [backed[0].title, backed[0].labels, backed[0].opens, /the break is back/.test(backed[0].body)],
    ['Journey broken on main: J-a-01', [], false, true],
    'back: a comment, no label, no new issue',
  );
  eq(/not back/.test(backNotes({ steps: ['J-a-01#2'], back: false, sha: A, runUrl: 'u' })[0].body), true, 'still red says so');
  eq(
    /did not finish/.test(backNotes({ steps: ['J-a-01#2'], back: null, sha: A, runUrl: 'u' })[0].body),
    true,
    'a run that broke says nothing',
  );
  // #7936, plant 1's own revert, as it merged.
  eq(
    failingSteps(
      'Automatic revert by the revert on main.\n\n- Red run: https://github.com/INTAFACED/intafaced/actions/runs/42970678172 on `main`\n- Failing: `J-home-ia-07 #4`\n- Culprit: #7929',
    ),
    ['J-home-ia-07#4'],
    "plant 1's revert body",
  );
  // The control and the recovery record.
  const ctlBody = revertBody({
    repo: 'o/r',
    sha: A,
    subject: 's (#7)',
    prNumber: 7,
    redRun: 9,
    steps: ['J-a-01#2'],
    base: 'main',
    control: B,
  });
  eq(/^- Control: `bbbbbbbbbb`, the last commit/m.test(ctlBody), true, 'the control line');
  eq(
    /- Control:/.test(revertBody({ repo: 'o/r', sha: A, subject: 's', prNumber: 7, redRun: 9, steps: ['J-a-01#2'], base: 'main' })),
    false,
    'no control, no line',
  );
  const rec = recoveryRecord({ revertPr: 8, revertBody: ctlBody, steps: ['J-a-01#2'], repair: C, confirmRun: 'u', back: true, at: 't' });
  eq(
    [rec.red_run, rec.blamed, rec.control, rec.confirm.result],
    [9, { pr: 7, sha: A.slice(0, 10) }, { sha: B.slice(0, 10), passed: true }, 'pass'],
    'the record from the body',
  );
  eq(parseRecord(recoveryComment(rec)), rec, 'the record reads back');
  eq([parseRecord('no mark'), parseRecord(`<!-- ${RECORD_MARK} {bad} -->`)], [null, null], 'no record, or a broken one, reads as none');
  eq(
    recoveryRecord({ revertPr: 8, revertBody: 'x', steps: [], repair: C, confirmRun: 'u', back: null, at: 't' }).confirm.result,
    'unfinished',
    'an unfinished confirm',
  );
  eq(
    /fail on `aaaaaaaaaa`, but also fail .* on `bbbbbbbbbb`.*no one is blamed/.test(
      unknownReason({ REASON: 'CONTROL_FAILED', PROBED: A, GOOD: B }),
    ),
    true,
    'a failed control blames no one',
  );
  eq(unknownReason({ REASON: 'x' }), 'x', 'any other reason as given');
  console.log('✓ journeys-revert --self-test OK (67 fixtures)');
}

async function selfTestRevoke() {
  const eq = (got, want, m) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${m}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  };
  const answers = (...list) => {
    const left = [...list];
    return async () => left.shift() ?? 200;
  };
  const sleep = async () => {};
  eq(await refusedAfterRevoke(answers(401), { sleep }), { refused: true, status: 401, tries: 1 }, 'refused at once');
  eq(
    await refusedAfterRevoke(answers(200, 200, 401), { sleep }),
    { refused: true, status: 401, tries: 3 },
    'refused once the revoke lands',
  );
  eq(await refusedAfterRevoke(answers(502, 401), { sleep }), { refused: true, status: 401, tries: 2 }, 'a 5xx is asked again');
  eq(
    await refusedAfterRevoke(answers(), { sleep }),
    { refused: false, status: 200, tries: REVOKE_PROBES.length },
    'still live: not refused',
  );
  eq(
    await refusedAfterRevoke(answers(403, 403, 403, 403, 403, 403), { sleep }),
    { refused: false, status: 403, tries: 6 },
    'only a 401 counts',
  );
  const slept = [];
  await refusedAfterRevoke(answers(), { sleep: async (ms) => slept.push(ms) });
  eq(slept, REVOKE_PROBES.filter(Boolean), 'waits between tries');
  console.log('✓ journeys-revert revoke self-test OK (6 fixtures)');
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
      const steps = revertSteps(prev, report);
      if (!steps.length) continue;
      const started = await startRevert(gh, repo, { good: prevRun.head_sha, bad: env.HEAD_SHA, steps, redRun: env.RUN_ID });
      lines.push(
        `- shard ${shard}: ${steps.join(', ')} passed on \`${prevRun.head_sha.slice(0, 10)}\` and failed outright here: ${started === null ? 'dispatch failed' : started.length ? `main-bisect.yml started for ${started.join(', ')}` : 'already started'}`,
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
  summary([
    `### Journeys revert, confirm`,
    '',
    started?.length
      ? `#${n} merged as \`${env.HEAD_SHA.slice(0, 10)}\`: main-bisect.yml runs ${steps.join(', ')} alone on it.`
      : 'Dispatch failed.',
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

async function back(env) {
  need(env, 'GITHUB_REPOSITORY', 'STEPS', 'BAD', 'RUN_URL');
  if (!SHA.test(env.BAD)) throw new Error('BAD must be a full commit sha');
  const back = env.BACK === 'true' ? true : env.BACK === 'false' ? false : null;
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

const COMMANDS = { trigger, find, open, unknown, early, confirm, back, 'confirm-files': confirmFiles };
if (process.argv.includes('--self-test')) {
  selfTest();
  await selfTestRevoke();
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = COMMANDS[process.argv[2]];
  if (!cmd) {
    console.error('usage: journeys-revert.mjs trigger|find|open|unknown|--self-test');
    process.exit(2);
  }
  cmd(process.env)
    .then((code) => process.exit(code ?? 0))
    .catch((e) => {
      console.error(`✖ journeys-revert ${process.argv[2]}: ${e.message}`);
      process.exit(1);
    });
}
