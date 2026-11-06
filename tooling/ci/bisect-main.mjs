#!/usr/bin/env node
/**
 * BISECT MAIN — which commit since the last green broke the failing tests (workflow: main-bisect.yml).
 *
 * Main trust opens "Main is red" once a main run has failed twice, and starts this with the last-green commit, the red
 * commit and the failing test files. This walks the first-parent commits between them with a binary search, running
 * only those test files at each probe, so it takes about log2(n) probes instead of one full suite per commit. A probe
 * counts as failed only if it fails twice (one re-run confirms, as everywhere else); nothing is skipped or changed.
 * The result is a comment on the culprit's pull request and on the "Main is red" issue. It reverts nothing.
 *
 * It runs from a copy outside the checkout (the workflow copies it to RUNNER_TEMP first) because the search checks out
 * old commits, which would swap this file for an older one mid-run.
 *
 * JOURNEYS MODE (--journeys; started by Main trust's post-merge job, tooling/ci/post-merge-trust.mjs, when a main
 * journeys run shows a new red step outside docs/runbooks/journey-baseline.json). Owner decisions OWNER 180 and 211 in
 * project-state: with no merge queue, a breaking commit is fixed or reverted within 2 hours. A probe is one targeted
 * Real-app journeys run of the red steps' journey files at one commit, dispatched on a `journey-probe/<sha>` tag (a
 * targeted run may not run on main, and a tag pins the exact commit; tags are made once and never moved or deleted).
 * Each round probes the red commit's neighbours in parallel (up to PROBE_FANOUT), so 8 commits take 2 rounds of about
 * 12 minutes. The flake guard: the commit it pins failed the steps twice (the main run, or a first probe, and one more
 * probe), its parent passed them or had no such step, and no probed commit after a failing one passed. A step that
 * passes on a re-run at the red commit is flaky and pins nothing; any other mixed result, or a probe whose report is
 * missing, ends the search with nothing pinned (fail closed).
 * Then --revert opens the revert of the pinned commit's merged pull request on the branch `auto-revert/pr-<n>` (the
 * business key: one per pull request, ever), labels it `auto-revert`, links it to that pull request and turns on
 * auto-merge, so the normal seal decides it. It opens nothing when the pull request is itself a revert, the steps
 * already pass again on main, the revert does not apply cleanly, or three auto-revert pull requests are open. Pull
 * requests opened with the GITHUB_TOKEN run no checks, and this repository lets no workflow open one, so opening and
 * arming needs the revert app's token (vars.AUTO_REVERT_APP_ID, secrets.AUTO_REVERT_APP_KEY; --app-token mints it).
 * Without it, the revert branch is pushed and the culprit pull request is told, with the link to open it.
 *
 *   node bisect-main.mjs --self-test
 *   (CI) GOOD BAD TESTS GH_TOKEN GITHUB_REPOSITORY node bisect-main.mjs
 *   (CI) GOOD BAD STEPS GH_TOKEN GITHUB_REPOSITORY [DRY_RUN=1] node tooling/ci/bisect-main.mjs --journeys
 *   (CI) CULPRIT STEPS REPORT GH_TOKEN [REVERT_TOKEN] [DRY_RUN=1] node tooling/ci/bisect-main.mjs --revert
 *   (CI) APP_ID APP_KEY GITHUB_REPOSITORY node tooling/ci/bisect-main.mjs --app-token
 * DRY_RUN=1 runs the probes for real (they are the evidence) and prints every revert write instead of sending it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SHA = /^[0-9a-f]{40}$/;
const TEST_PATH = /^(apps|services|packages|tooling)\/[\w.-]+\/[\w./@-]+\.(test|spec)\.[cm]?[jt]sx?$/;
export const MAX_COMMITS = 200;

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
function failsHere(tests) {
  const byPkg = new Map();
  for (const t of tests) {
    const [dir, rel] = splitTestPath(t);
    if (!existsSync(join(dir, rel))) continue; // the file does not exist at this commit, so it cannot fail here
    byPkg.set(dir, [...(byPkg.get(dir) ?? []), rel]);
  }
  if (!byPkg.size) return false;
  if (sh('pnpm', ['install', '--frozen-lockfile']).status !== 0) return true; // a commit that cannot install is not good
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

async function gh(method, path, body, token = process.env.GH_TOKEN) {
  const res = await fetch(path.startsWith('https://') ? path : `https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
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

async function report(repo, culprit, tests, probed, runUrl) {
  const subject = git('log', '-1', '--format=%s', culprit);
  const pr = /\(#(\d+)\)\s*$/.exec(subject)?.[1];
  const lines = [
    `Bisect of the red on main: the first commit where ${tests.length === 1 ? 'this test file fails' : 'these test files fail'} is \`${culprit.slice(0, 10)}\` (${subject}).`,
    '',
    tests.map((t) => `- \`${t}\``).join('\n'),
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

// ── Journeys mode ─────────────────────────────────────────────────────────
export const PROBE_FANOUT = 3;
export const PROBE_TAG_PREFIX = 'journey-probe/';
export const REVERT_BRANCH = (pr) => `auto-revert/pr-${pr}`;
export const MAX_OPEN_REVERTS = 3;
const JOURNEYS_WORKFLOW_FILE = 'real-app-journeys.yml';
const STEP_KEY = /^J-[a-z0-9]+(?:-[a-z0-9]+)*-\d+#\d+$/;
const JOURNEY_FILE = /^J-[a-z0-9]+(?:-[a-z0-9]+)*\.pw\.mjs$/;
const POLL_MS = Number(process.env.PROBE_POLL_MS || 60_000);
/** A probe run that has not finished after this long is unknown (the run's own limits end it sooner). */
const PROBE_LIMIT_MS = 75 * 60_000;

