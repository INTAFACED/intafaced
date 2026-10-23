#!/usr/bin/env node
/**
 * POST-MERGE TRUST: what Main trust does when a post-merge check on main finishes (workflow: main-trust.yml).
 * It only reads runs and opens, comments on or closes issues. It never blocks a merge and never runs on a schedule.
 *
 * Order-path CX-8 and Customer Money browser checks (whole-run checks):
 *   red after a green, first attempt   re-run the failed jobs once
 *   red after a green, re-run attempt  the break is real: open (or comment on) one "Broken on main: <check>" issue
 *                                      naming the commits between the last green run and this one
 *   red after a red                    nothing new: the issue from the first break still stands
 *   green                              close that check's issue when this commit includes every red it names
 *
 * Real-app journeys (per journey step; most journeys do not pass yet, so the job is red either way):
 *   The run is compared with the two finished runs before it. A step that passed two runs ago and failed in both the
 *   run before and this one is broken for real (the next run is the re-run, at no extra cost): open (or comment on)
 *   one "Journey broken on main: <J-id>" issue per journey, naming the commits between the last run it passed and the
 *   first run it failed. A journey's issue closes when every step it names passes again.
 *   The run summary lists the steps newly passing and newly failing against the run before.
 *
 *   node tooling/ci/post-merge-trust.mjs --self-test
 *   DRY_RUN=1 (with the CI env below): reads for real, prints every write instead of sending it
 *   (CI) GH_TOKEN GITHUB_REPOSITORY WORKFLOW_ID WORKFLOW_NAME RUN_ID RUN_ATTEMPT CONCLUSION HEAD_SHA
 *        node tooling/ci/post-merge-trust.mjs
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const JOURNEYS_WORKFLOW = 'Real-app journeys';
export const JOURNEYS_ARTIFACT = 'real-app-journeys';
const STEP_TITLE = /^(J-[a-z0-9-]+-\d+)\s+#(\d+)\b/;
const COUNTED = new Set(['success', 'failure', 'timed_out']);

/**
 * Each journey step in a Playwright JSON report: "passed", "failed" or "skipped". The key is "J-<module>-NN#<step>",
 * as in tooling/scripts/roadmap.mjs passedSteps. A step with any test that did not end expected or flaky failed.
 */
export function stepStates(report) {
  const states = new Map();
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const m = STEP_TITLE.exec(spec.title ?? '');
      if (!m) continue;
      const key = `${m[1]}#${Number(m[2])}`;
      const tests = spec.tests ?? [];
      const state =
        tests.length && tests.every((t) => t.status === 'skipped')
          ? 'skipped'
          : tests.length && tests.every((t) => t.status === 'expected' || t.status === 'flaky')
            ? 'passed'
            : 'failed';
      const had = states.get(key);
      states.set(key, had === 'failed' || state === 'failed' ? 'failed' : had === 'passed' || state === 'passed' ? 'passed' : 'skipped');
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report?.suites ?? []) walk(suite);
  return states;
}

const sortKeys = (keys) => [...keys].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

/** Steps newly passing and newly failing in `now` against `before` (a step absent or skipped in either is neither). */
export function stepChanges(before, now) {
  const newlyPassing = [];
  const newlyFailing = [];
  for (const [key, state] of now) {
    if (state === 'passed' && before.get(key) === 'failed') newlyPassing.push(key);
    if (state === 'failed' && before.get(key) === 'passed') newlyFailing.push(key);
  }
  return { newlyPassing: sortKeys(newlyPassing), newlyFailing: sortKeys(newlyFailing) };
}

