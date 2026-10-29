import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { initTRPC } from '@trpc/server';
import { serviceAuthHeadersForBody } from './service-auth.js';
import { createEdgeContext } from './edge.js';
import { s2sFetch, s2sRequestHeaders, serviceCallSigner, verifyServiceRequest } from './service-auth-http.js';
import { createServiceSigner, createServiceVerifier, parseKeyring, type ServiceName } from './service-keys.js';
import { serviceProcedureFor, type Context } from './trpc.js';

const SECRET = 'a-shared-internal-secret-for-tests-0123456789';
function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    x: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
  };
}
const keys = new Map(['svc-agents', 'svc-trade'].map((svc) => [svc, pair()]));
const keyring = parseKeyring(JSON.stringify({ keys: [...keys].map(([svc, k]) => ({ kid: `${svc}.a`, svc, use: 's2s', x: k.x })) }));
const signer = (svc: ServiceName) => createServiceSigner({ service: svc, kid: `${svc}.a`, privateKey: keys.get(svc)!.privateKey, keyring });
// Boot second 0: most tests sign a call before they make its verifier, and a verifier refuses calls signed before the
// second it was made, so a call signed at x.999 s failed as `stale` once the clock ticked (#6085). That refusal has its
// own test in service-keys.test.ts.
const newVerifier = () => createServiceVerifier({ self: 'svc-academy', keyring, bootSecond: 0 });

const URL_ = new URL('http://svc-academy.internal/internal/curriculum?lang=en');
const BODY = JSON.stringify({ q: 1 });
const reqOf = (headers: Record<string, string>, over: Partial<{ method: string; url: string; body: string }> = {}) => ({
  method: over.method ?? 'POST',
  url: over.url ?? URL_.pathname + URL_.search,
  headers,
  body: over.body ?? BODY,
});
const v3 = (svc: ServiceName = 'svc-agents') => signer(svc).headers({ audience: 'svc-academy', method: 'POST', url: URL_, body: BODY });

describe('verifyServiceRequest', () => {
  it('accepts a key-signed call and names the caller from the key', () => {
    const r = verifyServiceRequest(reqOf(v3()), { verifier: newVerifier(), legacySecret: SECRET });
    expect(r).toEqual({ service: 'svc-agents', scheme: 'keypair', rejected: null });
  });

  it('still accepts the shared-secret call while both are allowed', () => {
    const headers = serviceAuthHeadersForBody('svc-agents', SECRET, BODY);
    expect(verifyServiceRequest(reqOf(headers), { verifier: newVerifier(), legacySecret: SECRET })).toMatchObject({
      service: 'svc-agents',
      scheme: 'shared',
    });
  });

  it('refuses the shared-secret call once keypair-only', () => {
    const headers = serviceAuthHeadersForBody('svc-agents', SECRET, BODY);
    expect(verifyServiceRequest(reqOf(headers), { verifier: newVerifier(), legacySecret: SECRET, mode: 'keypair' })).toEqual({
      service: null,
      scheme: null,
      rejected: 'legacy-refused',
    });
  });

  it('never falls back to the shared secret when a key-signed call fails', () => {
    const tampered = reqOf(v3(), { body: JSON.stringify({ q: 2 }) });
    const withBoth = {
      ...tampered,
      headers: { ...tampered.headers, ...serviceAuthHeadersForBody('svc-agents', SECRET, JSON.stringify({ q: 2 })) },
    };
    expect(verifyServiceRequest(withBoth, { verifier: newVerifier(), legacySecret: SECRET })).toEqual({
      service: null,
      scheme: null,
      rejected: 'body-mismatch',
    });
  });

  it('judges one request once, so reading the caller twice is not a replay', () => {
    const verifier = newVerifier();
    const req = reqOf(v3());
    const first = verifyServiceRequest(req, { verifier });
    expect(verifyServiceRequest(req, { verifier })).toEqual(first);
    expect(first.service).toBe('svc-agents');
  });

  it('reports no caller (not a refusal) for a request with no service credentials', () => {
    expect(verifyServiceRequest(reqOf({}), { verifier: newVerifier(), legacySecret: SECRET })).toEqual({
      service: null,
      scheme: null,
      rejected: null,
    });
  });

  it('refuses a key-signed call when the request does not carry method and url', () => {
    const { method: _m, url: _u, ...bare } = reqOf(v3());
    expect(verifyServiceRequest(bare, { verifier: newVerifier() })).toMatchObject({ service: null, rejected: 'malformed' });
  });
});

