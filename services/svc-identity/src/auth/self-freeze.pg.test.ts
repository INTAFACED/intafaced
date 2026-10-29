import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { SESSION_SCOPES } from '@intafaced/auth';
import { selfFreezeStateSchema } from '@intafaced/contracts';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import { SelfFreezeLift } from './self-freeze-lift.js';
import type { FactorActor } from './factor-gate.js';
import { RankService } from '../rank/rank-service.js';
import { FREEZE_LINK_INVALID, mintFreezeLink, withFreezeLink } from './freeze-link.js';
import { localMailLine } from './local-mail.js';
import type { PasswordResetMail } from './password-reset.js';

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
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, undefined, undefined, undefined, undefined, 5);
  await rank.seedTiers();
  let n = 0;
  const unique = () => `sf${process.pid}${++n}`;
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

  describe('self-service account freeze', () => {
    it('revokes every session and key, records one open freeze, and a repeat changes nothing', async () => {
      const u = await person();
      await auth.createApiKey({ userId: u.userId, name: 'k', scopes: ['identity:read'], grantorScopes: SESSION_SCOPES });
      expect((await countLive(u.userId)).keys).toBe(1);
      const first = await auth.selfFreeze({ userId: u.userId, actor: me, reason: 'compromise', password: PASSWORD });
      expect(first).toMatchObject({ frozen: true, reason: 'compromise', changed: true });
      expect(await countLive(u.userId)).toEqual({ sessions: 0, keys: 0 });
      const again = await auth.selfFreeze({ userId: u.userId, actor: me, reason: 'personal', password: PASSWORD });
      expect(again).toMatchObject({ reason: 'compromise', changed: false });
      expect(await auth.selfFreezeStatus(u.userId)).toMatchObject({ frozen: true, reason: 'compromise' });
      const rows = await db.sql`SELECT id FROM account_self_freezes WHERE user_id = ${u.userId}`;
      expect(rows).toHaveLength(1);
    });

    it('refuses a wrong password and changes nothing', async () => {
      const u = await person();
      await expect(
        auth.selfFreeze({ userId: u.userId, actor: me, reason: 'temporary', password: 'wrong password here' }),
      ).rejects.toMatchObject({
        code: 'auth.invalid_credentials',
      });
      expect(await auth.selfFreezeStatus(u.userId)).toEqual({ frozen: false, reason: null, since: null });
    });

    it('refuses an API key or sub-account caller', async () => {
      const u = await person();
      await expect(
        auth.selfFreeze({ userId: u.userId, actor: { ...me, delegated: true }, reason: 'temporary', password: PASSWORD }),
      ).rejects.toMatchObject({ code: 'auth.mfa_required' });
    });

    it('allows a staff-frozen account to self-freeze and leaves the staff freeze in place', async () => {
      const u = await person();
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${u.userId}`;
      await expect(auth.selfFreeze({ userId: u.userId, actor: me, reason: 'personal', password: PASSWORD })).resolves.toMatchObject({
        changed: true,
      });
      const row = await db.sql<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${u.userId}`;
      expect(row[0]!.status).toBe('frozen');
    });

    it('refuses a closed account', async () => {
      const u = await person();
      await db.sql`UPDATE users SET status = 'closed' WHERE id = ${u.userId}`;
      await expect(auth.selfFreeze({ userId: u.userId, actor: me, reason: 'personal', password: PASSWORD })).rejects.toMatchObject({
        code: 'auth.account_frozen',
      });
    });

    it('stops a new API key while the freeze is open', async () => {
      const u = await person();
      await auth.selfFreeze({ userId: u.userId, actor: me, reason: 'compromise', password: PASSWORD });
      await expect(
        auth.createApiKey({ userId: u.userId, name: 'k', scopes: ['identity:read'], grantorScopes: SESSION_SCOPES }),
      ).rejects.toMatchObject({ code: 'identity.account_frozen_self' });
    });

    it('reads to other services as frozen with its start while open, unfrozen after the lift, and null for an unknown user', async () => {
      const u = await person();
      const before = await auth.selfFreezeState(u.userId);
      expect(selfFreezeStateSchema.parse(before)).toEqual({ userId: u.userId, frozen: false, since: null });
      const done = await auth.selfFreeze({ userId: u.userId, actor: me, reason: 'compromise', password: PASSWORD });
      const during = selfFreezeStateSchema.parse(await auth.selfFreezeState(u.userId));
      expect(during).toEqual({ userId: u.userId, frozen: true, since: done.since.toISOString() });
      await expect(new SelfFreezeLift(db.sql, 0).lift(u.userId)).resolves.toMatchObject({ frozen: false, changed: true });
      expect(selfFreezeStateSchema.parse(await auth.selfFreezeState(u.userId))).toEqual({ userId: u.userId, frozen: false, since: null });
      expect(await auth.selfFreezeState('00000000-0000-4000-8000-000000000000')).toBeNull();
    });

    it('leaves other people untouched', async () => {
      const a = await person();
      const b = await person();
      await auth.selfFreeze({ userId: a.userId, actor: me, reason: 'temporary', password: PASSWORD });
      expect(await auth.selfFreezeStatus(b.userId)).toMatchObject({ frozen: false });
      expect((await countLive(b.userId)).sessions).toBeGreaterThan(0);
    });
  });
  describe('the freeze link a security notice carries', () => {
    const sent: Array<Parameters<PasswordResetMail['send']>[0]> = [];
    const warned: string[] = [];
    const outbox = withFreezeLink({ send: async (m) => void sent.push(m) }, db.sql, { warn: (_o, msg) => void warned.push(msg) });
    const notice = async (userId: string, email: string, purpose: 'password-changed' | 'password-reset') => {
      sent.length = 0;
      await outbox.send({ email, userId, code: '', expiresAt: new Date(Date.now() + 60_000), purpose });
      return sent[0]!;
    };

    it('rides on a security notice and never on another mail', async () => {
      const u = await person();
      const email = `${u.handle}@example.com`;
      const m = await notice(u.userId, email, 'password-changed');
      expect(m.freezeToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(localMailLine(m)).toContain(`freeze=freeze/confirm?token=${m.freezeToken}`);
      expect((await notice(u.userId, email, 'password-reset')).freezeToken).toBeUndefined();
      const stored = await db.sql<Array<{ token_hash: string }>>`SELECT token_hash FROM self_freeze_links WHERE user_id = ${u.userId}`;
      expect(stored).toHaveLength(1);
      expect(stored[0]!.token_hash).not.toContain(m.freezeToken!);
    });

    it('used once freezes with no session and no key left; used twice shows the stored result and changes nothing', async () => {
      const u = await person();
      await auth.createApiKey({ userId: u.userId, name: 'k', scopes: ['identity:read'], grantorScopes: SESSION_SCOPES });
      const token = (await notice(u.userId, `${u.handle}@example.com`, 'password-changed')).freezeToken!;
      const first = await auth.redeemFreezeLink({ token });
      expect(first).toMatchObject({ userId: u.userId, firstUse: true, changed: true });
      expect(await countLive(u.userId)).toEqual({ sessions: 0, keys: 0 });
      expect(await auth.selfFreezeStatus(u.userId)).toMatchObject({ frozen: true, reason: 'compromise', since: first.since });
      const second = await auth.redeemFreezeLink({ token });
      expect(second).toEqual({ userId: u.userId, since: first.since, firstUse: false, changed: false, frozenNow: true });
      const rows = await db.sql`SELECT id FROM account_self_freezes WHERE user_id = ${u.userId}`;
      expect(rows).toHaveLength(1);
    });

    it('a link used while a freeze is open keeps that freeze and still ends a session that outlived it', async () => {
      const u = await person();
      const done = await auth.selfFreeze({ userId: u.userId, actor: me, reason: 'temporary', password: PASSWORD });
      await db.sql`UPDATE sessions SET revoked = false WHERE user_id = ${u.userId}`;
      expect((await countLive(u.userId)).sessions).toBeGreaterThan(0);
      const token = await mintFreezeLink(db.sql, { userId: u.userId, email: `${u.handle}@example.com`, purpose: 'factor-changed' });
      const used = await auth.redeemFreezeLink({ token: token! });
      expect(used).toMatchObject({ since: done.since, firstUse: true, changed: true, frozenNow: true });
      expect(await countLive(u.userId)).toEqual({ sessions: 0, keys: 0 });
      expect(await auth.selfFreezeStatus(u.userId)).toMatchObject({ reason: 'temporary' });
      const rows = await db.sql`SELECT id FROM account_self_freezes WHERE user_id = ${u.userId}`;
      expect(rows).toHaveLength(1);
    });

    it('a used link after the freeze was lifted shows the stored result and says it no longer holds', async () => {
      const u = await person();
      const token = (await notice(u.userId, `${u.handle}@example.com`, 'password-changed')).freezeToken!;
      const first = await auth.redeemFreezeLink({ token });
      await db.sql`UPDATE account_self_freezes SET state = 'lifted' WHERE user_id = ${u.userId}`;
      const again = await auth.redeemFreezeLink({ token });
      expect(again).toMatchObject({ since: first.since, firstUse: false, changed: false, frozenNow: false });
      expect(await auth.selfFreezeStatus(u.userId)).toMatchObject({ frozen: false });
    });

    it('a link stops working once the account moved to another address, except the notice of that change', async () => {
      const u = await person();
      const email = `${u.handle}@example.com`;
      const plain = await mintFreezeLink(db.sql, { userId: u.userId, email, purpose: 'password-changed' });
      const change = await mintFreezeLink(db.sql, { userId: u.userId, email, purpose: 'email-change-notice' });
      await db.sql`UPDATE users SET email = ${`moved-${u.handle}@example.com`} WHERE id = ${u.userId}`;
      await expect(auth.redeemFreezeLink({ token: plain! })).rejects.toMatchObject({ code: FREEZE_LINK_INVALID });
      expect(await auth.selfFreezeStatus(u.userId)).toMatchObject({ frozen: false });
      await expect(auth.redeemFreezeLink({ token: change! })).resolves.toMatchObject({ firstUse: true, changed: true });
    });

    it('a failed mint still sends the notice, without a link, and logs it', async () => {
      const broken = withFreezeLink({ send: async (m) => void sent.push(m) }, {} as never, { warn: (_o, msg) => void warned.push(msg) });
      sent.length = 0;
      warned.length = 0;
      await broken.send({ email: 'a@example.com', code: '', expiresAt: new Date(), purpose: 'password-changed' });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.freezeToken).toBeUndefined();
      expect(warned).toEqual(['auth.freeze_link_mint_failed']);
    });

    it('a staff-frozen account still freezes itself by link, and the staff freeze stays', async () => {
      const u = await person();
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${u.userId}`;
      const token = await mintFreezeLink(db.sql, { userId: u.userId, email: `${u.handle}@example.com`, purpose: 'password-changed' });
      await expect(auth.redeemFreezeLink({ token: token! })).resolves.toMatchObject({ changed: true });
      const row = await db.sql<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${u.userId}`;
      expect(row[0]!.status).toBe('frozen');
    });

    it('an unknown token, an empty one, and a closed account all get the one refusal and change nothing', async () => {
      await expect(auth.redeemFreezeLink({ token: 'not-a-real-token-at-all' })).rejects.toMatchObject({ code: FREEZE_LINK_INVALID });
      await expect(auth.redeemFreezeLink({ token: '  ' })).rejects.toMatchObject({ code: FREEZE_LINK_INVALID });
      const u = await person();
      const token = await mintFreezeLink(db.sql, { userId: u.userId, email: `${u.handle}@example.com`, purpose: 'password-changed' });
      const used = await mintFreezeLink(db.sql, { userId: u.userId, email: `${u.handle}@example.com`, purpose: 'password-changed' });
      await auth.redeemFreezeLink({ token: used! });
      await db.sql`UPDATE account_self_freezes SET state = 'lifted' WHERE user_id = ${u.userId}`;
      await db.sql`UPDATE users SET status = 'closed' WHERE id = ${u.userId}`;
      await expect(auth.redeemFreezeLink({ token: token! })).rejects.toMatchObject({ code: FREEZE_LINK_INVALID });
      await expect(auth.redeemFreezeLink({ token: used! })).rejects.toMatchObject({ code: FREEZE_LINK_INVALID });
      expect(await auth.selfFreezeStatus(u.userId)).toMatchObject({ frozen: false });
      expect(await mintFreezeLink(db.sql, { userId: u.userId, email: 'x@example.com', purpose: 'password-changed' })).toBeNull();
    });

    it('a notice to an address with no account carries no link', async () => {
      sent.length = 0;
      await outbox.send({ email: 'nobody-here@example.com', code: '', expiresAt: new Date(), purpose: 'password-changed' });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.freezeToken).toBeUndefined();
    });
  });
}
