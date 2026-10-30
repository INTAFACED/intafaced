import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { guestVerificationKey, retainRawBody, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { createGuestIngressContext } from './context.js';
import { GuestVerificationService } from './verification.js';
import { createNotifyRouter } from '../router.js';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';
import { NoMailer, type MailOutcome, type StatusMail, type StatusMailer } from '../status-page/mailer.js';

const ORIGIN = 'https://app.example.org';
const NOW = new Date('2026-10-30T12:00:00.000Z');

/** A sender that records each mail and answers as told. */
class Recorder implements StatusMailer {
  readonly kind = 'local-outbox' as const;
  readonly notConnected = null;
  readonly origin = '';
  readonly sent: StatusMail[] = [];
  answer: MailOutcome | 'hang' | 'throw' = { status: 'accepted' };
  async send(mail: StatusMail): Promise<MailOutcome> {
    this.sent.push(mail);
    if (this.answer === 'throw') throw new Error('transport down');
    if (this.answer === 'hang') return new Promise(() => undefined);
    return this.answer;
  }
}

const input = (requestId = randomUUID(), ordinal = 1, over: Record<string, unknown> = {}) => ({
  businessKey: guestVerificationKey(requestId, ordinal),
  guestRequestId: requestId,
  recipientEmail: `guest-${requestId.slice(0, 8)}@example.org`,
  link: `${ORIGIN}/support/guest/verify?token=secret-token-${ordinal}`,
  tokenId: `tok_${ordinal}_12345678`,
  expiresAt: '2026-10-30T13:00:00.000Z',
  ...over,
});

const opsSecret = 'notify-ops-fixture-secret-at-least-32-bytes';
const supportSecret = 'notify-support-fixture-secret-at-least-32-bytes';
const edgeSecret = 'notify-edge-fixture-secret-at-least-32-bytes';

describe('guest verification door (isolated PostgreSQL, ADR 2026-10-22 §3.5)', () => {
  let db: TestDatabase;
  let mailer: Recorder;
  const service = (over: Partial<ConstructorParameters<typeof GuestVerificationService>[2]> = {}, sender: StatusMailer = mailer) =>
    new GuestVerificationService(db.sql, sender, { origin: ORIGIN, now: () => NOW, timeoutMs: 200, ...over });

  beforeAll(async () => {
    db = await createTestDatabase({
      service: 'notify',
      migrations: [readFileSync(new URL('../../drizzle/0037_notify_guest_verifications.sql', import.meta.url), 'utf8')],
    });
  }, 30_000);
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(() => {
    mailer = new Recorder();
  });

  it('mails the link once and never stores it; a replay answers the same receipt', async () => {
    const sent = input();
    const first = await service().send('svc-support', sent);
    expect(first).toMatchObject({ businessKey: sent.businessKey, status: 'accepted', code: null });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: sent.recipientEmail, key: sent.businessKey, purpose: 'guest-verify' });
    expect(mailer.sent[0]!.text).toContain(sent.link);
    expect(await service().send('svc-support', sent)).toEqual(first);
    expect(mailer.sent).toHaveLength(1);
    const rows = await db.sql`SELECT * FROM notify.guest_verifications WHERE business_key = ${sent.businessKey}`;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('secret-token');
    expect(rows[0]).toMatchObject({ producer: 'svc-support', token_id: sent.tokenId, recipient_email: sent.recipientEmail });
  });

  it('refuses a blank origin, a link elsewhere and an expired link before anything is written', async () => {
    const sent = input();
    await expect(service({ origin: '' }).send('svc-support', sent)).rejects.toMatchObject({ code: 'guest.link_origin_unset' });
    await expect(service({ origin: 'https://other.example.org' }).send('svc-support', sent)).rejects.toMatchObject({
      code: 'guest.link_origin_mismatch',
    });
    await expect(service().send('svc-support', { ...sent, link: 'https://app.example.org.evil.example/x' })).rejects.toMatchObject({
      code: 'guest.link_origin_mismatch',
    });
    await expect(service().send('svc-support', { ...sent, expiresAt: '2026-10-30T11:59:59.000Z' })).rejects.toMatchObject({
      code: 'guest.link_expired',
    });
    expect(await db.sql`SELECT 1 FROM notify.guest_verifications WHERE business_key = ${sent.businessKey}`).toHaveLength(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it('with no sender: refused as unconfigured with nothing attempted, and sent once a sender exists', async () => {
    const sent = input();
    const waiting = await service({}, new NoMailer()).send('svc-support', sent);
    expect(waiting).toMatchObject({ status: 'refused', code: 'guest.notification_unconfigured', attemptedAt: null });
    expect(await service({ enabled: false }).send('svc-support', sent)).toMatchObject({ code: 'guest.notification_unconfigured' });
    expect(mailer.sent).toHaveLength(0);
    expect(await service().send('svc-support', sent)).toMatchObject({ status: 'accepted' });
    expect(mailer.sent).toHaveLength(1);
  });

  it('a different ask under the same key is a conflict; a lost answer is unresolved and never sent again', async () => {
    const sent = input();
    await service().send('svc-support', sent);
    await expect(service().send('svc-support', { ...sent, recipientEmail: 'other@example.org' })).rejects.toMatchObject({
      code: 'guest.request_conflict',
    });
    const lost = input();
    mailer.answer = 'hang';
    expect(await service().send('svc-support', lost)).toMatchObject({ status: 'unresolved', code: 'guest.acceptance_unknown' });
    mailer.answer = { status: 'accepted' };
    expect(await service().send('svc-support', lost)).toMatchObject({ status: 'unresolved' });
    expect(mailer.sent.filter((m) => m.key === lost.businessKey)).toHaveLength(1);
    mailer.answer = { status: 'refused', code: 'gateway.refused' };
    expect(await service().send('svc-support', input())).toMatchObject({ status: 'refused', code: 'guest.gateway_refused' });
  });

  it('limits sends per address per window', async () => {
    const address = { recipientEmail: `limited-${randomUUID()}@example.org` };
    const limited = service({ addressMaxPerWindow: 2 });
    await limited.send('svc-support', input(randomUUID(), 1, address));
    await limited.send('svc-support', input(randomUUID(), 1, address));
    expect(await limited.send('svc-support', input(randomUUID(), 1, address))).toMatchObject({
      status: 'refused',
      code: 'guest.address_rate_limited',
    });
  });

  it('erases a request once: the address goes, a tombstone refuses later sends, and erasing again answers the same', async () => {
    const requestId = randomUUID();
    await service().send('svc-support', input(requestId, 1));
    await service().send('svc-support', input(requestId, 2));
    const erased = await service().erase('svc-support', { guestRequestId: requestId });
    expect(erased).toMatchObject({ guestRequestId: requestId, erasedCount: 2 });
    expect(await service().erase('svc-support', { guestRequestId: requestId })).toEqual(erased);
    const rows = await db.sql`SELECT recipient_email FROM notify.guest_verifications WHERE guest_request_id = ${requestId}`;
    expect(rows.map((r) => r.recipient_email)).toEqual([null, null]);
    await expect(service().send('svc-support', input(requestId, 3))).rejects.toMatchObject({ code: 'guest.request_erased' });
    expect(await service().get('svc-support', { businessKey: guestVerificationKey(requestId, 1) })).toMatchObject({ status: 'accepted' });
    expect(await service().get('svc-support', { businessKey: guestVerificationKey(randomUUID(), 1) })).toBeNull();
  });

  describe('the mounted door', () => {
    let app: ReturnType<typeof Fastify>;
    beforeAll(async () => {
      app = Fastify();
      retainRawBody(app);
      const context = createGuestIngressContext({ edgeSecret, opsSecret, supportSecret });
      const router = createNotifyRouter(
        new NotifyService(new MemoryNotifyStore()),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        new GuestVerificationService(db.sql, new Recorder(), { origin: ORIGIN, now: () => NOW }),
      );
      const trpcOptions = { router, createContext: ({ req }) => context(req) } satisfies FastifyTRPCPluginOptions<
        typeof router
      >['trpcOptions'];
      await app.register(fastifyTRPCPlugin, { prefix: '/trpc', trpcOptions });
    });
    afterAll(async () => {
      await app?.close();
    });
    const post = (path: string, payload: unknown, service: string, secret: string) =>
      app.inject({
        method: 'POST',
        url: '/trpc/guestVerification.' + path,
        payload: JSON.stringify(payload),
        headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, secret, JSON.stringify(payload)) },
      });

    it('answers svc-support on its own secret, and nobody else', async () => {
      const sent = input();
      const ok = await post('send', sent, 'svc-support', supportSecret);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().result.data).toMatchObject({ status: 'accepted' });
      // The ops secret cannot name svc-support, and svc-ops is not a caller of this door.
      expect((await post('get', { businessKey: sent.businessKey }, 'svc-support', opsSecret)).statusCode).toBe(401);
      expect((await post('get', { businessKey: sent.businessKey }, 'svc-ops', opsSecret)).statusCode).toBe(403);
      // svc-support's secret names svc-support only.
      expect((await post('send', input(), 'svc-ops', supportSecret)).statusCode).toBe(401);
      expect((await post('get', { businessKey: sent.businessKey }, 'svc-support', supportSecret)).json().result.data).toMatchObject({
        status: 'accepted',
      });
    });

    it('refuses a link elsewhere by its code', async () => {
      const res = await post('send', input(randomUUID(), 1, { link: 'https://elsewhere.example.org/x' }), 'svc-support', supportSecret);
      expect(res.statusCode).toBe(412);
      expect(res.json().error.message).toBe('guest.link_origin_mismatch');
    });
  });
});
