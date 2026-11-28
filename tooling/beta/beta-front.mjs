#!/usr/bin/env node
/**
 * The beta's public front (docs/runbooks/beta-link.md): what the Cloudflare Tunnel reaches, behind Cloudflare Access.
 * No dependencies.
 *
 *   127.0.0.1:6211 -> 127.0.0.1:6210  the Customer app, served to https://beta.intafaced.com
 *   127.0.0.1:6291 -> 127.0.0.1:6290  the TEST mailbox, served to https://beta-mail.intafaced.com
 *
 * The stack only knows its loopback origin (http://localhost:6210): its Host check, Edge's and svc-ws's origin lists,
 * passkeys. Nothing in the stack's environment changes (beta-host.mjs check stays green); this front translates instead:
 *   - Host becomes localhost:6210 (the stack refuses any other).
 *   - Origin becomes http://localhost:6210 only when it is exactly the public origin; any other Origin passes unchanged,
 *     so Edge and svc-ws still refuse cross-site calls.
 *   - Referer under the public origin is rewritten the same way.
 *   - Location answers on the loopback origin point back at the public origin.
 *   - WebSocket upgrades get the same request rewrites.
 *   - Cloudflare Access's token (Cf-Access-Jwt-Assertion, the CF_Authorization cookie) never reaches the stack.
 *   - X-Forwarded-For becomes the caller's own address, from Cloudflare's Cf-Connecting-Ip (which Cloudflare sets on
 *     every request it passes, over anything the caller sent), else this front's TCP peer; every forwarding header the
 *     caller sent is dropped. The stack trusts this one hop on loopback (EDGE_TRUST_PROXY, WS_TRUST_PROXY), so each
 *     tester has their own rate-limit bucket and per-IP socket budget, and nobody can name another address (#11027).
 *   - The mailbox gets the viewer's token (VIEWER_HEADER), read from the Access token, and shows only the mail of the
 *     TEST addresses that start with it, so each person sees only the codes for the accounts they created (owner
 *     decision project-state#3903). No Access token, no mailbox. The tunnel already refused any request whose Access
 *     token its app did not sign (cloudflared's `originRequest.access`), so the token's email is read, not re-checked.
 *   - A sign-up (`auth.signUpStart`) from a viewer the Access token names, with any address but one of that viewer's
 *     TEST addresses (the token, or the token, a dot and more, at local-test.invalid), is refused here, before the stack
 *     sees it: no other address's code ever reaches the viewer's mailbox, and no other account is approved or funded
 *     (beta-invited.mjs invitedOwner). The refusal names the address to use and the mailbox (#11217).
 * Only the public name and this front's own loopback names are served (DNS rebinding stays closed).
 *
 * While the beta updates (beta-host.mjs writes `updating` to its status file from before the checkout moves until the new
 * stack is readied) or is down, a page load gets a short "updating" page instead of the app, and an open app tab, which
 * reads /__beta/state every 15 s through a script this front adds to the app's page, reloads onto it (#10299).
 */
import fs from 'node:fs';
import http from 'node:http';
import { createHash } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PUBLIC_ORIGIN = 'https://beta.intafaced.com';
const MAIL_PUBLIC_HOST = 'beta-mail.intafaced.com';
/** The TEST mailbox, where every code the beta mails is read (beta-host.mjs mailboxPage). */
export const MAILBOX_URL = `https://${MAIL_PUBLIC_HOST}/`;
const APP = { listen: 6211, upstream: 6210, upstreamHost: 'localhost:6210', upstreamOrigin: 'http://localhost:6210' };
const MAIL = { listen: 6291, upstream: 6290, upstreamHost: 'localhost:6290' };
const LOOPBACK_ORIGINS = ['http://localhost:6210', 'http://127.0.0.1:6210'];
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

const servedHosts = (publicHost, port) => new Set([publicHost, `localhost:${port}`, `127.0.0.1:${port}`]);
const APP_HOSTS = servedHosts(new URL(PUBLIC_ORIGIN).host, APP.listen);
const MAIL_HOSTS = servedHosts(MAIL_PUBLIC_HOST, MAIL.listen);

export const VIEWER_HEADER = 'x-beta-viewer';

/**
 * The token a viewer's TEST addresses start with: their Access email, lowercased, every other character a dash, then a
 * dash and the first 10 hex characters of the SHA-256 of the lowercased email. The readable part alone can fold two
 * emails into one (`a.b@x.io`, `a_b@x.io`); the hash keeps one token per email.
 */
