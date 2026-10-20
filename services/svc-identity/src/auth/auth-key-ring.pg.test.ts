/**
 * Signing-key rotation with overlap, against Postgres (I-signin-sessions-31).
 * Given rotate, new tokens carry the new key id and old tokens still verify; given remove-old, old tokens fail;
 * rotate without an approval is refused; a missing key is refused. Secrets below are TEST fixtures.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { postgresAvailable, type TestDatabase } from '@intafaced/db';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { actionApprovalSchema } from '@intafaced/contracts';
import { createTestDatabase } from '../fixture-truncate.testkit.js';
import { ActionApprovalError } from './action-approval-service.js';
import { AuthKeyError, AuthKeyRing, parseAuthKeys } from './auth-key-ring.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(migrationDirectory, file), 'utf8'));

const LEGACY = 'test-legacy-secret-that-is-long-enough-1234';
const K2 = 'test-key-two-secret-that-is-long-enough-5678';
const K3 = 'test-key-three-secret-that-is-long-enough-90';
const base = { issuer: 'intafaced', audience: 'intafaced.api', accessTtlSeconds: 900 };
const input = { userId: randomUUID(), sessionId: randomUUID(), scopes: ['trade:read'] };
const actor = randomUUID();

/** Approvals that accept only a named id; anything else is refused the way the real service refuses. */
function approvals(accept: Set<string>) {
  return {
    async consume(
      _service: string,
      i: { approvalId: string; operationId: string; payloadHash: string; targetService: string; targetId: string; expectedVersion: string },
    ) {
      if (!accept.has(i.approvalId)) throw new ActionApprovalError('approval refused', 'action_approval.not_found');
      return actionApprovalSchema.parse({
        approvalId: i.approvalId,
        actionType: i.targetId,
        targetService: i.targetService,
        targetId: i.targetId,
        expectedVersion: i.expectedVersion,
        payloadHash: i.payloadHash,
        requesterId: 'requester',
        approverId: 'approver',
        policyVersion: 'v1',
        createdAt: '2026-09-09T12:00:00.000Z',
        expiresAt: '2026-09-09T12:10:00.000Z',
        status: 'CONSUMED',
        operationId: i.operationId,
      });
    },
  };
}

describe('parseAuthKeys', () => {
  it('reads id:secret pairs and refuses bad entries', () => {
    expect([...parseAuthKeys(` k2:${K2} , k3:${K3}`).keys()]).toEqual(['k2', 'k3']);
    expect(parseAuthKeys('').size).toBe(0);
    expect(() => parseAuthKeys('K2:' + K2)).toThrow();
    expect(() => parseAuthKeys('legacy:' + K2)).toThrow();
    expect(() => parseAuthKeys('k2:short')).toThrow();
    expect(() => parseAuthKeys(`k2:${K2},k2:${K3}`)).toThrow();
  });
});

