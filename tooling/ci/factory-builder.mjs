#!/usr/bin/env node
/**
 * The headless builder's steps (.github/workflows/builder.yml): one journey per run, the pinned CLI headless on a fresh
 * runner, as an unprivileged agent user that holds no GitHub token. Every step runs this file from main's checkout
 * (the job's working directory), never from the agent's working tree. Each subcommand is one step:
 *
 *   check     the dispatched journey and area are well formed, the journey is in docs/roadmap/journeys.json and isn't
 *             parked; writes its module (the project-state folder of its step words) to GITHUB_OUTPUT.
 *   switch    reads the factory switch (factory-switch.mjs); `run=true` only when FACTORY on branch factory-switch says
 *             `run`. A pause ends the run cleanly; an unreadable switch fails it (closed).
 *   branch    the branch this run builds on: the journey's open PR's branch when there is one (a successor resumes it),
 *             else factory/<journey>, or factory/<journey>-r<run number> when that name is already taken.
 *   status    the resumed PR's head and its CI runs (names, states, links), for the agent, which can't read GitHub.
 *   prompt    fetches project-state BUILDER.md and the journey's section of its module's journeys.md with the factory
 *             token, and writes the agent's prompt to a file. Nothing from project-state is ever printed.
 *   run       runs the CLI headless with the prompt, as the agent user when AGENT_USER is set; everything it prints
 *             goes to files in the job, never the log. Every POLL_MS it reads the switch (no token: the repo is public);
 *             a pause, three unreadable reads in a row or the hard stop ends it. However it ends, the agent's processes
 *             get SIGTERM, then after the grace SIGKILL, and the step exits only once none is left.
 *   publish   after the agent's processes are gone: takes the agent's commits from a bundle into a fresh repository,
 *             pushes them to refs/heads/<the picked branch> only (never a force, never another ref), opens or updates
 *             the PR from the agent's PR text, adds the run's Handover-run line, and, if the agent asked, starts the
 *             journey's Real-app journeys run and arms squash auto-merge. The factory token reaches only this step and
 *             the read-only ones before the agent starts.
 *   stats     the run's usage, numbers only, from the CLI's final result event (the trial measures usage per hour).
 *
 * Public-repo hygiene: intafaced is public and anyone can read its logs. Nothing here prints text it fetched from
 * project-state, the agent's PR text or the CLI's output; messages carry only our own words, numbers, ids that passed a
 * strict pattern, and quoted, shortened input (so input can't add lines or workflow commands to the log).
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { judgeSwitch, readSwitch, SWITCH_BRANCH, SWITCH_FILE } from './factory-switch.mjs';

export const PROJECT_STATE = 'INTAFACED/project-state';
export const JOURNEY_RE = /^J-[a-z0-9]+(?:-[a-z0-9]+)*-\d{2,3}[a-z]?$/;
export const AREA_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const BRANCH_PREFIX = 'factory/';
/** Minutes after the build job starts: the brief's own wrap-up time, then the hard stop (job limit 340, GitHub's 360). */
export const SOFT_MIN = 290;
export const HARD_MIN = 320;
export const POLL_MS = 120_000;
export const UNREADABLE_LIMIT = 3;
export const KILL_GRACE_MS = 30_000;
export const MAX_BODY = 60_000;
/**
 * Every command this script starts, by full path, with PATH=/usr/bin:/bin for it: a directory earlier on PATH (the
 * runner image's /usr/local/bin is world-writable) could otherwise hold a fake `git` or `sudo` the agent planted, run
 * with the factory token in its environment. (Found by review round 2 on #7386, with a planted fake `git`.)
 */
export const BIN = { git: '/usr/bin/git', gh: '/usr/bin/gh', sudo: '/usr/bin/sudo', pkill: '/usr/bin/pkill', pgrep: '/usr/bin/pgrep' };
export const SAFE_PATH = '/usr/bin:/bin';
const ADDENDUM = '.github/workflows/builder/ACTIONS.md';
/** Variables the CLI's process never gets: the runner's command files (so it can't write to the public summary or to
 *  later steps' environment), the runner's own tokens, and every GitHub token. The CLI's own token is the one kept. */
