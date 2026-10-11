import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ChannelRegistry, channelsFromEnv } from './registry.js';
import { InAppChannel, UnconfiguredChannel } from './gateway.js';
import { EmailChannel, PushChannel, SmsChannel, composeSms } from './adapters.js';
import type { OutboundMessage } from './channel.js';
import { MemoryDeliveryStore, MemoryTargetStore } from '../channel-store.js';
import { MemoryNotifyStore } from '../store.js';
import { NotificationDispatcher } from '../dispatch.js';
import { NotifyService } from '../notify-service.js';

/**
 * THE WIRE TESTS — against a real HTTP server, on a real socket.
 *
 * Every assertion here is made from the SERVER side. Nothing below stubs
 * `fetch`, and that is the whole point of the file.
 *
 * A test that injects a fake `fetch` proves that the adapter called the function
 * the test handed it. It cannot prove the method, the header casing, the JSON
 * that was actually serialised, that a redirect was not followed, or that a
 * timeout aborted the socket — because none of that ever reaches a transport.
 * This repository has already paid for that lesson once: an agent's test was
 * intercepting nothing at all, because viem's `.extend()` returns a NEW object
 * and the stub was installed on the old one. The suite was green and the code
 * was never exercised.
 *
 * So: a `node:http` server on an ephemeral port, and the recording is the
 * request the operating system delivered.
 */

const TOKEN = 'a-token-long-enough-to-pass';

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string | undefined>;
  readonly raw: string;
  readonly body: Record<string, unknown>;
}

interface Reply {
  readonly status: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  /** Never answer. Used to prove the client's own timeout aborts the socket. */
  readonly hang?: boolean;
}

