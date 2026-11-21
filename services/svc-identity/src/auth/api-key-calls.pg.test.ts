import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { ApiKeyCallsError, listApiKeyCalls, recordApiKeyCall } from './api-key-calls.js';

/** A key's call log against real rows (J-developer-08): recorded once per request id, flagged outside the IP list, owner-only. TEST values only. */

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
  secret: 'an-identity-api-key-calls-pg-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
if (!(await postgresAvailable(TEST_URL))) {
  describe.skip('api key call log (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_api_key_calls',
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
    const handle = `ak${process.pid}${++n}`;
    return (await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' })).userId;
  };
  const hash = (i: number) => `${process.pid.toString(16).padStart(8, '0')}${String(i).padStart(56, '0')}`;
  const key = async (userId: string, ips: string[], revoked = false) => {
    const keyHash = hash(++n);
    const [row] = await db.sql<Array<{ id: string }>>`
      INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes, ip_allowlist, revoked)
      VALUES (${userId}, ${`k${n}`}, ${keyHash}, 'ifc_t', ${['trade:read']}, ${ips}, ${revoked})
      RETURNING id`;
    return { id: row!.id, keyHash };
  };
  const call = (
    keyHash: string,
    requestId: string,
    status: number,
    clientIp: string | null,
    at: string,
    path = '/api/v1/account/balance',
  ) => ({
    keyHash,
    requestId,
    method: 'GET',
    path,
    status,
    clientIp,
    at,
  });

  describe('api key call log', () => {
    it('records each call once, flags the one from outside the IP list, and keeps no query or address', async () => {
      const me = await person();
      const k = await key(me, ['127.0.0.1']);
      const rid = `r${process.pid}-${n}`;
      expect(await recordApiKeyCall(db.sql, call(k.keyHash, `${rid}-a`, 200, '127.0.0.1', '2026-11-12T08:00:00.000Z'))).toEqual({
        recorded: true,
      });
      // A repeated report of the same request writes nothing new.
      expect(await recordApiKeyCall(db.sql, call(k.keyHash, `${rid}-a`, 200, '127.0.0.1', '2026-11-12T08:00:00.000Z'))).toEqual({
        recorded: true,
      });
      await recordApiKeyCall(db.sql, call(k.keyHash, `${rid}-b`, 403, '127.0.0.1', '2026-11-12T08:00:01.000Z', '/api/v1/orders?secret=x'));
      await recordApiKeyCall(db.sql, call(k.keyHash, `${rid}-c`, 401, '127.0.0.2', '2026-11-12T08:00:02.000Z'));
      const log = await listApiKeyCalls(db.sql, me, { keyId: k.id, limit: 50 }, new Date('2026-11-12T09:00:00.000Z'));
      expect(log.asOf).toBe('2026-11-12T09:00:00.000Z');
      expect(log.calls).toEqual([
        {
          requestId: `${rid}-c`,
          method: 'GET',
          path: '/api/v1/account/balance',
          status: 401,
          outsideIpList: true,
          at: '2026-11-12T08:00:02.000Z',
        },
        { requestId: `${rid}-b`, method: 'GET', path: '/api/v1/orders', status: 403, outsideIpList: false, at: '2026-11-12T08:00:01.000Z' },
        {
          requestId: `${rid}-a`,
          method: 'GET',
          path: '/api/v1/account/balance',
          status: 200,
          outsideIpList: false,
          at: '2026-11-12T08:00:00.000Z',
        },
      ]);
      const stored = await db.sql`SELECT * FROM api_key_calls WHERE key_id = ${k.id}`;
      expect(JSON.stringify(stored)).not.toContain('127.0.0.');
      expect(JSON.stringify(stored)).not.toContain('secret=x');
    });

    it('narrows by status and by UTC day, inclusive of the last day', async () => {
      const me = await person();
      const k = await key(me, []);
      const rid = `s${process.pid}-${n}`;
      await recordApiKeyCall(db.sql, call(k.keyHash, `${rid}-1`, 200, null, '2026-11-10T23:59:59.000Z'));
      await recordApiKeyCall(db.sql, call(k.keyHash, `${rid}-2`, 403, null, '2026-11-11T00:00:00.000Z'));
      await recordApiKeyCall(db.sql, call(k.keyHash, `${rid}-3`, 403, null, '2026-11-11T23:59:59.000Z'));
      const ids = async (filter: { status?: number; from?: string; to?: string }) =>
        (await listApiKeyCalls(db.sql, me, { keyId: k.id, limit: 50, ...filter })).calls.map((c) => c.requestId);
      expect(await ids({ status: 403 })).toEqual([`${rid}-3`, `${rid}-2`]);
      expect(await ids({ from: '2026-11-11', to: '2026-11-11' })).toEqual([`${rid}-3`, `${rid}-2`]);
      expect(await ids({ status: 200, from: '2026-11-11' })).toEqual([]);
      expect(await ids({ to: '2026-11-10' })).toEqual([`${rid}-1`]);
      // An empty IP list flags nothing.
      expect((await listApiKeyCalls(db.sql, me, { keyId: k.id, limit: 50 })).calls.every((c) => !c.outsideIpList)).toBe(true);
    });

    it("refuses another person's key as not found, and an unknown key's call records nothing", async () => {
      const me = await person();
      const other = await person();
      const theirs = await key(other, []);
      await recordApiKeyCall(db.sql, call(theirs.keyHash, `t${process.pid}-${n}`, 200, null, '2026-11-12T08:00:00.000Z'));
      await expect(listApiKeyCalls(db.sql, me, { keyId: theirs.id, limit: 50 })).rejects.toBeInstanceOf(ApiKeyCallsError);
      expect(await recordApiKeyCall(db.sql, call(hash(999_999), `u${process.pid}`, 200, null, '2026-11-12T08:00:00.000Z'))).toEqual({
        recorded: false,
      });
    });

    it("records a revoked key's refused call on its log", async () => {
      const me = await person();
      const k = await key(me, [], true);
      await recordApiKeyCall(db.sql, call(k.keyHash, `v${process.pid}-${n}`, 401, null, '2026-11-12T08:00:00.000Z'));
      expect((await listApiKeyCalls(db.sql, me, { keyId: k.id, limit: 50 })).calls.map((c) => c.status)).toEqual([401]);
    });
  });
}
