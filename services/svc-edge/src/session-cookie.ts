/**
 * COOKIE TRANSPORT FOR THE REFRESH TOKEN (customer app sign-in that survives a reload).
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 *
 * The customer app held both tokens in React state only, so a reload, a second tab or a
 * pop-out window started signed out. `docs/FRONTEND-REMAINING-SOT-2026-08-25.md` §12.2
 * accepted that "until an HttpOnly refresh-cookie design exists". This is that design.
 *
 * ── The shape ───────────────────────────────────────────────────────────────
 *
 *   · The refresh token lives in an HttpOnly, SameSite=Strict cookie that this edge sets. Page
 *     script can never read it, so an XSS cannot steal a 30-day credential. Never in
 *     localStorage. The access token stays in page memory (short-lived, 15 min).
 *   · Opt-in per request: a caller that sends `x-session-transport: cookie` to a sign-in
 *     procedure gets the cookie and a body WITHOUT `refreshToken`. Every other caller (mobile,
 *     API clients, apps/admin's server, tests) keeps the old body-token behaviour untouched.
 *   · Two virtual doors under the identity prefix, handled here and never proxied as-is:
 *       POST /api/identity/session/refresh  → cookie → auth.refresh → rotated cookie + new access token
 *       POST /api/identity/session/logout   → cookie → auth.logout  → cookie cleared
 *     The cookie is scoped to `/api/identity/session`, so the browser attaches it to those two
 *     requests and to nothing else. No other upstream ever sees it.
 *   · The refresh token is taken from the cookie ONLY. A request body, a bearer token or a query
 *     string cannot supply one, so a stolen access token cannot mint a new session.
 *   · CSRF: SameSite=Strict, plus a custom header (`x-session-request: 1`) a cross-site form or
 *     simple request cannot send, plus `Sec-Fetch-Site` must be same-origin when the browser
 *     states it. Cross-origin script would need a CORS preflight that `cors.ts` never grants for
 *     this header.
 *   · Rotation and reuse detection stay in svc-identity (`auth.refresh`): each refresh retires
 *     the old token, and a retired token presented again revokes every session of that user.
 *     The edge only carries the rotated token back into the cookie.
 *   · `Secure` is set on https, and always in staging/prod; plain http (the local stack on
 *     127.0.0.1) gets a non-Secure cookie because a browser would drop a Secure one there.
 *
 * Pure functions only: the proxy in `index.ts` calls `planSessionCookie` before the upstream
 * hop and `finishSessionCookie` after it. The booted entrypoint is tested end to end in
 * `session-cookie.e2e.test.ts`.
 */

export const REFRESH_COOKIE = 'intafaced_rt';
export const SESSION_COOKIE_PATH = '/api/identity/session';
/** Sent by the app on sign-in calls that want the refresh token moved into the cookie. */
export const TRANSPORT_HEADER = 'x-session-transport';
/** Sent by the app on refresh/logout. Not CORS-safelisted, not in `cors.ts`'s allowed list. */
export const SESSION_REQUEST_HEADER = 'x-session-request';

/** tRPC procedures whose answer carries a session (`sessionOutput` in svc-identity's router). */
const MINT_PATHS: ReadonlySet<string> = new Set(['/trpc/auth.login', '/trpc/auth.register', '/trpc/webauthn.authVerify']);

/** Opaque token the identity service generates (base64url). Anything else never reaches a header. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,512}$/;

type Headers = Record<string, string | string[] | undefined>;

export type SessionCookiePlan =
  | { readonly kind: 'none' }
  /** Sign-in answer: lift `refreshToken` out of the body into the cookie. */
  | { readonly kind: 'mint' }
  | { readonly kind: 'refresh'; readonly path: string; readonly body: string }
  | { readonly kind: 'logout'; readonly path: string; readonly body: string }
  /** Answered by the edge itself, no upstream call. */
  | {
      readonly kind: 'refuse';
      readonly status: number;
      readonly code: string;
      readonly message: string;
      readonly clearCookie: boolean;
      readonly ok?: boolean;
    };

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The refresh token from a `Cookie` request header, null when absent, or 'ambiguous' when named twice (never guess which one is ours). */
export function readRefreshCookie(cookieHeader: string | undefined): string | null | 'ambiguous' {
  if (!cookieHeader) return null;
  let found: string | null = null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== REFRESH_COOKIE) continue;
    if (found !== null) return 'ambiguous';
    found = part.slice(eq + 1).trim();
  }
  return found === '' ? null : found;
}

export interface PlanInput {
  readonly module: string;
  /** Upstream path with the prefix removed, e.g. `/session/refresh` or `/trpc/auth.login`. */
  readonly path: string;
  readonly method: string;
  readonly headers: Headers;
}

function refuse(status: number, code: string, message: string, clearCookie = false): SessionCookiePlan {
  return { kind: 'refuse', status, code, message, clearCookie };
}

