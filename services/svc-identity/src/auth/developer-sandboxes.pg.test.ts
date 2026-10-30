/**
 * Named developer sandboxes and sandbox keys (`developerSandboxes.*`, DV-sandbox-01, J-developer-02 #2 and #3) against
 * Postgres: the blank and reached sandbox cap, the name rule, the request id as the business key, the sandbox-only
 * scopes refused before a factor is spent, the maker rule (pay scopes only for a sign-in that holds them), the key's
 * environment fixed at birth, a rotated key kept in its sandbox, and the account fence.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { mergeRouters } from '@intafaced/contracts';
import { sandboxCreateRequestId, sandboxKeyCreateRequestId } from '@intafaced/contracts/developer-sandboxes';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { AuthService, type KycTier } from './auth-service.js';
import { rotateApiKey } from './rotate-api-key.js';
import { parseApiKeyCapByTier, passkeyMintRule, type DeveloperKeysDeps } from './developer-keys.js';
import { parseSandboxCapByTier } from './developer-sandboxes.js';
import { createIdentityRouter } from '../router.js';
import { createDeveloperSandboxesRouter } from '../developer-sandboxes-router.js';
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
const tokenConfig = {
  secret: 'an-identity-developer-sandboxes-test-secret-long-enough',
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
  describe.skip('developer sandboxes (Postgres unavailable)', () => {
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
  let sandboxCaps: ReadonlyMap<KycTier, number> | null = null;
  /** The service's passkey mint rule, on only for the tests that check it (the other proofs here are TOTP). */
  let mintRule: DeveloperKeysDeps['mayMint'] = undefined;
  let n = 0;
  const unique = () => `ds${process.pid}${++n}`;

  beforeEach(async () => {
    caps = parseApiKeyCapByTier('none=3');
    sandboxCaps = null;
    mintRule = undefined;
    await db.truncateAll();
    await rank.seedTiers();
  });

  afterAll(async () => {
    await db.drop();
  });

  const appRouter = mergeRouters(
    createIdentityRouter(auth, rank, { registrationOpen: true }),
    createDeveloperSandboxesRouter({
      sql: db.sql,
      gate: auth,
      kycTier: (userId, executor) => auth.kycTier(userId, executor),
      get capByTier() {
        return caps;
      },
      get sandboxCapByTier() {
        return sandboxCaps;
      },
      baseUrl: 'http://localhost:14500',
      mayMint: async (userId, factor) => {
        await mintRule?.(userId, factor);
      },
    }),
  );

  async function register() {
    const handle = unique();
    return auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
  }

  /** The session's own scopes; `extra` adds the scopes a merchant grant would (the pay scopes). */
  async function caller(session: { userId: string; sessionId: string; accessToken: string }, apiKeyId?: string, extra: string[] = []) {
    const base = await verifyAccessToken(session.accessToken, tokenConfig);
    const principal =
      apiKeyId || extra.length > 0
        ? await verifyAccessToken(
            (
              await issueAccessToken(
                {
                  userId: session.userId,
                  sessionId: session.sessionId,
                  scopes: [...base.scopes, ...extra] as typeof base.scopes,
                  tier: 'none',
                  mfa: false,
                  ...(apiKeyId ? { apiKeyId } : {}),
                },
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

  const sandboxesOf = async (userId: string) =>
    db.sql<Array<{ name: string }>>`SELECT name FROM developer_sandboxes WHERE user_id = ${userId} ORDER BY created_at, id`;
  const keysOf = async (userId: string) =>
    db.sql<Array<{ id: string; name: string; mode: string; key_prefix: string; scopes: string[] }>>`
      SELECT id, name, mode, key_prefix, scopes FROM api_keys WHERE user_id = ${userId} ORDER BY created_at`;
  const unspent = async (p: { proofId: string }) =>
    (await db.sql`SELECT 1 FROM pay_step_up_proofs WHERE proof_id = ${p.proofId} AND consumed_at IS NULL`).length === 1;

  const make = (userId: string, name: string, listed: { id: string }[] = []) => ({
    name,
    requestId: sandboxCreateRequestId(userId, listed, name),
  });
  const keyAsk = (userId: string, sandboxId: string, name: string, scopes: string[]) => {
    const body = { name, scopes };
    return { ...body, sandboxId, requestId: sandboxKeyCreateRequestId(userId, sandboxId, [], body) };
  };

  describe('developerSandboxes.create', () => {
    it('makes the first sandbox with the cap blank, and refuses the second sandbox_cap_unset, writing nothing', async () => {
      const s = await register();
      const c = await caller(s);
      const first = await c.developerSandboxes.create(make(s.userId, 'development'));
      expect(first).toMatchObject({ sandbox: { name: 'development' }, replayed: false });
      await expect(c.developerSandboxes.create(make(s.userId, 'ci', [first.sandbox]))).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('[identity.sandbox_cap_unset]'),
      });
      expect(await sandboxesOf(s.userId)).toEqual([{ name: 'development' }]);
      const listed = await c.developerSandboxes.list();
      expect(listed.cap).toEqual({ limit: null, held: 1 });
      expect(listed.baseUrl).toBe('http://localhost:14500');
    });

    it('holds sandboxes up to the cap for the account level, then refuses sandbox_cap_reached', async () => {
      sandboxCaps = parseSandboxCapByTier('none=2');
      const s = await register();
      const c = await caller(s);
      const a = await c.developerSandboxes.create(make(s.userId, 'development'));
      const b = await c.developerSandboxes.create(make(s.userId, 'ci', [a.sandbox]));
      await expect(c.developerSandboxes.create(make(s.userId, 'staging', [a.sandbox, b.sandbox]))).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('[identity.sandbox_cap_reached]'),
      });
      expect((await sandboxesOf(s.userId)).map((row) => row.name)).toEqual(['development', 'ci']);
      expect((await c.developerSandboxes.list()).cap).toEqual({ limit: 2, held: 2 });
    });

    it('refuses even the first sandbox when the cap for the level is set to 0', async () => {
      sandboxCaps = parseSandboxCapByTier('none=0');
      const s = await register();
      const c = await caller(s);
      await expect(c.developerSandboxes.create(make(s.userId, 'development'))).rejects.toMatchObject({
        message: expect.stringContaining('[identity.sandbox_cap_reached]'),
      });
      expect(await sandboxesOf(s.userId)).toHaveLength(0);
    });

    it('refuses a level the cap leaves out as unset', async () => {
      sandboxCaps = parseSandboxCapByTier('full=3');
      const s = await register();
      const c = await caller(s);
      const a = await c.developerSandboxes.create(make(s.userId, 'development'));
      await expect(c.developerSandboxes.create(make(s.userId, 'ci', [a.sandbox]))).rejects.toMatchObject({
        message: expect.stringContaining('[identity.sandbox_cap_unset]'),
      });
      expect(await sandboxesOf(s.userId)).toHaveLength(1);
    });

    it('refuses a name already held in any case, and a blank name', async () => {
      sandboxCaps = parseSandboxCapByTier('none=3');
      const s = await register();
      const c = await caller(s);
      const a = await c.developerSandboxes.create(make(s.userId, 'development'));
      await expect(c.developerSandboxes.create(make(s.userId, 'DEVELOPMENT', [a.sandbox]))).rejects.toMatchObject({
        code: 'CONFLICT',
        message: expect.stringContaining('[identity.sandbox_name_taken]'),
      });
      await expect(c.developerSandboxes.create(make(s.userId, '   ', [a.sandbox]))).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('[identity.sandbox_name_invalid]'),
      });
      expect(await sandboxesOf(s.userId)).toHaveLength(1);
    });

    it('answers a repeat of the same request id with the same sandbox, and refuses that id for another name', async () => {
      const s = await register();
      const c = await caller(s);
      const ask = make(s.userId, 'development');
      const first = await c.developerSandboxes.create(ask);
      const again = await c.developerSandboxes.create(ask);
      expect(again).toEqual({ sandbox: first.sandbox, replayed: true });
      await expect(c.developerSandboxes.create({ ...ask, name: 'other' })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: expect.stringContaining('[identity.sandbox_request_conflict]'),
      });
      expect(await sandboxesOf(s.userId)).toHaveLength(1);
    });

    it('makes one sandbox when the same request races itself', async () => {
      const s = await register();
      const c = await caller(s);
      const ask = make(s.userId, 'development');
      const both = await Promise.all([c.developerSandboxes.create(ask), c.developerSandboxes.create(ask)]);
      expect(both[0].sandbox.id).toBe(both[1].sandbox.id);
      expect(await sandboxesOf(s.userId)).toHaveLength(1);
    });

    it('refuses an API key caller before anything is written', async () => {
      const s = await register();
      const c = await caller(s, randomUUID());
      await expect(c.developerSandboxes.create(make(s.userId, 'development'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringContaining('[identity.delegated_refused]'),
      });
      expect(await sandboxesOf(s.userId)).toHaveLength(0);
    });
  });

  describe('developerSandboxes.createKey', () => {
    /** A sandbox on an account whose sign-in holds the merchant pay scopes. */
    async function withSandbox() {
      const s = await register();
      const c = await caller(s, undefined, ['pay:read', 'pay:write']);
      const made = await c.developerSandboxes.create(make(s.userId, 'development'));
      return { s, c, sandboxId: made.sandbox.id };
    }

    it.each([[['trade:read']], [['trade:write']], [['pay:read', 'trade:read']], [['identity:read']]])(
      'refuses %j env.scope_not_sandboxable before the factor is spent, and makes nothing',
      async (scopes) => {
        const { s, c, sandboxId } = await withSandbox();
        const p = await proof(s);
        await expect(
          c.developerSandboxes.createKey({ ...keyAsk(s.userId, sandboxId, 'bot', scopes), factorProof: p }),
        ).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: expect.stringContaining('[env.scope_not_sandboxable]'),
        });
        expect(await keysOf(s.userId)).toHaveLength(0);
        expect(await unspent(p)).toBe(true);
      },
    );

    it('refuses an unknown scope with the key door code', async () => {
      const { s, c, sandboxId } = await withSandbox();
      await expect(
        c.developerSandboxes.createKey({ ...keyAsk(s.userId, sandboxId, 'bot', ['pay:nonsense']), factorProof: await proof(s) }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('[auth.scope_unknown]') });
      expect(await keysOf(s.userId)).toHaveLength(0);
    });

    it('refuses a pay scope the sign-in does not hold auth.scope_not_held before the factor is spent', async () => {
      const s = await register();
      const c = await caller(s);
      const made = await c.developerSandboxes.create(make(s.userId, 'development'));
      const p = await proof(s);
      await expect(
        c.developerSandboxes.createKey({ ...keyAsk(s.userId, made.sandbox.id, 'bot', ['pay:read']), factorProof: p }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('[auth.scope_not_held]') });
      expect(await keysOf(s.userId)).toHaveLength(0);
      expect(await unspent(p)).toBe(true);
    });

    it('keeps a rotated sandbox key in its sandbox', async () => {
      const { s, c, sandboxId } = await withSandbox();
      const made = await c.developerSandboxes.createKey({
        ...keyAsk(s.userId, sandboxId, 'bot', ['pay:read']),
        factorProof: await proof(s),
      });
      const rotated = await rotateApiKey(auth, db.sql, { userId: s.userId, keyId: made.record.id, grantorScopes: ['pay:read'] });
      expect(rotated.mode).toBe('sandbox');
      const keys = (await c.developerSandboxes.get({ sandboxId })).keys;
      expect(keys.map((k) => [k.id, k.revoked])).toEqual(
        expect.arrayContaining([
          [rotated.id, false],
          [made.record.id, true],
        ]),
      );
      expect(keys).toHaveLength(2);
    });

    it('refuses with no second factor and makes nothing', async () => {
      const { s, c, sandboxId } = await withSandbox();
      await expect(c.developerSandboxes.createKey(keyAsk(s.userId, sandboxId, 'bot', ['pay:read']))).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('[auth.step_up_required]'),
      });
      expect(await keysOf(s.userId)).toHaveLength(0);
    });

    it('mints a sandbox key once, links it to the sandbox, lists it, and answers a repeat without the secret', async () => {
      const { s, c, sandboxId } = await withSandbox();
      const ask = keyAsk(s.userId, sandboxId, 'bot', ['pay:read', 'pay:write']);
      const made = await c.developerSandboxes.createKey({ ...ask, factorProof: await proof(s) });
      expect(made.key).toMatch(/^ifc_test_/);
      expect(made.baseUrl).toBe('http://localhost:14500');
      expect(made.record).toMatchObject({ name: 'bot', mode: 'sandbox', scopes: ['pay:read', 'pay:write'], revoked: false });
      const stored = await keysOf(s.userId);
      expect(stored).toEqual([expect.objectContaining({ id: made.record.id, mode: 'sandbox', scopes: ['pay:read', 'pay:write'] })]);
      expect(made.key?.startsWith(stored[0]!.key_prefix)).toBe(true);
      const link = await db.sql`SELECT sandbox_id FROM developer_sandbox_keys WHERE api_key_id = ${made.record.id}`;
      expect(link).toEqual([{ sandbox_id: sandboxId }]);
      expect((await c.developerSandboxes.get({ sandboxId })).keys.map((k) => k.id)).toEqual([made.record.id]);
      const again = await c.developerSandboxes.createKey({ ...ask, factorProof: await proof(s) });
      expect(again).toMatchObject({ key: null, replayed: true, record: { id: made.record.id } });
      expect(await keysOf(s.userId)).toHaveLength(1);
    });

    it('never lets a key change its environment', async () => {
      const { s, c, sandboxId } = await withSandbox();
      const made = await c.developerSandboxes.createKey({
        ...keyAsk(s.userId, sandboxId, 'bot', ['pay:read']),
        factorProof: await proof(s),
      });
      await expect(db.sql`UPDATE api_keys SET mode = 'live' WHERE id = ${made.record.id}`).rejects.toThrow(/environment/);
      expect((await keysOf(s.userId))[0]!.mode).toBe('sandbox');
    });

    it('counts sandbox keys against the account key cap', async () => {
      caps = parseApiKeyCapByTier('none=1');
      const { s, c, sandboxId } = await withSandbox();
      await c.developerSandboxes.createKey({ ...keyAsk(s.userId, sandboxId, 'one', ['pay:read']), factorProof: await proof(s) });
      const p = await proof(s);
      await expect(
        c.developerSandboxes.createKey({ ...keyAsk(s.userId, sandboxId, 'two', ['pay:read']), factorProof: p }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('[identity.key_cap_reached]'),
      });
      expect(await keysOf(s.userId)).toHaveLength(1);
      expect(await unspent(p)).toBe(true);
    });

    it("refuses another account's sandbox as not found, and makes nothing", async () => {
      const { sandboxId } = await withSandbox();
      const other = await register();
      const c = await caller(other, undefined, ['pay:read']);
      await expect(
        c.developerSandboxes.createKey({ ...keyAsk(other.userId, sandboxId, 'bot', ['pay:read']), factorProof: await proof(other) }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('[identity.sandbox_not_found]') });
      await expect(c.developerSandboxes.get({ sandboxId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await keysOf(other.userId)).toHaveLength(0);
    });
    it('refuses a reused request id with a different key or a different sandbox, and makes nothing more', async () => {
      sandboxCaps = parseSandboxCapByTier('none=2');
      const { s, c, sandboxId } = await withSandbox();
      const ask = keyAsk(s.userId, sandboxId, 'bot', ['pay:read']);
      await c.developerSandboxes.createKey({ ...ask, factorProof: await proof(s) });
      await expect(
        c.developerSandboxes.createKey({ ...ask, scopes: ['pay:read', 'pay:write'], factorProof: await proof(s) }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('[identity.key_request_conflict]') });
      const other = await c.developerSandboxes.create(make(s.userId, 'ci', [{ id: sandboxId }]));
      await expect(
        c.developerSandboxes.createKey({ ...ask, sandboxId: other.sandbox.id, factorProof: await proof(s) }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('[identity.key_request_conflict]') });
      expect(await keysOf(s.userId)).toHaveLength(1);
      expect((await c.developerSandboxes.get({ sandboxId: other.sandbox.id })).keys).toEqual([]);
    });

    it('refuses a sandbox key named like a key the account holds, and makes nothing', async () => {
      const { s, c, sandboxId } = await withSandbox();
      await c.developerSandboxes.createKey({ ...keyAsk(s.userId, sandboxId, 'bot', ['pay:read']), factorProof: await proof(s) });
      await expect(
        c.developerSandboxes.createKey({ ...keyAsk(s.userId, sandboxId, 'bot', ['pay:write']), factorProof: await proof(s) }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('[identity.key_name_taken]') });
      expect(await keysOf(s.userId)).toHaveLength(1);
    });

    it('with the passkey mint rule on, an account with no passkey is refused and its factor is not spent', async () => {
      mintRule = passkeyMintRule(db.sql);
      const { s, c, sandboxId } = await withSandbox();
      const p = await proof(s);
      await expect(
        c.developerSandboxes.createKey({ ...keyAsk(s.userId, sandboxId, 'bot', ['pay:read']), factorProof: p }),
      ).rejects.toMatchObject({ message: expect.stringContaining('[auth.passkey_missing]') });
      expect(await keysOf(s.userId)).toHaveLength(0);
      expect(await unspent(p)).toBe(true);
    });
  });
}