/** The `steps` input: one `<step> <journey file>` per line. Returns { steps, files }; anything else is refused. */
export function parseSteps(text) {
  const steps = [];
  const files = {};
  for (const line of String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    const [step, file, extra] = line.split(/\s+/);
    if (!STEP_KEY.test(step ?? '') || !JOURNEY_FILE.test(file ?? '') || extra !== undefined)
      throw new Error(`not a "<step> <journey file>" line: ${line}`);
    if (!files[step]) steps.push(step);
    files[step] = file;
  }
  return { steps, files };
}

/** Up to `k` commit indexes strictly between `lo` (good) and `hi` (bad), evenly spread. */
export function interior(lo, hi, k = PROBE_FANOUT) {
  const span = hi - lo;
  const n = Math.min(k, span - 1);
  const out = new Set();
  for (let i = 1; i <= n; i++) out.add(lo + Math.round((i * span) / (n + 1)));
  return [...out].filter((i) => i > lo && i < hi).sort((a, b) => a - b);
}

/**
 * The first commit where the steps fail. `commits` is oldest first; the last one failed them in the main run (one
 * failure) and the commit before the first passed them or had no such step. `probe(sha)` resolves 'failed', 'passed'
 * or 'unknown'. Returns { verdict: 'pinned' | 'flaky' | 'inconclusive', culprit?, parent?, why?, probes }; `parent` is
 * the probed commit before the culprit, or null when it is the good end.
 */
export async function searchJourneys(commits, probe, k = PROBE_FANOUT) {
  const red = commits.length - 1;
  let lo = -1;
  let hi = red;
  const failures = new Map([[hi, 1]]);
  const probes = [];
  const short = (i) => `\`${commits[i].slice(0, 10)}\``;
  for (;;) {
    const confirm = failures.get(hi) < 2;
    const pts = interior(lo, hi, k);
    if (!confirm && !pts.length) return { verdict: 'pinned', culprit: commits[hi], parent: lo >= 0 ? commits[lo] : null, probes };
    const want = [...(confirm ? [hi] : []), ...pts];
    const got = await Promise.all(want.map((i) => probe(commits[i])));
    want.forEach((i, j) => probes.push({ sha: commits[i], result: got[j] }));
    const unknown = want.filter((_, j) => got[j] === 'unknown');
    if (unknown.length) return { verdict: 'inconclusive', why: `no result from the probe at ${unknown.map(short).join(', ')}`, probes };
    if (confirm) {
      if (got[0] === 'passed')
        return hi === red
          ? { verdict: 'flaky', why: `the steps passed on a re-run at the red commit ${short(hi)}`, probes }
          : { verdict: 'inconclusive', why: `${short(hi)} failed the steps once and passed them once`, probes };
      failures.set(hi, 2);
    }
    const res = pts.map((i, j) => [i, got[j + (confirm ? 1 : 0)]]);
    const first = res.findIndex(([, r]) => r === 'failed');
    if (first >= 0 && res.slice(first).some(([, r]) => r === 'passed'))
      return { verdict: 'inconclusive', why: 'a commit passed the steps after an earlier commit failed them', probes };
    if (first >= 0) {
      if (first > 0) lo = res[first - 1][0];
      hi = res[first][0];
      failures.set(hi, 1);
    } else if (res.length) lo = res[res.length - 1][0];
  }
}