export function viewerToken(email) {
  const e = String(email ?? '')
    .trim()
    .toLowerCase();
  if (!e.includes('@')) return null;
  const readable = e.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${readable}-${createHash('sha256').update(e).digest('hex').slice(0, 10)}`;
}

/** The Access-verified viewer's token, from Cf-Access-Jwt-Assertion or the CF_Authorization cookie; null without one. */
export function viewerFromAccess(headers) {
  const fromCookie = /(?:^|;\s*)CF_Authorization=([^;]+)/i.exec(String(headers.cookie ?? ''))?.[1];
  const jwt = String(headers['cf-access-jwt-assertion'] ?? fromCookie ?? '');
  const payload = jwt.split('.')[1];
  if (!payload) return null;
  try {
    return viewerToken(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).email);
  } catch {
    return null;
  }
}

/** The only domain a viewer's TEST addresses use (beta-invited.mjs INVITED_DOMAIN). */
const TEST_DOMAIN = 'local-test.invalid';
const SIGN_UP_PATH = '/api/identity/trpc/auth.signUpStart';
/** The most of a sign-up body the front reads to check its address; a longer one is refused by size. */
const SIGN_UP_MAX_BYTES = 16 * 1024;

/** Whether `email` is one of `token`'s TEST addresses: the token, or the token, a dot and more, at local-test.invalid. */
export function viewerAddress(email, token) {
  const e = String(email ?? '')
    .trim()
    .toLowerCase();
  const at = e.lastIndexOf('@');
  if (!token || at < 1 || e.slice(at + 1) !== TEST_DOMAIN) return false;
  const local = e.slice(0, at);
  return local === token || (local.startsWith(`${token}.`) && local.length > token.length + 1);
}

/**
 * The front's refusal of a sign-up body from `token`'s viewer, as the stack's tRPC refusals are shaped (the app shows
 * its message), or null when it may pass: a body that is not JSON, or names no email, is left to the stack to answer.
 */
export function signUpRefusal(text, token) {
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    return null;
  }
  const email = input && typeof input === 'object' ? input.email : undefined;
  if (input?.channel !== 'email' && email === undefined) return null;
  if (viewerAddress(email, token)) return null;
  const message = `On the beta, sign up with ${token}.1@${TEST_DOMAIN} (or ${token}, a dot and anything, @${TEST_DOMAIN}), not your own email: its code arrives only in your TEST mailbox, ${MAILBOX_URL}`;
  return JSON.stringify({ error: { message, code: -32600, data: { code: 'beta.signup_address_not_yours', httpStatus: 400 } } });
}

function withoutAccessCookie(cookie) {
  const kept = String(cookie)
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !/^CF_Authorization=/i.test(p));
  return kept.length ? kept.join('; ') : null;
}

/** Forwarding headers only this front writes: whatever a caller sends under these names is dropped. */
const FORWARDING = new Set(['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'forwarded']);

/** The caller's own address: Cloudflare's Cf-Connecting-Ip when it is one IP address, else this front's TCP peer. */
function callerAddress(headers, peer) {
  const cf = String(headers['cf-connecting-ip'] ?? '').trim();
  if (net.isIP(cf)) return cf;
  return peer && net.isIP(peer) ? peer : null;
}

/**
 * Request headers for the app upstream. `upgrade` keeps Connection/Upgrade for a WebSocket handshake; `peer` is this
 * front's TCP peer (cloudflared's address), the caller's address when Cloudflare named none.
 */
export function appRequestHeaders(headers, { upgrade = false, peer = null } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (!upgrade && HOP.has(lk)) continue;
    if (lk === 'cf-access-jwt-assertion') continue;
    if (FORWARDING.has(lk)) continue;
    out[lk] = v;
  }
  const caller = callerAddress(out, peer);
  if (caller) out['x-forwarded-for'] = caller;
  out.host = APP.upstreamHost;
  if (out.origin === PUBLIC_ORIGIN) out.origin = APP.upstreamOrigin;
  if (typeof out.referer === 'string' && (out.referer === PUBLIC_ORIGIN || out.referer.startsWith(`${PUBLIC_ORIGIN}/`)))
    out.referer = APP.upstreamOrigin + out.referer.slice(PUBLIC_ORIGIN.length);
  if (out.cookie !== undefined) {
    const c = withoutAccessCookie(Array.isArray(out.cookie) ? out.cookie.join('; ') : out.cookie);
    if (c) out.cookie = c;
    else delete out.cookie;
  }
  return out;
}

/** A Location on the loopback origin points at the public origin; anything else is left as it is. */
export function publicLocation(location) {
  for (const o of LOOPBACK_ORIGINS) {
    if (location === o || location.startsWith(`${o}/`)) return PUBLIC_ORIGIN + location.slice(o.length);
  }
  return location;
}

function responseHeaders(ur) {
  const out = {};
  for (const [k, v] of Object.entries(ur.headers)) {
    if (HOP.has(k)) continue;
    out[k] = k === 'location' && typeof v === 'string' ? publicLocation(v) : v;
  }
  return out;
}

function refuse(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

// ── While the beta updates ──────────────────────────────────────────────────

/** The status file beta-host.mjs writes after each step of a round. */
const STATUS_FILE = path.join(os.homedir(), '.intafaced', 'beta', 'status.json');
const STATE_PATH = '/__beta/state';
const WATCH_PATH = '/__beta/watch.js';

/**
 * What a tester is shown instead of the app, from the status file: 'updating' while a round moves the stack to main or
 * starts it, 'closed' when it is down, refused or blocked, null (the app) when it is up or there is no status yet.
 */
export function holdOf(status) {
  const state = status?.state;
  if (state === 'updating') return 'updating';
  if (state === 'down' || state === 'refused' || state === 'blocked') return 'closed';
  return null;
}

const HOLD_COPY = {
  updating: {
    title: 'Updating the beta',
    body: 'We are moving the beta to the newest build. It is back in a few minutes, and this page opens it by itself.',
  },
  closed: {
    title: 'The beta is resting',
    body: 'The beta is not answering right now. We are on it; this page opens it by itself as soon as it is back.',
  },
};

/** The page shown while held: Volt's dark look (packages/ui tokens.css), no script, reloading itself every 20 seconds. */
function holdPage(kind) {
  const { title, body } = HOLD_COPY[kind] ?? HOLD_COPY.closed;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="20"><meta name="color-scheme" content="dark"><title>${title} · INTAFACED</title>
<style>html{background:#000;color:#f7f7f8;color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 Inter,system-ui,-apple-system,sans-serif}
main{max-width:28rem;margin:1.5rem;padding:2rem;background:#0c0c0e;border:1px solid rgba(255,255,255,.09);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.4)}
.mark{font:700 .85rem/1 Orbitron,Rajdhani,system-ui,sans-serif;letter-spacing:.2em;color:#ff6b00}h1{font:600 1.4rem/1.3 Orbitron,Rajdhani,system-ui,sans-serif;margin:1rem 0 .5rem}
p{color:#a2a2ac;margin:0}.dot{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;background:#ff6b00;box-shadow:0 0 12px rgba(255,107,0,.24);margin-inline-end:.5rem;animation:p 1.6s ease-in-out infinite}
@keyframes p{50%{opacity:.3}}@media (prefers-reduced-motion:reduce){.dot{animation:none}}.test{margin-top:1.5rem;font-size:.8rem;color:rgba(247,247,248,.4)}</style></head>
<body><main><div class="mark">INTAFACED</div><h1><span class="dot" aria-hidden="true"></span>${title}</h1><p>${body}</p><p class="test">Beta on TEST funds: nothing here is real money.</p></main></body></html>`;
}

