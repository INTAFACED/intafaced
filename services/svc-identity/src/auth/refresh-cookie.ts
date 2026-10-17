/**
 * Browser refresh cookie.
 *
 * The access token stays in page memory. The refresh token is also this
 * httpOnly cookie, which script cannot read. Name is `ifc_rt` (not `__Host-`
 * or `__Secure-`):
 * those prefixes require `Secure` on every host, and localhost dev omits
 * `Secure`. Each line has an exact Path, so the cookie is not attached to
 * trade, pay, or the WebSocket upgrade. The edge rewrites that path to the
 * public `/api/identity` prefix when it forwards `Set-Cookie`.
 *
 * Client contract (sovereign-70):
 * - Cookie: `ifc_rt`. HttpOnly; SameSite=Strict; Secure except localhost,
 *   127.0.0.1, and ::1; no Domain attribute.
 * - Two Set-Cookie lines, same value. Identity paths: `/trpc/auth.refresh`
 *   and `/trpc/auth.logout`. Browser paths after the edge:
 *   `/api/identity/trpc/auth.refresh` and `/api/identity/trpc/auth.logout`.
 *   A prefix such as `/trpc/auth.` does not match those URLs.
 * - Set on `auth.login`, `auth.register`, `auth.registerFounder`,
 *   `webauthn.authVerify`, `auth.refresh`, and `auth.logout`.
 *   Passkey verify is not under those paths; the edge still forwards
 *   its Set-Cookie. The browser sends the cookie back only on refresh
 *   and logout.
 * - `auth.refresh` and `auth.logout` read this cookie when the body omits
 *   `refreshToken`. A body `refreshToken` still wins (API and mobile).
 * - The JSON always includes `refreshToken`, including when the request
 *   sends `Origin`. The customer app requires the field. Hiding it from the
 *   page is a later change that must land with, or after, that app change.
 *   The cookie is still set either way.
 * - Refuse codes: `auth.session_invalid`, `auth.session_reused` (HTTP 401,
 *   `error.data.intafacedCode`). Edge CSRF: `edge.origin_not_allowed` (HTTP 403).
 */
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';

export const REFRESH_COOKIE_NAME = 'ifc_rt';
/**
 * Exact paths on svc-identity. A prefix such as `/trpc/auth.` does not
 * match `/trpc/auth.refresh` under the cookie path algorithm.
 */
export const REFRESH_COOKIE_PATHS = ['/trpc/auth.refresh', '/trpc/auth.logout'] as const;
/** Paths the browser sees after svc-edge. */
export const PUBLIC_REFRESH_COOKIE_PATHS = ['/api/identity/trpc/auth.refresh', '/api/identity/trpc/auth.logout'] as const;

/**
 * Two tabs reloading together present one cookie. Ten seconds covers that
 * race and one slow retry. Longer than that is a stolen-token window.
 * `0` keeps the old immediate reuse burn. Ceiling is two minutes.
 */
export const DEFAULT_REFRESH_REUSE_GRACE_SECONDS = 10;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface RefreshCookieBag {
  readonly presented: string | null;
  /** True when the request carried an Origin header (a browser). */
  readonly browser: boolean;
  readonly secure: boolean;
  setCookie: string[] | null;
  issue(token: string, maxAgeSeconds: number): void;
  clear(): void;
}

