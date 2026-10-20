import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createServiceSigner,
  createServiceVerifier,
  verifyServiceRequest,
  type Keyring,
  type ServiceAuthMode,
  type ServiceName,
} from '@intafaced/contracts';
import { stripReserved } from './principal-exchange.js';
import { proxyAudience, signProxyHeaders, type EdgeS2s } from './s2s.js';

/**
 * The proxy forward: with svc-edge's own key, every forwarded request carries a signature over the exact method, the
 * upstream path and query, the body bytes and the content type, and the principal headers it forwards are inside the
 * signed context. The receiver here is the contracts verifier, fed the request as it would go on the wire.
 * Keys are generated per run.
 */
function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const keyring: Keyring = [{ kid: 'svc-edge.a', svc: 'svc-edge', use: 's2s', x }];
  const signer = createServiceSigner({ service: 'svc-edge', kid: 'svc-edge.a', privateKey: pkcs8, keyring });
  return {
    s2s: (mode: ServiceAuthMode): EdgeS2s => ({ signer, mode }),
    verifier: (self: ServiceName) => createServiceVerifier({ self, keyring, bootSecond: 0 }),
  };
}

const URL_TRADE = 'http://trade.test/trpc/orders.create?x=1&y=%20z';
const principalHeaders = {
  'x-intafaced-principal': 'eyJ1c2VyIjoiYSJ9',
  'x-intafaced-principal-sig': 'ed25519:c2ln',
  'x-intafaced-region': 'DE',
  'content-type': 'application/json',
  'x-forwarded-for': '203.0.113.9',
};

type Wire = { method: string; url: string; headers: Record<string, string>; body: Buffer | string | undefined };
const wire = (over: Partial<Wire> = {}): Wire => ({
  method: 'POST',
  url: URL_TRADE,
  headers: { ...principalHeaders },
  body: Buffer.from('{"amount":"1.50"}'),
  ...over,
});

type Kit = ReturnType<typeof keys>;
const accepted = (k: Kit, w: Wire, headers: Record<string, string>, self: ServiceName, verifier = k.verifier(self)) => {
  const url = new URL(w.url);
  return verifyServiceRequest(
    { method: w.method, url: url.pathname + url.search, headers, body: w.body ?? '' },
    { verifier, mode: 'keypair' },
  );
};

