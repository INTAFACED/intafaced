import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * THE SHIPPED ENTRYPOINT, BOOTED, MOVES THE REFRESH TOKEN INTO AN HttpOnly COOKIE.
 *
 * Boots the real `index.ts` (same approach as local-test-fixture-boot.e2e.test.ts) in front of a
 * stand-in svc-identity, and drives it over a real socket with a small cookie jar that obeys
 * Path and Max-Age the way a browser does.
 *
 * The stand-in implements the contract the edge relies on from `auth.refresh`: each refresh retires
 * the token it was given, and presenting a retired token revokes the whole family and answers 401.
 * That rule itself is svc-identity's and is tested there (identity.test.ts, "reuse"); what this file
 * proves is that the EDGE carries it correctly: rotated token into the cookie, dead session out of it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(HERE, 'index.ts');
const COOKIE = 'intafaced_rt';
const USER = '11111111-1111-4111-8111-111111111111';

interface Seen {
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function newToken(): string {
  return randomBytes(36).toString('base64url');
}

/** Stand-in svc-identity. `down` makes every call answer 503. */
function fakeIdentity() {
  const live = new Map<string, string>(); // refresh token -> family
  const retired = new Map<string, string>();
  const revokedFamilies = new Set<string>();
  const seen: Seen[] = [];
  const state = { down: false };

  const session = (family: string) => {
    const refreshToken = newToken();
    live.set(refreshToken, family);
    return { accessToken: `access.${newToken()}.sig`, refreshToken, expiresAt: new Date(Date.now() + 900_000).toISOString(), userId: USER };
  };
  const ok = (data: unknown) => ({ status: 200, body: { result: { data } } });
  const unauthorized = (code: string) => ({
    status: 401,
    body: { error: { message: code, code: -32001, data: { code: 'UNAUTHORIZED', httpStatus: 401, intafacedCode: code } } },
  });

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      seen.push({ url: req.url ?? '', headers: req.headers, body: text });
      let out: { status: number; body: unknown };
      if (state.down) out = { status: 503, body: { error: 'down' } };
      else if (req.url?.startsWith('/trpc/auth.login') || req.url?.startsWith('/trpc/webauthn.authVerify')) out = ok(session(newToken()));
      else if (req.url?.startsWith('/trpc/auth.refresh')) {
        const { refreshToken } = JSON.parse(text) as { refreshToken: string };
        if (retired.has(refreshToken)) {
          revokedFamilies.add(retired.get(refreshToken) as string);
          out = unauthorized('auth.session_reused');
        } else if (!live.has(refreshToken) || revokedFamilies.has(live.get(refreshToken) as string))
          out = unauthorized('auth.session_invalid');
        else {
          const family = live.get(refreshToken) as string;
          live.delete(refreshToken);
          retired.set(refreshToken, family);
          out = ok(session(family));
        }
      } else if (req.url?.startsWith('/trpc/auth.logout')) {
        const { refreshToken } = JSON.parse(text) as { refreshToken: string };
        const family = live.get(refreshToken);
        if (family) revokedFamilies.add(family);
        out = ok({ ok: true });
      } else out = { status: 404, body: { error: 'nope' } };
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  return { server, seen, state, revokedFamilies };
}

/** Just enough of a browser cookie jar for one origin: honours Path and Max-Age=0. */
class Jar {
  private value: string | null = null;
  private path = '';
  attachTo(url: string, headers: Record<string, string>) {
    if (this.value !== null && new URL(url).pathname.startsWith(this.path)) headers.cookie = `${COOKIE}=${this.value}`;
  }
  store(setCookie: string[]) {
    for (const line of setCookie) {
      const [pair = '', ...attrs] = line.split(';').map((p) => p.trim());
      const [, value = ''] = pair.split('=');
      const maxAge = attrs.find((a) => a.toLowerCase().startsWith('max-age='));
      this.path = attrs.find((a) => a.toLowerCase().startsWith('path='))?.slice(5) ?? '/';
      this.value = maxAge === 'Max-Age=0' || value === '' ? null : value;
    }
  }
  get token() {
    return this.value;
  }
  set token(v: string | null) {
    this.value = v;
    this.path = '/api/identity/session';
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const identity = fakeIdentity();
let edge: ChildProcess | undefined;
let base = '';
let output = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => identity.server.listen(0, '127.0.0.1', resolve));
  const identityUrl = `http://127.0.0.1:${(identity.server.address() as AddressInfo).port}`;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  edge = spawn(process.execPath, ['--import', 'tsx', ENTRYPOINT], {
    cwd: join(HERE, '..'),
    env: {
      PATH: process.env.PATH ?? '',
      APP_ENV: 'test',
      SERVICE_NAME: 'svc-edge',
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: String(port),
      LOG_LEVEL: 'fatal',
      OTEL_ENABLED: 'false',
      JWT_ACCESS_SECRET: 'j'.repeat(48),
      EDGE_PRINCIPAL_SECRET: 'e'.repeat(48),
      EDGE_RATE_LIMIT_MAX: '1000',
      EDGE_RATE_LIMIT_WINDOW_MS: '60000',
      EDGE_BODY_LIMIT_BYTES: '1048576',
      EDGE_KILL_STATE_PATH: '',
      IDENTITY_URL: identityUrl,
      // A listed test fixture that does not name DE: the geo door passes /api instead of refusing on unset screening.
      INTAFACED_SANCTIONS_REGIONS: 'AA:test-fixture-not-a-real-list',
      DEFAULT_REGION: 'DE',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  edge.stdout?.on('data', (d: Buffer) => (output += d.toString()));
  edge.stderr?.on('data', (d: Buffer) => (output += d.toString()));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && edge.exitCode === null) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`svc-edge did not start:\n${output}`);
}, 90_000);

afterAll(async () => {
  edge?.kill();
  await new Promise<void>((resolve) => identity.server.close(() => resolve()));
});

interface Answer {
  status: number;
  json: any;
  text: string;
  setCookie: string[];
}

async function call(path: string, init: { headers?: Record<string, string>; body?: unknown; method?: string; jar?: Jar }): Promise<Answer> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...init.headers };
  init.jar?.attachTo(`${base}${path}`, headers);
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'POST',
    headers,
    ...((init.method ?? 'POST') === 'GET' ? {} : { body: JSON.stringify(init.body ?? {}) }),
  });
  const text = await res.text();
  const setCookie = res.headers.getSetCookie();
  init.jar?.store(setCookie);
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, setCookie };
}