/**
 * A probe's result from its report (a readReport() result): 'failed' when any step failed; 'passed' when every step
 * passed, or is absent while another step of its journey file ran (the step does not exist at that commit); 'unknown'
 * otherwise (no report, a skipped step, or a file whose steps did not run).
 */
export function probeResult(read, steps, files) {
  if (!read) return 'unknown';
  const ran = new Set(Object.keys(read.states).map((k) => read.files[k]));
  let result = 'passed';
  for (const step of steps) {
    const state = read.states[step];
    if (state === 'failed') return 'failed';
    if (state === 'passed') continue;
    if (state === undefined && ran.has(files[step])) continue;
    result = 'unknown';
  }
  return result;
}

/** One probe: the steps' journey files at `sha`, in a targeted Real-app journeys run on its probe tag. */
function makeProbe({ repo, steps, files, log }) {
  const claimed = new Set();
  return async (sha) => {
    const wanted = [...new Set(steps.map((s) => files[s]))];
    const present = [];
    for (const f of wanted) {
      const r = await gh('GET', `/repos/${repo}/contents/apps/customer/tests/real-app/${f}?ref=${sha}`);
      if (r.status === 200) present.push(f);
      else if (r.status !== 404) return 'unknown';
    }
    const mine = steps.filter((s) => present.includes(files[s]));
    if (!mine.length) {
      log(`probe ${sha.slice(0, 10)}: no journey file of these steps exists here, so none can fail: passes`);
      return 'passed';
    }
    const tag = `${PROBE_TAG_PREFIX}${sha}`;
    const made = await gh('POST', `/repos/${repo}/git/refs`, { ref: `refs/tags/${tag}`, sha });
    if (made.status !== 201) {
      const cur = await gh('GET', `/repos/${repo}/git/ref/tags/${tag}`);
      if (cur.json?.object?.sha !== sha) return 'unknown';
    }
    const since = new Date(Date.now() - 10_000).toISOString();
    const d = await gh('POST', `/repos/${repo}/actions/workflows/${JOURNEYS_WORKFLOW_FILE}/dispatches`, {
      ref: `refs/tags/${tag}`,
      inputs: { journeys: present.join(' ') },
      return_run_details: true,
    });
    let runId = d.json?.workflow_run_id;
    for (let i = 0; !runId && d.status < 300 && i < 10; i++) {
      await new Promise((r) => setTimeout(r, 10_000));
      const { json } = await gh(
        'GET',
        `/repos/${repo}/actions/workflows/${JOURNEYS_WORKFLOW_FILE}/runs?event=workflow_dispatch&head_sha=${sha}&created=${encodeURIComponent(`>=${since}`)}&per_page=20`,
      );
      runId = (json?.workflow_runs ?? []).map((r) => r.id).find((id) => !claimed.has(id));
    }
    if (!runId) return (log(`probe ${sha.slice(0, 10)}: dispatch gave no run (HTTP ${d.status})`), 'unknown');
    claimed.add(runId);
    const url = `https://github.com/${repo}/actions/runs/${runId}`;
    const deadline = Date.now() + PROBE_LIMIT_MS;
    let run;
    do {
      await new Promise((r) => setTimeout(r, POLL_MS));
      run = (await gh('GET', `/repos/${repo}/actions/runs/${runId}`)).json;
    } while (run?.status !== 'completed' && Date.now() < deadline);
    if (run?.status !== 'completed') return (log(`probe ${sha.slice(0, 10)}: [run ${runId}](${url}) did not finish in time`), 'unknown');
    const { journeyReport } = await import('./post-merge-trust.mjs');
    const { readReport } = await import('./journey-verdict.mjs');
    const report = await journeyReport(repo, runId);
    const result = probeResult(report ? readReport(report) : null, mine, files);
    log(`probe \`${sha.slice(0, 10)}\` ${present.join(', ')}: **${result}** ([run ${runId}](${url}), ${run.conclusion})`);
    return result;
  };
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function journeysMain() {
  const { GOOD, BAD, STEPS, GITHUB_REPOSITORY: repo, GITHUB_SERVER_URL, GITHUB_RUN_ID, RUNNER_TEMP } = process.env;
  if (!SHA.test(GOOD ?? '') || !SHA.test(BAD ?? '')) throw new Error('GOOD and BAD must be full commit shas');
  const { steps, files } = parseSteps(STEPS);
  if (!steps.length) throw new Error('STEPS names no step');
  const { json: cmp } = await gh('GET', `/repos/${repo}/compare/${GOOD}...${BAD}`);
  if (cmp?.status !== 'ahead') throw new Error(`${BAD.slice(0, 10)} is ${cmp?.status} of ${GOOD.slice(0, 10)}, not ahead`);
  const { MAX_JOURNEY_BISECT_COMMITS } = await import('./post-merge-trust.mjs');
  const commits = git('rev-list', '--first-parent', '--reverse', `${GOOD}..${BAD}`).split('\n').filter(Boolean);
  if (!commits.length || commits.length > MAX_JOURNEY_BISECT_COMMITS)
    throw new Error(`${commits.length} commits between the runs; a journeys bisect takes 1 to ${MAX_JOURNEY_BISECT_COMMITS}`);
  const lines = [];
  const log = (l) => (console.log(l), lines.push(`- ${l}`));
  const runUrl = `${GITHUB_SERVER_URL}/${repo}/actions/runs/${GITHUB_RUN_ID}`;
  log(
    `${steps.join(', ')} failed on main at \`${BAD.slice(0, 10)}\` and passed, or did not exist, at \`${GOOD.slice(0, 10)}\`: ${commits.length} commit(s) between`,
  );
  const r = await searchJourneys(commits, makeProbe({ repo, steps, files, log }));
  const head =
    r.verdict === 'pinned'
      ? `The journeys bisect pinned the break to \`${r.culprit.slice(0, 10)}\` (${git('log', '-1', '--format=%s', r.culprit)}). It failed the steps twice; ${r.parent ? `its parent \`${r.parent.slice(0, 10)}\` passed them` : `the good end \`${GOOD.slice(0, 10)}\` before it passed them or had no such step`}.`
      : `The journeys bisect pinned nothing: ${r.verdict}, ${r.why}. Nothing is reverted.`;
  const report = [head, '', `Steps: ${steps.join(', ')}. [Bisect run](${runUrl}).`, '', ...lines].join('\n');
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Journeys bisect\n\n${report}\n`);
  if (RUNNER_TEMP) writeFileSync(`${RUNNER_TEMP}/journeys-bisect.md`, report);
  setOutput('verdict', r.verdict);
  if (r.verdict === 'pinned') setOutput('culprit', r.culprit);
}