/** A gateway the owner might run, reduced to: record the request, answer as told. */
class FakeGateway {
  readonly received: Recorded[] = [];
  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(reply: (callNumber: number, recorded: Recorded) => Reply): Promise<FakeGateway> {
    let self: FakeGateway;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: Record<string, unknown> = {};
        try {
          parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          parsed = {};
        }
        const recorded: Recorded = {
          method: req.method ?? '',
          path: req.url ?? '',
          headers: req.headers as Record<string, string | undefined>,
          raw,
          body: parsed,
        };
        self.received.push(recorded);

        const answer = reply(self.received.length, recorded);
        if (answer.hang) return; // socket held open; the client must give up on its own
        res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
        res.end(answer.body ?? '');
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    self = new FakeGateway(server, `http://127.0.0.1:${port}/send`);
    return self;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const running: FakeGateway[] = [];
async function gateway(reply: (n: number, r: Recorded) => Reply): Promise<FakeGateway> {
  const g = await FakeGateway.start(reply);
  running.push(g);
  return g;
}
const ok = (): Reply => ({ status: 202, body: JSON.stringify({ id: 'gw-1' }) });

/** The Error a deliver() rejected with. Fails the test if it resolved instead. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the delivery to be rejected, but it resolved');
}

afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
});

function message(over: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    notificationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: '11111111-1111-4111-8111-111111111111',
    channel: 'email',
    kind: 'bank.margin_call',
    severity: 'critical',
    titleKey: 'notify.bank.margin_call.title',
    bodyKey: 'notify.bank.margin_call.body',
    title: 'Margin call on your loan',
    body: 'Add 0.0415 BTC to restore your margin.',
    href: '/bank/loans/abc',
    locale: 'en',
    address: 'borrower@example.com',
    idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:email',
    ...over,
  };
}

describe('what actually goes out on the socket', () => {
  it('email: POST, bearer auth, idempotency key, and a mail-shaped body', async () => {
    const g = await gateway(ok);
    const receipt = await new EmailChannel({ url: g.url, token: TOKEN, timeoutMs: 2_000 }).deliver(message());

    expect(receipt.reference).toBe('gw-1');
    expect(g.received).toHaveLength(1);

    const req = g.received[0]!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/send');
    // Read off the wire, not off an object we handed ourselves.
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers['idempotency-key']).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:email');
    expect(req.headers['content-type']).toBe('application/json');

    // The contract a gateway author reads in the README, asserted as a whole set
    // so a field silently added or dropped fails here rather than at their end.
    expect(Object.keys(req.body).sort()).toEqual(
      ['bodyKey', 'channel', 'href', 'kind', 'locale', 'notificationId', 'severity', 'subject', 'text', 'titleKey', 'to'].sort(),
    );
    expect(req.body).toMatchObject({
      channel: 'email',
      to: 'borrower@example.com',
      subject: 'Margin call on your loan',
      text: 'Add 0.0415 BTC to restore your margin.',
    });
    // Copy is rendered before it leaves. A dotted key on the wire is a user
    // reading `notify.bank.margin_call.title` in their inbox.
    expect(req.body.subject).not.toMatch(/^notify\./);
  });

  it('push: title, body, and a data payload the app can route on', async () => {
    const g = await gateway(ok);
    const token = 'd'.repeat(64);
    await new PushChannel({ url: g.url, token: TOKEN, timeoutMs: 2_000 }).deliver(message({ channel: 'push', address: token }));

    const req = g.received[0]!;
    expect(req.body).toMatchObject({
      channel: 'push',
      to: token,
      title: 'Margin call on your loan',
      data: { href: '/bank/loans/abc', kind: 'bank.margin_call', notificationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    });
  });

  it('sms: one text field, composed and inside its budget', async () => {
    const g = await gateway(ok);
    await new SmsChannel({ url: g.url, token: TOKEN, timeoutMs: 2_000, maxChars: 480 }).deliver(
      message({ channel: 'sms', address: '+447700900000' }),
    );

    const req = g.received[0]!;
    expect(req.body).toMatchObject({ channel: 'sms', to: '+447700900000' });
    expect(req.body.text).toBe('Margin call on your loan: Add 0.0415 BTC to restore your margin. /bank/loans/abc');
    // No `title`/`body` pair on this channel — there is one field and it is `text`.
    expect(req.body).not.toHaveProperty('title');
  });

  it('sms: cuts the body, never the fact, and stays inside the billed budget', async () => {
    const g = await gateway(ok);
    const long = 'x'.repeat(1_000);
    await new SmsChannel({ url: g.url, token: TOKEN, timeoutMs: 2_000, maxChars: 120 }).deliver(
      message({ channel: 'sms', address: '+447700900000', body: long }),
    );

    const text = String(g.received[0]!.body.text);
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text.startsWith('Margin call on your loan: ')).toBe(true);
    expect(text).toContain('…');
    // The link survives the cut — a truncated SMS whose only job is to get the
    // user to the full message must still carry the way there.
    expect(text.endsWith('/bank/loans/abc')).toBe(true);
  });

  it('sends nothing at all when the address is not routable on this channel', async () => {
    const g = await gateway(ok);
    const sms = new SmsChannel({ url: g.url, token: TOKEN, timeoutMs: 2_000, maxChars: 480 });

    // A local-format number. A gateway handed this still sends it somewhere.
    await expect(sms.deliver(message({ channel: 'sms', address: '07700900000' }))).rejects.toMatchObject({
      name: 'ChannelRefusal',
      code: 'channel.target_unroutable',
    });
    await expect(
      new EmailChannel({ url: g.url, token: TOKEN, timeoutMs: 2_000 }).deliver(message({ address: 'borrower@localhost' })),
    ).rejects.toMatchObject({ code: 'channel.target_unroutable' });

    // The proof is the server's silence: not one request was made.
    expect(g.received).toHaveLength(0);
  });
});

describe('what the adapter does when the gateway misbehaves', () => {
  const cases: ReadonlyArray<{ status: number; retryable: boolean; why: string }> = [
    { status: 500, retryable: true, why: 'the gateway is broken and may not be in a minute' },
    { status: 503, retryable: true, why: 'unavailable is the definition of transient' },
    { status: 429, retryable: true, why: 'rate limited — back off, do not give up' },
    { status: 408, retryable: true, why: 'the gateway timed out reading us' },
    { status: 400, retryable: false, why: 'we sent something malformed; sending it again will not fix it' },
    { status: 401, retryable: false, why: 'the token is wrong for every message, so retrying triples a bad-credential rate' },
    { status: 403, retryable: false, why: 'as 401' },
    { status: 404, retryable: false, why: 'the configured URL is wrong' },
    { status: 422, retryable: false, why: 'the gateway rejected the address; a retry is a busy loop' },
  ];

  for (const { status, retryable, why } of cases) {
    it(`maps ${status} to retryable=${retryable} — ${why}`, async () => {
      const g = await gateway(() => ({ status, body: 'nope' }));
      await expect(new EmailChannel({ url: g.url, token: TOKEN, timeoutMs: 2_000 }).deliver(message())).rejects.toMatchObject({
        name: 'ChannelDeliveryError',
        retryable,
        status,
      });
      expect(g.received).toHaveLength(1);
    });
  }

  it('gives up on a gateway that never answers, and calls it retryable', async () => {
    const g = await gateway(() => ({ status: 200, hang: true }));
    const started = Date.now();

    await expect(new EmailChannel({ url: g.url, token: TOKEN, timeoutMs: 300 }).deliver(message())).rejects.toMatchObject({
      name: 'ChannelDeliveryError',
      retryable: true,
    });

    // It really aborted rather than waiting on the socket forever.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(g.received).toHaveLength(1);
  });

  it('refuses to follow a redirect, so the bearer token never reaches a host the owner did not configure', async () => {
    const elsewhere = await gateway(ok);
    const configured = await gateway(() => ({ status: 302, headers: { location: elsewhere.url } }));

    await expect(new EmailChannel({ url: configured.url, token: TOKEN, timeoutMs: 2_000 }).deliver(message())).rejects.toMatchObject({
      name: 'ChannelDeliveryError',
    });

    expect(configured.received).toHaveLength(1);
    // The assertion that matters: the second server saw nothing, so it never saw
    // the credential either.
    expect(elsewhere.received).toHaveLength(0);
  });

  it('does not copy the recipient into the delivery row when the gateway quotes it back', async () => {
    // The realistic shape of an aggregator's rejection: it names the number.
    const g = await gateway(() => ({
      status: 422,
      body: JSON.stringify({ code: 21211, message: "The 'To' number +447700900000 is not a valid phone number." }),
    }));

    const err = await failure(
      new SmsChannel({ url: g.url, token: TOKEN, timeoutMs: 2_000, maxChars: 480 }).deliver(
        message({ channel: 'sms', address: '+447700900000' }),
      ),
    );

    // `detail` on the delivery row is this message. The handset must not be in it.
    expect(err.message).not.toContain('+447700900000');
    expect(err.message).toContain('[address redacted]');
    // The diagnosis survives — an operator still learns what to fix.
    expect(err.message).toContain('422');
    expect(err.message).toContain('is not a valid phone number');
  });

  it('redacts an address the gateway percent-encoded before quoting it', async () => {
    const address = 'borrower+tag@example.com';
    const g = await gateway(() => ({ status: 400, body: `rejected: ${encodeURIComponent(address)}` }));

    const err = await failure(new EmailChannel({ url: g.url, token: TOKEN, timeoutMs: 2_000 }).deliver(message({ address })));

    expect(err.message).not.toContain('example.com');
    expect(err.message).toContain('[address redacted]');
  });

  it('redacts a mailbox echo and a percent-encoded address when only the case differs', async () => {
    // `encodeURIComponent` emits `%2B`. Percent-encoding hex is case-insensitive,
    // so a gateway that writes `%2b` for the same plus still names the recipient.
    // A mailbox quoted in another case is the same box. `detail` is this message,
    // and it is the copy that remains after `channel_targets` is removed.
    const address = 'Borrower+Tag@Example.COM';
    const encoded = encodeURIComponent(address);
    const lowerHex = encoded.replace(/%[0-9A-F]{2}/g, (token) => token.toLowerCase());
    const lowerEncoded = encodeURIComponent(address.toLowerCase()).replace(/%[0-9A-F]{2}/g, (token) => token.toLowerCase());
    expect(lowerHex).not.toBe(encoded);
    expect(lowerHex).toContain('%2b');
    expect(address.toLowerCase()).not.toBe(address);

    const g = await gateway(() => ({
      status: 400,
      body: `rejected ${address.toLowerCase()} via ${lowerHex} and ${lowerEncoded}`,
    }));
    const err = await failure(new EmailChannel({ url: g.url, token: TOKEN, timeoutMs: 2_000 }).deliver(message({ address })));
    const detail = err.message;

    expect(detail.toLowerCase()).not.toContain(address.toLowerCase());
    expect(detail.toLowerCase()).not.toContain('%2b');
    expect(detail.toLowerCase()).not.toContain('example.com');
    expect(detail).toContain('[address redacted]');
    expect(detail).toContain('400');
    expect(detail).toContain('rejected');

    // A handset plus is the same hex miss, and it is not a mailbox.
    const handset = '+447700900000';
    const handsetHex = encodeURIComponent(handset).replace(/%[0-9A-F]{2}/g, (token) => token.toLowerCase());
    expect(handsetHex).toBe('%2b447700900000');
    const sms = await gateway(() => ({ status: 422, body: `The To number ${handsetHex} is not valid` }));
    const smsErr = await failure(
      new SmsChannel({ url: sms.url, token: TOKEN, timeoutMs: 2_000, maxChars: 480 }).deliver(
        message({ channel: 'sms', address: handset }),
      ),
    );
    expect(smsErr.message).not.toContain(handset);
    expect(smsErr.message).not.toContain('447700900000');
    expect(smsErr.message.toLowerCase()).not.toContain('%2b');
    expect(smsErr.message).toContain('[address redacted]');
    expect(smsErr.message).toContain('is not valid');
  });

  it('treats a 2xx with no body as acceptance, with an honest null reference', async () => {
    const g = await gateway(() => ({ status: 204 }));
    const receipt = await new EmailChannel({ url: g.url, token: TOKEN, timeoutMs: 2_000 }).deliver(message());
    expect(receipt.reference).toBeNull();
  });
});

describe('a channel with no credentials, against the same suite', () => {
  it('refuses and makes no request — there is no URL for it to have called', async () => {
    const reg = channelsFromEnv({ NOTIFY_GATEWAY_TIMEOUT_MS: 1_000 });
    await expect(reg.get('email').deliver(message())).rejects.toMatchObject({
      name: 'ChannelRefusal',
      code: 'channel.not_configured',
    });
  });

  it('is fatal, not merely refused, once the operator says the channel is required', () => {
    // The env layer catches this first with a better message. This is the second
    // guard: a registry built by hand cannot be built in the broken state either.
    expect(
      () =>
        new ChannelRegistry(
          [
            new InAppChannel(),
            new UnconfiguredChannel('email', ['NOTIFY_EMAIL_GATEWAY_URL', 'NOTIFY_EMAIL_GATEWAY_TOKEN']),
            new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
            new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
          ],
          ['email'],
        ),
    ).toThrow(/NOTIFY_REQUIRED_CHANNELS/);
  });

  it('constructs normally once the credentials are there', async () => {
    const g = await gateway(ok);
    const reg = channelsFromEnv({
      NOTIFY_GATEWAY_TIMEOUT_MS: 1_000,
      NOTIFY_EMAIL_GATEWAY_URL: g.url,
      NOTIFY_EMAIL_GATEWAY_TOKEN: TOKEN,
      NOTIFY_REQUIRED_CHANNELS: 'email',
    });
    expect(reg.availableChannels()).toEqual(['inapp']);
    expect(reg.status().find((s) => s.channel === 'email')).toMatchObject({
      configured: true,
      available: false,
      reason: 'channel.unprobed',
      required: true,
    });
    expect(reg.status().find((s) => s.channel === 'sms')).toMatchObject({
      configured: false,
      available: false,
      required: false,
    });
  });
});

/**
 * THE BOUND, MEASURED AT THE SERVER.
 *
 * "Bounded retries" is a claim about how many times somebody else's server is
 * hit. So it is counted there, not asserted against our own attempt counter —
 * which is the number that would still look right if the adapter retried
 * internally on top of the dispatcher's budget.
 */
describe('retries are bounded and idempotent, counted by the gateway itself', () => {
  const USER = '11111111-1111-4111-8111-111111111111';

  async function wired(url: string, maxAttempts: number) {
    const store = new MemoryNotifyStore();
    const targets = new MemoryTargetStore();
    const deliveries = new MemoryDeliveryStore();
    const channels = channelsFromEnv({
      NOTIFY_GATEWAY_TIMEOUT_MS: 2_000,
      NOTIFY_EMAIL_GATEWAY_URL: url,
      NOTIFY_EMAIL_GATEWAY_TOKEN: TOKEN,
    });
    const dispatcher = new NotificationDispatcher(channels, targets, deliveries, { maxAttempts, outOfAppEnabled: true });
    const notify = new NotifyService(store, { fanoutEnabled: true, verifyTtlMinutes: 15 }, { targets, deliveries, channels, dispatcher });

    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'borrower@example.com',
      locale: 'en',
      verifyTokenHash: 'x'.repeat(64),
      verifyExpiresAt: new Date(Date.now() + 60_000),
    });
    await targets.markVerified(USER, 'email', 'x'.repeat(64), new Date());

    return { notify, deliveries };
  }

  const marginCall = {
    userId: USER,
    kind: 'bank.margin_call',
    titleKey: 'notify.bank.margin_call.title',
    bodyKey: 'notify.bank.margin_call.body',
    severity: 'critical' as const,
    sourceSubject: 'intafaced.bank.margin_call.created',
    sourceIdempotencyKey: 'loan-1:1',
  };

  it('stops at NOTIFY_MAX_DELIVERY_ATTEMPTS however often the bus redelivers', async () => {
    const g = await gateway(() => ({ status: 503, body: 'down' }));
    const { notify, deliveries } = await wired(g.url, 3);

    // Ten redeliveries of the same event. An unbounded retry is an outage we
    // cause at somebody else's expense.
    for (let i = 0; i < 10; i++) await notify.create(marginCall);

    expect(g.received).toHaveLength(3);

    const rows = await deliveries.listForNotification((await notify.list({ userId: USER, limit: 1, unreadOnly: false })).items[0]!.id);
    const email = rows.find((r) => r.channel === 'email')!;
    expect(email.status).toBe('abandoned');
    expect(email.refusalCode).toBe('channel.attempts_exhausted');
    expect(email.attemptedAt).not.toBeNull();
    // Nothing was ever accepted, so nothing may say it was.
    expect(email.acceptedAt).toBeNull();
  });

  it('sends exactly once for a redelivered event the gateway already took', async () => {
    const g = await gateway(ok);
    const { notify, deliveries } = await wired(g.url, 3);

    for (let i = 0; i < 5; i++) await notify.create(marginCall);

    expect(g.received).toHaveLength(1);
    // The same idempotency key every time, so a gateway that honours it would
    // have deduped too — belt and braces, not one or the other.
    expect(new Set(g.received.map((r) => r.headers['idempotency-key'])).size).toBe(1);

    const rows = await deliveries.listForNotification((await notify.list({ userId: USER, limit: 1, unreadOnly: false })).items[0]!.id);
    expect(rows.find((r) => r.channel === 'email')).toMatchObject({ status: 'accepted', attempts: 1 });
  });

  it('recovers a send the gateway refused once and took on the retry', async () => {
    const g = await gateway((n) => (n === 1 ? { status: 503, body: 'down' } : ok()));
    const { notify, deliveries } = await wired(g.url, 3);

    const first = await notify.create(marginCall);
    expect(first.dispatch!.retry).toBe(true);

    const second = await notify.create(marginCall);
    expect(second.dispatch!.retry).toBe(false);

    expect(g.received).toHaveLength(2);
    const rows = await deliveries.listForNotification(first.notification!.id);
    const email = rows.find((r) => r.channel === 'email')!;
    expect(email.status).toBe('accepted');
    expect(email.acceptedAt).not.toBeNull();
    expect(email.reference).toBe('gw-1');
  });

  it('does not spend the budget on a gateway that will never accept this address', async () => {
    const g = await gateway(() => ({ status: 422, body: 'bad address' }));
    const { notify } = await wired(g.url, 3);

    for (let i = 0; i < 5; i++) await notify.create(marginCall);

    // One call, not three: a permanent rejection is terminal on the first answer.
    expect(g.received).toHaveLength(1);
  });
});

describe('composeSms', () => {
  it('keeps a short message whole', () => {
    expect(composeSms({ title: 'Filled', body: 'buy 1 at 2', href: null }, 480)).toBe('Filled: buy 1 at 2');
  });

  it('cuts the title too when the title alone will not fit, rather than sending an empty text', () => {
    const text = composeSms({ title: 'A'.repeat(200), body: 'body', href: '/x' }, 64);
    expect(text.length).toBeLessThanOrEqual(64);
    expect(text.length).toBeGreaterThan(0);
  });
});