const LOGIN = '/api/identity/trpc/auth.login';
const REFRESH = '/api/identity/session/refresh';
const LOGOUT = '/api/identity/session/logout';
const asApp = { 'x-session-request': '1', 'sec-fetch-site': 'same-origin' };
const withCookie = { 'x-session-transport': 'cookie' };
const refreshCalls = () => identity.seen.filter((s) => s.url.startsWith('/trpc/auth.refresh'));

describe('sign-in through the edge, cookie transport', () => {
  it('sets an HttpOnly, SameSite=Strict, path-scoped cookie and keeps the refresh token out of the body (http: no Secure)', async () => {
    const jar = new Jar();
    const r = await call(LOGIN, { headers: withCookie, body: { identifier: 'a', password: 'b' }, jar });
    expect(r.status).toBe(200);
    expect(r.json.result.data.refreshToken).toBeUndefined();
    expect(r.json.result.data.accessToken).toMatch(/^access\./);
    expect(r.setCookie).toHaveLength(1);
    const cookie = r.setCookie[0] as string;
    expect(cookie).toMatch(new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{16,}; Path=/api/identity/session; `));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toMatch(/Max-Age=\d+/);
    expect(cookie).not.toContain('Secure');
    expect(r.text).not.toContain(cookie.split('=')[1]?.split(';')[0] as string);
    // Scoped to the session path: the browser would send it to the refresh door and nowhere else.
    expect(jar.token).not.toBeNull();
    const other: Record<string, string> = {};
    jar.attachTo(`${base}/api/trade/trpc/orders.list`, other);
    expect(other.cookie).toBeUndefined();
  });

  it('passkey sign-in (webauthn.authVerify) uses the same transport', async () => {
    const jar = new Jar();
    const r = await call('/api/identity/trpc/webauthn.authVerify', { headers: withCookie, body: {}, jar });
    expect(r.status).toBe(200);
    expect(r.json.result.data.refreshToken).toBeUndefined();
    expect(jar.token).not.toBeNull();
    expect((await call(REFRESH, { headers: asApp, jar })).status).toBe(200);
  });

  it('without the opt-in header every other caller still gets the refresh token in the body', async () => {
    const r = await call(LOGIN, { body: { identifier: 'a', password: 'b' } });
    expect(r.json.result.data.refreshToken).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(r.setCookie).toEqual([]);
  });
});

describe('reload keeps you signed in', () => {
  it('a fresh page with only the cookie gets a new access token and a rotated cookie', async () => {
    const jar = new Jar();
    await call(LOGIN, { headers: withCookie, body: {}, jar });
    const before = jar.token;
    // "Reload": the page has nothing in memory; the browser still has the cookie.
    const r = await call(REFRESH, { headers: asApp, jar });
    expect(r.status).toBe(200);
    expect(r.json.result.data).toMatchObject({ userId: USER });
    expect(r.json.result.data.accessToken).toMatch(/^access\./);
    expect(r.json.result.data.refreshToken).toBeUndefined();
    expect(jar.token).not.toBeNull();
    expect(jar.token).not.toBe(before);
    // Again, after another reload: still signed in.
    expect((await call(REFRESH, { headers: asApp, jar })).status).toBe(200);
  });

  it('never hands the cookie to the upstream: identity is called with the token in a body only', async () => {
    const jar = new Jar();
    await call(LOGIN, { headers: withCookie, body: {}, jar });
    const token = jar.token as string;
    identity.seen.length = 0;
    await call(REFRESH, { headers: asApp, jar });
    const hop = refreshCalls()[0] as Seen;
    expect(hop.headers.cookie).toBeUndefined();
    expect(JSON.parse(hop.body)).toEqual({ refreshToken: token });
  });
});

describe('a stolen access token cannot refresh', () => {
  it('bearer token alone, or a body that names a refresh token, is refused without calling identity', async () => {
    const jar = new Jar();
    const login = await call(LOGIN, { headers: withCookie, body: {}, jar });
    const access = login.json.result.data.accessToken as string;
    const victimToken = jar.token as string;
    identity.seen.length = 0;
    // The attacker has the access token (and even a leaked refresh token string) but not the victim's cookie jar.
    const attacker = new Jar();
    const r1 = await call(REFRESH, { headers: { ...asApp, authorization: `Bearer ${access}` }, jar: attacker });
    expect(r1.status).toBe(401);
    expect(r1.json.error.data.intafacedCode).toBe('session.no_cookie');
    const r2 = await call(REFRESH, { headers: asApp, body: { refreshToken: victimToken }, jar: attacker });
    expect(r2.status).toBe(401);
    expect(refreshCalls()).toHaveLength(0);
  });
});

describe('CSRF', () => {
  it('refuses a refresh without the custom header, or one the browser marks cross-site', async () => {
    const jar = new Jar();
    await call(LOGIN, { headers: withCookie, body: {}, jar });
    identity.seen.length = 0;
    expect((await call(REFRESH, { headers: { 'sec-fetch-site': 'same-origin' }, jar })).status).toBe(403);
    expect((await call(REFRESH, { headers: { 'x-session-request': '1', 'sec-fetch-site': 'cross-site' }, jar })).status).toBe(403);
    expect((await call(REFRESH, { headers: asApp, jar, method: 'GET' })).status).toBe(405);
    expect(refreshCalls()).toHaveLength(0);
  });
});

describe('rotation reuse is detected', () => {
  it('replaying a retired cookie is refused, clears the cookie, and the family is dead afterwards', async () => {
    const jar = new Jar();
    await call(LOGIN, { headers: withCookie, body: {}, jar });
    const stale = jar.token as string;
    expect((await call(REFRESH, { headers: asApp, jar })).status).toBe(200);
    const fresh = jar.token as string;
    // A thief replays the old cookie from another browser.
    const thief = new Jar();
    thief.token = stale;
    const replay = await call(REFRESH, { headers: asApp, jar: thief });
    expect(replay.status).toBe(401);
    expect(replay.json.error.data.intafacedCode).toBe('auth.session_reused');
    expect(replay.setCookie[0]).toContain('Max-Age=0');
    expect(thief.token).toBeNull();
    // Identity revoked the whole family, so the victim's rotated cookie no longer works either and is cleared.
    jar.token = fresh;
    const victim = await call(REFRESH, { headers: asApp, jar });
    expect(victim.status).toBe(401);
    expect(jar.token).toBeNull();
  });
});

describe('logout', () => {
  it('revokes the session upstream and clears the cookie; the old cookie is worthless afterwards', async () => {
    const jar = new Jar();
    await call(LOGIN, { headers: withCookie, body: {}, jar });
    const token = jar.token as string;
    identity.seen.length = 0;
    const out = await call(LOGOUT, { headers: asApp, jar });
    expect(out.status).toBe(200);
    expect(out.json).toEqual({ result: { data: { ok: true } } });
    expect(out.setCookie[0]).toContain('Max-Age=0');
    expect(jar.token).toBeNull();
    expect(JSON.parse((identity.seen.find((s) => s.url.startsWith('/trpc/auth.logout')) as Seen).body)).toEqual({ refreshToken: token });
    const thief = new Jar();
    thief.token = token;
    expect((await call(REFRESH, { headers: asApp, jar: thief })).status).toBe(401);
  });

  it('logging out with no cookie is a success and calls nothing', async () => {
    identity.seen.length = 0;
    const out = await call(LOGOUT, { headers: asApp, jar: new Jar() });
    expect(out.status).toBe(200);
    expect(identity.seen).toHaveLength(0);
  });
});

describe('an identity outage does not sign anyone out', () => {
  it('keeps the cookie on a 5xx so the next try can succeed', async () => {
    const jar = new Jar();
    await call(LOGIN, { headers: withCookie, body: {}, jar });
    const token = jar.token;
    identity.state.down = true;
    try {
      const r = await call(REFRESH, { headers: asApp, jar });
      expect(r.status).toBe(503);
      expect(r.setCookie).toEqual([]);
      expect(jar.token).toBe(token);
    } finally {
      identity.state.down = false;
    }
    expect((await call(REFRESH, { headers: asApp, jar })).status).toBe(200);
  });
});
