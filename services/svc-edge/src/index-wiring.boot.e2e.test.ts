import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { S2S_KID_HEADER, verifyServiceHeaders } from '@intafaced/contracts';
import { AUTH_ERROR_CATALOGUE } from '@intafaced/contracts/auth-errors';
import { API_KEY_REVOKED, apiKeyRefusalBody } from './api-key-refusal.js';
import { readyUpstreamHonesty } from './ready-honesty.js';
import { stampProxiedErrorBody } from './reply-envelope.js';
import { currentAuthorityTestReply } from './test-current-authority.js';
import { WIDGET_IFRAME_RETIRED, WIDGET_RAMP_PATH } from './widget-ramp.js';

/**
 * How `index.ts` puts the edge together, read from the running process: the shipped entrypoint is booted with its
 * identity, bank, pay and matching upstreams pointed at loopback stand-ins that record every request they get, and each
 * test sends a request through the edge and reads the reply and what reached each stand-in.
 *
 * Every stand-in records headers and bodies, so "the edge never sends INTERNAL_SERVICE_SECRET" is checked over every
 * byte the process sent, with that secret set in its environment. The edge holds its own S2S key (dual mode), so a
 * forward with no service header shows the proxy signs nothing, not that there was nothing to sign with.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(HERE, 'index.ts');

const JWT_SECRET = 'test-only-signing-secret-at-least-32-characters-long';
const TOKENS: TokenConfig = { secret: JWT_SECRET, issuer: 'intafaced', audience: 'intafaced.api', accessTtlSeconds: 900 };
const OWNERSHIP = 'test-only-identity-ownership-secret-32-chars';
const INTERNAL = 'test-only-internal-service-secret-the-edge-never-holds';

const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const ADMIN_SESSION = '33333333-3333-4333-8333-333333333333';
const DOWN_SESSION = '44444444-4444-4444-8444-444444444444';
const SANDBOX_KEY_ID = '55555555-5555-4555-8555-555555555555';
const LIVE_CREDENTIALS = new Set([SESSION, ADMIN_SESSION, SANDBOX_KEY_ID]);

const REVOKED_KEY = 'ifc_revoked_key_material_00000000';
const DOWN_KEY = 'ifc_identity_down_key_material_00';
const SANDBOX_KEY = 'ifc_sandbox_key_material_00000000';
const SANDBOX_HOST = 'sandbox.test';
const APP_ORIGIN = 'https://app.test';
const BANK_ERROR = '{"code":"bank.refused","error":"refused by the bank stand-in"}';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface StandIn {
  readonly server: Server;
  readonly url: string;
  readonly seen: Seen[];
}

/** A loopback server that records each request it gets and answers it with `answer`. */
async function standIn(answer: (seen: Seen, res: ServerResponse) => void | Promise<void>): Promise<StandIn> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const one: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(one);
      void Promise.resolve(answer(one, res)).catch(() => res.writeHead(500).end());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

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

function edgeKeys(): Record<string, string> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  return {
    S2S_AUTH_MODE: 'dual',
    S2S_KEYRING: JSON.stringify({ keys: [{ kid: 'svc-edge.boot', svc: 'svc-edge', use: 's2s', x }] }),
    S2S_SIGNING_KID: 'svc-edge.boot',
    S2S_SIGNING_KEY: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
  };
}

/** The env the edge is booted with on top of the host's: every value index.ts reads for these tests. */
function edgeEnv(port: number, upstreams: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    ...process.env,
    APP_ENV: 'test',
    NODE_ENV: 'test',
    SERVICE_NAME: 'svc-edge',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: String(port),
    LOG_LEVEL: 'info',
    OTEL_ENABLED: 'false',
    JWT_ACCESS_SECRET: JWT_SECRET,
    EDGE_PRINCIPAL_SECRET: 'test-only-edge-principal-secret-at-least-32-chars',
    EDGE_RATE_LIMIT_MAX: '300',
    EDGE_RATE_LIMIT_WINDOW_MS: '60000',
    EDGE_BODY_LIMIT_BYTES: '1048576',
    INTAFACED_SANCTIONS_REGIONS: 'AA:test-fixture-not-a-real-list',
    EDGE_KILL_STATE_PATH: '',
    EDGE_TRUST_PROXY: undefined,
    EDGE_ALLOWED_ORIGINS: APP_ORIGIN,
    EDGE_SANDBOX_HOSTS: SANDBOX_HOST,
    IDENTITY_OWNERSHIP_SECRET: OWNERSHIP,
    // Set in the host env so a read of it anywhere would show up in what the stand-ins recorded.
    INTERNAL_SERVICE_SECRET: INTERNAL,
    // The retired widget's old settings: nothing may read them.
    INFRA_LICENCE_KEY: 'test-only-retired-licence',
    INFRA_WIDGET_ORIGINS: 'https://partner.test',
    ...edgeKeys(),
    ...upstreams,
  };
}