/** The script added to the app's page: an open tab reloads onto the updating page when the beta starts updating. */
const WATCH_SCRIPT = `(()=>{const t=setInterval(async()=>{try{const r=await fetch('${STATE_PATH}',{cache:'no-store'});if((await r.json()).hold){clearInterval(t);location.reload()}}catch{}},15000)})();\n`;

/** The app's HTML with the watch script added in its head; anything else unchanged (null). */
function withWatch(html) {
  const at = html.indexOf('</head>');
  return at < 0 ? null : `${html.slice(0, at)}<script src="${WATCH_PATH}" defer></script>${html.slice(at)}`;
}

const wantsPage = (req) => (req.method === 'GET' || req.method === 'HEAD') && /\btext\/html\b/i.test(String(req.headers.accept ?? ''));

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...extra });
  res.end(body);
}

const sendHold = (req, res, kind) =>
  send(res, 503, 'text/html; charset=utf-8', req.method === 'HEAD' ? '' : holdPage(kind), {
    'retry-after': '30',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
  });

function statusReader(file, cacheMs) {
  let at = 0;
  let last = null;
  return () => {
    if (Date.now() - at < cacheMs) return last;
    at = Date.now();
    try {
      last = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      last = null;
    }
    return last;
  };
}

export function frontApp({ upstream = APP.upstream, statusFile = STATUS_FILE, cacheMs = 1000 } = {}) {
  const status = statusReader(statusFile, cacheMs);
  const server = http.createServer((req, res) => {
    if (!APP_HOSTS.has(req.headers.host ?? '')) return refuse(res, 403, 'forbidden host');
    const pathname = String(req.url ?? '').split('?')[0];
    if (pathname === STATE_PATH) return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ hold: holdOf(status()) }));
    if (pathname === WATCH_PATH) return send(res, 200, 'text/javascript; charset=utf-8', WATCH_SCRIPT);
    const page = wantsPage(req);
    const hold = holdOf(status());
    if (page && hold) return sendHold(req, res, hold);
    const viewer = req.method === 'POST' && pathname === SIGN_UP_PATH ? viewerFromAccess(req.headers) : null;
    const headers = appRequestHeaders(req.headers, { peer: req.socket.remoteAddress });
    if (page) delete headers['accept-encoding']; // the page comes back plain, so the watch script can be added
    const forward = () => {
      const up = http.request({ host: '127.0.0.1', port: upstream, method: req.method, path: req.url, headers }, (ur) => {
        const out = responseHeaders(ur);
        const html =
          page &&
          ur.statusCode === 200 &&
          /^text\/html\b/i.test(String(ur.headers['content-type'] ?? '')) &&
          !ur.headers['content-encoding'];
        if (!html) {
          res.writeHead(ur.statusCode ?? 502, out);
          return void ur.pipe(res);
        }
        const chunks = [];
        ur.on('data', (c) => chunks.push(c));
        ur.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const body = Buffer.from(withWatch(text) ?? text, 'utf8');
          if (req.method !== 'HEAD') out['content-length'] = String(body.length);
          res.writeHead(200, out);
          res.end(req.method === 'HEAD' ? undefined : body);
        });
      });
      up.on('error', () => {
        if (res.headersSent) return res.destroy();
        return page ? sendHold(req, res, 'closed') : refuse(res, 502, 'beta app unreachable');
      });
      return up;
    };
    if (!viewer) return void req.pipe(forward());
    // A viewer's sign-up: read the body whole, check its address, then send it on unchanged or refuse it here.
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= SIGN_UP_MAX_BYTES) chunks.push(c);
    });
    req.on('end', () => {
      if (size > SIGN_UP_MAX_BYTES) return refuse(res, 413, 'sign-up too large');
      const body = Buffer.concat(chunks);
      const refusal = signUpRefusal(body.toString('utf8'), viewer);
      if (!refusal) return void forward().end(body);
      send(res, 400, 'application/json; charset=utf-8', refusal);
    });
  });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    if (!APP_HOSTS.has(req.headers.host ?? ''))
      return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    const upSocket = net.connect(upstream, '127.0.0.1', () => {
      const headers = appRequestHeaders(req.headers, { upgrade: true, peer: req.socket.remoteAddress });
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) for (const one of [].concat(v)) lines.push(`${k}: ${one}`);
      upSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upSocket.write(head);
      // The stack's handshake answer and the frames after it pass through byte for byte.
      upSocket.pipe(socket).pipe(upSocket);
    });
    upSocket.on('error', () => socket.destroy());
    socket.on('close', () => upSocket.destroy());
  });
  return server;
}

