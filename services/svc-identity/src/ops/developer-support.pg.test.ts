import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from '../auth/auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { recordApiKeyCall } from '../auth/api-key-calls.js';
import { DeveloperSupportError, supportCalls, supportKeys } from './developer-support.js';

/** Support's read of one customer's keys and calls (J-developer-17): metadata and the error code only, one account only, audited. TEST values only. */

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) return 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const TEST_URL = testDatabaseUrl();
const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzleDir, file), 'utf8'));
const tokenConfig = {
  secret: 'an-identity-developer-support-pg-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
if (!(await postgresAvailable(TEST_URL))) {
  describe.skip('developer support lookup (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_developer_support',
    url: TEST_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, undefined, undefined, undefined, undefined, 5);
  await rank.seedTiers();
  afterAll(async () => {
    await db.drop();
  });
  let n = 0;
  const person = async () => {
    const handle = `ds${process.pid}${++n}`;
    return (await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' })).userId;
  };
  const hash = (i: number) => `${process.pid.toString(16).padStart(8, '0')}${String(i).padStart(56, '1')}`;
  const key = async (userId: string, ips: string[]) => {
    const keyHash = hash(++n);
    const [row] = await db.sql<Array<{ id: string }>>`
      INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes, ip_allowlist)
      VALUES (${userId}, ${`k${n}`}, ${keyHash}, 'ifc_t', ${['trade:read']}, ${ips})
      RETURNING id`;
    return { id: row!.id, keyHash };
  };
  const audits = async (actorId: string) =>
    (await db.sql`SELECT kind FROM operator_read_audit WHERE actor_id = ${actorId} ORDER BY created_at`).map((row) => String(row.kind));

  describe('developer support lookup', () => {
    it('finds one call of this account by request id with its error code, and never another account’s', async () => {
      const agent = await person();
      const customer = await person();
      const other = await person();
      const mine = await key(customer, ['127.0.0.1']);
      const theirs = await key(other, []);
      const rid = `r${process.pid}-${n}`;
      await recordApiKeyCall(db.sql, {
        keyHash: mine.keyHash,
        requestId: `${rid}-restricted`,
        method: 'POST',
        path: '/api/v1/orders',
        status: 403,
        errorCode: 'trade.account_restricted',
        clientIp: '10.0.0.9',
        at: '2026-11-21T08:00:00.000Z',
      });
      await recordApiKeyCall(db.sql, {
        keyHash: theirs.keyHash,
        requestId: `${rid}-other`,
        method: 'GET',
        path: '/api/v1/account/balance',
        status: 200,
        clientIp: null,
        at: '2026-11-21T08:00:01.000Z',
      });

      const found = await supportCalls(db.sql, { actorId: agent, input: { userId: customer, limit: 1, requestId: `${rid}-restricted` } });
      expect(found.calls).toEqual([
        {
          requestId: `${rid}-restricted`,
          keyId: mine.id,
          keyName: expect.any(String),
          keyPrefix: 'ifc_t',
          method: 'POST',
          path: '/api/v1/orders',
          status: 403,
          errorCode: 'trade.account_restricted',
          outsideIpList: true,
          at: '2026-11-21T08:00:00.000Z',
        },
      ]);
      // Another account's request id is not found on this account, exactly as one that never existed.
      for (const requestId of [`${rid}-other`, `${rid}-never`]) {
        await expect(supportCalls(db.sql, { actorId: agent, input: { userId: customer, limit: 1, requestId } })).rejects.toMatchObject({
          code: 'identity.developer_request_not_found',
        });
      }
      await expect(
        supportCalls(db.sql, { actorId: agent, input: { userId: customer, limit: 5, keyId: theirs.id } }),
      ).rejects.toBeInstanceOf(DeveloperSupportError);
      // Every read is audited, the refused ones too.
      expect(await audits(agent)).toEqual(['developer_calls', 'developer_calls', 'developer_calls', 'developer_calls']);
    });

    it('lists the account’s keys with no secret and no hash', async () => {
      const agent = await person();
      const customer = await person();
      const k = await key(customer, ['127.0.0.1']);
      const read = await supportKeys(db.sql, { actorId: agent, input: { userId: customer, limit: 50 } });
      expect(read.keys.map((row) => row.id)).toEqual([k.id]);
      expect(JSON.stringify(read)).not.toContain(k.keyHash);
      expect(Object.keys(read.keys[0]!).sort()).toEqual(
        [
          'createdAt',
          'expiresAt',
          'id',
          'ipAllowlist',
          'kind',
          'lastUsedAt',
          'mode',
          'name',
          'prefix',
          'revoked',
          'revokedAt',
          'revokedBy',
          'scopes',
        ].sort(),
      );
      expect(await audits(agent)).toEqual(['developer_keys']);
    });
  });
}
