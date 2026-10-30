import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import postgres from 'postgres';
import { FounderControls } from '../controls/founder-controls.js';
import { createFounderControlsRouter } from '../controls/founder-controls-router.js';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { getPreferences, PreferencesError, setPreferences } from '../preferences/preferences.js';
import { createPreferencesRouter } from '../preferences/preferences-router.js';
import { PREFERENCES_VERSION_CONFLICT } from '../preferences/trade-views.js';
import { ACCOUNT_DISPLAY_NAMESPACE } from '../preferences/account-display.js';
import { UI_VIEW_NAMESPACE } from '../preferences/ui-view.js';
import { HOME_TILES_NAMESPACE } from '../preferences/home-tiles.js';
import { RankService } from '../rank/rank-service.js';
import { AuthService } from '../auth/auth-service.js';
import { totp } from '../auth/totp.js';
import { searchAccounts } from './account-directory.js';
import { createOperatorOpsRouter } from './ops-router.js';
import { revokeSessionsForUser, revokeSessionsPayloadHash } from './operator-sessions.js';

const PASSWORD = 'correct horse battery staple';
const NO_FACTOR = { mfa: false, privileged: false } as const;
const TARGET_IP = '203.0.113.50';

const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
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

async function harnessUrl(): Promise<string | null> {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw || !(await postgresAvailable(raw))) return null;
  const name = new URL(raw).pathname.replace(/^\//, '').split('/')[0] ?? '';
  let target = raw;
  if (!name.endsWith('_test')) {
    const admin = postgres(raw, { max: 1, onnotice: () => undefined });
    try {
      await admin.unsafe('CREATE DATABASE identbe_ops_test');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(message)) throw err;
    } finally {
      await admin.end({ timeout: 5 });
    }
    const url = new URL(raw);
    url.pathname = '/identbe_ops_test';
    target = url.toString();
  }
  const sql = postgres(target, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS citext');
    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  } finally {
    await sql.end({ timeout: 5 });
  }
  return target;
}

const databaseUrl = await harnessUrl();

