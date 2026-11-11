#!/usr/bin/env node
/**
 * A Real-app journeys run on main that finished without a report is re-run, spaced out, until it has one.
 *
 * Why: every pull request's verdict reads the reports of main's finished journeys runs since the baseline, and a run whose
 * report can't be read fails that verdict closed (journey-verdict.mjs fetchInputs; OWNER 277). Run 4005 (43037279979)
 * died at "Install the browser" during an Ubuntu mirror outage on 11 Nov 2026: its first attempt ended 14:44 UTC, Main
 * trust's one shard re-run ended 15:23 UTC with no report again, and every pull request's verdict failed on it until a
 * person re-ran it at 23:14 UTC. The verdict stays as strict as it is; this only brings the report back.
 *
 * Main trust runs this on its hourly timer (main-trust.yml `revive`). It reads main's own journeys runs (push, schedule,
 * dispatch) created in the last WINDOW_HOURS, finished and not cancelled or skipped, that did not succeed (a run still going,
 * or one of its attempts still going, is left alone), and for each one whose `real-app-journeys` artifact has no
 * report.json:
 *   attempt below MAX_ATTEMPT, ended at least WAIT_MINUTES[attempt] ago   re-run its failed jobs
 *   attempt below MAX_ATTEMPT, ended more recently                         wait for a later tick
 *   attempt MAX_ATTEMPT (its last try), or GitHub refuses the re-run        open one issue naming it, once
 * The waits grow (30 min, 1 h, 2 h, 4 h), so the tries outlast an outage of several hours, and the attempts are bounded:
 * at most MAX_ATTEMPT - 1 re-runs per run, ever. A refused request (403, 429) stops the tick, never retried.
 *
 *   node tooling/ci/journeys-revive.mjs        (GITHUB_REPOSITORY, GH_TOKEN; DRY_RUN=1 writes nothing)
 * Its tests: tooling/ci/journeys-revive.test.mjs.
 */
import { downloadReport, isMainRun, JOURNEYS_FILE } from './journey-verdict.mjs';

export const MAX_ATTEMPT = 5;
/** Minutes to wait after attempt n ended before asking for attempt n + 1. */
export const WAIT_MINUTES = { 1: 30, 2: 60, 3: 120, 4: 240 };
// The whole series (four waits of 30 min to 4 h, five attempts of about an hour) ends within about 13 h of a run starting.
export const WINDOW_HOURS = 24;

export const issueTitle = (run) => `Journeys run on main has no report: run ${run.run_number}`;

/** The runs worth a report check: main's own, finished, not cancelled or skipped, not green, inside the window. */
export function candidates(runs, { repo, now }) {
  const since = now - WINDOW_HOURS * 3600_000;
  return runs
    .filter((r) => isMainRun(r, repo))
    .filter((r) => r.status === 'completed' && !['cancelled', 'skipped', 'success'].includes(r.conclusion))
    .filter((r) => Date.parse(r.created_at) >= since)
    .sort((a, b) => a.run_number - b.run_number);
}

/** What to do with a finished run that has no report: 'rerun', 'wait' or 'name' (its last try is spent). */
export function decide(run, now) {
  const attempt = Number(run.run_attempt || 1);
  if (attempt >= MAX_ATTEMPT) return 'name';
  const endedAgo = (now - Date.parse(run.updated_at)) / 60_000;
  return endedAgo >= WAIT_MINUTES[attempt] ? 'rerun' : 'wait';
}

export function issueBody(run, repo) {
  return [
    `Real-app journeys [run ${run.run_number}](https://github.com/${repo}/actions/runs/${run.id}) on main (\`${String(run.head_sha).slice(0, 10)}\`) has no \`report.json\` after ${run.run_attempt} attempts, the last ending ${run.updated_at}.`,
    '',
    'Until it has one, every pull request\'s journeys verdict fails closed on it ("the pass history couldn\'t be read"; tooling/ci/journey-verdict.mjs). Main trust re-ran its failed jobs with growing waits (tooling/ci/journeys-revive.mjs) and stops here.',
    '',
    "Next: read why its shards died before their tests. When the cause is gone, re-run the run's failed jobs; a run that can never report is settled only by rewriting the baseline from a newer run (docs/runbooks/regression-issue-state.md).",
  ].join('\n');
}