const available = await postgresAvailable(url);
if (!available) {
  describe.skip('auth key ring (Postgres unavailable)', () => {
    it('requires isolated Postgres evidence', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'identity', url, migrations });
  afterAll(async () => {
    await db.drop();
  });

  describe('auth key ring', () => {
    it('rotates with overlap, then removes the old key', async () => {
      await db.sql`DELETE FROM auth_signing_keys`;
      const ring = new AuthKeyRing(db.sql, LEGACY, parseAuthKeys(`k2:${K2},k3:${K3}`), approvals(new Set(['a1', 'a2', 'a3'])));
      await ring.refresh();
      const config = ring.tokenConfig(base);

      const before = (await issueAccessToken(input, config)).token;
      expect(JSON.parse(Buffer.from(before.split('.')[0]!, 'base64url').toString()).kid).toBeUndefined();

      const rotated = await ring.rotate({ keyId: 'k2', actorId: actor, approvalId: 'a1', operationId: 'op1' });
      expect(rotated).toMatchObject({ activeKeyId: 'k2', previousKeyIds: ['legacy'], nextRemoval: ['legacy'] });

      const after = (await issueAccessToken(input, config)).token;
      expect(JSON.parse(Buffer.from(after.split('.')[0]!, 'base64url').toString()).kid).toBe('k2');
      await expect(verifyAccessToken(before, config)).resolves.toMatchObject({ userId: input.userId });
      await expect(verifyAccessToken(after, config)).resolves.toMatchObject({ userId: input.userId });

      // A second rotation keeps both earlier keys until they are removed.
      const second = await ring.rotate({ keyId: 'k3', actorId: actor, approvalId: 'a2', operationId: 'op2' });
      expect(second.activeKeyId).toBe('k3');
      expect([...second.previousKeyIds].sort()).toEqual(['k2', 'legacy']);

      const removed = await ring.removeOld({ actorId: actor, approvalId: 'a3', operationId: 'op3' });
      expect(removed).toMatchObject({ activeKeyId: 'k3', previousKeyIds: [], nextRemoval: null });
      await expect(verifyAccessToken(before, config)).rejects.toMatchObject({ code: 'token.invalid' });
      await expect(verifyAccessToken(after, config)).rejects.toMatchObject({ code: 'token.invalid' });
      // A removed id keeps its row, so it cannot come back as the signing key.
      await expect(ring.rotate({ keyId: 'k2', actorId: actor, approvalId: 'a1', operationId: 'op4' })).rejects.toMatchObject({
        code: 'auth_key.already_known',
      });
      const fresh = (await issueAccessToken(input, config)).token;
      await expect(verifyAccessToken(fresh, config)).resolves.toBeDefined();
    });

    it('refuses without an approval, with no key material, a reused id and nothing to remove', async () => {
      await db.sql`DELETE FROM auth_signing_keys`;
      const ring = new AuthKeyRing(db.sql, LEGACY, parseAuthKeys(`k2:${K2}`), approvals(new Set(['ok1', 'ok2'])));
      await ring.refresh();
      const cmd = { actorId: actor, operationId: 'op' };

      await expect(ring.rotate({ ...cmd, keyId: 'k2', approvalId: 'nope' })).rejects.toMatchObject({ code: 'auth_key.approval_required' });
      await expect(ring.rotate({ ...cmd, keyId: 'k9', approvalId: 'ok1' })).rejects.toMatchObject({ code: 'auth_key.material_missing' });
      await expect(ring.rotate({ ...cmd, keyId: 'legacy', approvalId: 'ok1' })).rejects.toBeInstanceOf(AuthKeyError);
      await expect(ring.removeOld({ ...cmd, approvalId: 'ok1' })).rejects.toMatchObject({ code: 'auth_key.nothing_to_remove' });
      expect((await ring.state()).activeKeyId).toBe('legacy');

      await ring.rotate({ ...cmd, keyId: 'k2', approvalId: 'ok1' });
      await expect(ring.rotate({ ...cmd, keyId: 'k2', approvalId: 'ok2' })).rejects.toMatchObject({ code: 'auth_key.already_known' });
      const rows = await db.sql<Array<{ state: string }>>`SELECT state FROM auth_signing_keys WHERE state = 'active'`;
      expect(rows).toHaveLength(1);
    });

    it('a second instance reads the same ring after refresh and never prints key material in state', async () => {
      await db.sql`DELETE FROM auth_signing_keys`;
      const a = new AuthKeyRing(db.sql, LEGACY, parseAuthKeys(`k2:${K2}`), approvals(new Set(['x'])));
      const b = new AuthKeyRing(db.sql, LEGACY, parseAuthKeys(`k2:${K2}`), approvals(new Set()));
      await a.rotate({ keyId: 'k2', actorId: actor, approvalId: 'x', operationId: 'op' });
      await b.refresh();
      const token = (await issueAccessToken(input, a.tokenConfig(base))).token;
      await expect(verifyAccessToken(token, b.tokenConfig(base))).resolves.toBeDefined();
      expect(JSON.stringify(await b.state())).not.toContain(K2);
    });
  });
}
