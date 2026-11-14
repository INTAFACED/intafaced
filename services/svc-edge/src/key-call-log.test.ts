import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { apiKeyCallRecordInputSchema } from '@intafaced/contracts/api-keys';
import { keyCallReport, presentedKeyHash, reportKeyCall } from './key-call-log.js';

// A key's call log (J-developer-08): what the edge reports to identity for each call it answered for an API key. TEST values.
const KEY = 'ifc_TESTkeyvalue0123456789abcdefghij';
const SECRET = 'an-edge-authority-test-secret-long-enough-0123';

describe('presentedKeyHash', () => {
  it('hashes an API key the way identity stores it, and nothing else', () => {
    expect(presentedKeyHash(`Bearer ${KEY}`)).toBe(createHash('sha256').update(KEY).digest('hex'));
    expect(presentedKeyHash([`bearer ${KEY}`])).toBe(createHash('sha256').update(KEY).digest('hex'));
    // A session token (a JWT) or no bearer at all is not a key's call.
    expect(presentedKeyHash('Bearer aaa.bbb.ccc')).toBeNull();
    expect(presentedKeyHash('Basic abc')).toBeNull();
    expect(presentedKeyHash(undefined)).toBeNull();
  });
});

describe('keyCallReport', () => {
  it('keeps the method, the path without its query, the status and the request id, and never the key', () => {
    const report = keyCallReport({
      keyHash: presentedKeyHash(`Bearer ${KEY}`)!,
      requestId: 'req-1',
      method: 'post',
      url: '/api/v1/orders?token=hidden',
      status: 403,
      clientIp: '127.0.0.2',
      at: new Date('2026-11-12T08:00:00.000Z'),
    });
    expect(apiKeyCallRecordInputSchema.parse(report)).toEqual(report);
    expect(report).toMatchObject({
      method: 'POST',
      path: '/api/v1/orders',
      status: 403,
      requestId: 'req-1',
      at: '2026-11-12T08:00:00.000Z',
    });
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(JSON.stringify(report)).not.toContain('hidden');
  });
});

describe('reportKeyCall', () => {
  const report = keyCallReport({
    keyHash: presentedKeyHash(`Bearer ${KEY}`)!,
    requestId: 'req-2',
    method: 'GET',
    url: '/api/v1/account/balance',
    status: 200,
    clientIp: '127.0.0.1',
    at: new Date('2026-11-12T08:00:00.000Z'),
  });

  it("posts the report to identity's edge-only door, signed as svc-edge", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ result: { data: { recorded: true } } }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    expect(await reportKeyCall({ identityUrl: 'http://identity.test/', identityOwnershipSecret: SECRET, fetch, report })).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('http://identity.test/trpc/developerKeys.recordCall');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual(report);
    expect((seen[0]!.init.headers as Record<string, string>)['x-intafaced-service']).toBe('svc-edge');
  });

  it('answers false, never throws, when identity refuses or cannot be reached', async () => {
    const refusing = (async () => new Response('{}', { status: 401 })) as unknown as typeof globalThis.fetch;
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    expect(await reportKeyCall({ identityUrl: 'http://identity.test', identityOwnershipSecret: SECRET, fetch: refusing, report })).toBe(
      false,
    );
    expect(await reportKeyCall({ identityUrl: 'http://identity.test', identityOwnershipSecret: SECRET, fetch: down, report })).toBe(false);
  });
});