/**
 * One tick. `io` is GitHub: listRuns(), hasReport(run), rerun(run) -> { ok, status }, openIssue(title) -> issue|null,
 * createIssue(title, body). Returns the actions taken, one line per run, for the log and the tests.
 */
export async function tick({ repo, now, io }) {
  const out = [];
  for (const run of candidates(await io.listRuns(), { repo, now })) {
    if (await io.hasReport(run)) continue;
    const action = decide(run, now);
    const name = `run ${run.run_number} (${run.id}) attempt ${run.run_attempt}`;
    if (action === 'wait') {
      out.push(`${name}: no report, waiting ${WAIT_MINUTES[run.run_attempt]} min after it ended`);
      continue;
    }
    let why = 'after its last try';
    if (action === 'rerun') {
      const r = await io.rerun(run);
      if (r.ok) {
        out.push(`${name}: no report, re-run of failed jobs requested`);
        continue;
      }
      // GitHub would not re-run it (no failed job to re-run, or the run can't be re-run): asking every hour changes
      // nothing, so it is named now.
      why = `and GitHub did not take its re-run (${r.status})`;
    }
    if (await io.openIssue(issueTitle(run))) out.push(`${name}: no report ${why}, issue already open`);
    else {
      await io.createIssue(issueTitle(run), issueBody(run, repo));
      out.push(`${name}: no report ${why}, issue opened`);
    }
  }
  return out;
}

// ── GitHub ─────────────────────────────────────────────────────────────────
async function gh(method, path, body) {
  if (process.env.DRY_RUN === '1' && method !== 'GET') {
    console.log(`DRY_RUN ${method} ${path}`);
    return { status: 0, json: null };
  }
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  // AGENTS.md's one exception: "already running" on a re-run only means a re-run is in progress.
  if (res.status === 403 && /already running/i.test(text)) return { status: 403, json: null, alreadyRunning: true };
  if (res.status === 403 || res.status === 429) throw new Error(`GitHub ${res.status} on ${method} ${path}: stopping, not retrying`);
  if (method === 'GET' && !res.ok) throw new Error(`GitHub ${res.status} on GET ${path}`);
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

export function githubIo(repo) {
  return {
    listRuns: async () =>
      (await gh('GET', `/repos/${repo}/actions/workflows/${JOURNEYS_FILE}/runs?branch=main&per_page=100`)).json.workflow_runs,
    // The verdict's own reader: no artifact, or an artifact without report.json, is null; any other failure throws.
    hasReport: async (run) => downloadReport(repo, run.id, 'report.json', true) !== null,
    rerun: async (run) => {
      const r = await gh('POST', `/repos/${repo}/actions/runs/${run.id}/rerun-failed-jobs`);
      return { ok: r.alreadyRunning || r.status === 0 || (r.status >= 200 && r.status < 300), status: r.status };
    },
    openIssue: async (title) => {
      const q = encodeURIComponent(`repo:${repo} is:issue is:open in:title "${title}"`);
      return (await gh('GET', `/search/issues?q=${q}`)).json.items.find((i) => i.title === title) ?? null;
    },
    createIssue: (title, body) => gh('POST', `/repos/${repo}/issues`, { title, body }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !process.env.GH_TOKEN) {
    console.error('✖ journeys-revive: GITHUB_REPOSITORY and GH_TOKEN are required');
    process.exit(1);
  }
  tick({ repo, now: Date.now(), io: githubIo(repo) })
    .then((lines) => console.log(lines.length ? lines.join('\n') : 'every finished journeys run on main in the window has a report'))
    .catch((e) => {
      console.error(`✖ journeys-revive: ${e.message}`);
      process.exit(1);
    });
}
