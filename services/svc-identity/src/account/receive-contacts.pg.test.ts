import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { SESSION_SCOPES, issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { mergeRouters, type Context } from '@intafaced/contracts';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from '../auth/auth-service.js';
import type { PasswordResetMail } from '../auth/password-reset.js';
import { RankService } from '../rank/rank-service.js';
import { createIdentityRouter } from '../router.js';
import { createReceiveContactsRouter } from './receive-contacts-router.js';
import { ReceiveContactService, receiveContactSettings, type ReceiveContactTextPort } from './receive-contacts.js';

/**
 * Receive by email or phone (PP-send-request-03, J-pay-03 #6) against real Postgres: an added address counts only once
 * its code is typed back, a payee search by it then finds the account, the sender being off refuses before anything is
 * stored, a blank owner setting refuses, the cap holds, wrong codes run out, and an address someone else holds is never
 * proved twice.
 */

function dedicatedTestUrl(raw: string): string {
  const parsed = new URL(raw);
  const name = parsed.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const ADMIN_URL = dedicatedTestUrl(process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test');
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const tokenConfig = {
  secret: 'an-identity-receive-contacts-pg-secret',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

const available = await postgresAvailable(ADMIN_URL);

if (!available) {
  describe.skip('receive contacts (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_receive',
    url: ADMIN_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig);

  type Sent = { email?: string; phone?: string; code: string; purpose?: string };
  const sent: Sent[] = [];
  const mail: PasswordResetMail = {
    async send(message) {
      sent.push({ email: message.email, code: message.code, purpose: message.purpose });
    },
  };
  const text: ReceiveContactTextPort = {
    async send(message) {
      sent.push({ phone: message.phone, code: message.code });
    },
  };
  let clock = new Date('2026-11-05T12:00:00Z');
  const settings = receiveContactSettings({ max: 2, codeTtlSeconds: 600, codeMaxAttempts: 3 });
  const service = (over: Partial<ConstructorParameters<typeof ReceiveContactService>[0]> = {}) =>
    new ReceiveContactService({ sql: db.sql, mail, text, settings, now: () => clock, log: { warn() {} }, ...over });
  const router = mergeRouters(createIdentityRouter(auth, rank, { registrationOpen: true }), createReceiveContactsRouter(service()));
  const mailOff = createReceiveContactsRouter(service({ mail: undefined, text: undefined }));
  const unset = createReceiveContactsRouter(service({ settings: receiveContactSettings({}) }));

  afterAll(async () => {
    await db.drop();
  });

  async function signUp(handle: string) {
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
    return { userId: session.userId, sessionId: session.sessionId, handle };
  }

  async function ctxOf(who: { userId: string; sessionId: string }, extra: { apiKeyId?: string } = {}): Promise<Context> {
    const { token } = await issueAccessToken(
      { userId: who.userId, sessionId: who.sessionId, scopes: [...SESSION_SCOPES], tier: 'none', mfa: true, ...extra },
      tokenConfig,
    );
    return { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'r' };
  }
  const as = async (who: { userId: string; sessionId: string }) => router.createCaller(await ctxOf(who));
  const lastCode = (to: string) => [...sent].reverse().find((m) => m.email === to || m.phone === to)?.code ?? '';
  const sentTo = (to: string) => sent.filter((m) => m.email === to || m.phone === to).length;

  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => {
        throw new Error('expected a refusal');
      },
      (err: { code?: string; message: string; cause?: { code?: string } }) => ({
        trpc: err.code,
        code: err.cause?.code,
        message: err.message,
      }),
    );

  describe('receiveContacts', () => {
    it('an added email counts only after its code: then a payee search by it finds the account, and removing it stops that', async () => {
      const me = await signUp('rc_owner');
      const payer = await signUp('rc_payer');
      const mine = await as(me);
      const theirs = await as(payer);
      const address = 'Owner.Receive@Example.org';

      const added = await mine.receiveContacts.add({ channel: 'email', target: address });
      expect(added).toEqual({
        contacts: [{ id: expect.any(String), channel: 'email', target: 'owner.receive@example.org', verified: false }],
        max: 2,
      });
      expect(sent.at(-1)).toMatchObject({ email: 'owner.receive@example.org', purpose: 'receive-contact-code' });
      expect(lastCode('owner.receive@example.org')).toMatch(/^\d{6}$/);
      // Not proved yet: nobody finds the account by it.
      expect(await theirs.users.searchPayees({ email: address })).toEqual({ found: false });

      const id = added.contacts[0]!.id;
      const proved = await mine.receiveContacts.verify({ id, code: lastCode('owner.receive@example.org') });
      expect(proved.contacts).toEqual([{ id, channel: 'email', target: 'owner.receive@example.org', verified: true }]);
      expect(await theirs.users.searchPayees({ email: 'owner.receive@example.org' })).toEqual({
        found: true,
        userId: me.userId,
        handle: me.handle,
        self: false,
      });
      const audit = await db.sql<Array<{ event: string }>>`
        SELECT event FROM receive_contact_audit WHERE user_id = ${me.userId} ORDER BY created_at, event`;
      expect(audit.map((row) => row.event).sort()).toEqual(['added', 'code_sent', 'verified']);

      expect((await mine.receiveContacts.remove({ id })).contacts).toEqual([]);
      expect(await theirs.users.searchPayees({ email: address })).toEqual({ found: false });
    });

    it('a phone is proved the same way and found by an exact E.164 number', async () => {
      const me = await signUp('rc_phone');
      const payer = await signUp('rc_phone_payer');
      const mine = await as(me);
      const added = await mine.receiveContacts.add({ channel: 'phone', target: '+4915112345678' });
      await mine.receiveContacts.verify({ id: added.contacts[0]!.id, code: lastCode('+4915112345678') });
      expect(await (await as(payer)).users.searchPayees({ phone: '+4915112345678' })).toMatchObject({ found: true, userId: me.userId });
    });

    it('with the sender off, adding refuses by name and stores nothing', async () => {
      const me = await signUp('rc_mailoff');
      const off = mailOff.createCaller(await ctxOf(me));
      expect(await refusal(off.receiveContacts.add({ channel: 'email', target: 'off@example.org' }))).toMatchObject({
        trpc: 'PRECONDITION_FAILED',
        code: 'identity.receive_contact_mail_off',
      });
      expect(await refusal(off.receiveContacts.add({ channel: 'phone', target: '+4915100000001' }))).toMatchObject({
        code: 'identity.receive_contact_sms_off',
      });
      expect((await off.receiveContacts.list()).contacts).toEqual([]);
    });

    it('blank owner settings refuse adding; a malformed address names the rule', async () => {
      const me = await signUp('rc_unset');
      const blank = unset.createCaller(await ctxOf(me));
      expect(await refusal(blank.receiveContacts.add({ channel: 'email', target: 'a@example.org' }))).toMatchObject({
        code: 'identity.receive_contact_unset',
      });
      expect((await blank.receiveContacts.list()).max).toBeNull();
      const mine = await as(me);
      expect(await refusal(mine.receiveContacts.add({ channel: 'email', target: 'not-an-address' }))).toMatchObject({
        trpc: 'BAD_REQUEST',
        code: 'identity.receive_contact_invalid',
      });
      expect(await refusal(mine.receiveContacts.add({ channel: 'phone', target: '015112345678' }))).toMatchObject({
        code: 'identity.receive_contact_invalid',
      });
    });

    it('the cap counts every address added; adding again while the code works sends nothing new', async () => {
      const me = await signUp('rc_cap');
      const mine = await as(me);
      await mine.receiveContacts.add({ channel: 'email', target: 'cap1@example.org' });
      await mine.receiveContacts.add({ channel: 'email', target: 'cap1@example.org' });
      expect(sentTo('cap1@example.org')).toBe(1);
      await mine.receiveContacts.add({ channel: 'email', target: 'cap2@example.org' });
      expect(await refusal(mine.receiveContacts.add({ channel: 'email', target: 'cap3@example.org' }))).toMatchObject({
        trpc: 'PRECONDITION_FAILED',
        code: 'identity.receive_contact_cap_reached',
      });
      // Once the code's life is over, adding again sends a new one.
      clock = new Date(clock.getTime() + 601_000);
      await mine.receiveContacts.add({ channel: 'email', target: 'cap1@example.org' });
      expect(sentTo('cap1@example.org')).toBe(2);
    });

    it('wrong codes run out, and an expired code is refused the same way', async () => {
      const me = await signUp('rc_wrong');
      const mine = await as(me);
      const { contacts } = await mine.receiveContacts.add({ channel: 'email', target: 'wrong@example.org' });
      const id = contacts[0]!.id;
      const right = lastCode('wrong@example.org');
      const wrong = right === '000000' ? '111111' : '000000';
      for (let i = 0; i < 3; i++) {
        expect(await refusal(mine.receiveContacts.verify({ id, code: wrong }))).toMatchObject({ code: 'identity.contact_code_invalid' });
      }
      // The right code no longer works after three wrong ones.
      expect(await refusal(mine.receiveContacts.verify({ id, code: right }))).toMatchObject({ code: 'identity.contact_code_invalid' });

      clock = new Date(clock.getTime() + 601_000);
      const again = await mine.receiveContacts.add({ channel: 'email', target: 'wrong@example.org' });
      const fresh = lastCode('wrong@example.org');
      clock = new Date(clock.getTime() + 601_000);
      expect(await refusal(mine.receiveContacts.verify({ id: again.contacts[0]!.id, code: fresh }))).toMatchObject({
        code: 'identity.contact_code_invalid',
      });
    });

    it('an address another account proved, or signs in with, reads as a wrong code; another person cannot touch my addresses', async () => {
      const first = await signUp('rc_first');
      const second = await signUp('rc_second');
      const a = await as(first);
      const b = await as(second);
      const one = await a.receiveContacts.add({ channel: 'email', target: 'shared@example.org' });
      await a.receiveContacts.verify({ id: one.contacts[0]!.id, code: lastCode('shared@example.org') });
      const two = await b.receiveContacts.add({ channel: 'email', target: 'shared@example.org' });
      expect(await refusal(b.receiveContacts.verify({ id: two.contacts[0]!.id, code: lastCode('shared@example.org') }))).toMatchObject({
        code: 'identity.contact_code_invalid',
      });
      const theirs = await b.receiveContacts.add({ channel: 'email', target: 'rc_first@example.com' });
      expect(
        await refusal(b.receiveContacts.verify({ id: theirs.contacts.at(-1)!.id, code: lastCode('rc_first@example.com') })),
      ).toMatchObject({ code: 'identity.contact_code_invalid' });

      expect(await refusal(b.receiveContacts.remove({ id: one.contacts[0]!.id }))).toMatchObject({
        trpc: 'NOT_FOUND',
        code: 'auth.not_found',
      });
      expect((await a.receiveContacts.list()).contacts).toHaveLength(1);
    });

    it('an API key cannot add a way to receive', async () => {
      const me = await signUp('rc_key');
      const keyed = router.createCaller(await ctxOf(me, { apiKeyId: 'k1' }));
      expect(await refusal(keyed.receiveContacts.add({ channel: 'email', target: 'key@example.org' }))).toMatchObject({
        trpc: 'FORBIDDEN',
        code: 'identity.delegated_refused',
      });
    });

    it('removing and adding again cannot send more codes inside one code life than the cap', async () => {
      const me = await signUp('rc_budget');
      const mine = await as(me);
      const first = await mine.receiveContacts.add({ channel: 'email', target: 'budget@example.org' });
      await mine.receiveContacts.remove({ id: first.contacts[0]!.id });
      const second = await mine.receiveContacts.add({ channel: 'email', target: 'budget@example.org' });
      await mine.receiveContacts.remove({ id: second.contacts[0]!.id });
      expect(await refusal(mine.receiveContacts.add({ channel: 'email', target: 'budget@example.org' }))).toMatchObject({
        trpc: 'TOO_MANY_REQUESTS',
        code: 'identity.receive_contact_wait',
      });
      expect(sentTo('budget@example.org')).toBe(2);
      expect((await mine.receiveContacts.list()).contacts).toEqual([]);
    });

    it('a code the sender would not take is taken back and named, and adding again sends a new one', async () => {
      const me = await signUp('rc_sendfail');
      let fail = true;
      const flaky: PasswordResetMail = {
        async send(message) {
          if (fail) throw new Error(`smtp down ${message.code}`);
          sent.push({ email: message.email, code: message.code, purpose: message.purpose });
        },
      };
      const api = createReceiveContactsRouter(service({ mail: flaky })).createCaller(await ctxOf(me));
      expect(await refusal(api.receiveContacts.add({ channel: 'email', target: 'flaky@example.org' }))).toMatchObject({
        trpc: 'PRECONDITION_FAILED',
        code: 'identity.receive_contact_send_failed',
      });
      const rows = await db.sql<Array<{ code_hash: string | null }>>`SELECT code_hash FROM receive_contacts WHERE user_id = ${me.userId}`;
      expect(rows).toEqual([{ code_hash: null }]);
      fail = false;
      const again = await api.receiveContacts.add({ channel: 'email', target: 'flaky@example.org' });
      await api.receiveContacts.verify({ id: again.contacts[0]!.id, code: lastCode('flaky@example.org') });
      expect((await api.receiveContacts.list()).contacts[0]).toMatchObject({ verified: true });
    });

    it('wrong codes sent at the same time are each counted: no more than the allowed tries are ever checked', async () => {
      const me = await signUp('rc_race');
      const mine = await as(me);
      const { contacts } = await mine.receiveContacts.add({ channel: 'email', target: 'race@example.org' });
      const id = contacts[0]!.id;
      const right = lastCode('race@example.org');
      const wrong = right === '000000' ? '111111' : '000000';
      const answers = await Promise.allSettled(Array.from({ length: 12 }, () => mine.receiveContacts.verify({ id, code: wrong })));
      expect(answers.every((a) => a.status === 'rejected')).toBe(true);
      const row = await db.sql<Array<{ attempts: number }>>`SELECT attempts FROM receive_contacts WHERE id = ${id}`;
      expect(row[0]!.attempts).toBe(3);
      expect(await refusal(mine.receiveContacts.verify({ id, code: right }))).toMatchObject({ code: 'identity.contact_code_invalid' });
    });

    it('an address that names two accounts pays no one', async () => {
      const holder = await signUp('rc_twice_a');
      const later = await signUp('rc_twice_b');
      const payer = await signUp('rc_twice_payer');
      const a = await as(holder);
      const added = await a.receiveContacts.add({ channel: 'email', target: 'twice@example.org' });
      await a.receiveContacts.verify({ id: added.contacts[0]!.id, code: lastCode('twice@example.org') });
      const theirs = await as(payer);
      expect(await theirs.users.searchPayees({ email: 'twice@example.org' })).toMatchObject({ found: true, userId: holder.userId });
      // Another account later signs in with that address and lets people find it by email.
      // Two statements: changing the address clears its verified stamp (a trigger), as an email change does.
      await db.sql`UPDATE users SET email = 'twice@example.org' WHERE id = ${later.userId}`;
      await db.sql`UPDATE users SET email_verified_at = now(), payee_email_consent = true WHERE id = ${later.userId}`;
      expect(await theirs.users.searchPayees({ email: 'twice@example.org' })).toEqual({ found: false });
    });
  });
}