/** A spawn env with the removed keys left out, never passed as the string "undefined". */
const defined = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));

interface Edge {
  readonly child: ChildProcess;
  readonly port: number;
  readonly env: Record<string, string | undefined>;
}

/** Resolves on the edge's own "listening" log line; rejects if the process exits first. */
async function bootEdge(upstreams: Record<string, string | undefined>): Promise<Edge> {
  const port = await freePort();
  const env = edgeEnv(port, upstreams);
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRYPOINT], {
    cwd: join(HERE, '..'),
    env: defined(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const onData = (d: Buffer) => {
      output += d.toString();
      if (/listening/i.test(output)) resolve();
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => reject(new Error(`svc-edge exited with ${code} before listening:\n${output}`)));
  });
  return { child, port, env };
}

/** Boots the entrypoint with this env and waits for it to exit (a refused boot). */
function bootRefused(env: Record<string, string | undefined>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    // A boot that does not refuse is killed at 30 s, and its null exit code fails the test.
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRYPOINT], {
      cwd: join(HERE, '..'),
      env: defined(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    let output = '';
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
    child.on('exit', (code) => resolve({ code, output }));
  });
}

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

/** One request to the edge. node:http, so a test can set the Host header a browser would. */
function call(edge: Edge, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: edge.port, path, method: init.method ?? 'GET', headers: init.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(text) as Record<string, unknown>;
          } catch {
            body = {};
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body });
        });
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

async function bearer(sessionId: string, scopes: string[] = []): Promise<string> {
  const { token } = await issueAccessToken({ userId: USER, sessionId, scopes, tier: 'basic', mfa: true }, TOKENS);
  return `Bearer ${token}`;
}

/** Identity's tRPC refusal, as its formatter puts it on the wire. */
const identityRefusal = (status: number, intafacedCode: string) => ({
  error: { message: 'refused', code: -32001, data: { code: 'UNAUTHORIZED', httpStatus: status, intafacedCode } },
});

let identity: StandIn;
let bank: StandIn;
let pay: StandIn;
let matching: StandIn;
let edge: Edge;
let unwiredEdge: Edge;
const children: ChildProcess[] = [];
let sandboxToken = '';

const allStandIns = () => [identity, bank, pay, matching];
const counts = () => allStandIns().map((s) => s.seen.length);

beforeAll(async () => {
  sandboxToken = (
    await issueAccessToken(
      { userId: USER, sessionId: SANDBOX_KEY_ID, apiKeyId: SANDBOX_KEY_ID, keyEnv: 'sandbox', scopes: ['pay:read'], tier: 'basic' },
      TOKENS,
    )
  ).token;

  identity = await standIn(async (seen, res) => {
    const path = seen.url.split('?')[0] ?? seen.url;
    if (path === '/trpc/accountControls.currentAuthority') {
      const subject = JSON.parse(seen.body) as { credential: { kind: string; sessionId?: string; apiKeyId?: string } };
      const credentialId = subject.credential.sessionId ?? subject.credential.apiKeyId ?? '';
      if (credentialId === DOWN_SESSION) return json(res, 503, { error: 'identity stand-in is down' });
      const reply = currentAuthorityTestReply(
        `${identity.url}${path}`,
        { body: seen.body },
        {
          expectedUserId: USER,
          expectedCredentialId: LIVE_CREDENTIALS.has(credentialId) ? credentialId : 'not-a-live-credential',
        },
      );
      return json(res, reply!.status, await reply!.text());
    }
    if (path.startsWith('/internal/api-keys/')) return json(res, 200, { id: SANDBOX_KEY_ID, userId: USER, revoked: false });
    if (path.startsWith('/trpc/exchangeApiKey') || path === '/trpc/apiKeys.exchange') {
      const { key } = JSON.parse(seen.body) as { key: string };
      if (key === REVOKED_KEY) return json(res, 401, identityRefusal(401, 'auth.api_key_revoked'));
      if (key === DOWN_KEY) return json(res, 503, { error: 'identity stand-in is down' });
      if (key === SANDBOX_KEY) return json(res, 200, { result: { data: { accessToken: sandboxToken } } });
      return json(res, 401, identityRefusal(401, 'auth.api_key_denied'));
    }
    if (path === '/trpc/auth.refresh') {
      return json(
        res,
        200,
        { result: { data: { ok: true } } },
        { 'set-cookie': ['ifc_rt=rotated; HttpOnly; SameSite=Strict; Path=/trpc/auth.refresh'] },
      );
    }
    return json(res, 200, {});
  });
  bank = await standIn((seen, res) => (seen.url === '/proxied-error' ? json(res, 400, BANK_ERROR) : json(res, 200, { ok: true })));
  pay = await standIn((seen, res) => {
    if (seen.url.startsWith('/checkout/')) {
      res.writeHead(303, { location: 'https://elsewhere.test/not-a-checkout-session' });
      return void res.end();
    }
    json(res, 200, { ok: true });
  });
  matching = await standIn((seen, res) => (seen.url === '/health' ? json(res, 200, { halted: true }) : json(res, 200, { inFlight: [] })));

  edge = await bootEdge({ IDENTITY_URL: identity.url, BANK_URL: bank.url, PAY_URL: pay.url, MATCHING_URL: matching.url });
  children.push(edge.child);
  unwiredEdge = await bootEdge({ IDENTITY_URL: identity.url, BANK_URL: bank.url, PAY_URL: pay.url, MATCHING_URL: undefined });
  children.push(unwiredEdge.child);
}, 120_000);

