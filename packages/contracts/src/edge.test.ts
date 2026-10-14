import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import {
  createEdgeContext,
  encodePrincipal,
  signPrincipalHeader,
  verifyForwardedPrincipal,
  EdgeTrustError,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  type EdgeRequest,
} from './edge.js';
import { retainRawBody, type RawBodyHost } from './raw-body.js';
import { serviceAuthHeaders, serviceAuthHeadersForBody } from './service-auth.js';

const SECRET = 'a'.repeat(32);
const OTHER_SECRET = 'b'.repeat(32);

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: '11111111-1111-4111-8111-111111111111',
    userId: '11111111-1111-4111-8111-111111111111',
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function forward(p: Principal, secret = SECRET, region = 'XX'): { raw: string; sig: string } {
  const raw = encodePrincipal(p);
  return { raw, sig: signPrincipalHeader(raw, secret, region) };
}

describe('edge principal — the happy path', () => {
  it('accepts a correctly signed principal and preserves every claim', () => {
    const p = principal({ scopes: ['trade:read', 'trade:write'], tier: 'full', mfa: true });
    const { raw, sig } = forward(p);

    const { principal: got, rejected } = verifyForwardedPrincipal(raw, sig, SECRET);

    expect(rejected).toBeNull();
    expect(got).not.toBeNull();
    expect(got?.userId).toBe(p.userId);
    expect(got?.scopes).toEqual(['trade:read', 'trade:write']);
    expect(got?.tier).toBe('full');
    expect(got?.mfa).toBe(true);
    expect(got?.sid).toBe(p.sid);
    expect(got?.expiresAt.toISOString()).toBe(p.expiresAt.toISOString());
  });

  it('treats an absent header as anonymous rather than as a rejection', () => {
    expect(verifyForwardedPrincipal(undefined, undefined, SECRET)).toEqual({ principal: null, rejected: null });
  });
});

describe('edge principal — forgery', () => {
  it('refuses an unsigned principal', () => {
    const raw = encodePrincipal(principal({ scopes: ['admin:treasury'] }));

    expect(verifyForwardedPrincipal(raw, undefined, SECRET)).toEqual({
      principal: null,
      rejected: 'bad-signature',
    });
  });

  it('refuses a principal signed with the wrong secret', () => {
    const { raw, sig } = forward(principal(), OTHER_SECRET);

    expect(verifyForwardedPrincipal(raw, sig, SECRET).principal).toBeNull();
  });

  // The attack this whole module exists to stop: reach the port, claim to be
  // someone else with treasury scope and MFA already satisfied.
  it('refuses a self-escalated principal replayed under a captured signature', () => {
    const honest = principal({ scopes: ['trade:read'], mfa: false });
    const { sig } = forward(honest);

    const escalated = encodePrincipal(principal({ scopes: ['admin:treasury', 'trade:withdraw'], mfa: true, tier: 'institutional' }));

    const { principal: got, rejected } = verifyForwardedPrincipal(escalated, sig, SECRET);

    expect(got).toBeNull();
    expect(rejected).toBe('bad-signature');
  });

  it('refuses a single flipped byte in the payload', () => {
    const { raw, sig } = forward(principal());
    const tampered = raw.replace('"tier":"basic"', '"tier":"full"');

    expect(tampered).not.toBe(raw);
    expect(verifyForwardedPrincipal(tampered, sig, SECRET).principal).toBeNull();
  });

  it('refuses non-hex, empty, and truncated signatures without throwing', () => {
    const { raw, sig } = forward(principal());

    for (const bad of ['', 'zz', 'not-hex-at-all', sig.slice(0, -1), sig.slice(0, 32), `${sig}00`]) {
      expect(() => verifyForwardedPrincipal(raw, bad, SECRET)).not.toThrow();
      expect(verifyForwardedPrincipal(raw, bad, SECRET).principal).toBeNull();
    }
  });

  it('refuses a signature that is valid hex of the right length but wrong value', () => {
    const { raw, sig } = forward(principal());
    const wrong = sig[0] === '0' ? `1${sig.slice(1)}` : `0${sig.slice(1)}`;

    expect(wrong).toHaveLength(sig.length);
    expect(verifyForwardedPrincipal(raw, wrong, SECRET).principal).toBeNull();
  });

  it('refuses malformed JSON even when correctly signed', () => {
    const raw = '{"userId": broken';

    expect(verifyForwardedPrincipal(raw, signPrincipalHeader(raw, SECRET), SECRET)).toEqual({
      principal: null,
      rejected: 'malformed',
    });
  });

  it('refuses a correctly signed payload that is not a principal', () => {
    // The edge is trusted to be honest, not to be bug-free. A signed value of
    // the wrong shape must not reach a scope check half-formed.
    for (const value of ['{}', '[]', 'null', '"admin"', '{"userId":"not-a-uuid","scopes":[]}']) {
      const result = verifyForwardedPrincipal(value, signPrincipalHeader(value, SECRET), SECRET);
      expect(result.principal).toBeNull();
      expect(result.rejected).toBe('malformed');
    }
  });
});

