import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';

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
  secret: 'an-identity-s22-pg-test-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

const available = await postgresAvailable(TEST_URL);

if (!available) {
  describe.skip('trade identity auth (Postgres unavailable)', () => {
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
  const make = (kinds?: string[]) =>
    new AuthService(db.sql, bus, rank, tokenConfig, undefined, undefined, undefined, undefined, 5, undefined, undefined, kinds);
  const auth = make();
  await rank.seedTiers();
  let n = 0;
  const unique = () => `sk${process.pid}${++n}`;
  const person = async () => {
    const handle = unique();
    return auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
  };

  afterAll(async () => {
    await db.drop();
  });

  describe('sub-account kind and nickname', () => {
    it('stores a nickname and the standard kind, and lists them with the frozen flag', async () => {
      const u = await person();
      const made = await auth.createSubAccount(u.userId, 'strategy', undefined, { nickname: 'Alpha123' });
      const rows = await auth.listSubAccounts(u.userId, 10);
      expect(rows).toEqual([expect.objectContaining({ id: made.id, kind: 'standard', nickname: 'Alpha123', frozen: false })]);
    });

    it('refuses a nickname outside 5 to 20 letters or digits', async () => {
      const u = await person();
      for (const bad of ['abcd', 'a'.repeat(21), 'has space', 'under_score']) {
        await expect(auth.createSubAccount(u.userId, 'x', undefined, { nickname: bad })).rejects.toMatchObject({
          code: 'auth.sub_account_nickname_invalid',
        });
      }
    });

    it('refuses a duplicate nickname on one main account, case-insensitively, but allows it on another', async () => {
      const a = await person();
      const b = await person();
      await auth.createSubAccount(a.userId, 'one', undefined, { nickname: 'Desk001' });
      await expect(auth.createSubAccount(a.userId, 'two', undefined, { nickname: 'desk001' })).rejects.toMatchObject({
        code: 'auth.sub_account_nickname_taken',
      });
      await expect(auth.createSubAccount(b.userId, 'one', undefined, { nickname: 'Desk001' })).resolves.toHaveProperty('id');
    });

    it('keeps the cap: a nickname does not get around it', async () => {
      const u = await person();
      for (let i = 0; i < 5; i += 1) await auth.createSubAccount(u.userId, `s${i}`, undefined, { nickname: `Cap00${i}x` });
      await expect(auth.createSubAccount(u.userId, 's6', undefined, { nickname: 'Cap006x' })).rejects.toMatchObject({
        code: 'auth.sub_account_limit',
      });
    });

    it('never changes a nickname or kind once set', async () => {
      const u = await person();
      const made = await auth.createSubAccount(u.userId, 'fixed', undefined, { nickname: 'Fixed01' });
      await expect(db.sql`UPDATE sub_accounts SET nickname = 'Other001' WHERE id = ${made.id}`).rejects.toThrow(/immutable/);
      await expect(db.sql`UPDATE sub_accounts SET kind = 'spot' WHERE id = ${made.id}`).rejects.toThrow(/immutable/);
      await expect(db.sql`UPDATE sub_accounts SET revoked = true WHERE id = ${made.id}`).resolves.toBeDefined();
    });

    it('offers only standard until the owner lists another kind, and never derivatives', async () => {
      const u = await person();
      await expect(auth.createSubAccount(u.userId, 'k', undefined, { kind: 'spot' })).rejects.toMatchObject({
        code: 'auth.sub_account_kind_unavailable',
      });
      const listed = make(['spot', 'derivatives']);
      const made = await listed.createSubAccount(u.userId, 'k', undefined, { kind: 'spot' });
      expect((await listed.listSubAccounts(u.userId, 10))[0]).toMatchObject({ id: made.id, kind: 'spot' });
      await expect(listed.createSubAccount(u.userId, 'd', undefined, { kind: 'derivatives' })).rejects.toMatchObject({
        code: 'auth.sub_account_kind_unavailable',
      });
      await expect(make(['managed']).createSubAccount(u.userId, 'm', undefined, { kind: 'spot' })).rejects.toMatchObject({
        code: 'auth.sub_account_kind_unavailable',
      });
    });
  });
}
