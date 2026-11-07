#!/usr/bin/env node
/**
 * The headless builder's steps (.github/workflows/builder.yml): one journey per run, the pinned CLI headless on a fresh
 * runner, its pushes made with the factory token so CI runs on them. Each subcommand is one step of the workflow:
 *
 *   check     the dispatched journey and area are well formed, the journey is in docs/roadmap/journeys.json and isn't
 *             parked; writes its module (the project-state folder of its step words) to GITHUB_OUTPUT.
 *   switch    reads the factory switch (factory-switch.mjs); `run=true` only when FACTORY on branch factory-switch says
 *             `run`. A pause ends the run cleanly; an unreadable switch fails it (closed).
 *   branch    the branch this run builds on: the journey's open PR's branch when there is one (a successor resumes it),
 *             else factory/<journey>, or factory/<journey>-r<run number> when that name is already taken.
 *   prompt    fetches project-state BUILDER.md and the journey's section of its module's journeys.md with the factory
 *             token, and writes the builder's prompt to a file. Nothing from project-state is ever printed.
 *   run       runs the pinned CLI headless with the prompt; everything it prints goes to files in the job, never the log.
 *             Every POLL_MS it reads the switch; a pause, three unreadable reads in a row or the hard deadline stops it.
 *   handover  appends one line to the branch's open PR's body (run, end time, why it ended, head), so a run that was
 *             stopped before it wrote its own handover lines still leaves the successor a trace.
 *   stats     the run's usage, numbers only, from the CLI's final result event (the trial measures usage per hour).
 *
 * Public-repo hygiene: intafaced is public and anyone can read its logs. Nothing here prints text it fetched from
 * project-state or the CLI's output; messages carry only our own words, numbers, ids that passed a strict pattern, and
 * quoted, shortened input (so input can't add lines or workflow commands to the log).
 */
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { judgeSwitch, readSwitch } from './factory-switch.mjs';

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
const ADDENDUM = '.github/workflows/builder/ACTIONS.md';
/** Variables the CLI's process never gets: the runner's command files (so it can't write to the public summary or
 *  to later steps' environment) and the runner's own tokens. */
const RUNNER_ONLY = /^(GITHUB_(STEP_SUMMARY|OUTPUT|ENV|PATH|STATE)|ACTIONS_.*)$/;

const quote = (s) => JSON.stringify(String(s ?? '').slice(0, 60));

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

/**
 * The branch to build on. A successor resumes the journey's open PR (the oldest, if somehow there are two); otherwise
 * a fresh branch from main, never one that already exists (a merged or closed journey PR's branch is history).
 */
export function pickBranch({ journey, runNumber, openPulls, repo, taken }) {
  const own = new RegExp(`^${BRANCH_PREFIX}${journey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-r\\d+)?$`);
  const mine = (openPulls ?? [])
    .filter((p) => p?.head?.repo?.full_name === repo && p?.base?.ref === 'main' && own.test(p?.head?.ref ?? ''))
    .sort((a, b) => a.number - b.number);
  if (mine.length) return { branch: mine[0].head.ref, resume: true, pr: mine[0].number };
  const plain = `${BRANCH_PREFIX}${journey}`;
  return { branch: taken ? `${plain}-r${runNumber}` : plain, resume: false, pr: null };
}

/** The builder's prompt: the run's facts, the Actions addendum, the brief (placeholders filled), the step words. */
export function buildPrompt({ brief, section, addendum, run }) {
  const filled = brief
    .replaceAll('{JOURNEY}', run.journey)
    .replaceAll('{AREA}', run.area)
    .replaceAll('{ACCOUNT}', 'the factory account whose token this job holds')
    .replaceAll('{LEAD THREAD}', 'not reachable from this job (see the Actions addendum)');
  const facts = [
    `Journey: ${run.journey}`,
    `Area: ${run.area}`,
    `Module (project-state folder of the step words): ${run.module}`,
    `Branch: ${run.branch} (${run.resume ? `resuming open PR #${run.pr}` : 'new, from origin/main'}), checked out at ${run.workspace}`,
    `This run: ${run.runUrl}`,
    `Start wrapping up (push, handover lines, exit) at: ${run.soft}`,
    `Hard stop (the job ends you): ${run.hard}`,
  ];
  return [
    `You are a headless INTAFACED builder in GitHub Actions. Build ${run.journey} end to end, as the brief below says, adjusted by the Actions addendum, which wins where they differ.`,
    '',
    '# This run',
    ...facts.map((f) => `- ${f}`),
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

/** The CLI's environment: the step's, minus the runner's command files and tokens. */
export function childEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !RUNNER_ONLY.test(k)));
}