describe('edge principal — expiry', () => {
  it('refuses a signed but expired principal', () => {
    const p = principal({ expiresAt: new Date(Date.now() - 1) });
    const { raw, sig } = forward(p);

    expect(verifyForwardedPrincipal(raw, sig, SECRET)).toEqual({ principal: null, rejected: 'expired' });
  });

  it('refuses at exactly the expiry instant, not one tick after', () => {
    const at = new Date('2026-07-27T12:00:00.000Z');
    const { raw, sig } = forward(principal({ expiresAt: at }));

    expect(verifyForwardedPrincipal(raw, sig, SECRET, at).rejected).toBe('expired');
    expect(verifyForwardedPrincipal(raw, sig, SECRET, new Date(at.getTime() - 1)).principal).not.toBeNull();
  });
});

describe('createEdgeContext', () => {
  it('refuses to build without a secret, at boot rather than per request', () => {
    expect(() => createEdgeContext({ secret: '', serviceName: 'svc-test' })).toThrow(EdgeTrustError);
    expect(() => createEdgeContext({ secret: 'short', serviceName: 'svc-test' })).toThrow(/at least 32/);
  });

  it('names the service in the failure so an operator knows which one will not start', () => {
    expect(() => createEdgeContext({ secret: '', serviceName: 'svc-ledger' })).toThrow(/svc-ledger/);
  });

  // A present service-to-service secret shorter than 32 characters is the same
  // offline-guessable HMAC as a short principal secret. Boot must refuse it,
  // including svc-ledger, so the context never mounts and the short secret is
  // never handed to verifyServiceHeaders. Omitting the secret stays optional.
  it('refuses a present internal secret shorter than 32 characters and does not mount, including svc-ledger', () => {
    expect(() => createEdgeContext({ secret: SECRET, serviceName: 'svc-ledger', internalSecret: 'short' })).toThrow(EdgeTrustError);
    expect(() => createEdgeContext({ secret: SECRET, serviceName: 'svc-ledger', internalSecret: 'short' })).toThrow(/svc-ledger/);
    expect(() => createEdgeContext({ secret: SECRET, serviceName: 'svc-ledger', internalSecret: 'c'.repeat(31) })).toThrow(/at least 32/);
  });

  it('puts a verified principal on the context', () => {
    const ctx = createEdgeContext({ secret: SECRET, serviceName: 'svc-test' });
    const { raw, sig } = forward(principal(), SECRET, 'GB');

    const built = ctx({
      headers: { [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: sig, 'x-intafaced-region': 'GB' },
      id: 'req-1',
    });

    expect(built.principal?.userId).toBe(principal().userId);
    expect(built.region).toBe('GB');
    expect(built.requestId).toBe('req-1');
  });

  it('L2-4: rejects when region header does not match the signed region', () => {
    const ctx = createEdgeContext({ secret: SECRET, serviceName: 'svc-test' });
    const { raw, sig } = forward(principal(), SECRET, 'GB');

    const built = ctx({
      headers: { [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: sig, 'x-intafaced-region': 'US' },
      id: 'req-2',
    });

    expect(built.principal).toBeNull();
  });

  it('yields an anonymous context — not an error — when the principal is forged', () => {
    const ctx = createEdgeContext({ secret: SECRET, serviceName: 'svc-test' });
    const { raw } = forward(principal({ scopes: ['admin:treasury'] }), OTHER_SECRET);

    const built = ctx({ headers: { [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: 'deadbeef' }, id: 1 });

    // Anonymous, so `protectedProcedure` throws UNAUTHORIZED at the procedure
    // rather than the transport 500-ing and telling an attacker they got close.
    expect(built.principal).toBeNull();
  });

  it('defaults region to XX so a missing header cannot silently widen jurisdiction', () => {
    const ctx = createEdgeContext({ secret: SECRET, serviceName: 'svc-test' });

    expect(ctx({ headers: {} }).region).toBe('XX');
  });

  it('takes the first value when a header is sent twice', () => {
    const ctx = createEdgeContext({ secret: SECRET, serviceName: 'svc-test' });
    const { raw, sig } = forward(principal());

    const built = ctx({ headers: { [EDGE_PRINCIPAL_HEADER]: [raw, 'x'], [EDGE_SIGNATURE_HEADER]: [sig, 'y'] } });

    expect(built.principal).not.toBeNull();
  });

  // S13-6: a service caller and a user principal are independent. Omitting
  // internalSecret must not invent a service identity from serviceName or
  // from an unsigned header — otherwise every public request looks like S2S.
  it('omitting internalSecret yields service:null rather than inventing a service identity', () => {
    const ctx = createEdgeContext({ secret: SECRET, serviceName: 'svc-test' });

    expect(ctx({ headers: {} }).service).toBeNull();
    expect(ctx({ headers: { 'x-intafaced-service': 'svc-ledger' } }).service).toBeNull();
  });

  // verifyServiceHeaders fails closed on missing credentials (service:null,
  // rejected:'missing'). Wiring it when the secret IS set must not 500 a
  // public request and tell an attacker they got close.
  it('with internalSecret set but no S2S headers, service is still null rather than a 500', () => {
    const ctx = createEdgeContext({ secret: SECRET, serviceName: 'svc-test', internalSecret: OTHER_SECRET });

    expect(() => ctx({ headers: {} })).not.toThrow();
    expect(ctx({ headers: {} }).service).toBeNull();
  });
});

const S2S_BODY = JSON.stringify({ amount: '10.000000000000000001' });

/** Same object `retainRawBody` keys, so `rawBodyOf` inside createEdgeContext sees the bytes. */
function retainedEdgeRequest(headers: Record<string, string | string[] | undefined>, body: string): EdgeRequest {
  const parsers: RawBodyHost['addContentTypeParser'] extends (
    contentType: string,
    options: { parseAs: 'buffer' },
    handler: infer H,
  ) => unknown
    ? H[]
    : never = [];
  const hooks: RawBodyHost['addHook'] extends (name: 'onRequest', hook: infer H) => unknown ? H[] : never = [];
  const host: RawBodyHost = {
    addContentTypeParser(_contentType, _options, handler) {
      parsers.push(handler);
      return undefined;
    },
    addHook(_name, h) {
      hooks.push(h);
      return undefined;
    },
  };
  retainRawBody(host);
  const req: EdgeRequest = { headers };
  for (const onRequest of hooks) onRequest(req, {}, () => undefined);
  for (const parse of parsers) parse(req, Buffer.from(body, 'utf8'), () => undefined);
  return req;
}

describe('createEdgeContext — S2S body bind (tRPC HMAC)', () => {
  it('refuses a valid v2 signature replayed over a mutated tRPC body when bytes were retained', () => {
    const headers = serviceAuthHeadersForBody('svc-trade', OTHER_SECRET, S2S_BODY);
    const tampered = S2S_BODY.replace('10.000000000000000001', '99999.000000000000000001');
    expect(tampered).not.toBe(S2S_BODY);

    for (const bodyBindMode of ['accept-both', 'require'] as const) {
      const ctx = createEdgeContext({
        secret: SECRET,
        serviceName: 'svc-test',
        internalSecret: OTHER_SECRET,
        bodyBindMode,
      });
      expect(ctx(retainedEdgeRequest(headers, tampered)).service).toBeNull();
    }
  });

  it('accepts v2 over the exact retained bytes, including under require', () => {
    const headers = serviceAuthHeadersForBody('svc-trade', OTHER_SECRET, S2S_BODY);
    const ctx = createEdgeContext({
      secret: SECRET,
      serviceName: 'svc-test',
      internalSecret: OTHER_SECRET,
      bodyBindMode: 'require',
    });

    expect(ctx(retainedEdgeRequest(headers, S2S_BODY)).service).toBe('svc-trade');
  });

  // Was: "accept-both (default) still admits v2 when the request was not retained".
  // That encoded the hole: the tRPC edge context defaulted to accept-both, so an
  // authentic v2 signature (e.g. the digest of the EMPTY body, replayed) was a
  // service for any body. The tRPC door now defaults to require.
  it('defaults to require: v2 without retained bytes is refused (body-unavailable)', () => {
    const headers = serviceAuthHeadersForBody('svc-trade', OTHER_SECRET, S2S_BODY);
    const ctx = createEdgeContext({ secret: SECRET, serviceName: 'svc-test', internalSecret: OTHER_SECRET });

    expect(ctx({ headers }).service).toBeNull();
  });

  it('accept-both stays reachable as an explicit downgrade and still admits unretained v2', () => {
    const headers = serviceAuthHeadersForBody('svc-trade', OTHER_SECRET, S2S_BODY);
    const ctx = createEdgeContext({
      secret: SECRET,
      serviceName: 'svc-test',
      internalSecret: OTHER_SECRET,
      bodyBindMode: 'accept-both',
    });

    expect(ctx({ headers }).service).toBe('svc-trade');
  });

  it('require refuses v2 when bytes were not retained (body-unavailable)', () => {
    const headers = serviceAuthHeadersForBody('svc-trade', OTHER_SECRET, S2S_BODY);
    const ctx = createEdgeContext({
      secret: SECRET,
      serviceName: 'svc-test',
      internalSecret: OTHER_SECRET,
      bodyBindMode: 'require',
    });

    expect(ctx({ headers }).service).toBeNull();
  });

  // Was: "accept-both still admits a legacy v1 caller" under the default. The tRPC
  // door has no v1 callers (every outbound client signs v2), so the default now
  // refuses an unbound v1 signature; accept-both is the explicit downgrade.
  it('defaults to require: a legacy v1 caller (unbound signature) is refused', () => {
    const headers = serviceAuthHeaders('svc-trade', OTHER_SECRET);
    const ctx = createEdgeContext({ secret: SECRET, serviceName: 'svc-test', internalSecret: OTHER_SECRET });

    expect(ctx({ headers }).service).toBeNull();
  });

  it('accept-both still admits a legacy v1 caller when explicitly chosen', () => {
    const headers = serviceAuthHeaders('svc-trade', OTHER_SECRET);
    const ctx = createEdgeContext({
      secret: SECRET,
      serviceName: 'svc-test',
      internalSecret: OTHER_SECRET,
      bodyBindMode: 'accept-both',
    });

    expect(ctx({ headers }).service).toBe('svc-trade');
  });

  // The tRPC Fastify plugin replaces the JSON parser in its scope with
  // parseAs:'string', so retainRawBody's parser never runs; the onRequest marker
  // still does. These model that request: marker set, wire text on req.body.
  describe('tRPC adapter request (marker set, body as the wire string)', () => {
    function adapterRequest(headers: Record<string, string>, body: string | undefined): EdgeRequest {
      const hooks: Array<(req: object, reply: unknown, done: () => void) => void> = [];
      retainRawBody({
        addContentTypeParser: () => undefined,
        addHook: (_name, hook) => {
          hooks.push(hook);
          return undefined;
        },
      });
      const req: EdgeRequest = {
        headers: { ...headers, ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }) },
        ...(body === undefined ? {} : { body }),
      };
      for (const hook of hooks) hook(req, {}, () => undefined);
      return req;
    }
    const ctx = () => createEdgeContext({ secret: SECRET, serviceName: 'svc-test', internalSecret: OTHER_SECRET });

    it('accepts an honest v2 call signed over the exact wire text', () => {
      const headers = serviceAuthHeadersForBody('svc-trade', OTHER_SECRET, S2S_BODY);
      expect(ctx()(adapterRequest(headers, S2S_BODY)).service).toBe('svc-trade');
    });

    it('refuses an EMPTY-body signature replayed against an attacker body', () => {
      const headers = serviceAuthHeadersForBody('svc-edge', OTHER_SECRET, '');
      expect(ctx()(adapterRequest(headers, S2S_BODY)).service).toBeNull();
    });

    it('refuses a body altered after signing', () => {
      const headers = serviceAuthHeadersForBody('svc-trade', OTHER_SECRET, S2S_BODY);
      const altered = S2S_BODY.replace('10.', '99.');
      expect(ctx()(adapterRequest(headers, altered)).service).toBeNull();
    });

    it('refuses a marked request that announced a body nobody kept, in both modes', () => {
      const headers = serviceAuthHeadersForBody('svc-edge', OTHER_SECRET, '');
      for (const bodyBindMode of ['accept-both', 'require'] as const) {
        const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-test', internalSecret: OTHER_SECRET, bodyBindMode });
        const req = adapterRequest(headers, undefined);
        req.headers['content-length'] = '40';
        expect(edge(req).service).toBeNull();
      }
    });

    it('still accepts an honest bodyless call signed over the empty body', () => {
      const headers = serviceAuthHeadersForBody('svc-edge', OTHER_SECRET, '');
      expect(ctx()(adapterRequest(headers, undefined)).service).toBe('svc-edge');
    });
  });
});
