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
 *                                             TEST mailbox page; after each round it restarts the public front when the
 *                                             checkout's beta-front.mjs changed (syncFront); it exits after a round that
 *                                             changed this file, asking systemd to start the new copy at once
 *   node tooling/beta/beta-host.mjs round     one round: fetch main, move the checkout to it when main has moved, launch
 *                                             or update the stack, run the TEST funds check, wait until it is readied,
 *                                             write status.json: `updating` from before the checkout moves until then,
 *                                             so the front shows its updating page, never a half-built app (#10299)
 *   node tooling/beta/beta-host.mjs check [--state <dir>]   the TEST funds check alone, on the beta stack (or another
 *                                             stack's state folder); exit 1 on any finding. `--hosted <beta-host>`
 *                                             also passes the exact hosted allow list: the test networks' hosts and the
 *                                             beta's own, nothing else (hostedAllowList)
 *   node tooling/beta/beta-host.mjs status    what the last round found
 *   node tooling/beta/beta-host.mjs stop      stop the beta stack (the supervisor's next round starts it again)
 *   node tooling/beta/beta-host.mjs install   write and start the systemd user service that runs `serve`
 *   node tooling/beta/beta-host.mjs invited-test [--checkout <dir>] [--root <dir>] [--watch]
 *                                             the journey-style test of invited testers (beta-invited.journey.mjs)
 *
 * What it keeps (AGENTS.md floor 1, 7 and 8):
 *   - It moves no money and posts nothing: the stack's own start readies it (TEST gates, TEST market maker, TEST
 *     content), exactly as `verify launch` readies a journeys shard.
 *   - TEST funds only, shown by a check, not by a name: every process the stack started is read for every address in
 *     its environment, and one that names anything but this machine (127.0.0.1, localhost, ::1) or the beta's own
 *     public host (BETA_OWN_HOSTS: the tunnel brings it back to this stack) is a finding. The one route off the
 *     machine is the trade desks' venue, Hyperliquid's test network (BETA_USER_VENUE; its host is fixed in the adapter,
 *     never set by the environment); no service can reach a real chain, venue, bank or card rail. The page must carry the
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
import { PUBLIC_ORIGIN } from './beta-front.mjs';
import { invitedPaths, readInvited, recordInvited } from './beta-invited.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/** The beta's fixed slot. Slot n adds 1000 × n to every stack port (local-test-facts.mjs), so the link is stable. */
export const BETA_SLOT = 3;
/** The Customer app on the beta slot. `localhost`, not 127.0.0.1: passkeys and T3's "Open on this device" need a name. */
export const BETA_LINK = `http://localhost:${3210 + 1000 * BETA_SLOT}/`;
/** The TEST mailbox page: the codes and links the beta stack "mails" into its LOCAL-TEST outbox file. */
export const MAILBOX_PORT = 6290;
const MAILBOX_LINK = `http://localhost:${MAILBOX_PORT}/`;
/** The TEST banner's words (apps/customer/deployment/test-banner.mjs BANNER_TEXT); the page must carry them. */
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
    ...invitedPaths(root),
    unit: path.join(home, '.config', 'systemd', 'user', 'intafaced-beta.service'),
    frontUnit: path.join(home, '.config', 'systemd', 'user', 'intafaced-beta-front.service'),
    /** The hash of the beta-front.mjs the front service was last started on. */
    front: path.join(root, 'front.json'),
    /** The beta's anvil launcher (anvilLauncher): present only once its pinned image is on the box. */
    anvil: path.join(root, 'anvil'),
    /** The stack settings the running stack was last launched with (BETA_STACK_SETTINGS); others, or none, restart it once. */
    settings: path.join(root, 'stack-settings'),
  };
}

/**
 * Seconds between the beta's TEST market cycles, and between its lake captures: its book stays quoted and its price
 * moves, without the journeys' 8 s and 2 s churn.
 */
const BETA_CADENCE_SECONDS = 300;

/**
 * The venue the beta's trade desks run on: Hyperliquid's test network, live, with TEST funds only (#10603, the beta
 * posture #10217), behind the same HTTP venue protocol as every venue (local-test-venue.mjs serveHyperliquidVenue). The
 * customer's own wallet signs; the venue holds no key. Without it the desks ran on the stack's stand-in venue.
 */