const NEVER_TO_AGENT = /^(GITHUB_(STEP_SUMMARY|OUTPUT|ENV|PATH|STATE)|ACTIONS_.*|RUNNER_.*|INPUT_.*)$|TOKEN|_PAT$|^GH_/;
const KEEP = new Set(['CLAUDE_CODE_OAUTH_TOKEN']);
/** Variables sudo sets for the agent itself, so they aren't carried over. */
const SUDO_OWN = new Set([
  'AGENT_PATH',
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'MAIL',
  'SUDO_USER',
  'SUDO_UID',
  'SUDO_GID',
  'SUDO_COMMAND',
  'PWD',
  'OLDPWD',
]);

const quote = (s) => JSON.stringify(String(s ?? '').slice(0, 60));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The dispatch inputs against journeys.json: { journey, module } or { error }. */
export function checkInputs(journey, area, journeys) {
  if (!JOURNEY_RE.test(journey ?? '')) return { error: `journey ${quote(journey)} is not a journey id like J-identity-13` };
  if (!Array.isArray(journeys)) return { error: 'docs/roadmap/journeys.json is not a list' };
  const j = journeys.find((x) => x?.id === journey);
  if (!j) return { error: `${journey} is not in docs/roadmap/journeys.json` };
  if (j.parked) return { error: `${journey} is parked in docs/roadmap/journeys.json, so it isn't built` };
  if (!AREA_RE.test(j.module ?? '')) return { error: `${journey} has no module in docs/roadmap/journeys.json` };
  if (!AREA_RE.test(area ?? '') || area.length > 40) return { error: `area ${quote(area)} is not a short lowercase name` };
  return { journey, module: j.module };
}

/** The journey's section of a module's journeys.md: from its `## <id>:` heading to the next `## ` heading, or null. */
export function journeySection(markdown, journey) {
  if (typeof markdown !== 'string') return null;
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## ${journey}:`) || l.trim() === `## ${journey}`);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n').trim();
}

/** The journey's own branch names: factory/<journey> and factory/<journey>-r<n>, nothing else. */
export const ownBranch = (journey) => new RegExp(`^${escapeRe(BRANCH_PREFIX + journey)}(?:-r\\d+)?$`);

/**
 * The branch to build on. A successor resumes the journey's open PR (the oldest, if somehow there are two); otherwise
 * a fresh branch from main, never one that already exists (a merged or closed journey PR's branch is history).
 */
export function pickBranch({ journey, runNumber, openPulls, repo, taken }) {
  const own = ownBranch(journey);
  const mine = (openPulls ?? [])
    .filter((p) => p?.head?.repo?.full_name === repo && p?.base?.ref === 'main' && own.test(p?.head?.ref ?? ''))
    .sort((a, b) => a.number - b.number);
  if (mine.length) return { branch: mine[0].head.ref, resume: true, pr: mine[0].number, head: mine[0].head.sha };
  const plain = `${BRANCH_PREFIX}${journey}`;
  return { branch: taken ? `${plain}-r${runNumber}` : plain, resume: false, pr: null, head: null };
}

/** The one ref a run may push: refs/heads/<its branch>, and only a branch of its own journey. Anything else throws. */
export function pushRef(branch, journey) {
  if (!JOURNEY_RE.test(journey ?? '')) throw new Error('the journey is not a journey id, so nothing is pushed');
  if (typeof branch !== 'string' || !ownBranch(journey).test(branch))
    throw new Error(`refusing to push ${quote(branch)}: a builder pushes only refs/heads/${BRANCH_PREFIX}${journey}`);
  return `refs/heads/${branch}`;
}

/**
 * Whether to push, from what the fresh repository found. `remoteHead` is the branch's head on GitHub (null if it has
 * none), `newHead` the agent's, `isAncestor(a, b)` whether a is in b's history, `mainHead` main's head.
 */
export function publishPlan({ remoteHead, newHead, mainHead, isAncestor }) {
  if (!/^[0-9a-f]{40}$/.test(newHead ?? '')) return { push: false, why: 'the agent left no commit' };
  if (remoteHead) {
    if (newHead === remoteHead) return { push: false, why: 'no new commits' };
    if (!isAncestor(remoteHead, newHead))
      return { push: false, refused: true, why: "the agent's head does not contain the branch's pushed head (no force-push)" };
    return { push: true, why: 'new commits on the branch' };
  }
  if (newHead === mainHead || isAncestor(newHead, mainHead)) return { push: false, why: 'no commits beyond main' };
  return { push: true, why: 'a new branch' };
}

