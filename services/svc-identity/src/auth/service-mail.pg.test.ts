import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServiceMailRequest } from '@intafaced/contracts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import { ServiceMailError } from './service-mail.js';
import { localMailLine } from './local-mail.js';
import type { MailPurpose } from './password-reset.js';
import { RankService } from '../rank/rank-service.js';

/**
 * Mail another service asks identity to send (`POST /internal/mail`, service-mail.ts): only to an active account's own
 * proved address, once per business key, a changed body under a used key refused, and the link's token gone from the
 * outbox once the mail is handed off. Every value in this file is a TEST fixture.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@127.0.0.1:15491/intafaced_test';
const PASSWORD = 'a long enough sign-in passphrase';
const T0 = Date.parse('2026-10-24T09:00:00.000Z');

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

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('service mail (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(
    db.sql,
    bus,
    rank,
    tokenConfig,
    webauthnConfig,
    randomBytes(32).toString('base64'),
    undefined,
    undefined,
    25,
  );
  auth.useLogger({ warn: () => undefined });

  const sent: Array<{ email: string; code: string; purpose?: MailPurpose; detail?: string; userId?: string; expiresAt: Date }> = [];
  let nowMs = T0;
  let counter = 0;
  const account = async () => {
    const handle = `sm${process.pid}x${++counter}`;
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD });
    return { handle, email: `${handle}@example.com`, userId: session.userId };
  };
  const proved = async () => {
    const who = await account();
    await db.sql`UPDATE users SET email_verified_at = ${new Date(T0)} WHERE id = ${who.userId}`;
    return who;
  };
  const request = (userId: string, over: Partial<ServiceMailRequest> = {}): ServiceMailRequest => ({
    key: `address-approval:${userId}:1`,
    userId,
    purpose: 'withdraw-address-approval',
    token: 'tok_TEST_0123456789abcdef',
    detail: 'TRON (TRC-20) TXy1...9QzA',
    expiresAt: new Date(T0 + 3_600_000).toISOString(),
    ...over,
  });
  const refusal = async (promise: Promise<unknown>) => {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ServiceMailError);
    return (err as ServiceMailError).code;
  };
  const count = async (table: string) => (await db.sql.unsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n;
  const approvals = () => sent.filter((m) => m.purpose === 'withdraw-address-approval');

  beforeEach(async () => {
    bus.reset();
    sent.length = 0;
    nowMs = T0;
    auth.usePasswordResetMail({
      async send(message) {
        sent.push(message);
      },
    });
    auth.usePasswordResetPolicy({ subjectKey: 'test-only-flow-subject-key-0123456789abcdef' });
    auth.useMailRelayTrigger(async () => void (await auth.drainMailOutbox()));
    auth.usePasswordResetClock(() => new Date(nowMs));
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('service mail', () => {
    it("mails the account's own proved address once, with the token only in the link, then clears it from the outbox", async () => {
      const who = await proved();
      const answer = await auth.queueServiceMail(request(who.userId));
      expect(answer).toEqual({ accepted: true, mailId: expect.any(String) });
      expect(approvals()).toEqual([
        expect.objectContaining({
          email: who.email,
          code: 'tok_TEST_0123456789abcdef',
          detail: 'TRON (TRC-20) TXy1...9QzA',
          userId: who.userId,
          expiresAt: new Date(T0 + 3_600_000),
        }),
      ]);
      const [row] = await db.sql<Array<{ status: string; code: string | null; flow_id: string | null }>>`
        SELECT status, code, flow_id FROM mail_outbox WHERE id = ${answer.mailId}
      `;
      expect(row).toEqual({ status: 'sent', code: null, flow_id: null });
      expect(localMailLine(approvals()[0]!)).toBe(
        `LOCAL-TEST purpose=withdraw-address-approval email=${who.email} expires=2026-10-24T10:00:00.000Z detail=TRON_(TRC-20)_TXy1...9QzA link=approveAddress?token=tok_TEST_0123456789abcdef\n`,
      );
    });

    it('answers a retry of the same request with the first mail and sends nothing more', async () => {
      const who = await proved();
      const first = await auth.queueServiceMail(request(who.userId));
      const again = await Promise.all([auth.queueServiceMail(request(who.userId)), auth.queueServiceMail(request(who.userId))]);
      expect(again).toEqual([first, first]);
      expect(approvals()).toHaveLength(1);
      expect(await count('mail_outbox')).toBe(1);
    });

    it('refuses a used key with a different body, and sends nothing for it', async () => {
      const who = await proved();
      await auth.queueServiceMail(request(who.userId));
      expect(await refusal(auth.queueServiceMail(request(who.userId, { token: 'tok_TEST_another_token_99' })))).toBe(
        'identity.mail_key_conflict',
      );
      expect(await refusal(auth.queueServiceMail(request(who.userId, { detail: 'another address' })))).toBe('identity.mail_key_conflict');
      expect(approvals()).toHaveLength(1);
    });

    it('refuses an unknown, frozen or unproved account, and a link that is expired or too far ahead', async () => {
      expect(await refusal(auth.queueServiceMail(request('99999999-9999-4999-8999-999999999999')))).toBe('identity.account_not_found');
      const unproved = await account();
      expect(await refusal(auth.queueServiceMail(request(unproved.userId)))).toBe('identity.email_unproved');
      const frozen = await proved();
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${frozen.userId}`;
      expect(await refusal(auth.queueServiceMail(request(frozen.userId)))).toBe('identity.account_not_active');
      const who = await proved();
      expect(await refusal(auth.queueServiceMail(request(who.userId, { expiresAt: new Date(T0).toISOString() })))).toBe(
        'identity.mail_expiry_invalid',
      );
      expect(await refusal(auth.queueServiceMail(request(who.userId, { expiresAt: new Date(T0 + 8 * 86_400_000).toISOString() })))).toBe(
        'identity.mail_expiry_invalid',
      );
      expect(approvals()).toHaveLength(0);
      expect(await count('mail_outbox')).toBe(0);
    });

    it('answers a retry with the first mail even after its link expired', async () => {
      const who = await proved();
      const first = await auth.queueServiceMail(request(who.userId));
      nowMs = T0 + 2 * 3_600_000;
      expect(await auth.queueServiceMail(request(who.userId))).toEqual(first);
      expect(approvals()).toHaveLength(1);
    });

    it('withdraws a queued mail when the account is frozen or its address changes before the send', async () => {
      auth.useMailRelayTrigger(undefined);
      const frozen = await proved();
      const moved = await proved();
      const a = await auth.queueServiceMail(request(frozen.userId));
      const b = await auth.queueServiceMail(request(moved.userId));
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${frozen.userId}`;
      await db.sql`UPDATE users SET email = ${`new-${moved.email}`} WHERE id = ${moved.userId}`;
      await auth.drainMailOutbox();
      expect(approvals()).toHaveLength(0);
      const rows = await db.sql<Array<{ id: string; status: string; code: string | null }>>`
        SELECT id, status, code FROM mail_outbox ORDER BY id
      `;
      expect(rows).toEqual(
        expect.arrayContaining([
          { id: a.mailId, status: 'suppressed', code: null },
          { id: b.mailId, status: 'suppressed', code: null },
        ]),
      );
    });

    it('refuses while no mail transport is configured, and queues nothing', async () => {
      const who = await proved();
      auth.usePasswordResetMail(undefined);
      expect(await refusal(auth.queueServiceMail(request(who.userId)))).toBe('identity.mail_unwired');
      expect(await count('mail_outbox')).toBe(0);
    });

    it('keeps a queued mail when the send fails, and never sends it twice', async () => {
      const who = await proved();
      auth.usePasswordResetMail({
        async send() {
          throw new Error('TEST transport down');
        },
      });
      const answer = await auth.queueServiceMail(request(who.userId));
      const [row] = await db.sql<
        Array<{ status: string; code: string | null }>
      >`SELECT status, code FROM mail_outbox WHERE id = ${answer.mailId}`;
      // Claimed before the send: the outcome is unknown, the token is gone, and a retry of the request sends nothing.
      expect(row).toEqual({ status: 'unknown', code: null });
      expect(await auth.queueServiceMail(request(who.userId))).toEqual(answer);
      expect(await count('mail_outbox')).toBe(1);
    });
  });
}