const BETA_USER_VENUE = 'hl-testnet';

/**
 * The beta's own stack settings, which a running stack takes only when started whole (settingsChanged): its public
 * name as the origin of what testers sign, its venue, no TEST listings on svc-trade's board, and svc-ops' labelled TEST
 * valuation price list. A passkey or wallet message signed on https://beta.intafaced.com names that origin, which the
 * front cannot rewrite; with only the stack's localhost origins every sign-in passkey, every TEST wallet approval and
 * Connect to the venue (protocol.wallet_session_origin_unlisted) failed there. The journeys' TEST markets
 * (an untraded book, a shut session, a delisting, a new listing no one quotes) are fixtures for a step, not markets a
 * tester can use; the beta showed TWIN/USDC's empty coin page from its markets list (#10599). The rows stay in the
 * database; the beta's markets are the quoted ones. Without `LOCAL_STACK_VALUATION_PRICES=test`, svc-ops leaves
 * `valuation.prices` unpublished (`valuation.prices_unset`), so Home and Money show "No total" even after an invited
 * tester's 1,000 TEST USDT sits in their TEST partner account (#10632); with it, svc-ops publishes the ops profile's
 * labelled TEST price list (`test: true`, refused outside dev/test) so Home and Money total the partner balance.
 */
const BETA_STACK_SETTINGS = Object.freeze({
  LOCAL_STACK_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
  LOCAL_STACK_USER_VENUE: BETA_USER_VENUE,
  LOCAL_STACK_TEST_MARKETS: 'off',
  LOCAL_STACK_VALUATION_PRICES: 'test',
});
const settingsLine = () =>
  Object.entries(BETA_STACK_SETTINGS)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');

/**
 * The environment every stack command of the beta runs with: its slot and its state folder, and the settings of a
 * stack no journey runs on (project-state #3857: idle, the beta used about 1.6 cores): its services record no code
 * reach, and its TEST market re-quotes and its lake captures every BETA_CADENCE_SECONDS. Its database keeps crash
 * durability, so a box restart keeps the testers' accounts (#10352).
 */
export const stackEnv = (paths, env = process.env, hasAnvil = fs.existsSync(paths.anvil)) => ({
  ...env,
  ...(hasAnvil && !env.LOCAL_STACK_ANVIL_BIN ? { LOCAL_STACK_ANVIL_BIN: paths.anvil } : {}),
  LOCAL_STACK_SLOT: String(BETA_SLOT),
  LOCAL_STACK_STATE: paths.state,
  LOCAL_STACK_CODE_REACH: 'off',
  LOCAL_STACK_PG_DURABLE: '1',
  LOCAL_STACK_MARKET_INTERVAL: String(BETA_CADENCE_SECONDS),
  LOCAL_STACK_QUANT_LAKE_CAPTURE_SECONDS: String(BETA_CADENCE_SECONDS),
  // The beta's Customer build shows only rooms finished in Volt (apps/customer/src/app/beta-volt.ts).
  INTAFACED_BETA_VOLT_ONLY: '1',
  ...BETA_STACK_SETTINGS,
});

/**
 * Whether the running stack must restart whole onto BETA_STACK_SETTINGS: its marker (paths.settings, written after a
 * launch that exits 0) names other settings or none. A stack update restarts svc-trade only when backend source moved,
 * so a changed setting alone would never reach it.
 */
function settingsChanged(paths) {
  try {
    return fs.readFileSync(paths.settings, 'utf8').trim() !== settingsLine();
  } catch {
    return true;
  }
}

/**
 * The TEST chain's anvil on the beta: the same pinned foundry image and `docker run` launcher the journeys use
 * (.github/workflows/real-app-journeys.yml, "Get an anvil launcher"). The box has no anvil of its own, and without one the
 * stack starts no TEST chain: svc-indexer is not started and svc-protocol keeps no node, so /dex, /chain, /protocol and
 * /dex/pools only ever said "didn't answer" or "Checking network…" (#10305). Host network, so anvil binds the loopback
 * port the stack names; the stack's stop signals the client, which passes it to the container (--init, --rm).
 */
export const ANVIL_IMAGE = 'ghcr.io/foundry-rs/foundry:v1.5.1';
export const anvilLauncher = (image = ANVIL_IMAGE) => `#!/bin/sh\nexec docker run --rm --init --network host ${image} "anvil $*"\n`;

