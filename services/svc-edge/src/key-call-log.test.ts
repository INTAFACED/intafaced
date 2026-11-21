import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { apiKeyCallRecordInputSchema } from '@intafaced/contracts/api-keys';
import { ERROR_CODE_BODY_MAX, keyCallReport, presentedKeyHash, replyErrorCode, reportKeyCall } from './key-call-log.js';

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
    }) as typeof globalThis.fetch;
    expect(await reportKeyCall({ identityUrl: 'http://identity.test/', identityOwnershipSecret: SECRET, fetch, report })).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('http://identity.test/trpc/developerKeys.recordCall');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual(report);
    expect((seen[0]!.init.headers as Record<string, string>)['x-intafaced-service']).toBe('svc-edge');
  });

  it('answers false, never throws, when identity refuses or cannot be reached', async () => {
    const refusing = (async () => new Response('{}', { status: 401 })) as typeof globalThis.fetch;
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof globalThis.fetch;
    expect(await reportKeyCall({ identityUrl: 'http://identity.test', identityOwnershipSecret: SECRET, fetch: refusing, report })).toBe(
      false,
    );
    expect(await reportKeyCall({ identityUrl: 'http://identity.test', identityOwnershipSecret: SECRET, fetch: down, report })).toBe(false);
  });
});

describe('replyErrorCode', () => {
  it('keeps only the typed code of an error reply, never its message or body', () => {
    const edge = JSON.stringify({ code: 'edge.api_key_ip_denied', message: 'This key may not be used from 10.0.0.9', requestId: 'r' });
    expect(replyErrorCode(403, edge)).toBe('edge.api_key_ip_denied');
    expect(replyErrorCode(403, Buffer.from(edge))).toBe('edge.api_key_ip_denied');
    // A REST error names its class in `code` and its own reason beside it.
    const rest = JSON.stringify({ code: 'PermissionDenied', message: 'Trading is restricted', intafacedCode: 'trade.account_restricted' });
    expect(replyErrorCode(403, rest)).toBe('trade.account_restricted');
    // A tRPC error names its code in its cause; the status word (`FORBIDDEN`) is only the last resort.
    const trpc = JSON.stringify({
      error: {
        message: 'Trading is restricted [trade.account_restricted]',
        code: -32003,
        data: { code: 'FORBIDDEN', cause: { code: 'trade.account_restricted' } },
      },
    });
    expect(replyErrorCode(403, trpc)).toBe('trade.account_restricted');
    expect(replyErrorCode(403, JSON.stringify({ error: { code: -32003, data: { code: 'FORBIDDEN' } } }))).toBe('FORBIDDEN');
  });

  it('is null on a success, a body that is no JSON object, a code that is not a code, and an oversize body', () => {
    expect(replyErrorCode(200, JSON.stringify({ code: 'ok.code' }))).toBeNull();
    expect(replyErrorCode(500, 'upstream exploded')).toBeNull();
    expect(replyErrorCode(400, JSON.stringify([{ code: 'a.b' }]))).toBeNull();
    expect(replyErrorCode(400, JSON.stringify({ code: 'not a code, a sentence the caller sent' }))).toBeNull();
    expect(replyErrorCode(400, JSON.stringify({ code: 'a.b', pad: 'x'.repeat(ERROR_CODE_BODY_MAX) }))).toBeNull();
    expect(replyErrorCode(400, undefined)).toBeNull();
  });

  it('goes into the report beside the status', () => {
    const report = keyCallReport({
      keyHash: presentedKeyHash(`Bearer ${KEY}`)!,
      requestId: 'req-3',
      method: 'POST',
      url: '/api/v1/orders',
      status: 403,
      errorCode: replyErrorCode(403, JSON.stringify({ code: 'trade.account_restricted', message: 'm' })),
      clientIp: null,
      at: new Date('2026-11-12T08:00:00.000Z'),
    });
    expect(apiKeyCallRecordInputSchema.parse(report)).toEqual(report);
    expect(report.errorCode).toBe('trade.account_restricted');
  });
});
