import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createServiceSigner, createServiceVerifier, verifyServiceRequest, type Keyring, type ServiceAuthMode } from '@intafaced/contracts';
import { userAvailable } from '@intafaced/ledger-client';
import { createLedgerClient } from './ledger-client.js';

/**
 * svc-market signs its svc-ledger calls with its own key once S2S is on, and the ledger judges the caller from that key.
 * The receiver here is the contracts verifier svc-ledger uses, fed the request exactly as it went on the wire.
 */
const SECRET = 'test-internal-service-secret-32-chars';
const USER = '11111111-1111-4111-8111-111111111111';
const realFetch = globalThis.fetch;

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const keyring: Keyring = [{ kid: 'svc-market.a', svc: 'svc-market', use: 's2s', x }];
  return {
    signer: createServiceSigner({ service: 'svc-market', kid: 'svc-market.a', privateKey: pkcs8, keyring }),
    verifier: () => createServiceVerifier({ self: 'svc-ledger', keyring, bootSecond: 0 }),
  };
}

type Sent = { url: URL; method: string; headers: Record<string, string>; body: string };

function capture(): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: String(init?.body),
    });
    const body = String(input).endsWith('/trpc/balances')
      ? []
      : { accountId: 'a-1', assetId: 'USDT', kind: 'available', purpose: '', amount: '5' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return sent;
}

const judged = (s: Sent, verifier: ReturnType<typeof createServiceVerifier>, mode?: ServiceAuthMode) =>
  verifyServiceRequest(
    { method: s.method, url: s.url.pathname + s.url.search, headers: s.headers, body: s.body },
    { verifier, legacySecret: SECRET, mode },
  );

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('svc-market -> svc-ledger with its own key', () => {
  const ref = userAvailable(USER, 'USDT');

  it('without a signing key the call is signed with the shared secret as before', async () => {
    const sent = capture();
    await createLedgerClient('http://ledger.test', SECRET).balance(ref);
    const k = keys();
    expect(Object.keys(sent[0]!.headers).some((h) => h.startsWith('x-intafaced-s2s-'))).toBe(false);
    expect(judged(sent[0]!, k.verifier())).toMatchObject({ service: 'svc-market', scheme: 'shared' });
  });

  it('dual: the ledger names the caller from the key, and the shared secret rides along', async () => {
    const sent = capture();
    const k = keys();
    await createLedgerClient('http://ledger.test', SECRET, { signer: k.signer, mode: 'dual' }).balance(ref);
    expect(sent[0]!.headers['x-intafaced-service']).toBe('svc-market');
    expect(judged(sent[0]!, k.verifier())).toEqual({ service: 'svc-market', scheme: 'keypair', rejected: null });
  });

  it('keypair: only the key signature is sent, and a keypair-only ledger accepts it', async () => {
    const sent = capture();
    const k = keys();
    await createLedgerClient('http://ledger.test', SECRET, { signer: k.signer, mode: 'keypair' }).balance(ref);
    expect(sent[0]!.headers['x-intafaced-service']).toBeUndefined();
    expect(sent[0]!.headers['x-intafaced-signature']).toBeUndefined();
    expect(judged(sent[0]!, k.verifier(), 'keypair')).toMatchObject({ service: 'svc-market', scheme: 'keypair' });
  });

  it('every ledger call is signed for svc-ledger and for its own path, body and content type', async () => {
    const sent = capture();
    const k = keys();
    const client = createLedgerClient('http://ledger.test', SECRET, { signer: k.signer, mode: 'keypair' });
    await client.balance(ref);
    await client.balances('user', USER);
    const verifier = k.verifier();
    expect(sent.map((s) => s.url.pathname)).toEqual(['/trpc/balance', '/trpc/balances']);
    for (const s of sent) expect(judged(s, verifier, 'keypair').service).toBe('svc-market');
    // Moving a signed balance call to another path is refused.
    const moved = { ...sent[0]!, url: new URL('http://ledger.test/trpc/post') };
    expect(judged(moved, k.verifier(), 'keypair')).toMatchObject({ service: null });
  });
});
