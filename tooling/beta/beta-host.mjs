#!/usr/bin/env node
/**
 * THE BETA LINK — the Customer app on main, always on, on TEST funds only (#9346).
 *
 * One long-lived copy of the local test stack (tooling/scripts/local-test-stack.mjs) on the machine that runs it, in
 * its own checkout of origin/main, its own state folder and its own fixed slot, so the link never moves. A person
 * reaches it from their phone through T3 Connect's preview tunnel: the box's `localhost` pages open on a signed-in,
 * approved T3 device and nowhere else (docs/runbooks/beta-link.md says how, step by step).
 *
 *   node tooling/beta/beta-host.mjs serve     the supervisor: a round now and every BETA_EVERY_MIN minutes (30), and the
 *                                             TEST mailbox page; it exits after a round that changed this file, so
 *                                             systemd starts the new copy
 *   node tooling/beta/beta-host.mjs round     one round: fetch main, move the checkout to it (at most every 2 hours), launch
 *                                             or update the stack,
 *                                             run the TEST funds check, write status.json
 *   node tooling/beta/beta-host.mjs check [--state <dir>]   the TEST funds check alone, on the beta stack (or another
 *                                             stack's state folder); exit 1 on any finding
 *   node tooling/beta/beta-host.mjs status    what the last round found
 *   node tooling/beta/beta-host.mjs stop      stop the beta stack (the supervisor's next round starts it again)
 *   node tooling/beta/beta-host.mjs install   write and start the systemd user service that runs `serve`
 *
 * What it keeps (AGENTS.md floor 1, 7 and 8):
 *   - It moves no money and posts nothing: the stack's own start readies it (TEST gates, TEST market maker, TEST
 *     content), exactly as `verify launch` readies a journeys shard.
 *   - TEST funds only, shown by a check, not by a name: every process the stack started is read for every address in
 *     its environment, and one that names anything but this machine (127.0.0.1, localhost, ::1) is a finding. With
 *     no route off the machine, no service can reach a real chain, venue, bank or card rail. The page must carry the
 *     stack's TEST banner. A failed check stops the stack: it fails closed, never open.
 *   - It never sets or invents a sanctions screening list. Without the owner's TEST screening file in the beta state
 *     folder (screening.local.json, the file local-test-stack.mjs reads), Edge refuses every call; the round then
 *     builds nothing and says so in status.json.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/** The beta's fixed slot. Slot n adds 1000 × n to every stack port (local-test-facts.mjs), so the link is stable. */
export const BETA_SLOT = 3;
/** The Customer app on the beta slot. `localhost`, not 127.0.0.1: passkeys and T3's "Open on this device" need a name. */
export const BETA_LINK = `http://localhost:${3210 + 1000 * BETA_SLOT}/`;
/** The TEST mailbox page: the codes and links the beta stack "mails" into its LOCAL-TEST outbox file. */
export const MAILBOX_PORT = 6290;
const MAILBOX_LINK = `http://localhost:${MAILBOX_PORT}/`;
/** The stack's own banner text (local-test-stack.mjs BANNER_TEXT); the page must carry it. */
const BANNER_MARK = 'TEST FUNDS';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
/**
 * Names reserved so that they never reach a real service: the documentation networks (RFC 5737: 192.0.2.0/24,
 * 198.51.100.0/24, 203.0.113.0/24), the reserved top-level names (RFC 2606, RFC 6761: .example, .invalid, .test,
 * .localhost) and example.com, .net and .org. The stack uses them for settings a test must fill but nothing may reach
 * (svc-pay's terms page, svc-mining-pool's TLS door, svc-ops's restore archive). A real chain, venue or bank is none.
 */
export function reservedHost(host) {
  if (/^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/.test(host)) return true;
  if (/(^|\.)(example|invalid|test|localhost)$/.test(host)) return true;
  return /(^|\.)example\.(com|net|org)$/.test(host);
}

export function betaPaths(home = os.homedir()) {
  const root = path.join(home, '.intafaced', 'beta');
  return {
    root,
    checkout: path.join(root, 'checkout'),
    state: path.join(root, 'state'),
    status: path.join(root, 'status.json'),
    log: path.join(root, 'round.log'),
    screening: path.join(root, 'state', 'screening.local.json'),
    unit: path.join(home, '.config', 'systemd', 'user', 'intafaced-beta.service'),
  };
}

