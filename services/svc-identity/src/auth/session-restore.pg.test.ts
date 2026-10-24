import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { verifyAccessToken } from '@intafaced/auth';
import { createIdentityRouter } from '../router.js';
import { AuthService, AuthError } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { cookiePathMatches, installRefreshCookieHooks, REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATHS } from './refresh-cookie.js';
import { DEVICE_COOKIE_NAME, DEVICE_COOKIE_PATH } from './trusted-devices.js';
import { hashToken } from './passwords.js';
import { encodeCbor } from './cbor.js';
import {
  b64urlEncode,
  buildAuthenticatorData,
  buildClientDataJSON,
  coseKeyFromJwk,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from './webauthn.js';

/**
 * Signing back in after a typed URL.
 *
 * The browser keeps `ifc_rt`. A second tab that presents the same cookie
 * inside the grace window gets the already-rotated pair. Outside that window
 * the family burns.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const PASSWORD = 'correct horse battery staple';
const tokenConfig = {
  secret: 'an-identity-test-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const webauthnConfig = {
  rpID: 'localhost',
  rpName: 'INTAFACED',
  origin: 'http://localhost:3000',
};

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', '..', 'drizzle', f), 'utf8'));

function softAuthenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const cose = coseKeyFromJwk(jwk);
  const credId = randomBytes(16);
  let counter = 0;
  const sign = (authData: Buffer, clientDataJSON: Buffer, key: KeyObject = privateKey) => {
    const clientDataHash = createHash('sha256').update(clientDataJSON).digest();
    return cryptoSign('SHA256', Buffer.concat([authData, clientDataHash]), { key, dsaEncoding: 'der' });
  };
  return {
    credId,
    registrationResponse(challenge: string): RegistrationResponseJSON {
      const clientDataJSON = buildClientDataJSON({ type: 'webauthn.create', challenge, origin: webauthnConfig.origin });
      const authData = buildAuthenticatorData({ rpID: webauthnConfig.rpID, counter: 0, credential: { id: credId, publicKeyCose: cose } });
      const attestationObject = Buffer.from(
        encodeCbor(
          new Map<string | number, unknown>([
            ['fmt', 'none'],
            ['attStmt', new Map()],
            ['authData', new Uint8Array(authData)],
          ]) as never,
        ),
      );
      return {
        id: b64urlEncode(credId),
        rawId: b64urlEncode(credId),
        type: 'public-key',
        response: {
          clientDataJSON: b64urlEncode(clientDataJSON),
          attestationObject: b64urlEncode(attestationObject),
          transports: ['internal'],
        },
      };
    },
    assertionResponse(challenge: string): AuthenticationResponseJSON {
      counter += 1;
      const clientDataJSON = buildClientDataJSON({ type: 'webauthn.get', challenge, origin: webauthnConfig.origin });
      const authData = buildAuthenticatorData({ rpID: webauthnConfig.rpID, counter });
      const signature = sign(authData, clientDataJSON);
      return {
        id: b64urlEncode(credId),
        rawId: b64urlEncode(credId),
        type: 'public-key',
        response: {
          clientDataJSON: b64urlEncode(clientDataJSON),
          authenticatorData: b64urlEncode(authData),
          signature: b64urlEncode(signature),
        },
      };
    },
  };
}

function cookieLines(res: { headers: object }): string[] {
  const raw = (res.headers as { 'set-cookie'?: unknown })['set-cookie'];
  const all = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
  // A sign-in also sets the browser's device key (I-signin-sessions-07); it is its own cookie, on its own path.
  const device = all.filter((line) => line.startsWith(`${DEVICE_COOKIE_NAME}=`));
  expect(device.length).toBeLessThanOrEqual(1);
  for (const line of device) expect(line).toContain(`Path=${DEVICE_COOKIE_PATH}`);
  const lines = all.filter((line) => !line.startsWith(`${DEVICE_COOKIE_NAME}=`));
  expect(lines).toHaveLength(REFRESH_COOKIE_PATHS.length);
  return lines;
}

function cookieValue(lines: string[]): string {
  const values = lines.map((line) => {
    const first = line.split(';')[0] ?? '';
    expect(first.startsWith(`${REFRESH_COOKIE_NAME}=`)).toBe(true);
    return first.slice(REFRESH_COOKIE_NAME.length + 1);
  });
  expect(new Set(values).size).toBe(1);
  return values[0]!;
}

function expectCookiePaths(lines: string[]): void {
  for (const path of REFRESH_COOKIE_PATHS) {
    expect(lines.some((line) => line.includes(`Path=${path}`))).toBe(true);
    expect(cookiePathMatches(path, path)).toBe(true);
  }
  expect(cookiePathMatches('/trpc/auth.', '/trpc/auth.refresh')).toBe(false);
}

function wireData(res: { json: () => unknown }): Record<string, unknown> {
  const body = res.json() as { result?: { data?: Record<string, unknown> }; error?: unknown };
  if (!body.result?.data) throw new Error(`unexpected wire body ${JSON.stringify(body)}`);
  return body.result.data;
}

function httpPost(
  port: number,
  agent: http.Agent,
  path: string,
  body: string | undefined,
  headers: Record<string, string>,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; json: () => unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        agent,
        headers: {
          host: 'localhost',
          origin: 'http://localhost:3000',
          ...headers,
          ...(body === undefined
            ? { 'content-type': 'application/json', 'content-length': '0' }
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            json: () => JSON.parse(text) as unknown,
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('session restore (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const totpKey = randomBytes(32).toString('base64');
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, webauthnConfig, totpKey, undefined, undefined, 25, 10);
  await rank.seedTiers();
  let n = 0;
  const unique = () => `sr${process.pid}${++n}`;

  async function app(): Promise<FastifyInstance> {
    const router = createIdentityRouter(auth, rank, { registrationOpen: true, webauthnEnabled: true });
    const server = Fastify({ logger: false });
    const refreshCookieOf = installRefreshCookieHooks(server);
    await server.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router,
        createContext: ({ req }) => ({
          principal: null,
          service: null,
          region: 'DE',
          requestId: 'req-session-restore',
          refreshCookie: refreshCookieOf(req) ?? null,
        }),
      } satisfies FastifyTRPCPluginOptions<typeof router>['trpcOptions'],
    });
    await server.ready();
    return server;
  }

  beforeEach(async () => {
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  async function registerUser() {
    const handle = unique();
    await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD, region: 'DE' });
    return handle;
  }

  it('password sign-in sets the cookie and omits refreshToken from a browser reply', async () => {
    const handle = await registerUser();
    const server = await app();
    try {
      const browser = await server.inject({
        method: 'POST',
        url: '/trpc/auth.login',
        headers: { host: 'localhost:4002', origin: 'http://localhost:3000' },
        payload: { identifier: handle, password: PASSWORD },
      });
      expect(browser.statusCode).toBe(200);
      const lines = cookieLines(browser);
      expect(lines.every((line) => line.includes('HttpOnly'))).toBe(true);
      expect(lines.every((line) => line.includes('SameSite=Strict'))).toBe(true);
      expectCookiePaths(lines);
      expect(lines.every((line) => line.includes('Max-Age=2592000'))).toBe(true);
      expect(lines.some((line) => line.includes('Secure'))).toBe(false);
      expect(lines.some((line) => line.toLowerCase().includes('domain='))).toBe(false);
      const token = cookieValue(lines);
      const body = wireData(browser);
      expect(lines.length).toBe(REFRESH_COOKIE_PATHS.length);
      expect(body).not.toHaveProperty('refreshToken');
      expect(token.length).toBeGreaterThan(0);
      expect(typeof body.accessToken).toBe('string');

      const secure = await server.inject({
        method: 'POST',
        url: '/trpc/auth.login',
        headers: { host: 'app.example.com', origin: 'https://app.example.com' },
        payload: { identifier: handle, password: PASSWORD },
      });
      expect(cookieLines(secure).every((line) => line.includes('Secure'))).toBe(true);

      const api = await server.inject({
        method: 'POST',
        url: '/trpc/auth.login',
        headers: { host: 'app.example.com' },
        payload: { identifier: handle, password: PASSWORD },
      });
      const apiBody = wireData(api);
      expect(apiBody.refreshToken).toBe(cookieValue(cookieLines(api)));
      expect(typeof apiBody.refreshToken).toBe('string');
    } finally {
      await server.close();
    }
  });

  it('refresh reads the cookie, rotates it, and a second tab inside the window gets the same refresh token', async () => {
    const handle = await registerUser();
    const server = await app();
    try {
      const login = await server.inject({
        method: 'POST',
        url: '/trpc/auth.login',
        headers: { host: 'localhost', origin: 'http://localhost:3000' },
        payload: { identifier: handle, password: PASSWORD },
      });
      const first = cookieValue(cookieLines(login));
      const refreshed = await server.inject({
        method: 'POST',
        url: '/trpc/auth.refresh',
        headers: { host: 'localhost', origin: 'http://localhost:3000', cookie: `${REFRESH_COOKIE_NAME}=${first}` },
        payload: {},
      });
      expect(refreshed.statusCode).toBe(200);
      const second = cookieValue(cookieLines(refreshed));
      expect(second).not.toBe(first);
      expect(wireData(refreshed)).not.toHaveProperty('refreshToken');
      const access = wireData(refreshed).accessToken;
      expect(typeof access).toBe('string');
      await expect(verifyAccessToken(access as string, tokenConfig)).resolves.toMatchObject({ userId: expect.any(String) });

      const [left, right] = await Promise.all([auth.refresh(second), auth.refresh(second)]);
      expect(left.refreshToken).toBe(right.refreshToken);
      expect(left.sessionId).toBe(right.sessionId);
      expect(left.refreshToken).not.toBe(second);

      const again = await auth.refresh(second);
      expect(again.refreshToken).toBe(left.refreshToken);
      expect(again.sessionId).toBe(left.sessionId);
    } finally {
      await server.close();
    }
  });

  it('reuse outside the grace window revokes every live session, including another device', async () => {
    const handle = await registerUser();
    const phone = await auth.login({ identifier: handle, password: PASSWORD });
    const laptop = await auth.login({ identifier: handle, password: PASSWORD });
    const rotated = await auth.refresh(phone.refreshToken);
    await db.sql`UPDATE sessions SET rotated_at = now() - interval '2 minutes' WHERE refresh_hash = ${hashToken(phone.refreshToken)}`;
    await expect(auth.refresh(phone.refreshToken)).rejects.toMatchObject({ code: 'auth.session_reused' });
    await expect(auth.refresh(rotated.refreshToken)).rejects.toThrow(AuthError);
    await expect(auth.refresh(laptop.refreshToken)).rejects.toThrow(AuthError);
  });

  it('logout clears the cookie and revokes that rotation chain, and leaves another login signed in', async () => {
    const handle = await registerUser();
    const server = await app();
    try {
      const browser = await server.inject({
        method: 'POST',
        url: '/trpc/auth.login',
        headers: { host: 'localhost', origin: 'http://localhost:3000' },
        payload: { identifier: handle, password: PASSWORD },
      });
      const token = cookieValue(cookieLines(browser));
      const other = await auth.login({ identifier: handle, password: PASSWORD });
      const loggedOut = await server.inject({
        method: 'POST',
        url: '/trpc/auth.logout',
        headers: { host: 'localhost', origin: 'http://localhost:3000', cookie: `${REFRESH_COOKIE_NAME}=${token}` },
        payload: {},
      });
      expect(loggedOut.statusCode).toBe(200);
      const cleared = cookieLines(loggedOut);
      expect(cleared.every((line) => line.includes('Max-Age=0'))).toBe(true);
      expectCookiePaths(cleared);
      expect(cleared.every((line) => line.includes('HttpOnly'))).toBe(true);
      const again = await server.inject({
        method: 'POST',
        url: '/trpc/auth.refresh',
        headers: { host: 'localhost', origin: 'http://localhost:3000', cookie: `${REFRESH_COOKIE_NAME}=${token}` },
        payload: {},
      });
      expect(again.statusCode).toBe(401);
      await expect(auth.refresh(other.refreshToken)).resolves.toMatchObject({ userId: other.userId });
    } finally {
      await server.close();
    }
  });

  it('passkey sign-in sets the same cookie', async () => {
    const handle = await registerUser();
    const session = await auth.login({ identifier: handle, password: PASSWORD });
    const authenticator = softAuthenticator();
    const options = await auth.startWebauthnRegistration(session.userId, { mfa: false, privileged: false });
    await auth.confirmWebauthnRegistration(
      session.userId,
      { mfa: false, privileged: false },
      authenticator.registrationResponse(options.challenge),
    );
    const authOptions = await auth.startWebauthnAuthentication(handle);
    const server = await app();
    try {
      const res = await server.inject({
        method: 'POST',
        url: '/trpc/webauthn.authVerify',
        headers: { host: 'localhost', origin: 'http://localhost:3000' },
        payload: { identifier: handle, credential: authenticator.assertionResponse(authOptions.challenge) },
      });
      expect(res.statusCode).toBe(200);
      const lines = cookieLines(res);
      expect(lines.every((line) => line.includes('HttpOnly'))).toBe(true);
      expect(lines.every((line) => line.includes('SameSite=Strict'))).toBe(true);
      expectCookiePaths(lines);
      const token = cookieValue(lines);
      expect(token.length).toBeGreaterThan(0);
      expect(wireData(res)).not.toHaveProperty('refreshToken');
      const principal = await verifyAccessToken(wireData(res).accessToken as string, tokenConfig);
      expect(principal.mfa).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('grace refresh refuses a frozen account and revokes the successor', async () => {
    const handle = await registerUser();
    const t0 = await auth.login({ identifier: handle, password: PASSWORD });
    const t1 = await auth.refresh(t0.refreshToken);
    await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${t0.userId}`;
    await expect(auth.refresh(t0.refreshToken)).rejects.toMatchObject({ code: 'auth.account_frozen' });
    const successor = await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM sessions WHERE id = ${t1.sessionId}`;
    expect(successor[0]?.revoked).toBe(true);
    await expect(auth.refresh(t1.refreshToken)).rejects.toThrow(AuthError);
  });

  it('two callers on one keep-alive socket each receive their own cookie', async () => {
    const handleA = await registerUser();
    const handleB = await registerUser();
    const server = await app();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      await server.listen({ port: 0, host: '127.0.0.1' });
      const address = server.server.address();
      if (address === null || typeof address === 'string') throw new Error('expected a tcp port');
      const port = address.port;
      const loginA = await httpPost(port, agent, '/trpc/auth.login', JSON.stringify({ identifier: handleA, password: PASSWORD }), {});
      const loginB = await httpPost(port, agent, '/trpc/auth.login', JSON.stringify({ identifier: handleB, password: PASSWORD }), {});
      expect(loginA.statusCode).toBe(200);
      expect(loginB.statusCode).toBe(200);
      const cookieA = cookieValue(cookieLines(loginA));
      const cookieB = cookieValue(cookieLines(loginB));
      const userA = wireData(loginA).userId;
      const userB = wireData(loginB).userId;
      expect(userA).not.toBe(userB);

      const refreshA = await httpPost(port, agent, '/trpc/auth.refresh', JSON.stringify({}), {
        cookie: `${REFRESH_COOKIE_NAME}=${cookieA}`,
      });
      const refreshB = await httpPost(port, agent, '/trpc/auth.refresh', JSON.stringify({}), {
        cookie: `${REFRESH_COOKIE_NAME}=${cookieB}`,
      });
      expect(refreshA.statusCode).toBe(200);
      expect(refreshB.statusCode).toBe(200);
      const setA = cookieValue(cookieLines(refreshA));
      const setB = cookieValue(cookieLines(refreshB));
      expect(setA).not.toBe(setB);
      expect(setA).not.toBe(cookieA);
      expect(setB).not.toBe(cookieB);
      expect(wireData(refreshA).userId).toBe(userA);
      expect(wireData(refreshB).userId).toBe(userB);
      expect(wireData(refreshA)).not.toHaveProperty('refreshToken');
      expect(wireData(refreshB)).not.toHaveProperty('refreshToken');

      const missing = await httpPost(port, agent, '/trpc/auth.refresh', undefined, {});
      expect(missing.statusCode).toBe(401);
      const err = missing.json() as { error?: { data?: { intafacedCode?: string; cause?: { code?: string } } } };
      expect(err.error?.data?.intafacedCode ?? err.error?.data?.cause?.code).toBe('auth.session_invalid');
    } finally {
      agent.destroy();
      await server.close();
    }
  });
}
