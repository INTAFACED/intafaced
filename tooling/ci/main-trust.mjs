#!/usr/bin/env node
/**
 * MAIN TRUST — what runs after a CI run on main finishes (workflow: main-trust.yml).
 *
 *   red, first attempt   re-run the failed jobs once. Nothing is skipped or disabled.
 *   red, second attempt  the red is real: open (or update) one "Main is red" issue naming the failing tests, and start
 *                        main-bisect.yml to find the first commit since the last green where those files fail.
 *   green after a re-run the tests that failed on attempt 1 are flaky: open (or update) one
 *                        "Flaky on main: <test file>" issue each, naming the owner.
 *   green                move the `last-green` branch to this commit, never backwards, and close the open
 *                        "Main is red" issue when every red it names is this commit or older.
 *
 * Every issue this opens carries its label from the moment it exists (RULING 7, project-state #2065): "Main is red"
 * opens as `main-unknown-red` (a builder's pick 1) and main-bisect switches it to `regression` when it names the merge;
 * a "Flaky on main: <test file>" issue is a unit test, no journey step, so it opens as `flaky-test`, which is no pick 1
 * label (a journey step's flake is `flaky`, from post-merge-trust.mjs or tooling/ci/open-flaky.mjs).
 *
 * Owner of a flaky test = the author of the last commit that touched the file (the PR is named in the issue),
 * unless tooling/ci/flaky-owners.json maps a path prefix to a GitHub login. Failures are confirmed by re-run
 * before anything acts on them; there is no quarantine and no skip. (The one set-aside is the machine's, for journey
 * steps on main, never a money step: tooling/ci/journey-verdict.mjs.)
 *
 *   node tooling/ci/main-trust.mjs --self-test
 *   (CI) GH_TOKEN GITHUB_REPOSITORY RUN_ID RUN_ATTEMPT CONCLUSION HEAD_SHA node tooling/ci/main-trust.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JOB_PROBES, RED_LABELS } from './bisect-main.mjs';

const GROUPS = ['apps', 'services', 'packages'];
export const LAST_GREEN_BRANCH = 'last-green';
const FAIL_LINE = /\bFAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)/g;

/** Test files named by the `Failing: …` step titles CI writes into a failed Tests job. */
export function failingTestPaths(stepNames, resolveDir) {
  const out = new Set();
  for (const name of stepNames) {
    if (!name.startsWith('Failing: ')) continue;
    const pkgs = [...name.matchAll(/([@\w./-]+)#test/g)].map((m) => m[1].replace(/^@intafaced\//, ''));
    for (const m of name.matchAll(FAIL_LINE)) {
      const rel = m[1].replace(/^\.\//, '');
      const dir = resolveDir(rel, pkgs);
      out.add(dir ? `${dir}/${rel}` : rel);
    }
  }
  return [...out].sort();
}

/** Resolve a package-relative test path to its workspace dir using the checkout. */
export function dirResolver(root = process.cwd()) {
  const dirs = [];
  for (const g of GROUPS) {
    if (!existsSync(join(root, g))) continue;
    for (const d of readdirSync(join(root, g))) dirs.push(`${g}/${d}`);
  }
  return (rel, pkgs) => {
    const named = dirs.filter((d) => pkgs.some((p) => d.endsWith(`/${p}`)));
    return [...named, ...dirs].find((d) => existsSync(join(root, d, rel)));
  };
}

export function ownerFor(path, overrides, lastCommitLogin) {
  const hit = Object.keys(overrides ?? {})
    .filter((p) => path.startsWith(p))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? overrides[hit] : lastCommitLogin || null;
}

/** What to do with a finished main run. Pure, so the table is testable. */
export function decide({ conclusion, attempt }) {
  if (conclusion === 'cancelled' || conclusion === 'skipped' || conclusion === 'neutral') return 'ignore';
  if (conclusion === 'failure' || conclusion === 'timed_out') return attempt <= 1 ? 'rerun' : 'real-red';
  if (conclusion === 'success') return attempt > 1 ? 'green-after-rerun' : 'green';
  return 'ignore';
}

// ── GitHub API ────────────────────────────────────────────────────────────
const API = 'https://api.github.com';
async function gh(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
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

async function failedStepNames(repo, runId, attempt) {
  const { json } = await gh('GET', `/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`);
  const names = [];
  for (const job of json?.jobs ?? []) {
    if (job.conclusion !== 'failure' && job.conclusion !== 'timed_out') continue;
    for (const s of job.steps ?? []) names.push(s.name);
  }
  return names;
}

/** The failed jobs of a run attempt that bisect-main.mjs can probe by their own command (JOB_PROBES). */
async function failedProbedJobs(repo, runId, attempt) {
  const { json } = await gh('GET', `/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`);
  return probedJobs(json?.jobs);
}

/** Pure: the names of failed or timed-out jobs that have a probe, sorted, once each. */
export function probedJobs(jobs) {
  const names = (jobs ?? [])
    .filter((j) => j?.conclusion === 'failure' || j?.conclusion === 'timed_out')
    .map((j) => j.name)
    .filter((n) => Object.hasOwn(JOB_PROBES, n));
  return [...new Set(names)].sort();
}

async function findOpenIssue(repo, title) {
  const q = encodeURIComponent(`repo:${repo} is:issue is:open in:title "${title}"`);
  const { json } = await gh('GET', `/search/issues?q=${q}&per_page=5`);
  return (json?.items ?? []).find((i) => i.title === title) ?? null;
}

/** The label a unit test's "Flaky on main" issue opens with: not a journey step, so no pick 1 label. */
export const UNIT_FLAKY_LABEL = 'flaky-test';

/**
 * The labels an open issue is missing: none when it already has one of `accepted` (a "Main is red" issue that the
 * bisect switched to `regression` keeps it), else `labels`. Pure.
 */
export function missingLabels(have, labels, accepted = labels) {
  const names = (have ?? []).map((l) => (typeof l === 'string' ? l : l?.name));
  return accepted.some((l) => names.includes(l)) ? [] : labels;
}

/** Open the issue with its labels set in the same request, or comment on the open one and give it any it lacks. */
async function upsertIssue(repo, title, body, { assignee, labels, accepted } = {}) {
  const existing = await findOpenIssue(repo, title);
  if (existing) {
    await gh('POST', `/repos/${repo}/issues/${existing.number}/comments`, { body });
    const add = missingLabels(existing.labels, labels, accepted);
    if (add.length) await gh('POST', `/repos/${repo}/issues/${existing.number}/labels`, { labels: add });
    return existing.number;
  }
  let made = await gh('POST', `/repos/${repo}/issues`, { title, body, labels, assignees: assignee ? [assignee] : [] });
  // An owner GitHub can't assign (an App, a departed login) must not cost the issue: open it unassigned, labels kept.
  if (made.status === 422 && assignee) made = await gh('POST', `/repos/${repo}/issues`, { title, body, labels });
  if (made.status !== 201) throw new Error(`could not open "${title}": HTTP ${made.status}`);
  return made.json?.number;
}

/** The commits an open "Main is red" issue names, from its body and the comments added by later reds. */
export function redShas(texts) {
  return [...new Set(texts.flatMap((t) => [...(t ?? '').matchAll(/Main failed twice on `([0-9a-f]{7,40})`/g)].map((m) => m[1])))];
}

/** A green commit settles the issue when each red it names is that commit or an ancestor of it. */
export function settlesRed(compareStatuses) {
  return compareStatuses.length > 0 && compareStatuses.every((s) => s === 'ahead' || s === 'identical');
}

async function closeSettledRed(repo, sha, runUrl) {
  const issue = await findOpenIssue(repo, 'Main is red');
  if (!issue) return 'no open "Main is red" issue';
  const { json: comments } = await gh('GET', `/repos/${repo}/issues/${issue.number}/comments?per_page=100`);
  const reds = redShas([issue.body, ...(comments ?? []).map((c) => c.body)]);
  const statuses = [];
  for (const red of reds) statuses.push((await gh('GET', `/repos/${repo}/compare/${red}...${sha}`)).json?.status);
  if (!settlesRed(statuses))
    return `"Main is red" #${issue.number} stays open (${reds.join(', ') || 'no red commit named'}: ${statuses.join(', ')})`;
  await gh('POST', `/repos/${repo}/issues/${issue.number}/comments`, {
    body: `Main is green again on \`${sha.slice(0, 10)}\` ([run](${runUrl})), which includes ${reds.map((r) => `\`${r.slice(0, 10)}\``).join(', ')}. Closing.\n\n_Closed by tooling/ci/main-trust.mjs._`,
  });
  await gh('PATCH', `/repos/${repo}/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });
  return `closed "Main is red" #${issue.number}`;
}

async function lastCommit(repo, path) {
  const { json } = await gh('GET', `/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1`);
  const c = json?.[0];
  return { login: c?.author?.login ?? null, pr: /\(#(\d+)\)/.exec(c?.commit?.message ?? '')?.[1] ?? null };
}

async function publishLastGreen(repo, sha) {
  const ref = `heads/${LAST_GREEN_BRANCH}`;
  const cur = await gh('GET', `/repos/${repo}/git/ref/${ref}`);
  if (cur.status === 404) {
    const made = await gh('POST', `/repos/${repo}/git/refs`, { ref: `refs/${ref}`, sha });
    if (made.status !== 201) throw new Error(`could not create ${LAST_GREEN_BRANCH}: HTTP ${made.status}`);
    return `created ${LAST_GREEN_BRANCH} at ${sha}`;
  }
  if (cur.status !== 200) throw new Error(`could not read ${LAST_GREEN_BRANCH}: HTTP ${cur.status}`);
  const have = cur.json.object.sha;
  if (have === sha) return `${LAST_GREEN_BRANCH} already at ${sha}`;
  const cmp = await gh('GET', `/repos/${repo}/compare/${have}...${sha}`);
  // Only ever forward: an older run finishing late must not move the pointer back.
  if (cmp.json?.status !== 'ahead') return `${LAST_GREEN_BRANCH} stays at ${have} (${sha} is ${cmp.json?.status})`;
  const moved = await gh('PATCH', `/repos/${repo}/git/refs/${ref}`, { sha, force: false });
  if (moved.status !== 200) throw new Error(`could not move ${LAST_GREEN_BRANCH}: HTTP ${moved.status}`);
  return `moved ${LAST_GREEN_BRANCH} ${have} -> ${sha}`;
}

/** Start the bisect between the last green and this red commit. Needs a last-green branch that is an ancestor. */
async function startBisect(repo, sha, tests, jobs = [], runId = '') {
  if (!tests.length && !jobs.length) return 'bisect not started: no failing test file or probed job was named';
  const cur = await gh('GET', `/repos/${repo}/git/ref/heads/${LAST_GREEN_BRANCH}`);
  if (cur.status !== 200) return `bisect not started: no ${LAST_GREEN_BRANCH} branch yet`;
  const good = cur.json.object.sha;
  const cmp = await gh('GET', `/repos/${repo}/compare/${good}...${sha}`);
  if (cmp.json?.status !== 'ahead')
    return `bisect not started: ${LAST_GREEN_BRANCH} (${good.slice(0, 10)}) is ${cmp.json?.status} of ${sha.slice(0, 10)}`;
  const r = await gh('POST', `/repos/${repo}/actions/workflows/main-bisect.yml/dispatches`, {
    ref: 'main',
    inputs: { good, bad: sha, tests: tests.join('\n'), jobs: jobs.join(','), red_run: String(runId) },
  });
  return r.status === 204 ? `bisect started between ${good.slice(0, 10)} and ${sha.slice(0, 10)}` : `bisect not started: HTTP ${r.status}`;
}

function selfTest() {
  const eq = (got, want, m) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${m}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  };
  eq(decide({ conclusion: 'failure', attempt: 1 }), 'rerun', 'first red re-runs');
  eq(
    probedJobs([
      { name: 'Doctrine gates', conclusion: 'failure' },
      { name: 'Doctrine gates', conclusion: 'failure' },
      { name: 'Tests (shard 1)', conclusion: 'failure' },
      { name: 'Format', conclusion: 'success' },
    ]),
    ['Doctrine gates'],
    'a failed Doctrine gates job is probed by its command; a job with no probe is left to its test files',
  );
  eq(probedJobs([{ name: 'Doctrine gates', conclusion: 'success' }]), [], 'a green job is not probed');
  eq(
    probedJobs([
      { name: 'Typecheck & build', conclusion: 'failure' },
      { name: 'Tests (2/16)', conclusion: 'failure' },
    ]),
    ['Typecheck & build'],
    "main's build red (run 42828463480, 10 Nov) starts the bisect by its own command",
  );
  eq(decide({ conclusion: 'failure', attempt: 2 }), 'real-red', 'second red is real');
  eq(decide({ conclusion: 'success', attempt: 2 }), 'green-after-rerun', 'green after re-run');
  eq(decide({ conclusion: 'success', attempt: 1 }), 'green', 'plain green');
  eq(decide({ conclusion: 'cancelled', attempt: 1 }), 'ignore', 'cancelled ignored');
  eq(
    redShas(['Main failed twice on `46b3f74801` (x)', 'Main failed twice on `46b3f74801`', 'Main failed twice on `abcdef1234`']),
    ['46b3f74801', 'abcdef1234'],
    'red shas, deduped',
  );
  eq(redShas([null, 'nothing here']), [], 'no red named');
  eq(
    [settlesRed(['ahead', 'identical']), settlesRed(['ahead', 'behind']), settlesRed(['diverged']), settlesRed([])],
    [true, false, false, false],
    'a green settles only reds at or behind it',
  );
  const resolve = (rel, pkgs) => (pkgs.includes('svc-protocol') ? 'services/svc-protocol' : 'packages/x');
  eq(
    failingTestPaths(
      ['Run tests', 'Failing: Failed:    svc-protocol#test; FAIL  src/lending/a.onchain.test.ts > S > cascade; FAIL  src/b.test.ts > x;'],
      resolve,
    ),
    ['services/svc-protocol/src/b.test.ts', 'services/svc-protocol/src/lending/a.onchain.test.ts'],
    'parses the Failing step',
  );
  eq(failingTestPaths(['Why: AssertionError: x'], resolve), [], 'other steps ignored');
  eq(ownerFor('services/svc-a/x.test.ts', { 'services/svc-a/': 'alice' }, 'bob'), 'alice', 'override wins');
  eq(ownerFor('services/svc-b/x.test.ts', { 'services/svc-a/': 'alice' }, 'bob'), 'bob', 'last committer otherwise');
  eq(ownerFor('x.test.ts', {}, null), null, 'unknown owner stays null');
  eq(missingLabels([], ['main-unknown-red'], ['main-unknown-red', 'regression']), ['main-unknown-red'], 'a bare issue gets its label');
  eq(
    missingLabels([{ name: 'regression' }], ['main-unknown-red'], ['main-unknown-red', 'regression']),
    [],
    'a traced red keeps regression',
  );
}

/**
 * Each issue-opening path of main() against a stub GitHub (RULING 7): the labels go in the request that opens the
 * issue, so no issue ever exists bare, and an open issue missing its label gets it on the next red.
 */
async function selfTestPaths() {
  const eq = (got, want, m) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${m}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  };
  const sha = 'a'.repeat(40);
  async function run(env, { jobs, openIssue = null, rejectAssignee = false }) {
    const calls = [];
    const realFetch = globalThis.fetch;
    const realEnv = { ...process.env };
    const realLog = console.log;
    globalThis.fetch = async (url, init) => {
      const path = String(url).replace(API, '');
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ method: init.method, path, body });
      const reply = (status, json) => new Response(json === undefined ? '' : JSON.stringify(json), { status });
      if (path.includes('/jobs?')) return reply(200, { jobs });
      if (path.startsWith('/search/issues')) return reply(200, { items: openIssue ? [openIssue] : [] });
      if (path === '/repos/o/r/issues' && init.method === 'POST')
        return body.assignees?.length && rejectAssignee ? reply(422, { message: 'Validation Failed' }) : reply(201, { number: 9001 });
      if (path.includes('/git/ref/heads/last-green')) return reply(200, { object: { sha } });
      if (path.includes('/commits?path=')) return reply(200, [{ author: { login: 'github-actions[bot]' }, commit: { message: 'x (#1)' } }]);
      return reply(init.method === 'GET' ? 200 : 201, {});
    };
    Object.assign(process.env, { GITHUB_REPOSITORY: 'o/r', RUN_ID: '1', HEAD_SHA: sha, GH_TOKEN: 't', ...env });
    console.log = () => {};
    try {
      await main();
    } finally {
      globalThis.fetch = realFetch;
      process.env = realEnv;
      console.log = realLog;
    }
    return calls
      .filter((c) => c.method !== 'GET' && !c.path.includes('/dispatches'))
      .map((c) => [c.method, c.path, c.body?.labels ?? null]);
  }
  const red = { CONCLUSION: 'failure', RUN_ATTEMPT: '2' };
  // #7881's path: a red with no "Failing:" step names no test file, and the issue still opens labelled.
  const noFile = [{ name: 'Format', conclusion: 'failure', steps: [{ name: 'Run prettier' }] }];
  eq(
    await run(red, { jobs: noFile }),
    [['POST', '/repos/o/r/issues', ['main-unknown-red']]],
    'a red naming no test file opens "Main is red" as main-unknown-red',
  );
  const named = [
    {
      name: 'Tests (shard 1)',
      conclusion: 'failure',
      steps: [{ name: 'Failing: Failed: x#test; FAIL  tooling/ci/main-trust.mjs.test.ts > a;' }],
    },
  ];
  eq(
    await run(red, { jobs: named }),
    [['POST', '/repos/o/r/issues', ['main-unknown-red']]],
    'a red naming a test file opens "Main is red" as main-unknown-red until the bisect names a merge',
  );
  eq(
    await run(red, { jobs: noFile, openIssue: { number: 7881, title: 'Main is red', labels: [] } }),
    [
      ['POST', '/repos/o/r/issues/7881/comments', null],
      ['POST', '/repos/o/r/issues/7881/labels', ['main-unknown-red']],
    ],
    'an open bare "Main is red" gets main-unknown-red on the next red',
  );
  eq(
    await run(red, { jobs: noFile, openIssue: { number: 7881, title: 'Main is red', labels: [{ name: 'regression' }] } }),
    [['POST', '/repos/o/r/issues/7881/comments', null]],
    'a "Main is red" the bisect traced keeps regression',
  );
  const flakyRun = { CONCLUSION: 'success', RUN_ATTEMPT: '2' };
  eq(
    (await run(flakyRun, { jobs: named, rejectAssignee: true })).filter((c) => c[1] === '/repos/o/r/issues'),
    [
      ['POST', '/repos/o/r/issues', ['flaky-test']],
      ['POST', '/repos/o/r/issues', ['flaky-test']],
    ],
    'a flaky unit test opens "Flaky on main" as flaky-test, kept when the owner cannot be assigned',
  );
  console.log('✓ main-trust --self-test OK (20 fixtures)');
}