/** The agent's PR text (`# title` on the first line, then the body) and its asks, checked; never printed. */
export function readAgentOutput({ prText, actionsText, journey }) {
  let title = `${journey}: factory builder`;
  let body = '';
  if (typeof prText === 'string' && prText.trim()) {
    const [first, ...rest] = prText.replace(/\r/g, '').split('\n');
    const t = first.replace(/^#\s*/, '').trim();
    if (t && t.length <= 200) title = t;
    body = rest.join('\n').trim();
  }
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n\n(cut at ${MAX_BODY} characters)`;
  let asks = { prove: false, arm: false };
  try {
    const a = JSON.parse(actionsText ?? '{}');
    asks = { prove: a?.prove === true, arm: a?.arm === true };
  } catch {}
  return { title, body, asks };
}

/** The builder's prompt: the run's facts, the CI status, the addendum, the brief (placeholders filled), the steps. */
export function buildPrompt({ brief, section, addendum, status, run }) {
  const filled = brief
    .replaceAll('{JOURNEY}', run.journey)
    .replaceAll('{AREA}', run.area)
    .replaceAll('{ACCOUNT}', 'the factory account whose token this job holds')
    .replaceAll('{LEAD THREAD}', 'not reachable from this job (see the Actions addendum)');
  const facts = [
    `Journey: ${run.journey}`,
    `Area: ${run.area}`,
    `Module (project-state folder of the step words): ${run.module}`,
    `Branch: ${run.branch} (${run.resume ? `resuming open PR #${run.pr}` : 'new, from origin/main'}), checked out at ${run.work}`,
    `Your output folder (PR text and asks): ${run.out}`,
    `Main's rules, as they stand on main: ${run.rules} (they win over the branch's AGENTS.md and CLAUDE.md)`,
    `This run: ${run.runUrl}`,
    `Start wrapping up (commit, write the PR text, end) at: ${run.soft}`,
    `Hard stop (the job ends you): ${run.hard}`,
  ];
  return [
    `You are a headless INTAFACED builder in GitHub Actions. Build ${run.journey} end to end, as the brief below says, adjusted by the Actions addendum, which wins where they differ.`,
    '',
    '# This run',
    ...facts.map((f) => `- ${f}`),
    '',
    '# CI on your branch when this run started',
    '',
    (status ?? '').trim() || 'No PR yet: this is the first run for this branch.',
    '',
    addendum.trim(),
    '',
    '# The builder brief (project-state BUILDER.md, private: never copy its text into intafaced)',
    '',
    filled.trim(),
    '',
    `# ${run.journey}: its step words (project-state operation-zero/modules/${run.module}/acceptance/journeys.md, private)`,
    '',
    section.trim(),
    '',
  ].join('\n');
}

/** The CI status the agent gets: the PR's head and each run on it, our own CI's names and states only. */
export function statusText({ pr, head, runs }) {
  const lines = [`PR #${pr}, head ${head}.`];
  const list = (runs ?? []).filter((r) => r && typeof r.name === 'string');
  if (!list.length) lines.push('No CI runs on this head yet.');
  for (const r of list)
    lines.push(`- ${r.name.slice(0, 80)}: ${r.status}${r.conclusion ? `, ${r.conclusion}` : ''} (run ${r.id}, ${r.html_url})`);
  return lines.join('\n');
}

/** What the watcher does now: keep going, or stop and why. */
export function nextAction({ now, hardAt, verdict, unreadable }) {
  if (now >= hardAt) return { stop: 'deadline' };
  if (verdict === 'pause') return { stop: 'paused' };
  if (verdict === 'unreadable' && unreadable >= UNREADABLE_LIMIT) return { stop: 'switch-unreadable' };
  return { stop: null };
}

