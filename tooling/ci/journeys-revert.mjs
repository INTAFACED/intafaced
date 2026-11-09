#!/usr/bin/env node
/**
 * JOURNEYS REVERT: when main's Real-app journeys turn red, find the one merged pull request that did it and open its
 * revert (workflow: main-bisect.yml, the `Journeys revert` jobs). OWNER 249 (3): "a red main is reverted".
 *
 *   trigger  Main trust's post-merge job, after a Real-app journeys run on main: a step that passed two runs ago and
 *            failed outright (not only on its retry) in the run before and in this one is a confirmed break (the next
 *            run is the journeys' re-run, as in post-merge-trust.mjs). It dispatches the revert jobs once, with the
 *            last passing commit, the first failing commit, that run and the broken steps. A flaky step (passed on its
 *            retry) never counts: the verdict sets it aside instead.
 *   find     The commits between the good and the bad commit (first parent, oldest first). The red run must show the
 *            named steps failing outright on the bad commit, or nothing is reverted (a known-good state opens nothing).
 *            One commit: that is the culprit. More: only the commits whose changed files can reach a failing journey
 *            (journey-touch.mjs with the touched-journeys map: a full-suite path or a failing journey's file) stay. One
 *            left: the culprit; none: no commit is blamed; several: the probe job runs the failing journey files on
 *            them by binary search (journeys-revert-probe.mjs).
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
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JOURNEYS_ARTIFACT, JOURNEYS_WORKFLOW, confirmedBreaks, stepStates } from './post-merge-trust.mjs';
import { journeyTouch } from './journey-touch.mjs';
import { SUBSCRIBES, loadMap, runsBehind } from './journey-reach-map.mjs';
import { evaluateGateFileRule } from '../scripts/gate-file-guard.mjs';

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
        out.set(`${m[1]}#${Number(m[2])}`, String(spec.file ?? f ?? '').split('/').pop());
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

/** The steps to revert for, from the three newest runs' reports (oldest first): passed in `older`, failed outright in
 *  `previous` and `now`. Sorted, flat. */
export function revertSteps(older, previous, now) {
  return [...confirmedBreaks(stepStates(older), outrightStates(previous), outrightStates(now)).values()].flat();
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
  return hit.length ? { reaches: true, why: `reaches ${hit.join(', ')}` } : { reaches: false, why: `${t.mode}: ${t.files.join(', ') || 'no journey'}` };
}

/**
 * The culprit from the commits (oldest first): { culprit } | { none: why } | { probe: [sha] }. `reachOf(sha)` says
 * whether that commit can reach a failing journey.
 */
export function narrow(commits, reachOf) {
  if (!commits.length) return { none: 'no commit lies between the good and the bad commit, so no commit broke it' };
  if (commits.length === 1) return { culprit: commits[0], lines: [`\`${commits[0].slice(0, 10)}\`: the one commit in the range`] };
  const lines = [];
  const kept = [];
  for (const sha of commits) {
    const r = reachOf(sha);
    lines.push(`\`${sha.slice(0, 10)}\`: ${r.reaches ? 'kept' : 'cannot reach the failing journeys'} (${r.why})`);
    if (r.reaches) kept.push(sha);
  }
  if (!kept.length) return { none: 'no commit in the range can reach the failing journeys', lines };
  if (kept.length === 1) return { culprit: kept[0], lines };
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
export function revertTitle({ prNumber, sha, files, redRun }) {
  const what = prNumber ? `#${prNumber}` : `\`${sha.slice(0, 10)}\``;
  const base = `Revert ${what}, which turned the Real-app journeys red (run ${redRun})`;
  return evaluateGateFileRule('', files).gateFiles.length ? `ci: ${base.charAt(0).toLowerCase()}${base.slice(1)}` : base;
}

export function revertBody({ repo, sha, subject, prNumber, redRun, steps, base }) {
  return [
    `Automatic revert by the journeys revert (tooling/ci/journeys-revert.mjs, OWNER 249 (3): "a red main is reverted").`,
    '',
    `- Red run: https://github.com/${repo}/actions/runs/${redRun} on \`${base}\``,
    `- Failing steps: ${steps.map((s) => `\`${s.replace('#', ' #')}\``).join(', ')}`,
    `- Culprit: ${prNumber ? `#${prNumber}` : 'no pull request found'}, commit \`${sha.slice(0, 10)}\` ${subject}`,
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
    if (res.status === 403 || res.status === 429) throw new Error(`GitHub ${res.status} on ${method} ${path.split('?')[0]}: stopping, not retrying`);
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, json };
  };
}