/**
 * Seconds between the beta's TEST market cycles, and between its lake captures: its book stays quoted and its price
 * moves, without the journeys' 8 s and 2 s churn.
 */
const BETA_CADENCE_SECONDS = 300;

/**
 * The environment every stack command of the beta runs with: its slot and its state folder, and the settings of a
 * stack no journey runs on (project-state #3857: idle, the beta used about 1.6 cores): its services record no code
 * reach, and its TEST market re-quotes and its lake captures every BETA_CADENCE_SECONDS.
 */
export const stackEnv = (paths, env = process.env) => ({
  ...env,
  LOCAL_STACK_SLOT: String(BETA_SLOT),
  LOCAL_STACK_STATE: paths.state,
  LOCAL_STACK_CODE_REACH: 'off',
  LOCAL_STACK_MARKET_INTERVAL: String(BETA_CADENCE_SECONDS),
  LOCAL_STACK_QUANT_LAKE_CAPTURE_SECONDS: String(BETA_CADENCE_SECONDS),
});

// ── The TEST funds check ────────────────────────────────────────────────────

/**
 * Every address in one process environment that names a host other than this machine, as `{ key, scheme, host }`. A
 * value is read for every `scheme://[user@]host` in it (a list of URLs counts each one). The value itself is never
 * returned: environments hold the stack's secrets.
 */
export function outsideAddresses(entries) {
  const out = [];
  for (const [key, value] of entries) {
    for (const m of String(value).matchAll(/\b([a-z][a-z0-9+.-]*):\/\/(?:[^/\s@"',;]*@)?(\[[^\]]+\]|[^/\s:,;"'?#]+)/gi)) {
      const host = m[2].toLowerCase();
      if (!LOOPBACK.has(host) && !reservedHost(host)) out.push({ key, scheme: m[1].toLowerCase(), host });
    }
  }
  return out;
}

/** A /proc environ file's NUL-separated `KEY=value` list as entries. */
export const environEntries = (text) =>
  text
    .split('\0')
    .filter(Boolean)
    .map((kv) => {
      const i = kv.indexOf('=');
      return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)];
    });

/**
 * The TEST funds check on one stack. `records` are the stack's processes ({ name: { pid } }, run/processes.json);
 * `readEnviron(pid)` gives a process's environ text or null; `page` is the Customer page's HTML or null. Returns
 * `{ ok, lines }`, one line per finding or pass, naming keys and hosts, never a value.
 */
export function fundsCheck({ records, readEnviron, page }) {
  const findings = [];
  const passes = [];
  const named = Object.entries(records ?? {}).filter(([, r]) => Number.isInteger(r?.pid));
  if (named.length === 0) findings.push('no process: the stack is not running, so nothing could be read');
  let read = 0;
  let clean = 0;
  for (const [name, r] of named) {
    const text = readEnviron(r.pid);
    if (text == null) continue; // a process that has ended holds no route
    read++;
    const outside = outsideAddresses(environEntries(text));
    if (outside.length === 0) clean++;
    for (const a of outside) findings.push(`${name} (pid ${r.pid}): ${a.key} names ${a.scheme}://${a.host}, off this machine`);
  }
  if (named.length && read === 0) findings.push('no running process could be read');
  if (clean) passes.push(`${clean} of ${read} running processes: every address in their environments is this machine or a reserved name`);
  if (page == null) findings.push('the Customer page did not answer');
  else if (!page.includes(BANNER_MARK)) findings.push(`the Customer page lacks the TEST banner ("${BANNER_MARK}")`);
  else passes.push(`the Customer page carries the TEST banner ("${BANNER_MARK}")`);
  return { ok: findings.length === 0, lines: [...findings.map((f) => `FAIL ${f}`), ...passes.map((p) => `ok   ${p}`)] };
}

const readJson = (file, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const readEnviron = (pid) => {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
  } catch {
    return null;
  }
};
function getText(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 10_000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(res.statusCode === 200 ? body : null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
  });
}

async function checkStack(state, link) {
  const records = readJson(path.join(state, 'run', 'processes.json'), {});
  return fundsCheck({ records, readEnviron, page: await getText(link) });
}

// ── The TEST mailbox page ───────────────────────────────────────────────────