/** The handover line for a PR body, or null when this run's line is already there. */
export function handoverLine({ body, runId, runUrl, endedAt, reason, head }) {
  if (String(body ?? '').includes(`Handover-run: ${runId} `)) return null;
  return `Handover-run: ${runId} ended ${endedAt} (${reason}); head ${head}; ${runUrl}`;
}

/** Usage numbers from the CLI's stream-json output: the last `result` event's numeric fields only, or null. */
export function usageStats(jsonl) {
  let result = null;
  for (const line of String(jsonl ?? '').split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type === 'result') result = e;
    } catch {}
  }
  if (!result) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const u = result.usage ?? {};
  return {
    turns: num(result.num_turns),
    duration_min: num(result.duration_ms) === null ? null : Math.round(result.duration_ms / 6000) / 10,
    cost_usd_equivalent: num(result.total_cost_usd),
    input_tokens: num(u.input_tokens),
    output_tokens: num(u.output_tokens),
    cache_read_tokens: num(u.cache_read_input_tokens),
    cache_creation_tokens: num(u.cache_creation_input_tokens),
    is_error: typeof result.is_error === 'boolean' ? result.is_error : null,
  };
}

/** The CLI's environment: the step's, minus the runner's files and tokens and every GitHub token. */
export function childEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => KEEP.has(k) || !NEVER_TO_AGENT.test(k)));
}

/**
 * How the CLI is started. As the agent user: through sudo, with only the filtered variables' names carried over (the
 * values travel in the environment, never in the command line), PATH set for it, its home its own.
 */
