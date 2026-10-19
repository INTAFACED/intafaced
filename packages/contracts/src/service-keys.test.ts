import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { serviceBodyDigest } from './service-auth.js';
import {
  createNonceCache,
  createServiceSigner,
  createServiceVerifier,
  parseKeyring,
  type Keyring,
  type ServiceName,
} from './service-keys.js';

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    x: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
  };
}

const NOW = new Date('2026-10-19T12:00:00.000Z');
const URL_POST = new URL('http://svc-ledger.internal/trpc/post?batch=1');
const BODY = JSON.stringify({ amount: '1.00' });

function kit(services: ServiceName[] = ['svc-trade', 'svc-agents']) {
  const keys = services.map((svc) => ({ svc, ...pair() }));
  const keyring: Keyring = keys.map((k) => ({ kid: `${k.svc}.a`, svc: k.svc, use: 's2s' as const, x: k.x }));
  const signer = (svc: ServiceName) =>
    createServiceSigner({
      service: svc,
      kid: `${svc}.a`,
      privateKey: keys.find((k) => k.svc === svc)!.privateKey,
      keyring,
      now: () => NOW,
    });
  const verifier = (over: Partial<Parameters<typeof createServiceVerifier>[0]> = {}) =>
    createServiceVerifier({ self: 'svc-ledger', keyring, now: () => NOW, ...over });
  return { keys, keyring, signer, verifier };
}

const request = (headers: Record<string, string>, over: { method?: string; url?: URL; body?: string } = {}) => ({
  method: over.method ?? 'POST',
  url: (over.url ?? URL_POST).pathname + (over.url ?? URL_POST).search,
  headers,
  rawBody: { retained: true as const, bytes: Buffer.from(over.body ?? BODY) },
});

const signed = (k: ReturnType<typeof kit>, svc: ServiceName = 'svc-trade', context = {}) =>
  k.signer(svc).headers({ audience: 'svc-ledger', method: 'POST', url: URL_POST, body: BODY, context });

describe('parseKeyring', () => {
  const good = { kid: 'svc-trade.a', svc: 'svc-trade', use: 's2s', x: pair().x };
  const parse = (...keys: object[]) => parseKeyring(JSON.stringify({ keys }));

  it('accepts a well-formed public keyring', () => {
    expect(parse(good)).toEqual([good]);
  });

  it('refuses private material, bad keys, bad ids, unknown services and too many keys', () => {
    expect(() => parse({ ...good, d: 'secret' })).toThrow();
    expect(() => parse({ ...good, x: 'AAAA' })).toThrow();
    expect(() => parse({ ...good, x: `${good.x}=` })).toThrow();
    expect(() => parse({ ...good, kid: 'svc-pay.a' })).toThrow();
    expect(() => parse({ ...good, kid: 'svc-trade' })).toThrow();
    expect(() => parse({ ...good, svc: 'svc-nope', kid: 'svc-nope.a' })).toThrow();
    expect(() => parse({ ...good, use: 'other' })).toThrow();
    expect(() => parse(good, { ...good, x: pair().x })).toThrow();
    expect(() => parse(good, { ...good, kid: 'svc-trade.b', x: pair().x }, { ...good, kid: 'svc-trade.c', x: pair().x })).toThrow();
    expect(() => parseKeyring('not json')).toThrow();
  });
});

describe('createServiceSigner', () => {
  it('refuses a private key that does not match the keyring entry for its service', () => {
    const k = kit();
    expect(() =>
      createServiceSigner({ service: 'svc-trade', kid: 'svc-trade.a', privateKey: pair().privateKey, keyring: k.keyring }),
    ).toThrow();
    expect(() =>
      createServiceSigner({ service: 'svc-pay', kid: 'svc-trade.a', privateKey: k.keys[0]!.privateKey, keyring: k.keyring }),
    ).toThrow();
  });

  it('produces six strict headers with a fresh nonce each time', () => {
    const k = kit();
    const a = signed(k);
    const b = signed(k);
    expect(Object.keys(a).sort()).toEqual([
      'x-intafaced-s2s-aud',
      'x-intafaced-s2s-body',
      'x-intafaced-s2s-kid',
      'x-intafaced-s2s-nonce',
      'x-intafaced-s2s-sig',
      'x-intafaced-s2s-ts',
    ]);
    expect(a['x-intafaced-s2s-body']).toBe(serviceBodyDigest(BODY));
    expect(a['x-intafaced-s2s-nonce']).not.toBe(b['x-intafaced-s2s-nonce']);
  });
});

