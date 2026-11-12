import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { readAgentKey } from './agent-key-read.js';

/** svc-trade's agent-key read against real rows (J-agents-21 #6): the caller's own key, its kind, scopes and liveness. TEST values only. */

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
  secret: 'an-identity-agent-key-read-pg-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
if (!(await postgresAvailable(TEST_URL))) {
  describe.skip('agent key read (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_agent_key_read',
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
  const key = async (
    userId: string,
    kind: 'agent' | 'personal',
    scopes: string[],
    extra: { revoked?: boolean; expiresAt?: string } = {},
  ) => {
    const [row] = await db.sql<Array<{ id: string }>>`
      INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes, kind, revoked, expires_at)
      VALUES (${userId}, ${`k${++n}`}, ${`h${process.pid}-${n}`}, 'ifc_t', ${scopes}, ${kind}, ${extra.revoked ?? false},
        ${extra.expiresAt ?? null}::timestamptz)
      RETURNING id`;
    return row!.id;
  };

  describe('agent key read', () => {
    it("answers the caller's own key with its kind and sorted scopes, and another person's key as none", async () => {
      const me = await person();
      const other = await person();
      const mine = await key(me, 'agent', ['trade:write', 'trade:read']);
      const theirs = await key(other, 'agent', ['trade:write']);
      expect(await readAgentKey(db.sql, me, mine)).toEqual({
        state: 'found',
        keyId: mine,
        kind: 'agent',
        scopes: ['trade:read', 'trade:write'],
        revoked: false,
      });
      expect(await readAgentKey(db.sql, me, theirs)).toEqual({ state: 'none' });
      expect(await readAgentKey(db.sql, me, '22222222-2222-4222-8222-222222222222')).toEqual({ state: 'none' });
    });

    it('a personal key reads as personal; a revoked or expired key reads as revoked', async () => {
      const me = await person();
      expect(await readAgentKey(db.sql, me, await key(me, 'personal', ['trade:read']))).toMatchObject({ kind: 'personal', revoked: false });
      expect(await readAgentKey(db.sql, me, await key(me, 'agent', ['trade:read'], { revoked: true }))).toMatchObject({ revoked: true });
      expect(await readAgentKey(db.sql, me, await key(me, 'agent', ['trade:read'], { expiresAt: '2020-01-01T00:00:00Z' }))).toMatchObject({
        revoked: true,
      });
    });
  });
}
