import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { parseAmount } from '@intafaced/ledger-client';
import { afterEach, describe, expect, it } from 'vitest';
import { verifySignature } from './rails/webhook-signature.js';
import {
  MemoryMerchantWebhookStore,
  MerchantWebhookService,
  WEBHOOK_CLAIM_LEASE_MS,
  buildSignedHeaders,
  eventIdFor,
  paymentStateBody,
} from './merchant-webhooks.js';
import { PayError, type PaymentView } from './payment-service.js';
import type { PinnedPostRequest, WebhookTransport } from './webhook-pinned-post.js';
import type { WebhookResolver } from './webhook-url-guard.js';

const MERCHANT = '33333333-3333-4333-8333-333333333333';

function payment(over: Partial<PaymentView> = {}): PaymentView {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    merchantId: MERCHANT,
    profileId: null,
    amount: parseAmount('1.10'),
    assetId: 'USD',
    method: 'card',
    railAdapter: 'card-sandbox',
    railRef: 'ref-1',
    status: 'captured',
    capturedAmount: parseAmount('1.10'),
    refundedAmount: parseAmount('0'),
    createdAt: new Date('2026-08-07T10:00:00.000Z'),
    ...over,
  } as PaymentView;
}

type Captured = { headers: Record<string, string>; body: string; count: number };

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse, cap: Captured) => void,
): Promise<{ url: string; server: Server; cap: Captured }> {
  const cap: Captured = { headers: {}, body: '', count: 0 };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      cap.body = Buffer.concat(chunks).toString('utf8');
      cap.count += 1;
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') cap.headers[k.toLowerCase()] = v;
      }
      handler(req, res, cap);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return { url: `http://127.0.0.1:${addr.port}/hook`, server, cap };
}

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
  server = undefined;
});

describe('merchant webhook signing (ADR §2.4)', () => {
  it('signs raw body + timestamp the same way inbound rails verify', () => {
    const body = JSON.stringify({ id: 'evt', type: 'payment.captured' });
    const ts = '1723000000';
    const headers = buildSignedHeaders('secret-at-least-32-chars-xxxxxxxxxxxx', ts, body);
    expect(
      verifySignature({
        body,
        signature: headers['x-intafaced-signature'],
        timestamp: headers['x-intafaced-timestamp'],
        secret: 'secret-at-least-32-chars-xxxxxxxxxxxx',
        toleranceSeconds: 300,
        now: new Date(Number(ts) * 1000),
      }),
    ).toBe(true);
  });

  it('event ids are stable per logical payment state (merchant dedupe key)', () => {
    const p = payment();
    expect(eventIdFor('payment.captured', p)).toBe(`payment.captured:${p.id}`);
    expect(eventIdFor('payment.refunded', { ...p, refundedAmount: parseAmount('0.5') })).toBe(`payment.refunded:${p.id}:0.5`);
  });

  it('payment state body uses decimal strings, never numbers', () => {
    const body = paymentStateBody(payment());
    expect(body.amount).toBe('1.1');
    expect(typeof body.amount).toBe('string');
    expect(typeof body.capturedAmount).toBe('string');
    expect(body.mode).toBe('sandbox');
  });

  it('REFUSES a missing rail on the webhook body rather than omitting mode (looks live)', () => {
    try {
      paymentStateBody(payment({ railAdapter: '' }));
      expect.unreachable('should have refused');
    } catch (err) {
      expect(err).toMatchObject({ code: 'pay.rail_mode_undisclosed' });
    }
  });
});

