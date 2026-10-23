import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from '../auth/auth-service.js';
import type { PasswordResetMail } from '../auth/password-reset.js';
import { RankService } from '../rank/rank-service.js';
import { antiPhishingKey, sealCode } from './anti-phishing.js';
import { withAntiPhishingCode } from './anti-phishing-mail.js';

/** Identity's mails against Postgres: the account's own proved address gets its anti-phishing code, nothing else does. */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));
const tokenConfig = {
  secret: 'an-identity-anti-phishing-mail-test-secret-long',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('anti-phishing code on mails (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_anti_phishing_mail',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const auth = new AuthService(db.sql, bus, new RankService(db.sql, bus), tokenConfig);
  const key = antiPhishingKey(randomBytes(32));
  const expires = new Date('2026-10-23T12:00:00.000Z');

  afterAll(async () => {
    await db.drop();
  });

  function recorder() {
    const sent: Array<Parameters<PasswordResetMail['send']>[0]> = [];
    return { sent, mail: { send: async (m: Parameters<PasswordResetMail['send']>[0]) => void sent.push(m) } };
  }

  async function accountWithCode(handle: string, code: string | null, sealKey = key, proved = true) {
    const email = `${handle}@example.com`;
    const { userId } = await auth.register({ handle, email, password: 'correct horse battery staple', region: 'DE' });
    if (proved) await db.sql`UPDATE users SET email_verified_at = now() WHERE id = ${userId}`;
    if (code && sealKey) {
      const sealed = sealCode(sealKey, code);
      await db.sql`INSERT INTO anti_phishing_codes (user_id, ciphertext, nonce) VALUES (${userId}, ${sealed.ciphertext}, ${sealed.nonce})`;
    }
    return { email, userId };
  }

  it('adds the code to mails about the account sent to its own address, whatever the address case', async () => {
    const { email } = await accountWithCode('apmailone', 'Harbour42');
    const { sent, mail } = recorder();
    const stamped = withAntiPhishingCode(mail, db.sql, key);
    for (const purpose of ['password-reset', 'email-change-notice', 'handle-recovery', 'signup-existing'] as const) {
      await stamped.send({ email: email.toUpperCase(), code: 'x', expiresAt: expires, purpose });
    }
    await stamped.send({ email, code: 'x', expiresAt: expires });
    expect(sent.map((m) => m.antiPhishingCode)).toEqual(Array(5).fill('Harbour42'));
    // The rest of the message is passed on as it was.
    expect(sent[0]).toMatchObject({ email: email.toUpperCase(), code: 'x', purpose: 'password-reset' });
  });

  it('the address-change notice, sent to the old address after the switch, still carries the code by the account', async () => {
    const { email, userId } = await accountWithCode('apmailsix', 'Beacon5');
    await db.sql`UPDATE users SET email = 'apmailsix-new@example.com' WHERE id = ${userId}`;
    const { sent, mail } = recorder();
    const stamped = withAntiPhishingCode(mail, db.sql, key);
    await stamped.send({ email, userId, code: '', expiresAt: expires, purpose: 'email-change-notice' });
    // Without the account named, the old address names nobody (or someone else) and carries nothing.
    await stamped.send({ email, code: '', expiresAt: expires, purpose: 'email-change-notice' });
    expect(sent.map((m) => m.antiPhishingCode)).toEqual(['Beacon5', undefined]);
  });

  it('leaves it off mails to an address that is not yet the account’s or not proved, and off accounts with no code', async () => {
    const { email } = await accountWithCode('apmailtwo', 'Lantern7');
    const { email: plain } = await accountWithCode('apmailthree', null);
    const { email: unproved } = await accountWithCode('apmailseven', 'Anchor3', key, false);
    const { sent, mail } = recorder();
    const stamped = withAntiPhishingCode(mail, db.sql, key);
    await stamped.send({ email: 'new-address@example.com', code: 'x', expiresAt: expires, purpose: 'email-change' });
    await stamped.send({ email, code: 'x', expiresAt: expires, purpose: 'email-change' });
    await stamped.send({ email, code: '123456', expiresAt: expires, purpose: 'signup-code' });
    await stamped.send({ email: 'nobody@example.com', code: '', expiresAt: expires, purpose: 'reset-no-account' });
    await stamped.send({ email: 'nobody@example.com', code: 'x', expiresAt: expires, purpose: 'password-reset' });
    await stamped.send({ email: plain, code: 'x', expiresAt: expires, purpose: 'password-reset' });
    await stamped.send({ email: unproved, code: 'x', expiresAt: expires, purpose: 'password-reset' });
    await stamped.send({ email, code: 'tok', expiresAt: expires, purpose: 'email-confirm' });
    expect(sent).toHaveLength(8);
    expect(sent.every((m) => !('antiPhishingCode' in m))).toBe(true);
  });

  it('sends without the code when no key is set or the code was sealed under another key', async () => {
    const { email } = await accountWithCode('apmailfour', 'Compass88', antiPhishingKey(randomBytes(32)));
    const { sent, mail } = recorder();
    await withAntiPhishingCode(mail, db.sql, key).send({ email, code: 'x', expiresAt: expires, purpose: 'password-reset' });
    const { email: own } = await accountWithCode('apmailfive', 'Compass89');
    await withAntiPhishingCode(mail, db.sql, null).send({ email: own, code: 'x', expiresAt: expires, purpose: 'password-reset' });
    expect(sent.map((m) => m.antiPhishingCode)).toEqual([undefined, undefined]);
  });

  it('a failed lookup still sends the mail, without the code, since the relay cannot send it twice', async () => {
    const { sent, mail } = recorder();
    const broken = (async () => {
      throw new Error('db down');
    }) as unknown as typeof db.sql;
    await withAntiPhishingCode(mail, broken, key).send({
      email: 'x@example.com',
      code: 'x',
      expiresAt: expires,
      purpose: 'password-reset',
    });
    expect(sent).toEqual([expect.objectContaining({ email: 'x@example.com', code: 'x' })]);
    expect(sent[0]).not.toHaveProperty('antiPhishingCode');
  });
}
