#!/usr/bin/env node
/**
 * BISECT MAIN — which commit since the last green broke the failing tests (workflow: main-bisect.yml).
 *
 * Main trust opens "Main is red" once a main run has failed twice, and starts this with the last-green commit, the red
 * commit and the failing test files. This walks the first-parent commits between them with a binary search, running
 * only those test files at each probe, so it takes about log2(n) probes instead of one full suite per commit. A probe
 * counts as failed only if it fails twice (one re-run confirms, as everywhere else); nothing is skipped or changed.
 * A red CI job that names no test file but has a probe here (JOB_PROBES: Doctrine gates runs `pnpm gates`) is
 * searched the same way with that job's own command. The result is a comment on the culprit's pull request and on the
 * "Main is red" issue, and the culprit as this job's output, which main-bisect.yml's revert job opens a revert for
 * (journeys-revert.mjs open, the one revert on main for journeys and CI; OWNER 180: a red main is fixed or undone
 * within 2 hours). (Failure it prevents: on 9 Nov 2026 main's Doctrine gates stayed red on #7602's
 * journey-reach-map.test.mjs:555, and builders merged main three times to clear it.)
 *
 * It runs from a copy outside the checkout (the workflow copies it to RUNNER_TEMP first) because the search checks out
 * old commits, which would swap this file for an older one mid-run.
 *
 *   node bisect-main.mjs --self-test
 *   (CI) GOOD BAD TESTS GH_TOKEN GITHUB_REPOSITORY node bisect-main.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SHA = /^[0-9a-f]{40}$/;
const TEST_PATH = /^(apps|services|packages|tooling)\/[\w.-]+\/[\w./@-]+\.(test|spec)\.[cm]?[jt]sx?$/;
export const MAX_COMMITS = 200;
/** CI jobs on main whose failure names no test file, with the command that decides them: each probe runs it twice. */
export const JOB_PROBES = { 'Doctrine gates': ['pnpm', 'gates'] };

/** The probed job names in a comma- or line-separated list; anything else is refused. */
export function parseJobs(text) {
  const jobs = String(text || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = jobs.filter((j) => !Object.hasOwn(JOB_PROBES, j));
  if (bad.length) throw new Error(`no probe for job: ${bad.join(', ')}`);
  return [...new Set(jobs)];
}

/**
 * First bad index in `commits` (oldest first), given that `commits[last]` is bad and the commit before `commits[0]`
 * is good. `isBad(sha)` is only called for commits strictly between, so n commits cost at most ceil(log2 n) probes.
 */
export function firstBad(commits, isBad) {
  let lo = -1; // known good
  let hi = commits.length - 1; // known bad
  const probed = [];
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const bad = isBad(commits[mid]);
    probed.push({ sha: commits[mid], bad });
    if (bad) hi = mid;
    else lo = mid;
  }
  return { culprit: commits[hi], probed };
}

/** The workspace directory and package-relative path of a test file: services/svc-x/src/a.test.ts -> [dir, rel]. */
export function splitTestPath(path) {
  const [group, pkg, ...rest] = path.split('/');
  return [`${group}/${pkg}`, rest.join('/')];
}

