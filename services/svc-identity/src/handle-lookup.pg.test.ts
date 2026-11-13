import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, afterAll } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { SESSION_SCOPES, issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDb } from './fixture-truncate.testkit.js';
import { AuthService } from './auth/auth-service.js';
import { RankService } from './rank/rank-service.js';
import { createIdentityRouter } from './router.js';
import { PgHandleLookupLimiter } from './handle-lookup.js';

/**
 * Pay-by-@handle lookup against real Postgres: the SQL is what decides "exact"
 * and "case-insensitive", and what makes frozen and closed accounts look the
 * same as accounts that do not exist.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
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

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('handle lookup (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_handle',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig);
  const router = createIdentityRouter(auth, rank, { registrationOpen: true });

  afterAll(async () => {
    await db.drop();
  });

  async function signUp(handle: string) {
    const s = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
    return s.userId;
  }

  async function as(userId: string) {
    const { token } = await issueAccessToken(
      { userId, sessionId: '44444444-4444-4444-8444-444444444444', scopes: [...SESSION_SCOPES], tier: 'none', mfa: true },
      tokenConfig,
    );
    const ctx: Context = { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'r' };
    return router.createCaller(ctx);
  }

  describe('identity.users.resolveHandle (real Postgres)', () => {
    it('matches the exact handle, case-insensitively, and returns the stored casing', async () => {
      const sender = await signUp('Sender_One');
      const friend = await signUp('Straw_Hat');
      const api = await as(sender);
      for (const q of ['Straw_Hat', 'straw_hat', 'STRAW_HAT', '@sTRAW_hAT']) {
        const hit = await api.users.resolveHandle({ handle: q });
        expect(hit).toEqual({ found: true, userId: friend, handle: 'Straw_Hat', self: false });
      }
    });

    it('does not match a prefix, a longer handle, or a wildcard', async () => {
      const sender = await signUp('Sender_Two');
      await signUp('Zoro_Roronoa');
      const api = await as(sender);
      for (const q of ['Zoro', 'Zoro_Roronoa_', 'Zoro_R%', 'Zoro_Ronoa']) {
        expect(await api.users.resolveHandle({ handle: q })).toEqual({ found: false });
      }
    });

    it('answers a frozen and a closed account exactly like an unknown handle', async () => {
      const sender = await signUp('Sender_Three');
      const frozen = await signUp('Frozen_Pal');
      const closed = await signUp('Closed_Pal');
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${frozen}`;
      await db.sql`UPDATE users SET status = 'closed' WHERE id = ${closed}`;
      const api = await as(sender);
      const unknown = await api.users.resolveHandle({ handle: 'never_registered' });
      expect(unknown).toEqual({ found: false });
      expect(await api.users.resolveHandle({ handle: 'frozen_pal' })).toEqual(unknown);
      expect(await api.users.resolveHandle({ handle: 'closed_pal' })).toEqual(unknown);
    });

    it('answers the payee card by user id: the chosen name and the month joined, null for no name, nothing for a frozen account', async () => {
      const sender = await signUp('Card_Sender');
      const friend = await signUp('Card_Friend');
      const nameless = await signUp('Card_Nameless');
      const frozen = await signUp('Card_Frozen');
      await db.sql`UPDATE profiles SET display_name = 'Nami Navigator' WHERE user_id = ${friend}`;
      await db.sql`UPDATE profiles SET display_name = NULL WHERE user_id = ${nameless}`;
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${frozen}`;
      const [row] = await db.sql<Array<{ created_at: Date }>>`SELECT created_at FROM users WHERE id = ${friend}`;
      const api = await as(sender);
      expect(await api.users.payeeCard({ userId: friend })).toEqual({
        found: true,
        name: 'Nami Navigator',
        memberSince: row!.created_at.toISOString().slice(0, 7),
      });
      expect(await api.users.payeeCard({ userId: nameless })).toMatchObject({ found: true, name: null });
      expect(await api.users.payeeCard({ userId: frozen })).toEqual({ found: false });
    });

    it('marks your own handle self:true and returns no extra fields', async () => {
      const me = await signUp('Myself_Here');
      const api = await as(me);
      const hit = await api.users.resolveHandle({ handle: 'myself_here' });
      expect(hit).toEqual({ found: true, userId: me, handle: 'Myself_Here', self: true });
      expect(Object.keys(hit).sort()).toEqual(['found', 'handle', 'self', 'userId']);
    });
  });

  describe('identity.me (real Postgres)', () => {
    it('returns the caller userId and stored handle', async () => {
      const me = await signUp('Whoami_Now');
      const out = await (await as(me)).me();
      expect(out).toEqual({ userId: me, handle: 'Whoami_Now', emailVerified: false });
    });
  });
  describe('the shared people-lookup budget (real Postgres, #4689)', () => {
    const limit = { max: 3, windowMs: 60_000 };

    async function replicaAs(userId: string, now: () => Date) {
      const replica = createIdentityRouter(auth, rank, {
        registrationOpen: true,
        handleLookupLimiter: new PgHandleLookupLimiter(db.sql, limit, now),
      });
      const { token } = await issueAccessToken(
        { userId, sessionId: '55555555-5555-4555-8555-555555555555', scopes: [...SESSION_SCOPES], tier: 'none', mfa: true },
        tokenConfig,
      );
      const ctx: Context = { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'r' };
      return replica.createCaller(ctx);
    }

    it('gives one person one budget across two replicas, and a new window refills it', async () => {
      const me = await signUp('Budget_Owner');
      await signUp('Budget_Target');
      let t = new Date('2026-11-13T10:00:00Z').getTime();
      const now = () => new Date(t);
      const a = await replicaAs(me, now);
      const b = await replicaAs(me, now);
      await a.users.resolveHandle({ handle: 'budget_target' });
      await b.users.resolveHandle({ handle: 'budget_target' });
      await a.users.resolveHandle({ handle: 'budget_target' });
      for (const api of [a, b]) {
        await expect(api.users.resolveHandle({ handle: 'budget_target' })).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
      }
      // A refused lookup is not counted: the row still says 3.
      const [row] = await db.sql<{ hits: number }[]>`SELECT hits FROM handle_lookup_budget WHERE user_id = ${me}`;
      expect(row?.hits).toBe(3);
      t += 60_000;
      await expect(b.users.resolveHandle({ handle: 'budget_target' })).resolves.toMatchObject({ found: true });
      const [after] = await db.sql<{ hits: number }[]>`SELECT hits FROM handle_lookup_budget WHERE user_id = ${me}`;
      expect(after?.hits).toBe(1);
    });

    it('lets at most the budget through when lookups arrive at once from several replicas', async () => {
      const me = await signUp('Burst_Caller');
      const now = () => new Date('2026-11-13T11:00:00Z');
      const limiters = [0, 1, 2].map(() => new PgHandleLookupLimiter(db.sql, limit, now));
      const taken = await Promise.all(Array.from({ length: 12 }, (_, i) => limiters[i % 3]!.tryTake(me)));
      expect(taken.filter(Boolean)).toHaveLength(3);
    });

    it('keeps one person’s budget apart from another’s', async () => {
      const one = await signUp('Budget_One');
      const two = await signUp('Budget_Two');
      const limiter = new PgHandleLookupLimiter(db.sql, limit, () => new Date('2026-11-13T12:00:00Z'));
      for (let i = 0; i < 3; i++) expect(await limiter.tryTake(one)).toBe(true);
      expect(await limiter.tryTake(one)).toBe(false);
      expect(await limiter.tryTake(two)).toBe(true);
    });

    it('refuses a caller with no user row instead of failing', async () => {
      const limiter = new PgHandleLookupLimiter(db.sql, limit, () => new Date('2026-11-13T13:00:00Z'));
      expect(await limiter.tryTake('99999999-9999-4999-8999-999999999999')).toBe(false);
    });
  });
}