// ---- GitHub, through the factory token ----

/** GitHub's API root: GITHUB_API_URL, which every Actions job sets, else github.com's (the tests plant a local one). */
const apiRoot = () => process.env.GITHUB_API_URL || 'https://api.github.com';

function api(token) {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  const call = async (method, path, body) => {
    const res = await fetch(`${apiRoot()}${path}`, {
      method,
      headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  };
  return {
    async json(path) {
      const res = await call('GET', path);
      if (!res.ok) throw new Error(`GET ${path.split('?')[0]}: HTTP ${res.status}`);
      return res.json();
    },
    async status(path) {
      return (await call('GET', path)).status;
    },
    async raw(repo, file) {
      const path = `/repos/${repo}/contents/${file}?ref=main`;
      const res = await fetch(`${apiRoot()}${path}`, { headers: { ...headers, accept: 'application/vnd.github.raw' } });
      if (!res.ok) throw new Error(`GET ${repo} ${file}: HTTP ${res.status}`);
      return res.text();
    },
    async patch(path, body) {
      const res = await call('PATCH', path, body);
      if (!res.ok) throw new Error(`PATCH ${path}: HTTP ${res.status}`);
    },
  };
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

/** A read that hangs counts as unreadable, so the watcher never stalls on GitHub. */
const timedFetch = (url, init) =>
  fetch(String(url).replace('https://api.github.com', apiRoot()), { ...init, signal: AbortSignal.timeout(30_000) });

async function switchVerdict(env) {
  try {
    return judgeSwitch(await readSwitch({ repo: env.REPO, token: env.GH_TOKEN, fetchImpl: timedFetch })).pass ? 'run' : 'pause';
  } catch {
    return 'unreadable';
  }
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

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
    const text = await readSwitch({ repo: env.REPO, token: env.GH_TOKEN, fetchImpl: timedFetch }); // throws: unreadable fails the run closed
    const v = judgeSwitch(text);
    output({ run: v.pass ? 'true' : 'false' });
    if (v.pass) console.log('FACTORY=run: the builder starts');
    else console.log(`::notice title=Factory paused::${v.why}, so no builder starts`);
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
    output({ branch: b.branch, resume: String(b.resume), pr: b.pr ?? '' });
    console.log(b.resume ? `resuming #${b.pr} on ${b.branch}` : `new branch ${b.branch} from origin/main`);
    return 0;
  }
  if (cmd === 'prompt') {
    need(env, 'GH_TOKEN', 'JOURNEY', 'AREA', 'MODULE', 'BRANCH', 'RUN_URL', 'STARTED_AT', 'GITHUB_WORKSPACE');
    const dir = args[0];
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
      run: {
        journey: env.JOURNEY,
        area: env.AREA,
        module: env.MODULE,
        branch: env.BRANCH,
        resume: env.RESUME === 'true',
        pr: env.PR,
        workspace: env.GITHUB_WORKSPACE,
        runUrl: env.RUN_URL,
        soft: iso(start + SOFT_MIN * 60_000),
        hard: iso(start + HARD_MIN * 60_000),
      },
    });
    writeFileSync(join(dir, 'prompt.txt'), prompt);
    console.log(
      `prompt written: ${Buffer.byteLength(prompt)} bytes (brief ${Buffer.byteLength(brief)}, steps ${Buffer.byteLength(section)})`,
    );
    return 0;
  }
  if (cmd === 'run') {
    need(env, 'REPO', 'GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_BIN', 'STARTED_AT');
    const dir = args[0];
    const hardAt = Number(env.STARTED_AT) * 1000 + HARD_MIN * 60_000;
    const pollMs = Number(env.POLL_MS ?? POLL_MS);
    const cliArgs = JSON.parse(env.CLAUDE_ARGS ?? '[]');
    const stdin = openSync(join(dir, 'prompt.txt'), 'r');
    const out = openSync(join(dir, 'out.jsonl'), 'a');
    const err = openSync(join(dir, 'err.log'), 'a');
    const startedAt = Date.now();
    const child = spawn(env.CLAUDE_BIN, cliArgs, {
      cwd: env.GITHUB_WORKSPACE,
      env: childEnv(env),
      stdio: [stdin, out, err],
      detached: true,
    });
    [stdin, out, err].forEach((fd) => closeSync(fd));
    let reason = null;
    let unreadable = 0;
    const stopGroup = (why) => {
      if (reason) return;
      reason = why;
      console.log(`stopping the builder: ${why}`);
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, KILL_GRACE_MS).unref();
    };
    const deadline = setTimeout(() => stopGroup('deadline'), Math.max(0, hardAt - Date.now()));
    // A cancelled run (gh run cancel) signals this step: the CLI's whole process group goes with it.
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => stopGroup('cancelled'));
    let busy = false;
    const poll = setInterval(async () => {
      if (busy) return;
      busy = true;
      const verdict = await switchVerdict(env);
      busy = false;
      unreadable = verdict === 'unreadable' ? unreadable + 1 : 0;
      const a = nextAction({ now: Date.now(), hardAt, verdict, unreadable });
      if (a.stop) stopGroup(a.stop);
    }, pollMs);
    const { code, signal } = await new Promise((resolve) => {
      child.on('error', (e) => resolve({ code: null, signal: null, spawnError: e.code ?? 'spawn failed' }));
      child.on('exit', (c, s) => resolve({ code: c, signal: s }));
    });
    clearTimeout(deadline);
    clearInterval(poll);
    const ended = reason ?? (code === 0 ? 'done' : 'error');
    const minutes = Math.round((Date.now() - startedAt) / 6000) / 10;
    writeFileSync(join(dir, 'end.json'), JSON.stringify({ reason: ended, code, signal, minutes, endedAt: iso(Date.now()) }));
    console.log(`the builder ended: ${ended} after ${minutes} min (exit ${code ?? 'none'}${signal ? `, ${signal}` : ''})`);
    if (ended === 'error') {
      console.log('::error title=Builder failed::the CLI exited non-zero; its output stays inside the job (public logs)');
      return 1;
    }
    return 0;
  }
  if (cmd === 'handover') {
    need(env, 'REPO', 'GH_TOKEN', 'BRANCH', 'RUN_ID', 'RUN_URL');
    const dir = args[0];
    const end = existsSync(join(dir, 'end.json')) ? JSON.parse(readFileSync(join(dir, 'end.json'), 'utf8')) : null;
    const reason = end?.reason ?? 'ended before the builder ran';
    const gh = api(env.GH_TOKEN);
    const pull = (await openPulls(gh, env.REPO)).find((p) => p?.head?.ref === env.BRANCH && p?.head?.repo?.full_name === env.REPO);
    if (!pull) {
      console.log(`no open PR for ${env.BRANCH} (${reason}): nothing to hand over on a PR`);
      return 0;
    }
    const line = handoverLine({
      body: pull.body,
      runId: env.RUN_ID,
      runUrl: env.RUN_URL,
      endedAt: end?.endedAt ?? iso(Date.now()),
      reason,
      head: pull.head.sha,
    });
    if (!line) {
      console.log(`#${pull.number}: this run's handover line is already there`);
      return 0;
    }
    const body = `${(pull.body ?? '').trimEnd()}\n\n${line}\n`;
    if (body.length > 65_000) {
      console.log(`::warning title=Handover not written::#${pull.number}'s body is near GitHub's limit`);
      return 0;
    }
    await gh.patch(`/repos/${env.REPO}/pulls/${pull.number}`, { body });
    console.log(`#${pull.number}: handover line added (${reason}, head ${pull.head.sha})`);
    return 0;
  }
  if (cmd === 'stats') {
    const dir = args[0];
    const file = join(dir, 'out.jsonl');
    const s = existsSync(file) ? usageStats(readFileSync(file, 'utf8')) : null;
    if (!s) {
      console.log('no usage: the CLI wrote no final result (it was stopped, or never started)');
      return 0;
    }
    const rows = Object.entries(s).map(([k, v]) => `${k}=${v ?? 'missing'}`);
    console.log(rows.join(' '));
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