/**
 * Puts the launcher in place once its image is on the box (pulled when missing), and returns the round.log line and
 * whether the launcher is new (`fresh`): a stack already running with no chain has started svc-protocol, svc-indexer's
 * absence and every other service's chain settings without one, so the round restarts it once onto the chain. With no
 * docker or a failed pull the launcher is removed, so the stack starts as before, with no TEST chain, rather than failing
 * its launch on a chain that cannot start.
 */
export function ensureAnvil(paths, sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 15 * 60_000 })) {
  const have = sh('docker', ['image', 'inspect', '--format', '{{.Id}}', ANVIL_IMAGE]).status === 0;
  const pulled = have || sh('docker', ['pull', '--quiet', ANVIL_IMAGE]).status === 0;
  if (!pulled) {
    fs.rmSync(paths.anvil, { force: true });
    return { line: `anvil: no ${ANVIL_IMAGE} (docker missing or the pull failed); the stack starts with no TEST chain`, fresh: false };
  }
  const fresh = !fs.existsSync(paths.anvil);
  const text = anvilLauncher();
  if (fresh || fs.readFileSync(paths.anvil, 'utf8') !== text) fs.writeFileSync(paths.anvil, text);
  fs.chmodSync(paths.anvil, 0o755);
  return { line: `anvil: ${ANVIL_IMAGE} ${have ? 'on the box' : 'pulled'}; the stack runs its TEST chain with ${paths.anvil}`, fresh };
}

// ── The TEST funds check ────────────────────────────────────────────────────

const NO_HOSTS = new Set();

/**
 * The beta's own public host, the one host off loopback this box's beta passes: the tunnel brings it back to this stack's
 * own loopback, so an address on it reaches nothing else. The stack's TEST owner values name it (the help centre on the
 * official-channel list, J-identity-13 #1). Any other host, a sibling name on the same domain included, still fails.
 */
export const BETA_OWN_HOSTS = Object.freeze(new Set([new URL(PUBLIC_ORIGIN).host]));

/**
 * The public test networks' hosts a hosted beta may reach (#10208), each exactly: the Hyperliquid test network's API
 * (packages/venue-hyperliquid HL_TESTNET_API_URL) and the Base Sepolia RPC. A host is allowed only by an exact match,
 * never a suffix, so `sepolia.base.org.attacker.net` is a finding. Adding a test network here is the only way to open
 * one; a mainnet, a bank or a card rail never goes on it.
 */
export const HOSTED_TEST_NETWORK_HOSTS = Object.freeze(['api.hyperliquid-testnet.xyz', 'sepolia.base.org']);

/**
 * The exact allow list for a hosted beta: the test networks' hosts and the beta's own host, nothing else. `betaHost`
 * must be one plain DNS name (no scheme, port, path or wildcard); anything else throws, so the check never runs open.
 */
export function hostedAllowList(betaHost) {
  const host = String(betaHost ?? '')
    .trim()
    .toLowerCase();
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  if (!new RegExp(`^${label}(?:\\.${label})+$`).test(host))
    throw new Error(`beta: the hosted beta's host must be one plain DNS name like beta.example.com, not "${betaHost ?? ''}"`);
  return new Set([...HOSTED_TEST_NETWORK_HOSTS, host]);
}

/**
 * Every address in one process environment that names a host other than this machine, as `{ key, scheme, host }`. A
 * value is read for every `scheme://[user@]host` in it (a list of URLs counts each one). `allow` (a hosted beta's
 * `hostedAllowList`) adds hosts that pass by exact match; without it only this machine and reserved names pass. The
 * value itself is never returned: environments hold the stack's secrets.
 */
