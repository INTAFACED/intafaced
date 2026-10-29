import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerKillSwitchGuard } from './control-plane.js';
import {
  ALLOWED_METHODS,
  ALLOWED_ORIGINS_ENV,
  ALLOWED_REQUEST_HEADERS,
  CORS_ENFORCED_ENVS,
  DEV_ORIGINS,
  edgeOriginAllowlist,
  isCorsSurface,
  OriginListError,
  parseOriginList,
  PREFLIGHT_MAX_AGE_SECONDS,
  registerCors,
  type OriginAllowlist,
} from './cors.js';
import { KillSwitchState } from './kill-switch.js';

/**
 * THE DOOR, OPENED FOR EXACTLY WHO WE MEANT.
 *
 * ── Why these assertions and not "the header is present" ────────────────────
 *
 * A CORS test that only checks the happy path certifies the half of the
 * behaviour that was never at risk. The failures worth catching are the ones
 * that still return 200:
 *
 *   · a refused origin answered with a PERMISSIVE header instead of none,
 *   · `*` emitted anywhere, which the spec forbids alongside credentials and
 *     which would make the allowlist decorative,
 *   · `Access-Control-Allow-Credentials` beside a wildcard, or on an origin
 *     that is not on the allowlist,
 *   · a preflight that reaches the proxy, which is an unauthenticated request
 *     touching upstreams,
 *   · a preflight whose answer varies by path, which is the route table read out
 *     to anyone who can open a socket.
 *
 * So the HTTP half runs `registerCors` and `registerKillSwitchGuard` — the same
 * two functions `index.ts` calls, in the same order — against a stub that records
 * every request that got past them. A refusal is only proven if the thing behind
 * the door can say it never heard anyone knock.
 *
 * `app.inject()` is Fastify's own request pipeline, so hooks, ordering and header
 * handling are the real ones. It is not a browser and does not pretend to be:
 * browser ENFORCEMENT of these headers is verified separately by
 * `cors.browser.e2e.test.ts`, which drives real Chromium against a real socket.
 * An earlier audit in this repo found a test that intercepted nothing because it
 * mocked the wrong layer; these two files are split so that neither can be
 * mistaken for the other's guarantee.
 */

const APP = 'https://app.example.com';
const OTHER = 'https://www.example.com';
const EVIL = 'https://evil.example.net';

const allowlistOf = (...origins: string[]): OriginAllowlist => ({
  origins,
  configured: true,
  source: 'test',
  summary: 'test',
});

interface Harness {
  app: FastifyInstance;
  /** Every request that got past the hooks. Empty means nothing got through. */
  reached: string[];
}

let harness: Harness | null = null;

async function edge(allowlist: OriginAllowlist = allowlistOf(APP, OTHER)): Promise<Harness> {
  const app = Fastify({ logger: false });
  const reached: string[] = [];

  // THE SAME TWO CALLS `index.ts` MAKES, in the same order. If the order is ever
  // swapped there, the 503 assertions below stop passing here.
  registerCors(app, allowlist);
  registerKillSwitchGuard(app, new KillSwitchState());

  app.get('/health', async () => ({ ok: true }));
  app.get('/ready', async () => ({ ready: true }));
  app.get('/admin/kill-switches', async () => ({ disabledModules: [] }));

  // The far side of the perimeter. Anything recorded here crossed the hooks.
  app.all('/api/*', async (req) => {
    reached.push(`${req.method} ${req.url}`);
    return { ok: true };
  });

  await app.ready();
  harness = { app, reached };
  return harness;
}

afterEach(async () => {
  await harness?.app.close();
  harness = null;
});

