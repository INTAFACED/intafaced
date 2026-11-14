import { describe, expect, it } from 'vitest';
import { SERVICE_MAIL_PATH } from '@intafaced/contracts';
import { chatMailRequest, createIdentityChatMail, SUPPORT_CHAT_EMAIL_UNAVAILABLE, SUPPORT_CHAT_EMAIL_UNPROVED } from './chat-email.js';

const SESSION = '7b0c2f4e-1d7a-4b8e-9c55-2f6f1a0b9e11';
const USER = '0a6b7f3c-5c1e-4a7d-8f3e-1b2c3d4e5f60';
const MAIL_ID = '3c2d1e0f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

function identity(status: number, body: unknown) {
  const calls: { url: string; body: string }[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return {
    calls,
    port: createIdentityChatMail('http://identity.test/', 'a-support-chat-mail-test-secret-long-enough', undefined, fetchFn),
  };
}

const request = chatMailRequest({ sessionId: SESSION, userId: USER, now: new Date('2026-11-12T23:59:00Z') });

describe('chat mail through identity', () => {
  it('asks once per chat per UTC day, shown valid to the end of the seventh day', () => {
    expect(request).toEqual({
      key: `support-chat-email:${SESSION}:2026-11-12`,
      userId: USER,
      purpose: 'support-chat-email',
      token: SESSION,
      detail: 'support chat',
      expiresAt: '2026-11-19T00:00:00.000Z',
    });
  });

  it('posts to identity’s mail door and answers its mail id', async () => {
    const { calls, port } = identity(200, { accepted: true, mailId: MAIL_ID });
    expect(await port.send(request)).toEqual({ mailId: MAIL_ID });
    expect(calls).toEqual([{ url: `http://identity.test${SERVICE_MAIL_PATH}`, body: JSON.stringify(request) }]);
  });

  it('identity with no mail transport is no mailbox (vendor.email)', async () => {
    expect(await identity(503, { code: 'identity.mail_unwired' }).port.send(request)).toBeNull();
  });

  it('an unproved address refuses by name; anything else is unavailable, never a sent mail', async () => {
    await expect(identity(409, { code: 'identity.email_unproved' }).port.send(request)).rejects.toMatchObject({
      code: SUPPORT_CHAT_EMAIL_UNPROVED,
    });
    await expect(identity(403, { code: 'identity.mail_caller_refused' }).port.send(request)).rejects.toMatchObject({
      code: SUPPORT_CHAT_EMAIL_UNAVAILABLE,
    });
    await expect(identity(200, { accepted: true }).port.send(request)).rejects.toMatchObject({ code: SUPPORT_CHAT_EMAIL_UNAVAILABLE });
  });
});
