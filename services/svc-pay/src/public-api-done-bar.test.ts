/**
 * D26-P1-P7 Done bar — Surface + webhooks + sandbox.
 *
 * Promise: a merchant can call the REST surface, receive signed webhooks with
 * retry/disable/re-enable, and tell sandbox from live without inventing a
 * second stack or a live PSP.
 * Break: missing mode, undeliverable webhooks with no dashboard path, or
 * sandbox/live rail confusion.
 * Class: M. Leverage: extend svc-pay public-rest + merchant-webhooks +
 * sandbox-key-routing (Phase A S-PAY) — no second book, no SPA rebuild.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryMerchantWebhookStore, MerchantWebhookService } from './merchant-webhooks.js';
import { PayError, type PayService } from './payment-service.js';
import { registerPublicPayRest } from './public-rest.js';
import { verifySignature } from './rails/webhook-signature.js';
import { MemoryRestIdempotencyStore } from './rest-idempotency.js';

const SECRET = 'a-pay-public-api-done-bar-edge-secret-xx';
const OWNER = '11111111-1111-4111-8111-111111111111';
const MERCHANT = '33333333-3333-4333-8333-333333333333';
const PAYMENT = '44444444-4444-4444-8444-444444444444';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: OWNER,
    userId: OWNER,
    sid: '55555555-5555-4555-8555-555555555555',
    scopes: ['pay:read', 'pay:write', 'pay:refund'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signed(p: Principal = principal()): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

type Captured = { headers: Record<string, string>; body: string; count: number };

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
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
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return { url: `http://127.0.0.1:${addr.port}/hook`, server, cap };
}

function stubPay(): PayService {
  return {
    getMerchant: async (id: string) => {
      if (id !== MERCHANT) throw new PayError(`merchant ${id} not found`, 'pay.merchant_not_found');
      return { id: MERCHANT, userId: OWNER } as never;
    },
    getPayment: async () => {
      throw new PayError('unused', 'pay.payment_not_found');
    },
    listPayments: async () => [],
    clearingBalance: async () => parseAmount('0'),
    merchantBalance: async () => parseAmount('0'),
    createPayment: async (input: { railAdapter: string }) =>
      ({
        id: PAYMENT,
        merchantId: MERCHANT,
        profileId: null,
        amount: parseAmount('1.10'),
        assetId: 'USD',
        method: 'card',
        railAdapter: input.railAdapter,
        railRef: null,
        status: 'created',
        capturedAmount: parseAmount('0'),
        refundedAmount: parseAmount('0'),
        createdAt: new Date('2026-08-12T10:00:00.000Z'),
      }) as never,
    authorize: async () => {
      throw new PayError('unused', 'pay.invalid_transition');
    },
    capture: async () => {
      throw new PayError('unused', 'pay.invalid_transition');
    },
    refund: async () => {
      throw new PayError('unused', 'pay.invalid_transition');
    },
  } as unknown as PayService;
}

describe('D26-P1-P7 Done bar — surface + webhooks + sandbox', () => {
  let app: FastifyInstance | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    server = undefined;
  });

  it('sandbox create → mode=sandbox; live naming sandbox refused; webhook deliver+enable', async () => {
    const store = new MemoryMerchantWebhookStore();
    const webhooks = new MerchantWebhookService(store, { disableAfterFailures: 1, maxAttempts: 4 });
    app = Fastify({ logger: false });
    await registerPublicPayRest(app, {
      edgeSecret: SECRET,
      serviceName: 'svc-pay',
      pay: stubPay(),
      idempotency: new MemoryRestIdempotencyStore(),
      webhooks,
    });
    await app.ready();

    // Surface + sandbox
    const sandboxCreate = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: {
        ...signed(principal({ key_env: 'sandbox', kid: 'sandbox-key' })),
        'content-type': 'application/json',
        'idempotency-key': 'done:sandbox:1',
      },
      payload: {
        merchantId: MERCHANT,
        amount: '1.10',
        assetId: 'USD',
        method: 'card',
        railAdapter: 'crypto-native',
      },
    });
    expect(sandboxCreate.statusCode).toBe(200);
    expect(sandboxCreate.json().mode).toBe('sandbox');
    expect(sandboxCreate.json().railAdapter).toBe('card-sandbox');

    const liveRefuse = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: {
        ...signed(principal({ key_env: 'live', kid: 'live-key' })),
        'content-type': 'application/json',
        'idempotency-key': 'done:live:refuse',
      },
      payload: {
        merchantId: MERCHANT,
        amount: '1.10',
        assetId: 'USD',
        method: 'card',
        railAdapter: 'card-sandbox',
      },
    });
    expect(liveRefuse.statusCode).toBe(503);
    expect(liveRefuse.json().error.code).toBe('pay.sandbox_rail_refused');

    // Webhooks — signed delivery, then disable on failure, then re-enable
    let failNext = false;
    const {
      url,
      server: s,
      cap,
    } = await listen((_req, res) => {
      if (failNext) {
        res.writeHead(500);
        res.end('down');
        return;
      }
      res.writeHead(200);
      res.end('ok');
    });
    server = s;

    const reg = await app.inject({
      method: 'POST',
      url: '/v1/webhook-endpoints',
      headers: { ...signed(), 'content-type': 'application/json' },
      payload: { merchantId: MERCHANT, url },
    });
    expect(reg.statusCode).toBe(200);
    const secret = reg.json().secret as string;
    expect(secret).toHaveLength(64);

    await webhooks.enqueue({
      type: 'payment.captured',
      payment: {
        id: PAYMENT,
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
        createdAt: new Date('2026-08-12T10:00:00.000Z'),
      } as never,
    });

    const delivered = await webhooks.processDue();
    expect(delivered.delivered).toBe(1);
    expect(cap.count).toBe(1);
    expect(
      verifySignature({
        body: cap.body,
        signature: cap.headers['x-intafaced-signature']!,
        timestamp: cap.headers['x-intafaced-timestamp']!,
        secret,
        toleranceSeconds: 300,
        now: new Date(Number(cap.headers['x-intafaced-timestamp']) * 1000),
      }),
    ).toBe(true);

    failNext = true;
    await webhooks.enqueue({
      type: 'payment.authorized',
      payment: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        merchantId: MERCHANT,
        profileId: null,
        amount: parseAmount('2.00'),
        assetId: 'USD',
        method: 'card',
        railAdapter: 'card-sandbox',
        railRef: null,
        status: 'authorized',
        capturedAmount: parseAmount('0'),
        refundedAmount: parseAmount('0'),
        createdAt: new Date('2026-08-12T10:01:00.000Z'),
      } as never,
    });
    const failed = await webhooks.processDue();
    expect(failed.disabled).toBe(1);

    const dashboard = await app.inject({
      method: 'GET',
      url: `/v1/webhook-deliveries?merchantId=${MERCHANT}&status=failed`,
      headers: signed(),
    });
    expect(dashboard.statusCode).toBe(200);
    expect((dashboard.json() as unknown[]).length).toBeGreaterThanOrEqual(1);

    const endpointId = reg.json().id as string;
    const enable = await app.inject({
      method: 'POST',
      url: `/v1/webhook-endpoints/${endpointId}/enable?merchantId=${MERCHANT}`,
      headers: signed(),
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json().status).toBe('active');
    expect(enable.json().consecutiveFailures).toBe(0);
  });
});