export function refreshCookieSecure(host: string | undefined): boolean {
  const bare = (host ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const hostname = bare.split(':')[0] ?? '';
  return !LOCAL_HOSTS.has(hostname);
}

export function serializeRefreshCookie(token: string, options: { maxAgeSeconds: number; secure: boolean; path: string }): string {
  const parts = [`${REFRESH_COOKIE_NAME}=${token}`, 'HttpOnly'];
  if (options.secure) parts.push('Secure');
  parts.push('SameSite=Strict', `Path=${options.path}`, `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  return parts.join('; ');
}

export function refreshCookieLines(token: string, options: { maxAgeSeconds: number; secure: boolean }): string[] {
  return REFRESH_COOKIE_PATHS.map((path) => serializeRefreshCookie(token, { ...options, path }));
}

/**
 * RFC 6265 path-match. The cookie is sent only when the paths are identical,
 * or the cookie path is a directory prefix (it ends in `/`, or the next
 * request character is `/`).
 */
export function cookiePathMatches(cookiePath: string, requestPath: string): boolean {
  const req = requestPath.split('?')[0] ?? '';
  if (cookiePath === req) return true;
  if (cookiePath.endsWith('/') && req.startsWith(cookiePath)) return true;
  return req.startsWith(cookiePath) && req[cookiePath.length] === '/';
}

export function readRefreshCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== REFRESH_COOKIE_NAME) continue;
    const value = trimmed.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

export function rewriteRefreshCookiePath(line: string): string {
  let out = line;
  for (let i = 0; i < REFRESH_COOKIE_PATHS.length; i++) {
    out = out.replaceAll(`Path=${REFRESH_COOKIE_PATHS[i]}`, `Path=${PUBLIC_REFRESH_COOKIE_PATHS[i]}`);
  }
  return out;
}

export function isRefreshCookieRoute(pathname: string): boolean {
  const path = pathname.split('?')[0] ?? '';
  return path.includes('/trpc/auth.');
}

function headerOne(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function openRefreshCookieBag(headers: {
  host?: string | string[] | undefined;
  origin?: string | string[] | undefined;
  cookie?: string | string[] | undefined;
}): RefreshCookieBag {
  const host = headerOne(headers.host);
  const origin = headerOne(headers.origin);
  const secure = refreshCookieSecure(host);
  const bag: RefreshCookieBag = {
    presented: readRefreshCookie(headerOne(headers.cookie)),
    browser: origin !== undefined,
    secure,
    setCookie: null,
    issue(token, maxAgeSeconds) {
      bag.setCookie = refreshCookieLines(token, { maxAgeSeconds, secure });
    },
    clear() {
      bag.setCookie = refreshCookieLines('', { maxAgeSeconds: 0, secure });
    },
  };
  return bag;
}

/**
 * Registers the cookie hooks and returns the per-request lookup.
 *
 * The bag lives on the request, then on the tRPC context. An ambient store
 * does not survive Fastify's POST body parsing the same way on Node 22
 * (the production image) and Node 26 (this machine). index.ts and the
 * acceptance test both call this, so the test does not keep a second copy
 * of the hooks.
 */
export function installRefreshCookieHooks(app: FastifyInstance): (req: object) => RefreshCookieBag | undefined {
  const bags = new WeakMap<object, RefreshCookieBag>();
  app.addHook('onRequest', (req, _reply, done) => {
    // A refresh with no body has no Content-Type. Fastify refuses that with 415
    // before the procedure can say the session is missing.
    const path = req.url.split('?')[0] ?? '';
    if (req.method === 'POST' && path.endsWith('/auth.refresh') && req.headers['content-type'] === undefined) {
      req.headers['content-type'] = 'application/json';
    }
    bags.set(req, openRefreshCookieBag(req.headers));
    done();
  });
  app.addHook('preParsing', (req, _reply, payload, done) => {
    const path = req.url.split('?')[0] ?? '';
    if (req.method === 'POST' && path.endsWith('/auth.refresh') && req.headers['content-length'] === '0') {
      req.headers['content-length'] = String(Buffer.byteLength('{}'));
      done(null, Readable.from(['{}']));
      return;
    }
    done(null, payload);
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const lines = bags.get(req)?.setCookie;
    if (lines) {
      for (const line of lines) reply.header('set-cookie', line);
    }
    return payload;
  });
  return (req) => bags.get(req);
}

/**
 * True when `Origin` is the same origin as the `Host` the browser called.
 * Port is part of the match: `localhost:9999` is not `localhost:4000`.
 */
export function originMatchesRequestHost(origin: string, hostHeader: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return hostHeader.trim().toLowerCase() === url.host;
}