describe('MerchantWebhookService', () => {
  it('REFUSES non-https remote URLs', async () => {
    const svc = new MerchantWebhookService(new MemoryMerchantWebhookStore());
    await expect(svc.registerEndpoint(MERCHANT, 'http://example.com/hook')).rejects.toMatchObject({
      code: 'pay.webhook_url_invalid',
    });
  });

  it('REFUSES listEndpoints when limit is omitted — never invents 50', async () => {
    const svc = new MerchantWebhookService(new MemoryMerchantWebhookStore());
    await expect(svc.listEndpoints(MERCHANT)).rejects.toMatchObject({
      code: 'pay.webhook_endpoint_list_limit_unset',
    });
    await expect(svc.listEndpoints(MERCHANT, 50)).resolves.toEqual([]);
  });

  it('enqueues once per endpoint and dedupes on event id', async () => {
    const store = new MemoryMerchantWebhookStore();
    const svc = new MerchantWebhookService(store, { allowLocalHttp: true });
    const { url, server: s } = await listen((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    server = s;

    await svc.registerEndpoint(MERCHANT, url);
    await svc.registerEndpoint(MERCHANT, url.replace('/hook', '/hook2'));

    const n1 = await svc.enqueue({ type: 'payment.captured', payment: payment() });
    const n2 = await svc.enqueue({ type: 'payment.captured', payment: payment() });
    expect(n1).toBe(2);
    expect(n2).toBe(0);
  });

  it('delivers with verifiable signature and marks delivered', async () => {
    const store = new MemoryMerchantWebhookStore();
    let seenSecret = '';
    const {
      url,
      server: s,
      cap,
    } = await listen((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    server = s;

    const svc = new MerchantWebhookService(store, { allowLocalHttp: true, disableAfterFailures: 3, maxAttempts: 3 });
    const created = await svc.registerEndpoint(MERCHANT, url);
    seenSecret = created.secret;
    expect(seenSecret.length).toBe(64);

    await svc.enqueue({ type: 'payment.captured', payment: payment() });
    const result = await svc.processDue(25);
    expect(result.delivered).toBe(1);
    expect(cap.count).toBe(1);

    expect(
      verifySignature({
        body: cap.body,
        signature: cap.headers['x-intafaced-signature'],
        timestamp: cap.headers['x-intafaced-timestamp'],
        secret: seenSecret,
        toleranceSeconds: 300,
        now: new Date(Number(cap.headers['x-intafaced-timestamp']) * 1000),
      }),
    ).toBe(true);

    const payload = JSON.parse(cap.body) as { type: string; data: { payment: { amount: string } } };
    expect(payload.type).toBe('payment.captured');
    expect(payload.data.payment.amount).toBe('1.1');
  });

  it('retries on 5xx, then disables the endpoint after consecutive failures', async () => {
    const store = new MemoryMerchantWebhookStore();
    const { url, server: s } = await listen((_req, res) => {
      res.writeHead(500);
      res.end('nope');
    });
    server = s;

    const svc = new MerchantWebhookService(store, { allowLocalHttp: true, disableAfterFailures: 2, maxAttempts: 8 });
    await svc.registerEndpoint(MERCHANT, url);
    await svc.enqueue({ type: 'payment.authorized', payment: payment({ status: 'authorized' }) });

    const r1 = await svc.processDue(25);
    expect(r1.failed).toBe(1);
    expect(r1.disabled).toBe(0);

    // Make due again immediately.
    for (const d of store.deliveries.values()) {
      d.nextAttemptAt = new Date(0);
    }
    const r2 = await svc.processDue(25);
    expect(r2.failed).toBe(1);
    expect(r2.disabled).toBe(1);

    const eps = await svc.listEndpoints(MERCHANT, 50);
    expect(eps[0]?.status).toBe('disabled');
    expect(eps[0]?.disabledReason).toBe('consecutive_failures');

    const dashboard = await svc.listDeliveries(MERCHANT, { status: 'failed', limit: 50 });
    expect(dashboard.length).toBe(1);
    expect(dashboard[0]?.lastStatusCode).toBe(500);
  });

  it('surfaces dead deliveries on the failure dashboard', async () => {
    const store = new MemoryMerchantWebhookStore();
    const { url, server: s } = await listen((_req, res) => {
      res.writeHead(503);
      res.end('down');
    });
    server = s;

    const svc = new MerchantWebhookService(store, { allowLocalHttp: true, disableAfterFailures: 99, maxAttempts: 2 });
    await svc.registerEndpoint(MERCHANT, url);
    await svc.enqueue({ type: 'payment.failed', payment: payment({ status: 'failed' }) });

    await svc.processDue(25);
    for (const d of store.deliveries.values()) d.nextAttemptAt = new Date(0);
    await svc.processDue(25);

    const dead = await svc.listDeliveries(MERCHANT, { status: 'dead', limit: 50 });
    expect(dead).toHaveLength(1);
    expect(dead[0]?.attempts).toBe(2);
  });

  it('claimDue leases due rows so a second claim cannot double-POST', async () => {
    const store = new MemoryMerchantWebhookStore();
    const svc = new MerchantWebhookService(store);
    await svc.registerEndpoint(MERCHANT, 'https://merchant.example/hooks');
    await svc.enqueue({ type: 'payment.captured', payment: payment() });
    // enqueue stamps nextAttemptAt via wall clock; pin it so claimDue's
    // frozen `now` is never behind that stamp (same pattern as processDue tests).
    for (const d of store.deliveries.values()) d.nextAttemptAt = new Date(0);

    // Enqueue stamps nextAttemptAt = wall clock. A fixed "now" that falls before
    // that stamp (e.g. tip-day noon UTC while CI runs after noon) makes claimDue
    // return [] — pin due, then claim at an explicit instant.
    const now = new Date('2026-08-12T12:00:00.000Z');
    for (const d of store.deliveries.values()) d.nextAttemptAt = new Date(0);
    const first = await store.claimDue(25, now);
    expect(first).toHaveLength(1);
    expect(first[0]!.nextAttemptAt.getTime()).toBe(now.getTime() + WEBHOOK_CLAIM_LEASE_MS);

    const second = await store.claimDue(25, now);
    expect(second).toHaveLength(0);
  });

  it('enableEndpoint restores active status after consecutive-failure disable', async () => {
    const store = new MemoryMerchantWebhookStore();
    const { url, server: s } = await listen((_req, res) => {
      res.writeHead(500);
      res.end('nope');
    });
    server = s;

    const svc = new MerchantWebhookService(store, { allowLocalHttp: true, disableAfterFailures: 1, maxAttempts: 8 });
    const created = await svc.registerEndpoint(MERCHANT, url);
    await svc.enqueue({ type: 'payment.authorized', payment: payment({ status: 'authorized' }) });
    await svc.processDue(25);

    const disabled = await svc.listEndpoints(MERCHANT, 50);
    expect(disabled[0]?.status).toBe('disabled');

    const enabled = await svc.enableEndpoint(MERCHANT, created.id);
    expect(enabled.status).toBe('active');
    expect(enabled.consecutiveFailures).toBe(0);
    expect(enabled.disabledReason).toBeNull();
  });

  it('processDue with a blank signing secret refuses by name and does not POST', async () => {
    const store = new MemoryMerchantWebhookStore();
    let posts = 0;
    const { url, server: s } = await listen((_req, res) => {
      posts += 1;
      res.writeHead(200);
      res.end('ok');
    });
    server = s;

    const svc = new MerchantWebhookService(store, { allowLocalHttp: true, disableAfterFailures: 8, maxAttempts: 8 });
    const created = await svc.registerEndpoint(MERCHANT, url);
    const ep = store.endpoints.get(created.id);
    expect(ep).toBeTruthy();
    ep!.secret = '';

    await svc.enqueue({ type: 'payment.captured', payment: payment() });
    for (const d of store.deliveries.values()) d.nextAttemptAt = new Date(0);

    const result = await svc.processDue(25);
    expect(posts).toBe(0);
    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(1);
    const [delivery] = [...store.deliveries.values()];
    expect(delivery?.lastError).toBe('pay.webhook_not_configured');
  });

  it('processDue refuses unset batch — never invent 25; owner may pass 25', async () => {
    const store = new MemoryMerchantWebhookStore();
    const svc = new MerchantWebhookService(store, { allowLocalHttp: true });
    await expect(svc.processDue()).rejects.toMatchObject({
      code: 'pay.due_webhook_deliveries_batch_limit_unset',
    });
    await expect(svc.processDue(Number.NaN)).rejects.toBeInstanceOf(PayError);
    await expect(svc.processDue(0)).rejects.toMatchObject({ code: 'pay.validation_failed' });
    await expect(svc.processDue(501)).rejects.toMatchObject({ code: 'pay.validation_failed' });
    await expect(svc.processDue(25)).resolves.toEqual({ delivered: 0, failed: 0, disabled: 0 });
  });
});

describe('MerchantWebhookService — SSRF guard', () => {
  const PUBLIC_ADDR = '93.184.216.34';
  const publicResolver: WebhookResolver = async () => [{ address: PUBLIC_ADDR, family: 4 }];

  /** Transport stub: records every connect and answers with `status`. No sockets. */
  function stubTransport(status = 200) {
    const calls: PinnedPostRequest[] = [];
    const transport: WebhookTransport = async (req) => {
      calls.push(req);
      return { status };
    };
    return { calls, transport };
  }

  async function seed(svc: MerchantWebhookService, store: MemoryMerchantWebhookStore, url: string) {
    // Written straight to the store: this is an endpoint that predates the guard.
    const id = '55555555-5555-4555-8555-555555555555';
    await store.insertEndpoint({ id, merchantId: MERCHANT, url, secretHash: 'h', secretEncrypted: 'x'.repeat(64) });
    await svc.enqueue({ type: 'payment.captured', payment: payment() });
    for (const d of store.deliveries.values()) d.nextAttemptAt = new Date(0);
    return id;
  }

  it('registerEndpoint REFUSES private targets in production posture (default)', async () => {
    const svc = new MerchantWebhookService(new MemoryMerchantWebhookStore());
    for (const url of ['https://169.254.169.254/x', 'https://10.0.0.1/x', 'https://svc-ledger/x', 'http://localhost:3000/x']) {
      await expect(svc.registerEndpoint(MERCHANT, url)).rejects.toMatchObject({ code: 'pay.webhook_url_invalid' });
    }
    await expect(svc.registerEndpoint(MERCHANT, 'https://merchant.example/x')).resolves.toBeTruthy();
  });

  it('registerEndpoint allows http localhost only with allowLocalHttp', async () => {
    const svc = new MerchantWebhookService(new MemoryMerchantWebhookStore(), { allowLocalHttp: true });
    await expect(svc.registerEndpoint(MERCHANT, 'http://localhost:3000/x')).resolves.toBeTruthy();
  });

  it('delivery to an endpoint stored with a private URL fails as webhook_target_not_public, is counted, and never connects', async () => {
    const store = new MemoryMerchantWebhookStore();
    const { calls, transport } = stubTransport();
    const svc = new MerchantWebhookService(store, { transport, resolver: publicResolver, disableAfterFailures: 2, maxAttempts: 8 });
    const id = await seed(svc, store, 'http://169.254.169.254/latest/meta-data/');

    const r1 = await svc.processDue(25);
    expect(r1).toEqual({ delivered: 0, failed: 1, disabled: 0 });
    const [delivery] = [...store.deliveries.values()];
    expect(delivery?.lastError).toBe('webhook_target_not_public');
    expect(delivery?.status).toBe('failed');
    expect(store.endpoints.get(id)?.consecutiveFailures).toBe(1);

    for (const d of store.deliveries.values()) d.nextAttemptAt = new Date(0);
    const r2 = await svc.processDue(25);
    expect(r2).toEqual({ delivered: 0, failed: 1, disabled: 1 });
    expect(store.endpoints.get(id)?.status).toBe('disabled');
    expect(store.endpoints.get(id)?.disabledReason).toBe('consecutive_failures');
    expect(calls).toHaveLength(0);
  });

  it('a hostname that resolves to a private address fails as webhook_target_not_public', async () => {
    const store = new MemoryMerchantWebhookStore();
    const { calls, transport } = stubTransport();
    const resolver: WebhookResolver = async () => [
      { address: PUBLIC_ADDR, family: 4 },
      { address: '10.1.2.3', family: 4 },
    ];
    const svc = new MerchantWebhookService(store, { transport, resolver });
    await seed(svc, store, 'https://rebind.merchant.example/hook');

    const r = await svc.processDue(25);
    expect(r.failed).toBe(1);
    expect([...store.deliveries.values()][0]?.lastError).toBe('webhook_target_not_public');
    expect(calls).toHaveLength(0);
  });

  it('a resolver error fails closed as webhook_target_not_public', async () => {
    const store = new MemoryMerchantWebhookStore();
    const { calls, transport } = stubTransport();
    const resolver: WebhookResolver = async () => {
      throw new Error('ENOTFOUND');
    };
    const svc = new MerchantWebhookService(store, { transport, resolver });
    await seed(svc, store, 'https://merchant.example/hook');

    await svc.processDue(25);
    expect([...store.deliveries.values()][0]?.lastError).toBe('webhook_target_not_public');
    expect(calls).toHaveLength(0);
  });

  it('PINS the connect: the vetted address is used and the name is never resolved a second time', async () => {
    const store = new MemoryMerchantWebhookStore();
    const { calls, transport } = stubTransport(200);
    let lookups = 0;
    // First answer is public; any later answer would be loopback (DNS rebinding).
    const resolver: WebhookResolver = async () => {
      lookups += 1;
      return [{ address: lookups === 1 ? PUBLIC_ADDR : '127.0.0.1', family: 4 }];
    };
    const svc = new MerchantWebhookService(store, { transport, resolver });
    await seed(svc, store, 'https://merchant.example/hook');

    const r = await svc.processDue(25);
    expect(r.delivered).toBe(1);
    expect(lookups).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.address).toEqual({ address: PUBLIC_ADDR, family: 4 });
    // Name kept for SNI / Host; the transport receives the vetted IP separately.
    expect(calls[0]!.url.hostname).toBe('merchant.example');
    expect(calls[0]!.timeoutMs).toBe(10_000);
  });

  it('a 302 to the metadata service is NOT followed and is recorded as a failure', async () => {
    const store = new MemoryMerchantWebhookStore();
    const { calls, transport } = stubTransport(302);
    const svc = new MerchantWebhookService(store, { transport, resolver: publicResolver, disableAfterFailures: 1 });
    const id = await seed(svc, store, 'https://merchant.example/hook');

    const r = await svc.processDue(25);
    expect(r).toEqual({ delivered: 0, failed: 1, disabled: 1 });
    const [delivery] = [...store.deliveries.values()];
    expect(delivery?.lastStatusCode).toBe(302);
    expect(delivery?.lastError).toBe('webhook_redirect_not_followed (HTTP 302)');
    expect(calls).toHaveLength(1);
    expect(store.endpoints.get(id)?.status).toBe('disabled');
  });

  it('end to end with the real transport: a receiver that redirects to 169.254.169.254 is hit once and fails', async () => {
    const store = new MemoryMerchantWebhookStore();
    const {
      url,
      server: s,
      cap,
    } = await listen((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    server = s;
    const svc = new MerchantWebhookService(store, { allowLocalHttp: true });
    await svc.registerEndpoint(MERCHANT, url);
    await svc.enqueue({ type: 'payment.captured', payment: payment() });
    const r = await svc.processDue(25);
    expect(r.failed).toBe(1);
    expect(cap.count).toBe(1);
    expect([...store.deliveries.values()][0]?.lastError).toBe('webhook_redirect_not_followed (HTTP 302)');
  });

  it('production posture refuses even a loopback receiver at delivery time', async () => {
    const store = new MemoryMerchantWebhookStore();
    const {
      url,
      server: s,
      cap,
    } = await listen((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    server = s;
    const svc = new MerchantWebhookService(store); // allowLocalHttp defaults to false
    await seed(svc, store, url);

    const r = await svc.processDue(25);
    expect(r.failed).toBe(1);
    expect(cap.count).toBe(0);
    expect([...store.deliveries.values()][0]?.lastError).toBe('webhook_target_not_public');
  });
});
