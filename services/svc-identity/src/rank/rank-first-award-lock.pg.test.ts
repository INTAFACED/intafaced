import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { SESSION_SCOPES } from '@intafaced/auth';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from '../auth/auth-service.js';
import { RankService } from './rank-service.js';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced:intafaced@127.0.0.1:5432/intafaced_test';
const drizzleDir = join(process.cwd(), 'drizzle');
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
const PASSWORD_SESSION = { mfa: false, privileged: false } as const;
if (!(await postgresAvailable(URL))) throw new Error('postgres unavailable');
const db: TestDb = await createTestDb({
  service: 'identity',
  url: URL,
  migrations: migrations.map((b) => (s: string) => rewriteSchemaSql(b, 'identity', s)),
});
const bus = new MemoryEventBus('svc-identity');
const rank = new RankService(db.sql, bus);
const auth = new AuthService(db.sql, bus, rank, tokenConfig, webauthnConfig, randomBytes(32).toString('base64'), undefined, undefined, 25);
await rank.seedTiers();
let counter = 0;
const register = () => {
  const handle = `t${process.pid}${++counter}`;
  return auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
};
beforeEach(async () => {
  await db.truncateAll();
  await rank.seedTiers();
});
afterAll(async () => {
  await db.drop();
});
void SESSION_SCOPES;
void PASSWORD_SESSION;
void describe;
void it;
void expect;
describe('L257', () => {
  it('two concurrent first awards for a user with no rank_state row sum', async () => {
    const a = await register();
    await db.sql`DELETE FROM rank_state WHERE user_id = ${a.userId}`;
    const mk = (n: number, d: number) =>
      rank.awardXp({
        userId: a.userId,
        sourceModule: 'triage',
        action: 'a' + n,
        xpDelta: d,
        idempotencyKey: `t257:${a.userId}:${n}`,
      } as never);
    await Promise.all([mk(1, 10), mk(2, 20), mk(3, 30)]);
    const row = (await db.sql<Array<{ xp: string }>>`SELECT xp FROM rank_state WHERE user_id = ${a.userId}`)[0]!;
    expect(BigInt(row.xp)).toBe(60n);
  });
});