describe('createServiceVerifier', () => {
  it('names the caller from the key that verified, and refuses an exact replay', () => {
    const k = kit();
    const v = k.verifier();
    const h = signed(k);
    expect(v.verify(request(h))).toEqual({ status: 'accepted', service: 'svc-trade', kid: 'svc-trade.a' });
    expect(v.verify(request(h))).toEqual({ status: 'rejected', reason: 'replay' });
  });

  it('reports absent when the request carries no v3 header at all', () => {
    expect(
      kit()
        .verifier()
        .verify(request({ 'content-type': 'application/json' })),
    ).toEqual({ status: 'absent' });
  });

  it('refuses a caller that claims another service name, and a wrong audience', () => {
    const k = kit();
    const h = { ...signed(k, 'svc-agents'), 'x-intafaced-s2s-kid': 'svc-trade.a' };
    expect(k.verifier().verify(request(h))).toMatchObject({ status: 'rejected', reason: 'bad-signature' });
    const other = k.signer('svc-trade').headers({ audience: 'svc-identity', method: 'POST', url: URL_POST, body: BODY });
    expect(k.verifier().verify(request(other))).toEqual({ status: 'rejected', reason: 'wrong-audience' });
  });

  it('refuses an unknown key id', () => {
    const k = kit();
    const h = { ...signed(k), 'x-intafaced-s2s-kid': 'svc-pay.a' };
    expect(k.verifier().verify(request(h))).toEqual({ status: 'rejected', reason: 'unknown-key' });
  });

  it('refuses a changed method, path, query or body', () => {
    const k = kit();
    const h = signed(k);
    expect(k.verifier().verify(request(h, { method: 'GET' }))).toMatchObject({ reason: 'bad-signature' });
    expect(k.verifier().verify(request(h, { url: new URL('http://x/trpc/other?batch=1') }))).toMatchObject({ reason: 'bad-signature' });
    expect(k.verifier().verify(request(h, { url: new URL('http://x/trpc/post?batch=2') }))).toMatchObject({ reason: 'bad-signature' });
    expect(k.verifier().verify(request(h, { body: JSON.stringify({ amount: '9.00' }) }))).toMatchObject({ reason: 'body-mismatch' });
    expect(k.verifier().verify({ ...request(h), rawBody: { retained: false } })).toEqual({
      status: 'rejected',
      reason: 'body-unavailable',
    });
  });

  it('binds the principal, region and content type to the hop', () => {
    const k = kit();
    const context = { principal: 'p', principalSignature: 's', region: 'DE', contentType: 'application/json' };
    const h = signed(k, 'svc-trade', context);
    const wire = {
      'x-intafaced-principal': 'p',
      'x-intafaced-principal-sig': 's',
      'x-intafaced-region': 'DE',
      'content-type': 'application/json',
    };
    expect(k.verifier().verify(request({ ...h, ...wire }))).toMatchObject({ status: 'accepted' });
    for (const change of [
      { 'x-intafaced-principal': 'other' },
      { 'x-intafaced-principal-sig': 'other' },
      { 'x-intafaced-region': 'US' },
      { 'content-type': 'text/plain' },
    ]) {
      expect(k.verifier().verify(request({ ...h, ...wire, ...change }))).toMatchObject({ status: 'rejected', reason: 'bad-signature' });
    }
  });

  it('refuses malformed and repeated headers', () => {
    const k = kit();
    const h = signed(k);
    for (const [name, value] of [
      ['x-intafaced-s2s-nonce', 'short'],
      ['x-intafaced-s2s-ts', '12'],
      ['x-intafaced-s2s-sig', `${h['x-intafaced-s2s-sig']},${h['x-intafaced-s2s-sig']}`],
      ['x-intafaced-s2s-body', 'ZZ'],
      ['x-intafaced-s2s-aud', 'svc-ledger, svc-pay'],
    ] as const) {
      expect(k.verifier().verify(request({ ...h, [name]: value }))).toEqual({ status: 'rejected', reason: 'malformed' });
    }
    const missing = { ...h };
    delete (missing as Record<string, string>)['x-intafaced-s2s-nonce'];
    expect(k.verifier().verify(request(missing))).toEqual({ status: 'rejected', reason: 'malformed' });
    expect(k.verifier().verify(request({ ...h, 'x-intafaced-s2s-kid': ['svc-trade.a', 'svc-trade.a'] as never }))).toEqual({
      status: 'rejected',
      reason: 'malformed',
    });
  });

  it('applies the asymmetric clock window and the boot floor', () => {
    const k = kit();
    const call = (offset: number) =>
      createServiceSigner({
        service: 'svc-trade',
        kid: 'svc-trade.a',
        privateKey: k.keys[0]!.privateKey,
        keyring: k.keyring,
        now: () => new Date(NOW.getTime() + offset * 1000),
      }).headers({ audience: 'svc-ledger', method: 'POST', url: URL_POST, body: BODY });
    const v = () => k.verifier({ bootSecond: 0 });
    expect(v().verify(request(call(-60)))).toMatchObject({ status: 'accepted' });
    expect(v().verify(request(call(-61)))).toEqual({ status: 'rejected', reason: 'stale' });
    expect(v().verify(request(call(5)))).toMatchObject({ status: 'accepted' });
    expect(v().verify(request(call(6)))).toEqual({ status: 'rejected', reason: 'stale' });
    const booted = Math.floor(NOW.getTime() / 1000);
    expect(k.verifier({ bootSecond: booted + 1 }).verify(request(call(0)))).toEqual({ status: 'rejected', reason: 'stale' });
    expect(k.verifier().verify(request(call(-1)))).toEqual({ status: 'rejected', reason: 'stale' });
  });

  it('refuses rather than evicts when the nonce cache is full', () => {
    const k = kit();
    const nonce = createNonceCache({ maxEntries: 1 });
    const v = k.verifier({ nonce });
    expect(v.verify(request(signed(k)))).toMatchObject({ status: 'accepted' });
    expect(v.verify(request(signed(k)))).toEqual({ status: 'rejected', reason: 'replay-cache-full' });
  });

  it('forgets a nonce once its window has passed', () => {
    const k = kit();
    const nonce = createNonceCache({ maxEntries: 10 });
    expect(k.verifier({ nonce }).verify(request(signed(k)))).toMatchObject({ status: 'accepted' });
    expect(nonce.size()).toBe(1);
    const later = new Date(NOW.getTime() + 200_000);
    const signer = createServiceSigner({
      service: 'svc-trade',
      kid: 'svc-trade.a',
      privateKey: k.keys[0]!.privateKey,
      keyring: k.keyring,
      now: () => later,
    });
    const fresh = signer.headers({ audience: 'svc-ledger', method: 'POST', url: URL_POST, body: BODY });
    expect(k.verifier({ nonce, now: () => later }).verify(request(fresh))).toMatchObject({ status: 'accepted' });
    expect(nonce.size()).toBe(1);
  });
});
