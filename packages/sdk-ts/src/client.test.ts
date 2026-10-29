import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPayClient, PayClient, signPayRequest, signaturesEqual } from './index.js';
import { retryDelayMs, type PayTransportRequest } from './client.js';

const SECRET = 'ifs_vector-lock';
const GOLDEN = 'd61e9fa131b74a34ffdf69dbeee3fe8b82b68168d54a230d9d7ed12f042b4283';
const edgeHref = new URL('../../../services/svc-edge/src/api-key-request-sign.ts', import.meta.url).href;

type EdgeSign = {
  canonicalRequest: (input: { method: string; path: string; timestamp: string; nonce: string; bodyHash: string }) => string;
  hashBody: (body: Uint8Array | string | null | undefined) => string;
  signRequest: (secret: string, canonical: string) => string;
};

async function loadEdge(): Promise<EdgeSign> {
  return (await import(edgeHref)) as EdgeSign;
}

function header(headers: PayTransportRequest['headers'], name: string): string {
  return headers[name] ?? headers[name.toLowerCase()] ?? '';
}

describe('request signing helper', () => {
  it('matches the edge canonical string and the published vector', async () => {
    const edge = await loadEdge();
    const signed = signPayRequest({
      secret: SECRET,
      method: 'post',
      path: '/api/pay/v1/payments?merchantId=abc',
      timestamp: '1700000000',
      nonce: 'nonce-fresh-1',
      body: null,
    });
    const bodyHash = 'ab'.repeat(32);
    const canonical = edge.canonicalRequest({
      method: 'POST',
      path: '/api/pay/v1/payments?merchantId=abc',
      timestamp: '1700000000',
      nonce: 'nonce-fresh-1',
      bodyHash,
    });
    expect(edge.signRequest(SECRET, canonical)).toBe(GOLDEN);
    const raw = '{"amount":"1.10"}';
    const again = signPayRequest({
      secret: SECRET,
      method: 'POST',
      path: '/api/pay/v1/payments',
      timestamp: '1700000000',
      nonce: 'nonce-fresh-1',
      body: raw,
    });
    expect(again.bodyHash).toBe(edge.hashBody(raw));
    expect(again.signature).toBe(
      edge.signRequest(
        SECRET,
        edge.canonicalRequest({
          method: 'POST',
          path: '/api/pay/v1/payments',
          timestamp: '1700000000',
          nonce: 'nonce-fresh-1',
          bodyHash: again.bodyHash,
        }),
      ),
    );
    expect(signed.canonical.startsWith('INTAFACED-REQ-V1\nPOST\n')).toBe(true);
  });

  it('compares signatures in constant time and ignores a length mismatch', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sign.ts'), 'utf8');
    expect(src).toContain('timingSafeEqual');
    expect(src).not.toMatch(/signature\s*===/);
    expect(signaturesEqual('abcd', 'abcd')).toBe(true);
    expect(signaturesEqual('abcd', 'ab')).toBe(false);
    expect(signaturesEqual('zz', 'zz')).toBe(false);
  });

  it('holds no signing window of its own: the window is the owner value the server publishes', async () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sign.ts'), 'utf8');
    expect(src).not.toMatch(/WINDOW_SECONDS\s*=|\b300\b/);
    expect(Object.keys(await import('./index.js')).filter((name) => /WINDOW/.test(name))).toEqual([]);
  });
});