async function main() {
  const { GITHUB_REPOSITORY: repo, RUN_ID: runId, RUN_ATTEMPT, CONCLUSION, HEAD_SHA: sha } = process.env;
  if (!repo || !runId || !CONCLUSION || !sha) throw new Error('GITHUB_REPOSITORY, RUN_ID, CONCLUSION and HEAD_SHA are required');
  const attempt = Number(RUN_ATTEMPT || 1);
  const action = decide({ conclusion: CONCLUSION, attempt });
  const runUrl = `https://github.com/${repo}/actions/runs/${runId}`;
  console.log(`main run ${runId} attempt ${attempt}: ${CONCLUSION} -> ${action}`);

  if (action === 'ignore') return;
  if (action === 'rerun') {
    const r = await gh('POST', `/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`);
    console.log(`re-run of failed jobs requested (${r.status}); no further action until it finishes`);
    return;
  }

  const overrides = existsSync('tooling/ci/flaky-owners.json') ? JSON.parse(readFileSync('tooling/ci/flaky-owners.json', 'utf8')) : {};
  const resolve = dirResolver();

  if (action === 'real-red') {
    const tests = failingTestPaths(await failedStepNames(repo, runId, attempt), resolve);
    const body = [
      `Main failed twice on \`${sha.slice(0, 10)}\` (the failed jobs were re-run once): [run ${runId}](${runUrl}).`,
      '',
      tests.length
        ? `Failing test files:\n${tests.map((t) => `- \`${t}\``).join('\n')}`
        : 'No failing test file was named; see the run for the failing job.',
      '',
      '_Opened by tooling/ci/main-trust.mjs._',
    ].join('\n');
    const red = await upsertIssue(repo, 'Main is red', body, {
      labels: [RED_LABELS.untraced],
      accepted: [RED_LABELS.untraced, RED_LABELS.traced],
    });
    console.log(`opened or updated issue #${red}`);
    console.log(await startBisect(repo, sha, tests, await failedProbedJobs(repo, runId, attempt), runId));
    return;
  }

  if (action === 'green-after-rerun') {
    const tests = failingTestPaths(await failedStepNames(repo, runId, attempt - 1), resolve);
    for (const t of tests) {
      const { login, pr } = await lastCommit(repo, t);
      const owner = ownerFor(t, overrides, login);
      const body = [
        `\`${t}\` failed on main and passed on the re-run of the same commit \`${sha.slice(0, 10)}\` ([run ${runId}](${runUrl})). That makes it flaky.`,
        `Owner: ${owner ? `@${owner}` : 'unassigned'}${pr ? ` (last changed in #${pr})` : ''}. Fix the cause; the test stays enabled.`,
        '',
        '_Opened by tooling/ci/main-trust.mjs._',
      ].join('\n');
      console.log(
        `flaky ${t}: issue #${await upsertIssue(repo, `Flaky on main: ${t}`, body, { assignee: owner, labels: [UNIT_FLAKY_LABEL] })}`,
      );
    }
  }

  console.log(await publishLastGreen(repo, sha));
  console.log(await closeSettledRed(repo, sha, runUrl));
}

if (process.argv.includes('--self-test')) {
  selfTest();
  selfTestPaths().catch((e) => {
    console.error(`✖ main-trust --self-test: ${e.message}`);
    process.exit(1);
  });
} else if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`✖ main-trust: ${e.message}`);
    process.exit(1);
  });
}
