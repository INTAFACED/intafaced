/**
 * Set-Cookie and Cookie for the refresh cookie.
 *
 * Set-Cookie is copied on identity auth procedures and on passkey verify
 * (`webauthn.authVerify`). Each Path is rewritten from the identity path
 * (`/trpc/auth.refresh` or `/trpc/auth.logout`) to the public path
 * (`/api/identity/trpc/auth.refresh` or `/api/identity/trpc/auth.logout`).
 * The Cookie request header is forwarded only on the auth procedures,
 * which are the ones that read it.
 *
 * A state-changing auth request that presents `ifc_rt` must show either an
 * Origin on the customer allowlist or `x-session-request: 1`. Missing both
 * is `auth.csrf_origin_required` and the edge returns 403 before the
 * upstream runs, so the refresh token is not rotated and the session is
 * not revoked. An Origin that is not on the allowlist is
 * `edge.origin_not_allowed`. An empty allowlist matches no Origin
 * (fail closed). SameSite=Strict already blocks cross-site browsers.
 */

const REFRESH_COOKIE_NAME = 'ifc_rt';
const REFRESH_COOKIE_PATHS = ['/trpc/auth.refresh', '/trpc/auth.logout'] as const;
const PUBLIC_REFRESH_COOKIE_PATHS = ['/api/identity/trpc/auth.refresh', '/api/identity/trpc/auth.logout'] as const;
/** The public status badge: svc-notify sets its cache life from the reading's age, so the edge passes it on. */
const STATUS_BADGE_PATH = '/api/notify/status/badge.svg';

function headerOne(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isRefreshCookieRoute(pathname: string): boolean {
  const path = pathname.split('?')[0] ?? '';
  return path.includes('/trpc/auth.');
}

/** Login, register, refresh, logout, and passkey verify all set the cookie. */
function issuesRefreshCookie(pathname: string): boolean {
  const path = pathname.split('?')[0] ?? '';
  return isRefreshCookieRoute(path) || path.includes('/trpc/webauthn.authVerify');
}

function readRefreshCookie(header: string | undefined): string | null {
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

export function setCookieLines(headers: { getSetCookie?: () => string[]; get(name: string): string | null }): string[] {
  if (typeof headers.getSetCookie === 'function') {
    const lines = headers.getSetCookie().filter((line) => line.length > 0);
    if (lines.length > 0) return lines;
  }
  const one = headers.get('set-cookie');
  return one ? [one] : [];
}

export function forwardUpstreamResponseHeaders(
  pathname: string,
  upstream: { getSetCookie?: () => string[]; get(name: string): string | null },
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {
    'content-type': upstream.get('content-type') ?? 'application/json',
  };
  if (pathname === STATUS_BADGE_PATH) {
    const cacheControl = upstream.get('cache-control');
    if (cacheControl !== null) out['cache-control'] = cacheControl;
  }
  if (!issuesRefreshCookie(pathname)) return out;
  const lines = setCookieLines(upstream).map(rewriteRefreshCookiePath);
  if (lines.length === 1) out['set-cookie'] = lines[0]!;
  else if (lines.length > 1) out['set-cookie'] = lines;
  return out;
}

export function prepareUpstreamRequestHeaders(pathname: string, headers: Record<string, string>): Record<string, string> {
  if (isRefreshCookieRoute(pathname) || !('cookie' in headers)) return headers;
  const next = { ...headers };
  delete next.cookie;
  return next;
}

function sessionRequestHeader(headers: { [key: string]: string | string[] | undefined }): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'x-session-request') return headerOne(value);
  }
  return undefined;
}

export function refuseCookieCsrf(input: {
  method: string;
  pathname: string;
  headers: { [key: string]: string | string[] | undefined };
  allowedOrigins: readonly string[];
}): { code: 'auth.csrf_origin_required' | 'edge.origin_not_allowed' } | null {
  const method = input.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  if (!isRefreshCookieRoute(input.pathname)) return null;
  if (!readRefreshCookie(headerOne(input.headers.cookie))) return null;
  if (sessionRequestHeader(input.headers) === '1') return null;
  const origin = headerOne(input.headers.origin) ?? null;
  if (origin !== null && input.allowedOrigins.includes(origin)) return null;
  if (origin === null) return { code: 'auth.csrf_origin_required' };
  return { code: 'edge.origin_not_allowed' };
}
