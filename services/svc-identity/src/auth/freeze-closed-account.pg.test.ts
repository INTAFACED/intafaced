import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { SESSION_SCOPES } from '@intafaced/auth';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';

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
it('freeze then unfreeze leaves a closed account closed', async () => {
  const s = await register();
  await db.sql`UPDATE users SET status = 'closed' WHERE id = ${s.userId}`;
  await auth.freezeIdentity(s.userId).catch(() => undefined);
  await auth.unfreezeIdentity(s.userId).catch(() => undefined);
  const [u] = await db.sql<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${s.userId}`;
  expect(u!.status).toBe('closed');
});

describe('sign-in names the account state only after the password verified (J-identity-02 #7)', () => {
  const PASSWORD = 'correct horse battery staple';
  it.each(['frozen', 'closed'] as const)('a %s account answers auth.account_frozen with that state', async (state) => {
    const s = await register();
    await db.sql`UPDATE users SET status = ${state} WHERE id = ${s.userId}`;
    const [u] = await db.sql<Array<{ email: string }>>`SELECT email::text AS email FROM users WHERE id = ${s.userId}`;
    await expect(auth.login({ identifier: u!.email, password: PASSWORD })).rejects.toMatchObject({
      code: 'auth.account_frozen',
      details: { accountState: state },
    });
  });

  it('a wrong password on a frozen or closed account names nothing', async () => {
    for (const state of ['frozen', 'closed'] as const) {
      const s = await register();
      await db.sql`UPDATE users SET status = ${state} WHERE id = ${s.userId}`;
      const err = await auth
        .login({ identifier: `t${process.pid}${counter}`, password: 'wrong horse battery staple' })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'auth.invalid_credentials' });
      expect((err as { details?: unknown }).details).toBeUndefined();
    }
  });
});