describe('s2sRequestHeaders and s2sFetch', () => {
  it('signs both forms while dual, and only the key form otherwise', () => {
    const dual = s2sRequestHeaders(
      signer('svc-agents'),
      { audience: 'svc-academy', method: 'POST', url: URL_, body: BODY },
      { legacySecret: SECRET },
    );
    expect(Object.keys(dual)).toEqual(expect.arrayContaining(['x-intafaced-s2s-sig', 'x-intafaced-service-sig']));
    const only = s2sRequestHeaders(signer('svc-agents'), { audience: 'svc-academy', method: 'POST', url: URL_, body: BODY });
    expect(Object.keys(only)).not.toContain('x-intafaced-service-sig');
  });

  it('sets content-type before signing so the signed context matches the wire', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    await s2sFetch(signer('svc-agents'), 'svc-academy', URL_, { method: 'POST', body: BODY }, { fetchImpl });
    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    const result = verifyServiceRequest(
      { method: 'POST', url: URL_.pathname + URL_.search, headers, body: BODY },
      { verifier: newVerifier() },
    );
    expect(result.service).toBe('svc-agents');
  });
});

describe('createEdgeContext with a service verifier', () => {
  const edgeSecret = 'an-edge-secret-for-tests-0123456789abcdef';
  const ctxFactory = () =>
    createEdgeContext({ secret: edgeSecret, serviceName: 'svc-academy', internalSecret: SECRET, serviceVerifier: newVerifier() });

  it('reports the key-verified caller on the context', () => {
    const ctx = ctxFactory()(reqOf(v3()));
    expect(ctx).toMatchObject({ service: 'svc-agents', serviceAuth: 'keypair' });
  });

  it('keeps accepting the shared-secret caller as a claim', () => {
    const ctx = ctxFactory()(reqOf(serviceAuthHeadersForBody('svc-agents', SECRET, BODY)));
    expect(ctx).toMatchObject({ service: 'svc-agents', serviceAuth: 'shared' });
  });

  it('gives a failed key-signed call no caller', () => {
    expect(ctxFactory()(reqOf(v3(), { method: 'GET' })).service).toBeNull();
  });
});