describe('PayClient', () => {
  it('refuses a blank host, a blank key, and a numeric amount', async () => {
    expect(() => new PayClient({ baseUrl: '  ', apiKey: 'ifc_test_x' })).toThrow(/not configured/);
    expect(() => new PayClient({ baseUrl: 'https://pay.example/api/pay/v1', apiKey: '' })).toThrow(/not configured/);
    const seen: PayTransportRequest[] = [];
    const client = new PayClient({
      baseUrl: 'https://pay.example/api/pay/v1',
      apiKey: 'ifc_test_x',
      transport: async (input) => {
        seen.push(input);
        return { status: 200, body: '{}' };
      },
    });
    await expect(client.call({ method: 'POST', path: '/payments', idempotency: true, body: { amount: 1.1 } })).rejects.toThrow(
      /decimal string/,
    );
    expect(seen).toHaveLength(0);
  });

  it('keeps a decimal amount as a string', async () => {
    let raw = '';
    const client = new PayClient({
      baseUrl: 'https://pay.example/api/pay/v1',
      apiKey: 'ifc_test_x',
      maxRetries: 0,
      transport: async (input) => {
        raw = new TextDecoder().decode(input.body);
        return { status: 200, body: raw };
      },
    });
    await client.call({ method: 'POST', path: '/payments', idempotency: true, idempotencyKey: 'business-1', body: { amount: '1.10' } });
    expect(raw).toBe('{"amount":"1.10"}');
  });

  it('reuses the idempotency key and signs each attempt with a fresh nonce', async () => {
    const edge = await loadEdge();
    const nonces = ['nonce-fresh-1', 'nonce-fresh-2'];
    let cursor = 0;
    const calls: PayTransportRequest[] = [];
    const client = new PayClient({
      baseUrl: 'https://pay.example/api/pay/v1',
      apiKey: 'ifc_test_x',
      signingSecret: SECRET,
      maxRetries: 1,
      sleep: async () => undefined,
      now: () => 1_700_000_000_000,
      nonce: () => nonces[cursor++] ?? 'nonce-unused',
      transport: async (input) => {
        calls.push(input);
        const status = calls.length === 1 ? 500 : 200;
        return { status, body: '{"amount":"1.10"}' };
      },
    });
    const result = await client.call({
      method: 'POST',
      path: '/payments',
      idempotency: true,
      idempotencyKey: 'business-1',
      query: { merchantId: 'abc' },
      body: { amount: '1.10' },
    });
    expect(result.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(header(calls[0]!.headers, 'idempotency-key')).toBe('business-1');
    expect(header(calls[1]!.headers, 'idempotency-key')).toBe('business-1');
    expect(header(calls[0]!.headers, 'x-intafaced-request-nonce')).toBe('nonce-fresh-1');
    expect(header(calls[1]!.headers, 'x-intafaced-request-nonce')).toBe('nonce-fresh-2');
    for (const call of calls) {
      const raw = new TextDecoder().decode(call.body);
      const nonce = header(call.headers, 'x-intafaced-request-nonce');
      const timestamp = header(call.headers, 'x-intafaced-request-timestamp');
      const path = new URL(call.url).pathname + new URL(call.url).search;
      expect(path).toBe('/api/pay/v1/payments?merchantId=abc');
      expect(header(call.headers, 'x-intafaced-request-signature')).toBe(
        edge.signRequest(
          SECRET,
          edge.canonicalRequest({
            method: 'POST',
            path,
            timestamp,
            nonce,
            bodyHash: edge.hashBody(raw),
          }),
        ),
      );
    }
  });

  it('does not retry a client error and does not sign when no secret is configured', async () => {
    const calls: PayTransportRequest[] = [];
    const client = new PayClient({
      baseUrl: 'https://pay.example/api/pay/v1',
      apiKey: 'ifc_test_x',
      maxRetries: 2,
      transport: async (input) => {
        calls.push(input);
        return { status: 400, body: '{"code":"pay.bad_request"}' };
      },
    });
    const result = await client.call({ method: 'POST', path: '/payments', idempotency: true, body: { amount: '1.00' } });
    expect(result.status).toBe(400);
    expect(calls).toHaveLength(1);
    expect(header(calls[0]!.headers, 'x-intafaced-request-signature')).toBe('');
    expect(header(calls[0]!.headers, 'idempotency-key').length).toBeGreaterThan(0);
  });

  it('issues a new idempotency key for a new call', async () => {
    const keys: string[] = [];
    const seen: string[] = [];
    const client = new PayClient({
      baseUrl: 'https://pay.example/api/pay/v1',
      apiKey: 'ifc_test_x',
      maxRetries: 1,
      sleep: async () => undefined,
      newIdempotencyKey: () => {
        const key = `idem-${keys.length}`;
        keys.push(key);
        return key;
      },
      transport: async (input) => {
        seen.push(header(input.headers, 'idempotency-key'));
        return { status: seen.length === 1 ? 503 : 200, body: '{}' };
      },
    });
    await client.call({ method: 'POST', path: '/payments', idempotency: true, body: {} });
    await client.call({ method: 'POST', path: '/payments', idempotency: true, body: {} });
    expect(seen).toEqual(['idem-0', 'idem-0', 'idem-1']);
  });

  it('retries only safe methods or a call that carries an Idempotency-Key, with backoff and Retry-After', async () => {
    let posts = 0;
    const unsafe = new PayClient({
      baseUrl: 'https://pay.example/api/pay/v1',
      apiKey: 'ifc_test_x',
      maxRetries: 2,
      sleep: async () => {
        throw new Error('unsafe POST must not wait to retry');
      },
      transport: async () => {
        posts += 1;
        return { status: 500, body: '{}' };
      },
    });
    await expect(unsafe.call({ method: 'POST', path: '/payments', idempotency: false, body: {} })).resolves.toMatchObject({ status: 500 });
    expect(posts).toBe(1);

    const delays: number[] = [];
    let gets = 0;
    const reader = new PayClient({
      baseUrl: 'https://pay.example/api/pay/v1',
      apiKey: 'ifc_test_x',
      maxRetries: 1,
      random: () => 0,
      now: () => 1_700_000_000_000,
      sleep: async (ms) => {
        delays.push(ms);
      },
      transport: async () => {
        gets += 1;
        return gets === 1 ? { status: 503, body: '{}', headers: { 'Retry-After': '2' } } : { status: 200, body: '{}' };
      },
    });
    await expect(reader.call({ method: 'GET', path: '/payments', idempotency: false })).resolves.toMatchObject({ status: 200 });
    expect(gets).toBe(2);
    expect(delays).toEqual([2_000]);

    const headDelays: number[] = [];
    let heads = 0;
    const head = new PayClient({
      baseUrl: 'https://pay.example/api/pay/v1',
      apiKey: 'ifc_test_x',
      maxRetries: 1,
      random: () => 0,
      now: () => 1_700_000_000_000,
      sleep: async (ms) => {
        headDelays.push(ms);
      },
      transport: async () => {
        heads += 1;
        return { status: heads === 1 ? 429 : 200, body: '' };
      },
    });
    await head.call({ method: 'HEAD', path: '/payments', idempotency: false });
    expect(heads).toBe(2);
    expect(headDelays).toEqual([retryDelayMs(0, '', 1_700_000_000_000, () => 0)]);

    let keyedPosts = 0;
    const keyed = new PayClient({
      baseUrl: 'https://pay.example/api/pay/v1',
      apiKey: 'ifc_test_x',
      maxRetries: 1,
      sleep: async () => undefined,
      transport: async () => {
        keyedPosts += 1;
        return { status: keyedPosts === 1 ? 500 : 200, body: '{}' };
      },
    });
    await expect(
      keyed.call({ method: 'POST', path: '/payments', idempotency: false, idempotencyKey: 'business-1', body: {} }),
    ).resolves.toMatchObject({ status: 200 });
    expect(keyedPosts).toBe(2);
  });
});

describe('sandbox contract', () => {
  it('posts a signed retry to a local payments sandbox', async () => {
    const edge = await loadEdge();
    const seen: Array<{ path: string; body: string; idempotency: string; nonce: string; signature: string; timestamp: string }> = [];
    const server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        seen.push({
          path: req.url ?? '',
          body,
          idempotency: String(req.headers['idempotency-key'] ?? ''),
          nonce: String(req.headers['x-intafaced-request-nonce'] ?? ''),
          signature: String(req.headers['x-intafaced-request-signature'] ?? ''),
          timestamp: String(req.headers['x-intafaced-request-timestamp'] ?? ''),
        });
        const status = seen.length === 1 ? 500 : 200;
        const payload = '{"id":"pay_sandbox","amount":"1.10"}';
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(payload);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    try {
      const api = createPayClient({
        baseUrl: `http://127.0.0.1:${port}/api/pay/v1`,
        apiKey: 'ifc_test_sandbox',
        signingSecret: SECRET,
        maxRetries: 1,
        sleep: async () => undefined,
      });
      const result = await api.postPayments({ body: { amount: '1.10', assetId: 'USD' } });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ amount: '1.10' });
      expect(seen).toHaveLength(2);
      expect(seen[0]!.idempotency).toBe(seen[1]!.idempotency);
      expect(seen[0]!.nonce).not.toBe(seen[1]!.nonce);
      expect(seen[0]!.path).toBe('/api/pay/v1/payments');
      for (const call of seen) {
        expect(call.signature).toBe(
          edge.signRequest(
            SECRET,
            edge.canonicalRequest({
              method: 'POST',
              path: call.path,
              timestamp: call.timestamp,
              nonce: call.nonce,
              bodyHash: edge.hashBody(call.body),
            }),
          ),
        );
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});

describe('generated surface', () => {
  it('has no founder or operator paths', () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const operations = readFileSync(join(root, 'operations.ts'), 'utf8');
    const spec = readFileSync(join(root, '..', 'openapi', 'payments.openapi.json'), 'utf8');
    for (const text of [operations, spec]) {
      expect(text).not.toMatch(/founderAdmin|founder-admin|payHalts|operatorStatus/);
      expect(text).not.toMatch(/\/operator(\/|")/);
    }
  });
});
