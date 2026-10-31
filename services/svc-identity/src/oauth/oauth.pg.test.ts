import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { oauthAppRequestId } from '@intafaced/contracts/oauth';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import postgres from 'postgres';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { OAuthError, OAuthService, s256, type OAuthSettings } from './oauth.js';
import { createOAuthRouter } from './oauth-router.js';
import { RankService } from '../rank/rank-service.js';
import { AuthService } from '../auth/auth-service.js';

const PASSWORD = 'correct horse battery staple';

const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const tokenConfig = {
  secret: 'an-identity-test-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const webauthnConfig = { rpID: 'localhost', rpName: 'INTAFACED', origin: 'http://localhost:3000' };

async function harnessUrl(): Promise<string | null> {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw || !(await postgresAvailable(raw))) return null;
  const name = new URL(raw).pathname.replace(/^\//, '').split('/')[0] ?? '';
  let target = raw;
  if (!name.endsWith('_test')) {
    const admin = postgres(raw, { max: 1, onnotice: () => undefined });
    try {
      await admin.unsafe('CREATE DATABASE identbe_oauth_test');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(message)) throw err;
    } finally {
      await admin.end({ timeout: 5 });
    }
    const url = new URL(raw);
    url.pathname = '/identbe_oauth_test';
    target = url.toString();
  }
  const sql = postgres(target, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS citext');
    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  } finally {
    await sql.end({ timeout: 5 });
  }
  return target;
}

const databaseUrl = await harnessUrl();

