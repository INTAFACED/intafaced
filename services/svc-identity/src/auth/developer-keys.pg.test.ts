/**
 * The developer room's key create (`developerKeys.create`, DV-keys-01, J-developer-03) against Postgres: the second
 * factor, the typed refusals, the shown-once secret, the request id as the business key, the name rule and the key
 * cap, including two creates racing for the last place.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { mergeRouters } from '@intafaced/contracts';
import { apiKeyCreateRequestId } from '@intafaced/contracts/api-keys';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { AuthService, type KycTier } from './auth-service.js';
import { parseApiKeyCapByTier, passkeyMintRule } from './developer-keys.js';
import { totp } from './totp.js';
import { createIdentityRouter } from '../router.js';
import { createDeveloperKeysRouter } from '../developer-keys-router.js';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '').split('/')[0] ?? '';
  if (name.length > 0 && !name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const DATABASE_URL = testDatabaseUrl();
const PASSWORD_SESSION = { mfa: false, privileged: false } as const;
const tokenConfig = {
  secret: 'an-identity-developer-keys-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const available = await postgresAvailable(DATABASE_URL);

if (!available) {
  describe.skip('developer keys (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: DATABASE_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, undefined, randomBytes(32).toString('base64'), undefined, undefined, 25);
  await rank.seedTiers();

  let caps: ReadonlyMap<KycTier, number> | null = parseApiKeyCapByTier('none=3');
  let passkeyRule = false;
  let n = 0;
  const unique = () => `dk${process.pid}${++n}`;

  beforeEach(async () => {
    caps = parseApiKeyCapByTier('none=3');
    passkeyRule = false;
    await db.truncateAll();
    await rank.seedTiers();
  });

  afterAll(async () => {
    await db.drop();
  });

  const appRouter = mergeRouters(
    createIdentityRouter(auth, rank, { registrationOpen: true }),
    createDeveloperKeysRouter({
      sql: db.sql,
      gate: auth,
      kycTier: (userId, executor) => auth.kycTier(userId, executor),
      get capByTier() {
        return caps;
      },
      mayMint: async (userId, factor) => {
        if (passkeyRule) await passkeyMintRule(db.sql)(userId, factor);
      },
    }),
  );

  async function register() {
    const handle = unique();
    return auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
  }

  async function caller(session: { userId: string; sessionId: string; accessToken: string }, apiKeyId?: string) {
    const base = await verifyAccessToken(session.accessToken, tokenConfig);
    const principal = apiKeyId
      ? await verifyAccessToken(
          (
            await issueAccessToken(
              { userId: session.userId, sessionId: session.sessionId, scopes: [...base.scopes], tier: 'none', mfa: false, apiKeyId },
              tokenConfig,
            )
          ).token,
          tokenConfig,
        )
      : base;
    return appRouter.createCaller({ principal, service: null, region: 'DE', requestId: 'r' });
  }

  /** A create-bound proof row from a factor confirmed just now. */
  async function proof(session: { userId: string; sessionId: string }) {
    const proofId = randomUUID();
    const now = new Date();
    await db.sql`
      INSERT INTO pay_step_up_proofs (proof_id, user_id, session_id, method, verified_at, expires_at, bound_action, bound_key_id)
      VALUES (${proofId}, ${session.userId}, ${session.sessionId}, 'totp', ${now}, ${new Date(now.getTime() + 300_000)}, 'create', NULL)
    `;
    return { proofId };
  }

  const keysOf = async (userId: string) => db.sql<Array<{ name: string; key_hash: string; revoked: boolean }>>`
    SELECT name, key_hash, revoked FROM api_keys WHERE user_id = ${userId} ORDER BY created_at`;

  const ask = (userId: string, name: string, extra: { scopes?: string[]; ips?: string[]; expiresAt?: string } = {}) => {
    const body = {
      name,
      scopes: extra.scopes ?? ['trade:read'],
      ...(extra.ips ? { ips: extra.ips } : {}),
      ...(extra.expiresAt ? { expiresAt: extra.expiresAt } : {}),
    };
    return { ...body, requestId: apiKeyCreateRequestId(userId, [], body) };
  };

  describe('developerKeys.create', () => {
    it('refuses with no second factor and makes nothing', async () => {
      const s = await register();
      await expect((await caller(s)).developerKeys.create(ask(s.userId, 'bot-1'))).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('[auth.step_up_required]'),
      });
      expect(await keysOf(s.userId)).toHaveLength(0);
    });

    it('shows the key once, stores only its hash, binds the IP list and end date, and lists them', async () => {
      const s = await register();
      const started = await auth.startTotpEnrolment(s.userId, PASSWORD_SESSION);
      await auth.confirmTotpEnrolment(s.userId, PASSWORD_SESSION, started.secret, totp(started.secret));
      const step = Math.floor(Date.now() / 30_000) + 1;
      const code = totp(started.secret, { at: new Date(step * 30_000) });
      const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
      const c = await caller(s);
      const made = await c.developerKeys.create({
        ...ask(s.userId, 'bot-1', { ips: [' 203.0.113.7 ', '2001:db8::1'], expiresAt }),
        factorProof: { totpCode: code },
      });
      expect(made.key).toMatch(/^ifc_/);
      expect(made.replayed).toBe(false);
      expect(made.record).toMatchObject({
        name: 'bot-1',
        mode: 'live',
        scopes: ['trade:read'],
        ipAllowlist: ['2001:db8::1', '203.0.113.7'],
        expiresAt,
      });
      expect(made.key!.startsWith(made.record.prefix)).toBe(true);
      const stored = await db.sql`SELECT * FROM api_keys WHERE user_id = ${s.userId}`;
      expect(JSON.stringify(stored)).not.toContain(made.key);
      const list = await c.developerKeys.list({ limit: 50 });
      expect(list.keys).toEqual([made.record]);
      expect(list.cap).toEqual({ limit: 3, live: 1 });
      const audit = await db.sql`SELECT action, factor FROM api_key_action_audit WHERE user_id = ${s.userId}`;
      expect(audit).toEqual([{ action: 'create', factor: 'totp' }]);
    });

    it('answers a repeat of the same request id with the record and no secret, and refuses it for another key', async () => {
      const s = await register();
      const c = await caller(s);
      const asked = ask(s.userId, 'bot-1');
      const first = await c.developerKeys.create({ ...asked, factorProof: await proof(s) });
      // No second factor: a repeat reveals only what the list shows.
      const again = await c.developerKeys.create(asked);
      expect(again).toEqual({ record: first.record, key: null, replayed: true });
      await expect(c.developerKeys.create({ ...asked, scopes: ['trade:read', 'trade:write'] })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: expect.stringContaining('[identity.key_request_conflict]'),
      });
      expect(await keysOf(s.userId)).toHaveLength(1);
    });

    it('refuses a second live key with the same name in any case, and allows it once the first is revoked', async () => {
      const s = await register();
      const c = await caller(s);
      const first = await c.developerKeys.create({ ...ask(s.userId, 'bot-1'), factorProof: await proof(s) });
      await expect(c.developerKeys.create({ ...ask(s.userId, 'BOT-1'), factorProof: await proof(s) })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: expect.stringContaining('[identity.key_name_taken]'),
      });
      await c.apiKeys.revoke({ keyId: first.record.id });
      const listed = [{ id: first.record.id, revoked: true }];
      const body = { name: 'BOT-1', scopes: ['trade:read'] };
      await c.developerKeys.create({ ...body, requestId: apiKeyCreateRequestId(s.userId, listed, body), factorProof: await proof(s) });
      expect((await keysOf(s.userId)).map((k) => [k.name, k.revoked])).toEqual([
        ['bot-1', true],
        ['BOT-1', false],
      ]);
    });

    it.each([
      [{ scopes: [] }, 'auth.scope_empty'],
      [{ scopes: ['trade:nonsense'] }, 'auth.scope_unknown'],
      [{ scopes: ['trade:withdraw'] }, 'auth.scope_interactive_only'],
      [{ scopes: ['admin:write'] }, 'auth.scope_interactive_only'],
      [{ scopes: ['agents:execute'] }, 'auth.scope_interactive_only'],
      [{ scopes: ['pay:read'] }, 'auth.scope_not_held'],
      [{ ips: ['10.0.0.0/8'] }, 'auth.ip_invalid'],
      [{ name: '   ' }, 'identity.key_name_invalid'],
      [{ expiresAt: new Date(Date.now() - 1000).toISOString() }, 'identity.key_expiry_invalid'],
    ])('refuses %j with %s and spends no factor', async (change, code) => {
      const s = await register();
      const c = await caller(s);
      const p = await proof(s);
      const body = { name: 'bot-1', scopes: ['trade:read'], ...change };
      await expect(
        c.developerKeys.create({ ...body, requestId: apiKeyCreateRequestId(s.userId, [], body), factorProof: p }),
      ).rejects.toMatchObject({
        message: expect.stringContaining(`[${code}]`),
      });
      expect(await keysOf(s.userId)).toHaveLength(0);
      const unspent = await db.sql`SELECT 1 FROM pay_step_up_proofs WHERE proof_id = ${p.proofId} AND consumed_at IS NULL`;
      expect(unspent).toHaveLength(1);
    });

    it('refuses an account without a verified passkey with a typed code, before the factor is spent', async () => {
      passkeyRule = true;
      const s = await register();
      const c = await caller(s);
      const p = await proof(s);
      await expect(c.developerKeys.create({ ...ask(s.userId, 'bot-1'), factorProof: p })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('[auth.passkey_missing]'),
      });
      expect(await keysOf(s.userId)).toHaveLength(0);
      expect(await db.sql`SELECT 1 FROM pay_step_up_proofs WHERE proof_id = ${p.proofId} AND consumed_at IS NULL`).toHaveLength(1);
    });

    it('lets a passkey that has not been used yet through only to a step-up that verifies it', async () => {
      passkeyRule = true;
      const s = await register();
      const c = await caller(s);
      const enrolled = { credentialId: 'cred-1', publicKey: 'pk', counter: 0 };
      await db.sql`UPDATE users SET webauthn_creds = ${db.sql.json([enrolled])} WHERE id = ${s.userId}`;
      // A code would be spent on a key the mint then refuses: refused first, the proof left unspent.
      const p = await proof(s);
      await expect(c.developerKeys.create({ ...ask(s.userId, 'bot-1'), factorProof: p })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('[auth.passkey_verify_unavailable]'),
      });
      expect(await db.sql`SELECT 1 FROM pay_step_up_proofs WHERE proof_id = ${p.proofId} AND consumed_at IS NULL`).toHaveLength(1);
      // With no factor the person is asked for the step-up.
      await expect(c.developerKeys.create(ask(s.userId, 'bot-1'))).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('[auth.step_up_required]'),
      });
      expect(await keysOf(s.userId)).toHaveLength(0);
      // Once the passkey has passed an assertion, a code-confirmed create goes through.
      await db.sql`UPDATE users SET webauthn_creds = ${db.sql.json([{ ...enrolled, lastVerifiedAt: new Date().toISOString() }])} WHERE id = ${s.userId}`;
      const made = await c.developerKeys.create({ ...ask(s.userId, 'bot-1'), factorProof: p });
      expect(made.key).toMatch(/^ifc_/);
    });

    it('refuses while the cap is blank, or not set for this verification level', async () => {
      const s = await register();
      const c = await caller(s);
      for (const blank of [null, parseApiKeyCapByTier('full=3')]) {
        caps = blank;
        await expect(c.developerKeys.create({ ...ask(s.userId, 'bot-1'), factorProof: await proof(s) })).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: expect.stringContaining('[identity.key_cap_unset]'),
        });
        expect((await c.developerKeys.list({ limit: 50 })).cap).toEqual({ limit: null, live: 0 });
      }
      expect(await keysOf(s.userId)).toHaveLength(0);
    });

    it('refuses the fourth live key at a cap of three; revoked and ended keys do not count', async () => {
      const s = await register();
      const c = await caller(s);
      const made = [];
      for (const name of ['a', 'b', 'c']) made.push(await c.developerKeys.create({ ...ask(s.userId, name), factorProof: await proof(s) }));
      await expect(c.developerKeys.create({ ...ask(s.userId, 'd'), factorProof: await proof(s) })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('[identity.key_cap_reached]'),
      });
      await c.apiKeys.revoke({ keyId: made[0]!.record.id });
      await db.sql`UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE id = ${made[1]!.record.id}`;
      await c.developerKeys.create({ ...ask(s.userId, 'd'), factorProof: await proof(s) });
      await c.developerKeys.create({ ...ask(s.userId, 'e'), factorProof: await proof(s) });
      expect((await c.developerKeys.list({ limit: 50 })).cap).toEqual({ limit: 3, live: 3 });
    });

    it('lets only one of two creates racing for the last place through', async () => {
      const s = await register();
      const c = await caller(s);
      caps = parseApiKeyCapByTier('none=1');
      const [p1, p2] = [await proof(s), await proof(s)];
      const results = await Promise.allSettled([
        c.developerKeys.create({ ...ask(s.userId, 'x'), factorProof: p1 }),
        c.developerKeys.create({ ...ask(s.userId, 'y'), factorProof: p2 }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(String(refused.reason.message)).toContain('[identity.key_cap_reached]');
      expect(await keysOf(s.userId)).toHaveLength(1);
    });

    it('makes one key when the same request id arrives twice at once', async () => {
      // Repeated, so the twin can land at each point of the other's path: before its replay read, between that read
      // and the name and cap checks, and while it waits for the lock.
      for (let round = 0; round < 8; round += 1) {
        const s = await register();
        const c = await caller(s);
        const asked = ask(s.userId, 'bot-1');
        const [p1, p2] = [await proof(s), await proof(s)];
        const results = await Promise.all([
          c.developerKeys.create({ ...asked, factorProof: p1 }),
          c.developerKeys.create({ ...asked, factorProof: p2 }),
        ]);
        expect(results.filter((r) => r.key !== null)).toHaveLength(1);
        expect(results[0]!.record.id).toBe(results[1]!.record.id);
        expect(await keysOf(s.userId)).toHaveLength(1);
      }
    });

    it('lets only one of two different requests for the same name through', async () => {
      const s = await register();
      const c = await caller(s);
      const [p1, p2] = [await proof(s), await proof(s)];
      const results = await Promise.allSettled([
        c.developerKeys.create({ ...ask(s.userId, 'bot-1'), factorProof: p1 }),
        c.developerKeys.create({ ...ask(s.userId, 'BOT-1', { scopes: ['trade:read', 'trade:write'] }), factorProof: p2 }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(String(refused.reason.message)).toContain('[identity.key_name_taken]');
      expect(await keysOf(s.userId)).toHaveLength(1);
    });

    it('frees the name of a key that has ended', async () => {
      const s = await register();
      const c = await caller(s);
      const made = await c.developerKeys.create({ ...ask(s.userId, 'bot-1'), factorProof: await proof(s) });
      await db.sql`UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE id = ${made.record.id}`;
      const again = await c.developerKeys.create({ ...ask(s.userId, 'bot-1', { scopes: ['trade:write'] }), factorProof: await proof(s) });
      expect(again.key).toMatch(/^ifc_/);
    });

    it('refuses an API key or a sub-account caller on every door', async () => {
      const s = await register();
      const c = await caller(s);
      const made = await c.developerKeys.create({ ...ask(s.userId, 'bot-1'), factorProof: await proof(s) });
      const asKey = await caller(s, made.record.id);
      for (const call of [
        () => asKey.developerKeys.create({ ...ask(s.userId, 'bot-2'), factorProof: { proofId: randomUUID() } }),
        () => asKey.developerKeys.list({ limit: 50 }),
        () => asKey.developerKeys.scopes(),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('[identity.delegated_refused]') });
      }
      expect(await keysOf(s.userId)).toHaveLength(1);
    });

    it('describes the scopes a key may hold, and why withdraw never can', async () => {
      const s = await register();
      const { scopes } = await (await caller(s)).developerKeys.scopes();
      expect(scopes).toContainEqual({ scope: 'trade:read', access: 'read', onKey: true, blockedBy: null });
      expect(scopes).toContainEqual({ scope: 'trade:write', access: 'write', onKey: true, blockedBy: null });
      expect(scopes).toContainEqual({ scope: 'trade:withdraw', access: 'write', onKey: false, blockedBy: 'interactive_only' });
      expect(scopes.some((entry) => entry.scope.startsWith('admin:'))).toBe(false);
    });
  });
}
