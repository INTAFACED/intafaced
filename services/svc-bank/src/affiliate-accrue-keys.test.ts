import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServiceSigner, createServiceVerifier, verifyServiceRequest, type Keyring, type ServiceAuthMode } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { createAffiliateAccrueClient } from './affiliate-accrue.js';

/**
 * svc-bank signs its affiliate accrue call with its own key once S2S is on.
 * The receiver is the contracts verifier the callee (svc-identity) uses, fed the request exactly as it went on the wire.
 * Keys are generated per run.
 */
const SECRET = 'test-internal-service-secret-32-chars';

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const keyring: Keyring = [{ kid: 'svc-bank.a', svc: 'svc-bank', use: 's2s', x }];
  const signer = createServiceSigner({ service: 'svc-bank', kid: 'svc-bank.a', privateKey: pkcs8, keyring });
  return {
    s2s: (mode: ServiceAuthMode) => ({ signer, mode }),
    verifier: () => createServiceVerifier({ self: 'svc-identity', keyring }),
  };
}

type Sent = { url: URL; method: string; headers: Record<string, string>; body: string };

function record(sent: Sent[], input: string | URL | Request, init?: RequestInit): void {
  sent.push({
    url: new URL(String(input)),
    method: init?.method ?? 'GET',
    headers: init?.headers as Record<string, string>,
    body: init?.body === undefined ? '' : String(init.body),
  });
}

const judged = (s: Sent, verifier: ReturnType<typeof createServiceVerifier>, mode?: ServiceAuthMode) =>
  verifyServiceRequest(
    { method: s.method, url: s.url.pathname + s.url.search, headers: s.headers, body: s.body },
    { verifier, legacySecret: SECRET, mode },
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('svc-bank -> svc-identity affiliate accrue with its own key', () => {
  it('without a signing key the call is signed with the shared secret as before', async () => {
    const sent: Sent[] = [];
    const k = keys();
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      record(sent, input, init);
      return new Response('{}', { status: 200 });
    });
    await createAffiliateAccrueClient('http://identity.test', SECRET, undefined).accrueBankFee({
      userId: 'u-1',
      feeAmount: parseAmount('1'),
      feeAsset: 'USDT',
      feeEventId: 'bank.repay:l-1:1',
    });
    expect(sent.length).toBeGreaterThan(0);
    expect(Object.keys(sent[0]!.headers).some((h) => h.startsWith('x-intafaced-s2s-'))).toBe(false);
    expect(judged(sent[0]!, k.verifier())).toMatchObject({ service: 'svc-bank', scheme: 'shared' });
  });

  it('dual: the callee names the caller from the key, and the shared secret rides along', async () => {
    const sent: Sent[] = [];
    const k = keys();
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      record(sent, input, init);
      return new Response('{}', { status: 200 });
    });
    await createAffiliateAccrueClient('http://identity.test', SECRET, k.s2s('dual')).accrueBankFee({
      userId: 'u-1',
      feeAmount: parseAmount('1'),
      feeAsset: 'USDT',
      feeEventId: 'bank.repay:l-1:1',
    });
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) {
      expect(s.headers['x-intafaced-service']).toBe('svc-bank');
      expect(judged(s, k.verifier())).toEqual({ service: 'svc-bank', scheme: 'keypair', rejected: null });
    }
  });

  it('keypair: only the key signature is sent, and a keypair-only callee accepts it', async () => {
    const sent: Sent[] = [];
    const k = keys();
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      record(sent, input, init);
      return new Response('{}', { status: 200 });
    });
    await createAffiliateAccrueClient('http://identity.test', SECRET, k.s2s('keypair')).accrueBankFee({
      userId: 'u-1',
      feeAmount: parseAmount('1'),
      feeAsset: 'USDT',
      feeEventId: 'bank.repay:l-1:1',
    });
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) {
      expect(s.headers['x-intafaced-service']).toBeUndefined();
      expect(s.headers['x-intafaced-signature']).toBeUndefined();
      expect(judged(s, k.verifier(), 'keypair')).toMatchObject({ service: 'svc-bank', scheme: 'keypair' });
    }
  });

  it('a signed call moved to another path or method is refused', async () => {
    const sent: Sent[] = [];
    const k = keys();
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      record(sent, input, init);
      return new Response('{}', { status: 200 });
    });
    await createAffiliateAccrueClient('http://identity.test', SECRET, k.s2s('keypair')).accrueBankFee({
      userId: 'u-1',
      feeAmount: parseAmount('1'),
      feeAsset: 'USDT',
      feeEventId: 'bank.repay:l-1:1',
    });
    const first = sent[0]!;
    expect(judged(first, k.verifier(), 'keypair').service).toBe('svc-bank');
    const otherPath = { ...first, url: new URL('http://callee.test/elsewhere') };
    expect(judged(otherPath, k.verifier(), 'keypair')).toMatchObject({ service: null });
    const otherMethod = { ...first, method: first.method === 'POST' ? 'GET' : 'POST' };
    expect(judged(otherMethod, k.verifier(), 'keypair')).toMatchObject({ service: null });
  });
});
