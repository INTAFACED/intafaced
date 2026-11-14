import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addressAllowed,
  AlertWebhookError,
  causeOfStatus,
  checkWebhookUrl,
  httpPostWebhook,
  MemoryAlertWebhookStore,
  parseNumberList,
  runWebhookTick,
  webhookTestLoopback,
  type AlertWebhookPolicy,
  type PostWebhook,
  type Resolve,
  type WebhookCause,
} from './webhook.js';

/**
 * J-charts-desk-10 #3 #4 and C-alerts-scan-04: a webhook URL is https, on an owner-allowed port, to a public address, checked at save
 * and at send; a firing posts once; a failure is resent on the owner's schedule and every attempt is kept.
 */

const POLICY: AlertWebhookPolicy = { ports: [443], retrySeconds: [5, 5, 5], testLoopback: false, timeoutMs: 2_000 };
const publicHost: Resolve = async () => [{ address: '93.184.216.34', family: 4 }];
const resolvesTo =
  (...addresses: string[]): Resolve =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AlertWebhookError) return err.code;
    throw err;
  }
  return 'saved';
}

describe('checkWebhookUrl: at save', () => {
  it('stores an https URL on an allowed port that resolves to a public address', async () => {
    await expect(checkWebhookUrl('https://hooks.example.com/alerts', POLICY, publicHost)).resolves.toBe('https://hooks.example.com/alerts');
  });

  it('blank is no webhook', async () => {
    await expect(checkWebhookUrl('  ', POLICY, publicHost)).resolves.toBeNull();
    await expect(checkWebhookUrl(undefined, POLICY, publicHost)).resolves.toBeNull();
  });

  it('refuses every save while the owner has not set the ports', async () => {
    expect(await refusal(checkWebhookUrl('https://hooks.example.com/', { ...POLICY, ports: null }, publicHost))).toBe(
      'notify.alert_webhook_ports_unset',
    );
  });

  it('refuses http, a port the owner did not allow, credentials in the URL and a non-URL', async () => {
    expect(await refusal(checkWebhookUrl('http://hooks.example.com/', POLICY, publicHost))).toBe('alert.webhook_not_https');
    expect(await refusal(checkWebhookUrl('https://hooks.example.com:8443/', POLICY, publicHost))).toBe('alert.webhook_port_not_allowed');
    expect(await refusal(checkWebhookUrl('https://me:secret@hooks.example.com/', POLICY, publicHost))).toBe('alert.webhook_invalid_url');
    expect(await refusal(checkWebhookUrl('not a url', POLICY, publicHost))).toBe('alert.webhook_invalid_url');
  });

  it('refuses a name that resolves to a private range, even when it also resolves to a public one', async () => {
    for (const address of [
      '10.1.2.3',
      '192.168.1.1',
      '172.20.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
    ]) {
      expect(await refusal(checkWebhookUrl('https://hooks.example.com/', POLICY, resolvesTo(address))), address).toBe(
        'alert.webhook_private_address',
      );
    }
    expect(await refusal(checkWebhookUrl('https://hooks.example.com/', POLICY, resolvesTo('93.184.216.34', '10.0.0.1')))).toBe(
      'alert.webhook_private_address',
    );
  });

  it('refuses a private IP literal, IPv4 carried in IPv6 included, without asking the resolver', async () => {
    const never: Resolve = async () => {
      throw new Error('a literal is not resolved');
    };
    expect(await refusal(checkWebhookUrl('https://10.0.0.5/', POLICY, never))).toBe('alert.webhook_private_address');
    expect(await refusal(checkWebhookUrl('https://[::ffff:127.0.0.1]/', POLICY, never))).toBe('alert.webhook_private_address');
    expect(await refusal(checkWebhookUrl('https://[::ffff:a00:1]/', POLICY, never))).toBe('alert.webhook_private_address');
  });

  it('refuses a name that does not resolve', async () => {
    const nothing: Resolve = async () => {
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    expect(await refusal(checkWebhookUrl('https://nowhere.example.com/', POLICY, nothing))).toBe('alert.webhook_unresolvable');
  });

  it('the TEST loopback switch lets a loopback endpoint through, over http too, and nothing else', async () => {
    const test = { ...POLICY, ports: [443, 14590], testLoopback: true };
    await expect(checkWebhookUrl('http://127.0.0.1:14590/hook', test, publicHost)).resolves.toBe('http://127.0.0.1:14590/hook');
    expect(await refusal(checkWebhookUrl('http://hooks.example.com:14590/', test, publicHost))).toBe('alert.webhook_not_https');
    expect(await refusal(checkWebhookUrl('https://10.0.0.5:14590/', test, publicHost))).toBe('alert.webhook_private_address');
  });

  it('the TEST loopback switch stops the boot outside dev and test', () => {
    expect(webhookTestLoopback('on', 'test')).toBe(true);
    expect(webhookTestLoopback('on', 'dev')).toBe(true);
    expect(webhookTestLoopback(undefined, 'prod')).toBe(false);
    expect(() => webhookTestLoopback('on', 'prod')).toThrow(/APP_ENV/);
    expect(() => webhookTestLoopback('on', 'staging')).toThrow(/APP_ENV/);
  });

  it('owner lists: blank is null, a bad entry stops the boot', () => {
    expect(parseNumberList('', 'X', 1, 10)).toBeNull();
    expect(parseNumberList(undefined, 'X', 1, 10)).toBeNull();
    expect(parseNumberList('5, 5,5', 'X', 1, 10)).toEqual([5, 5, 5]);
    expect(() => parseNumberList('5,x', 'X', 1, 10)).toThrow(/X/);
    expect(() => parseNumberList('0', 'X', 1, 10)).toThrow(/X/);
  });
});

describe('addressAllowed', () => {
  it('allows a public address and refuses the reserved ranges', () => {
    expect(addressAllowed('93.184.216.34', false)).toBe(true);
    expect(addressAllowed('2606:4700::1111', false)).toBe(true);
    for (const a of [
      '0.0.0.0',
      '127.0.0.1',
      '10.0.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fc00::1',
      'ff02::1',
      '2001:db8::1',
    ]) {
      expect(addressAllowed(a, false), a).toBe(false);
    }
  });
});

describe('causeOfStatus', () => {
  it('names each class of answer, and only a 5xx other than 504 is resent', () => {
    const cases: [number, WebhookCause][] = [
      [200, 'ok'],
      [204, 'ok'],
      [301, 'redirect'],
      [400, 'refused'],
      [401, 'refused'],
      [404, 'refused'],
      [500, 'unavailable'],
      [503, 'unavailable'],
      [504, 'gateway_timeout'],
    ];
    for (const [status, cause] of cases) expect(causeOfStatus(status), String(status)).toBe(cause);
  });
});

describe('runWebhookTick: one post, the schedule, every attempt kept', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 14, 4, 0, s));

  function poster(
    answers: { status: number | null; cause: WebhookCause }[],
  ): PostWebhook & { calls: { url: string; body: string; key: string }[] } {
    const calls: { url: string; body: string; key: string }[] = [];
    const fn = (async (url: string, body: string, key: string) => {
      calls.push({ url, body, key });
      return answers[Math.min(calls.length - 1, answers.length - 1)]!;
    }) as PostWebhook & { calls: typeof calls };
    fn.calls = calls;
    return fn;
  }

  it('a 2xx is delivered with one attempt; a replayed firing posts nothing new', async () => {
    const store = new MemoryAlertWebhookStore();
    const firing = {
      alertId: 'a1',
      seq: 1,
      userId: 'u1',
      url: 'https://hooks.example.com/',
      body: { alertId: 'a1', markPrice: '100' },
      at: at(0),
    };
    await store.enqueue(firing);
    await store.enqueue({ ...firing, body: { changed: true } });
    const post = poster([{ status: 200, cause: 'ok' }]);
    let now = at(0);
    await runWebhookTick(store, post, POLICY, () => now);
    now = at(30);
    await runWebhookTick(store, post, POLICY, () => now);
    expect(post.calls).toHaveLength(1);
    expect(JSON.parse(post.calls[0]!.body)).toEqual({ alertId: 'a1', markPrice: '100' });
    expect(post.calls[0]!.key).toBe('alert:a1:1');
    const [row] = await store.listFor('u1', [{ alertId: 'a1', seq: 1 }]);
    expect(row).toMatchObject({ status: 'delivered', nextAttemptAt: null });
    expect(row!.attempts).toEqual([expect.objectContaining({ n: 1, status: 200, cause: 'ok' })]);
  });

  it('a 503 is resent after each delay of the schedule, then gives up with four attempts on the record', async () => {
    const store = new MemoryAlertWebhookStore();
    await store.enqueue({ alertId: 'a2', seq: 1, userId: 'u1', url: 'https://hooks.example.com/', body: {}, at: at(0) });
    const post = poster([{ status: 503, cause: 'unavailable' }]);
    let now = at(0);
    const clock = () => now;
    await runWebhookTick(store, post, POLICY, clock); // attempt 1
    now = at(4);
    await runWebhookTick(store, post, POLICY, clock); // not due yet
    expect(post.calls).toHaveLength(1);
    for (const s of [5, 10, 15, 20, 25]) {
      now = at(s);
      await runWebhookTick(store, post, POLICY, clock);
    }
    expect(post.calls).toHaveLength(4);
    const [row] = await store.listFor('u1', [{ alertId: 'a2', seq: 1 }]);
    expect(row!.status).toBe('failed');
    expect(row!.attempts.map((a) => [a.n, a.status, a.cause])).toEqual([
      [1, 503, 'unavailable'],
      [2, 503, 'unavailable'],
      [3, 503, 'unavailable'],
      [4, 503, 'unavailable'],
    ]);
  });

  it('a 504, a 4xx and a timeout are not resent; a blank schedule resends nothing', async () => {
    for (const answer of [
      { status: 504, cause: 'gateway_timeout' as const },
      { status: 404, cause: 'refused' as const },
      { status: null, cause: 'timeout' as const },
    ]) {
      const store = new MemoryAlertWebhookStore();
      await store.enqueue({ alertId: 'a3', seq: 1, userId: 'u1', url: 'https://hooks.example.com/', body: {}, at: at(0) });
      const post = poster([answer]);
      for (const s of [0, 10, 20]) await runWebhookTick(store, post, POLICY, () => at(s));
      expect(post.calls, answer.cause).toHaveLength(1);
      expect((await store.listFor('u1', [{ alertId: 'a3', seq: 1 }]))[0]!.status).toBe('failed');
    }
    const store = new MemoryAlertWebhookStore();
    await store.enqueue({ alertId: 'a4', seq: 1, userId: 'u1', url: 'https://hooks.example.com/', body: {}, at: at(0) });
    const post = poster([{ status: 503, cause: 'unavailable' }]);
    for (const s of [0, 10, 20]) await runWebhookTick(store, post, { ...POLICY, retrySeconds: null }, () => at(s));
    expect(post.calls).toHaveLength(1);
  });

  it("another person's firing is not listed", async () => {
    const store = new MemoryAlertWebhookStore();
    await store.enqueue({ alertId: 'a5', seq: 1, userId: 'u1', url: 'https://hooks.example.com/', body: {}, at: at(0) });
    expect(await store.listFor('u2', [{ alertId: 'a5', seq: 1 }])).toEqual([]);
  });
});