afterAll(async () => {
  for (const child of children) child.kill();
  await Promise.all(allStandIns().map((s) => new Promise<void>((resolve) => (s ? s.server.close(() => resolve()) : resolve()))));
});

describe('index.ts: a session is checked live with identity, under the ownership secret only', () => {
  it('reads the session from IDENTITY_URL signed with IDENTITY_OWNERSHIP_SECRET, and never sends INTERNAL_SERVICE_SECRET', async () => {
    const before = identity.seen.length;
    const res = await call(edge, '/api/bank/accounts', { headers: { authorization: await bearer(SESSION) } });
    expect(res.status, res.text).toBe(200);

    const read = identity.seen.slice(before).find((s) => s.url === '/trpc/accountControls.currentAuthority');
    expect(read, 'the authority read reached IDENTITY_URL').toBeDefined();
    const rawBody = { retained: true as const, bytes: Buffer.from(read!.body) };
    expect(verifyServiceHeaders(read!.headers, OWNERSHIP, { rawBody, mode: 'require' })).toMatchObject({
      service: 'svc-edge',
      rejected: null,
    });
    expect(verifyServiceHeaders(read!.headers, INTERNAL, { rawBody, mode: 'require' }).rejected).not.toBeNull();
    // The edge holds its own S2S key and signs its identity calls with it.
    expect(read!.headers[S2S_KID_HEADER]).toBe('svc-edge.boot');
  });
});

describe('index.ts: identity not answering is a 503, never anonymous', () => {
  it('answers 503 edge.authority_unavailable with retry-after 1 and the catalogue entry, and forwards nothing', async () => {
    const before = bank.seen.length;
    const res = await call(edge, '/api/bank/accounts', { headers: { authorization: await bearer(DOWN_SESSION) } });
    expect(res.status, res.text).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.body.code).toBe('edge.authority_unavailable');
    expect(res.body).not.toHaveProperty('intafacedCode');
    expect(AUTH_ERROR_CATALOGUE.find((e) => e.code === 'edge.authority_unavailable')).toMatchObject({
      status: res.status,
      answeredBy: 'edge',
    });
    expect(bank.seen.length).toBe(before);
  });

  it('a key identity cannot be asked about is the same 503, not a verdict on the key', async () => {
    const before = bank.seen.length;
    const res = await call(edge, '/api/bank/accounts', { headers: { authorization: `Bearer ${DOWN_KEY}` } });
    expect(res.status, res.text).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.body.code).toBe('edge.authority_unavailable');
    expect(bank.seen.length).toBe(before);
  });

  it('a token that does not verify still goes up, as anonymous', async () => {
    const before = bank.seen.length;
    const res = await call(edge, '/api/bank/accounts', { headers: { authorization: 'Bearer not.a.token' } });
    expect(res.status, res.text).toBe(200);
    const forwarded = bank.seen.slice(before);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.headers['x-intafaced-principal']).toBeUndefined();
  });
});