export function outsideAddresses(entries, allow = NO_HOSTS) {
  const out = [];
  for (const [key, value] of entries) {
    for (const m of String(value).matchAll(/\b([a-z][a-z0-9+.-]*):\/\/(?:[^/\s@"',;]*@)?(\[[^\]]+\]|[^/\s:,;"'?#]+)/gi)) {
      const host = m[2].toLowerCase();
      if (!LOOPBACK.has(host) && !reservedHost(host) && !allow.has(host)) out.push({ key, scheme: m[1].toLowerCase(), host });
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

/** A /proc/net/tcp or tcp6 address (hex, the kernel's byte order) as text: `0.0.0.0`, `127.0.0.1`, `::`, `::ffff:…`. */
export function procHost(hex) {
  const words = hex.match(/.{8}/g).map((w) => w.match(/../g).reverse().join(''));
  if (words.length === 1)
    return words[0]
      .match(/../g)
      .map((b) => parseInt(b, 16))
      .join('.');
  const all = words.join('').toLowerCase();
  if (/^0{32}$/.test(all)) return '::';
  if (/^0{31}1$/.test(all)) return '::1';
  if (/^0{20}ffff/.test(all)) return `::ffff:${procHost(hex.slice(24))}`;
  return all.match(/.{4}/g).join(':');
}

/** One /proc/net/tcp or tcp6 table's listening sockets (state 0A), as `{ inode, host, port }`. */
export function listeningSockets(text) {
  const out = [];
  for (const line of String(text).split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '0A') continue;
    const [hex, port] = f[1].split(':');
    out.push({ inode: f[9], host: procHost(hex), port: parseInt(port, 16) });
  }
  return out;
}

/** Is a listen address this machine only? */
const loopbackListen = (host) => host.startsWith('127.') || host === '::1' || host.startsWith('::ffff:127.');

/**
 * The TEST funds check on one stack. `records` are the stack's processes ({ name: { pid } }, run/processes.json);
 * `readEnviron(pid)` gives a process's environ text or null; `readListeners(pid)` its listening sockets
 * (`{ host, port }`) or null; `page` is the Customer page's HTML or null. A listener on any address but loopback is a
 * finding: the home network could reach it (#10244). Returns `{ ok, lines }`, one line per finding or pass, naming
 * keys and hosts, never a value.
 */
export function fundsCheck({ records, readEnviron, readListeners = () => null, page, allow = NO_HOSTS }) {
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
    const outside = outsideAddresses(environEntries(text), allow);
    if (outside.length === 0) clean++;
    const off = allow.size ? 'off this machine and the hosted allow list' : 'off this machine';
    for (const a of outside) findings.push(`${name} (pid ${r.pid}): ${a.key} names ${a.scheme}://${a.host}, ${off}`);
    for (const l of readListeners(r.pid) ?? []) {
      if (!loopbackListen(l.host)) findings.push(`${name} (pid ${r.pid}): listens on ${l.host} port ${l.port}, reachable off this machine`);
    }
  }
  if (named.length && read === 0) findings.push('no running process could be read');
  const where = allow.size ? 'this machine, a reserved name or the hosted allow list' : 'this machine or a reserved name';
  if (clean) passes.push(`${clean} of ${read} running processes: every address in their environments is ${where}`);
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
/** One process's listening TCP sockets, from its socket fds and the kernel's tables, or null once it has ended. */
export const readListeners = (pid) => {
  let inodes;
  try {
    inodes = new Set(
      fs
        .readdirSync(`/proc/${pid}/fd`)
        .map((fd) => {
          try {
            return /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1];
          } catch {
            return undefined; // an fd closed while it was read
          }
        })
        .filter(Boolean),
    );
  } catch {
    return null;
  }
  const tables = ['tcp', 'tcp6'].map((t) => {
    try {
      return fs.readFileSync(`/proc/${pid}/net/${t}`, 'utf8');
    } catch {
      return '';
    }
  });
  return tables.flatMap(listeningSockets).filter((l) => inodes.has(l.inode));
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

async function checkStack(state, link, allow = NO_HOSTS) {
  const records = readJson(path.join(state, 'run', 'processes.json'), {});
  return fundsCheck({ records, readEnviron, readListeners, page: await getText(link), allow });
}

// ── Readied: what a tester sees first ───────────────────────────────────────

/**
 * Is the stack readied for a tester, from the two public reads Home and Markets make (`/api/v1/markets`, `/api/v1/tickers`,
 * either text or null)? Right after a restart the stack answered while it listed only the TEST pairs with blank prices and
 * Home showed "Prices can't be loaded" (#10299). Readied: a market that is not a TEST pair has a last price.
 */
export function readied({ markets, tickers }) {
  let list;
  let prices;
  try {
    list = JSON.parse(markets ?? '');
    prices = JSON.parse(tickers ?? '');
  } catch {
    return { ok: false, why: 'the market list or the prices did not answer' };
  }
  if (!Array.isArray(list) || !prices || typeof prices !== 'object')
    return { ok: false, why: 'the market list or the prices did not answer' };
  const priced = list.filter((m) => m && m.test !== true && Number.isFinite(Number.parseFloat(prices[m.symbol]?.last)));
  return priced.length
    ? { ok: true, why: `${priced.length} of ${list.length} markets have a price` }
    : { ok: false, why: `none of ${list.length} markets that are not TEST pairs has a price yet` };
}

async function readiedNow(link) {
  const [markets, tickers] = await Promise.all([getText(`${link}api/v1/markets?limit=500`), getText(`${link}api/v1/tickers?limit=500`)]);
  return readied({ markets, tickers });
}

/** How long a round waits, after the launch and the TEST funds check pass, for the stack to be readied. */
export const READY_WAIT_MS = 5 * 60_000;
const READY_EVERY_MS = 10_000;

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

/** The rows a viewer may see: mail to TEST addresses whose local part is their token, or it, a dot and more. A token
 * holds no dot (beta-front.mjs viewerToken), so one viewer's token is never the start of another's addresses. */
export function viewerRows(rows, token) {
  if (!token) return [];
  return rows.filter((r) => {
    const local = String(r.email ?? '')
      .toLowerCase()
      .split('@')[0];
    return local === token || local.startsWith(`${token}.`);
  });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function mailboxPage(rows, { link = BETA_LINK, status = null, viewer = null } = {}) {
  const body = rows.length
    ? rows
        .map(
          (r) =>
            `<tr><td>${esc(r.purpose)}</td><td>${esc(r.email)}</td><td class="code">${r.code ? esc(r.code) : r.link ? `<a href="${esc(new URL(r.link.replace(/^\//, ''), link))}">open the link</a>` : ''}</td><td>${esc(r.expires)}</td></tr>`,
        )
        .join('\n')
    : '<tr><td colspan="4">No mail yet. Sign up in the app, then reload this page.</td></tr>';
  const state = status
    ? `<p>Beta: ${esc(status.state)}${status.sha ? ` on main ${esc(status.sha.slice(0, 9))}` : ''}${status.mainAt && status.sha && status.mainAt !== status.sha ? ` (main is at ${esc(status.mainAt.slice(0, 9))}; the beta moves to it in its next round)` : ''}${status.reason ? `: ${esc(status.reason)}` : ''}</p>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10"><title>TEST mailbox</title>
<style>body{background:#0b0b0b;color:#eee;font:16px/1.4 system-ui,sans-serif;margin:0;padding:1rem}h1{font-size:1.2rem}
.test{background:#F5A915;color:#0b0b0b;font-weight:600;padding:.3rem .6rem;display:inline-block}table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #333;padding:.4rem;text-align:start;word-break:break-all}.code{font:600 1.3rem ui-monospace,monospace}a{color:#9cf}</style></head>
<body><p class="test">TEST MAILBOX: test accounts only, not real mail</p><h1>Codes and links the beta app sent</h1>${state}
${viewer ? `<p>You see only mail to TEST addresses that start with <b>${esc(viewer)}</b>. Sign up with one, for example <b>${esc(viewer)}.1@local-test.invalid</b>.</p>` : ''}
<p><a href="${esc(link)}">Open the beta app</a>. This page reloads every 10 seconds.</p>
<table><thead><tr><th>What</th><th>To</th><th>Code</th><th>Expires</th></tr></thead><tbody>
${body}
</tbody></table></body></html>`;
}

/** The TEST mailbox page's server, on `port` (MAILBOX_PORT on the beta). */
export function serveMailbox(paths, port = MAILBOX_PORT) {
  const server = http.createServer((req, res) => {
    let text = '';
    try {
      text = fs.readFileSync(path.join(paths.state, 'email-outbox.log'), 'utf8');
    } catch {}
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
    // Through the public front, each viewer sees only their own addresses' mail (beta-front.mjs VIEWER_HEADER); on the
    // box's own loopback, without the header, every row.
    const viewer = req.headers['x-beta-viewer'];
    // A viewer the front passed on came through Cloudflare Access, so is on the invite list (beta-invited.mjs).
    if (viewer !== undefined && recordInvited(paths.invited, String(viewer))) log(paths, `mailbox: a new invited viewer, ${viewer}`);
    const rows = mailboxRows(text);
    res.end(
      mailboxPage(viewer === undefined ? rows : viewerRows(rows, String(viewer)), {
        status: readJson(paths.status),
        viewer: viewer ?? null,
      }),
    );
  });
  server.on('error', (err) => log(paths, `mailbox: ${err.message}`));
  server.listen(port, '127.0.0.1');
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
export function decide({ screening, head, target }) {
  if (!screening) return 'blocked';
  // Every round moves to a moved main, so each merge is on the beta within one round (owner's guide, 25 Nov: the beta
  // picks up each merge the same hour; it replaced the 2-hour bound and its beta-issue bypass, #10612).
  return head === target ? 'launch' : 'update';
}

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
async function stopStack(paths, runWith = run) {
  let code = 0;
  for (const args of stopCommands(paths)) {
    const c = await runWith(paths, 'node', args, { cwd: paths.checkout, env: stackEnv(paths) });
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

/** What a round reaches outside itself: git, commands, the TEST funds check, the readied probe, the clock. A test replaces them. */
const roundIo = {
  git,
  run,
  check: (state, link) => checkStack(state, link, BETA_OWN_HOSTS),
  readied: readiedNow,
  anvil: ensureAnvil,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

export async function round(paths = betaPaths(), io = {}) {
  const { git, run, check: checkWith, readied: readiedWith, anvil, sleep, now } = { ...roundIo, ...io };
  fs.mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  const noCheckout = ensureCheckout(paths);
  if (noCheckout) return finish(paths, { state: 'down', reason: noCheckout });
  const fetched = git(paths.checkout, 'fetch', '--quiet', 'origin', 'main');
  if (fetched.status !== 0) log(paths, `fetch failed (${fetched.stderr.trim()}); the round goes on with the last main it has`);
  const target = git(paths.checkout, 'rev-parse', 'origin/main').stdout.trim();
  const head = git(paths.checkout, 'rev-parse', 'HEAD').stdout.trim();
  const prev = readJson(paths.status, {});
  const screening = fs.existsSync(paths.screening);
  const step = decide({ screening, head, target });
  log(paths, `round: ${step} (checkout ${head.slice(0, 9)}, main ${target.slice(0, 9)})`);
  if (step === 'blocked')
    return finish(paths, {
      state: 'blocked',
      reason: `no TEST screening file at ${paths.screening}: Edge would refuse every call, so nothing is built (docs/runbooks/beta-link.md)`,
      sha: head,
    });
  const chain = anvil(paths);
  log(paths, chain.line);
  const settingsNew = settingsChanged(paths);
  const env = stackEnv(paths);
  // The commit the stack serves after this round, and when the checkout last moved: the next update waits on it.
  const sha = step === 'update' ? target : head;
  const updatedAt = step === 'update' ? new Date(now()).toISOString() : prev.updatedAt;
  const mainAt = target;
  // A tester never meets the stack half-built (#10299): from before the checkout moves until the stack is readied, the
  // status reads `updating`, and the front shows its updating page instead of the app. A launch on a stack that was up and
  // readied restarts nothing (same commit), so it stays `up`.
  const warm = !chain.fresh && !settingsNew && step === 'launch' && prev.state === 'up' && (await readiedWith(BETA_LINK)).ok;
  if (!warm)
    writeStatus(paths, {
      state: 'updating',
      reason: step === 'update' ? `moving to main ${target.slice(0, 9)}` : 'starting what is down',
      sha: head,
      target: sha,
      since: new Date(now()).toISOString(),
      updatedAt: prev.updatedAt,
      mainAt,
    });
  if (step === 'update') {
    const co = git(paths.checkout, 'checkout', '--quiet', '--detach', target);
    if (co.status !== 0) return finish(paths, { state: 'down', reason: `checkout of ${target} failed: ${co.stderr.trim()}`, sha: head });
    if ((await run(paths, 'pnpm', ['install', '--frozen-lockfile'], { cwd: paths.checkout, env })) !== 0)
      return finish(paths, { state: 'down', reason: 'pnpm install failed (round.log)', sha, updatedAt, mainAt });
  }
  if (chain.fresh) {
    log(paths, 'anvil: new, so the stack is stopped and started whole on its TEST chain');
    await stopStack(paths, run);
  } else if (settingsNew) {
    log(paths, `settings: ${settingsLine()} are new, so the stack is stopped and started whole on them`);
    await stopStack(paths, run);
  }
  const stackCli = path.join(paths.checkout, 'tooling', 'scripts', 'local-test-stack.mjs');
  const launched = await run(paths, 'node', [stackCli, 'start', 'verify', 'launch'], { cwd: paths.checkout, env });
  if (launched === 0) fs.writeFileSync(paths.settings, `${settingsLine()}\n`);
  const check = await checkWith(paths.state, BETA_LINK);
  for (const l of check.lines) log(paths, `check: ${l}`);
  if (!check.ok) {
    await stopStack(paths, run);
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
  // Readied: still `updating` until Markets lists priced markets, so Home and Markets open full.
  let ready = await readiedWith(BETA_LINK);
  for (const until = now() + READY_WAIT_MS; !ready.ok && now() < until;) {
    await sleep(READY_EVERY_MS);
    ready = await readiedWith(BETA_LINK);
  }
  log(paths, `readied: ${ready.ok ? 'ok' : 'not yet'}: ${ready.why}`);
  if (!ready.ok)
    return finish(paths, {
      state: 'down',
      reason: `not readied ${READY_WAIT_MS / 60_000} minutes after the launch: ${ready.why}`,
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
    upSince: warm && prev.upSince ? prev.upSince : new Date(now()).toISOString(),
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

/** How often the invited testers' pass runs (beta-invited.mjs): a Full request is approved and funded within a minute. */
const INVITED_EVERY_MS = 15_000;

/**
 * Whether the invited pass runs now: the stack is up, someone invited has opened the mailbox, and no pass is running.
 * Idle (no invited viewer yet) it starts nothing.
 */
export const invitedPassDue = ({ state, invited, running }) => state === 'up' && invited > 0 && !running;

/**
 * One invited pass at a time, from the checkout's own copy, its lines in the round log; never longer than 2 minutes. A
 * failed pass waits a minute before the next, so a stack that refuses fills the log once a minute, not every 15 s.
 */
export function invitedLoop(paths, { script = path.join(paths.checkout, 'tooling', 'beta', 'beta-invited.mjs') } = {}) {
  let running = false;
  let nextAt = 0;
  const tick = () => {
    if (Date.now() < nextAt) return;
    if (!invitedPassDue({ state: readJson(paths.status, {})?.state, invited: readInvited(paths.invited).size, running })) return;
    running = true;
    const out = fs.openSync(paths.log, 'a');
    const args = [script, 'pass', '--root', paths.root, '--checkout', paths.checkout];
    const child = spawn('node', args, { cwd: paths.checkout, env: stackEnv(paths), stdio: ['ignore', out, out] });
    const timer = setTimeout(() => child.kill('SIGTERM'), 120_000);
    let ended = false;
    const end = (code) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      fs.closeSync(out);
      if (code !== 0) nextAt = Date.now() + 60_000;
      running = false;
    };
    child.on('close', (code) => end(code ?? 1));
    child.on('error', () => end(127));
  };
  const every = setInterval(tick, INVITED_EVERY_MS);
  return () => clearInterval(every);
}

async function serve(paths) {
  const everyMin = Number(process.env.BETA_EVERY_MIN ?? 30);
  if (!Number.isFinite(everyMin) || everyMin < 5 || everyMin > 55) throw new Error('BETA_EVERY_MIN must be 5 to 55');
  const mine = fileHash(SELF);
  serveMailbox(paths);
  invitedLoop(paths);
  for (;;) {
    try {
      await round(paths);
    } catch (err) {
      finish(paths, { state: 'down', reason: `round threw: ${err.message}` });
    }
    try {
      syncFront(paths);
    } catch (err) {
      log(paths, `front: ${err.message}`);
    }
    // The checkout's copy of this file moved with main: start the new one at once (selfRestart), else exit and let
    // systemd (Restart=always) start it.
    if (SELF.startsWith(paths.checkout + path.sep) && fileHash(SELF) !== mine) {
      if (selfRestart() === 'restart') {
        log(paths, 'serve: beta-host.mjs changed on main; systemd starts the new copy now');
        // systemd stops this copy as its restart job runs; should it not, exit and Restart=always starts the new one.
        await new Promise((r) => setTimeout(r, 30_000));
      } else log(paths, 'serve: beta-host.mjs changed on main; exiting so the new copy starts');
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, everyMin * 60_000));
  }
}

const BETA_SERVICE = 'intafaced-beta.service';

/**
 * How the supervisor hands over to a new copy of itself (#10888): when it is its unit's main process, it asks systemd to
 * restart the unit now ('restart'), so the TEST mailbox is down only while node starts, not for RestartSec; run by
 * hand, or when systemd refuses, it exits ('exit').
 */
export function selfRestart({
  pid = process.pid,
  systemctl = (...args) => spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 10_000 }),
} = {}) {
  const show = systemctl('show', BETA_SERVICE, '-p', 'MainPID');
  if (show.status !== 0 || Number(/MainPID=(\d+)/.exec(show.stdout ?? '')?.[1]) !== pid) return 'exit';
  return systemctl('restart', '--no-block', BETA_SERVICE).status === 0 ? 'restart' : 'exit';
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

const FRONT_SERVICE = 'intafaced-beta-front.service';

/**
 * The public front's systemd user service (beta-front.mjs), run from the beta checkout, so a merged change to the front
 * reaches the link with the round that moves the checkout (#10294), not by a copy placed by hand.
 */
export function frontUnitText(paths) {
  return `[Unit]
Description=INTAFACED beta public front: 127.0.0.1:6211 -> app :6210, 127.0.0.1:6291 -> TEST mailbox :6290, for https://beta.intafaced.com (cloudflared)
After=intafaced-beta.service

[Service]
Type=simple
WorkingDirectory=${paths.checkout}
ExecStart=/bin/bash -lc 'exec node tooling/beta/beta-front.mjs'
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/**
 * What the supervisor does to the front after a round: 'none' where no front is installed (it is installed with the
 * tunnel, docs/runbooks/beta-link.md), 'install' when its unit is not the one above (write it, reload, restart),
 * 'restart' when the checkout's beta-front.mjs is not the file it last started on, else 'keep'.
 */
export function frontAction({ unitOnDisk, unitWanted, startedOn, fileHash: now }) {
  if (unitOnDisk == null || now == null) return 'none';
  if (unitOnDisk !== unitWanted) return 'install';
  return startedOn === now ? 'keep' : 'restart';
}

export function syncFront(paths, systemctl = (...args) => spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' })) {
  let unitOnDisk = null;
  try {
    unitOnDisk = fs.readFileSync(paths.frontUnit, 'utf8');
  } catch {}
  const unitWanted = frontUnitText(paths);
  const hash = fileHash(path.join(paths.checkout, 'tooling', 'beta', 'beta-front.mjs'));
  const action = frontAction({ unitOnDisk, unitWanted, startedOn: readJson(paths.front, {})?.sha256 ?? null, fileHash: hash });
  if (action === 'none' || action === 'keep') return action;
  if (action === 'install') {
    fs.writeFileSync(paths.frontUnit, unitWanted);
    systemctl('daemon-reload');
  }
  const r = systemctl('restart', FRONT_SERVICE);
  if (r.status === 0) fs.writeFileSync(paths.front, `${JSON.stringify({ sha256: hash, at: new Date().toISOString() })}\n`);
  log(paths, `front: ${action}${r.status === 0 ? '' : ` failed (systemctl exited ${r.status})`}`);
  return action;
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
    const h = rest.indexOf('--hosted');
    const allow = h >= 0 ? hostedAllowList(rest[h + 1]) : state === paths.state ? BETA_OWN_HOSTS : NO_HOSTS;
    const c = await checkStack(state, link, allow);
    for (const l of c.lines) console.log(l);
    process.exit(c.ok ? 0 : 1);
  }
  if (cmd === 'status') {
    const s = readJson(paths.status);
    console.log(s ? JSON.stringify(s, null, 2) : `no round yet (${paths.status})`);
    return;
  }
  if (cmd === 'stop') process.exit(await stopStack(paths));
  // The journey-style test of the invited testers' approval and funds (#10243); it reads its own flags.
  if (cmd === 'invited-test') return void (await import('./beta-invited.journey.mjs'));
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
  console.error(
    'usage: beta-host.mjs serve | round | check [--state <dir>] [--hosted <beta-host>] | status | stop | install | invited-test [--watch]',
  );
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`beta: ${err.message}`);
    process.exit(1);
  });
}