// ── The revert ────────────────────────────────────────────────────────────
/** The merged pull request whose squash commit is `sha`, from GET /commits/<sha>/pulls; null when none. */
export const mergedPull = (pulls, sha) =>
  (pulls ?? []).find((p) => p.merged_at && p.merge_commit_sha === sha && p.base?.ref === 'main') ?? null;
/** A pull request that is itself an auto-revert (or any revert) is never reverted again. */
export const isRevert = (pr) =>
  pr.head?.ref?.startsWith('auto-revert/') ||
  (pr.labels ?? []).some((l) => l.name === 'auto-revert') ||
  /^(ci: )?revert[:(!]/i.test(pr.title ?? '');
/** The revert's title: no journey step in it (the merge seal would then wait for those steps to pass), `ci:` when the
 *  reverted change touches gate files, as the gate-file guard asks. */
export const revertTitle = (pr, gate) => `${gate ? 'ci: revert' : 'revert:'} #${pr.number}, which turned main's journeys red`;
export function revertBody({ pr, culprit, steps, report }) {
  return [
    `Reverts #${pr.number} (\`${culprit.slice(0, 10)}\`), opened by Main trust's auto-revert: main's Real-app journeys turned steps red that are not in \`docs/runbooks/journey-baseline.json\`, and the journeys bisect pinned them to this pull request (owner decisions OWNER 180 and 211: a breaking commit is fixed or reverted within 2 hours).`,
    '',
    report,
    '',
    'The normal merge seal decides this pull request; nothing is bypassed. If the break is fixed forward first, Main trust closes it once the steps pass on two main runs in a row. To undo the revert, re-land the change with its fix.',
    '',
    `<!-- auto-revert-steps: ${steps.join(', ')} -->`,
    '_Opened by tooling/ci/bisect-main.mjs (main-bisect.yml)._',
  ].join('\n');
}

/** A GitHub App installation token for this repository, for the revert's pull request (masked in the log). */
async function appToken() {
  const { APP_ID, APP_KEY, GITHUB_REPOSITORY: repo } = process.env;
  if (!APP_ID || !APP_KEY) return console.log('no revert app is set up (vars.AUTO_REVERT_APP_ID, secrets.AUTO_REVERT_APP_KEY)');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: APP_ID })}`;
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(APP_KEY, 'base64url')}`;
  const inst = await gh('GET', `/repos/${repo}/installation`, undefined, jwt);
  if (inst.status !== 200) throw new Error(`the revert app is not installed on ${repo} (HTTP ${inst.status})`);
  const tok = await gh(
    'POST',
    `/app/installations/${inst.json.id}/access_tokens`,
    { repositories: [repo.split('/')[1]], permissions: { contents: 'write', pull_requests: 'write', issues: 'write' } },
    jwt,
  );
  if (tok.status !== 201) throw new Error(`no token from the revert app (HTTP ${tok.status})`);
  console.log(`::add-mask::${tok.json.token}`);
  setOutput('token', tok.json.token);
}