/** The outbox file's rows of the last `hours`, newest first, at most `max`: `{ purpose, email, expires, code, link }`. */
export function mailboxRows(text, { now = Date.now(), hours = 24, max = 60 } = {}) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('LOCAL-TEST ')) continue;
    const field = (k) => new RegExp(`\\b${k}=(\\S+)`).exec(line)?.[1] ?? null;
    const expires = field('expires');
    const at = expires ? Date.parse(expires) : NaN;
    if (Number.isFinite(at) && at < now - hours * 3600_000) continue;
    rows.push({ purpose: field('purpose'), email: field('email'), expires, code: field('code'), link: field('link') ?? field('freeze') });
  }
  return rows.reverse().slice(0, max);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function mailboxPage(rows, { link = BETA_LINK, status = null } = {}) {
  const body = rows.length
    ? rows
        .map(
          (r) =>
            `<tr><td>${esc(r.purpose)}</td><td>${esc(r.email)}</td><td class="code">${r.code ? esc(r.code) : r.link ? `<a href="${esc(new URL(r.link.replace(/^\//, ''), link))}">open the link</a>` : ''}</td><td>${esc(r.expires)}</td></tr>`,
        )
        .join('\n')
    : '<tr><td colspan="4">No mail yet. Sign up in the app, then reload this page.</td></tr>';
  const state = status
    ? `<p>Beta: ${esc(status.state)}${status.sha ? ` on main ${esc(status.sha.slice(0, 9))}` : ''}${status.mainAt && status.sha && status.mainAt !== status.sha ? ` (main is at ${esc(status.mainAt.slice(0, 9))}; the beta updates at most every 2 hours)` : ''}${status.reason ? `: ${esc(status.reason)}` : ''}</p>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10"><title>TEST mailbox</title>
<style>body{background:#0b0b0b;color:#eee;font:16px/1.4 system-ui,sans-serif;margin:0;padding:1rem}h1{font-size:1.2rem}
.test{background:#F5A915;color:#0b0b0b;font-weight:600;padding:.3rem .6rem;display:inline-block}table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #333;padding:.4rem;text-align:start;word-break:break-all}.code{font:600 1.3rem ui-monospace,monospace}a{color:#9cf}</style></head>
<body><p class="test">TEST MAILBOX: test accounts only, not real mail</p><h1>Codes and links the beta app sent</h1>${state}
<p><a href="${esc(link)}">Open the beta app</a>. This page reloads every 10 seconds.</p>
<table><thead><tr><th>What</th><th>To</th><th>Code</th><th>Expires</th></tr></thead><tbody>
${body}
</tbody></table></body></html>`;
}

function serveMailbox(paths) {
  const server = http.createServer((req, res) => {
    let text = '';
    try {
      text = fs.readFileSync(path.join(paths.state, 'email-outbox.log'), 'utf8');
    } catch {}
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
    res.end(mailboxPage(mailboxRows(text), { status: readJson(paths.status) }));
  });
  server.on('error', (err) => log(paths, `mailbox: ${err.message}`));
  server.listen(MAILBOX_PORT, '127.0.0.1');
  return server;
}

// ── One round ───────────────────────────────────────────────────────────────

function log(paths, line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  try {
    fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    fs.appendFileSync(paths.log, `${stamped}\n`);
  } catch {}
}

