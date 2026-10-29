/**
 * The developer room's key detail, revoke and end date (DV-keys-03, J-developer-03 #1 and #9) against Postgres: a
 * revoked key says why (the person with their reason, an account freeze, the older revoke door), the detail shows the
 * IP policy and the owner's idle period (blank is `not set`), the end date narrows without a factor and widens only
 * with a fresh one, and a key can never move its own end date (T-8).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { mergeRouters } from '@intafaced/contracts';
import { apiKeyCreateRequestId, apiKeyRecordSchema, apiKeyRevokeInputSchema } from '@intafaced/contracts/api-keys';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { AuthService } from './auth-service.js';
import { checkRevokeReason, parseApiKeyCapByTier, parseApiKeyIdleExpirySeconds } from './developer-keys.js';
import { createIdentityRouter } from '../router.js';
import { createDeveloperKeysRouter } from '../developer-keys-router.js';
import { createApiKeyExpireRouter } from '../api-key-expire-router.js';
import { revokeAllApiKeys } from './revoke-all-api-keys.js';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';

describe('IDENTITY_API_KEY_IDLE_EXPIRY_SECONDS', () => {
  it('is null when blank and never defaults', () => {
    expect(parseApiKeyIdleExpirySeconds(undefined)).toBeNull();
    expect(parseApiKeyIdleExpirySeconds('  ')).toBeNull();
    expect(parseApiKeyIdleExpirySeconds('7776000')).toBe(7_776_000);
  });
  it('refuses anything but a positive whole number of seconds', () => {
    for (const raw of ['0', '-5', '1.5', '90d', '01', '12345678901']) {
      expect(() => parseApiKeyIdleExpirySeconds(raw), raw).toThrow(/IDENTITY_API_KEY_IDLE_EXPIRY_SECONDS/);
    }
  });
});

describe('the revoke reason', () => {
  it('is trimmed, blank is none, and too long, control or bidi characters refuse', () => {
    expect(checkRevokeReason(undefined)).toBeNull();
    expect(checkRevokeReason('   ')).toBeNull();
    expect(checkRevokeReason('  TEST: rotated ')).toBe('TEST: rotated');
    const bidi = ['‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩'];
    for (const bad of ['x'.repeat(201), 'line\nbreak', 'bell\u0007', ...bidi.map((mark) => `TEST ${mark}rotated`)]) {
      expect(() => checkRevokeReason(bad), JSON.stringify(bad)).toThrow(
        expect.objectContaining({ code: 'identity.key_revoke_reason_invalid' }),
      );
    }
  });

  it('keeps joiners and variation selectors, so emoji stay whole', () => {
    // A person at a computer: woman, zero-width joiner, laptop. A heart with a variation selector. A zero-width non-joiner.
    for (const good of ['rotated \u{1F469}‍\u{1F4BB}', 'thanks ❤️', 'zw‌nj']) {
      expect(checkRevokeReason(good)).toBe(good);
    }
  });

  it('counts code points, as the contract and the database do: 200 emoji pass, 201 refuse', () => {
    const emoji = '\u{1F511}';
    expect(checkRevokeReason(emoji.repeat(200))).toBe(emoji.repeat(200));
    expect(() => checkRevokeReason(emoji.repeat(201))).toThrow(expect.objectContaining({ code: 'identity.key_revoke_reason_invalid' }));
    expect(apiKeyRevokeInputSchema.safeParse({ keyId: randomUUID(), reason: emoji.repeat(200) }).success).toBe(true);
    expect(apiKeyRevokeInputSchema.safeParse({ keyId: randomUUID(), reason: emoji.repeat(201) }).success).toBe(false);
  });
});

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '').split('/')[0] ?? '';
  if (name.length > 0 && !name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const DATABASE_URL = testDatabaseUrl();
const tokenConfig = {
  secret: 'an-identity-developer-keys-detail-test-secret-long',
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
  describe.skip('developer key detail (Postgres unavailable)', () => {
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

  let idle: number | null = null;
  let n = 0;
  const unique = () => `dkd${process.pid}${++n}`;
  const DAY = 86_400_000;

  beforeEach(async () => {
    idle = null;
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
      capByTier: parseApiKeyCapByTier('none=5'),
      get idleExpirySeconds() {
        return idle;
      },
    }),
    createApiKeyExpireRouter(db.sql, auth),
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

  /** A proof row from a factor confirmed just now, bound to one action (and key). */
  async function proof(session: { userId: string; sessionId: string }, action = 'create', keyId: string | null = null) {
    const proofId = randomUUID();
    const now = new Date();
    await db.sql`
      INSERT INTO pay_step_up_proofs (proof_id, user_id, session_id, method, verified_at, expires_at, bound_action, bound_key_id)
      VALUES (${proofId}, ${session.userId}, ${session.sessionId}, 'totp', ${now}, ${new Date(now.getTime() + 300_000)}, ${action}, ${keyId})
    `;
    return { proofId };
  }

  async function makeKey(s: Awaited<ReturnType<typeof register>>, name: string, extra: { expiresAt?: string; ips?: string[] } = {}) {
    const body = { name, scopes: ['trade:read'], ...extra };
    const made = await (
      await caller(s)
    ).developerKeys.create({ ...body, requestId: apiKeyCreateRequestId(s.userId, [], body), factorProof: await proof(s) });
    return made.record;
  }

  describe('developerKeys.revoke', () => {
    it('revokes with no second factor, records the person and their reason, and the list shows it', async () => {
      const s = await register();
      const key = await makeKey(s, 'bot-1');
      const c = await caller(s);
      const out = await c.developerKeys.revoke({ keyId: key.id, reason: '  TEST: rotated ' });
      expect(out.changed).toBe(true);
      expect(out.record).toMatchObject({ id: key.id, revoked: true, revokedBy: 'owner', revokeReason: 'TEST: rotated' });
      expect(Date.parse(out.record.revokedAt!)).toBeGreaterThan(Date.now() - 60_000);
      const list = await c.developerKeys.list({ limit: 50 });
      expect(list.keys).toEqual([out.record]);
      expect(list.cap.live).toBe(0);
      // No factor was spent: the only audit row is the create's.
      const audit = await db.sql`SELECT action FROM api_key_action_audit WHERE user_id = ${s.userId}`;
      expect(audit).toEqual([{ action: 'create' }]);
    });

    it('takes no reason, and a repeat changes nothing and keeps the first reason', async () => {
      const s = await register();
      const key = await makeKey(s, 'bot-1');
      const c = await caller(s);
      const first = await c.developerKeys.revoke({ keyId: key.id });
      expect(first.record).toMatchObject({ revokedBy: 'owner', revokeReason: null });
      const again = await c.developerKeys.revoke({ keyId: key.id, reason: 'later words' });
      expect(again).toEqual({ record: first.record, changed: false });
    });

    it('refuses a bad reason and revokes nothing', async () => {
      const s = await register();
      const key = await makeKey(s, 'bot-1');
      await expect((await caller(s)).developerKeys.revoke({ keyId: key.id, reason: 'a\u0007b' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('[identity.key_revoke_reason_invalid]'),
      });
      const [row] = await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM api_keys WHERE id = ${key.id}`;
      expect(row!.revoked).toBe(false);
    });

    it("answers another account's key and a missing key alike, and touches neither", async () => {
      const owner = await register();
      const other = await register();
      const key = await makeKey(owner, 'bot-1');
      for (const keyId of [key.id, randomUUID()]) {
        await expect((await caller(other)).developerKeys.revoke({ keyId })).rejects.toMatchObject({
          code: 'NOT_FOUND',
          message: expect.stringContaining('[identity.key_not_found]'),
        });
      }
      const [row] = await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM api_keys WHERE id = ${key.id}`;
      expect(row!.revoked).toBe(false);
    });

    it('refuses a key principal before anything changes', async () => {
      const s = await register();
      const key = await makeKey(s, 'bot-1');
      await expect((await caller(s, key.id)).developerKeys.revoke({ keyId: key.id })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringContaining('[identity.delegated_refused]'),
      });
    });
  });

  describe('why a key was revoked', () => {
    it('an account freeze revokes every live key as account_freeze, and keeps an earlier owner revoke as it was', async () => {
      const s = await register();
      const mine = await makeKey(s, 'bot-1');
      const other = await makeKey(s, 'bot-2');
      const c = await caller(s);
      await c.developerKeys.revoke({ keyId: mine.id, reason: 'TEST: done' });
      await auth.freezeIdentity(s.userId);
      const rows = await db.sql<Array<{ id: string; revoked_cause: string; revoke_reason: string | null; revoked_at: Date | null }>>`
        SELECT id, revoked_cause, revoke_reason, revoked_at FROM api_keys WHERE user_id = ${s.userId}`;
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(mine.id)).toMatchObject({ revoked_cause: 'owner', revoke_reason: 'TEST: done' });
      expect(byId.get(other.id)).toMatchObject({ revoked_cause: 'account_freeze', revoke_reason: null });
      expect(byId.get(other.id)!.revoked_at).toBeInstanceOf(Date);
    });

    it('the older revoke door records the person too', async () => {
      const s = await register();
      const key = await makeKey(s, 'bot-1');
      const c = await caller(s);
      await c.apiKeys.revoke({ keyId: key.id });
      const detail = await c.developerKeys.get({ keyId: key.id });
      expect(detail.key).toMatchObject({ revoked: true, revokedBy: 'owner', revokeReason: null });
    });

    it('a key revoked before causes were recorded reads null, and the database refuses a cause on a live key', async () => {
      const s = await register();
      const key = await makeKey(s, 'bot-1');
      await db.sql`UPDATE api_keys SET revoked = true WHERE id = ${key.id}`;
      const detail = await (await caller(s)).developerKeys.get({ keyId: key.id });
      expect(detail.key).toMatchObject({ revoked: true, revokedAt: null, revokedBy: null, revokeReason: null });
      const live = await makeKey(s, 'bot-2');
      await expect(db.sql`UPDATE api_keys SET revoked_cause = 'owner' WHERE id = ${live.id}`).rejects.toThrow(/api_keys_revoked_fields_ck/);
      await expect(
        db.sql`UPDATE api_keys SET revoked = true, revoked_cause = 'account_freeze', revoke_reason = 'x' WHERE id = ${live.id}`,
      ).rejects.toThrow(/api_keys_revoke_reason_ck/);
    });
  });

  describe('developerKeys.get', () => {
    it('shows the key, its IP policy and the idle period: not set while blank, the owner value once set', async () => {
      const s = await register();
      const key = await makeKey(s, 'bot-1', { ips: ['203.0.113.7'] });
      const c = await caller(s);
      expect(await c.developerKeys.get({ keyId: key.id })).toEqual({ key, requireNonEmptyIpAllowlist: false, idleExpirySeconds: null });
      idle = 7_776_000;
      expect((await c.developerKeys.get({ keyId: key.id })).idleExpirySeconds).toBe(7_776_000);
      expect(JSON.stringify(await c.developerKeys.get({ keyId: key.id }))).not.toMatch(/key_hash|ifc_[A-Za-z0-9_-]{20,}/);
    });

    it("answers another account's key as not found", async () => {
      const owner = await register();
      const key = await makeKey(owner, 'bot-1');
      await expect((await caller(await register())).developerKeys.get({ keyId: key.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: expect.stringContaining('[identity.key_not_found]'),
      });
    });
  });

  describe('developerKeys.setExpiry', () => {
    it('gives a key with no end date its first one with no second factor, and the list shows it', async () => {
      const s = await register();
      const key = await makeKey(s, 'bot-1');
      const c = await caller(s);
      const expiresAt = new Date(Date.now() + 30 * DAY).toISOString();
      const out = await c.developerKeys.setExpiry({ keyId: key.id, expiresAt });
      expect(out.record.expiresAt).toBe(expiresAt);
      expect((await c.developerKeys.list({ limit: 50 })).keys[0]!.expiresAt).toBe(expiresAt);
    });

    it('brings an end date nearer with no factor, and needs a fresh one to push it later', async () => {
      const s = await register();
      const far = new Date(Date.now() + 30 * DAY).toISOString();
      const key = await makeKey(s, 'bot-1', { expiresAt: far });
      const c = await caller(s);
      const near = new Date(Date.now() + 10 * DAY).toISOString();
      expect((await c.developerKeys.setExpiry({ keyId: key.id, expiresAt: near })).record.expiresAt).toBe(near);
      await expect(c.developerKeys.setExpiry({ keyId: key.id, expiresAt: far })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('[auth.step_up_required]'),
      });
      const [kept] = await db.sql<Array<{ expires_at: Date }>>`SELECT expires_at FROM api_keys WHERE id = ${key.id}`;
      expect(kept!.expires_at.toISOString()).toBe(near);
      // A proof made for another action does not count.
      await expect(
        c.developerKeys.setExpiry({ keyId: key.id, expiresAt: far, factorProof: await proof(s, 'create') }),
      ).rejects.toMatchObject({ message: expect.stringContaining('[auth.step_up_required]') });
      const out = await c.developerKeys.setExpiry({ keyId: key.id, expiresAt: far, factorProof: await proof(s, 'expiry_widen', key.id) });
      expect(out.record.expiresAt).toBe(far);
      const audit = await db.sql`SELECT action, key_id FROM api_key_action_audit WHERE user_id = ${s.userId} AND action = 'expiry_widen'`;
      expect(audit).toEqual([{ action: 'expiry_widen', key_id: key.id }]);
    });

    it('refuses an end date in the past, a revoked key, and a key that is not yours', async () => {
      const s = await register();
      const key = await makeKey(s, 'bot-1');
      const c = await caller(s);
      await expect(c.developerKeys.setExpiry({ keyId: key.id, expiresAt: new Date(Date.now() - DAY).toISOString() })).rejects.toMatchObject(
        {
          code: 'BAD_REQUEST',
          message: expect.stringContaining('[identity.key_expiry_invalid]'),
        },
      );
      const soon = new Date(Date.now() + DAY).toISOString();
      await expect((await caller(await register())).developerKeys.setExpiry({ keyId: key.id, expiresAt: soon })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: expect.stringContaining('[identity.key_not_found]'),
      });
      await c.developerKeys.revoke({ keyId: key.id });
      await expect(c.developerKeys.setExpiry({ keyId: key.id, expiresAt: soon })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('[identity.key_not_live]'),
      });
      const [row] = await db.sql<Array<{ expires_at: Date | null }>>`SELECT expires_at FROM api_keys WHERE id = ${key.id}`;
      expect(row!.expires_at).toBeNull();
    });

    it('T-8: a key cannot move its own end date, even with a proof', async () => {
      const s = await register();
      const key = await makeKey(s, 'bot-1');
      const asKey = await caller(s, key.id);
      const later = new Date(Date.now() + DAY).toISOString();
      for (const factorProof of [undefined, await proof(s, 'expiry_widen', key.id)]) {
        await expect(asKey.developerKeys.setExpiry({ keyId: key.id, expiresAt: later, factorProof })).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: expect.stringContaining('[auth.delegate_cannot_grant]'),
        });
      }
      const [row] = await db.sql<Array<{ expires_at: Date | null }>>`SELECT expires_at FROM api_keys WHERE id = ${key.id}`;
      expect(row!.expires_at).toBeNull();
    });
  });

  describe('the older expireApiKey door, through the same writer', () => {
    it('narrows with no factor, needs a fresh one to widen, and never brings back an ended or revoked key', async () => {
      const s = await register();
      const far = new Date(Date.now() + 30 * DAY).toISOString();
      const key = await makeKey(s, 'bot-1', { expiresAt: far });
      const c = await caller(s);
      const near = new Date(Date.now() + 10 * DAY).toISOString();
      expect(await c.expireApiKey({ keyId: key.id, expiresAt: near })).toEqual({ id: key.id, expiresAt: near });
      await expect(c.expireApiKey({ keyId: key.id, expiresAt: far })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('[auth.step_up_required]'),
      });
      expect(await c.expireApiKey({ keyId: key.id, expiresAt: far, factorProof: await proof(s, 'expiry_widen', key.id) })).toEqual({
        id: key.id,
        expiresAt: far,
      });

      // Ending a key now still works with no factor (it narrows); afterwards nothing moves its end date again.
      const ended = await makeKey(s, 'bot-2');
      const past = new Date(Date.now() - 1000).toISOString();
      expect((await c.expireApiKey({ keyId: ended.id, expiresAt: past })).expiresAt).toBe(past);
      for (const factorProof of [undefined, await proof(s, 'expiry_widen', ended.id)]) {
        await expect(c.expireApiKey({ keyId: ended.id, expiresAt: far, factorProof })).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: expect.stringContaining('[identity.key_not_live]'),
        });
      }
      const [row] = await db.sql<Array<{ expires_at: Date }>>`SELECT expires_at FROM api_keys WHERE id = ${ended.id}`;
      expect(row!.expires_at.toISOString()).toBe(past);

      const gone = await makeKey(s, 'bot-3');
      await c.developerKeys.revoke({ keyId: gone.id });
      await expect(c.expireApiKey({ keyId: gone.id, expiresAt: near })).rejects.toMatchObject({
        message: expect.stringContaining('[identity.key_not_live]'),
      });
    });
  });

  describe('reasons in code points', () => {
    it('stores 200 emoji, a joined emoji and a variation selector, and every read still parses', async () => {
      const s = await register();
      const c = await caller(s);
      const reasons = ['\u{1F511}'.repeat(200), 'rotated \u{1F469}\u200d\u{1F4BB}', 'thanks \u2764\ufe0f'];
      for (const [index, reason] of reasons.entries()) {
        const key = await makeKey(s, `bot-${index}`);
        expect((await c.developerKeys.revoke({ keyId: key.id, reason })).record.revokeReason).toBe(reason);
        expect(apiKeyRecordSchema.parse((await c.developerKeys.get({ keyId: key.id })).key).revokeReason).toBe(reason);
      }
      const list = await c.developerKeys.list({ limit: 50 });
      expect(list.keys.map((key) => key.revokeReason).sort()).toEqual([...reasons].sort());
    });

    it('refuses 201 emoji at the door and a bidi override in the service, and revokes nothing', async () => {
      const s = await register();
      const key = await makeKey(s, 'bot-1');
      const c = await caller(s);
      await expect(c.developerKeys.revoke({ keyId: key.id, reason: '\u{1F511}'.repeat(201) })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      await expect(c.developerKeys.revoke({ keyId: key.id, reason: 'TEST \u202erotated' })).rejects.toMatchObject({
        message: expect.stringContaining('[identity.key_revoke_reason_invalid]'),
      });
      const [row] = await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM api_keys WHERE id = ${key.id}`;
      expect(row!.revoked).toBe(false);
    });
  });

  describe('keys the service or our team revoked', () => {
    it('a key undone before it was handed over reads system; a support recovery reads support', async () => {
      const s = await register();
      const undone = await makeKey(s, 'bot-1');
      const kept = await makeKey(s, 'bot-2');
      await auth.revokeApiKey(s.userId, undone.id, 'system');
      await revokeAllApiKeys(db.sql, s.userId, s.userId, 'support');
      const c = await caller(s);
      expect((await c.developerKeys.get({ keyId: undone.id })).key).toMatchObject({ revokedBy: 'system', revokeReason: null });
      expect((await c.developerKeys.get({ keyId: kept.id })).key).toMatchObject({ revokedBy: 'support', revokeReason: null });
    });
  });
}