/** A JSON file of a run's journeys artifact, or null when it kept none. */
async function runReport(gh, repo, runId, token) {
  const { json } = await gh('GET', `/repos/${repo}/actions/runs/${runId}/artifacts?name=${JOURNEYS_ARTIFACT}&per_page=5`);
  const artifact = (json?.artifacts ?? []).find((a) => a.name === JOURNEYS_ARTIFACT && !a.expired);
  if (!artifact) return null;
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

// ── trigger ────────────────────────────────────────────────────────────────

async function trigger(env) {
  need(env, 'GITHUB_REPOSITORY', 'WORKFLOW_ID', 'RUN_ID', 'HEAD_SHA');
  const repo = env.GITHUB_REPOSITORY;
  const gh = client(env.GH_TOKEN);
  const { json: run } = await gh('GET', `/repos/${repo}/actions/runs/${env.RUN_ID}`);
  if (!run?.created_at) throw new Error(`could not read run ${env.RUN_ID}`);
  if (run.head_branch !== 'main') return summary([`Journeys revert: run ${env.RUN_ID} is not on main; nothing to do.`]);
  const { json } = await gh('GET', `/repos/${repo}/actions/workflows/${env.WORKFLOW_ID}/runs?branch=main&status=completed&per_page=100`);
  // The same earlier runs post-merge-trust.mjs compares with: main's own finished runs before this one; a replaced
  // (cancelled) run is left out.
  const earlier = (json?.workflow_runs ?? [])
    .filter(
      (r) =>
        r.id !== run.id &&
        r.created_at < run.created_at &&
        ['push', 'workflow_dispatch', 'schedule'].includes(r.event) &&
        ['success', 'failure', 'timed_out'].includes(r.conclusion),
    )
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const [prevRun, olderRun] = earlier;
  if (!prevRun || !olderRun) return summary(['Journeys revert: fewer than two earlier finished runs on main; nothing to compare.']);
  const [now, prev, older] = [await runReport(gh, repo, run.id, env.GH_TOKEN), await runReport(gh, repo, prevRun.id, env.GH_TOKEN), await runReport(gh, repo, olderRun.id, env.GH_TOKEN)];
  if (!now || !prev || !older) return summary(['Journeys revert: one of the three runs kept no journey report; nothing is reverted.']);
  const steps = revertSteps(older, prev, now);
  if (!steps.length) return summary([`Journeys revert: no step passed on \`${olderRun.head_sha.slice(0, 10)}\` and then failed outright twice; nothing to revert.`]);
  if (olderRun.head_sha === prevRun.head_sha)
    return summary([`Journeys revert: ${steps.join(', ')} broke with no commit between the runs (flaky or outside the code); nothing to revert.`]);
  const inputs = { good: olderRun.head_sha, bad: prevRun.head_sha, journeys: steps.join(','), red_run: String(prevRun.id), base: 'main' };
  const r = await gh('POST', `/repos/${repo}/actions/workflows/main-bisect.yml/dispatches`, { ref: 'main', inputs });
  summary([
    `### Journeys revert`,
    '',
    `${steps.join(', ')} passed on \`${olderRun.head_sha.slice(0, 10)}\` (run ${olderRun.id}) and failed outright on \`${prevRun.head_sha.slice(0, 10)}\` (run ${prevRun.id}) and \`${run.head_sha.slice(0, 10)}\` (run ${run.id}).`,
    r.status === 204 || r.status === 0 ? 'Dispatched main-bisect.yml to find the culprit and open its revert.' : `Dispatch failed: HTTP ${r.status}`,
  ]);
  if (r.status !== 204 && r.status !== 0) return 1;
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
  const none = (why, lines = []) => {
    summary(['### Journeys revert: nothing reverted', '', why, ...(lines.length ? ['', ...lines.map((l) => `- ${l}`)] : [])]);
    output({ culprit: '', probe: 'false' });
  };

  const { json: run } = await gh('GET', `/repos/${repo}/actions/runs/${env.RED_RUN}`);
  if (run?.name !== JOURNEYS_WORKFLOW) return none(`Run ${env.RED_RUN} is not a ${JOURNEYS_WORKFLOW} run.`);
  if (run.head_sha !== env.BAD) return none(`Run ${env.RED_RUN} ran \`${run.head_sha?.slice(0, 10)}\`, not the bad commit \`${env.BAD.slice(0, 10)}\`.`);
  if (run.head_branch !== env.BASE) return none(`Run ${env.RED_RUN} ran on \`${run.head_branch}\`, not \`${env.BASE}\`.`);
  const report = await runReport(gh, repo, env.RED_RUN, env.GH_TOKEN);
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
  if (commits.length > MAX_COMMITS) return none(`${commits.length} commits lie between them, more than ${MAX_COMMITS}.`);

  let reach = null;
  const map = loadMap();
  if (map) {
    const { json: runs } = await gh('GET', `/repos/${repo}/actions/workflows/real-app-journeys.yml/runs?branch=main&status=completed&per_page=30`);
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
  if (result.none) return none(result.none, result.lines);
  if (result.probe) {
    summary([...head, `${result.probe.length} commits can reach them: the probe runs ${files.join(', ')} on them by binary search.`]);
    return output({ culprit: '', probe: 'true', candidates: result.probe.join(' '), files: files.join(' '), steps: steps.join(',') });
  }
  summary([...head, `Culprit: \`${result.culprit.slice(0, 10)}\` ${git('log', '-1', '--format=%s', result.culprit)}`]);
  output({ culprit: result.culprit, probe: 'false', steps: steps.join(',') });
}

// ── open ───────────────────────────────────────────────────────────────────

async function open(env) {
  need(env, 'GITHUB_REPOSITORY', 'CULPRIT', 'BASE', 'RED_RUN', 'STEPS');
  const repo = env.GITHUB_REPOSITORY;
  if (!SHA.test(env.CULPRIT)) throw new Error('CULPRIT must be a full commit sha');
  if (!BASE.test(env.BASE) || !/^\d+$/.test(env.RED_RUN)) throw new Error('BASE or RED_RUN is malformed');
  const steps = parseSteps(env.STEPS);
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
    const stepText = steps.map((s) => `\`${s.replace('#', ' #')}\``).join(', ');

    const refused = refuseRevert({ subject, parents, files, pr });
    if (refused) {
      await comment(`The Real-app journeys [run ${env.RED_RUN}](${runUrl}) on \`${env.BASE}\` failed ${stepText}, and the journeys revert found this pull request's commit \`${sha.slice(0, 10)}\` as the cause. It opened no revert: ${refused}. Fix it forward or revert it by hand.\n\n_Posted by tooling/ci/journeys-revert.mjs._`);
      return summary([`Journeys revert: no revert of \`${sha.slice(0, 10)}\`: ${refused}.`]);
    }
    const exists = await gh('GET', `/repos/${repo}/branches/${encodeURIComponent(branch)}`);
    if (exists.status === 200) return summary([`Journeys revert: \`${branch}\` already exists, so its revert was opened before; nothing new.`]);

    git('checkout', '--quiet', '-B', branch, `origin/${env.BASE}`);
    try {
      execFileSync(
        'git',
        ['-c', 'user.name=intafaced-mac-agents[bot]', '-c', 'user.email=intafaced-mac-agents[bot]@users.noreply.github.com', 'revert', '--no-edit', sha],
        { stdio: 'pipe' },
      );
    } catch {
      execFileSync('git', ['revert', '--abort'], { stdio: 'ignore' });
      await comment(`The Real-app journeys [run ${env.RED_RUN}](${runUrl}) on \`${env.BASE}\` failed ${stepText}, and the journeys revert found this pull request's commit \`${sha.slice(0, 10)}\` as the cause. Its revert doesn't apply cleanly on \`${env.BASE}\`, so no revert was opened. Fix it forward or revert it by hand.\n\n_Posted by tooling/ci/journeys-revert.mjs._`);
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
    const title = revertTitle({ prNumber: pr?.number, sha, files, redRun: env.RED_RUN });
    const made = await gh('POST', `/repos/${repo}/pulls`, {
      title,
      head: branch,
      base: env.BASE,
      body: revertBody({ repo, sha, subject, prNumber: pr?.number, redRun: env.RED_RUN, steps, base: env.BASE }),
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
    await comment(`The Real-app journeys [run ${env.RED_RUN}](${runUrl}) on \`${env.BASE}\` failed ${stepText}, and the journeys revert found this pull request's commit \`${sha.slice(0, 10)}\` as the cause. Its revert is #${number ?? '(dry run)'}, with auto-merge ${armed.startsWith('armed') ? 'on' : 'off'}. To keep this change, fix it forward and close the revert.\n\n_Posted by tooling/ci/journeys-revert.mjs._`);
    summary([`### Journeys revert`, '', `Opened #${number ?? '(dry run)'}: ${title}`, `Auto-merge: ${armed}.`, `Culprit: ${pr ? `#${pr.number}` : 'no pull request'} \`${sha.slice(0, 10)}\` ${subject}`]);
  } finally {
    if (token && !dry) {
      // Revoke, then prove it: GitHub must refuse the token afterwards (401).
      const end = await fetch(`${API}/installation/token`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
      const after = await fetch(`${API}/repos/${repo}`, { headers: { authorization: `Bearer ${token}` } });
      if (end.status !== 204 || after.status !== 401) throw new Error(`the revert token may still be live (revoke ${end.status}, then ${after.status})`);
      console.log('the revert token is revoked: GitHub now refuses it (401)');
    }
  }
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
  eq(revertSteps(pass, red, red), ['J-a-01#2'], 'passed, then failed outright twice: revert');
  eq(revertSteps(pass, red, flaky), [], 'planted fault: flaky in the newest run reverts nothing');
  eq(revertSteps(pass, flaky, flaky), [], 'flaky twice reverts nothing (the verdict sets it aside)');
  eq(revertSteps(pass, pass, pass), [], 'known-good: green runs revert nothing');
  eq(revertSteps(red, red, red), [], 'a step that never passed reverts nothing');
  eq(revertSteps(pass, pass, red), [], 'one red run is not confirmed yet');
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
  eq(narrow([A], () => ({ reaches: false })).culprit, A, 'one commit is the culprit');
  const reach = { [A]: { reaches: false, why: 'none' }, [B]: { reaches: true, why: 'x' }, [C]: { reaches: false, why: 'none' } };
  eq(narrow([A, B, C], (s) => reach[s]).culprit, B, 'the one commit that can reach the journey');
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
  eq(revertTitle({ prNumber: 7, sha: A, files: ['apps/x.ts'], redRun: 9 }), 'Revert #7, which turned the Real-app journeys red (run 9)', 'title');
  eq(revertTitle({ prNumber: 7, sha: A, files: ['tooling/ci/gates.mjs'], redRun: 9 }).startsWith('ci: revert #7'), true, 'a gate revert says ci:');
  eq(/J-[a-z]/.test(revertTitle({ prNumber: 7, sha: A, files: [], redRun: 9 })), false, 'no journey step in the title');
  const body = revertBody({ repo: 'o/r', sha: A, subject: 's (#7)', prNumber: 7, redRun: 9, steps: ['J-a-01#2'], base: 'main' });
  eq(['actions/runs/9', '`J-a-01 #2`', '#7'].every((t) => body.includes(t)), true, 'body names the red run, the steps and the culprit');
  console.log('✓ journeys-revert --self-test OK (31 fixtures)');
}

const COMMANDS = { trigger, find, open };
if (process.argv.includes('--self-test')) selfTest();
else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = COMMANDS[process.argv[2]];
  if (!cmd) {
    console.error('usage: journeys-revert.mjs trigger|find|open|--self-test');
    process.exit(2);
  }
  cmd(process.env)
    .then((code) => process.exit(code ?? 0))
    .catch((e) => {
      console.error(`✖ journeys-revert ${process.argv[2]}: ${e.message}`);
      process.exit(1);
    });
}