const LOOPBACK_ORIGIN_RE = /http:\/\/(?:localhost|127\.0\.0\.1):6210/g;

function frontMail() {
  return http.createServer((req, res) => {
    if (!MAIL_HOSTS.has(req.headers.host ?? '')) return refuse(res, 403, 'forbidden host');
    const viewer = viewerFromAccess(req.headers);
    if (!viewer) return refuse(res, 403, 'sign in through the beta login first');
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (HOP.has(lk) || lk === 'cf-access-jwt-assertion' || lk === 'accept-encoding' || lk === VIEWER_HEADER) continue;
      headers[lk] = v;
    }
    headers.host = MAIL.upstreamHost;
    headers[VIEWER_HEADER] = viewer;
    if (headers.cookie !== undefined) {
      const c = withoutAccessCookie(headers.cookie);
      if (c) headers.cookie = c;
      else delete headers.cookie;
    }
    const up = http.request({ host: '127.0.0.1', port: MAIL.upstream, method: req.method, path: req.url, headers }, (ur) => {
      const out = responseHeaders(ur);
      const html = /^text\/html\b/i.test(String(ur.headers['content-type'] ?? '')) && !ur.headers['content-encoding'];
      if (!html) {
        res.writeHead(ur.statusCode ?? 502, out);
        return void ur.pipe(res);
      }
      const chunks = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('end', () => {
        const body = Buffer.from(Buffer.concat(chunks).toString('utf8').replace(LOOPBACK_ORIGIN_RE, PUBLIC_ORIGIN), 'utf8');
        out['content-length'] = String(body.length);
        res.writeHead(ur.statusCode ?? 502, out);
        res.end(req.method === 'HEAD' ? undefined : body);
      });
    });
    up.on('error', () => (res.headersSent ? res.destroy() : refuse(res, 502, 'mailbox unreachable')));
    req.pipe(up);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const app = frontApp();
  const mail = frontMail();
  for (const [s, name] of [
    [app, 'app'],
    [mail, 'mailbox'],
  ]) {
    s.on('error', (err) => {
      console.error(`front ${name}: ${err.message}`);
      process.exit(1);
    });
  }
  app.listen(APP.listen, '127.0.0.1', () => console.error(`front: app on 127.0.0.1:${APP.listen} -> ${APP.upstream}`));
  mail.listen(MAIL.listen, '127.0.0.1', () => console.error(`front: mailbox on 127.0.0.1:${MAIL.listen} -> ${MAIL.upstream}`));
}
