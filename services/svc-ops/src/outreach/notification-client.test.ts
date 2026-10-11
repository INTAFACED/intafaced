import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { verifyServiceHeaders, type GuestNotificationSendInput } from '@intafaced/contracts';
import { createOutreachNotificationClient } from './notification-client.js';

const secret = 'dedicated-ops-notify-fixture-key-32';
const input: GuestNotificationSendInput = {
  businessKey: `acknowledgement:${randomUUID()}`,
  contactId: randomUUID(),
  submissionId: randomUUID(),
  recipientEmail: 'prospect@example.test',
  message: { kind: 'enquiry_acknowledgement' },
};
describe('bounded exact-body guest ingress', () => {
  it('uses real HTTP POSTs and v2 bytes for send, get and erasure, with bound receipts', async () => {
    const calls: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const authenticated = verifyServiceHeaders(request.headers, secret, { mode: 'require', rawBody: { retained: true, bytes } });
      expect(authenticated).toMatchObject({ service: 'svc-ops', scheme: 'v2', rejected: null });
      expect(request.method).toBe('POST');
      calls.push(request.url!);
      const wire = JSON.parse(bytes.toString('utf8'));
      let data: unknown = {
        notificationId: randomUUID(),
        businessKey: wire.businessKey,
        status: 'accepted',
        attemptedAt: '2026-10-10T12:00:00Z',
        acceptedAt: '2026-10-10T12:00:01Z',
        code: null,
        reference: 'fixture-ref',
      };
      if (request.url!.endsWith('eraseSubmission')) data = { ...wire, erasedCount: 1, erasedAt: '2026-10-10T12:00:02Z' };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ result: { data } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture address missing');
    try {
      const client = createOutreachNotificationClient({ notifyUrl: `http://127.0.0.1:${address.port}`, secret });
      expect((await client.send(input))?.status).toBe('accepted');
      expect((await client.get(input.businessKey))?.businessKey).toBe(input.businessKey);
      const erase = { requestId: randomUUID(), submissionId: input.submissionId };
      expect(await client.eraseSubmission(erase)).toMatchObject({ ...erase, erasedCount: 1 });
      expect(calls).toEqual(['/trpc/guestNotifications.send', '/trpc/guestNotifications.get', '/trpc/guestNotifications.eraseSubmission']);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
  it('refuses missing config, redirects, foreign/malformed receipts and bounds stuck fetch or body independently of abort', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await createOutreachNotificationClient({ fetcher }).send(input)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    const configured = { notifyUrl: 'https://notify.invalid', secret };
    for (const data of [{ notificationId: randomUUID(), businessKey: 'foreign', status: 'accepted' }, { status: 'accepted' }]) {
      expect(
        await createOutreachNotificationClient({
          ...configured,
          fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ result: { data } }), { status: 200 })),
        }).send(input),
      ).toBeNull();
    }
    fetcher.mockResolvedValue(new Response('{}', { status: 307 }));
    expect(await createOutreachNotificationClient({ ...configured, fetcher }).send(input)).toBeNull();
    expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({ redirect: 'error', cache: 'no-store' });
    vi.useFakeTimers();
    try {
      const stuckFetch = createOutreachNotificationClient({ ...configured, fetcher: () => new Promise<Response>(() => undefined) }).send(
        input,
      );
      await vi.advanceTimersByTimeAsync(3000);
      expect(await stuckFetch).toBeNull();
      const stuckBody = createOutreachNotificationClient({
        ...configured,
        fetcher: vi.fn<typeof fetch>().mockResolvedValue({ ok: true, json: () => new Promise(() => undefined) } as Response),
      }).send(input);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await stuckBody).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