describe('serviceProcedureFor', () => {
  const t = initTRPC.context<Context>().create();
  const router = t.router({
    ping: serviceProcedureFor(['svc-agents']).query(() => 'ok'),
  });
  const ctx = (service: string | null, serviceAuth?: Context['serviceAuth']): Context => ({
    principal: null,
    service,
    ...(serviceAuth ? { serviceAuth } : {}),
    region: 'XX',
    requestId: 'r',
  });

  it('lets a listed caller in, refuses an unlisted one as forbidden and no caller as unauthorized', async () => {
    expect(await router.createCaller(ctx('svc-agents', 'keypair')).ping()).toBe('ok');
    await expect(router.createCaller(ctx('svc-trade', 'keypair')).ping()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(router.createCaller(ctx(null)).ping()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('treats a claimed (shared-secret) name as a caller only while it is on the list', async () => {
    expect(await router.createCaller(ctx('svc-agents', 'shared')).ping()).toBe('ok');
    await expect(router.createCaller(ctx('svc-trade', 'shared')).ping()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('serviceCallSigner', () => {
  const target = new URL('http://svc-academy.internal/trpc/post');
  const request = { method: 'POST', url: target, contentType: 'application/json' };
  const asRequest = (headers: Record<string, string>) => ({
    method: 'POST',
    url: target.pathname + target.search,
    headers: { 'content-type': 'application/json', ...headers },
    body: BODY,
  });

  it('signs with the shared secret alone when there is no signing key', () => {
    const sign = serviceCallSigner({ service: 'svc-agents', audience: 'svc-academy', legacySecret: SECRET });
    const headers = sign(BODY, request);
    expect(Object.keys(headers).some((h) => h.startsWith('x-intafaced-s2s-'))).toBe(false);
    expect(verifyServiceRequest(asRequest(headers), { verifier: newVerifier(), legacySecret: SECRET })).toMatchObject({
      service: 'svc-agents',
      scheme: 'shared',
    });
  });

  it('dual sends the key signature and the shared secret', () => {
    const sign = serviceCallSigner({
      service: 'svc-agents',
      audience: 'svc-academy',
      legacySecret: SECRET,
      s2s: { signer: signer('svc-agents'), mode: 'dual' },
    });
    const headers = sign(BODY, request);
    expect(headers['x-intafaced-s2s-sig']).toBeDefined();
    expect(headers['x-intafaced-service']).toBe('svc-agents');
    expect(verifyServiceRequest(asRequest(headers), { verifier: newVerifier(), legacySecret: SECRET })).toEqual({
      service: 'svc-agents',
      scheme: 'keypair',
      rejected: null,
    });
  });

  it('keypair sends the key signature only, and the receiver in keypair mode accepts it', () => {
    const sign = serviceCallSigner({
      service: 'svc-agents',
      audience: 'svc-academy',
      legacySecret: SECRET,
      s2s: { signer: signer('svc-agents'), mode: 'keypair' },
    });
    const headers = sign(BODY, request);
    expect(headers['x-intafaced-service']).toBeUndefined();
    expect(headers['x-intafaced-signature']).toBeUndefined();
    expect(verifyServiceRequest(asRequest(headers), { verifier: newVerifier(), legacySecret: SECRET, mode: 'keypair' })).toMatchObject({
      service: 'svc-agents',
      scheme: 'keypair',
    });
  });

  it('covers a forwarded principal: the same bytes verify, a swapped principal or region is refused', () => {
    const sign = serviceCallSigner({
      service: 'svc-agents',
      audience: 'svc-academy',
      legacySecret: SECRET,
      s2s: { signer: signer('svc-agents'), mode: 'keypair' },
    });
    const forwarded = { raw: '{"userId":"u1"}', signature: 'ed25519:sig-one', region: 'SG' };
    const wire = {
      'x-intafaced-principal': forwarded.raw,
      'x-intafaced-principal-sig': forwarded.signature,
      'x-intafaced-region': forwarded.region,
    };
    const headers = sign(BODY, { ...request, forwarded });
    const verifier = newVerifier();
    expect(verifyServiceRequest(asRequest({ ...headers, ...wire }), { verifier, mode: 'keypair' })).toMatchObject({
      service: 'svc-agents',
      scheme: 'keypair',
    });
    for (const swapped of [
      { 'x-intafaced-principal': '{"userId":"u2"}' },
      { 'x-intafaced-principal-sig': 'ed25519:sig-two' },
      { 'x-intafaced-region': 'US' },
    ]) {
      expect(
        verifyServiceRequest(asRequest({ ...sign(BODY, { ...request, forwarded }), ...wire, ...swapped }), {
          verifier: newVerifier(),
          mode: 'keypair',
        }),
      ).toMatchObject({
        service: null,
      });
    }
    // A call signed as the service itself cannot have a principal attached afterwards.
    expect(
      verifyServiceRequest(asRequest({ ...sign(BODY, request), ...wire }), { verifier: newVerifier(), mode: 'keypair' }),
    ).toMatchObject({ service: null });
  });

  it('signs each call afresh, so a retry is not a replay', () => {
    const sign = serviceCallSigner({
      service: 'svc-agents',
      audience: 'svc-academy',
      legacySecret: SECRET,
      s2s: { signer: signer('svc-agents'), mode: 'keypair' },
    });
    const verifier = newVerifier();
    expect(verifyServiceRequest(asRequest(sign(BODY, request)), { verifier, mode: 'keypair' }).service).toBe('svc-agents');
    expect(verifyServiceRequest(asRequest(sign(BODY, request)), { verifier, mode: 'keypair' }).service).toBe('svc-agents');
  });

  it('covers the content type: a different one at the receiver is refused', () => {
    const sign = serviceCallSigner({
      service: 'svc-agents',
      audience: 'svc-academy',
      legacySecret: SECRET,
      s2s: { signer: signer('svc-agents'), mode: 'keypair' },
    });
    const headers = sign(BODY, request);
    const tampered = { ...asRequest(headers), headers: { ...headers, 'content-type': 'text/plain' } };
    expect(verifyServiceRequest(tampered, { verifier: newVerifier(), mode: 'keypair' }).service).toBeNull();
  });
});