export function agentCommand({ user, bin, args, env, work }) {
  const own = childEnv(env);
  if (!user) return { cmd: bin, args, env: own, cwd: work };
  const names = Object.keys(own).filter((k) => !SUDO_OWN.has(k) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
  return {
    cmd: BIN.sudo,
    // `env -C`: the agent's home is closed to the runner, so the agent user itself enters the working tree.
    args: [
      '-n',
      '-u',
      user,
      '-H',
      `--preserve-env=${names.join(',')}`,
      '--',
      '/usr/bin/env',
      '-C',
      work,
      `PATH=${env.AGENT_PATH ?? env.PATH}`,
      bin,
      ...args,
    ],
    env: own,
    cwd: '/',
  };
}

// ---- Processes ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Whether any process is left in the group (EPERM: one is, run by another user). */
export function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function userAlive(user) {
  if (!user) return false;
  try {
    execFileSync(BIN.pgrep, ['-u', user], { stdio: 'ignore', env: { PATH: SAFE_PATH } });
    return true;
  } catch {
    return false;
  }
}

function signalAll(pgid, user, sig) {
  try {
    process.kill(-pgid, sig);
  } catch {}
  if (user)
    try {
      execFileSync(BIN.sudo, ['-n', BIN.pkill, `-${sig.replace('SIG', '')}`, '-u', user], { stdio: 'ignore', env: { PATH: SAFE_PATH } });
    } catch {}
}

/**
 * Ends every process the CLI started: SIGTERM to its process group (and, as the agent user, to all of that user's
 * processes, wherever they moved), the grace, then SIGKILL, and returns only once none is left (or throws).
 */
export async function stopAll({ pgid, user, graceMs = KILL_GRACE_MS, step = 100 }) {
  const alive = () => groupAlive(pgid) || userAlive(user);
  if (!alive()) return 'none left';
  signalAll(pgid, user, 'SIGTERM');
  for (let t = 0; t < graceMs && alive(); t += step) await sleep(step);
  if (!alive()) return 'ended on SIGTERM';
  signalAll(pgid, user, 'SIGKILL');
  for (let t = 0; t < 10_000 && alive(); t += step) await sleep(step);
  if (alive()) throw new Error('processes of the agent are still running after SIGKILL');
  return 'killed after the grace';
}

// ---- GitHub ----

/** GitHub's API root: GITHUB_API_URL, which every Actions job sets, else github.com's (the tests plant a local one). */
const apiRoot = () => process.env.GITHUB_API_URL || 'https://api.github.com';
const timed = (init) => ({ ...init, signal: AbortSignal.timeout(30_000) });

function api(token) {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  if (token) headers.authorization = `Bearer ${token}`;
  const call = (method, path, body, accept) =>
    fetch(
      `${apiRoot()}${path}`,
      timed({
        method,
        headers: { ...headers, ...(accept ? { accept } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  const ok = async (res, what) => {
    if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
    return res;
  };
  return {
    json: async (path) => (await ok(await call('GET', path), `GET ${path.split('?')[0]}`)).json(),
    status: async (path) => (await call('GET', path)).status,
    raw: async (repo, file) =>
      (
        await ok(await call('GET', `/repos/${repo}/contents/${file}?ref=main`, null, 'application/vnd.github.raw'), `GET ${repo} ${file}`)
      ).text(),
    send: async (method, path, body) => {
      const res = await ok(await call(method, path, body), `${method} ${path}`);
      return res.status === 204 ? null : res.json();
    },
  };
}

/** The switch without a token (the repository is public): the agent's step holds no GitHub token at all. */
async function switchVerdict(repo) {
  try {
    const res = await fetch(
      `${apiRoot()}/repos/${repo}/contents/${SWITCH_FILE}?ref=${SWITCH_BRANCH}`,
      timed({ headers: { accept: 'application/vnd.github.raw' } }),
    );
    if (!res.ok) return 'unreadable';
    return judgeSwitch(await res.text()).pass ? 'run' : 'pause';
  } catch {
    return 'unreadable';
  }
}

async function openPulls(gh, repo) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const p = await gh.json(`/repos/${repo}/pulls?state=open&base=main&per_page=100&page=${page}`);
    if (!Array.isArray(p)) throw new Error('the open pull requests: not a list');
    all.push(...p);
    if (p.length < 100) return all;
  }
  throw new Error('more than 1,000 open pull requests, not whole');
}

function need(env, ...names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) throw new Error(`factory-builder needs ${missing.join(', ')}`);
}

function output(pairs) {
  const file = process.env.GITHUB_OUTPUT;
  const text = Object.entries(pairs)
    .map(([k, v]) => `${k}=${v}\n`)
    .join('');
  if (file) appendFileSync(file, text);
  else process.stdout.write(text);
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const readIf = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null);

/** git in the fresh publish repository only (never the agent's): no hooks, no global or system config. */
function gitIn(dir, args, extraEnv = {}) {
  return execFileSync(BIN.git, ['-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: SAFE_PATH,
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      ...extraEnv,
    },
  }).trim();
}

async function main(cmd, args, env) {
  if (cmd === 'check') {
    const journeys = JSON.parse(readFileSync('docs/roadmap/journeys.json', 'utf8'));
    const r = checkInputs(env.JOURNEY, env.AREA, journeys);
    if (r.error) throw new Error(r.error);
    output({ module: r.module });
    console.log(`${r.journey}: module ${r.module}, area ${env.AREA}`);
    return 0;
  }
  if (cmd === 'switch') {
    need(env, 'REPO', 'GH_TOKEN');
    const fetchImpl = (url, init) => fetch(String(url).replace('https://api.github.com', apiRoot()), timed(init));
    const v = judgeSwitch(await readSwitch({ repo: env.REPO, token: env.GH_TOKEN, fetchImpl })); // throws: fails closed
    output({ run: v.pass ? 'true' : 'false' });
    console.log(v.pass ? 'FACTORY=run: the builder starts' : `::notice title=Factory paused::${v.why}, so no builder starts`);
    return 0;
  }
  if (cmd === 'branch') {
    need(env, 'REPO', 'GH_TOKEN', 'JOURNEY', 'RUN_NUMBER');
    if (!JOURNEY_RE.test(env.JOURNEY)) throw new Error('JOURNEY is not a journey id');
    const gh = api(env.GH_TOKEN);
    const pulls = await openPulls(gh, env.REPO);
    const plain = `${BRANCH_PREFIX}${env.JOURNEY}`;
    const st = await gh.status(`/repos/${env.REPO}/branches/${encodeURIComponent(plain)}`);
    if (st !== 200 && st !== 404) throw new Error(`GET branch ${plain}: HTTP ${st}`);
    const b = pickBranch({ journey: env.JOURNEY, runNumber: env.RUN_NUMBER, openPulls: pulls, repo: env.REPO, taken: st === 200 });
    pushRef(b.branch, env.JOURNEY);
    output({ branch: b.branch, resume: String(b.resume), pr: b.pr ?? '', head: b.head ?? '' });
    console.log(b.resume ? `resuming #${b.pr} on ${b.branch}` : `new branch ${b.branch} from origin/main`);
    return 0;
  }
  if (cmd === 'status') {
    need(env, 'BUILDER_DIR');
    let text = '';
    if (env.RESUME === 'true') {
      need(env, 'REPO', 'GH_TOKEN', 'PR', 'HEAD');
      const runs = await api(env.GH_TOKEN).json(`/repos/${env.REPO}/actions/runs?head_sha=${env.HEAD}&per_page=100`);
      text = statusText({ pr: env.PR, head: env.HEAD, runs: runs?.workflow_runs });
    }
    writeFileSync(join(env.BUILDER_DIR, 'status.md'), text);
    console.log(`status written: ${Buffer.byteLength(text)} bytes`);
    return 0;
  }
  if (cmd === 'prompt') {
    need(env, 'GH_TOKEN', 'JOURNEY', 'AREA', 'MODULE', 'BRANCH', 'RUN_URL', 'STARTED_AT', 'GITHUB_WORKSPACE', 'BUILDER_DIR', 'WORK', 'OUT');
    const gh = api(env.GH_TOKEN);
    const brief = await gh.raw(PROJECT_STATE, 'BUILDER.md');
    const file = `operation-zero/modules/${env.MODULE}/acceptance/journeys.md`;
    const section = journeySection(await gh.raw(PROJECT_STATE, file), env.JOURNEY);
    if (!section) throw new Error(`${env.JOURNEY} has no section in project-state ${file}`);
    const start = Number(env.STARTED_AT) * 1000;
    const prompt = buildPrompt({
      brief,
      section,
      addendum: readFileSync(join(env.GITHUB_WORKSPACE, ADDENDUM), 'utf8'),
      status: readIf(join(env.BUILDER_DIR, 'status.md')),
      run: {
        journey: env.JOURNEY,
        area: env.AREA,
        module: env.MODULE,
        branch: env.BRANCH,
        resume: env.RESUME === 'true',
        pr: env.PR,
        work: env.WORK,
        out: env.OUT,
        rules: '/opt/factory-cli/main-AGENTS.md',
        runUrl: env.RUN_URL,
        soft: iso(start + SOFT_MIN * 60_000),
        hard: iso(start + HARD_MIN * 60_000),
      },
    });
    writeFileSync(join(env.BUILDER_DIR, 'prompt.txt'), prompt);
    console.log(
      `prompt written: ${Buffer.byteLength(prompt)} bytes (brief ${Buffer.byteLength(brief)}, steps ${Buffer.byteLength(section)})`,
    );
    return 0;
  }
  if (cmd === 'run') {
    need(env, 'REPO', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_BIN', 'STARTED_AT', 'BUILDER_DIR', 'WORK');
    const dir = env.BUILDER_DIR;
    const hardAt = Number(env.STARTED_AT) * 1000 + HARD_MIN * 60_000;
    const pollMs = Number(env.POLL_MS ?? POLL_MS);
    const graceMs = Number(env.KILL_GRACE_MS ?? KILL_GRACE_MS);
    const user = env.AGENT_USER || null;
    const c = agentCommand({ user, bin: env.CLAUDE_BIN, args: JSON.parse(env.CLAUDE_ARGS ?? '[]'), env, work: env.WORK });
    const stdin = openSync(join(dir, 'prompt.txt'), 'r');
    const out = openSync(join(dir, 'out.jsonl'), 'a');
    const err = openSync(join(dir, 'err.log'), 'a');
    const startedAt = Date.now();
    // Its own process group (detached), so one signal reaches everything it starts that stays in the group.
    const child = spawn(c.cmd, c.args, { cwd: c.cwd, env: c.env, stdio: [stdin, out, err], detached: true });
    [stdin, out, err].forEach((fd) => closeSync(fd));
    let reason = null;
    let unreadable = 0;
    const stop = (why) => {
      if (reason) return;
      reason = why;
      console.log(`stopping the builder: ${why}`);
      signalAll(child.pid, user, 'SIGTERM');
    };
    const deadline = setTimeout(() => stop('deadline'), Math.max(0, hardAt - Date.now()));
    // A cancelled run (gh run cancel) signals this step: the CLI and everything it started go with it.
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => stop('cancelled'));
    let busy = false;
    const poll = setInterval(async () => {
      if (busy) return;
      busy = true;
      const verdict = await switchVerdict(env.REPO);
      busy = false;
      unreadable = verdict === 'unreadable' ? unreadable + 1 : 0;
      const a = nextAction({ now: Date.now(), hardAt, verdict, unreadable });
      if (a.stop) stop(a.stop);
    }, pollMs);
    const { code, signal } = await new Promise((resolve) => {
      child.on('error', () => resolve({ code: null, signal: null }));
      child.on('exit', (cd, s) => resolve({ code: cd, signal: s }));
    });
    clearTimeout(deadline);
    clearInterval(poll);
    // However the CLI ended, nothing it started outlives this step.
    const cleanup = await stopAll({ pgid: child.pid, user, graceMs });
    const ended = reason ?? (code === 0 ? 'done' : 'error');
    const minutes = Math.round((Date.now() - startedAt) / 6000) / 10;
    writeFileSync(join(dir, 'end.json'), JSON.stringify({ reason: ended, code, signal, minutes, endedAt: iso(Date.now()) }));
    console.log(
      `the builder ended: ${ended} after ${minutes} min (exit ${code ?? 'none'}${signal ? `, ${signal}` : ''}); its processes: ${cleanup}`,
    );
    if (ended === 'error') {
      console.log('::error title=Builder failed::the CLI exited non-zero; its output stays inside the job (public logs)');
      return 1;
    }
    return 0;
  }
  if (cmd === 'publish') {
    need(env, 'REPO', 'GH_TOKEN', 'JOURNEY', 'BRANCH', 'RUN_ID', 'RUN_URL', 'BUILDER_DIR');
    const dir = env.BUILDER_DIR;
    const ref = pushRef(env.BRANCH, env.JOURNEY);
    const gh = api(env.GH_TOKEN);
    const end = readIf(join(dir, 'end.json')) ? JSON.parse(readIf(join(dir, 'end.json'))) : null;
    let reason = end?.reason ?? 'ended before the builder ran';
    // A fresh repository, filled only from the agent's bundle (data, not a repository whose config or hooks could run)
    // and from GitHub. The token is in git's environment for the push alone, never in a command line.
    const repoDir = join(dir, 'publish');
    mkdirSync(repoDir, { recursive: true });
    gitIn(repoDir, ['init', '-q']);
    const url = `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.REPO}.git`;
    const bundle = join(dir, 'branch.bundle');
    let newHead = null;
    if (existsSync(bundle)) {
      gitIn(repoDir, ['fetch', '-q', '--no-tags', bundle, 'HEAD:refs/factory/new']);
      newHead = gitIn(repoDir, ['rev-parse', 'refs/factory/new']);
    }
    gitIn(repoDir, ['fetch', '-q', '--no-tags', url, 'refs/heads/main:refs/remotes/origin/main']);
    const mainHead = gitIn(repoDir, ['rev-parse', 'refs/remotes/origin/main']);
    const st = await gh.status(`/repos/${env.REPO}/branches/${encodeURIComponent(env.BRANCH)}`);
    if (st !== 200 && st !== 404) throw new Error(`GET branch: HTTP ${st}`);
    let remoteHead = null;
    if (st === 200) {
      gitIn(repoDir, ['fetch', '-q', '--no-tags', url, `${ref}:refs/remotes/origin/branch`]);
      remoteHead = gitIn(repoDir, ['rev-parse', 'refs/remotes/origin/branch']);
    }
    const isAncestor = (a, b) => {
      try {
        gitIn(repoDir, ['merge-base', '--is-ancestor', a, b]);
        return true;
      } catch {
        return false;
      }
    };
    const plan = publishPlan({ remoteHead, newHead, mainHead, isAncestor });
    let head = remoteHead;
    if (plan.push) {
      const auth = Buffer.from(`x-access-token:${env.GH_TOKEN}`).toString('base64');
      console.log(`::add-mask::${auth}`);
      try {
        gitIn(repoDir, ['push', '-q', '--no-verify', url, `refs/factory/new:${ref}`], {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `http.${env.GITHUB_SERVER_URL || 'https://github.com'}/.extraheader`,
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`,
        });
        head = newHead;
        console.log(`pushed ${newHead} to ${ref} (${plan.why})`);
      } catch (e) {
        reason = `${reason}; push refused`;
        console.log(
          `::warning title=Push refused::${ref}: ${
            String(e.stderr ?? e.message)
              .split('\n')
              .find((l) => /error|denied|refus|reject/i.test(l))
              ?.slice(0, 200) ?? 'git push failed'
          }`,
        );
      }
    } else {
      if (plan.refused) reason = `${reason}; not pushed: ${plan.why}`;
      console.log(`nothing pushed: ${plan.why}`);
    }
    if (!head) {
      console.log('no branch on GitHub, so no PR');
      return plan.refused ? 1 : 0;
    }
    const agent = readAgentOutput({
      prText: readIf(join(dir, 'pr.md')),
      actionsText: readIf(join(dir, 'actions.json')),
      journey: env.JOURNEY,
    });
    let pull = (await openPulls(gh, env.REPO)).find((p) => p?.head?.ref === env.BRANCH && p?.head?.repo?.full_name === env.REPO);
    const line = handoverLine({
      body: agent.body,
      runId: env.RUN_ID,
      runUrl: env.RUN_URL,
      endedAt: end?.endedAt ?? iso(Date.now()),
      reason,
      head,
    });
    const body = `${agent.body}${line ? `\n\n${line}` : ''}\n`;
    if (pull) {
      await gh.send('PATCH', `/repos/${env.REPO}/pulls/${pull.number}`, { title: agent.title, body });
      console.log(`#${pull.number}: updated, with the handover line (${reason})`);
    } else {
      pull = await gh.send('POST', `/repos/${env.REPO}/pulls`, { title: agent.title, head: env.BRANCH, base: 'main', body, draft: false });
      console.log(`#${pull.number}: opened`);
    }
    if (agent.asks.prove) {
      const test = `apps/customer/tests/real-app/${env.JOURNEY}.pw.mjs`;
      let has = true;
      try {
        gitIn(repoDir, ['cat-file', '-e', `${head}:${test}`]);
      } catch {
        has = false;
      }
      if (has) {
        await gh.send('POST', `/repos/${env.REPO}/actions/workflows/real-app-journeys.yml/dispatches`, {
          ref: env.BRANCH,
          inputs: { journeys: `${env.JOURNEY}.pw.mjs` },
        });
        console.log(`started the Real-app journeys run of ${env.JOURNEY}.pw.mjs on ${env.BRANCH}`);
      } else console.log(`no ${test} on the head, so no journeys run`);
    }
    if (agent.asks.arm) {
      execFileSync(BIN.gh, ['pr', 'merge', String(pull.number), '-R', env.REPO, '--auto', '--squash'], {
        stdio: 'ignore',
        env: { PATH: SAFE_PATH, GH_TOKEN: env.GH_TOKEN, HOME: dir },
      });
      console.log(`#${pull.number}: squash auto-merge armed`);
    }
    return plan.refused ? 1 : 0;
  }
  if (cmd === 'stats') {
    need(env, 'BUILDER_DIR');
    const s = usageStats(readIf(join(env.BUILDER_DIR, 'out.jsonl')) ?? '');
    if (!s) {
      console.log('no usage: the CLI wrote no final result (it was stopped, or never started)');
      return 0;
    }
    console.log(
      Object.entries(s)
        .map(([k, v]) => `${k}=${v ?? 'missing'}`)
        .join(' '),
    );
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `### Builder usage\n\n| | |\n|-|-|\n${Object.entries(s)
          .map(([k, v]) => `| ${k} | ${v ?? 'missing'} |`)
          .join('\n')}\n`,
      );
    return 0;
  }
  throw new Error(`unknown subcommand ${quote(cmd)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main(process.argv[2], process.argv.slice(3), process.env).then(
    (code) => process.exit(code),
    (e) => {
      console.error(
        `::error title=Builder step failed::${String(e.message)
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 300)}`,
      );
      process.exit(1);
    },
  );
