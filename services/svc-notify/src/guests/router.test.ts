import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { retainRawBody, serviceAuthHeadersForBody, serviceAuthHeaders, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createGuestIngressContext } from './context.js';
import { GuestNotificationService } from './service.js';
import { createNotifyRouter } from '../router.js';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';

const opsSecret = 'notify-ops-fixture-secret-at-least-32-bytes';
const edgeSecret = 'notify-edge-fixture-secret-at-least-32-bytes';
describe('Guest ingress authenticates the exact original ops POST', () => {
  let db: TestDatabase;
  let app: ReturnType<typeof Fastify>;
  beforeAll(async () => {
    db = await createTestDatabase({
      service: 'notify',
      migrations: [readFileSync(new URL('../../drizzle/0009_guest_notifications.sql', import.meta.url), 'utf8')],
    });
    app = Fastify();
    retainRawBody(app);
    const context = createGuestIngressContext({ edgeSecret, opsSecret });
    const router = createNotifyRouter(
      new NotifyService(new MemoryNotifyStore()),
      undefined,
      undefined,
      new GuestNotificationService(db.sql, null),
    );
    const trpcOptions = { router, createContext: ({ req }) => context(req) } satisfies FastifyTRPCPluginOptions<
      typeof router
    >['trpcOptions'];
    await app.register(fastifyTRPCPlugin, { prefix: '/trpc', trpcOptions });
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  }, 30_000);
  const input = () => ({
    businessKey: `acknowledgement:${randomUUID()}`,
    contactId: randomUUID(),
    submissionId: randomUUID(),
    recipientEmail: 'prospect@example.com',
    message: { kind: 'enquiry_acknowledgement' },
  });
  function post(path: string, payload: unknown, service = 'svc-ops', signedBody = JSON.stringify(payload)) {
    return app.inject({
      method: 'POST',
      url: '/trpc/guestNotifications.' + path,
      payload: JSON.stringify(payload),
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, opsSecret, signedBody) },
    });
  }
  it('accepts only ops, binds get to POST bytes, and refuses altered bodies and GETs', async () => {
    const original = input();
    const accepted = await post('send', original);
    expect(accepted.statusCode).toBe(200);
    const received = accepted.json().result.data;
    expect(received).toMatchObject({ status: 'refused', code: 'guest.notification_unconfigured' });
    expect((await post('get', { businessKey: original.businessKey })).json().result.data).toEqual(received);
    expect((await post('get', { businessKey: original.businessKey }, 'svc-trade')).statusCode).toBe(403);
    expect((await post('send', { ...original, recipientEmail: 'other@example.com' }, 'svc-ops', JSON.stringify(original))).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/trpc/guestNotifications.get?input=' + encodeURIComponent(JSON.stringify({ businessKey: original.businessKey })),
        })
      ).statusCode,
    ).not.toBe(200);
  });
  it('an authenticated platform founder still cannot use guest ingress without the ops credential', async () => {
    const userId = randomUUID();
    const principal = {
      userId,
      sub: userId,
      sid: randomUUID(),
      tier: 'full' as const,
      mfa: true,
      scopes: ['admin:write', 'notify:read', 'notify:write'],
      expiresAt: new Date(Date.now() + 60000),
    };
    const raw = encodePrincipal(principal);
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/guestNotifications.send',
      payload: input(),
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, edgeSecret),
      },
    });
    expect(response.statusCode).toBe(401);
    const platform = await app.inject({
      method: 'GET',
      url: '/trpc/notify.list?input=' + encodeURIComponent(JSON.stringify({ limit: 1 })),
      headers: { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, edgeSecret) },
    });
    expect(platform.statusCode).toBe(200);
    expect(platform.json().result.data.items).toEqual([]);
  });
  it('rejects injected templates, authority and recipient lookup fields before persistence', async () => {
    for (const extra of [
      { userId: randomUUID() },
      { subject: 'arbitrary' },
      { href: 'https://example.com/?token=secret' },
      { actorUserId: randomUUID() },
    ]) {
      expect((await post('send', { ...input(), ...extra })).statusCode).toBe(400);
    }
  });
  it('erasure is ops-only, strictly bound and replayable through the mounted route', async () => {
    const original = input();
    await post('send', original);
    const erase = { requestId: randomUUID(), submissionId: original.submissionId };
    expect((await post('eraseSubmission', erase, 'svc-trade')).statusCode).toBe(403);
    const response = await post('eraseSubmission', erase);
    expect(response.statusCode).toBe(200);
    expect(response.json().result.data).toMatchObject({ ...erase, erasedCount: 1 });
    expect((await post('eraseSubmission', erase)).json()).toEqual(response.json());
    expect((await post('get', { businessKey: original.businessKey })).json().result.data).toMatchObject({
      code: 'guest.submission_erased',
    });
  });
  it('missing configuration, v1 signatures and parsed objects without original bytes never grant ingress', () => {
    const body = JSON.stringify(input());
    const headers = serviceAuthHeadersForBody('svc-ops', opsSecret, body);
    expect(createGuestIngressContext({ edgeSecret })({ headers, body }).service).toBeNull();
    expect(
      createGuestIngressContext({ edgeSecret, opsSecret })({ headers: serviceAuthHeaders('svc-ops', opsSecret), body }).service,
    ).toBeNull();
    expect(createGuestIngressContext({ edgeSecret, opsSecret })({ headers, body: JSON.parse(body) }).service).toBeNull();
    expect(
      createGuestIngressContext({ edgeSecret, opsSecret })({
        headers: serviceAuthHeadersForBody('svc-ops', opsSecret, ''),
        body: JSON.parse(body),
      }).service,
    ).toBeNull();
  });
});