function writeStatus(paths, status) {
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const tmp = `${paths.status}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    `${JSON.stringify({ link: BETA_LINK, mailbox: MAILBOX_LINK, at: new Date().toISOString(), ...status }, null, 2)}\n`,
  );
  fs.renameSync(tmp, paths.status);
}

const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

/** Run a command to its end, its output appended to the round log; resolves to its exit code. */
function run(paths, cmd, args, { cwd, env }) {
  return new Promise((resolve) => {
    const out = fs.openSync(paths.log, 'a');
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', out, out] });
    child.on('close', (code) => {
      fs.closeSync(out);
      resolve(code ?? 1);
    });
    child.on('error', () => resolve(127));
  });
}

/**
 * What a round does, decided from what it found: 'blocked' (no screening file: build nothing), 'update' (main moved:
 * check out, install, launch) or 'launch' (same commit: launch, which restarts only what is down).
 */
export function decide({ screening, head, target, updatedAt = null, now = Date.now() }) {
  if (!screening) return 'blocked';
  if (head === target) return 'launch';
  return nextUpdateAt(updatedAt) <= now ? 'update' : 'launch';
}

/**
 * The beta moves to main at most once every UPDATE_EVERY_MS. An update (checkout, install, rebuild) cost 10 CPU-minutes in
 * one measured round, and main moves nearly every half hour; between updates a round only launches what is down.
 */
export const UPDATE_EVERY_MS = 2 * 3600_000;
/** When the next update may run: UPDATE_EVERY_MS after the last one, or now when none is recorded. */
export const nextUpdateAt = (updatedAt) => {
  const at = Date.parse(updatedAt ?? '');
  return Number.isFinite(at) ? at + UPDATE_EVERY_MS : 0;
};

/**
 * The beta's stop: the TEST market maker's own stop, then the stack's, as `verify stop` runs them, without its gate.
 * `verify stop` stops only a stack that the latest `verify launch` started, and every round's launch after the first
 * finds the stack running, so it left every process up, team-tls included. The beta owns its whole stack.
 */
export function stopCommands(paths) {
  const scripts = path.join(paths.checkout, 'tooling', 'scripts');
  return [
    [path.join(scripts, 'local-test-market.mjs'), 'stop'],
    [path.join(scripts, 'local-test-stack.mjs'), 'stop'],
  ];
}

/** Run stopCommands in the beta checkout on its slot; resolves to the first failing exit code, else 0. */
async function stopStack(paths) {
  let code = 0;
  for (const args of stopCommands(paths)) {
    const c = await run(paths, 'node', args, { cwd: paths.checkout, env: stackEnv(paths) });
    if (c !== 0 && code === 0) code = c;
  }
  return code;
}

/** The repository the beta checkout is a worktree of: the one holding this script's own checkout. */
function mainRepo() {
  const r = spawnSync('git', ['-C', HERE, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('beta: this script is not inside a git checkout');
  return path.dirname(r.stdout.trim());
}

/** The beta's own checkout, a detached worktree of origin/main, made when missing; null when it is there, else why not. */
function ensureCheckout(paths) {
  if (fs.existsSync(path.join(paths.checkout, '.git'))) return null;
  const repo = mainRepo();
  git(repo, 'fetch', '--quiet', 'origin', 'main');
  const add = git(repo, 'worktree', 'add', '--detach', paths.checkout, 'origin/main');
  return add.status === 0 ? null : `could not make the checkout: ${add.stderr.trim()}`;
}

async function round(paths = betaPaths()) {
  fs.mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  const noCheckout = ensureCheckout(paths);
  if (noCheckout) return finish(paths, { state: 'down', reason: noCheckout });
  const fetched = git(paths.checkout, 'fetch', '--quiet', 'origin', 'main');
  if (fetched.status !== 0) log(paths, `fetch failed (${fetched.stderr.trim()}); the round goes on with the last main it has`);
  const target = git(paths.checkout, 'rev-parse', 'origin/main').stdout.trim();
  const head = git(paths.checkout, 'rev-parse', 'HEAD').stdout.trim();
  const prev = readJson(paths.status, {});
  const step = decide({ screening: fs.existsSync(paths.screening), head, target, updatedAt: prev.updatedAt });
  const held = step === 'launch' && head !== target;
  log(
    paths,
    `round: ${step} (checkout ${head.slice(0, 9)}, main ${target.slice(0, 9)}${held ? `; the next update is after ${new Date(nextUpdateAt(prev.updatedAt)).toISOString()}` : ''})`,
  );
  if (step === 'blocked')
    return finish(paths, {
      state: 'blocked',
      reason: `no TEST screening file at ${paths.screening}: Edge would refuse every call, so nothing is built (docs/runbooks/beta-link.md)`,
      sha: head,
    });
  const env = stackEnv(paths);
  // The commit the stack serves after this round, and when the checkout last moved: the next update waits on it.
  const sha = step === 'update' ? target : head;
  const updatedAt = step === 'update' ? new Date().toISOString() : prev.updatedAt;
  const mainAt = target;
  if (step === 'update') {
    const co = git(paths.checkout, 'checkout', '--quiet', '--detach', target);
    if (co.status !== 0) return finish(paths, { state: 'down', reason: `checkout of ${target} failed: ${co.stderr.trim()}`, sha: head });
    if ((await run(paths, 'pnpm', ['install', '--frozen-lockfile'], { cwd: paths.checkout, env })) !== 0)
      return finish(paths, { state: 'down', reason: 'pnpm install failed (round.log)', sha, updatedAt, mainAt });
  }
  const stackCli = path.join(paths.checkout, 'tooling', 'scripts', 'local-test-stack.mjs');
  const launched = await run(paths, 'node', [stackCli, 'start', 'verify', 'launch'], { cwd: paths.checkout, env });
  const check = await checkStack(paths.state, BETA_LINK);
  for (const l of check.lines) log(paths, `check: ${l}`);
  if (!check.ok) {
    await stopStack(paths);
    return finish(paths, {
      state: 'refused',
      reason: 'the TEST funds check failed, so the stack was stopped',
      check: check.lines,
      sha,
      updatedAt,
      mainAt,
    });
  }
  if (launched !== 0)
    return finish(paths, {
      state: 'down',
      reason: `verify launch exited ${launched} (round.log)`,
      check: check.lines,
      sha,
      updatedAt,
      mainAt,
    });
  return finish(paths, {
    state: 'up',
    sha,
    updatedAt,
    mainAt,
    upSince: prev.state === 'up' && prev.upSince ? prev.upSince : new Date().toISOString(),
    check: check.lines,
  });
}

function finish(paths, status) {
  writeStatus(paths, status);
  log(paths, `round: ${status.state}${status.reason ? `: ${status.reason}` : ''}`);
  return status;
}

const fileHash = (file) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
};

async function serve(paths) {
  const everyMin = Number(process.env.BETA_EVERY_MIN ?? 30);
  if (!Number.isFinite(everyMin) || everyMin < 5 || everyMin > 55) throw new Error('BETA_EVERY_MIN must be 5 to 55');
  const mine = fileHash(SELF);
  serveMailbox(paths);
  for (;;) {
    try {
      await round(paths);
    } catch (err) {
      finish(paths, { state: 'down', reason: `round threw: ${err.message}` });
    }
    // The checkout's copy of this file moved with main: exit, and systemd (Restart=always) starts the new one.
    if (SELF.startsWith(paths.checkout + path.sep) && fileHash(SELF) !== mine) {
      log(paths, 'serve: beta-host.mjs changed on main; exiting so the new copy starts');
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, everyMin * 60_000));
  }
}

/** The systemd user service that keeps `serve` running. KillMode=process: a restart of the supervisor leaves the stack up. */
export function unitText(paths) {
  return `[Unit]
Description=INTAFACED beta link: the Customer app on main, TEST funds only (intafaced tooling/beta/beta-host.mjs, #9346)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${paths.checkout}
ExecStart=/bin/bash -lc 'exec node tooling/beta/beta-host.mjs serve'
Restart=always
RestartSec=60
KillMode=process

[Install]
WantedBy=default.target
`;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const paths = betaPaths();
  if (cmd === 'serve') return serve(paths);
  if (cmd === 'round') {
    const s = await round(paths);
    process.exit(s.state === 'up' || s.state === 'blocked' ? 0 : 1);
  }
  if (cmd === 'check') {
    const i = rest.indexOf('--state');
    const state = i >= 0 ? path.resolve(rest[i + 1]) : paths.state;
    const marker = readJson(path.join(state, 'LOCAL-TEST-STACK.json'), {});
    const link = state === paths.state || !marker.ports?.customer ? BETA_LINK : `http://127.0.0.1:${marker.ports.customer}/`;
    const c = await checkStack(state, link);
    for (const l of c.lines) console.log(l);
    process.exit(c.ok ? 0 : 1);
  }
  if (cmd === 'status') {
    const s = readJson(paths.status);
    console.log(s ? JSON.stringify(s, null, 2) : `no round yet (${paths.status})`);
    return;
  }
  if (cmd === 'stop') process.exit(await stopStack(paths));
  if (cmd === 'install') {
    if (process.platform !== 'linux') throw new Error('install writes a systemd user service: Linux only');
    const noCheckout = ensureCheckout(paths);
    if (noCheckout) throw new Error(noCheckout);
    if (!fs.existsSync(path.join(paths.checkout, 'tooling', 'beta', 'beta-host.mjs')))
      throw new Error(`the beta checkout (${paths.checkout}) has no tooling/beta/beta-host.mjs: install once it is on main`);
    fs.mkdirSync(path.dirname(paths.unit), { recursive: true });
    fs.writeFileSync(paths.unit, unitText(paths));
    for (const args of [['daemon-reload'], ['enable', '--now', 'intafaced-beta.service']]) {
      const r = spawnSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
      if (r.status !== 0) process.exit(r.status ?? 1);
    }
    console.log(`installed ${paths.unit}; status: node tooling/beta/beta-host.mjs status`);
    return;
  }
  console.error('usage: beta-host.mjs serve | round | check [--state <dir>] | status | stop | install');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`beta: ${err.message}`);
    process.exit(1);
  });
}
