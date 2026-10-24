import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { retainRawBody, serviceAuthHeadersForBody, SERVICE_MAIL_PATH, type ServiceMailRequest } from '@intafaced/contracts';
import { registerServiceMailRoute, ServiceMailError } from './service-mail.js';

const SECRET = 'm'.repeat(32);
const USER = '11111111-1111-4111-8111-111111111111';
const MAIL_ID = '22222222-2222-4222-8222-222222222222';

function body(over: Partial<ServiceMailRequest> = {}): ServiceMailRequest {
  return {
    key: 'address-approval:addr-1:1',
    userId: USER,
    purpose: 'withdraw-address-approval',
    token: 'tok_0123456789abcdefABCDEF',
    detail: 'TRON (TRC-20) TXy1...9QzA',
    expiresAt: '2026-10-25T09:00:00.000Z',
    ...over,
  };
}

async function app(queue: (input: ServiceMailRequest) => Promise<{ accepted: true; mailId: string }>) {
  const server = Fastify({ logger: false });
  retainRawBody(server);
  registerServiceMailRoute(server, { queue, internalSecret: SECRET });
  await server.ready();
  return server;
}

function post(payload: unknown, service = 'svc-bank') {
  const raw = JSON.stringify(payload);
  return {
    method: 'POST' as const,
    url: SERVICE_MAIL_PATH,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, raw) },
    payload: raw,
  };
}

describe('POST /internal/mail', () => {
  it("needs service credentials, and only the purpose's own caller may ask", async () => {
    const asked: ServiceMailRequest[] = [];
    const server = await app(async (input) => {
      asked.push(input);
      return { accepted: true, mailId: MAIL_ID };
    });
    expect((await server.inject({ method: 'POST', url: SERVICE_MAIL_PATH, payload: body() })).statusCode).toBe(401);
    const other = await server.inject(post(body(), 'svc-trade'));
    expect(other.statusCode).toBe(403);
    expect(other.json().code).toBe('identity.mail_caller_refused');
    expect(asked).toHaveLength(0);

    const ok = await server.inject(post(body()));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ accepted: true, mailId: MAIL_ID });
    expect(asked).toEqual([body()]);
  });

  it('refuses a malformed request before anything is queued', async () => {
    let calls = 0;
    const server = await app(async () => {
      calls += 1;
      return { accepted: true, mailId: MAIL_ID };
    });
    for (const bad of [
      { ...body(), email: 'someone@example.com' },
      body({ token: 'short' }),
      body({ key: 'a key with spaces' }),
      body({ detail: '<a href="x">click</a>' }),
      { ...body(), purpose: 'password-reset' },
    ]) {
      const res = await server.inject(post(bad));
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('identity.mail_request_invalid');
    }
    expect(calls).toBe(0);
  });

  it('answers each refusal with its own status and code', async () => {
    const cases = [
      ['identity.account_not_found', 404],
      ['identity.account_not_active', 409],
      ['identity.email_unproved', 409],
      ['identity.mail_key_conflict', 409],
      ['identity.mail_expiry_invalid', 400],
      ['identity.mail_unwired', 503],
    ] as const;
    for (const [code, status] of cases) {
      const server = await app(async () => {
        throw new ServiceMailError(code, 'refused');
      });
      const res = await server.inject(post(body()));
      expect(res.statusCode).toBe(status);
      expect(res.json().code).toBe(code);
    }
  });
});