describe('index.ts: a key the edge cannot open is refused at the edge', () => {
  it('a key identity names revoked is answered with its own refusal body and forwarded nowhere', async () => {
    const before = bank.seen.length;
    const res = await call(edge, '/api/bank/accounts', { headers: { authorization: `Bearer ${REVOKED_KEY}` } });
    expect(res.status, res.text).toBe(API_KEY_REVOKED.status);
    expect(res.body).toMatchObject(apiKeyRefusalBody(API_KEY_REVOKED));
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    expect(bank.seen.length).toBe(before);
  });
});

describe('index.ts: the environment rule reads the raw Host header against EDGE_SANDBOX_HOSTS', () => {
  const live = () => `127.0.0.1:${edge.port}`;
  const payCall = (headers: Record<string, string>) =>
    call(edge, '/api/pay/v1/payments', { headers: { authorization: `Bearer ${SANDBOX_KEY}`, ...headers } });

  it('a sandbox key at the live host is env.mismatch, marked sandbox, and forwarded nowhere', async () => {
    const before = pay.seen.length;
    const res = await payCall({ host: live() });
    expect(res.text).toContain('env.mismatch');
    expect(res.headers['x-intafaced-key-env']).toBe('sandbox');
    expect(pay.seen.length).toBe(before);
  });

  it('x-forwarded-host naming the sandbox host changes nothing', async () => {
    const before = pay.seen.length;
    const res = await payCall({ host: live(), 'x-forwarded-host': SANDBOX_HOST });
    expect(res.text).toContain('env.mismatch');
    expect(pay.seen.length).toBe(before);
  });

  it('the same key at the sandbox host passes the environment rule', async () => {
    const res = await payCall({ host: SANDBOX_HOST });
    expect(res.text).not.toContain('env.mismatch');
    expect(res.headers['x-intafaced-key-env']).toBe('sandbox');
  });
});