export function planSessionCookie(input: PlanInput): SessionCookiePlan {
  if (input.module !== 'identity') return { kind: 'none' };

  if (input.path === '/session/refresh' || input.path === '/session/logout') {
    const action = input.path === '/session/refresh' ? 'refresh' : 'logout';
    if (input.method !== 'POST') return refuse(405, 'session.method_not_allowed', 'POST only');
    // Defence in depth on top of SameSite=Strict: a request the browser itself labels as
    // cross-site/same-site-but-not-same-origin never reaches the cookie.
    const site = header(input.headers, 'sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      return refuse(403, 'session.cross_site', 'Cross-site session request refused');
    }
    if (header(input.headers, SESSION_REQUEST_HEADER) !== '1') {
      return refuse(403, 'session.csrf_header_missing', 'Session request header missing');
    }
    const cookie = readRefreshCookie(header(input.headers, 'cookie'));
    if (cookie === 'ambiguous') return refuse(401, 'session.cookie_ambiguous', 'Session cookie is ambiguous', true);
    if (cookie === null) {
      // Logout with nothing to revoke is a success; refresh with nothing to refresh is "not signed in".
      return action === 'logout'
        ? { kind: 'refuse', status: 200, code: 'session.logged_out', message: 'ok', clearCookie: true, ok: true }
        : refuse(401, 'session.no_cookie', 'No session cookie');
    }
    if (!TOKEN_SHAPE.test(cookie)) return refuse(401, 'session.cookie_invalid', 'Session cookie is invalid', true);
    const body = JSON.stringify({ refreshToken: cookie });
    return action === 'refresh'
      ? { kind: 'refresh', path: '/trpc/auth.refresh', body }
      : { kind: 'logout', path: '/trpc/auth.logout', body };
  }

  if (input.method === 'POST' && MINT_PATHS.has(input.path) && header(input.headers, TRANSPORT_HEADER) === 'cookie') {
    return { kind: 'mint' };
  }
  return { kind: 'none' };
}

export interface CookieOptions {
  readonly secure: boolean;
  readonly maxAgeSeconds: number;
}

export function refreshCookieValue(token: string, options: CookieOptions): string {
  return `${REFRESH_COOKIE}=${token}; Path=${SESSION_COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.floor(options.maxAgeSeconds))}${options.secure ? '; Secure' : ''}`;
}

export function clearedCookieValue(options: Pick<CookieOptions, 'secure'>): string {
  return `${REFRESH_COOKIE}=; Path=${SESSION_COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=0${options.secure ? '; Secure' : ''}`;
}

/** Error envelope the app's api client already understands (`error.data.intafacedCode`). */
export function sessionRefusalBody(status: number, code: string, message: string): string {
  return JSON.stringify({
    error: {
      message,
      code: status === 401 ? -32001 : -32603,
      data: { code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', httpStatus: status, intafacedCode: code },
    },
  });
}

export interface Finished {
  readonly status: number;
  readonly body: string;
  /** Zero or one `Set-Cookie` values. */
  readonly setCookie: readonly string[];
}

/** tRPC single or batched envelope → the `data` objects that carry a refresh token. */
function sessionData(parsed: unknown): Array<Record<string, unknown>> {
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const out: Array<Record<string, unknown>> = [];
  for (const item of items) {
    const data = (item as { result?: { data?: unknown } } | null)?.result?.data;
    if (data && typeof data === 'object' && typeof (data as Record<string, unknown>).refreshToken === 'string') {
      out.push(data as Record<string, unknown>);
    }
  }
  return out;
}

/**
 * Turn the upstream answer into what the browser gets.
 *
 * Cookie rules, chosen so a hiccup never silently signs someone out and a dead session never lingers:
 *   · mint/refresh success  → set the (rotated) cookie, remove `refreshToken` from the body.
 *   · refresh 4xx           → clear the cookie (expired, revoked, or REUSE DETECTED: identity has
 *                             already revoked the family, a cookie for it is only a liability).
 *   · refresh 5xx / network → keep the cookie; the token is still valid, try again.
 *   · logout                → always clear the cookie, whatever identity answered; the status is
 *                             passed through so the app can tell if revocation was not confirmed.
 */
export function finishSessionCookie(
  plan: SessionCookiePlan,
  upstream: { readonly status: number; readonly text: string },
  options: CookieOptions,
): Finished {
  if (plan.kind === 'none') return { status: upstream.status, body: upstream.text, setCookie: [] };

  if (plan.kind === 'logout') {
    return { status: upstream.status, body: upstream.text, setCookie: [clearedCookieValue(options)] };
  }

  const failed = upstream.status < 200 || upstream.status >= 300;
  if (failed) {
    const clear = plan.kind === 'refresh' && upstream.status >= 400 && upstream.status < 500;
    return { status: upstream.status, body: upstream.text, setCookie: clear ? [clearedCookieValue(options)] : [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(upstream.text);
  } catch {
    return failClosed();
  }
  const rows = sessionData(parsed);
  // A sign-in that did not mint a session (e.g. a second factor is still required) has nothing to move.
  if (rows.length === 0) {
    return plan.kind === 'refresh' ? failClosed() : { status: upstream.status, body: upstream.text, setCookie: [] };
  }
  let token = '';
  for (const row of rows) {
    token = String(row.refreshToken);
    delete row.refreshToken;
  }
  if (!TOKEN_SHAPE.test(token)) return failClosed();
  return { status: upstream.status, body: JSON.stringify(parsed), setCookie: [refreshCookieValue(token, options)] };
}

/** An answer we cannot safely split: say so, leak nothing, leave the old cookie alone. */
function failClosed(): Finished {
  return {
    status: 502,
    body: sessionRefusalBody(502, 'session.unreadable_answer', 'Session answer could not be read'),
    setCookie: [],
  };
}

/** The edge's own answer for a `refuse` plan (no upstream call was made). */
export function answerRefusal(plan: Extract<SessionCookiePlan, { kind: 'refuse' }>, options: Pick<CookieOptions, 'secure'>): Finished {
  return {
    status: plan.status,
    body: plan.ok ? JSON.stringify({ result: { data: { ok: true } } }) : sessionRefusalBody(plan.status, plan.code, plan.message),
    setCookie: plan.clearCookie ? [clearedCookieValue(options)] : [],
  };
}

/** Secure on https, and always on hosted environments, where plain http can only be a misconfigured hop. */
export function cookieIsSecure(protocol: string, appEnv: string): boolean {
  return protocol === 'https' || appEnv === 'staging' || appEnv === 'prod';
}
