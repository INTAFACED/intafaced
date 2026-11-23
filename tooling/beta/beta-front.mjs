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
 * Only the public name and this front's own loopback names are served (DNS rebinding stays closed).
 */
import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

export const PUBLIC_ORIGIN = 'https://beta.intafaced.com';
export const MAIL_PUBLIC_HOST = 'beta-mail.intafaced.com';
const APP = { listen: 6211, upstream: 6210, upstreamHost: 'localhost:6210', upstreamOrigin: 'http://localhost:6210' };
const MAIL = { listen: 6291, upstream: 6290, upstreamHost: 'localhost:6290' };
const LOOPBACK_ORIGINS = ['http://localhost:6210', 'http://127.0.0.1:6210'];
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

const servedHosts = (publicHost, port) => new Set([publicHost, `localhost:${port}`, `127.0.0.1:${port}`]);
const APP_HOSTS = servedHosts(new URL(PUBLIC_ORIGIN).host, APP.listen);
const MAIL_HOSTS = servedHosts(MAIL_PUBLIC_HOST, MAIL.listen);

function withoutAccessCookie(cookie) {
  const kept = String(cookie)
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !/^CF_Authorization=/i.test(p));
  return kept.length ? kept.join('; ') : null;
}

/** Request headers for the app upstream. `upgrade` keeps Connection/Upgrade for a WebSocket handshake. */
export function appRequestHeaders(headers, { upgrade = false } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (!upgrade && HOP.has(lk)) continue;
    if (lk === 'cf-access-jwt-assertion') continue;
    out[lk] = v;
  }
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

function frontApp() {
  const server = http.createServer((req, res) => {
    if (!APP_HOSTS.has(req.headers.host ?? '')) return refuse(res, 403, 'forbidden host');
    const up = http.request(
      { host: '127.0.0.1', port: APP.upstream, method: req.method, path: req.url, headers: appRequestHeaders(req.headers) },
      (ur) => {
        res.writeHead(ur.statusCode ?? 502, responseHeaders(ur));
        ur.pipe(res);
      },
    );
    up.on('error', () => (res.headersSent ? res.destroy() : refuse(res, 502, 'beta app unreachable')));
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    if (!APP_HOSTS.has(req.headers.host ?? ''))
      return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    const upSocket = net.connect(APP.upstream, '127.0.0.1', () => {
      const headers = appRequestHeaders(req.headers, { upgrade: true });
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
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (HOP.has(lk) || lk === 'cf-access-jwt-assertion' || lk === 'accept-encoding') continue;
      headers[lk] = v;
    }
    headers.host = MAIL.upstreamHost;
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
