import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { signPayload } from '../rails/webhook-signature.js';
import { buildSignedHeaders } from '../merchant-webhooks.js';
import {
  absoluteUrl,
  assertDecimalAmount,
  assertHttpsWebhookUrl,
  buildAuthorizePaymentRequest,
  buildCapturePaymentRequest,
  buildCreatePaymentRequest,
  buildGetPaymentRequest,
  buildListWebhookDeliveriesRequest,
  buildListWebhookEndpointsRequest,
  buildRefundRequest,
  buildRegisterWebhookEndpointRequest,
  PAY_PUBLIC_API_BASE,
  sendPluginRequest,
  signMerchantWebhook,
  verifyMerchantWebhook,
} from './reference-client.js';
import { FROZEN_CAPTURED_BODY, frozenWebhookVectors, MERCHANT_WEBHOOK_HEADERS } from './webhook-vectors.js';

/**
 * Unit card — pay.plugins · D26-P1-P8
 *
 * 1. Promise: one real plugin path (TS reference client) or §13 for PHP CMS.
 * 2. Reachable break: store install lacked webhook-endpoint + authorize/capture builders.
 * 3. Done bar: payment lifecycle + webhook register/list/verify pins on public REST.
 * 4. Class N (no money movement in this client).
 * 5. Paths: services/svc-pay/src/plugins/** (+ docs/pay + §13 law).
 * 6. RED first: https refuse, missing idempotency, numeric amount.
 * 7. Collision: clear of settlement-ledger / payment-service (#1694 landed).
 */

const here = dirname(fileURLToPath(import.meta.url));
const clientOpts = {
  baseUrl: 'https://pay.example.test',
  apiKey: 'ifc_test_fixture_not_live',
};

