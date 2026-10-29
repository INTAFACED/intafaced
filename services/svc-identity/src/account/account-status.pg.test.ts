/**
 * Account status against Postgres (I-signin-sessions-22): an active account blocks nothing; each restriction identity
 * keeps shows with only what its own guard refuses, its code and start, and how it ends; a staff restriction's free
 * text never shows; `mine` reads only the caller and `of` is behind `admin:read`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { type Context } from '@intafaced/contracts';
import { ACCOUNT_ACTIONS, accountStatusSchema } from '@intafaced/contracts/identity-account-status';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from '../auth/auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { SecurityLock } from '../auth/security-lock.js';
import { AccountStatusDesk } from './account-status.js';
import { createAccountStatusRouter } from './account-status-router.js';

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) return 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const TEST_URL = testDatabaseUrl();
const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzleDir, file), 'utf8'));
const tokenConfig = {
  secret: 'an-identity-account-status-pg-test-secret-long',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const PASSWORD = 'correct horse battery staple';

if (!(await postgresAvailable(TEST_URL))) {
  describe.skip('account status (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_account_status',
    url: TEST_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, undefined, undefined, undefined, undefined, 5);
  auth.useLogger({ warn: () => undefined });
  await rank.seedTiers();
  afterAll(async () => {
    await db.drop();
  });
  const REASONS = new Map([
    ['compliance_hold', { code: 'compliance_hold', reason: 'TEST: switched off after a review.', guidance: 'TEST: ask Support.' }],
  ]);
  const desk = new AccountStatusDesk(db.sql, 3600, REASONS);
  const lock = new SecurityLock(db.sql, 0);
  let n = 0;
  const person = async () => {
    const handle = `as${process.pid}${++n}`;
    return (await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD, region: 'DE' })).userId;
  };
  const read = async (userId: string) => accountStatusSchema.parse(await desk.read(userId));

  describe('account status', () => {
    it('an active account blocks nothing: everything is in "you can still"', async () => {
      const status = await read(await person());
      expect(status).toEqual({
        state: 'active',
        reasonCode: null,
        since: null,
        restrictions: [],
        canStill: [...ACCOUNT_ACTIONS],
        cannot: [],
      });
    });

    it("the owner's freeze: frozen by you, blocks only a new API key, and lifts after the published wait", async () => {
      const userId = await person();
      const done = await auth.selfFreeze({
        userId,
        actor: { delegated: false, privileged: false, mfa: false },
        reason: 'compromise',
        password: PASSWORD,
      });
      const status = await read(userId);
      expect(status).toMatchObject({ state: 'frozen_self', reasonCode: 'compromise', since: done.since.toISOString() });
      expect(status.restrictions).toEqual([
        {
          kind: 'self_freeze',
          reasonCode: 'compromise',
          since: done.since.toISOString(),
          blocks: ['create_api_key'],
          lift: { by: 'owner_after_wait', availableAt: new Date(done.since.getTime() + 3600_000).toISOString() },
          capability: null,
          owner: null,
        },
      ]);
      expect(status.cannot).toEqual([{ action: 'create_api_key', kind: 'self_freeze' }]);
      expect(status.canStill).toContain('sign_in');
      // With no wait published, the lift time is unknown and the page says a lift refuses.
      const unpublished = accountStatusSchema.parse(await new AccountStatusDesk(db.sql, undefined, REASONS).read(userId));
      expect(unpublished.restrictions[0]!.lift).toEqual({ by: 'owner_after_wait', availableAt: null });
    });

    it('a security lock names who set it and blocks the security changes and withdrawal addresses; an ended lock is gone', async () => {
      const userId = await person();
      await lock.lock(userId, { kind: 'self', userId });
      const status = await read(userId);
      expect(status.state).toBe('restricted');
      expect(status.restrictions).toEqual([
        expect.objectContaining({ kind: 'security_lock', reasonCode: 'set_by_you', lift: { by: 'owner_unlock', endsAt: null } }),
      ]);
      expect(status.cannot.map((c) => c.action)).toEqual([
        'change_password',
        'change_signin_methods',
        'reset_password',
        'reset_second_factor',
        'add_recovery_keys',
        'add_withdrawal_address',
        'withdraw_to_address',
      ]);
      expect(status.canStill).toEqual(['sign_in', 'trade', 'create_api_key', 'request_level_with_switched_off_capability']);
      await db.sql`UPDATE account_security_locks SET unlock_requested_at = now() - interval '2 seconds', unlocks_at = now() - interval '1 second' WHERE user_id = ${userId}`;
      expect((await read(userId)).state).toBe('active');
    });

    it('a staff trading restriction is listed with no reason on file, and blocks nothing it does not enforce', async () => {
      const userId = await person();
      await db.sql`INSERT INTO trading_restrictions (user_id, restricted, version) VALUES (${userId}, true, 1)`;
      const status = await read(userId);
      // svc-trade does not read identity's record, so "you cannot" stays empty and trading stays in "you can still".
      expect(status).toMatchObject({ state: 'active', reasonCode: null, cannot: [], canStill: [...ACCOUNT_ACTIONS] });
      expect(status.restrictions[0]!.blocks).toEqual([]);
      expect(status.restrictions[0]).toMatchObject({ kind: 'trading_restricted', lift: { by: 'staff' } });
      expect(status.restrictions[0]!.since).toBeNull();
      await db.sql`UPDATE trading_restrictions SET restricted = false WHERE user_id = ${userId}`;
      expect((await read(userId)).state).toBe('active');
    });

    it("a staff freeze blocks everything and only staff lift it; the owner's freeze on top is listed too", async () => {
      const userId = await person();
      await auth.selfFreeze({ userId, actor: { delegated: false, privileged: false, mfa: false }, reason: 'personal', password: PASSWORD });
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${userId}`;
      const status = await read(userId);
      expect(status).toMatchObject({ state: 'frozen', reasonCode: null, canStill: [] });
      expect(status.restrictions.map((r) => [r.kind, r.lift.by])).toEqual([
        ['staff_freeze', 'staff'],
        ['self_freeze', 'owner_after_wait'],
      ]);
      expect(status.cannot.every((c) => c.kind === 'staff_freeze')).toBe(true);
    });

    it("a KYC capability compliance switched off is listed with the owner's words and next step, blocks nothing and never lifts", async () => {
      const userId = await person();
      await db.sql`
        INSERT INTO kyc_capabilities (user_id, capability, state, decided_by, reason_code)
        VALUES (${userId}, 'trade_crypto', 'inactive', 'reviewer', 'compliance_hold'),
               (${userId}, 'custody_crypto', 'inactive', 'reviewer', 'no_longer_listed'),
               (${userId}, 'transfer_fiat', 'active', NULL, NULL)`;
      const status = await read(userId);
      expect(status).toMatchObject({
        state: 'restricted',
        reasonCode: null,
        cannot: [{ action: 'request_level_with_switched_off_capability', kind: 'capability_off' }],
      });
      const blocks = ['request_level_with_switched_off_capability'];
      expect(status.restrictions.map((r) => [r.kind, r.capability, r.owner, r.blocks, r.lift])).toEqual([
        ['capability_off', 'custody_crypto', { code: 'no_longer_listed', text: null, guidance: null }, blocks, { by: 'none' }],
        [
          'capability_off',
          'trade_crypto',
          { code: 'compliance_hold', text: 'TEST: switched off after a review.', guidance: 'TEST: ask Support.' },
          blocks,
          { by: 'none' },
        ],
      ]);
      expect(status.restrictions.every((r) => r.since !== null)).toBe(true);
    });

    it('a closed account names the closure code staff recorded', async () => {
      const userId = await person();
      await db.sql`UPDATE users SET status = 'closed', closed_reason = 'customer_request' WHERE id = ${userId}`;
      expect(await read(userId)).toMatchObject({ state: 'closed', reasonCode: 'customer_request', canStill: [] });
      // Closed by the person through the closure flow: no staff code, so the finalised closure is the code and the time.
      const own = await person();
      await db.sql`UPDATE users SET status = 'closed' WHERE id = ${own}`;
      await db.sql`
        INSERT INTO account_closures (user_id, status, requested_at, effective_at, finalized_at, client_request_id)
        VALUES (${own}, 'closed', now() - interval '1 day', now(), now(), 'close-1')`;
      const closed = await read(own);
      expect(closed.restrictions[0]).toMatchObject({ kind: 'closed', reasonCode: 'customer_request' });
      expect(closed.restrictions[0]!.since).not.toBeNull();
      expect(await desk.read('00000000-0000-4000-8000-000000000000')).toBeNull();
    });

    it('`mine` reads only the caller; `of` is for admin:read', async () => {
      const userId = await person();
      const other = await person();
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${other}`;
      const caller = (scopes: string[]) =>
        createAccountStatusRouter(desk).createCaller({
          principal: { userId, sid: 'sid-1', scopes, mfa: false },
          service: null,
          region: 'DE',
          requestId: 'req-status',
        } as unknown as Context);
      expect((await caller(['identity:read']).accountStatus.mine()).state).toBe('active');
      await expect(caller(['identity:read']).accountStatus.of({ userId: other })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await caller(['admin:read']).accountStatus.of({ userId: other })).state).toBe('frozen');
      await expect(caller(['identity:read']).accountStatus.mine({ userId: other } as never)).resolves.toMatchObject({ state: 'active' });
      // A staff read is for a person signed in: an API key, a sub-account or a service is refused; a sub-account session
      // never reads the owner's status as its own.
      const as = (extra: Record<string, unknown>, service: string | null = null) =>
        createAccountStatusRouter(desk).createCaller({
          principal: { userId, sid: 'sid-1', scopes: ['admin:read', 'identity:read'], mfa: false, ...extra },
          service,
          region: 'DE',
          requestId: 'req-status',
        } as unknown as Context);
      await expect(as({ kid: 'key-1' }).accountStatus.of({ userId: other })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(as({ sub_account: 'sub-1' }).accountStatus.of({ userId: other })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(as({}, 'svc-ops').accountStatus.of({ userId: other })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(as({ sub_account: 'sub-1' }).accountStatus.mine()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });
}