async function revertMain() {
  const { CULPRIT, STEPS, REPORT, REVERT_TOKEN, GITHUB_REPOSITORY: repo, GH_TOKEN } = process.env;
  const dry = process.env.DRY_RUN === '1';
  if (!SHA.test(CULPRIT ?? '')) throw new Error('CULPRIT must be a full commit sha');
  const { steps } = parseSteps(STEPS);
  const report = REPORT && existsSync(REPORT) ? readFileSync(REPORT, 'utf8') : '';
  const write = async (method, path, body, token = GH_TOKEN) => {
    if (dry) return (console.log(`DRY_RUN ${method} ${path}${body ? `\n${JSON.stringify(body, null, 2)}` : ''}`), { status: 0, json: {} });
    return gh(method, path, body, token);
  };
  const say = (pr, text) =>
    write('POST', `/repos/${repo}/issues/${pr}/comments`, { body: `${text}\n\n_Main trust auto-revert, tooling/ci/bisect-main.mjs._` });
  const pr = mergedPull((await gh('GET', `/repos/${repo}/commits/${CULPRIT}/pulls`)).json, CULPRIT);
  if (!pr) return console.log(`\`${CULPRIT.slice(0, 10)}\` is no merged pull request's commit on main: nothing to revert`);
  if (isRevert(pr))
    return say(
      pr.number,
      `The journeys bisect pinned ${steps.join(', ')} to this revert. A revert is never reverted automatically; fix forward.\n\n${report}`,
    );
  // Fixed forward already: the newest finished main journeys run that holds the culprit passes every step.
  const { JOURNEYS_WORKFLOW, journeyReport } = await import('./post-merge-trust.mjs');
  const { readReport } = await import('./journey-verdict.mjs');
  const { json: runs } = await gh(
    'GET',
    `/repos/${repo}/actions/workflows/${JOURNEYS_WORKFLOW_FILE}/runs?branch=main&status=completed&per_page=30`,
  );
  const newest = (runs?.workflow_runs ?? []).find(
    (r) => r.name === JOURNEYS_WORKFLOW && r.conclusion !== 'cancelled' && ['push', 'schedule', 'workflow_dispatch'].includes(r.event),
  );
  if (newest) {
    const holds = (await gh('GET', `/repos/${repo}/compare/${CULPRIT}...${newest.head_sha}`)).json?.status;
    const rep = holds === 'ahead' ? await journeyReport(repo, newest.id) : null;
    const states = rep ? readReport(rep).states : null;
    if (states && steps.every((s) => states[s] === 'passed'))
      return say(
        pr.number,
        `${steps.join(', ')} already pass again on main ([run ${newest.id}](${newest.html_url})), so this is not reverted.\n\n${report}`,
      );
  }
  const branch = REVERT_BRANCH(pr.number);
  if ((await gh('GET', `/repos/${repo}/git/ref/heads/${branch}`)).status === 200)
    return console.log(`${branch} exists already: this pull request's revert was opened before; nothing more`);
  const open = (await gh('GET', `/repos/${repo}/issues?labels=auto-revert&state=open&per_page=50`)).json ?? [];
  if (open.filter((i) => i.pull_request).length >= MAX_OPEN_REVERTS)
    return say(
      pr.number,
      `The journeys bisect pinned ${steps.join(', ')} to this pull request, but ${MAX_OPEN_REVERTS} auto-revert pull requests are open already, so none more is opened. Fix forward or revert by hand.\n\n${report}`,
    );
  // The revert commit, on current main.
  git('fetch', '--quiet', 'origin', 'main');
  git('checkout', '--quiet', '-B', branch, 'origin/main');
  const ident = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];
  const files = git('show', '--name-only', '--format=', CULPRIT).split('\n').filter(Boolean);
  const { gateFilesTouched } = await import('../scripts/gate-file-guard.mjs');
  const title = revertTitle(pr, gateFilesTouched(files).length > 0);
  const r = spawnSync('git', [...ident, 'revert', '--no-edit', CULPRIT], { encoding: 'utf8' });
  if (r.status !== 0) {
    spawnSync('git', ['revert', '--abort']);
    return say(
      pr.number,
      `The journeys bisect pinned ${steps.join(', ')} to this pull request, but its revert does not apply cleanly on current main, so none is opened. Fix forward.\n\n${report}`,
    );
  }
  execFileSync('git', [...ident, 'commit', '--amend', '--quiet', '-m', title, '-m', `This reverts commit ${CULPRIT} (#${pr.number}).`]);
  const pushToken = REVERT_TOKEN || GH_TOKEN;
  const auth = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${pushToken}`).toString('base64')}`;
  if (dry) console.log(`DRY_RUN git push origin HEAD:refs/heads/${branch} (${git('log', '-1', '--format=%h %s')})`);
  else
    execFileSync('git', [
      '-c',
      `http.https://github.com/.extraheader=${auth}`,
      'push',
      '--quiet',
      `https://github.com/${repo}.git`,
      `HEAD:refs/heads/${branch}`,
    ]);
  if (!REVERT_TOKEN)
    return say(
      pr.number,
      `The journeys bisect pinned ${steps.join(', ')} to this pull request. Its revert is ready on \`${branch}\`, but no revert app is set up (pull requests the workflow's own token opens run no checks), so it is not opened. Open it: https://github.com/${repo}/compare/main...${branch}?expand=1\n\n${report}`,
    );
  const made = await write(
    'POST',
    `/repos/${repo}/pulls`,
    { title, head: branch, base: 'main', body: revertBody({ pr, culprit: CULPRIT, steps, report }) },
    REVERT_TOKEN,
  );
  if (!dry && made.status !== 201) throw new Error(`could not open the revert pull request (HTTP ${made.status})`);
  const n = made.json?.number;
  await write('POST', `/repos/${repo}/labels`, {
    name: 'auto-revert',
    color: 'b60205',
    description: 'Opened by Main trust: reverts a pull request that broke main',
  });
  await write('POST', `/repos/${repo}/issues/${n}/labels`, { labels: ['auto-revert'] }, REVERT_TOKEN);
  const armed = await write(
    'POST',
    'https://api.github.com/graphql',
    {
      query: 'mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { clientMutationId } }',
      variables: { id: made.json?.node_id },
    },
    REVERT_TOKEN,
  );
  const armedOk = dry || (armed.status === 200 && !armed.json?.errors);
  await say(
    pr.number,
    `The journeys bisect pinned ${steps.join(', ')} to this pull request. Its revert is #${n}${armedOk ? ', with auto-merge on: the merge seal decides it' : `; auto-merge could not be turned on (${JSON.stringify(armed.json?.errors ?? armed.status)})`}.\n\n${report}`,
  );
  console.log(`opened #${n} reverting #${pr.number}${armedOk ? ', armed' : ', not armed'}`);
}