describe('pay.plugins — TypeScript reference client', () => {
  it('pins public API base path', () => {
    expect(PAY_PUBLIC_API_BASE).toBe('/api/pay/v1');
    const req = buildCreatePaymentRequest(clientOpts, { merchantId: 'm1', amount: '1.1', assetId: 'USDT', method: 'card' }, 'order-1');
    expect(req.path).toBe('/api/pay/v1/payments');
    expect(req.method).toBe('POST');
    expect(req.headers.authorization).toBe('Bearer ifc_test_fixture_not_live');
    expect(req.headers['idempotency-key']).toBe('order-1');
    expect(req.headers['content-type']).toBe('application/json');
  });

  it('refuses money POST without Idempotency-Key', () => {
    expect(() => buildCreatePaymentRequest(clientOpts, { merchantId: 'm1', amount: '1', assetId: 'USDT', method: 'card' }, '  ')).toThrow(
      /Idempotency-Key/,
    );
  });

  it('amount is a decimal string on the wire — never a JSON number', () => {
    expect(() => assertDecimalAmount(1.1 as unknown as string)).toThrow(/decimal string/);
    expect(() => assertDecimalAmount('1.1')).not.toThrow();
    const req = buildCreatePaymentRequest(clientOpts, { merchantId: 'm1', amount: '10.50', assetId: 'USDT', method: 'crypto' }, 'ord-2');
    const body = JSON.parse(req.body!) as { amount: unknown };
    expect(typeof body.amount).toBe('string');
    expect(body.amount).toBe('10.50');
  });

  it('get payment and refund paths follow the public contract', () => {
    const get = buildGetPaymentRequest(clientOpts, 'pay_abc');
    expect(get.path).toBe('/api/pay/v1/payments/pay_abc');
    expect(get.method).toBe('GET');

    const refund = buildRefundRequest(clientOpts, 'pay_abc', { amount: '1', refundId: 'r1' }, 'refund-key-1');
    expect(refund.path).toBe('/api/pay/v1/payments/pay_abc/refund');
    expect(refund.headers['idempotency-key']).toBe('refund-key-1');
  });

  it('authorize and capture money POSTs require Idempotency-Key and pin paths', () => {
    expect(() => buildAuthorizePaymentRequest(clientOpts, 'pay_abc', '  ')).toThrow(/Idempotency-Key/);
    expect(() => buildCapturePaymentRequest(clientOpts, 'pay_abc', '')).toThrow(/Idempotency-Key/);

    const auth = buildAuthorizePaymentRequest(clientOpts, 'pay_abc', 'auth-1');
    expect(auth.path).toBe('/api/pay/v1/payments/pay_abc/authorize');
    expect(auth.method).toBe('POST');
    expect(auth.headers['idempotency-key']).toBe('auth-1');
    expect(auth.body).toBe('{}');

    const cap = buildCapturePaymentRequest(clientOpts, 'pay_abc', 'cap-1');
    expect(cap.path).toBe('/api/pay/v1/payments/pay_abc/capture');
    expect(cap.headers['idempotency-key']).toBe('cap-1');
  });

  it('registers webhook endpoints over https only and lists deliveries', () => {
    expect(() => buildRegisterWebhookEndpointRequest(clientOpts, { merchantId: 'm1', url: 'http://merchant.example/hooks' })).toThrow(
      /https/,
    );
    expect(() => assertHttpsWebhookUrl('not-a-url')).toThrow(/valid https URL/);

    const reg = buildRegisterWebhookEndpointRequest(clientOpts, {
      merchantId: 'm1',
      url: 'https://merchant.example/hooks/pay',
    });
    expect(reg.method).toBe('POST');
    expect(reg.path).toBe('/api/pay/v1/webhook-endpoints');
    expect(reg.headers.authorization).toBe('Bearer ifc_test_fixture_not_live');
    expect(JSON.parse(reg.body!).url).toBe('https://merchant.example/hooks/pay');

    const list = buildListWebhookEndpointsRequest(clientOpts, 'm1', { limit: 50 });
    expect(list.path).toBe('/api/pay/v1/webhook-endpoints?merchantId=m1&limit=50');
    expect(() => buildListWebhookEndpointsRequest(clientOpts, 'm1', { limit: undefined as unknown as number })).toThrow(/never 50/);

    const deliveries = buildListWebhookDeliveriesRequest(clientOpts, 'm1', { status: 'failed', limit: 50 });
    expect(deliveries.path).toBe('/api/pay/v1/webhook-deliveries?merchantId=m1&status=failed&limit=50');
  });

  it('frozen webhook vectors match the core rail signPayload', () => {
    for (const v of frozenWebhookVectors()) {
      const core = signPayload(v.secret, v.timestampSeconds, v.rawBody);
      expect(core, v.name).toBe(v.signatureHex);
      expect(signMerchantWebhook(v.secret, v.timestampSeconds, v.rawBody)).toBe(v.signatureHex);
      expect(
        verifyMerchantWebhook({
          secret: v.secret,
          rawBody: v.rawBody,
          signatureHex: v.signatureHex,
          timestampSeconds: v.timestampSeconds,
          now: new Date(Number(v.timestampSeconds) * 1000),
          toleranceSeconds: 300,
        }),
      ).toBe(true);
    }
  });

  it('rejects tampered body and stale timestamps', () => {
    const v = frozenWebhookVectors()[0]!;
    expect(
      verifyMerchantWebhook({
        secret: v.secret,
        rawBody: v.rawBody + ' ',
        signatureHex: v.signatureHex,
        timestampSeconds: v.timestampSeconds,
        now: new Date(Number(v.timestampSeconds) * 1000),
        toleranceSeconds: 300,
      }),
    ).toBe(false);

    expect(
      verifyMerchantWebhook({
        secret: v.secret,
        rawBody: v.rawBody,
        signatureHex: v.signatureHex,
        timestampSeconds: v.timestampSeconds,
        now: new Date((Number(v.timestampSeconds) + 10_000) * 1000),
        toleranceSeconds: 300,
      }),
    ).toBe(false);
  });

  it('documents header names merchants must verify', () => {
    expect(MERCHANT_WEBHOOK_HEADERS.signature).toBe('x-intafaced-signature');
    expect(MERCHANT_WEBHOOK_HEADERS.timestamp).toBe('x-intafaced-timestamp');
    // What svc-pay sends on a delivery carries exactly the headers this client documents, and they verify here.
    const v = frozenWebhookVectors()[0]!;
    const sent = buildSignedHeaders(v.secret, v.timestampSeconds, v.rawBody);
    expect(sent[MERCHANT_WEBHOOK_HEADERS.timestamp]).toBe(v.timestampSeconds);
    expect(sent[MERCHANT_WEBHOOK_HEADERS.signature]).toBe(v.signatureHex);
    expect(
      verifyMerchantWebhook({
        secret: v.secret,
        rawBody: v.rawBody,
        signatureHex: sent[MERCHANT_WEBHOOK_HEADERS.signature]!,
        timestampSeconds: sent[MERCHANT_WEBHOOK_HEADERS.timestamp]!,
        now: new Date(Number(v.timestampSeconds) * 1000),
        toleranceSeconds: 300,
      }),
    ).toBe(true);
  });

  it('captured vector body keeps amount as a string (contract break detector)', () => {
    const parsed = JSON.parse(FROZEN_CAPTURED_BODY) as { data: { amount: unknown } };
    expect(typeof parsed.data.amount).toBe('string');
  });

  it('does not ship PHP CMS plugin trees (honest reclassify)', () => {
    // This TypeScript client IS the product path; no PHP CMS adapter (Woo, Magento, OpenCart) is shipped beside it.
    const shipped = (readdirSync(here, { recursive: true }) as string[]).map((f) => f.split('\\').join('/'));
    expect(shipped.filter((f) => /\.(php|phtml|tpl|twig)$/i.test(f))).toEqual([]);
    expect(shipped.filter((f) => /(^|\/)(wp-content|app\/code|catalog\/controller|admin\/controller)(\/|$)/i.test(f))).toEqual([]);
  });

  it('public-door sendPluginRequest posts create-payment contract to a live HTTP stub', async () => {
    const { createServer } = await import('node:http');
    const seen: { method?: string; url?: string; auth?: string; idem?: string; body?: string } = {};
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.method = req.method;
        seen.url = req.url;
        seen.auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
        seen.idem = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;
        seen.body = Buffer.concat(chunks).toString('utf8');
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'pay_stub', status: 'created', amount: '1.10' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    try {
      const req = buildCreatePaymentRequest(
        { baseUrl, apiKey: 'ifc_test_fixture_not_live' },
        { merchantId: 'm1', amount: '1.10', assetId: 'USDT', method: 'card' },
        'order-public-door',
      );
      expect(absoluteUrl({ baseUrl, apiKey: 'x' }, req.path)).toBe(`${baseUrl}/api/pay/v1/payments`);
      const res = await sendPluginRequest({ baseUrl, apiKey: 'ifc_test_fixture_not_live' }, req);
      expect(res.status).toBe(201);
      expect(seen.method).toBe('POST');
      expect(seen.url).toBe('/api/pay/v1/payments');
      expect(seen.auth).toBe('Bearer ifc_test_fixture_not_live');
      expect(seen.idem).toBe('order-public-door');
      const body = JSON.parse(seen.body ?? '{}') as { amount: unknown };
      expect(typeof body.amount).toBe('string');
      expect((res.body as { id: string }).id).toBe('pay_stub');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