describe('index.ts: matching', () => {
  it('a halt-all from MATCHING_URL refuses a new order, read by GET /health with no operator or credential', async () => {
    const before = matching.seen.length;
    const res = await call(edge, '/api/trade/trpc/orders.create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status, res.text).toBe(503);
    expect(res.body.code).toBe('edge.venue_halted');
    const read = matching.seen.slice(before);
    expect(read.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /health']);
    expect(read[0]!.body).toBe('');
    expect(read[0]!.headers.authorization).toBeUndefined();
    expect(Object.keys(read[0]!.headers).filter((h) => h.startsWith('x-intafaced-') || /operator/i.test(h))).toEqual([]);
  });

  it('with MATCHING_URL and EDGE_PRINCIPAL_SECRET set, the in-flight read goes to matching as the signed operator, not the bearer', async () => {
    const before = matching.seen.length;
    const res = await call(edge, '/admin/matching/in-flight', { headers: { authorization: await bearer(ADMIN_SESSION, ['admin:read']) } });
    expect(res.status, res.text).toBe(200);
    const sent = matching.seen.slice(before).find((s) => s.url === '/operator/in-flight');
    expect(sent).toBeDefined();
    expect(sent!.headers.authorization).toBeUndefined();
    expect(sent!.headers['x-intafaced-principal']).toBeTruthy();
  });

  it('with MATCHING_URL unset the in-flight read is edge.matching_unwired', async () => {
    const before = matching.seen.length;
    const res = await call(unwiredEdge, '/admin/matching/in-flight', {
      headers: { authorization: await bearer(ADMIN_SESSION, ['admin:read']) },
    });
    expect(res.status, res.text).toBe(503);
    expect(res.body.code).toBe('edge.matching_unwired');
    expect(matching.seen.length).toBe(before);
  });

  it('an edge with no EDGE_PRINCIPAL_SECRET does not start, so no operator call goes unsigned', async () => {
    const { code, output } = await bootRefused({ ...edge.env, HTTP_PORT: '0', EDGE_PRINCIPAL_SECRET: undefined });
    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
    expect(output).toMatch(/EDGE_PRINCIPAL_SECRET/);
  }, 40_000);
});

describe('index.ts: the proxy forward', () => {
  it('carries the caller headers as prepared, the edge-signed person and the reply’s own request id, and no service identity', async () => {
    const before = bank.seen.length;
    const res = await call(edge, '/api/bank/accounts', {
      headers: {
        authorization: await bearer(SESSION),
        accept: 'application/json',
        'x-request-id': 'caller-chosen-id',
        'x-intafaced-service': 'svc-edge',
        'x-intafaced-service-sig': 'forged',
        [S2S_KID_HEADER]: 'svc-edge.boot',
      },
    });
    expect(res.status, res.text).toBe(200);
    const forwarded = bank.seen.slice(before);
    expect(forwarded).toHaveLength(1);
    const headers = forwarded[0]!.headers;
    expect(Object.keys(headers).filter((h) => /^x-intafaced-(s2s|service)/.test(h))).toEqual([]);
    expect(headers['x-intafaced-principal']).toBeTruthy();
    expect(headers.accept).toBe('application/json');
    expect(res.headers['x-request-id']).toMatch(UUID);
    expect(headers['x-request-id']).toBe(res.headers['x-request-id']);
  });
});

describe('index.ts: /ready', () => {
  it('serves readyUpstreamHonesty over the process env and fetches no upstream', async () => {
    const before = counts();
    const res = await call(edge, '/ready');
    expect(res.status).toBe(200);
    expect(res.body.upstreamConfiguration).toEqual(readyUpstreamHonesty((name) => edge.env[name]));
    expect(res.body).not.toHaveProperty('upstreamWiring');
    expect(res.text).not.toMatch(/"wired"|"unwired"/);
    expect(res.text).not.toContain(bank.url);
    expect(counts()).toEqual(before);
  });
});

describe('index.ts: the refresh cookie', () => {
  const refresh = (origin: string) =>
    call(edge, '/api/identity/trpc/auth.refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'ifc_rt=presented', origin },
      body: '{}',
    });

  it('a cookie refresh from an origin not on the allowlist is refused before anything is proxied', async () => {
    const before = identity.seen.length;
    const res = await refresh('https://elsewhere.test');
    expect(res.status, res.text).toBe(403);
    expect(res.body.code).toBe('edge.origin_not_allowed');
    expect(identity.seen.length).toBe(before);
  });

  it('from the allowed origin the cookie goes up and the rotated cookie comes back on the public path', async () => {
    const before = identity.seen.length;
    const res = await refresh(APP_ORIGIN);
    expect(res.status, res.text).toBe(200);
    const sent = identity.seen.slice(before).find((s) => s.url === '/trpc/auth.refresh');
    expect(sent?.headers.cookie).toBe('ifc_rt=presented');
    expect(res.headers['set-cookie']).toEqual(['ifc_rt=rotated; HttpOnly; SameSite=Strict; Path=/api/identity/trpc/auth.refresh']);
  });
});

describe('index.ts: the reply envelope', () => {
  it('stamps a preflight too: the envelope runs before CORS answers it', async () => {
    const res = await call(edge, '/api/bank/accounts', {
      method: 'OPTIONS',
      headers: { origin: APP_ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers['x-request-id']).toMatch(UUID);
    expect(res.headers['x-server-received']).toBeTruthy();
    expect(res.headers['x-server-sent']).toBeTruthy();
  });

  it('an edge refusal gets the full edge body', async () => {
    const res = await call(edge, '/api/nowhere');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'edge.no_route', requestId: res.headers['x-request-id'] });
    expect(res.body.docs).toBeTruthy();
  });

  it('a service’s error body gains the request id and every other byte is as the service sent it', async () => {
    const res = await call(edge, '/api/bank/proxied-error');
    expect(res.status).toBe(400);
    expect(res.text).toBe(stampProxiedErrorBody(BANK_ERROR, String(res.headers['x-request-id'])));
  });

  it('a refused checkout redirect is the edge’s own 502, not marked as the service’s body', async () => {
    const res = await call(edge, '/api/pay/checkout/abc');
    expect(res.status, res.text).toBe(502);
    expect(res.body).toMatchObject({ code: 'edge.upstream_unavailable', requestId: res.headers['x-request-id'] });
    expect(res.body.docs).toBeTruthy();
  });
});

describe('index.ts: the retired ramp widget', () => {
  it('is mounted ahead of the /api proxy: 410, framing denied, with the old licence settings set', async () => {
    const before = counts();
    const res = await call(edge, WIDGET_RAMP_PATH);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe(WIDGET_IFRAME_RETIRED);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(res.text).not.toMatch(/<iframe|<html/i);
    expect(counts()).toEqual(before);
  });
});

describe('index.ts: the edge never holds the internal service secret', () => {
  it('sends INTERNAL_SERVICE_SECRET in no request to any upstream, whatever it was asked to do', () => {
    // The last test in the file: every other test has sent its traffic (vitest runs a file's tests in order).
    for (const seen of allStandIns().flatMap((s) => s.seen)) {
      expect(JSON.stringify(seen.headers), seen.url).not.toContain(INTERNAL);
      expect(seen.body, seen.url).not.toContain(INTERNAL);
    }
  });
});
