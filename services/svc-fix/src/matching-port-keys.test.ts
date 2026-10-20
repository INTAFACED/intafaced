import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServiceSigner, createServiceVerifier, verifyServiceRequest, type Keyring, type ServiceAuthMode } from '@intafaced/contracts';
import type { MatchingOrderCommand } from './command.js';
import { postMatchingSubmit, type MatchingPortOptions } from './matching-port.js';

/**
 * svc-fix's outgoing matching submit signed with its own Ed25519 key (S2S v3), judged by the real contracts verifier
 * fed the request exactly as it went on the wire. Keys are generated at runtime; none is stored.
 */
const SECRET = randomBytes(24).toString('hex');
const OWNER_MAP = '{"CLIENT":"acct-desk"}';

const command: MatchingOrderCommand = {
  kind: 'new_order_single',
  clOrdId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  beginString: 'FIX.4.4',
  symbol: 'BTC/USDT',
  side: 'buy',
  ordType: 'limit',
  qty: '1.50',
  price: '100.25',
  senderCompId: 'CLIENT',
  tif: 'GTC',
};

type Sent = { url: URL; method: string; headers: Record<string, string>; body: string };

function makeKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const keyring: Keyring = [{ kid: 'svc-fix.a', svc: 'svc-fix', use: 's2s', x }];
  const signer = createServiceSigner({ service: 'svc-fix', kid: 'svc-fix.a', privateKey: pkcs8, keyring });
  return {
    pkcs8,
    keyring,
    s2s: (mode: ServiceAuthMode) => ({ signer, mode }),
    verifier: () => createServiceVerifier({ self: 'svc-matching', keyring, bootSecond: 0 }),
  };
}

const sent: Sent[] = [];

function stubFetch(): void {
  sent.length = 0;
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    sent.push({
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: String(init?.body ?? ''),
    });
    return new Response('{"accepted":true,"sequence":7}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

function judged(s: Sent, verifier: ReturnType<typeof createServiceVerifier>, mode?: ServiceAuthMode) {
  return verifyServiceRequest(
    { method: s.method, url: s.url.pathname + s.url.search, headers: s.headers, body: s.body },
    { verifier, legacySecret: SECRET, mode },
  );
}

function opts(extra: Partial<MatchingPortOptions> = {}): MatchingPortOptions {
  return { matchingBaseUrl: 'http://matching.test', compIdAccountJson: OWNER_MAP, internalServiceSecret: SECRET, ...extra };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('svc-fix matching submit with its own key', () => {
  it('off: no signing key, the shared secret alone, no v3 headers', async () => {
    stubFetch();
    const out = await postMatchingSubmit(command, opts());
    expect(out.ok).toBe(true);
    expect(Object.keys(sent[0]!.headers).some((h) => h.startsWith('x-intafaced-s2s-'))).toBe(false);
    expect(judged(sent[0]!, makeKeys().verifier())).toMatchObject({ service: 'svc-fix', scheme: 'shared' });
  });

  it('off: a blank or short secret still refuses before any POST', async () => {
    stubFetch();
    for (const internalServiceSecret of ['', 'short']) {
      const out = await postMatchingSubmit(command, opts({ internalServiceSecret }));
      expect(out).toMatchObject({ ok: false, error: { code: 'matching_service_auth_unconfigured' } });
    }
    expect(sent).toHaveLength(0);
  });

  it('dual: the callee names the caller from the key and the shared secret rides along', async () => {
    stubFetch();
    const k = makeKeys();
    const out = await postMatchingSubmit(command, opts({ s2s: k.s2s('dual') }));
    expect(out.ok).toBe(true);
    expect(sent[0]!.headers['x-intafaced-service']).toBe('svc-fix');
    expect(sent[0]!.headers['x-intafaced-s2s-aud']).toBe('svc-matching');
    expect(judged(sent[0]!, k.verifier())).toEqual({ service: 'svc-fix', scheme: 'keypair', rejected: null });
  });

  it('dual: a blank or short secret still refuses', async () => {
    stubFetch();
    for (const internalServiceSecret of ['', 'short']) {
      const out = await postMatchingSubmit(command, opts({ s2s: makeKeys().s2s('dual'), internalServiceSecret }));
      expect(out).toMatchObject({ ok: false, error: { code: 'matching_service_auth_unconfigured' } });
    }
    expect(sent).toHaveLength(0);
  });

  it('keypair: only the key signature is sent, a blank shared secret is fine, and a keypair-only callee accepts it', async () => {
    stubFetch();
    const k = makeKeys();
    const out = await postMatchingSubmit(command, opts({ s2s: k.s2s('keypair'), internalServiceSecret: '' }));
    expect(out.ok).toBe(true);
    expect(sent[0]!.headers['x-intafaced-service']).toBeUndefined();
    expect(sent[0]!.headers['x-intafaced-service-sig']).toBeUndefined();
    expect(judged(sent[0]!, k.verifier(), 'keypair')).toMatchObject({ service: 'svc-fix', scheme: 'keypair' });
  });

  it('a signed call moved to another path or method is refused', async () => {
    stubFetch();
    const k = makeKeys();
    await postMatchingSubmit(command, opts({ s2s: k.s2s('keypair') }));
    const path = { ...sent[0]!, url: new URL(`${sent[0]!.url.origin}/markets/ETH%2FUSDT/orders`) };
    expect(judged(path, k.verifier(), 'keypair')).toMatchObject({ service: null });
    const method = { ...sent[0]!, method: 'PUT' };
    expect(judged(method, k.verifier(), 'keypair')).toMatchObject({ service: null });
  });

  it('a signed call with another body or content type is refused', async () => {
    stubFetch();
    const k = makeKeys();
    await postMatchingSubmit(command, opts({ s2s: k.s2s('keypair') }));
    const body = { ...sent[0]!, body: sent[0]!.body.replace('1.50', '9.50') };
    expect(judged(body, k.verifier(), 'keypair')).toMatchObject({ service: null });
    const typed = { ...sent[0]!, headers: { ...sent[0]!.headers, 'content-type': 'text/plain' } };
    expect(judged(typed, k.verifier(), 'keypair')).toMatchObject({ service: null });
  });

  it('reads the mode and key from the environment when no s2s option is given', async () => {
    stubFetch();
    const k = makeKeys();
    vi.stubEnv('S2S_AUTH_MODE', 'keypair');
    vi.stubEnv('S2S_KEYRING', JSON.stringify({ keys: k.keyring }));
    vi.stubEnv('S2S_SIGNING_KID', 'svc-fix.a');
    vi.stubEnv('S2S_SIGNING_KEY', k.pkcs8);
    const out = await postMatchingSubmit(command, opts({ internalServiceSecret: '' }));
    expect(out.ok).toBe(true);
    expect(judged(sent[0]!, k.verifier(), 'keypair')).toMatchObject({ service: 'svc-fix', scheme: 'keypair' });
  });

  it('a malformed S2S environment refuses instead of falling back to unsigned', async () => {
    stubFetch();
    vi.stubEnv('S2S_AUTH_MODE', 'bogus');
    const out = await postMatchingSubmit(command, opts());
    expect(out).toMatchObject({ ok: false, error: { code: 'matching_service_auth_unconfigured' } });
    expect(sent).toHaveLength(0);
  });
});