/** Steps that passed in `older`, then failed in both `previous` and `now`: confirmed breaks, grouped by journey. */
export function confirmedBreaks(older, previous, now) {
  const byJourney = new Map();
  for (const [key, state] of now) {
    if (state !== 'failed' || previous.get(key) !== 'failed' || older.get(key) !== 'passed') continue;
    const journey = key.split('#')[0];
    byJourney.set(journey, sortKeys([...(byJourney.get(journey) ?? []), key]));
  }
  return new Map([...byJourney].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
}

/** What to do with a finished whole-run check. `previous` is the conclusion of the finished run before it. */
export function decideCheck({ conclusion, attempt, previous }) {
  if (conclusion === 'success') return 'green';
  if (conclusion !== 'failure' && conclusion !== 'timed_out') return 'ignore';
  if (previous !== 'success') return 'still-red';
  return attempt <= 1 ? 'rerun' : 'broken';
}

export const checkIssueTitle = (check) => `Broken on main: ${check}`;
export const journeyIssueTitle = (journey) => `Journey broken on main: ${journey}`;
const CHECK_RED = /failed twice on `([0-9a-f]{7,40})`/g;
const STEPS_MARK = /<!-- steps: ([^>]*) -->/g;

/** The commits a check's open issue names as red, from its body and later comments. */
export function checkRedShas(texts) {
  return [...new Set(texts.flatMap((t) => [...(t ?? '').matchAll(CHECK_RED)].map((m) => m[1])))];
}

/** The steps a journey's open issue names, from its body and later comments. */
export function issueSteps(texts) {
  return sortKeys(
    new Set(
      texts.flatMap((t) =>
        [...(t ?? '').matchAll(STEPS_MARK)].flatMap((m) =>
          m[1]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ),
    ),
  );
}

/** Markdown lines for the commits between two runs, newest last; at most `max`, then a count of the rest. */
export function commitLines(commits, max = 30) {
  const lines = commits.slice(-max).map((c) => {
    const subject = (c.commit?.message ?? '').split('\n')[0];
    const who = c.author?.login ? ` by @${c.author.login}` : '';
    return `- \`${c.sha.slice(0, 10)}\` ${subject}${who}`;
  });
  if (commits.length > max) lines.unshift(`- … ${commits.length - max} older commits (see the compare link)`);
  return lines;
}

// ── GitHub API ────────────────────────────────────────────────────────────
const API = 'https://api.github.com';
async function gh(method, path, body) {
  if (process.env.DRY_RUN === '1' && method !== 'GET') {
    console.log(`DRY_RUN ${method} ${path}${body ? `\n${JSON.stringify(body, null, 2)}` : ''}`);
    return { status: 0, json: null };
  }
  const res = await fetch(path.startsWith('https://') ? path : `${API}${path}`, {
    method,
    headers: {
      ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 403 || res.status === 429) {
    // AGENTS.md: a 403 or 429 from GitHub is a stop. No retry, no loop.
    throw new Error(`GitHub ${res.status} on ${method} ${path}: stopping, not retrying`);
  }
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** Finished runs of this workflow on main created before `runId`, newest first (cancelled and skipped runs left out). */
async function earlierRuns(repo, workflowId, runId, createdAt) {
  const { json } = await gh('GET', `/repos/${repo}/actions/workflows/${workflowId}/runs?branch=main&status=completed&per_page=100`);
  return (json?.workflow_runs ?? [])
    .filter((r) => r.id !== Number(runId) && r.created_at < createdAt && COUNTED.has(r.conclusion))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

async function findOpenIssue(repo, title) {
  const q = encodeURIComponent(`repo:${repo} is:issue is:open in:title "${title}"`);
  const { json } = await gh('GET', `/search/issues?q=${q}&per_page=5`);
  return (json?.items ?? []).find((i) => i.title === title) ?? null;
}

/** Open issues whose title starts with `prefix`. */
async function openIssuesTitled(repo, prefix) {
  const q = encodeURIComponent(`repo:${repo} is:issue is:open in:title "${prefix.trim()}"`);
  const { json } = await gh('GET', `/search/issues?q=${q}&per_page=100`);
  return (json?.items ?? []).filter((i) => i.title.startsWith(prefix));
}

async function issueTexts(repo, issue) {
  const { json: comments } = await gh('GET', `/repos/${repo}/issues/${issue.number}/comments?per_page=100`);
  return [issue.body, ...(comments ?? []).map((c) => c.body)];
}

async function upsertIssue(repo, title, body) {
  const existing = await findOpenIssue(repo, title);
  if (existing) {
    await gh('POST', `/repos/${repo}/issues/${existing.number}/comments`, { body });
    return `commented on #${existing.number}`;
  }
  const { json } = await gh('POST', `/repos/${repo}/issues`, { title, body });
  return `opened #${json?.number}`;
}

async function closeIssue(repo, issue, body) {
  await gh('POST', `/repos/${repo}/issues/${issue.number}/comments`, { body });
  await gh('PATCH', `/repos/${repo}/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });
}

async function between(repo, from, to) {
  const { json } = await gh('GET', `/repos/${repo}/compare/${from}...${to}`);
  return { commits: json?.commits ?? [], url: `https://github.com/${repo}/compare/${from.slice(0, 10)}...${to.slice(0, 10)}` };
}

/** The journeys report of a run, or null when the run kept none (the stack or browser did not start). */
async function journeyReport(repo, runId) {
  const { json } = await gh('GET', `/repos/${repo}/actions/runs/${runId}/artifacts?name=${JOURNEYS_ARTIFACT}&per_page=5`);
  const artifact = (json?.artifacts ?? []).find((a) => a.name === JOURNEYS_ARTIFACT && !a.expired);
  if (!artifact) return null;
  const res = await fetch(artifact.archive_download_url, {
    headers: process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {},
  });
  if (res.status === 403 || res.status === 429) throw new Error(`GitHub ${res.status} on the artifact of run ${runId}: stopping`);
  if (!res.ok) return null;
  const dir = mkdtempSync(join(tmpdir(), 'journeys-'));
  try {
    const zip = join(dir, 'a.zip');
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    const entry = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' })
      .split('\n')
      .find((e) => e.endsWith('journeys/report.json') || e === 'report.json');
    if (!entry) return null;
    return JSON.parse(execFileSync('unzip', ['-p', zip, entry], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function summary(lines) {
  const text = `${lines.join('\n')}\n`;
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

async function wholeRunCheck(ctx) {
  const { repo, name, runId, attempt, conclusion, sha, runUrl, earlier } = ctx;
  const prev = earlier[0];
  const action = decideCheck({ conclusion, attempt, previous: prev?.conclusion });
  console.log(`${name} run ${runId} attempt ${attempt}: ${conclusion} (previous: ${prev?.conclusion ?? 'none'}) -> ${action}`);
  if (action === 'rerun') {
    const r = await gh('POST', `/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`);
    console.log(`re-run of failed jobs requested (${r.status}); no further action until it finishes`);
    return;
  }
  if (action === 'broken') {
    const { commits, url } = await between(repo, prev.head_sha, sha);
    const body = [
      `\`${name}\` failed twice on \`${sha.slice(0, 10)}\` (the failed jobs were re-run once): [run ${runId}](${runUrl}). It passed on \`${prev.head_sha.slice(0, 10)}\` ([run ${prev.id}](${prev.html_url})).`,
      '',
      commits.length === 1 ? 'The breaking commit:' : `The breaking commit is one of these ${commits.length} ([compare](${url})):`,
      ...commitLines(commits),
      '',
      '_Opened by tooling/ci/post-merge-trust.mjs. Nothing is skipped or blocked; fix or revert the commit._',
    ].join('\n');
    console.log(await upsertIssue(repo, checkIssueTitle(name), body));
    return;
  }
  if (action === 'green') {
    const issue = await findOpenIssue(repo, checkIssueTitle(name));
    if (!issue) return console.log(`no open "${checkIssueTitle(name)}" issue`);
    const reds = checkRedShas(await issueTexts(repo, issue));
    const statuses = [];
    for (const red of reds) statuses.push((await gh('GET', `/repos/${repo}/compare/${red}...${sha}`)).json?.status);
    if (!statuses.length || !statuses.every((s) => s === 'ahead' || s === 'identical'))
      return console.log(`#${issue.number} stays open (${reds.join(', ') || 'no red commit named'}: ${statuses.join(', ')})`);
    await closeIssue(
      repo,
      issue,
      `\`${name}\` passes again on \`${sha.slice(0, 10)}\` ([run ${runId}](${runUrl})). Closing.\n\n_Closed by tooling/ci/post-merge-trust.mjs._`,
    );
    console.log(`closed #${issue.number}`);
  }
}

async function journeysCheck(ctx) {
  const { repo, runId, sha, runUrl, earlier } = ctx;
  const now = await journeyReport(repo, runId);
  if (!now)
    return summary([`### Journeys against earlier runs`, '', `Run ${runId} kept no journey report, so there is nothing to compare.`]);
  const nowStates = stepStates(now);
  const [prevRun, olderRun] = earlier;
  const prev = prevRun ? await journeyReport(repo, prevRun.id) : null;
  const lines = ['### Journeys against earlier runs', ''];
  if (!prev) {
    lines.push('No earlier finished run kept a journey report, so nothing is compared yet.');
    return summary(lines);
  }
  const prevStates = stepStates(prev);
  const { newlyPassing, newlyFailing } = stepChanges(prevStates, nowStates);
  lines.push(`Against [run ${prevRun.id}](${prevRun.html_url}) (\`${prevRun.head_sha.slice(0, 10)}\`):`, '');
  lines.push(`- Newly passing (${newlyPassing.length}): ${newlyPassing.join(', ') || 'none'}`);
  lines.push(
    `- Newly broken (${newlyFailing.length}): ${newlyFailing.join(', ') || 'none'}${newlyFailing.length ? ' (an issue opens if the next run fails them too)' : ''}`,
  );

  // Close journey issues whose named steps all pass now. One search for all of them (search allows 30 calls a minute).
  for (const issue of await openIssuesTitled(repo, journeyIssueTitle(''))) {
    const journey = issue.title.slice(journeyIssueTitle('').length);
    const steps = issueSteps(await issueTexts(repo, issue));
    if (!steps.length || !steps.every((s) => nowStates.get(s) === 'passed')) continue;
    await closeIssue(
      repo,
      issue,
      `${steps.join(', ')} pass again on \`${sha.slice(0, 10)}\` ([run ${runId}](${runUrl})). Closing.\n\n_Closed by tooling/ci/post-merge-trust.mjs._`,
    );
    lines.push(`- Closed #${issue.number} (${journey} passes again)`);
  }

  const older = olderRun ? await journeyReport(repo, olderRun.id) : null;
  if (!older) {
    lines.push('', 'No third finished run kept a report, so no break can be confirmed yet.');
    return summary(lines);
  }
  const breaks = confirmedBreaks(stepStates(older), prevStates, nowStates);
  if (breaks.size) {
    const { commits, url } = await between(repo, olderRun.head_sha, prevRun.head_sha);
    for (const [journey, steps] of breaks) {
      const body = [
        `${steps.join(', ')} passed on \`${olderRun.head_sha.slice(0, 10)}\` ([run ${olderRun.id}](${olderRun.html_url})), then failed on \`${prevRun.head_sha.slice(0, 10)}\` ([run ${prevRun.id}](${prevRun.html_url})) and again on \`${sha.slice(0, 10)}\` ([run ${runId}](${runUrl})).`,
        '',
        commits.length === 1 ? 'The breaking commit:' : `The breaking commit is one of these ${commits.length} ([compare](${url})):`,
        ...commitLines(commits),
        '',
        `<!-- steps: ${steps.join(', ')} -->`,
        '_Opened by tooling/ci/post-merge-trust.mjs. It closes itself when these steps pass again._',
      ].join('\n');
      lines.push(`- Confirmed broken: ${steps.join(', ')}: ${await upsertIssue(repo, journeyIssueTitle(journey), body)}`);
    }
  }
  summary(lines);
}

function selfTest() {
  const eq = (got, want, m) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${m}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  };
  const spec = (title, ...statuses) => ({ title, tests: statuses.map((status) => ({ status })) });
  const report = (...specs) => ({ suites: [{ title: 'a.pw.mjs', specs: specs.slice(0, 2), suites: [{ specs: specs.slice(2) }] }] });
  const r1 = report(
    spec('J-a-01 #1 x', 'expected'),
    spec('J-a-01 #2 y', 'unexpected'),
    spec('J-b-02 #1 z', 'skipped'),
    spec('not a journey', 'unexpected'),
  );
  eq(
    [...stepStates(r1)],
    [
      ['J-a-01#1', 'passed'],
      ['J-a-01#2', 'failed'],
      ['J-b-02#1', 'skipped'],
    ],
    'step states, nested suites',
  );
  eq(
    [...stepStates(report(spec('J-a-01 #1 x', 'expected'), spec('J-a-01 #1 dup', 'unexpected')))],
    [['J-a-01#1', 'failed']],
    'a failing duplicate title wins',
  );
  eq([...stepStates(report(spec('J-a-01 #1 x', 'flaky')))], [['J-a-01#1', 'passed']], 'flaky counts as passed');
  const m = (o) => new Map(Object.entries(o));
  eq(
    stepChanges(
      m({ 'J-a-01#1': 'failed', 'J-a-01#2': 'passed', 'J-a-01#3': 'passed', 'J-a-01#10': 'passed' }),
      m({ 'J-a-01#1': 'passed', 'J-a-01#2': 'failed', 'J-a-01#3': 'skipped', 'J-a-01#10': 'failed', 'J-c-01#1': 'failed' }),
    ),
    { newlyPassing: ['J-a-01#1'], newlyFailing: ['J-a-01#2', 'J-a-01#10'] },
    'newly passing and failing; skipped and new steps are neither; numeric order',
  );
  eq(
    [
      ...confirmedBreaks(
        m({ 'J-a-01#1': 'passed', 'J-a-01#2': 'passed', 'J-b-01#1': 'passed', 'J-c-01#1': 'failed' }),
        m({ 'J-a-01#1': 'failed', 'J-a-01#2': 'failed', 'J-b-01#1': 'failed', 'J-c-01#1': 'failed' }),
        m({ 'J-a-01#1': 'failed', 'J-a-01#2': 'passed', 'J-b-01#1': 'failed', 'J-c-01#1': 'failed' }),
      ),
    ],
    [
      ['J-a-01', ['J-a-01#1']],
      ['J-b-01', ['J-b-01#1']],
    ],
    'a break is confirmed only after passing, then failing twice in a row; never-passed steps open nothing',
  );
  eq(decideCheck({ conclusion: 'failure', attempt: 1, previous: 'success' }), 'rerun', 'first red after green re-runs');
  eq(decideCheck({ conclusion: 'failure', attempt: 2, previous: 'success' }), 'broken', 'red after re-run is a break');
  eq(decideCheck({ conclusion: 'timed_out', attempt: 2, previous: 'success' }), 'broken', 'a timeout counts as red');
  eq(decideCheck({ conclusion: 'failure', attempt: 1, previous: 'failure' }), 'still-red', 'red after red opens nothing new');
  eq(decideCheck({ conclusion: 'failure', attempt: 1, previous: undefined }), 'still-red', 'no earlier run: nothing to blame');
  eq(decideCheck({ conclusion: 'success', attempt: 1, previous: 'failure' }), 'green', 'green');
  eq(decideCheck({ conclusion: 'cancelled', attempt: 1, previous: 'success' }), 'ignore', 'cancelled ignored');
  eq(
    checkRedShas([
      '`Order-path CX-8` failed twice on `46b3f74801` (x)',
      null,
      'failed twice on `46b3f74801`, failed twice on `abcdef1234`',
    ]),
    ['46b3f74801', 'abcdef1234'],
    'red shas, deduped',
  );
  eq(
    issueSteps(['x <!-- steps: J-a-01#2, J-a-01#1 -->', 'y <!-- steps: J-a-01#1 -->', null]),
    ['J-a-01#1', 'J-a-01#2'],
    'issue steps, merged',
  );
  const c = (sha, message, login) => ({ sha, commit: { message }, author: login ? { login } : null });
  eq(
    commitLines([c('a'.repeat(40), 'feat: one (#1)\n\nbody', 'alice'), c('b'.repeat(40), 'fix: two (#2)')]),
    ['- `aaaaaaaaaa` feat: one (#1) by @alice', '- `bbbbbbbbbb` fix: two (#2)'],
    'commit lines',
  );
  eq(
    commitLines([c('a'.repeat(40), 'x'), c('b'.repeat(40), 'y'), c('c'.repeat(40), 'z')], 2)[0],
    '- … 1 older commits (see the compare link)',
    'long ranges are cut',
  );
  console.log('✓ post-merge-trust --self-test OK (16 fixtures)');
}

async function main() {
  const {
    GITHUB_REPOSITORY: repo,
    WORKFLOW_ID: workflowId,
    WORKFLOW_NAME: name,
    RUN_ID: runId,
    RUN_ATTEMPT,
    CONCLUSION: conclusion,
    HEAD_SHA: sha,
  } = process.env;
  if (!repo || !workflowId || !name || !runId || !conclusion || !sha)
    throw new Error('GITHUB_REPOSITORY, WORKFLOW_ID, WORKFLOW_NAME, RUN_ID, CONCLUSION and HEAD_SHA are required');
  const attempt = Number(RUN_ATTEMPT || 1);
  const runUrl = `https://github.com/${repo}/actions/runs/${runId}`;
  const { json: run } = await gh('GET', `/repos/${repo}/actions/runs/${runId}`);
  if (!run?.created_at) throw new Error(`could not read run ${runId}`);
  const earlier = await earlierRuns(repo, workflowId, runId, run.created_at);
  const ctx = { repo, name, runId, attempt, conclusion, sha, runUrl, earlier };
  if (name === JOURNEYS_WORKFLOW) {
    if (!COUNTED.has(conclusion)) return console.log(`${name} run ${runId}: ${conclusion}, nothing to compare`);
    return journeysCheck(ctx);
  }
  return wholeRunCheck(ctx);
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`✖ post-merge-trust: ${e.message}`);
    process.exit(1);
  });
}