const preflight = (app: FastifyInstance, url: string, origin?: string) =>
  app.inject({
    method: 'OPTIONS',
    url,
    headers: {
      ...(origin ? { origin } : {}),
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });

// ─────────────────────────────────────────────────────────────────────────────
// Parsing — a list that does not say what its author meant is a boot failure.
// ─────────────────────────────────────────────────────────────────────────────

describe('parseOriginList', () => {
  it('returns nothing for an absent or empty value', () => {
    expect(parseOriginList(undefined)).toEqual([]);
    expect(parseOriginList('')).toEqual([]);
    expect(parseOriginList('   ')).toEqual([]);
    expect(parseOriginList(' , , ')).toEqual([]);
  });

  it('accepts a comma-separated list, tolerating whitespace', () => {
    expect(parseOriginList(` ${APP} , ${OTHER} `)).toEqual([APP, OTHER]);
  });

  it('accepts http on a loopback port, which is what dev is', () => {
    expect(parseOriginList('http://localhost:3000')).toEqual(['http://localhost:3000']);
  });

  it('normalises case, because a browser sends a lower-cased origin', () => {
    expect(parseOriginList('HTTPS://APP.EXAMPLE.COM')).toEqual([APP]);
  });

  it('REFUSES a bare wildcard rather than skipping it', () => {
    // The vendored CorsAllowlist.java skips `*` silently. Skipping means the
    // operator who wrote it is served a list that differs from what they wrote.
    expect(() => parseOriginList('*')).toThrow(OriginListError);
    expect(() => parseOriginList(`${APP},*`)).toThrow(/wildcard is not an allowlist/);
  });

  it('refuses the opaque origin `null`', () => {
    expect(() => parseOriginList('null')).toThrow(/opaque origin/);
  });

  it('refuses a trailing slash, and says what the browser will actually send', () => {
    expect(() => parseOriginList(`${APP}/`)).toThrow(new RegExp(`A browser sends "${APP}"`));
  });

  it('refuses a path, which would never match anything', () => {
    expect(() => parseOriginList(`${APP}/app`)).toThrow(/not an origin/);
  });

  it('refuses userinfo smuggled into the authority', () => {
    expect(() => parseOriginList('https://evil@app.example.com')).toThrow(/not an origin/);
  });

  it('refuses an explicit default port, which a browser omits', () => {
    expect(() => parseOriginList('http://app.example.com:80')).toThrow(/A browser sends "http:\/\/app.example.com"/);
  });

  it('refuses a non-http scheme', () => {
    expect(() => parseOriginList('ws://app.example.com')).toThrow(/scheme must be http or https/);
    expect(() => parseOriginList('file://')).toThrow();
  });

  it('refuses something that is not a URL at all', () => {
    expect(() => parseOriginList('app.example.com')).toThrow(/not a URL/);
  });

  it('refuses a duplicate, so there is one line to delete when an origin is revoked', () => {
    expect(() => parseOriginList(`${APP},${APP}`)).toThrow(/listed more than once/);
  });

  it('reports every problem at once, so a bad list is fixed in one pass', () => {
    try {
      parseOriginList(`*,app.example.com,${APP}/`);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OriginListError);
      expect((err as OriginListError).issues).toHaveLength(3);
    }
  });

  it('names the variable an operator has to fix', () => {
    expect(() => parseOriginList('*')).toThrow(new RegExp(ALLOWED_ORIGINS_ENV));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Posture — dev frictionless, staging/prod explicit.
// ─────────────────────────────────────────────────────────────────────────────

describe('edgeOriginAllowlist — posture', () => {
  it('dev with nothing configured falls back to our own front-end ports', () => {
    const list = edgeOriginAllowlist({ APP_ENV: 'dev' });
    expect(list.origins).toEqual(DEV_ORIGINS);
    // NOT `configured`. A default is not a decision, and `/ready` must be able
    // to tell an operator which one they are looking at.
    expect(list.configured).toBe(false);
    expect(list.source).toBe('dev-default');
  });

  it('defaults to dev when APP_ENV is unset, rather than shutting every local run', () => {
    expect(edgeOriginAllowlist({}).origins).toEqual(DEV_ORIGINS);
  });

  it('test is not an enforced posture — a unit test needs no origin list', () => {
    expect(edgeOriginAllowlist({ APP_ENV: 'test' }).origins).toEqual(DEV_ORIGINS);
  });

  it.each(CORS_ENFORCED_ENVS)('%s with nothing configured is a CLOSED DOOR, not a boot failure', (appEnv) => {
    // The deliberate decision, argued in cors.ts: unconfigured here is silently
    // RESTRICTIVE and loud in the caller's console, unlike an unconfigured
    // sanctions list which is silently permissive and dishonest. Refusing to
    // boot would take down every server-to-server caller to fix a browser-only
    // problem none of them have.
    const list = edgeOriginAllowlist({ APP_ENV: appEnv });
    expect(list.origins).toEqual([]);
    expect(list.configured).toBe(false);
    expect(list.summary).toMatch(/NO browser origin can call this edge/);
    expect(list.summary).toMatch(/closed door, not a boot failure/);
  });

  it.each(CORS_ENFORCED_ENVS)('%s never inherits the development default', (appEnv) => {
    const list = edgeOriginAllowlist({ APP_ENV: appEnv });
    for (const dev of DEV_ORIGINS) expect(list.origins).not.toContain(dev);
  });

  it.each(CORS_ENFORCED_ENVS)('%s with a configured list uses exactly that list', (appEnv) => {
    const list = edgeOriginAllowlist({ APP_ENV: appEnv, [ALLOWED_ORIGINS_ENV]: `${APP},${OTHER}` });
    expect(list.origins).toEqual([APP, OTHER]);
    expect(list.configured).toBe(true);
    expect(list.source).toBe(`env:${ALLOWED_ORIGINS_ENV}`);
  });

  it('a configured list in dev replaces the default rather than adding to it', () => {
    const list = edgeOriginAllowlist({ APP_ENV: 'dev', [ALLOWED_ORIGINS_ENV]: APP });
    expect(list.origins).toEqual([APP]);
    expect(list.origins).not.toContain('http://localhost:3000');
  });

  it.each(['dev', ...CORS_ENFORCED_ENVS])('a MISCONFIGURED list throws in %s — every environment', (appEnv) => {
    // Saying nothing is a closed door; saying something that is not what you
    // meant is a failure to start, and that half is not environment-dependent.
    expect(() => edgeOriginAllowlist({ APP_ENV: appEnv, [ALLOWED_ORIGINS_ENV]: '*' })).toThrow(OriginListError);
  });

  it('never produces a wildcard, whatever the environment', () => {
    for (const appEnv of ['dev', 'test', 'staging', 'prod']) {
      expect(edgeOriginAllowlist({ APP_ENV: appEnv }).origins).not.toContain('*');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The surface — /admin is not one.
// ─────────────────────────────────────────────────────────────────────────────

describe('isCorsSurface', () => {
  it('covers what a browser legitimately calls', () => {
    expect(isCorsSurface('/api/trade/trpc/orders.create')).toBe(true);
    expect(isCorsSurface('/api/v1/markets')).toBe(true);
    expect(isCorsSurface('/health')).toBe(true);
    expect(isCorsSurface('/ready')).toBe(true);
  });

  it('excludes the operator control plane', () => {
    expect(isCorsSurface('/admin/kill-switches')).toBe(false);
    expect(isCorsSurface('/admin/ledger/freeze')).toBe(false);
  });

  it('does not treat a path that merely starts with the same letters as /api', () => {
    expect(isCorsSurface('/apiary')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The preflight.
// ─────────────────────────────────────────────────────────────────────────────

describe('preflight', () => {
  it('an allowed origin gets 204 with the exact origin echoed back', async () => {
    const { app } = await edge();
    const res = await preflight(app, '/api/trade/trpc/orders.create', APP);

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(APP);
    expect(res.headers['access-control-allow-methods']).toBe(ALLOWED_METHODS);
    expect(res.headers['access-control-allow-headers']).toBe(ALLOWED_REQUEST_HEADERS);
    expect(res.headers['access-control-max-age']).toBe(String(PREFLIGHT_MAX_AGE_SECONDS));
    expect(res.headers.vary).toBe('origin');
  });

  it('allows the Authorization header — the one that makes every tRPC call preflight', async () => {
    const { app } = await edge();
    const res = await preflight(app, '/api/trade/trpc/orders.create', APP);
    expect(res.headers['access-control-allow-headers']).toMatch(/authorization/);
    expect(res.headers['access-control-allow-headers']).toMatch(/content-type/);
  });

  it('never permits the edge`s own header vocabulary to be sent by a browser', async () => {
    // `stripReserved` removes these upstream regardless. This is the same rule
    // one layer earlier, where the caller can see it.
    const { app } = await edge();
    const res = await preflight(app, '/api/trade/trpc/orders.create', APP);
    expect(res.headers['access-control-allow-headers']).not.toMatch(/x-intafaced/i);
  });

  it('permits no method that could mutate outside GET/POST', async () => {
    const { app } = await edge();
    const res = await preflight(app, '/api/trade/trpc/orders.create', APP);
    for (const method of ['DELETE', 'PUT', 'PATCH']) {
      expect(res.headers['access-control-allow-methods']).not.toMatch(method);
    }
  });

  /**
   * Honesty residual: CORS methods are not a map of what the proxy forwards.
   * DELETE cancels on `/api/v1/orders…` are real release paths for bots/ccxt
   * (no Origin → no CORS). Browsers cancel via tRPC POST. Never re-read
   * ALLOWED_METHODS as "edge has no DELETE routes."
   */
  it('excludes DELETE from CORS while kill-switch still names DELETE release routes', async () => {
    const { ALWAYS_ALLOWED_REST } = await import('./kill-switch.js');
    expect(ALLOWED_METHODS).toBe('GET, POST, OPTIONS');
    expect(ALLOWED_METHODS).not.toMatch(/DELETE/i);
    expect(ALWAYS_ALLOWED_REST.some((r) => r.method === 'DELETE')).toBe(true);
  });

  it('a DISALLOWED origin gets no allow-origin header at all — not a 200 with a permissive one', async () => {
    const { app } = await edge();
    const res = await preflight(app, '/api/trade/trpc/orders.create', EVIL);

    expect(res.statusCode).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-methods']).toBeUndefined();
    expect(res.headers['access-control-allow-headers']).toBeUndefined();
  });

  it('a preflight with no Origin at all is refused — a browser always sends one', async () => {
    const { app } = await edge();
    const res = await preflight(app, '/api/trade/trpc/orders.create');
    expect(res.statusCode).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('NEVER reaches the proxy, from any origin', async () => {
    const { app, reached } = await edge();
    await preflight(app, '/api/trade/trpc/orders.create', APP);
    await preflight(app, '/api/pay/trpc/withdrawal.create', APP);
    await preflight(app, '/api/trade/trpc/orders.create', EVIL);
    await app.inject({ method: 'OPTIONS', url: '/api/trade/trpc/orders.create', headers: { origin: APP } });

    // The unauthenticated request shape forwards nowhere. Not "is refused by the
    // upstream" — never arrives.
    expect(reached).toEqual([]);
  });

  it('cannot be used to enumerate the route table', async () => {
    const { app } = await edge();
    const real = await preflight(app, '/api/trade/trpc/orders.create', APP);
    const fake = await preflight(app, '/api/does-not-exist/trpc/anything', APP);
    const absent = await preflight(app, '/api/ledger/trpc/post', APP);

    // svc-ledger has no route table entry on purpose, and the preflight must not
    // be the thing that says so. All three answers are identical.
    expect(fake.statusCode).toBe(real.statusCode);
    expect(absent.statusCode).toBe(real.statusCode);
    expect(fake.headers['access-control-allow-origin']).toBe(real.headers['access-control-allow-origin']);
    expect(absent.headers['access-control-allow-origin']).toBe(real.headers['access-control-allow-origin']);
    expect(fake.body).toBe(real.body);
    expect(absent.body).toBe(real.body);
  });

  it('does not report which modules an operator has halted', async () => {
    const app = Fastify({ logger: false });
    const state = new KillSwitchState();
    registerCors(app, allowlistOf(APP));
    registerKillSwitchGuard(app, state);
    app.all('/api/*', async () => ({ ok: true }));
    await app.ready();
    harness = { app, reached: [] };

    state.set('trade', true, 'halted for the test', 'operator');

    const killed = await preflight(app, '/api/trade/trpc/orders.create', APP);
    const live = await preflight(app, '/api/pay/trpc/payment.create', APP);

    // The preflight runs before the kill-switch guard precisely so that an
    // unauthenticated caller cannot read operational state off it.
    expect(killed.statusCode).toBe(204);
    expect(killed.statusCode).toBe(live.statusCode);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Actual requests.
// ─────────────────────────────────────────────────────────────────────────────

describe('cross-origin requests', () => {
  it('an allowed origin gets the header on a real call, and the call goes through', async () => {
    const { app, reached } = await edge();
    const res = await app.inject({ method: 'GET', url: '/api/v1/markets', headers: { origin: APP } });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(APP);
    expect(reached).toEqual(['GET /api/v1/markets']);
  });

  it('every configured origin works, not just the first', async () => {
    const { app } = await edge();
    for (const origin of [APP, OTHER]) {
      const res = await app.inject({ method: 'GET', url: '/api/v1/markets', headers: { origin } });
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
  });

  it('a disallowed origin gets NO allow-origin header — the browser drops the answer', async () => {
    const { app } = await edge();
    const res = await app.inject({ method: 'GET', url: '/api/v1/markets', headers: { origin: EVIL } });

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    // The request is not refused: it carries no ambient credential, so it got
    // exactly as far as an anonymous `curl` would. What is shut down is READING
    // the answer, which is the whole cross-site risk here.
    expect(res.statusCode).toBe(200);
  });

  it('a request with NO Origin is untouched — this is the vendored shell on :8090', async () => {
    // nginx proxies its `/api` same-origin, so no Origin header is ever sent and
    // none of this applies. `/api/v1/markets` returning 200 through that path is
    // a verified property and must stay one.
    const { app, reached } = await edge();
    const res = await app.inject({ method: 'GET', url: '/api/v1/markets' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(reached).toEqual(['GET /api/v1/markets']);
  });

  it('server-to-server callers are unaffected by an empty allowlist', async () => {
    const { app, reached } = await edge({ origins: [], configured: false, source: 'unconfigured', summary: '' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/markets' });

    expect(res.statusCode).toBe(200);
    expect(reached).toEqual(['GET /api/v1/markets']);
  });

  it('a closed allowlist refuses every browser origin', async () => {
    const { app } = await edge({ origins: [], configured: false, source: 'unconfigured', summary: '' });

    for (const origin of [APP, OTHER, EVIL, 'http://localhost:3000']) {
      const pre = await preflight(app, '/api/v1/markets', origin);
      expect(pre.statusCode).toBe(403);
      expect(pre.headers['access-control-allow-origin']).toBeUndefined();

      const get = await app.inject({ method: 'GET', url: '/api/v1/markets', headers: { origin } });
      expect(get.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('sets Vary: Origin even when it adds nothing, so a cache cannot leak one origin`s answer to another', async () => {
    const { app } = await edge();
    const refused = await app.inject({ method: 'GET', url: '/api/v1/markets', headers: { origin: EVIL } });
    const none = await app.inject({ method: 'GET', url: '/api/v1/markets' });

    expect(refused.headers.vary).toBe('origin');
    expect(none.headers.vary).toBe('origin');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Refusals have to survive the trip.
// ─────────────────────────────────────────────────────────────────────────────

describe('the headers go on refusals too', () => {
  it('/ready carries them — this is the masthead that said PLATFORM UNREACHABLE', async () => {
    const { app } = await edge();
    const res = await app.inject({ method: 'GET', url: '/ready', headers: { origin: APP } });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(APP);
  });

  it('/health carries them', async () => {
    const { app } = await edge();
    const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: APP } });
    expect(res.headers['access-control-allow-origin']).toBe(APP);
  });

  it('a kill-switch 503 carries them, so an incident reads as an incident', async () => {
    const app = Fastify({ logger: false });
    const state = new KillSwitchState();
    registerCors(app, allowlistOf(APP));
    registerKillSwitchGuard(app, state);
    app.all('/api/*', async () => ({ ok: true }));
    await app.ready();
    harness = { app, reached: [] };

    state.set('trade', true, 'halted for the test', 'operator');
    // A POST, because the release rule lets every read through — a kill that
    // blinded the terminal would not be a safety control.
    const res = await app.inject({ method: 'POST', url: '/api/trade/trpc/orders.create', headers: { origin: APP }, payload: {} });

    expect(res.statusCode).toBe(503);
    // Without this the operator who halted the market would watch the UI report
    // "unreachable" instead of "switched off by the operator". The status code
    // is the message; it has to reach the caller.
    expect(res.headers['access-control-allow-origin']).toBe(APP);
    expect(res.json().code).toBe('edge.module_killed');
  });

  it('a 404 from an unknown path carries them', async () => {
    const app = Fastify({ logger: false });
    registerCors(app, allowlistOf(APP));
    registerKillSwitchGuard(app, new KillSwitchState());
    app.all('/api/*', async (_req, reply) => reply.code(404).send({ error: 'no route', code: 'edge.no_route' }));
    await app.ready();
    harness = { app, reached: [] };

    const res = await app.inject({ method: 'GET', url: '/api/nope/x', headers: { origin: APP } });
    expect(res.statusCode).toBe(404);
    expect(res.headers['access-control-allow-origin']).toBe(APP);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// What stays shut.
// ─────────────────────────────────────────────────────────────────────────────

describe('deliberately closed', () => {
  it('/admin/* is not reachable from any browser origin', async () => {
    const { app } = await edge();
    const res = await app.inject({ method: 'GET', url: '/admin/kill-switches', headers: { origin: APP } });

    // The route answers — apps/admin reaches it from its own SERVER — but a
    // browser is given nothing that would let it read the reply.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers.vary).toBeUndefined();
  });

  it('a preflight to /admin/* is not answered 204', async () => {
    const { app } = await edge();
    const res = await preflight(app, '/admin/ledger/freeze', APP);
    expect(res.statusCode).not.toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  // RC-developer-03 re-took this decision: exactly the request id and the two server times, nothing else,
  // and only to an origin that may read the reply at all.
  it('exposes exactly the request id and the two server times to an allowed origin, on answers and on refusals', async () => {
    const { app } = await edge();
    for (const url of ['/api/v1/markets', '/api/does-not-exist']) {
      const res = await app.inject({ method: 'GET', url, headers: { origin: APP } });
      expect(res.headers['access-control-expose-headers']).toBe('x-request-id, x-server-received, x-server-sent');
    }
  });

  it('exposes nothing to a disallowed origin, to a caller with no origin, on a preflight, or on /admin/*', async () => {
    const { app } = await edge();
    const answers = [
      await app.inject({ method: 'GET', url: '/api/v1/markets', headers: { origin: EVIL } }),
      await app.inject({ method: 'GET', url: '/api/v1/markets' }),
      await preflight(app, '/api/v1/markets', APP),
      await app.inject({ method: 'GET', url: '/admin/kill-switches', headers: { origin: APP } }),
    ];
    for (const res of answers) expect(res.headers['access-control-expose-headers']).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE INVARIANT. Nothing above may violate this, and nothing added later either.
// ─────────────────────────────────────────────────────────────────────────────

describe('invariant — no wildcard, credentials only for an allowlisted origin', () => {
  const surfaces = [
    '/api/v1/markets',
    '/api/trade/trpc/orders.create',
    '/api/pay/trpc/withdrawal.create',
    '/health',
    '/ready',
    '/admin/kill-switches',
  ];
  const origins = [APP, OTHER, EVIL, 'null', 'http://localhost:3000', undefined];

  it('across every surface, origin and method, ACAO is never `*` and credentials follow the allowlist', async () => {
    const { app } = await edge();
    let checked = 0;
    const allowlisted = new Set([APP, OTHER]);

    for (const url of surfaces) {
      for (const origin of origins) {
        const headers = origin ? { origin } : {};
        const responses = [
          await app.inject({ method: 'GET', url, headers }),
          await app.inject({ method: 'POST', url, headers, payload: {} }),
          await preflight(app, url, origin),
        ];

        for (const res of responses) {
          const acao = res.headers['access-control-allow-origin'];
          const credentials = res.headers['access-control-allow-credentials'];
          expect(acao).not.toBe('*');
          if (acao !== undefined) expect(allowlisted.has(String(acao))).toBe(true);
          // Credentials only beside an exact allowlisted origin. Never with `*`,
          // never for a stranger, never when there is no allow-origin header.
          if (credentials !== undefined) {
            expect(credentials).toBe('true');
            expect(acao).toBeDefined();
            expect(allowlisted.has(String(acao))).toBe(true);
          }
          const corsSurface = url.startsWith('/api/') || url === '/health' || url === '/ready';
          if (corsSurface && origin && allowlisted.has(origin)) expect(credentials).toBe('true');
          if (!origin || !allowlisted.has(origin ?? '')) expect(credentials).toBeUndefined();
          checked++;
        }
      }
    }

    // Guards against the matrix silently emptying and the assertions above
    // passing over nothing — the failure mode of the mocked-the-wrong-layer test
    // this file's header refers to.
    expect(checked).toBe(surfaces.length * origins.length * 3);
  });

  it('an allowlist can never be constructed with a wildcard in it', () => {
    expect(() => parseOriginList('*')).toThrow();
    expect(() => edgeOriginAllowlist({ APP_ENV: 'prod', [ALLOWED_ORIGINS_ENV]: '*' })).toThrow();
    expect(() => edgeOriginAllowlist({ APP_ENV: 'prod', [ALLOWED_ORIGINS_ENV]: `${APP}, *` })).toThrow();
  });
});