function selfTest() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
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
  // Journeys mode: a planted fault at each place in a range is pinned; flaky and mixed results pin nothing.
  const eqJ = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}`);
  eqJ(interior(-1, 7), [1, 3, 5], 'interior points of 8 commits');
  eqJ(interior(-1, 2), [0, 1], 'interior points of 3 commits');
  eqJ(interior(-1, 0), [], 'one commit has no interior');
  eqJ(interior(3, 5), [4], 'one interior commit');
  eqJ(
    parseSteps('J-bank-13#1 J-bank-13.pw.mjs\nJ-ops-console-01#2 J-ops-console-01-health.pw.mjs\n'),
    {
      steps: ['J-bank-13#1', 'J-ops-console-01#2'],
      files: { 'J-bank-13#1': 'J-bank-13.pw.mjs', 'J-ops-console-01#2': 'J-ops-console-01-health.pw.mjs' },
    },
    'parses steps',
  );
  for (const bad of ['J-bank-13#1', 'J-bank-13#1 ../x.pw.mjs', 'J-bank-13#1 J-bank-13.pw.mjs; rm -rf /', '$(x) J-a-01.pw.mjs']) {
    let threw = false;
    try {
      parseSteps(bad);
    } catch {
      threw = true;
    }
    assert(threw, `refuses steps line ${bad}`);
  }
  const rd = (states, files) => ({ states, files });
  const F = { 'J-a-01#1': 'J-a-01.pw.mjs', 'J-a-01#2': 'J-a-01.pw.mjs' };
  assert(probeResult(null, ['J-a-01#1'], F) === 'unknown', 'no report: unknown');
  assert(
    probeResult(rd({ 'J-a-01#1': 'passed', 'J-a-01#2': 'failed' }, F), ['J-a-01#1', 'J-a-01#2'], F) === 'failed',
    'a failing step fails the probe',
  );
  assert(
    probeResult(rd({ 'J-a-01#1': 'passed' }, F), ['J-a-01#1', 'J-a-01#2'], F) === 'passed',
    'a step its file does not have yet passes',
  );
  assert(
    probeResult(rd({ 'J-b-01#1': 'passed' }, { 'J-b-01#1': 'J-b-01.pw.mjs' }), ['J-a-01#1'], F) === 'unknown',
    'a file that did not run: unknown',
  );
  assert(probeResult(rd({ 'J-a-01#1': 'skipped' }, F), ['J-a-01#1'], F) === 'unknown', 'a skipped step: unknown');
  const sim = (n, culpritIdx, { flaky = new Set(), unknownAt = -1 } = {}) => {
    const seen = new Map();
    const shas = Array.from({ length: n }, (_, i) => `c${i}`);
    return {
      shas,
      probe: async (sha) => {
        const i = Number(sha.slice(1));
        seen.set(i, (seen.get(i) ?? 0) + 1);
        if (i === unknownAt) return 'unknown';
        if (flaky.has(i)) return seen.get(i) % 2 ? 'passed' : 'failed';
        return i >= culpritIdx ? 'failed' : 'passed';
      },
      seen,
    };
  };
  return (async () => {
    for (const n of [1, 2, 3, 5, 8, 13, 40])
      for (let c = 0; c < n; c++) {
        const { shas, probe } = sim(n, c);
        const r = await searchJourneys(shas, probe);
        assert(r.verdict === 'pinned' && r.culprit === `c${c}`, `planted fault at ${c} of ${n} is pinned, got ${r.verdict} ${r.culprit}`);
        assert(r.parent === (c === 0 ? null : `c${c - 1}`), `the parent of ${c} of ${n} was probed and passed`);
        const fails = r.probes.filter((p) => p.sha === r.culprit && p.result === 'failed').length + (c === n - 1 ? 1 : 0);
        assert(fails >= 2, `the pinned commit failed twice (${c} of ${n})`);
        const rounds = new Set(r.probes.map((p) => p.sha)).size;
        assert(rounds <= n, 'never probes more commits than the range');
      }
    // Known-good: the red does not come back on a re-run at the red commit: flaky, nothing pinned.
    const good = await searchJourneys(['c0', 'c1', 'c2'], async () => 'passed');
    assert(good.verdict === 'flaky' && !good.culprit, `a step that passes on a re-run pins nothing, got ${good.verdict}`);
    assert(good.probes.length === 3, 'the first round probes the red commit and its neighbours together');
    const flakyMid = sim(8, 3, { flaky: new Set([5]) });
    const fm = await searchJourneys(flakyMid.shas, flakyMid.probe);
    assert(fm.verdict !== 'pinned' || fm.culprit === 'c3', `a flaky commit never pins a wrong culprit, got ${fm.verdict} ${fm.culprit}`);
    const mixed = await searchJourneys(
      Array.from({ length: 8 }, (_, i) => `c${i}`),
      async (sha) => (sha === 'c0' || sha === 'c3' ? 'passed' : 'failed'),
    );
    assert(mixed.verdict === 'inconclusive', `a pass after a failing commit pins nothing, got ${mixed.verdict}`);
    const unk = sim(8, 3, { unknownAt: 1 });
    assert((await searchJourneys(unk.shas, unk.probe)).verdict === 'inconclusive', 'a probe with no report pins nothing');
    // The revert's guards.
    const pull = (o) => ({
      number: 7202,
      title: 'svc-bank: J-bank-13 I get a card (J-bank-13 #1 #2)',
      head: { ref: 'agent/x' },
      labels: [],
      merged_at: 'x',
      merge_commit_sha: 'a'.repeat(40),
      base: { ref: 'main' },
      ...o,
    });
    assert(
      mergedPull([pull({ merge_commit_sha: 'b'.repeat(40) }), pull()], 'a'.repeat(40))?.number === 7202,
      'finds the merged pull request of the commit',
    );
    assert(mergedPull([pull({ merged_at: null })], 'a'.repeat(40)) === null, 'an unmerged pull request is not the culprit');
    assert(
      isRevert(pull({ head: { ref: 'auto-revert/pr-1' } })) && isRevert(pull({ title: 'revert: #1, which' })) && !isRevert(pull()),
      'a revert is never reverted',
    );
    const title = revertTitle(pull(), false);
    assert(!/J-[a-z0-9-]+-\d+/.test(title) && title.startsWith('revert: #7202'), `the revert title names no step: ${title}`);
    assert(revertTitle(pull(), true).startsWith('ci: revert #7202'), 'a gate-file revert says ci:');
    const body = revertBody({ pr: pull(), culprit: 'a'.repeat(40), steps: ['J-bank-13#1'], report: 'R' });
    assert(
      body.includes('<!-- auto-revert-steps: J-bank-13#1 -->') && body.includes('Reverts #7202'),
      'the body links the pull request and names its steps',
    );
    assert(!/^Left-or-replaced:/m.test(body), 'the body exempts no step');
    assert(REVERT_BRANCH(7202) === 'auto-revert/pr-7202', 'one revert branch per pull request');
    console.log('✓ bisect-main --self-test OK');
  })();
}

async function main() {
  const { GOOD, BAD, TESTS, GITHUB_REPOSITORY: repo, GITHUB_SERVER_URL, GITHUB_RUN_ID } = process.env;
  if (!SHA.test(GOOD ?? '') || !SHA.test(BAD ?? '')) throw new Error('GOOD and BAD must be full commit shas');
  const tests = parseTests(TESTS);
  if (!tests.length) throw new Error('TESTS names no test file');
  const commits = git('rev-list', '--first-parent', '--reverse', `${GOOD}..${BAD}`).split('\n').filter(Boolean);
  if (!commits.length) throw new Error(`no commits between ${GOOD} and ${BAD}`);
  if (commits.length > MAX_COMMITS) throw new Error(`${commits.length} commits since the last green; more than ${MAX_COMMITS}`);
  console.log(`${commits.length} commit(s) between the last green and the red; probing with ${tests.length} test file(s)`);
  const { culprit, probed } = firstBad(commits, (sha) => {
    git('checkout', '--quiet', '--force', sha);
    const bad = failsHere(tests);
    console.log(`probe ${sha.slice(0, 10)}: ${bad ? 'FAILS' : 'passes'}`);
    return bad;
  });
  await report(repo, culprit, tests, probed, `${GITHUB_SERVER_URL}/${repo}/actions/runs/${GITHUB_RUN_ID}`);
}

const fail = (e) => {
  console.error(`✖ bisect-main: ${e.message}`);
  process.exit(1);
};
if (process.argv.includes('--self-test')) {
  Promise.resolve(selfTest()).catch(fail);
} else if (process.argv.includes('--journeys')) {
  journeysMain().catch(fail);
} else if (process.argv.includes('--revert')) {
  revertMain().catch(fail);
} else if (process.argv.includes('--app-token')) {
  appToken().catch(fail);
} else if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`✖ bisect-main: ${e.message}`);
    process.exit(1);
  });
}