describe('the proxy forward is signed with the edge key', () => {
  it('unset, or for a module with no S2S role, the headers are returned untouched', () => {
    const w = wire();
    expect(signProxyHeaders(undefined, 'trade', w)).toBe(w.headers);
    const k = keys();
    for (const module of ['blueprint', 'dex', 'indexer', 'protocol', 'unknown']) {
      expect(proxyAudience(module)).toBeUndefined();
      expect(signProxyHeaders(k.s2s('dual'), module, w)).toBe(w.headers);
    }
  });

  it('signs for the service behind the module, and only that service accepts it', () => {
    const k = keys();
    const w = wire();
    const headers = signProxyHeaders(k.s2s('keypair'), 'trade', w);
    expect(headers['x-intafaced-s2s-aud']).toBe('svc-trade');
    expect(accepted(k, w, headers, 'svc-trade')).toEqual({ service: 'svc-edge', scheme: 'keypair', rejected: null });
    expect(accepted(k, w, headers, 'svc-bank')).toMatchObject({ service: null, rejected: 'wrong-audience' });
    // The headers the receiver also reads are kept as they were.
    for (const [name, value] of Object.entries(principalHeaders)) expect(headers[name]).toBe(value);
    expect(headers['x-intafaced-service']).toBeUndefined();
  });

  it('dual and keypair both send the key signature alone, since the edge holds no shared secret for upstreams', () => {
    const k = keys();
    const dual = signProxyHeaders(k.s2s('dual'), 'trade', wire());
    expect(Object.keys(dual).filter((h) => h.startsWith('x-intafaced-s2s-'))).toHaveLength(6);
    expect(dual['x-intafaced-signature']).toBeUndefined();
  });

  it('maps every proxied module to a real service name', () => {
    const modules = [
      ['identity', 'svc-identity'],
      ['trade', 'svc-trade'],
      ['token', 'svc-token'],
      ['agents', 'svc-agents'],
      ['bank', 'svc-bank'],
      ['p2p', 'svc-p2p'],
      ['pay', 'svc-pay'],
      ['notify', 'svc-notify'],
      ['academy', 'svc-academy'],
      ['mining-pool', 'svc-mining-pool'],
      ['support', 'svc-support'],
      ['market', 'svc-market'],
      ['execution', 'svc-execution'],
      ['tax', 'svc-tax'],
      ['quant', 'svc-quant'],
      ['core-ops', 'svc-ops'],
    ] as const;
    for (const [module, service] of modules) expect(proxyAudience(module)).toBe(service);
  });

  it('refuses a changed method, path, query, body or content type', () => {
    const k = keys();
    const w = wire();
    const headers = signProxyHeaders(k.s2s('keypair'), 'trade', w);
    const refused = (over: Partial<Wire>, h = headers) => accepted(k, { ...w, ...over }, h, 'svc-trade').service;
    expect(refused({})).toBe('svc-edge');
    expect(refused({ method: 'PUT' })).toBeNull();
    expect(refused({ url: 'http://trade.test/trpc/orders.cancel?x=1&y=%20z' })).toBeNull();
    expect(refused({ url: 'http://trade.test/trpc/orders.create?x=2&y=%20z' })).toBeNull();
    expect(refused({ body: Buffer.from('{"amount":"150"}') })).toBeNull();
    expect(refused({}, { ...headers, 'content-type': 'text/plain' })).toBeNull();
  });

  it('keeps the forwarded principal, its signature and the region inside the signed context', () => {
    const k = keys();
    const w = wire();
    const headers = signProxyHeaders(k.s2s('keypair'), 'trade', w);
    for (const name of ['x-intafaced-principal', 'x-intafaced-principal-sig', 'x-intafaced-region']) {
      expect(accepted(k, w, { ...headers, [name]: `${headers[name]}x` }, 'svc-trade').service).toBeNull();
      const without = { ...headers };
      delete without[name];
      expect(accepted(k, w, without, 'svc-trade').service).toBeNull();
    }
    expect(accepted(k, w, headers, 'svc-trade').service).toBe('svc-edge');
  });

  it('signs the exact body bytes, including bytes that are not valid text', () => {
    const k = keys();
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x7b]);
    const w = wire({ body: bytes, headers: { ...principalHeaders, 'content-type': 'application/octet-stream' } });
    const headers = signProxyHeaders(k.s2s('keypair'), 'pay', w);
    expect(accepted(k, w, headers, 'svc-pay').service).toBe('svc-edge');
    expect(accepted(k, { ...w, body: Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x7c]) }, headers, 'svc-pay').service).toBeNull();
  });

  it('signs a bodyless GET, and a string body that has no content type as fetch will send it', () => {
    const k = keys();
    const get = wire({ method: 'GET', body: undefined, url: 'http://bank.test/trpc/accounts.list?limit=5' });
    const headers = signProxyHeaders(k.s2s('keypair'), 'bank', get);
    expect(accepted(k, get, headers, 'svc-bank').service).toBe('svc-edge');
    expect(accepted(k, { ...get, url: 'http://bank.test/trpc/accounts.list?limit=500' }, headers, 'svc-bank').service).toBeNull();

    const text = wire({ body: 'hello', headers: { 'x-intafaced-region': 'DE' } });
    const signed = signProxyHeaders(k.s2s('keypair'), 'bank', text);
    expect(signed['content-type']).toBe('text/plain;charset=UTF-8');
    expect(accepted(k, text, signed, 'svc-bank').service).toBe('svc-edge');
  });

  it('a signed forward cannot be replayed', () => {
    const k = keys();
    const w = wire();
    const headers = signProxyHeaders(k.s2s('keypair'), 'trade', w);
    const verifier = k.verifier('svc-trade');
    expect(accepted(k, w, headers, 'svc-trade', verifier).service).toBe('svc-edge');
    expect(accepted(k, w, headers, 'svc-trade', verifier)).toMatchObject({ service: null, rejected: 'replay' });
  });

  it('a browser cannot bring its own service signature: every x-intafaced-* header is stripped', () => {
    const stripped = stripReserved({
      'x-intafaced-s2s-kid': 'svc-trade.a',
      'X-Intafaced-S2S-Signature': 'sig',
      'x-intafaced-service': 'svc-ledger',
      'x-intafaced-signature': 'sig',
      accept: 'application/json',
    });
    expect(stripped).toEqual({ accept: 'application/json' });
  });
});
