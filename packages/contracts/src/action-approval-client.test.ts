import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTION_APPROVAL_CONSUME_FAILED,
  IDENTITY_CONSUME_TIMEOUT_MS,
  createIdentityApprovalClient,
  refusalDetail,
  unwrapTrpcData,
} from './action-approval-client.js';
import { createServiceSigner, createServiceVerifier, type Keyring } from './service-keys.js';
import { verifyServiceRequest, type ServiceAuthMode } from './service-auth-http.js';
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

  it("passes on only the first line of identity's error message, never its stack", async () => {
    const body = {
      error: {
        message: 'approval not found [action_approval.not_found]',
        code: -32004,
        data: {
          code: 'NOT_FOUND',
          httpStatus: 404,
          stack: 'TRPCError: approval not found\n    at toTrpc (file:///svc-identity/dist/x.js:82:15)',
        },
      },
    };
    vi.stubGlobal('fetch', reply(body, 404));
    const err = (await client()
      .consume(input)
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(TestError);
    expect(err.message).toBe('identity refused consume (404) approval not found [action_approval.not_found]');
    expect(err.message).not.toContain('at toTrpc');
    expect(refusalDetail('upstream unavailable')).toBe('upstream unavailable');
    expect(refusalDetail('[action_approval.expired] approval expired\nmore')).toBe('[action_approval.expired] approval expired');
    expect(refusalDetail('{"weird":true}')).toBe('');
    expect(refusalDetail('x'.repeat(400))).toHaveLength(301);
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

describe('createIdentityApprovalClient with a service key', () => {
  const keyed = () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
    const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
    const keyring: Keyring = [{ kid: 'svc-execution.a', svc: 'svc-execution', use: 's2s', x }];
    const signer = createServiceSigner({ service: 'svc-execution', kid: 'svc-execution.a', privateKey: pkcs8, keyring });
    return { signer, verifier: (self: 'svc-identity' | 'svc-ledger') => createServiceVerifier({ self, keyring, bootSecond: 0 }) };
  };
  const send = async (s2s?: { signer: ReturnType<typeof keyed>['signer']; mode: ServiceAuthMode }) => {
    const fetchSpy = reply({ result: { data: approval() } });
    vi.stubGlobal('fetch', fetchSpy);
    await createIdentityApprovalClient({
      service: 'svc-execution',
      baseUrl: 'http://identity:4001/',
      internalSecret: SECRET,
      fail: (m) => new TestError(m),
      s2s,
    }).consume(input);
    const [target, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    return { url: new URL(target), headers: init.headers as Record<string, string>, body: String(init.body) };
  };
  const judged = (
    s: { url: URL; headers: Record<string, string>; body: string },
    verifier: ReturnType<ReturnType<typeof keyed>['verifier']>,
    mode?: ServiceAuthMode,
    over: Partial<{ method: string; url: string; body: string }> = {},
  ) =>
    verifyServiceRequest(
      { method: over.method ?? 'POST', url: over.url ?? s.url.pathname + s.url.search, headers: s.headers, body: over.body ?? s.body },
      { verifier, legacySecret: SECRET, mode },
    );
  afterEach(() => vi.unstubAllGlobals());

  it('without s2s the headers are the shared-secret ones, unchanged', async () => {
    const k = keyed();
    const sent = await send();
    expect(Object.keys(sent.headers).some((h) => h.startsWith('x-intafaced-s2s-'))).toBe(false);
    expect(judged(sent, k.verifier('svc-identity'))).toMatchObject({ service: 'svc-execution', scheme: 'shared' });
  });

  it('dual sends both the key signature and the shared secret', async () => {
    const k = keyed();
    const sent = await send({ signer: k.signer, mode: 'dual' });
    expect(sent.headers[SERVICE_HEADER]).toBe('svc-execution');
    expect(Object.keys(sent.headers).some((h) => h.startsWith('x-intafaced-s2s-'))).toBe(true);
    expect(judged(sent, k.verifier('svc-identity'))).toEqual({ service: 'svc-execution', scheme: 'keypair', rejected: null });
  });

  it('keypair sends the key signature only, and the contracts verifier accepts it', async () => {
    const k = keyed();
    const sent = await send({ signer: k.signer, mode: 'keypair' });
    expect(sent.headers[SERVICE_HEADER]).toBeUndefined();
    expect(sent.headers[SERVICE_SIGNATURE_HEADER]).toBeUndefined();
    expect(judged(sent, k.verifier('svc-identity'), 'keypair')).toMatchObject({ service: 'svc-execution', scheme: 'keypair' });
  });

  it('the key signature binds audience, path, body and method: a moved call is refused', async () => {
    const k = keyed();
    const sent = await send({ signer: k.signer, mode: 'keypair' });
    expect(judged(sent, k.verifier('svc-ledger'), 'keypair')).toMatchObject({ service: null });
    expect(judged(sent, k.verifier('svc-identity'), 'keypair', { url: '/trpc/actionApproval.get' })).toMatchObject({ service: null });
    expect(judged(sent, k.verifier('svc-identity'), 'keypair', { body: sent.body.replace('op-1', 'op-2') })).toMatchObject({
      service: null,
    });
    expect(judged(sent, k.verifier('svc-identity'), 'keypair', { method: 'GET' })).toMatchObject({ service: null });
  });
});
