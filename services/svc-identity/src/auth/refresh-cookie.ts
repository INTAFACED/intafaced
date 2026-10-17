/**
 * Browser refresh cookie.
 *
 * The access token stays in page memory. The refresh token is this cookie and
 * is not readable from script. Name is `ifc_rt` (not `__Host-` or `__Secure-`):
 * those prefixes require `Secure` on every host, and localhost dev omits
 * `Secure`. Path is the identity auth prefix so the cookie is not attached to
 * trade, pay, or the WebSocket upgrade. The edge rewrites that path to the
 * public `/api/identity` prefix when it forwards `Set-Cookie`.
 *
 * Client contract (sovereign-70):
 * - Cookie: `ifc_rt`. HttpOnly; SameSite=Strict; Secure except localhost,
 *   127.0.0.1, and ::1; no Domain attribute.
 * - Identity path: `/trpc/auth.`. Browser path after the edge: `/api/identity/trpc/auth.`.
 * - Send it on `auth.login`, `auth.register`, `auth.registerFounder`,
 *   `webauthn.authVerify`, `auth.refresh`, and `auth.logout`.
 *   The cookie Path stays `/trpc/auth.` so a later refresh and logout
 *   receive it. Passkey verify is not under that path; the edge still
 *   forwards its Set-Cookie.
 * - `auth.refresh` and `auth.logout` read this cookie when the body omits
 *   `refreshToken`. A body `refreshToken` still wins (API and mobile).
 * - A request that sends `Origin` is a browser: the JSON omits `refreshToken`.
 *   A request with no `Origin` still receives `refreshToken` in the JSON.
 * - Refuse codes: `auth.session_invalid`, `auth.session_reused` (HTTP 401,
 *   `error.data.intafacedCode`). Edge CSRF: `edge.origin_not_allowed` (HTTP 403).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const REFRESH_COOKIE_NAME = 'ifc_rt';
/** Path on svc-identity. Matches `auth.*` procedures and nothing else. */
export const REFRESH_COOKIE_PATH = '/trpc/auth.';
/** Path the browser sees after svc-edge. */
export const PUBLIC_REFRESH_COOKIE_PATH = '/api/identity/trpc/auth.';

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
  setCookie: string | null;
  issue(token: string, maxAgeSeconds: number): void;
  clear(): void;
}

export const refreshCookieAls = new AsyncLocalStorage<RefreshCookieBag>();

export function refreshCookieSecure(host: string | undefined): boolean {
  const bare = (host ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const hostname = bare.split(':')[0] ?? '';
  return !LOCAL_HOSTS.has(hostname);
}

export function serializeRefreshCookie(token: string, options: { maxAgeSeconds: number; secure: boolean; path?: string }): string {
  const parts = [`${REFRESH_COOKIE_NAME}=${token}`, 'HttpOnly'];
  if (options.secure) parts.push('Secure');
  parts.push('SameSite=Strict', `Path=${options.path ?? REFRESH_COOKIE_PATH}`, `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  return parts.join('; ');
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
  return line.replaceAll(`Path=${REFRESH_COOKIE_PATH}`, `Path=${PUBLIC_REFRESH_COOKIE_PATH}`);
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
      bag.setCookie = serializeRefreshCookie(token, { maxAgeSeconds, secure });
    },
    clear() {
      bag.setCookie = serializeRefreshCookie('', { maxAgeSeconds: 0, secure });
    },
  };
  return bag;
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