if (!databaseUrl) {
  describe.skip('identity operator reads (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: databaseUrl,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const keyMaterial = randomBytes(32).toString('base64');
  const buildAuth = () => new AuthService(db.sql, bus, rank, tokenConfig, webauthnConfig, keyMaterial, undefined, undefined, 25);
  let auth = buildAuth();
  let counter = 0;

  const register = async (handle?: string, device?: string, ip?: string) => {
    const name = handle ?? `ops${process.pid}x${++counter}`;
    const session = await auth.register({ handle: name, email: `${name}@example.com`, password: PASSWORD, device, ip });
    return { handle: name, email: `${name}@example.com`, ...session };
  };

  async function ctx(userId: string, sessionId: string, scopes: string[], mfa: boolean): Promise<Context> {
    const { token } = await issueAccessToken({ userId, sessionId, scopes, tier: 'none', mfa }, tokenConfig);
    return { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'identbe' };
  }

  const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  const REDIRECT = 'https://app.example.test/callback';
  const SCOPES = ['trade:read', 'identity:read'];
  let clock = new Date('2026-10-20T12:00:00Z');
  const settings: OAuthSettings = { codeTtlSeconds: 300, accessTokenTtlSeconds: 3600 };
  const build = (overrides: Partial<OAuthSettings> = {}) => new OAuthService(db.sql, { ...settings, ...overrides }, () => clock);
  let oauth = build();

  const person = async (scopes = ['identity:read', 'identity:write', 'trade:read'], mfa = false) => {
    const reg = await register();
    return { userId: reg.userId, ctx: await ctx(reg.userId, reg.sessionId, scopes, mfa) };
  };
  const operator = async (mfa = true) => person(['identity:read', 'identity:write', 'admin:compliance'], mfa);

  const input = (userId: string, over: Record<string, unknown> = {}) => ({
    name: 'Ledger sync',
    redirectUrls: [REDIRECT],
    scopes: SCOPES,
    confidential: true,
    ...over,
    requestId: (over.requestId as string | undefined) ?? oauthAppRequestId(userId, (over.name as string | undefined) ?? 'Ledger sync'),
  });
  const request = (clientId: string, over: Record<string, unknown> = {}) => ({
    responseType: 'code' as const,
    clientId,
    redirectUri: REDIRECT,
    scope: ['trade:read'],
    state: 'st-1',
    codeChallenge: CHALLENGE,
    codeChallengeMethod: 'S256' as const,
    ...over,
  });
  const codeOf = (redirectTo: string) => new URL(redirectTo).searchParams.get('code') as string;
  const failsWith = async (promise: Promise<unknown>, code: string) => {
    const error = await promise.then(
      () => undefined,
      (e) => e,
    );
    expect(error, code).toBeInstanceOf(OAuthError);
    expect((error as OAuthError).code).toBe(code);
  };

  /** A registered, approved app and a person who allowed it; returns the code. */
  async function approvedApp(over: Record<string, unknown> = {}) {
    const dev = await person();
    const op = await operator();
    const { app, clientSecret } = await oauth.registerApp(dev.ctx, input(dev.userId, over) as never);
    await oauth.reviewApp(op.ctx, { appId: app.id, decision: 'approve' });
    return { dev, op, app, clientSecret };
  }
  const allow = async (userCtx: Context, clientId: string, over: Record<string, unknown> = {}) =>
    codeOf((await oauth.decide(userCtx, { ...request(clientId, over), decision: 'allow' })).redirectTo);

  beforeEach(async () => {
    bus.reset();
    await db.truncateAll();
    await rank.seedTiers();
    auth = buildAuth();
    clock = new Date('2026-10-20T12:00:00Z');
    oauth = build();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('app registration', () => {
    it('shows a client secret once, keeps only its hash, and returns the app with no secret on a replay', async () => {
      const dev = await person();
      const first = await oauth.registerApp(dev.ctx, input(dev.userId) as never);
      expect(first.clientSecret).toMatch(/^ifcs_/);
      expect(first.app).toMatchObject({ status: 'pending', confidential: true, scopes: ['identity:read', 'trade:read'] });
      const rows = await db.sql<Array<Record<string, unknown>>>`SELECT * FROM oauth_apps`;
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).not.toContain(first.clientSecret as string);
      expect(rows[0]?.secret_hash).toBe(
        createHash('sha256')
          .update(first.clientSecret as string)
          .digest('hex'),
      );
      const replay = await oauth.registerApp(dev.ctx, input(dev.userId) as never);
      expect(replay.clientSecret).toBeNull();
      expect(replay.app.id).toBe(first.app.id);
      await failsWith(oauth.registerApp(dev.ctx, input(dev.userId, { scopes: ['trade:read'] }) as never), 'oauth.idempotency_conflict');
      expect(await db.sql`SELECT 1 FROM oauth_apps`).toHaveLength(1);
    });

    it('registers a public app with no secret', async () => {
      const dev = await person();
      const out = await oauth.registerApp(dev.ctx, input(dev.userId, { confidential: false }) as never);
      expect(out.clientSecret).toBeNull();
      expect(out.app.confidential).toBe(false);
    });

    it('refuses an HTTP or wildcard redirect URL, an interactive-only scope, an unknown scope and no scope', async () => {
      const dev = await person();
      await failsWith(
        oauth.registerApp(dev.ctx, input(dev.userId, { redirectUrls: ['http://app.example.test/cb'] }) as never),
        'oauth.redirect_url_invalid',
      );
      await failsWith(
        oauth.registerApp(dev.ctx, input(dev.userId, { redirectUrls: ['https://*.example.test/cb'] }) as never),
        'oauth.redirect_url_invalid',
      );
      await failsWith(oauth.registerApp(dev.ctx, input(dev.userId, { scopes: ['trade:withdraw'] }) as never), 'oauth.scope_not_delegable');
      await failsWith(oauth.registerApp(dev.ctx, input(dev.userId, { scopes: ['admin:write'] }) as never), 'oauth.scope_not_delegable');
      await failsWith(oauth.registerApp(dev.ctx, input(dev.userId, { scopes: ['pay:payout'] }) as never), 'oauth.scope_not_delegable');
      await failsWith(oauth.registerApp(dev.ctx, input(dev.userId, { scopes: ['nope:read'] }) as never), 'oauth.invalid_scope');
      await failsWith(oauth.registerApp(dev.ctx, input(dev.userId, { scopes: [] }) as never), 'oauth.scope_empty');
      expect(await db.sql`SELECT 1 FROM oauth_apps`).toHaveLength(0);
    });

    it('refuses an API key principal, a frozen account and a request id that is not the business key', async () => {
      const dev = await person();
      const keyCtx = { ...dev.ctx, principal: { ...dev.ctx.principal!, kid: 'key-1' } } as Context;
      await failsWith(oauth.registerApp(keyCtx, input(dev.userId) as never), 'oauth.key_principal_refused');
      await failsWith(oauth.registerApp(dev.ctx, input(dev.userId, { requestId: 'random-id' }) as never), 'oauth.idempotency_conflict');
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${dev.userId}`;
      await failsWith(oauth.registerApp(dev.ctx, input(dev.userId) as never), 'oauth.account_not_active');
    });

    it('rolls the secret: the old one stops working, the new one is shown once, a repeat shows none', async () => {
      const { dev, app, clientSecret } = await approvedApp();
      const user = await person();
      const code = await allow(user.ctx, app.clientId);
      const rolled = await oauth.rollSecret(dev.ctx, { appId: app.id, requestId: 'roll-1' });
      expect(rolled.clientSecret).toMatch(/^ifcs_/);
      expect(rolled.clientSecret).not.toBe(clientSecret);
      expect((await oauth.rollSecret(dev.ctx, { appId: app.id, requestId: 'roll-1' })).clientSecret).toBeNull();
      await failsWith(
        oauth.exchange({
          code,
          redirectUri: REDIRECT,
          clientId: app.clientId,
          codeVerifier: VERIFIER,
          clientSecret: clientSecret as string,
        }),
        'oauth.invalid_client',
      );
      const out = await oauth.exchange({
        code,
        redirectUri: REDIRECT,
        clientId: app.clientId,
        codeVerifier: VERIFIER,
        clientSecret: rolled.clientSecret as string,
      });
      expect(out.tokenType).toBe('Bearer');
      const other = await person();
      await failsWith(oauth.rollSecret(other.ctx, { appId: app.id, requestId: 'roll-2' }), 'oauth.app_not_found');
    });
  });

  describe('scopes follow the person, not the app', () => {
    it('refuses to register an app that declares a scope the registering session does not hold', async () => {
      const dev = await person(['identity:read', 'identity:write']);
      await failsWith(oauth.registerApp(dev.ctx, input(dev.userId, { scopes: ['trade:read'] }) as never), 'oauth.scope_not_delegable');
      expect(await db.sql`SELECT 1 FROM oauth_apps`).toHaveLength(0);
    });

    it('gives a person without pay:write no code carrying it, from preview or from the decision', async () => {
      const dev = await person(['identity:read', 'identity:write', 'pay:write']);
      const op = await operator();
      const { app } = await oauth.registerApp(dev.ctx, input(dev.userId, { scopes: ['pay:write'] }) as never);
      await oauth.reviewApp(op.ctx, { appId: app.id, decision: 'approve' });
      const user = await person();
      await failsWith(oauth.preview(user.ctx, request(app.clientId, { scope: ['pay:write'] })), 'oauth.invalid_scope');
      await failsWith(
        oauth.decide(user.ctx, { ...request(app.clientId, { scope: ['pay:write'] }), decision: 'allow' }),
        'oauth.invalid_scope',
      );
      expect(await db.sql`SELECT 1 FROM oauth_codes`).toHaveLength(0);
      const holder = await person(['identity:read', 'identity:write', 'pay:write']);
      expect((await oauth.preview(holder.ctx, request(app.clientId, { scope: ['pay:write'] }))).scopes).toEqual(['pay:write']);
    });
  });

  describe('operator approval', () => {
    it('needs two-factor to approve, and the developer cannot approve their own app', async () => {
      const dev = await person();
      const noMfa = await operator(false);
      const { app } = await oauth.registerApp(dev.ctx, input(dev.userId) as never);
      await failsWith(oauth.reviewApp(noMfa.ctx, { appId: app.id, decision: 'approve' }), 'oauth.operator_denied');
      const selfOp = await person(['identity:read', 'identity:write', 'trade:read', 'admin:compliance'], true);
      const own = await oauth.registerApp(selfOp.ctx, input(selfOp.userId) as never);
      await failsWith(oauth.reviewApp(selfOp.ctx, { appId: own.app.id, decision: 'approve' }), 'oauth.operator_denied');
      expect((await oauth.reviewApp(selfOp.ctx, { appId: own.app.id, decision: 'suspend' })).status).toBe('suspended');
      expect((await db.sql<Array<{ status: string }>>`SELECT status FROM oauth_apps WHERE id = ${app.id}`)[0]?.status).toBe('pending');
    });

    it('lets only an operator decide, and an unapproved app reaches only its developer', async () => {
      const dev = await person();
      const op = await operator();
      const stranger = await person();
      const { app } = await oauth.registerApp(dev.ctx, input(dev.userId) as never);
      await failsWith(oauth.reviewApp(dev.ctx, { appId: app.id, decision: 'approve' }), 'oauth.operator_denied');
      await failsWith(oauth.reviewQueue(dev.ctx, 'pending', 10), 'oauth.operator_denied');
      expect((await oauth.reviewQueue(op.ctx, 'pending', 10)).map((row) => row.id)).toEqual([app.id]);
      await failsWith(oauth.preview(stranger.ctx, request(app.clientId)), 'oauth.app_not_approved');
      await failsWith(oauth.decide(stranger.ctx, { ...request(app.clientId), decision: 'allow' }), 'oauth.app_not_approved');
      expect(await oauth.preview(dev.ctx, request(app.clientId))).toMatchObject({ appName: 'Ledger sync', developerOwnAccount: true });
      const approved = await oauth.reviewApp(op.ctx, { appId: app.id, decision: 'approve', reason: 'checked' });
      expect(approved.status).toBe('approved');
      expect((await oauth.reviewApp(op.ctx, { appId: app.id, decision: 'approve' })).status).toBe('approved');
      expect(await oauth.preview(stranger.ctx, request(app.clientId))).toMatchObject({
        developerOwnAccount: false,
        scopes: ['trade:read'],
      });
      const [row] = await db.sql<Array<{ reviewed_by: string; review_reason: string }>>`SELECT reviewed_by, review_reason FROM oauth_apps`;
      expect(row).toMatchObject({ reviewed_by: op.userId, review_reason: 'checked' });
    });

    it('suspending an app ends its live tokens and refuses new exchanges', async () => {
      const { op, app, clientSecret } = await approvedApp();
      const user = await person();
      const code = await allow(user.ctx, app.clientId);
      await oauth.exchange({
        code,
        redirectUri: REDIRECT,
        clientId: app.clientId,
        codeVerifier: VERIFIER,
        clientSecret: clientSecret as string,
      });
      await oauth.reviewApp(op.ctx, { appId: app.id, decision: 'suspend' });
      expect(await db.sql`SELECT 1 FROM oauth_tokens WHERE revoked_at IS NULL`).toHaveLength(0);
      const second = await allow(user.ctx, app.clientId).catch((e: OAuthError) => e.code);
      expect(second).toBe('oauth.app_not_approved');
    });
  });

  describe('authorisation code with PKCE', () => {
    it('echoes state, works once, stores only hashes, and a second use revokes the token', async () => {
      const { app, clientSecret } = await approvedApp();
      const user = await person();
      const decided = await oauth.decide(user.ctx, { ...request(app.clientId), decision: 'allow' });
      const url = new URL(decided.redirectTo);
      expect(url.origin + url.pathname).toBe(REDIRECT);
      expect(url.searchParams.get('state')).toBe('st-1');
      const code = url.searchParams.get('code') as string;
      const stored = await db.sql<
        Array<{ code_hash: string; code_challenge: string | null }>
      >`SELECT code_hash, code_challenge FROM oauth_codes`;
      expect(stored[0]?.code_hash).toBe(createHash('sha256').update(code).digest('hex'));
      expect(stored[0]?.code_challenge).toBe(CHALLENGE);
      const exchange = {
        code,
        redirectUri: REDIRECT,
        clientId: app.clientId,
        codeVerifier: VERIFIER,
        clientSecret: clientSecret as string,
      };
      const token = await oauth.exchange(exchange);
      expect(token).toMatchObject({ tokenType: 'Bearer', expiresIn: 3600, scope: ['trade:read'] });
      const tokens = await db.sql<Array<Record<string, unknown>>>`SELECT * FROM oauth_tokens`;
      expect(tokens).toHaveLength(1);
      expect(JSON.stringify(tokens[0])).not.toContain(token.accessToken);
      expect(tokens[0]?.token_hash).toBe(createHash('sha256').update(token.accessToken).digest('hex'));
      expect(tokens[0]?.revoked_at).toBeNull();
      expect(
        (await db.sql<Array<{ code_challenge: string | null }>>`SELECT code_challenge FROM oauth_codes`)[0]?.code_challenge,
      ).toBeNull();
      await failsWith(oauth.exchange(exchange), 'oauth.invalid_grant');
      expect((await db.sql<Array<{ revoked_at: Date | null }>>`SELECT revoked_at FROM oauth_tokens`)[0]?.revoked_at).not.toBeNull();
    });

    it('computes the RFC 7636 example challenge', () => {
      expect(s256(VERIFIER)).toBe(CHALLENGE);
    });

    it('spends the code on a wrong verifier, a bad-length verifier and a forbidden character', async () => {
      const { app, clientSecret } = await approvedApp();
      const user = await person();
      const base = { redirectUri: REDIRECT, clientId: app.clientId, clientSecret: clientSecret as string };
      for (const bad of ['x'.repeat(43), VERIFIER.slice(0, 42), VERIFIER + 'abcdefghij'.repeat(10), VERIFIER.slice(0, 42) + '!']) {
        const code = await allow(user.ctx, app.clientId);
        await failsWith(oauth.exchange({ ...base, code, codeVerifier: bad }), 'oauth.invalid_grant');
        await failsWith(oauth.exchange({ ...base, code, codeVerifier: VERIFIER }), 'oauth.invalid_grant');
      }
      expect(await db.sql`SELECT 1 FROM oauth_tokens`).toHaveLength(0);
    });

    it('refuses an expired code, another redirect URL and a code that belongs to another app', async () => {
      const { app, clientSecret } = await approvedApp();
      const other = await approvedApp();
      const user = await person();
      const base = { redirectUri: REDIRECT, clientId: app.clientId, clientSecret: clientSecret as string, codeVerifier: VERIFIER };
      const stale = await allow(user.ctx, app.clientId);
      clock = new Date(clock.getTime() + 301_000);
      await failsWith(oauth.exchange({ ...base, code: stale }), 'oauth.invalid_grant');
      const code = await allow(user.ctx, app.clientId);
      await failsWith(oauth.exchange({ ...base, code, redirectUri: 'https://app.example.test/other' }), 'oauth.invalid_grant');
      const mine = await allow(user.ctx, app.clientId);
      await failsWith(
        oauth.exchange({ ...base, code: mine, clientId: other.app.clientId, clientSecret: other.clientSecret as string }),
        'oauth.invalid_grant',
      );
      // The wrong client did not spend it.
      expect((await oauth.exchange({ ...base, code: mine })).scope).toEqual(['trade:read']);
    });

    it('refuses a redirect URL the app did not register and a scope it did not declare', async () => {
      const { app } = await approvedApp();
      const user = await person();
      await failsWith(
        oauth.preview(user.ctx, request(app.clientId, { redirectUri: 'https://evil.example.test/cb' })),
        'oauth.redirect_uri_mismatch',
      );
      await failsWith(
        oauth.decide(user.ctx, { ...request(app.clientId, { scope: ['trade:write'] }), decision: 'allow' }),
        'oauth.invalid_scope',
      );
      await failsWith(oauth.preview(user.ctx, request('ifc_unknown000')), 'oauth.app_not_found');
      expect(await db.sql`SELECT 1 FROM oauth_codes`).toHaveLength(0);
    });

    it('answers a denial with access_denied and the state, and issues nothing', async () => {
      const { app } = await approvedApp();
      const user = await person();
      const out = await oauth.decide(user.ctx, { ...request(app.clientId), decision: 'deny' });
      const url = new URL(out.redirectTo);
      expect(url.searchParams.get('error')).toBe('access_denied');
      expect(url.searchParams.get('state')).toBe('st-1');
      expect(url.searchParams.get('code')).toBeNull();
      expect(await db.sql`SELECT 1 FROM oauth_codes`).toHaveLength(0);
    });

    it('authenticates a confidential app by its secret and refuses a secret on a public app', async () => {
      const { app, clientSecret } = await approvedApp();
      const user = await person();
      const code = await allow(user.ctx, app.clientId);
      const base = { code, redirectUri: REDIRECT, clientId: app.clientId, codeVerifier: VERIFIER };
      await failsWith(oauth.exchange(base), 'oauth.invalid_client');
      await failsWith(oauth.exchange({ ...base, clientSecret: 'ifcs_wrong' }), 'oauth.invalid_client');
      expect((await oauth.exchange({ ...base, clientSecret: clientSecret as string })).tokenType).toBe('Bearer');

      const publicApp = await approvedApp({ confidential: false, name: 'Phone app' });
      const pcode = await allow(user.ctx, publicApp.app.clientId);
      const pbase = { code: pcode, redirectUri: REDIRECT, clientId: publicApp.app.clientId, codeVerifier: VERIFIER };
      await failsWith(oauth.exchange({ ...pbase, clientSecret: 'ifcs_x' }), 'oauth.invalid_client');
      expect((await oauth.exchange(pbase)).scope).toEqual(['trade:read']);
    });

    it('refuses to authorise or exchange for a frozen account', async () => {
      const { app, clientSecret } = await approvedApp();
      const user = await person();
      const code = await allow(user.ctx, app.clientId);
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${user.userId}`;
      await failsWith(oauth.decide(user.ctx, { ...request(app.clientId), decision: 'allow' }), 'oauth.account_not_active');
      await failsWith(
        oauth.exchange({
          code,
          redirectUri: REDIRECT,
          clientId: app.clientId,
          codeVerifier: VERIFIER,
          clientSecret: clientSecret as string,
        }),
        'oauth.account_not_active',
      );
      expect(await db.sql`SELECT 1 FROM oauth_tokens`).toHaveLength(0);
    });

    it('refuses an API key principal at the consent decision', async () => {
      const { app } = await approvedApp();
      const user = await person();
      const keyCtx = { ...user.ctx, principal: { ...user.ctx.principal!, kid: 'key-1' } } as Context;
      await failsWith(oauth.decide(keyCtx, { ...request(app.clientId), decision: 'allow' }), 'oauth.key_principal_refused');
    });
  });

  describe('a suspension racing the exchange', () => {
    it('wins over a token still being issued: the exchange waits for it and then refuses', async () => {
      const { app, clientSecret } = await approvedApp();
      const user = await person();
      const code = await allow(user.ctx, app.clientId);
      let release!: () => void;
      let held!: () => void;
      const locked = new Promise<void>((resolve) => (held = resolve));
      const suspending = db.sql.begin(async (tx) => {
        await tx`UPDATE oauth_apps SET status = 'suspended' WHERE id = ${app.id}`;
        held();
        await new Promise<void>((resolve) => (release = resolve));
      });
      await locked;
      const exchanging = oauth
        .exchange({ code, redirectUri: REDIRECT, clientId: app.clientId, codeVerifier: VERIFIER, clientSecret: clientSecret as string })
        .then(
          () => 'issued',
          (e: OAuthError) => e.code,
        );
      await new Promise((resolve) => setTimeout(resolve, 150));
      release();
      await suspending;
      expect(await exchanging).toBe('oauth.app_not_approved');
      expect(await db.sql`SELECT 1 FROM oauth_tokens`).toHaveLength(0);
    });
  });

  describe('owner lifetimes', () => {
    it('refuses to authorise or exchange while a lifetime is blank, and never defaults one', async () => {
      const { app, clientSecret } = await approvedApp();
      const user = await person();
      for (const blank of [{ codeTtlSeconds: undefined }, { accessTokenTtlSeconds: undefined }]) {
        const service = build(blank);
        await failsWith(service.preview(user.ctx, request(app.clientId)), 'oauth.lifetime_unset');
        await failsWith(service.decide(user.ctx, { ...request(app.clientId), decision: 'allow' }), 'oauth.lifetime_unset');
        await failsWith(
          service.exchange({
            code: 'x',
            redirectUri: REDIRECT,
            clientId: app.clientId,
            codeVerifier: VERIFIER,
            clientSecret: clientSecret as string,
          }),
          'oauth.lifetime_unset',
        );
      }
      expect(await db.sql`SELECT 1 FROM oauth_codes`).toHaveLength(0);
    });

    it('reads the lifetimes as published and a blank one as null, never a default', async () => {
      const user = await person();
      for (const [settings, want] of [
        [{ codeTtlSeconds: undefined }, { codeTtlSeconds: null }],
        [{ accessTokenTtlSeconds: undefined }, { accessTokenTtlSeconds: null }],
      ] as const) {
        const read = await createOAuthRouter(build(settings)).createCaller(user.ctx).oauth.lifetimes();
        expect(read).toMatchObject(want);
      }
      const both = build({ codeTtlSeconds: undefined, accessTokenTtlSeconds: undefined }).lifetimes();
      expect(both).toEqual({ codeTtlSeconds: null, accessTokenTtlSeconds: null });
      expect(build().lifetimes()).toEqual({
        codeTtlSeconds: settings.codeTtlSeconds,
        accessTokenTtlSeconds: settings.accessTokenTtlSeconds,
      });
    });
  });

  describe('router', () => {
    it('carries the oauth code as the message, and the token door needs no session', async () => {
      const { app, clientSecret } = await approvedApp();
      const user = await person();
      const caller = createOAuthRouter(oauth).createCaller(user.ctx);
      const anonymous = createOAuthRouter(oauth).createCaller({
        principal: null,
        service: null,
        region: 'DE',
        requestId: 'anon',
      } as Context);
      const preview = await caller.oauth.authorize.preview(request(app.clientId));
      expect(preview).toMatchObject({ appName: 'Ledger sync' });
      const { redirectTo } = await caller.oauth.authorize.decide({ ...request(app.clientId), decision: 'allow' });
      const token = await anonymous.oauth.token({
        grantType: 'authorization_code',
        code: codeOf(redirectTo),
        redirectUri: REDIRECT,
        clientId: app.clientId,
        codeVerifier: VERIFIER,
        clientSecret: clientSecret as string,
      });
      expect(token.accessToken).toMatch(/^ifct_/);
      await expect(
        anonymous.oauth.token({
          grantType: 'authorization_code',
          code: 'c',
          redirectUri: REDIRECT,
          clientId: app.clientId,
          codeVerifier: VERIFIER,
          clientSecret: clientSecret as string,
        }),
      ).rejects.toMatchObject({ message: 'oauth.invalid_grant' });
      await expect(anonymous.oauth.apps.list({ limit: 5 })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(caller.oauth.apps.queue({ status: 'pending', limit: 5 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await caller.oauth.apps.list({ limit: 5 })).apps).toEqual([]);
    });
  });
}
