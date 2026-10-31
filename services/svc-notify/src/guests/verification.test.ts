import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  guestVerificationKey,
  retainRawBody,
  S2S_KID_HEADER,
  S2S_NONCE_HEADER,
  serviceAuthHeadersForBody,
  type ServiceVerifier,
} from '@intafaced/contracts';
import { createGuestIngressContext } from './context.js';
import { ChannelDeliveryError, type NotificationChannel, type OutboundMessage } from '../channels/channel.js';
import {
  channelGuestMailSender,
  GuestVerificationService,
  NO_GUEST_MAIL_SENDER,
  type GuestMailOutcome,
  type GuestMailSender,
  type GuestVerificationMail,
} from './verification.js';
import { createNotifyRouter } from '../router.js';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';

const ORIGIN = 'https://app.example.org';
const NOW = new Date('2026-10-30T12:00:00.000Z');

/** A sender that records each mail and answers as told. */
class Recorder implements GuestMailSender {
  readonly notConnected = null;
  readonly sent: GuestVerificationMail[] = [];
  answer: 'accepted' | 'refused' | 'unknown' | 'hang' | 'throw' = 'accepted';
  async send(mail: GuestVerificationMail): Promise<GuestMailOutcome> {
    this.sent.push(mail);
    if (this.answer === 'throw') throw new Error('transport down');
    if (this.answer === 'hang') return new Promise(() => undefined);
    return { status: this.answer, reference: this.answer === 'accepted' ? 'gw.ref-1' : null };
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
  const service = (over: Partial<ConstructorParameters<typeof GuestVerificationService>[2]> = {}, sender: GuestMailSender = mailer) =>
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
    expect(first).toMatchObject({ businessKey: sent.businessKey, status: 'accepted', code: null, reference: 'gw.ref-1' });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: sent.recipientEmail });
    // The transport key is opaque: the request id never reaches an outside sender.
    expect(mailer.sent[0]!.transportKey).toMatch(/^guest-verify-v1:[0-9a-f]{64}$/);
    expect(mailer.sent[0]!.transportKey).not.toContain(sent.guestRequestId);
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
    const waiting = await service({}, NO_GUEST_MAIL_SENDER).send('svc-support', sent);
    expect(waiting).toMatchObject({ status: 'refused', code: 'guest.notification_unconfigured', attemptedAt: null });
    // No sender comes before the link checks: a stack with neither a sender nor an origin still names the sender.
    expect(await service({ origin: '' }, NO_GUEST_MAIL_SENDER).send('svc-support', sent)).toMatchObject({
      code: 'guest.notification_unconfigured',
    });
    // Sending switched off names the switch, not a missing sender.
    expect(await service({ enabled: false }).send('svc-support', sent)).toMatchObject({ code: 'guest.configuration_unverified' });
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
    mailer.answer = 'accepted';
    expect(await service().send('svc-support', lost)).toMatchObject({ status: 'unresolved' });
    expect(mailer.sent.filter((m) => m.to === lost.recipientEmail)).toHaveLength(1);
    mailer.answer = 'refused';
    expect(await service().send('svc-support', input())).toMatchObject({ status: 'refused', code: 'guest.gateway_refused' });
  });

  it('a send already made answers its receipt even after the link expired or the origin moved', async () => {
    const sent = input();
    const first = await service().send('svc-support', sent);
    const later = service({ now: () => new Date('2026-10-30T14:00:00.000Z'), origin: 'https://moved.example.org' });
    expect(await later.send('svc-support', sent)).toEqual(first);
    expect(mailer.sent).toHaveLength(1);
  });

  it('a lease too short to finish a send leaves it unresolved and sends nothing', async () => {
    const sent = input();
    // The lease (2 × timeout + 1s) is read against a clock a minute ahead: too little of it is left to send in.
    const tight = new GuestVerificationService(db.sql, mailer, { origin: ORIGIN, now: () => NOW, timeoutMs: 200 });
    const original = Date.now;
    Date.now = () => original() + 60_000;
    try {
      expect(await tight.send('svc-support', sent)).toMatchObject({ status: 'unresolved', code: 'guest.acceptance_unknown' });
    } finally {
      Date.now = original;
    }
    expect(mailer.sent).toHaveLength(0);
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
    const marks = await db.sql`SELECT fingerprint FROM notify.guest_verifications WHERE guest_request_id = ${requestId}`;
    expect(marks.map((r) => r.fingerprint)).toEqual(['erased', 'erased']);
    const hash = createHash('sha256')
      .update(`guest-verify:${input(requestId).recipientEmail}`)
      .digest('hex');
    expect(await db.sql`SELECT 1 FROM notify.guest_verification_rate_windows WHERE address_hash = ${hash}`).toHaveLength(0);
    await expect(service().send('svc-support', input(requestId, 3))).rejects.toMatchObject({ code: 'guest.request_erased' });
    expect(await service().get('svc-support', { businessKey: guestVerificationKey(requestId, 1) })).toMatchObject({ status: 'accepted' });
    expect(await service().get('svc-support', { businessKey: guestVerificationKey(randomUUID(), 1) })).toBeNull();
  });

  it('a gateway refusal is refused only when permanent; anything else is unknown', async () => {
    const failing = (error: Error): NotificationChannel => ({
      channel: 'email',
      unavailableReason: null,
      deliver: async (_: OutboundMessage) => {
        throw error;
      },
    });
    const mail = { to: 'g@example.org', subject: 's', text: 't', transportKey: 'guest-verify-v1:x' };
    expect(
      await channelGuestMailSender(failing(new ChannelDeliveryError('email', 'bad', { retryable: false, status: 422 }))).send(mail),
    ).toEqual({ status: 'refused' });
    for (const status of [408, 425, 429, 500])
      expect(await channelGuestMailSender(failing(new ChannelDeliveryError('email', 'x', { retryable: true, status }))).send(mail)).toEqual(
        {
          status: 'unknown',
        },
      );
    expect(await channelGuestMailSender(failing(new Error('socket'))).send(mail)).toEqual({ status: 'unknown' });
    expect(channelGuestMailSender(null).notConnected).toBe('vendor.email');
    expect(channelGuestMailSender({ ...failing(new Error('x')), unavailableReason: 'channel.not_configured' }).notConnected).toBe(
      'vendor.email',
    );
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

    it("a call that tried a per-service key and failed never falls back to svc-support's secret", () => {
      const body = JSON.stringify({ businessKey: guestVerificationKey(randomUUID(), 1) });
      const context = createGuestIngressContext({
        edgeSecret,
        opsSecret,
        supportSecret,
        s2s: { verifier: { verify: () => ({ status: 'rejected', reason: 'bad-signature' }) } as ServiceVerifier, mode: 'dual' },
      });
      const request = (extra: Record<string, string>) =>
        ({
          method: 'POST',
          url: '/trpc/guestVerification.get',
          body,
          headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-support', supportSecret, body), ...extra },
        }) as unknown as Parameters<typeof context>[0];
      expect(context(request({})).service).toBe('svc-support');
      expect(context(request({ [S2S_KID_HEADER]: 'svc-support:1' })).service).toBeNull();
      expect(context(request({ [S2S_NONCE_HEADER]: 'n' })).service).toBeNull();
    });

    it('refuses a link elsewhere by its code', async () => {
      const res = await post('send', input(randomUUID(), 1, { link: 'https://elsewhere.example.org/x' }), 'svc-support', supportSecret);
      expect(res.statusCode).toBe(412);
      expect(res.json().error.message).toBe('guest.link_origin_mismatch');
    });
  });
});
