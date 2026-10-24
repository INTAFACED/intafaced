/**
 * A notice for each change to a sign-in factor, against Postgres (I-signin-sessions-08; J-identity-05 #6): turning the
 * authenticator app on, off or replacing it, and removing a passkey, queue a factor-changed mail and an outbox row in the
 * change's own transaction; a refused change queues neither. The relay publishes each row once with its business key.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { AuthService } from './auth-service.js';
import { queueFactorChangedNotice, relaySecurityFactorEvents } from './factor-changed-notice.js';
import { localMailLine } from './local-mail.js';
import { relayMailOutbox } from './password-reset.js';
import { MemoryPendingTotpEnrolmentStore } from './pending-totp-store.js';
import { totp } from './totp.js';
import { TotpLifecycle } from './totp-lifecycle.js';
import { unenrollPasskey } from './unenroll-passkey.js';

function identityTestUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const parsed = new URL(raw);
  if (!parsed.pathname.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const DATABASE_URL = identityTestUrl();
const tokenConfig = {
  secret: 'an-identity-factor-notice-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const webauthnConfig = { rpID: 'localhost', rpName: 'INTAFACED', origin: 'http://localhost:3000' };
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const available = await postgresAvailable(DATABASE_URL);

if (!available) {
  describe.skip('factor change notices (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: DATABASE_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  afterAll(async () => {
    await db.drop();
  });
  const totpKey = randomBytes(32);
  const bus = new MemoryEventBus('svc-identity');
  const auth = new AuthService(
    db.sql,
    bus,
    new RankService(db.sql, bus),
    tokenConfig,
    webauthnConfig,
    totpKey.toString('base64'),
    undefined,
    undefined,
    25,
  );
  auth.useLogger({ warn: () => undefined });
  const lifecycle = () => new TotpLifecycle({ sql: db.sql, key: totpKey, pending: new MemoryPendingTotpEnrolmentStore() });
  const actor = { mfa: true, privileged: false };

  let n = 0;
  /** A TEST account with a password and, unless told otherwise, a proved address. */
  async function account(opts: { proved?: boolean } = {}) {
    const handle = `fc${process.pid}x${++n}`;
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
    if (opts.proved !== false) await db.sql`UPDATE users SET email_verified_at = now() WHERE id = ${session.userId}`;
    return session.userId;
  }
  async function withApp(userId: string) {
    const started = await auth.startTotpEnrolment(userId, { mfa: false, privileged: false });
    await auth.confirmTotpEnrolment(userId, { mfa: false, privileged: false }, started.secret, totp(started.secret));
    // The enrolment spent its step; the next proof in the test may reuse the same 30 seconds.
    await db.sql`UPDATE users SET totp_last_step = NULL WHERE id = ${userId}`;
    return started.secret;
  }
  const events = (userId: string) =>
    db.sql<Array<{ notice_key: string; change: string; published_at: Date | null }>>`
      SELECT notice_key, change, published_at FROM security_factor_events WHERE user_id = ${userId} ORDER BY created_at, notice_key`;
  const mails = (userId: string) =>
    db.sql<Array<{ detail: string | null; dedupe_key: string; code: string | null }>>`
      SELECT detail, dedupe_key, code FROM mail_outbox WHERE user_id = ${userId} AND purpose = 'factor-changed' ORDER BY created_at`;

  describe('factor change notices', () => {
    it('turning the app on, off and replacing it each queue one mail and one event, with distinct keys', async () => {
      const userId = await account();
      const secret = await withApp(userId);
      const l = lifecycle();
      const started = await l.replaceStart(userId);
      await l.replaceConfirm(userId, { secret: started.secret, newCode: totp(started.secret), currentCode: totp(secret) });
      await db.sql`UPDATE users SET totp_last_step = NULL WHERE id = ${userId}`;
      await l.disable(userId, totp(started.secret));

      const rows = await events(userId);
      expect(rows.map((r) => r.change)).toEqual(['totp_added', 'totp_replaced', 'totp_removed']);
      expect(rows.map((r) => r.notice_key)).toEqual([1, 2, 3].map((i) => `factor-changed:${userId}:${i}`));
      const mailed = await mails(userId);
      expect(mailed.map((m) => m.detail)).toEqual(['totp_added', 'totp_replaced', 'totp_removed']);
      expect(mailed.map((m) => m.dedupe_key)).toEqual(rows.map((r) => r.notice_key));
      // A notice carries no code and no secret.
      expect(mailed.every((m) => m.code === null)).toBe(true);
    });

    it('a refused change queues nothing', async () => {
      const userId = await account();
      const secret = await withApp(userId);
      const before = (await events(userId)).length;
      await expect(lifecycle().disable(userId, '000000')).rejects.toMatchObject({ code: 'auth.mfa_invalid' });
      const l = lifecycle();
      const started = await l.replaceStart(userId);
      await expect(
        l.replaceConfirm(userId, { secret: started.secret, newCode: '000000', currentCode: totp(secret) }),
      ).rejects.toMatchObject({ code: 'auth.mfa_invalid' });
      expect(await events(userId)).toHaveLength(before);
      expect(await mails(userId)).toHaveLength(before);
    });

    it('removing a passkey queues passkey_removed, by either door', async () => {
      const userId = await account();
      const cred = (id: string) => ({ credentialId: id, publicKey: 'cGs', counter: 0, transports: ['internal'] });
      await db.sql`UPDATE users SET webauthn_creds = ${db.sql.json([cred('Y3JlZEE'), cred('Y3JlZEI')] as never)} WHERE id = ${userId}`;
      await unenrollPasskey(db.sql, userId, 'Y3JlZEE');
      expect(await auth.removeWebauthnCredential(userId, actor, 'Y3JlZEI')).toBe(true);
      expect((await events(userId)).map((r) => r.change)).toEqual(['passkey_removed', 'passkey_removed']);
      // Removing one that is already gone changes nothing and says nothing.
      expect(await auth.removeWebauthnCredential(userId, actor, 'Y3JlZEI')).toBe(false);
      expect(await events(userId)).toHaveLength(2);
    });

    it('an account with no proved address gets the event but no mail', async () => {
      const userId = await account({ proved: false });
      await withApp(userId);
      expect((await events(userId)).map((r) => r.change)).toEqual(['totp_added']);
      expect(await mails(userId)).toHaveLength(0);
    });

    it('a change rolled back with its transaction leaves neither row', async () => {
      const userId = await account();
      await expect(
        db.sql.begin(async (tx) => {
          await queueFactorChangedNotice(tx, { userId, change: 'passkey_added', now: new Date() });
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');
      expect(await events(userId)).toHaveLength(0);
      expect(await mails(userId)).toHaveLength(0);
    });

    it('the relay publishes each change once with its business key, and a failed publish leaves it for the next run', async () => {
      const userId = await account();
      await withApp(userId);
      await db.sql`UPDATE security_factor_events SET published_at = now() WHERE user_id <> ${userId} AND published_at IS NULL`;

      const failing = { publish: async () => Promise.reject(new Error('bus down')) };
      await expect(relaySecurityFactorEvents({ sql: db.sql, bus: failing, now: () => new Date() })).rejects.toThrow('bus down');
      expect((await events(userId))[0]!.published_at).toBeNull();

      bus.reset();
      expect(await relaySecurityFactorEvents({ sql: db.sql, bus, now: () => new Date() })).toBe(1);
      const sent = bus.emitted('securityFactorChanged');
      expect(sent).toHaveLength(1);
      expect(sent[0]!.idempotencyKey).toBe(`factor-changed:${userId}:1`);
      expect(sent[0]!.payload).toMatchObject({ userId, change: 'totp_added', noticeKey: `factor-changed:${userId}:1` });
      expect((await events(userId))[0]!.published_at).not.toBeNull();
      expect(await relaySecurityFactorEvents({ sql: db.sql, bus, now: () => new Date() })).toBe(0);
      expect(bus.emitted('securityFactorChanged')).toHaveLength(1);
    });

    it('a row published stays published when a later one fails, and the run stops there to keep the order', async () => {
      const userId = await account();
      const secret = await withApp(userId);
      await lifecycle().disable(userId, totp(secret));
      await db.sql`UPDATE security_factor_events SET published_at = now() WHERE user_id <> ${userId} AND published_at IS NULL`;
      let calls = 0;
      const second: Pick<typeof bus, 'publish'> = {
        publish: (async (...args: Parameters<typeof bus.publish>) => {
          calls += 1;
          if (calls === 2) throw new Error('bus down');
          return bus.publish(...args);
        }) as typeof bus.publish,
      };
      await expect(relaySecurityFactorEvents({ sql: db.sql, bus: second, now: () => new Date() })).rejects.toThrow('bus down');
      const [first, rest] = await events(userId);
      expect(first!.published_at).not.toBeNull();
      expect(rest!.published_at).toBeNull();
    });

    it('the mail goes to the proved address with what changed, even after the address changes', async () => {
      const userId = await account();
      await withApp(userId);
      await db.sql`UPDATE users SET email = ${`moved${n}@example.com`} WHERE id = ${userId}`;
      const sent: Array<{ email: string; purpose?: string; detail?: string }> = [];
      await relayMailOutbox({
        sql: db.sql,
        mail: { send: async (message: { email: string; purpose?: string; detail?: string }) => void sent.push(message) },
        ttlSeconds: 900,
        now: () => new Date(),
        log: { warn: () => undefined },
      } as never);
      const mine = sent.filter((m) => m.purpose === 'factor-changed' && m.email.startsWith(`fc${process.pid}x${n}@`));
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ email: `fc${process.pid}x${n}@example.com`, detail: 'totp_added' });
      expect(localMailLine({ ...mine[0]!, code: '', expiresAt: new Date(0) } as never)).toContain('purpose=factor-changed email=');
      expect(localMailLine({ ...mine[0]!, code: '', expiresAt: new Date(0) } as never)).toContain('change=totp_added');
    });
  });
}