if (!databaseUrl) {
  describe.skip('identity operator reads (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: databaseUrl,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const keyMaterial = randomBytes(32).toString('base64');
  const buildAuth = () => new AuthService(db.sql, bus, rank, tokenConfig, webauthnConfig, keyMaterial, undefined, undefined, 25);
  let auth = buildAuth();
  let counter = 0;

  const register = async (handle?: string, device?: string, ip?: string) => {
    const name = handle ?? `ops${process.pid}x${++counter}`;
    const session = await auth.register({ handle: name, email: `${name}@example.com`, password: PASSWORD, device, ip });
    return { handle: name, email: `${name}@example.com`, ...session };
  };

  async function ctx(userId: string, sessionId: string, scopes: string[], mfa: boolean): Promise<Context> {
    const { token } = await issueAccessToken({ userId, sessionId, scopes, tier: 'none', mfa }, tokenConfig);
    return { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'identbe' };
  }

  async function restrict(userId: string, area: 'identity' | 'trading', reason: string, actor: string, at: string) {
    if (area === 'identity') {
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${userId}`;
    } else {
      await db.sql`
        INSERT INTO trading_restrictions (user_id, restricted, version) VALUES (${userId}, true, 1)
      `;
    }
    await db.sql`
      INSERT INTO founder_control_audit (audit_id, request_id, actor_id, kind, fingerprint, result)
      VALUES (
        ${randomUUID()},
        ${randomUUID()},
        ${actor},
        'identity',
        ${'fp'},
        ${db.sql.json({
          outcome: 'changed',
          action: 'restrict',
          reason,
          actorUserId: actor,
          occurredAt: at,
          target: { area, userId },
        })}
      )
    `;
  }

  async function approval(targetUserId: string, requesterId: string, approverId: string) {
    const approvalId = `apr-${randomUUID()}`;
    await db.sql`
      INSERT INTO action_approvals (
        approval_id, action_type, target_service, target_id, expected_version, payload_hash,
        requester_id, approver_id, policy_version, operation_id, status, created_at, expires_at, approved_at
      ) VALUES (
        ${approvalId},
        'identity.revoke_sessions',
        'svc-identity',
        ${targetUserId},
        '1',
        ${revokeSessionsPayloadHash(targetUserId)},
        ${requesterId},
        ${approverId},
        '1',
        ${randomUUID()},
        'APPROVED',
        now(),
        now() + interval '1 hour',
        now()
      )
    `;
    return approvalId;
  }

  beforeEach(async () => {
    bus.reset();
    await db.truncateAll();
    await rank.seedTiers();
    auth = buildAuth();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('restricted accounts', () => {
    it('lists three accounts in two areas, pages, filters, and drops a lifted row', async () => {
      const actor = await register();
      const a = await register();
      const b = await register();
      const c = await register();
      const lifted = await register();
      await restrict(a.userId, 'identity', 'stored-a', actor.userId, '2026-01-01T00:00:03.000Z');
      await restrict(b.userId, 'identity', 'stored-b', actor.userId, '2026-01-01T00:00:02.000Z');
      await restrict(c.userId, 'trading', 'stored-c', actor.userId, '2026-01-01T00:00:01.000Z');
      await restrict(lifted.userId, 'identity', 'stored-lifted', actor.userId, '2026-01-01T00:00:04.000Z');
      await db.sql`UPDATE users SET status = 'active' WHERE id = ${lifted.userId}`;

      const controls = new FounderControls(db.sql, null);
      const reader = createFounderControlsRouter(controls).createCaller(await ctx(actor.userId, actor.sessionId, ['admin:read'], true));
      const customer = createFounderControlsRouter(controls).createCaller(
        await ctx(actor.userId, actor.sessionId, ['identity:read'], false),
      );
      await expect(customer.accountControls.listRestricted({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(reader.accountControls.listRestricted({})).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('identity.restricted_list_limit_unset'),
      });

      const first = await reader.accountControls.listRestricted({ limit: 1 });
      const second = await reader.accountControls.listRestricted({ limit: 1, cursor: first.nextCursor ?? '' });
      const third = await reader.accountControls.listRestricted({ limit: 1, cursor: second.nextCursor ?? '' });
      const ids = [first, second, third].flatMap((page) => page.rows.map((row) => `${row.accountId}:${row.area}`));
      expect(ids).toEqual([`${a.userId}:${'identity'}`, `${b.userId}:${'identity'}`, `${c.userId}:${'trading'}`]);
      expect(new Set(ids).size).toBe(3);
      expect(third.nextCursor).toBeNull();
      expect(first.rows[0]).toMatchObject({ reason: 'stored-a', actor: actor.userId, area: 'identity' });
      expect(JSON.stringify(first.rows)).not.toContain('@');

      const identityOnly = await reader.accountControls.listRestricted({ area: 'identity', limit: 10 });
      expect(identityOnly.rows.map((row) => row.accountId)).toEqual([a.userId, b.userId]);
      const tradingOnly = await reader.accountControls.listRestricted({ area: 'trading', limit: 10 });
      expect(tradingOnly.rows.map((row) => row.accountId)).toEqual([c.userId]);
    });
  });

  describe('account directory and session revoke', () => {
    it('pages a long handle search with a marker, never cutting it silently, and refuses a forged marker', async () => {
      const operator = await register();
      const reader = await ctx(operator.userId, operator.sessionId, ['admin:compliance'], true);
      // 27 matches, twelve of them signed up at the same instant, so the page break falls inside a tie.
      for (let i = 0; i < 27; i += 1) {
        const handle = `pgq${String(i).padStart(2, '0')}`;
        await db.sql`
          INSERT INTO users (handle, email, password_hash, created_at)
          VALUES (${handle}, ${`${handle}@example.com`}, 'x', ${i >= 15 ? '2026-10-22T10:00:00.123456Z' : new Date(Date.UTC(2026, 9, 21, 0, i)).toISOString()}::text::timestamptz)
        `;
      }
      const first = await searchAccounts(db.sql, reader, { handle: 'pgq' });
      expect(first.rows).toHaveLength(25);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = await searchAccounts(db.sql, reader, { handle: 'pgq', cursor: first.nextCursor! });
      expect(second.rows).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
      const all = [...first.rows, ...second.rows].map((row) => row.handle);
      expect(new Set(all).size).toBe(27);
      expect(all.slice(0, 15)).toEqual(Array.from({ length: 15 }, (_, i) => `pgq${String(i).padStart(2, '0')}`));

      const exact = await searchAccounts(db.sql, reader, { handle: 'pgq26' });
      expect(exact.rows).toHaveLength(1);
      expect(exact.nextCursor).toBeNull();

      const marker = (at: string, id = '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b') =>
        Buffer.from(JSON.stringify([at, id])).toString('base64url');
      for (const forged of [
        'not-a-marker',
        Buffer.from('["yesterday","x"]').toString('base64url'),
        Buffer.from('{}').toString('base64url'),
        marker('2026-02-30T00:00:00.000000Z'),
        marker('2026-10-22 10:00:00.123456+00'),
        marker('2026-10-22T10:00:00.123456Z', 'not-a-uuid'),
      ]) {
        await expect(searchAccounts(db.sql, reader, { handle: 'pgq', cursor: forged })).rejects.toMatchObject({
          code: 'identity.search_cursor_invalid',
        });
      }
      // A marker in the right shape for an instant before every match starts from the first match.
      const fromStart = await searchAccounts(db.sql, reader, { handle: 'pgq', cursor: marker('2000-01-01T00:00:00.000000Z') });
      expect(fromStart.rows[0]?.handle).toBe('pgq00');
      const pages = await db.sql<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM operator_read_audit WHERE actor_id = ${operator.userId} AND kind = 'account_search'
      `;
      expect(pages[0]?.n).toBe('4');
    });

    it('finds an exact email, refuses a short handle, audits, and refuses a customer', async () => {
      const operator = await register();
      const secret = await (async () => {
        const started = await auth.startTotpEnrolment(operator.userId, NO_FACTOR);
        await auth.confirmTotpEnrolment(operator.userId, NO_FACTOR, started.secret, totp(started.secret));
        return started.secret;
      })();
      const signed = await auth.login({
        identifier: operator.handle,
        password: PASSWORD,
        totpCode: totp(secret, { at: new Date(Date.now() + 30_000) }),
        device: 'Operator desk',
      });
      const target = await register('zzqtarget1', 'Desk phone', TARGET_IP);
      await db.sql`
        INSERT INTO kyc_records (user_id, tier, jurisdiction, status, reviewed_at)
        VALUES (${target.userId}, 'basic', 'DE', 'approved', now())
      `;
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${target.userId}`;
      const ops = createOperatorOpsRouter(db.sql);
      const reader = ops.createCaller(await ctx(signed.userId, signed.sessionId, ['admin:compliance', 'admin:read', 'admin:write'], true));
      const customer = ops.createCaller(await ctx(target.userId, target.sessionId, ['identity:read', 'identity:write'], false));

      const found = await reader.accountDirectory.search({ email: `  ${target.email.toUpperCase()} ` });
      expect(found.rows).toHaveLength(1);
      expect(found.rows[0]).toMatchObject({
        id: target.userId,
        handle: 'zzqtarget1',
        status: 'frozen',
        kycTier: 'basic',
        restrictedAreas: ['identity'],
      });
      expect(found.rows[0]?.emailMasked).toBe(`z***@example.com`);
      expect(found.rows[0]?.emailMasked).not.toBe(target.email);
      const miss = await reader.accountDirectory.search({ email: 'not-the-one@example.com' });
      expect(miss.rows).toEqual([]);
      await expect(
        searchAccounts(db.sql, await ctx(signed.userId, signed.sessionId, ['admin:compliance'], true), { handle: 'zz' }),
      ).rejects.toMatchObject({
        code: 'identity.handle_prefix_short',
      });
      const byHandle = await reader.accountDirectory.search({ handle: 'zzq' });
      expect(byHandle.rows.map((row) => row.id)).toEqual([target.userId]);

      const audits = await db.sql<Array<{ kind: string; query_hash: string }>>`
        SELECT kind, query_hash FROM operator_read_audit WHERE actor_id = ${signed.userId} AND kind = 'account_search'
      `;
      expect(audits.length).toBeGreaterThanOrEqual(3);
      const emailHash = createHash('sha256').update(`email\0${target.email}`).digest('hex');
      expect(audits.some((row) => row.query_hash === emailHash)).toBe(true);
      expect(JSON.stringify(audits)).not.toContain(target.email);

      const counts = await reader.accountDirectory.counts({});
      expect(counts.byStatus.frozen).toBe(1);
      expect(counts.byStatus.active).toBe(1);
      expect(counts.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const listed = await reader.sessions.listForUser({ userId: target.userId });
      expect(listed.sessions[0]).toMatchObject({ deviceLabel: 'Desk phone', state: 'live' });
      expect(JSON.stringify(listed)).not.toContain(TARGET_IP);
      expect(JSON.stringify(listed)).not.toMatch(/refresh|hash/i);
      const listAudits = await db.sql<Array<{ query_hash: string }>>`
        SELECT query_hash FROM operator_read_audit WHERE actor_id = ${signed.userId} AND kind = 'session_list'
      `;
      expect(listAudits).toHaveLength(1);

      await expect(customer.accountDirectory.search({ email: target.email })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(customer.accountDirectory.counts({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(customer.sessions.listForUser({ userId: target.userId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        customer.sessions.revokeForUser({ userId: target.userId, approvalId: 'missing', clientRequestId: 'c1' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      const [before] = await db.sql<Array<{ password_hash: string }>>`SELECT password_hash FROM users WHERE id = ${target.userId}`;
      await expect(
        revokeSessionsForUser(db.sql, await ctx(signed.userId, signed.sessionId, ['admin:write'], true), {
          userId: target.userId,
          approvalId: 'missing-approval',
          clientRequestId: 'no-approval',
        }),
      ).rejects.toMatchObject({ code: 'identity.revoke_approval_required' });
      const [still] = await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM sessions WHERE user_id = ${target.userId}`;
      expect(still?.revoked).toBe(false);

      const other = await register();
      const wrong = await approval(other.userId, other.userId, signed.userId);
      await expect(
        reader.sessions.revokeForUser({ userId: target.userId, approvalId: wrong, clientRequestId: 'wrong-user' }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      const [stillLive] = await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM sessions WHERE id = ${target.sessionId}`;
      expect(stillLive?.revoked).toBe(false);

      const ok = await approval(target.userId, other.userId, signed.userId);
      const first = await reader.sessions.revokeForUser({ userId: target.userId, approvalId: ok, clientRequestId: 'revoke-1' });
      expect(first.revokedSessionCount).toBe(1);
      const [again] = await db.sql<Array<{ id: string }>>`
        INSERT INTO sessions (user_id, refresh_hash, device, mfa, expires_at)
        VALUES (${target.userId}, ${`replay-${randomUUID()}`}, 'Second phone', false, now() + interval '1 day')
        RETURNING id
      `;
      const replay = await reader.sessions.revokeForUser({ userId: target.userId, approvalId: ok, clientRequestId: 'revoke-1' });
      expect(replay).toEqual(first);
      const [second] = await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM sessions WHERE id = ${again?.id ?? ''}`;
      expect(second?.revoked).toBe(false);
      const [after] = await db.sql<Array<{ password_hash: string }>>`SELECT password_hash FROM users WHERE id = ${target.userId}`;
      expect(after?.password_hash).toBe(before?.password_hash);
    });
  });

  describe('trade views', () => {
    it('round-trips one user, refuses a stale version, and hides the row from the other user', async () => {
      const a = await register();
      const b = await register();
      const view = [{ id: 'v1', name: 'Open', sort: 'name', filters: { market: 'BTC-USD' }, columns: ['name', 'last'] }];
      const callerA = await ctx(a.userId, a.sessionId, ['identity:read', 'identity:write'], false);
      const callerB = await ctx(b.userId, b.sessionId, ['identity:read', 'identity:write'], false);
      const stored = await setPreferences(db.sql, callerA, {
        namespace: 'trade.views',
        value: view,
        ifVersion: 0,
        clientRequestId: 'set-1',
      });
      expect(stored).toMatchObject({ version: 1, value: view });
      expect(await getPreferences(db.sql, callerA, 'trade.views')).toMatchObject({ version: 1, value: view });
      const replay = await setPreferences(db.sql, callerA, {
        namespace: 'trade.views',
        value: view,
        ifVersion: 0,
        clientRequestId: 'set-1',
      });
      expect(replay.version).toBe(1);

      await expect(
        setPreferences(db.sql, callerA, { namespace: 'trade.views', value: view, ifVersion: 0, clientRequestId: 'stale' }),
      ).rejects.toMatchObject({ code: PREFERENCES_VERSION_CONFLICT, current: { version: 1 } });
      expect(await getPreferences(db.sql, callerA, 'trade.views')).toMatchObject({ version: 1, value: view });

      expect(await getPreferences(db.sql, callerB, 'trade.views')).toMatchObject({ version: 0, value: null });
      await setPreferences(db.sql, callerB, {
        namespace: 'trade.views',
        value: [{ id: 'b', name: 'Mine', sort: 'name', filters: {}, columns: ['name'] }],
        ifVersion: 0,
        clientRequestId: 'b-1',
      });
      expect((await getPreferences(db.sql, callerA, 'trade.views')).value).toEqual(view);

      const prefs = createPreferencesRouter(db.sql);
      await expect(
        prefs.createCaller(callerA).preferences.set({ namespace: 'other.views', value: view, ifVersion: 0, clientRequestId: 'bad-ns' }),
      ).rejects.toMatchObject({
        message: 'identity.preferences_namespace_unknown',
      });
      await expect(
        prefs.createCaller(callerA).preferences.set({
          namespace: 'trade.views',
          value: [{ ...view[0], extra: true }],
          ifVersion: 1,
          clientRequestId: 'bad-key',
        }),
      ).rejects.toMatchObject({ message: 'identity.preferences_value_invalid' });
      const fat = Array.from({ length: 8 }, (_, i) => ({
        id: `fat-${i}`,
        name: 'n'.repeat(60),
        sort: 'name',
        filters: Object.fromEntries(Array.from({ length: 20 }, (__, j) => [`k${j}`, 'v'.repeat(200)])),
        columns: ['name'],
      }));
      await expect(
        setPreferences(db.sql, callerA, { namespace: 'trade.views', value: fat, ifVersion: 1, clientRequestId: 'fat' }),
      ).rejects.toBeInstanceOf(PreferencesError);
      expect(await getPreferences(db.sql, callerA, 'trade.views')).toMatchObject({ version: 1, value: view });
    });
  });
  describe('receipts under a race', () => {
    it('two identical requests sent at once both answer stored at version 1 (one write, no 500)', async () => {
      const a = await register();
      const caller = await ctx(a.userId, a.sessionId, ['identity:read', 'identity:write'], false);
      const view = [{ id: 'race', name: 'Race', sort: 'name', filters: {}, columns: ['name'] }];
      const request = { namespace: 'trade.views', value: view, ifVersion: 0, clientRequestId: 'race-1' };
      const [first, second] = await Promise.all([setPreferences(db.sql, caller, request), setPreferences(db.sql, caller, request)]);
      expect(first).toMatchObject({ outcome: 'stored', version: 1 });
      expect(second).toMatchObject({ outcome: 'stored', version: 1 });
      expect(await getPreferences(db.sql, caller, 'trade.views')).toMatchObject({ version: 1, value: view });
    });
  });
  describe('an identical save', () => {
    it('stores nothing and keeps the version; a changed value is written; a stale version still refuses', async () => {
      const a = await register();
      const caller = await ctx(a.userId, a.sessionId, ['identity:read', 'identity:write'], false);
      const namespace = 'protocol.address-watches';
      const watch = { address: `0x${'a'.repeat(40)}`, tag: 'TEST cold wallet', note: 'TEST note' };
      await setPreferences(db.sql, caller, { namespace, value: [watch], ifVersion: 0, clientRequestId: 'watch-0' });
      const [before] = await db.sql<Array<{ updated_at: Date }>>`
        SELECT updated_at FROM user_preferences WHERE user_id = ${a.userId} AND namespace = ${namespace}
      `;
      // The same watch, its keys in another order, sent again at the version read.
      const again = await setPreferences(db.sql, caller, {
        namespace,
        value: [{ note: watch.note, tag: watch.tag, address: watch.address }],
        ifVersion: 1,
        clientRequestId: 'watch-1',
      });
      expect(again).toEqual({ outcome: 'stored', namespace, version: 1, value: [watch] });
      const [after] = await db.sql<Array<{ updated_at: Date; version: string }>>`
        SELECT updated_at, version::text AS version FROM user_preferences WHERE user_id = ${a.userId} AND namespace = ${namespace}
      `;
      expect(after).toEqual({ updated_at: before!.updated_at, version: '1' });
      expect(
        await db.sql`SELECT 1 FROM user_preference_receipts WHERE user_id = ${a.userId} AND client_request_id = 'watch-1'`,
      ).toHaveLength(0);
      // A client whose request id names only the version it read sends its next change under the same id: the no-op kept
      // no receipt, so that change is written, not refused as a reused id.
      const changed = { ...watch, note: 'TEST other note' };
      expect(await setPreferences(db.sql, caller, { namespace, value: [changed], ifVersion: 1, clientRequestId: 'watch-1' })).toMatchObject(
        { outcome: 'stored', version: 2, value: [changed] },
      );
      // An identical value sent at an old version is still a conflict: the caller's copy is stale and must rebase.
      await expect(
        setPreferences(db.sql, caller, { namespace, value: [changed], ifVersion: 1, clientRequestId: 'watch-stale' }),
      ).rejects.toMatchObject({ code: PREFERENCES_VERSION_CONFLICT, current: { version: 2, value: [changed] } });
      expect(await getPreferences(db.sql, caller, namespace)).toEqual({ namespace, version: 2, value: [changed] });
    });
  });
  describe('view record', () => {
    it('follows the account to a second device, replays a request, refuses a stale version and stays per account', async () => {
      const a = await register();
      const b = await register();
      const deviceA = await ctx(a.userId, a.sessionId, ['identity:read', 'identity:write'], false);
      const deviceB = await ctx(a.userId, a.sessionId, ['identity:read', 'identity:write'], false);
      const other = await ctx(b.userId, b.sessionId, ['identity:read', 'identity:write'], false);
      const routerA = createPreferencesRouter(db.sql).createCaller(deviceA);
      const routerB = createPreferencesRouter(db.sql).createCaller(deviceB);

      expect(await routerB.preferences.get({ namespace: UI_VIEW_NAMESPACE })).toMatchObject({ version: 0, value: null });
      const value = { layoutMode: 'simple', theme: 'dark', activeProfile: 'personal' };
      expect(
        await routerA.preferences.set({ namespace: UI_VIEW_NAMESPACE, value, ifVersion: 0, clientRequestId: 'ui-view:a:0' }),
      ).toMatchObject({
        namespace: UI_VIEW_NAMESPACE,
        version: 1,
        value,
        outcome: 'stored',
      });
      expect(await routerB.preferences.get({ namespace: UI_VIEW_NAMESPACE })).toMatchObject({ version: 1, value });
      const replay = await routerA.preferences.set({ namespace: UI_VIEW_NAMESPACE, value, ifVersion: 0, clientRequestId: 'ui-view:a:0' });
      expect(replay.version).toBe(1);
      // The same request id with other contents is an idempotency conflict; a stale version is a version conflict.
      await expect(
        routerA.preferences.set({ namespace: UI_VIEW_NAMESPACE, value: { theme: 'light' }, ifVersion: 0, clientRequestId: 'ui-view:a:0' }),
      ).rejects.toMatchObject({ message: 'identity.preferences_idempotency_conflict' });
      await expect(
        routerB.preferences.set({ namespace: UI_VIEW_NAMESPACE, value: { theme: 'light' }, ifVersion: 0, clientRequestId: 'ui-view:b:0' }),
      ).rejects.toMatchObject({ message: PREFERENCES_VERSION_CONFLICT });
      await expect(
        routerA.preferences.set({ namespace: UI_VIEW_NAMESPACE, value: { theme: 'sepia' }, ifVersion: 1, clientRequestId: 'ui-view:a:1' }),
      ).rejects.toMatchObject({ message: 'identity.preferences_value_invalid' });
      expect(await routerA.preferences.get({ namespace: UI_VIEW_NAMESPACE })).toMatchObject({ version: 1, value });
      expect(await createPreferencesRouter(db.sql).createCaller(other).preferences.get({ namespace: UI_VIEW_NAMESPACE })).toMatchObject({
        version: 0,
        value: null,
      });
    });
  });
  describe('Home layout (home.tiles)', () => {
    it('follows the account to a second device, refuses a stale version and a bad record, and stays per account', async () => {
      const a = await register();
      const b = await register();
      const deviceA = await ctx(a.userId, a.sessionId, ['identity:read', 'identity:write'], false);
      const deviceB = await ctx(a.userId, a.sessionId, ['identity:read', 'identity:write'], false);
      const other = await ctx(b.userId, b.sessionId, ['identity:read', 'identity:write'], false);
      const routerA = createPreferencesRouter(db.sql).createCaller(deviceA);
      const routerB = createPreferencesRouter(db.sql).createCaller(deviceB);

      expect(await routerB.preferences.get({ namespace: HOME_TILES_NAMESPACE })).toMatchObject({ version: 0, value: null });
      const value = { order: ['activity', 'markets'], hidden: ['markets'] };
      expect(
        await routerA.preferences.set({ namespace: HOME_TILES_NAMESPACE, value, ifVersion: 0, clientRequestId: 'home-tiles:a:0' }),
      ).toMatchObject({ namespace: HOME_TILES_NAMESPACE, version: 1, value, outcome: 'stored' });
      expect(await routerB.preferences.get({ namespace: HOME_TILES_NAMESPACE })).toMatchObject({ version: 1, value });
      // The second device wrote at the version it read, which is now stale: a version conflict, and the newer layout stays.
      await expect(
        routerB.preferences.set({
          namespace: HOME_TILES_NAMESPACE,
          value: { order: [], hidden: [] },
          ifVersion: 0,
          clientRequestId: 'home-tiles:b:0',
        }),
      ).rejects.toMatchObject({ message: PREFERENCES_VERSION_CONFLICT });
      await expect(
        routerA.preferences.set({
          namespace: HOME_TILES_NAMESPACE,
          value: { order: ['markets', 'markets'], hidden: [] },
          ifVersion: 1,
          clientRequestId: 'home-tiles:a:1',
        }),
      ).rejects.toMatchObject({ message: 'identity.preferences_value_invalid' });
      expect(await routerA.preferences.get({ namespace: HOME_TILES_NAMESPACE })).toMatchObject({ version: 1, value });
      // The view record is a separate namespace with its own version.
      expect(await routerA.preferences.get({ namespace: UI_VIEW_NAMESPACE })).toMatchObject({ version: 0 });
      expect(await createPreferencesRouter(db.sql).createCaller(other).preferences.get({ namespace: HOME_TILES_NAMESPACE })).toMatchObject({
        version: 0,
        value: null,
      });
    });
  });
  describe('account display', () => {
    const listed = { displayCurrencies: ['USD', 'EUR'] } as const;

    it('follows the account to a second device, refuses unknown values, and stays per account', async () => {
      const a = await register();
      const b = await register();
      const deviceA = await ctx(a.userId, a.sessionId, ['identity:read', 'identity:write'], false);
      const deviceB = await ctx(a.userId, a.sessionId, ['identity:read', 'identity:write'], false);
      const other = await ctx(b.userId, b.sessionId, ['identity:read', 'identity:write'], false);
      const routerA = createPreferencesRouter(db.sql, listed).createCaller(deviceA);
      const routerB = createPreferencesRouter(db.sql, listed).createCaller(deviceB);

      expect(await routerB.preferences.get({ namespace: ACCOUNT_DISPLAY_NAMESPACE })).toMatchObject({ version: 0, value: null });
      const stored = await routerA.preferences.set({
        namespace: ACCOUNT_DISPLAY_NAMESPACE,
        value: { locale: 'ES', displayCurrency: 'EUR' },
        ifVersion: 0,
        clientRequestId: 'display-1',
      });
      expect(stored).toMatchObject({ version: 1, value: { locale: 'es', displayCurrency: 'EUR' } });
      expect(await routerB.preferences.get({ namespace: ACCOUNT_DISPLAY_NAMESPACE })).toMatchObject({
        version: 1,
        value: { locale: 'es', displayCurrency: 'EUR' },
      });
      const replay = await routerA.preferences.set({
        namespace: ACCOUNT_DISPLAY_NAMESPACE,
        value: { locale: 'ES', displayCurrency: 'EUR' },
        ifVersion: 0,
        clientRequestId: 'display-1',
      });
      expect(replay.version).toBe(1);

      for (const [clientRequestId, value] of [
        ['bad-locale', { locale: 'xx-not-shipped', displayCurrency: null }],
        ['bad-currency', { locale: 'en', displayCurrency: 'JPY' }],
        ['extra-key', { locale: 'en', displayCurrency: null, extra: 1 }],
      ] as const) {
        await expect(
          routerA.preferences.set({ namespace: ACCOUNT_DISPLAY_NAMESPACE, value, ifVersion: 1, clientRequestId }),
        ).rejects.toMatchObject({ message: 'identity.preferences_value_invalid' });
      }
      expect(await routerA.preferences.get({ namespace: ACCOUNT_DISPLAY_NAMESPACE })).toMatchObject({
        version: 1,
        value: { locale: 'es', displayCurrency: 'EUR' },
      });
      expect(
        await createPreferencesRouter(db.sql, listed).createCaller(other).preferences.get({ namespace: ACCOUNT_DISPLAY_NAMESPACE }),
      ).toMatchObject({
        version: 0,
        value: null,
      });
    });

    it('lists no currency until the owner publishes one, and refuses any currency meanwhile', async () => {
      const a = await register();
      const caller = createPreferencesRouter(db.sql).createCaller(
        await ctx(a.userId, a.sessionId, ['identity:read', 'identity:write'], false),
      );
      const options = await caller.preferences.options();
      expect(options.displayCurrencies).toEqual([]);
      expect(options.defaultDisplayCurrency).toBe('USD');
      expect(options.locales).toContain('en');
      await expect(
        caller.preferences.set({
          namespace: ACCOUNT_DISPLAY_NAMESPACE,
          value: { locale: 'en', displayCurrency: 'USD' },
          ifVersion: 0,
          clientRequestId: 'blank-list',
        }),
      ).rejects.toMatchObject({ message: 'identity.preferences_value_invalid' });
      expect(
        await caller.preferences.set({
          namespace: ACCOUNT_DISPLAY_NAMESPACE,
          value: { locale: 'en', displayCurrency: null },
          ifVersion: 0,
          clientRequestId: 'no-currency',
        }),
      ).toMatchObject({ version: 1, value: { locale: 'en', displayCurrency: null } });
    });
  });
}
