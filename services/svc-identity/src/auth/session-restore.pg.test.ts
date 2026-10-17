import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
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
import {
  openRefreshCookieBag,
  refreshCookieAls,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  type RefreshCookieBag,
} from './refresh-cookie.js';
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

function cookieLine(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const line = Array.isArray(raw) ? raw[0] : raw;
  expect(typeof line).toBe('string');
  return line as string;
}

function cookieValue(line: string): string {
  const first = line.split(';')[0] ?? '';
  expect(first.startsWith(`${REFRESH_COOKIE_NAME}=`)).toBe(true);
  return first.slice(REFRESH_COOKIE_NAME.length + 1);
}

function wireData(res: { json: () => unknown }): Record<string, unknown> {
  const body = res.json() as { result?: { data?: Record<string, unknown> }; error?: unknown };
  if (!body.result?.data) throw new Error(`unexpected wire body ${JSON.stringify(body)}`);
  return body.result.data;
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

  const bags = new WeakMap<object, RefreshCookieBag>();
  async function app(): Promise<FastifyInstance> {
    const router = createIdentityRouter(auth, rank, { registrationOpen: true, webauthnEnabled: true });
    const server = Fastify({ logger: false });
    server.addHook('onRequest', (req, _reply, done) => {
      const bag = openRefreshCookieBag(req.headers);
      bags.set(req, bag);
      refreshCookieAls.enterWith(bag);
      refreshCookieAls.run(bag, () => done());
    });
    server.addHook('onSend', async (req, reply, payload) => {
      const setCookie = bags.get(req)?.setCookie;
      if (setCookie) reply.header('set-cookie', setCookie);
      return payload;
    });
    await server.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router,
        createContext: () => ({ principal: null, service: null, region: 'DE', requestId: 'req-session-restore' }),
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

  it('password sign-in sets an httpOnly Strict path-scoped cookie and hides the refresh token from a browser', async () => {
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
      const line = cookieLine(browser);
      expect(line).toContain('HttpOnly');
      expect(line).toContain('SameSite=Strict');
      expect(line).toContain(`Path=${REFRESH_COOKIE_PATH}`);
      expect(line).toContain('Max-Age=2592000');
      expect(line).not.toContain('Secure');
      expect(line.toLowerCase()).not.toContain('domain=');
      const token = cookieValue(line);
      const body = wireData(browser);
      expect(body.refreshToken).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(token);
      expect(typeof body.accessToken).toBe('string');

      const secure = await server.inject({
        method: 'POST',
        url: '/trpc/auth.login',
        headers: { host: 'app.example.com', origin: 'https://app.example.com' },
        payload: { identifier: handle, password: PASSWORD },
      });
      expect(cookieLine(secure)).toContain('Secure');

      const api = await server.inject({
        method: 'POST',
        url: '/trpc/auth.login',
        headers: { host: 'app.example.com' },
        payload: { identifier: handle, password: PASSWORD },
      });
      expect(typeof wireData(api).refreshToken).toBe('string');
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
      const first = cookieValue(cookieLine(login));
      const refreshed = await server.inject({
        method: 'POST',
        url: '/trpc/auth.refresh',
        headers: { host: 'localhost', origin: 'http://localhost:3000', cookie: `${REFRESH_COOKIE_NAME}=${first}` },
        payload: {},
      });
      expect(refreshed.statusCode).toBe(200);
      const second = cookieValue(cookieLine(refreshed));
      expect(second).not.toBe(first);
      expect(JSON.stringify(wireData(refreshed))).not.toContain(second);
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
      const token = cookieValue(cookieLine(browser));
      const other = await auth.login({ identifier: handle, password: PASSWORD });
      const loggedOut = await server.inject({
        method: 'POST',
        url: '/trpc/auth.logout',
        headers: { host: 'localhost', origin: 'http://localhost:3000', cookie: `${REFRESH_COOKIE_NAME}=${token}` },
        payload: {},
      });
      expect(loggedOut.statusCode).toBe(200);
      const cleared = cookieLine(loggedOut);
      expect(cleared).toContain('Max-Age=0');
      expect(cleared).toContain(`Path=${REFRESH_COOKIE_PATH}`);
      expect(cleared).toContain('HttpOnly');
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
      const line = cookieLine(res);
      expect(line).toContain('HttpOnly');
      expect(line).toContain('SameSite=Strict');
      expect(line).toContain(`Path=${REFRESH_COOKIE_PATH}`);
      const token = cookieValue(line);
      expect(JSON.stringify(wireData(res))).not.toContain(token);
      const principal = await verifyAccessToken(wireData(res).accessToken as string, tokenConfig);
      expect(principal.mfa).toBe(true);
    } finally {
      await server.close();
    }
  });
}
