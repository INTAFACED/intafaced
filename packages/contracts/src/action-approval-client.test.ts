import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTION_APPROVAL_CONSUME_FAILED,
  IDENTITY_CONSUME_TIMEOUT_MS,
  createIdentityApprovalClient,
  unwrapTrpcData,
} from './action-approval-client.js';
import { SERVICE_HEADER, SERVICE_SIGNATURE_HEADER } from './service-auth.js';

const SECRET = 's'.repeat(32);
const input = {
  approvalId: 'ap-1',
  operationId: 'op-1',
  payloadHash: 'sha256:abc',
  targetService: 'svc-bank',
  targetId: 'bank.x',
  expectedVersion: 'v1',
};
const approval = (over: Record<string, unknown> = {}) => ({
  ...input,
  actionType: 'bank.x',
  requesterId: 'r',
  approverId: 'a',
  policyVersion: 'v1',
  createdAt: '2026-09-09T12:00:00.000Z',
  expiresAt: '2026-09-09T12:10:00.000Z',
  status: 'CONSUMED',
  ...over,
});
class TestError extends Error {}
const client = (timeoutMs?: number) =>
  createIdentityApprovalClient({
    service: 'svc-test',
    baseUrl: 'http://identity:4001/',
    internalSecret: SECRET,
    fail: (m) => new TestError(m),
    timeoutMs,
  });
const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

describe('unwrapTrpcData', () => {
  it('reads plain, result.data and superjson shapes', () => {
    expect(unwrapTrpcData({ a: 1 })).toEqual({ a: 1 });
    expect(unwrapTrpcData({ result: { data: { a: 1 } } })).toEqual({ a: 1 });
    expect(unwrapTrpcData({ result: { data: { json: { a: 1 } } } })).toEqual({ a: 1 });
    expect(unwrapTrpcData(null)).toBeNull();
  });
});

describe('createIdentityApprovalClient', () => {
  it('posts a signed body to identity and returns the consumed approval', async () => {
    const f = reply({ result: { data: { json: approval() } } });
    vi.stubGlobal('fetch', f);
    await expect(client().consume(input)).resolves.toMatchObject({ status: 'CONSUMED', approvalId: 'ap-1' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://identity:4001/trpc/actionApproval.consume');
    const h = init.headers as Record<string, string>;
    expect(h[SERVICE_HEADER]).toBe('svc-test');
    expect(h[SERVICE_SIGNATURE_HEADER]).toMatch(/\S/);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses a non-2xx reply with the caller error type', async () => {
    vi.stubGlobal('fetch', reply({ error: 'no' }, 403));
    await expect(client().consume(input)).rejects.toBeInstanceOf(TestError);
  });

  it.each([
    ['not consumed', { status: 'APPROVED' }],
    ['other approval', { approvalId: 'ap-2' }],
    ['other payload', { payloadHash: 'sha256:zzz' }],
    ['other target', { targetId: 'bank.y' }],
    ['other version', { expectedVersion: 'v2' }],
  ])('refuses a result that is %s', async (_n, over) => {
    vi.stubGlobal('fetch', reply({ result: { data: approval(over) } }));
    await expect(client().consume(input)).rejects.toMatchObject({ message: expect.stringContaining('does not match') });
  });

  it('refuses an ok reply that is not an action approval with the caller error type', async () => {
    vi.stubGlobal('fetch', reply({ result: { data: { ok: true } } }));
    await expect(client().consume(input)).rejects.toBeInstanceOf(TestError);
  });

  it('refuses an ok reply that is not JSON with the caller error type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>', { status: 200 })),
    );
    await expect(client().consume(input)).rejects.toBeInstanceOf(TestError);
  });

  it('gives up when identity hangs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal?.addEventListener('abort', () => rej(init.signal?.reason))),
      ),
    );
    await expect(client(20).consume(input)).rejects.toBeTruthy();
    expect(IDENTITY_CONSUME_TIMEOUT_MS).toBe(5000);
    expect(ACTION_APPROVAL_CONSUME_FAILED).toBe('action_approval.consume_failed');
  });
});
