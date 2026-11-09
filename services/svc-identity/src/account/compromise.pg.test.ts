import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { SESSION_SCOPES } from '@intafaced/auth';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { transaction } from '@intafaced/db';
import { AuthService } from '../auth/auth-service.js';
import type { FactorActor } from '../auth/factor-gate.js';
import { queueFactorChangedNotice } from '../auth/factor-changed-notice.js';
import { COMPROMISE_NO_CASE, openCompromiseCase } from './compromise.js';
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
  describe.skip('compromised-account case (Postgres unavailable)', () => {
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
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, undefined, undefined, undefined, undefined, 5);
  await rank.seedTiers();
  let n = 0;
  const unique = () => `cc${process.pid}${++n}`;
  const person = async () => {
    const handle = unique();
    const tokens = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
    return { ...tokens, handle };
  };

  afterAll(async () => {
    await db.drop();
  });

  const PASSWORD = 'correct horse battery staple';
  const me: FactorActor = { delegated: false, privileged: false, mfa: false };
  const countLive = async (userId: string) => {
    const s = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM sessions WHERE user_id = ${userId} AND revoked = false`;
    const k = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM api_keys WHERE user_id = ${userId} AND revoked = false`;
    return { sessions: Number(s[0]!.n), keys: Number(k[0]!.n) };
  };

  const factor = (userId: string, change: 'password_changed' | 'totp_added', at: Date) =>
    transaction(db.sql, (tx) => queueFactorChangedNotice(tx, { userId, change, now: at, mail: false }));

  describe('compromised-account case (I-signin-sessions-28)', () => {
    it('ends every session and key, freezes for a compromise and opens one case; again returns the same case', async () => {
      const u = await person();
      await auth.createApiKey({ userId: u.userId, name: 'k', scopes: ['identity:read'], grantorScopes: SESSION_SCOPES });
      await auth.createApiKey({ userId: u.userId, name: 'k2', scopes: ['identity:read'], grantorScopes: SESSION_SCOPES });
      const live = await countLive(u.userId);
      expect(live.keys).toBe(2);
      expect(live.sessions).toBeGreaterThanOrEqual(1);
      expect(await auth.compromiseCase(u.userId, me)).toBeNull();

      const first = await auth.startCompromise({ userId: u.userId, actor: me, password: PASSWORD });
      expect(first.changed).toBe(true);
      expect(await countLive(u.userId)).toEqual({ sessions: 0, keys: 0 });
      expect(await auth.selfFreezeStatus(u.userId)).toMatchObject({ frozen: true, reason: 'compromise' });
      const held = await auth.compromiseCase(u.userId, me);
      expect(held).toMatchObject({ id: first.caseId, sessionsEnded: live.sessions, keysEnded: 2, notes: [] });

      // The person lifts the freeze (the TEST wait is skipped here), then a new sign-in and a new key, then pressing
      // again: the same case, the freeze is back, and both are ended.
      await db.sql`UPDATE account_self_freezes SET state = 'lifted', lifted_at = now() WHERE user_id = ${u.userId}`;
      await auth.login({ identifier: u.handle, password: PASSWORD });
      await auth.createApiKey({ userId: u.userId, name: 'k3', scopes: ['identity:read'], grantorScopes: SESSION_SCOPES });
      const again = await auth.startCompromise({ userId: u.userId, actor: me, password: PASSWORD });
      expect(again).toMatchObject({ caseId: first.caseId, changed: true });
      expect(await countLive(u.userId)).toEqual({ sessions: 0, keys: 0 });
      // Pressed once more with nothing left to end: the same case, nothing changed.
      const third = await auth.startCompromise({ userId: u.userId, actor: me, password: PASSWORD });
      expect(third).toMatchObject({ caseId: first.caseId, changed: false });
      expect(await auth.selfFreezeStatus(u.userId)).toMatchObject({ frozen: true, reason: 'compromise' });
      expect(await db.sql`SELECT id FROM compromise_cases WHERE user_id = ${u.userId}`).toHaveLength(1);
      expect(await db.sql`SELECT id FROM account_self_freezes WHERE user_id = ${u.userId} AND state = 'frozen'`).toHaveLength(1);
    });

    it('a wrong password, or an API key or sub-account, changes nothing', async () => {
      const u = await person();
      await expect(auth.startCompromise({ userId: u.userId, actor: me, password: 'wrong password here' })).rejects.toMatchObject({
        code: 'auth.invalid_credentials',
      });
      await expect(auth.startCompromise({ userId: u.userId, actor: { ...me, delegated: true }, password: PASSWORD })).rejects.toMatchObject(
        { code: 'auth.mfa_required' },
      );
      expect(await auth.compromiseCase(u.userId, me)).toBeNull();
      expect(await auth.selfFreezeStatus(u.userId)).toMatchObject({ frozen: false });
      expect((await countLive(u.userId)).sessions).toBeGreaterThanOrEqual(1);
    });

    it('is all or nothing: a crash after the case opens, before commit, leaves sessions, keys and freeze as they were', async () => {
      const u = await person();
      await auth.createApiKey({ userId: u.userId, name: 'k', scopes: ['identity:read'], grantorScopes: SESSION_SCOPES });
      const before = await countLive(u.userId);
      await expect(
        transaction(db.sql, async (tx) => {
          await openCompromiseCase(tx, u.userId);
          throw new Error('crash before commit');
        }),
      ).rejects.toThrow('crash before commit');
      expect(await countLive(u.userId)).toEqual(before);
      expect(await auth.selfFreezeStatus(u.userId)).toMatchObject({ frozen: false });
      expect(await auth.compromiseCase(u.userId, me)).toBeNull();
    });

    it('a freeze already open still gets a case, and the sessions signed in since are ended', async () => {
      const u = await person();
      await auth.selfFreeze({ userId: u.userId, actor: me, reason: 'temporary', password: PASSWORD });
      await auth.login({ identifier: u.handle, password: PASSWORD });
      const opened = await auth.startCompromise({ userId: u.userId, actor: me, password: PASSWORD });
      expect(opened.changed).toBe(true);
      expect((await countLive(u.userId)).sessions).toBe(0);
      expect((await auth.compromiseCase(u.userId, me))?.sessionsEnded).toBe(1);
      expect(await db.sql`SELECT id FROM account_self_freezes WHERE user_id = ${u.userId}`).toHaveLength(1);
    });

    it('the checklist ticks from changes recorded after the case opened and from reviews, never before', async () => {
      const u = await person();
      await factor(u.userId, 'password_changed', new Date(Date.now() - 60_000));
      const opened = await auth.startCompromise({ userId: u.userId, actor: me, password: PASSWORD });
      const items = async () =>
        Object.fromEntries((await auth.compromiseCase(u.userId, me))!.checklist.map((entry) => [entry.item, entry.doneAt]));
      let list = await items();
      expect(Object.keys(list)).toEqual(['password', 'second_factor', 'devices', 'api_keys', 'addresses']);
      expect(list).toMatchObject({ password: null, second_factor: null, devices: null, addresses: null });
      expect(list.api_keys).toBe(opened.openedAt.toISOString());

      await factor(u.userId, 'password_changed', new Date());
      await factor(u.userId, 'totp_added', new Date());
      const devices = await auth.markCompromiseReviewed({ userId: u.userId, actor: me, item: 'devices' });
      const repeat = await auth.markCompromiseReviewed({ userId: u.userId, actor: me, item: 'devices' });
      expect(repeat.reviewedAt).toEqual(devices.reviewedAt);
      list = await items();
      expect(list.password).not.toBeNull();
      expect(list.second_factor).not.toBeNull();
      expect(list.devices).toBe(devices.reviewedAt.toISOString());
      expect(list.addresses).toBeNull();

      // A key made after the case opened (once the freeze is lifted) puts the API keys item back to be done.
      await db.sql`UPDATE account_self_freezes SET state = 'lifted', lifted_at = now() WHERE user_id = ${u.userId}`;
      await auth.createApiKey({ userId: u.userId, name: 'late', scopes: ['identity:read'], grantorScopes: SESSION_SCOPES });
      expect((await items()).api_keys).toBeNull();
    });

    it('removing the authenticator alone does not tick the second-step item', async () => {
      const u = await person();
      await auth.startCompromise({ userId: u.userId, actor: me, password: PASSWORD });
      await transaction(db.sql, (tx) =>
        queueFactorChangedNotice(tx, { userId: u.userId, change: 'totp_removed', now: new Date(), mail: false }),
      );
      const list = (await auth.compromiseCase(u.userId, me))!.checklist;
      expect(list.find((entry) => entry.item === 'second_factor')?.doneAt).toBeNull();
    });

    it('an API key or sub-account cannot read the case', async () => {
      const u = await person();
      await auth.startCompromise({ userId: u.userId, actor: me, password: PASSWORD });
      await expect(auth.compromiseCase(u.userId, { ...me, delegated: true })).rejects.toMatchObject({ code: 'auth.mfa_required' });
    });

    it('a stolen-funds report is one note per request id, and with no open case it refuses by name', async () => {
      const u = await person();
      await expect(
        auth.reportStolenFunds({ userId: u.userId, actor: me, body: 'TEST', clientRequestId: 'req-00000001' }),
      ).rejects.toMatchObject({ code: COMPROMISE_NO_CASE });
      await expect(auth.markCompromiseReviewed({ userId: u.userId, actor: me, item: 'addresses' })).rejects.toMatchObject({
        code: COMPROMISE_NO_CASE,
      });
      await auth.startCompromise({ userId: u.userId, actor: me, password: PASSWORD });
      const once = await auth.reportStolenFunds({ userId: u.userId, actor: me, body: 'TEST 1 BTC left', clientRequestId: 'req-00000001' });
      const twice = await auth.reportStolenFunds({ userId: u.userId, actor: me, body: 'TEST 1 BTC left', clientRequestId: 'req-00000001' });
      expect(once.changed).toBe(true);
      expect(twice).toEqual({ noteId: once.noteId, changed: false });
      const other = await auth.reportStolenFunds({ userId: u.userId, actor: me, body: 'TEST more', clientRequestId: 'req-00000002' });
      expect(other.noteId).not.toBe(once.noteId);
      const notes = (await auth.compromiseCase(u.userId, me))!.notes;
      expect(notes.map((note) => [note.kind, note.body])).toEqual([
        ['stolen_funds', 'TEST 1 BTC left'],
        ['stolen_funds', 'TEST more'],
      ]);
      await expect(
        auth.reportStolenFunds({ userId: u.userId, actor: { ...me, delegated: true }, body: 'x', clientRequestId: 'req-00000003' }),
      ).rejects.toMatchObject({ code: 'auth.mfa_required' });
    });
  });
}
