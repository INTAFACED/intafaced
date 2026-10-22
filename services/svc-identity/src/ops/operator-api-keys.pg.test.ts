import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { SESSION_SCOPES, issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from '../auth/auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { createOperatorOpsRouter } from './ops-router.js';
import { revokeApiKeyForUser } from './operator-api-keys.js';

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) return 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const TEST_URL = testDatabaseUrl();
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '../../drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzleDir, file), 'utf8'));

const tokenConfig = {
  secret: 'an-identity-dv-keys-04-pg-test-signing-secret',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

const available = await postgresAvailable(TEST_URL);

if (!available) {
  describe.skip('operator API key revoke (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: TEST_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, undefined, undefined, undefined, undefined, 5);
  await rank.seedTiers();
  let n = 0;
  const unique = () => `ok${process.pid}${++n}`;
  const person = async () => {
    const handle = unique();
    return auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
  };

  afterAll(async () => {
    await db.drop();
  });

  async function ctx(
    userId: string,
    sessionId: string,
    scopes: string[],
    mfa: boolean,
    extra: { kid?: string; service?: string } = {},
  ): Promise<Context> {
    const { token } = await issueAccessToken({ userId, sessionId, scopes, tier: 'none', mfa }, tokenConfig);
    const principal = await verifyAccessToken(token, tokenConfig);
    return {
      principal: extra.kid ? { ...principal, kid: extra.kid } : principal,
      service: extra.service ?? null,
      region: 'DE',
      requestId: 'dv-keys-04',
    } as Context;
  }

  /** An operator with admin:write, signed in on a second-factor session. */
  async function operator() {
    const op = await person();
    await db.sql`UPDATE sessions SET mfa = true WHERE id = ${op.sessionId}`;
    return { ...op, context: await ctx(op.userId, op.sessionId, ['admin:read', 'admin:write'], true) };
  }

  async function customerWithKey() {
    const u = await person();
    const made = await auth.createApiKey({ userId: u.userId, name: 'bot', scopes: ['identity:read'], grantorScopes: SESSION_SCOPES });
    return { ...u, keyId: made.id, key: made.key, prefix: made.prefix };
  }

  const auditRows = (keyId: string) =>
    db.sql<
      Array<{ actor_id: string; reason: string; client_request_id: string }>
    >`SELECT actor_id, reason, client_request_id FROM api_key_operator_revocations WHERE key_id = ${keyId}`;

  describe('operator revoke of one API key (DV-keys-04, KS-11)', () => {
    it('revokes at once with one audit row; a second revoke is a no-op returning the same record', async () => {
      const op = await operator();
      const c = await customerWithKey();
      const other = await auth.createApiKey({ userId: c.userId, name: 'other', scopes: ['identity:read'], grantorScopes: SESSION_SCOPES });
      expect(await auth.verifyApiKey(c.key)).not.toBeNull();

      const first = await revokeApiKeyForUser(db.sql, op.context, {
        userId: c.userId,
        keyId: c.keyId,
        reason: '  Customer reported the key leaked  ',
        clientRequestId: 'req-1',
      });
      expect(first).toMatchObject({
        userId: c.userId,
        keyId: c.keyId,
        changed: true,
        revocation: { actorId: op.userId, reason: 'Customer reported the key leaked' },
      });
      expect(await auth.verifyApiKey(c.key)).toBeNull();
      expect(await auth.verifyApiKey(other.key)).not.toBeNull();
      expect(await auditRows(c.keyId)).toEqual([
        { actor_id: op.userId, reason: 'Customer reported the key leaked', client_request_id: 'req-1' },
      ]);

      const second = await revokeApiKeyForUser(db.sql, op.context, {
        userId: c.userId,
        keyId: c.keyId,
        reason: 'A different reason',
        clientRequestId: 'req-2',
      });
      expect(second).toEqual({ ...first, changed: false });
      expect(await auditRows(c.keyId)).toHaveLength(1);
    });

    it('never returns a secret, hash or prefix through the router', async () => {
      const op = await operator();
      const c = await customerWithKey();
      const caller = createOperatorOpsRouter(db.sql).createCaller(op.context);
      const out = await caller.apiKeyOps.revoke({ userId: c.userId, keyId: c.keyId, reason: 'Abuse report', clientRequestId: 'r' });
      expect(out.changed).toBe(true);
      const text = JSON.stringify(out);
      expect(text).not.toContain(c.key);
      expect(text).not.toContain(c.prefix);
    });

    it('a key already revoked another way answers no-op without an operator audit row', async () => {
      const op = await operator();
      const c = await customerWithKey();
      await auth.revokeApiKey(c.userId, c.keyId);
      const out = await revokeApiKeyForUser(db.sql, op.context, {
        userId: c.userId,
        keyId: c.keyId,
        reason: 'Late report',
        clientRequestId: 'r',
      });
      expect(out).toEqual({ userId: c.userId, keyId: c.keyId, changed: false, revocation: null });
      expect(await auditRows(c.keyId)).toHaveLength(0);
    });

    it('refuses a blank reason or request id and changes nothing', async () => {
      const op = await operator();
      const c = await customerWithKey();
      await expect(
        revokeApiKeyForUser(db.sql, op.context, { userId: c.userId, keyId: c.keyId, reason: '   ', clientRequestId: 'r' }),
      ).rejects.toMatchObject({ code: 'identity.revoke_reason_unset' });
      await expect(
        revokeApiKeyForUser(db.sql, op.context, { userId: c.userId, keyId: c.keyId, reason: 'x'.repeat(501), clientRequestId: 'r' }),
      ).rejects.toMatchObject({ code: 'identity.revoke_reason_unset' });
      await expect(
        revokeApiKeyForUser(db.sql, op.context, { userId: c.userId, keyId: c.keyId, reason: 'Leak', clientRequestId: ' ' }),
      ).rejects.toMatchObject({ code: 'identity.client_request_id_unset' });
      expect(await auth.verifyApiKey(c.key)).not.toBeNull();
      expect(await auditRows(c.keyId)).toHaveLength(0);
    });

    it('answers not found for another account, an unknown key and a malformed id', async () => {
      const op = await operator();
      const c = await customerWithKey();
      const stranger = await person();
      for (const input of [
        { userId: stranger.userId, keyId: c.keyId },
        { userId: c.userId, keyId: randomUUID() },
        { userId: c.userId, keyId: 'not-a-uuid' },
      ]) {
        await expect(revokeApiKeyForUser(db.sql, op.context, { ...input, reason: 'Leak', clientRequestId: 'r' })).rejects.toMatchObject({
          code: 'auth.not_found',
        });
      }
      expect(await auth.verifyApiKey(c.key)).not.toBeNull();
    });

    it('refuses a caller without admin:write, a key or service principal, no second factor, and a dead session', async () => {
      const c = await customerWithKey();
      const input = { userId: c.userId, keyId: c.keyId, reason: 'Leak', clientRequestId: 'r' };
      const op = await operator();
      const refusals: Array<[Context, string]> = [
        [await ctx(op.userId, op.sessionId, ['admin:read'], true), 'operator.denied'],
        [await ctx(op.userId, op.sessionId, ['admin:write'], true, { kid: randomUUID() }), 'operator.denied'],
        [await ctx(op.userId, op.sessionId, ['admin:write'], true, { service: 'svc-trade' }), 'operator.denied'],
        [await ctx(op.userId, op.sessionId, ['admin:write'], false), 'mfa.required'],
        [{ principal: null, service: null, region: 'DE', requestId: 'x' } as unknown as Context, 'operator.denied'],
      ];
      for (const [context, code] of refusals) {
        await expect(revokeApiKeyForUser(db.sql, context, input)).rejects.toMatchObject({ code });
      }

      // The token claims a second factor but the session row does not.
      const noFactor = await person();
      await expect(
        revokeApiKeyForUser(db.sql, await ctx(noFactor.userId, noFactor.sessionId, ['admin:write'], true), input),
      ).rejects.toMatchObject({ code: 'mfa.required' });

      // A revoked operator session is refused even with a valid token.
      await db.sql`UPDATE sessions SET revoked = true WHERE id = ${op.sessionId}`;
      await expect(revokeApiKeyForUser(db.sql, op.context, input)).rejects.toMatchObject({ code: 'operator.denied' });

      expect(await auth.verifyApiKey(c.key)).not.toBeNull();
      expect(await auditRows(c.keyId)).toHaveLength(0);
    });

    it('maps refusals to tRPC codes with the typed code in the message', async () => {
      const op = await operator();
      const c = await customerWithKey();
      const ops = createOperatorOpsRouter(db.sql);
      const caller = ops.createCaller(op.context);
      await expect(
        caller.apiKeyOps.revoke({ userId: c.userId, keyId: randomUUID(), reason: 'Leak', clientRequestId: 'r' }),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(caller.apiKeyOps.revoke({ userId: c.userId, keyId: c.keyId, reason: ' ', clientRequestId: 'r' })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('identity.revoke_reason_unset'),
      });
      const weak = ops.createCaller(await ctx(op.userId, op.sessionId, ['admin:write'], false));
      await expect(weak.apiKeyOps.revoke({ userId: c.userId, keyId: c.keyId, reason: 'Leak', clientRequestId: 'r' })).rejects.toMatchObject(
        {
          code: 'UNAUTHORIZED',
        },
      );
    });
  });
}