describe('httpPostWebhook: the real request', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  async function listen(status: number): Promise<{ port: number; seen: { headers: Record<string, unknown>; body: string }[] }> {
    const seen: { headers: Record<string, unknown>; body: string }[] = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ headers: req.headers, body });
        res.writeHead(status, status >= 300 && status < 400 ? { location: 'http://10.0.0.1/' } : {});
        res.end('answer body is never stored');
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    return { port: (server!.address() as AddressInfo).port, seen };
  }

  it('posts the body once with its idempotency key, and reads only the status', async () => {
    const { port, seen } = await listen(200);
    const post = httpPostWebhook({ ...POLICY, ports: [port], testLoopback: true });
    const out = await post(`http://127.0.0.1:${port}/hook`, '{"alertId":"a1"}', 'alert:a1:1');
    expect(out).toEqual({ status: 200, cause: 'ok' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toBe('{"alertId":"a1"}');
    expect(seen[0]!.headers['idempotency-key']).toBe('alert:a1:1');
    expect(seen[0]!.headers['content-type']).toBe('application/json');
  });

  it('does not follow a redirect', async () => {
    const { port, seen } = await listen(302);
    const out = await httpPostWebhook({ ...POLICY, ports: [port], testLoopback: true })(`http://127.0.0.1:${port}/`, '{}', 'k');
    expect(out).toEqual({ status: 302, cause: 'redirect' });
    expect(seen).toHaveLength(1);
  });

  it('refuses at send a URL whose address is no longer allowed: nothing reaches it', async () => {
    const { port, seen } = await listen(200);
    const out = await httpPostWebhook({ ...POLICY, ports: [port], testLoopback: false })(`http://127.0.0.1:${port}/`, '{}', 'k');
    expect(out).toEqual({ status: null, cause: 'private_address' });
    expect(seen).toHaveLength(0);
  });

  it('a name that resolves to a private address at send (rebinding) is refused, though it was public at save', async () => {
    const { port, seen } = await listen(200);
    let answers = 0;
    const rebinding: Resolve = async () =>
      answers++ === 0 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }];
    const policy = { ...POLICY, ports: [port] };
    await expect(checkWebhookUrl(`https://rebind.example.com:${port}/`, policy, rebinding)).resolves.toBeTruthy();
    const out = await httpPostWebhook(policy, rebinding)(`https://rebind.example.com:${port}/`, '{}', 'k');
    expect(out.cause).toBe('private_address');
    expect(seen).toHaveLength(0);
  });

  it('a closed port is unreachable, and so resent', async () => {
    const { port } = await listen(200);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    const out = await httpPostWebhook({ ...POLICY, ports: [port], testLoopback: true })(`http://127.0.0.1:${port}/`, '{}', 'k');
    expect(out).toEqual({ status: null, cause: 'unreachable' });
  });
});