export function parseTests(text) {
  const tests = String(text || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = tests.filter((t) => !TEST_PATH.test(t) || t.includes('..'));
  if (bad.length) throw new Error(`not a test file path: ${bad.join(', ')}`);
  return tests;
}

// Old commits run as code here, so the probes do not get the GitHub token that only the report needs.
const { GH_TOKEN: _token, ...PROBE_ENV } = process.env;

function sh(cmd, args) {
  return spawnSync(cmd, args, { stdio: 'inherit', env: PROBE_ENV });
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** Run the failing test files at the checked-out commit. true = they fail (twice). */
/**
 * Installs at the probed commit, trying twice. An install that fails twice says nothing about the commit (a registry or
 * network flake looks the same), so it stops the search with no culprit instead of counting the commit as failing: a
 * wrong culprit would open a revert of an innocent pull request.
 */
export function installOrStop(run = sh) {
  for (let attempt = 1; attempt <= 2; attempt++) if (run('pnpm', ['install', '--frozen-lockfile']).status === 0) return;
  throw new Error("can't probe: pnpm install --frozen-lockfile failed twice at this commit; stopping with no culprit");
}

function failsHere(tests, jobs = []) {
  if (jobs.length) {
    installOrStop();
    for (const job of jobs) {
      const [cmd, ...args] = JOB_PROBES[job];
      if (sh(cmd, args).status !== 0 && sh(cmd, args).status !== 0) return true;
    }
    if (!tests.length) return false;
  }
  const byPkg = new Map();
  for (const t of tests) {
    const [dir, rel] = splitTestPath(t);
    if (!existsSync(join(dir, rel))) continue; // the file does not exist at this commit, so it cannot fail here
    byPkg.set(dir, [...(byPkg.get(dir) ?? []), rel]);
  }
  if (!byPkg.size) return false;
  installOrStop();
  for (const [dir, files] of byPkg) {
    const name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name;
    if (sh('pnpm', ['exec', 'turbo', 'run', 'build', `--filter=${name}^...`]).status !== 0) return true;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = sh('pnpm', ['--filter', name, 'exec', 'vitest', 'run', ...files]);
      if (r.status === 0) break;
      if (attempt === 2) return true;
    }
  }
  return false;
}

async function gh(method, path, body) {
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
  if (res.status === 403 || res.status === 429) throw new Error(`GitHub ${res.status} on ${method} ${path}: stopping, not retrying`);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function report(repo, culprit, tests, probed, runUrl, jobs = []) {
  const subject = git('log', '-1', '--format=%s', culprit);
  const pr = /\(#(\d+)\)\s*$/.exec(subject)?.[1];
  const lines = [
    `Bisect of the red on main: the first commit where ${tests.length + jobs.length === 1 ? 'this fails' : 'these fail'} is \`${culprit.slice(0, 10)}\` (${subject}).`,
    '',
    [...tests.map((t) => `- \`${t}\``), ...jobs.map((j) => `- the ${j} job (\`${JOB_PROBES[j].join(' ')}\`)`)].join('\n'),
    '',
    `It narrowed ${probed.length} probe${probed.length === 1 ? '' : 's'} between the last green and the red commit; a probe fails only if it fails twice. A probable cause, not a proof: a test that depends on an earlier commit's state can point one commit late. [Bisect run](${runUrl}).`,
    '',
    '_Opened by tooling/ci/bisect-main.mjs._',
  ];
  const body = lines.join('\n');
  if (pr) await gh('POST', `/repos/${repo}/issues/${pr}/comments`, { body });
  const q = encodeURIComponent(`repo:${repo} is:issue is:open in:title "Main is red"`);
  const found = await gh('GET', `/search/issues?q=${q}&per_page=5`);
  const issue = (found.json?.items ?? []).find((i) => i.title === 'Main is red');
  if (issue) await gh('POST', `/repos/${repo}/issues/${issue.number}/comments`, { body });
  console.log(`culprit ${culprit} (${subject}); commented on ${pr ? `#${pr}` : 'no PR'}${issue ? ` and issue #${issue.number}` : ''}`);
}

function selfTest() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  // The install: one flake is retried, two stop the search, and nothing counts the commit as failing.
  let calls = 0;
  const flaky = () => ({ status: calls++ === 0 ? 1 : 0 });
  installOrStop(flaky);
  assert(calls === 2, 'a single install flake is retried');
  let stopped = false;
  try {
    installOrStop(() => ({ status: 1 }));
  } catch (e) {
    stopped = /no culprit/.test(e.message);
  }
  assert(stopped, 'an install that fails twice stops the search with no culprit');
  const commits = Array.from({ length: 13 }, (_, i) => `c${i}`);
  for (let culpritIdx = 0; culpritIdx < commits.length; culpritIdx++) {
    let calls = 0;
    const r = firstBad(commits, (sha) => {
      calls += 1;
      return Number(sha.slice(1)) >= culpritIdx;
    });
    assert(r.culprit === commits[culpritIdx], `finds commit ${culpritIdx}, got ${r.culprit}`);
    assert(calls <= 4, `13 commits take at most 4 probes, took ${calls} for ${culpritIdx}`);
  }
  assert(firstBad(['only'], () => assert(false, 'a single commit needs no probe')).culprit === 'only', 'one commit is the culprit');
  assert(splitTestPath('services/svc-x/src/a.test.ts').join('|') === 'services/svc-x|src/a.test.ts', 'splits a test path');
  assert(parseTests('services/svc-x/src/a.test.ts\npackages/y/b.spec.tsx').length === 2, 'parses a list');
  let threw = false;
  try {
    parseTests('services/svc-x/../../etc/passwd.test.ts');
  } catch {
    threw = true;
  }
  assert(threw, 'a path with .. is refused');
  threw = false;
  try {
    parseTests('rm -rf /');
  } catch {
    threw = true;
  }
  assert(threw, 'a non-path is refused');
  assert(SHA.test('a'.repeat(40)) && !SHA.test('main'), 'only full shas are accepted');
  assert(parseJobs('Doctrine gates').join() === 'Doctrine gates', 'a probed job is taken');
  assert(parseJobs('').length === 0, 'no jobs is none');
  threw = false;
  try {
    parseJobs('Doctrine gates,rm -rf /');
  } catch {
    threw = true;
  }
  assert(threw, 'a job with no probe is refused, so no input becomes a command');
  console.log('✓ bisect-main --self-test OK');
}

async function main() {
  const { GOOD, BAD, TESTS, JOBS, GITHUB_REPOSITORY: repo, GITHUB_SERVER_URL, GITHUB_RUN_ID, GITHUB_OUTPUT } = process.env;
  if (!SHA.test(GOOD ?? '') || !SHA.test(BAD ?? '')) throw new Error('GOOD and BAD must be full commit shas');
  const tests = parseTests(TESTS);
  const jobs = parseJobs(JOBS);
  if (!tests.length && !jobs.length) throw new Error('TESTS names no test file and JOBS no probed job');
  const commits = git('rev-list', '--first-parent', '--reverse', `${GOOD}..${BAD}`).split('\n').filter(Boolean);
  if (!commits.length) throw new Error(`no commits between ${GOOD} and ${BAD}`);
  if (commits.length > MAX_COMMITS) throw new Error(`${commits.length} commits since the last green; more than ${MAX_COMMITS}`);
  console.log(
    `${commits.length} commit(s) between the last green and the red; probing with ${tests.length} test file(s) and ${jobs.length} job(s)`,
  );
  const { culprit, probed } = firstBad(commits, (sha) => {
    git('checkout', '--quiet', '--force', sha);
    const bad = failsHere(tests, jobs);
    console.log(`probe ${sha.slice(0, 10)}: ${bad ? 'FAILS' : 'passes'}`);
    return bad;
  });
  await report(repo, culprit, tests, probed, `${GITHUB_SERVER_URL}/${repo}/actions/runs/${GITHUB_RUN_ID}`, jobs);
  // The revert job (main-bisect.yml revert-open) opens the culprit's revert through the normal seal.
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `culprit=${culprit}\n`);
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`✖ bisect-main: ${e.message}`);
    process.exit(1);
  });
}
