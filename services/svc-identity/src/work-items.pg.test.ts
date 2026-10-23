import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { SESSION_SCOPES, issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDb } from './fixture-truncate.testkit.js';
import { AuthService } from './auth/auth-service.js';
import { RankService } from './rank/rank-service.js';
import { createWorkItemsRouter } from './work-items.js';

/** `workItems.list` against Postgres: the newest record decides the one verification item, for the signed person only. */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));
const tokenConfig = {
  secret: 'an-identity-work-items-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('identity work items (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_work_items',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig);
  const router = createWorkItemsRouter(db.sql);
  let n = 0;

  afterAll(async () => {
    await db.drop();
  });

  async function signUp() {
    n += 1;
    const handle = `wi${process.pid}x${n}`;
    return (await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' })).userId;
  }
  async function as(userId: string, extra: Record<string, unknown> = {}) {
    const { token } = await issueAccessToken(
      { userId, sessionId: '44444444-4444-4444-8444-444444444444', scopes: [...SESSION_SCOPES], tier: 'none', mfa: true },
      tokenConfig,
    );
    const ctx: Context = {
      principal: { ...(await verifyAccessToken(token, tokenConfig)), ...extra },
      service: null,
      region: 'DE',
      requestId: 'r',
    };
    return router.createCaller(ctx);
  }

  it('follows the newest record: start, under review, approved (nothing), and a newer rejection', async () => {
    const me = await signUp();
    const other = await signUp();
    const api = await as(me);
    expect((await api.workItems.list()).items).toEqual([
      expect.objectContaining({ id: `verification:${me}`, titleKey: 'identity.verification.start', severity: 'action' }),
    ]);

    const first = await auth.submitKyc({ userId: me, tier: 'basic', jurisdiction: 'DE' });
    expect((await api.workItems.list()).items).toEqual([
      expect.objectContaining({ id: `verification:${first.id}`, titleKey: 'identity.verification.pending', severity: 'info' }),
    ]);

    await db.sql`UPDATE kyc_records SET status = 'approved', reviewed_at = now() WHERE id = ${first.id}`;
    expect((await api.workItems.list()).items).toEqual([]);

    // A rejected upgrade does not nag while the basic approval is live; once that lapses, the rejection asks again.
    const second = await auth.submitKyc({ userId: me, tier: 'full', jurisdiction: 'DE' });
    expect((await api.workItems.list()).items).toEqual([
      expect.objectContaining({ id: `verification:${second.id}`, titleKey: 'identity.verification.pending' }),
    ]);
    await db.sql`UPDATE kyc_records SET status = 'rejected', reviewed_at = now() WHERE id = ${second.id}`;
    expect((await api.workItems.list()).items).toEqual([]);
    await db.sql`UPDATE kyc_records SET expires_at = now() - interval '1 minute' WHERE id = ${first.id}`;
    expect((await api.workItems.list()).items).toEqual([
      expect.objectContaining({ id: `verification:${second.id}`, titleKey: 'identity.verification.rejected' }),
    ]);

    // Someone else's records never show here.
    expect((await (await as(other)).workItems.list()).items).toEqual([
      expect.objectContaining({ id: `verification:${other}`, titleKey: 'identity.verification.start' }),
    ]);
  });

  it('names a lapsed approval, and refuses an API key or a sub-account', async () => {
    const me = await signUp();
    const record = await auth.submitKyc({ userId: me, tier: 'basic', jurisdiction: 'DE' });
    await db.sql`UPDATE kyc_records SET status = 'approved', reviewed_at = now(), expires_at = now() - interval '1 day' WHERE id = ${record.id}`;
    const [item] = (await (await as(me)).workItems.list()).items;
    expect(item).toMatchObject({ titleKey: 'identity.verification.expired', severity: 'action', dueAt: expect.any(String) });

    for (const extra of [{ kid: 'key-1' }, { sub_account: '55555555-5555-4555-8555-555555555555' }]) {
      await expect((await as(me, extra)).workItems.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });
}
