import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createServiceSigner, createServiceVerifier, verifyServiceRequest, type Keyring, type ServiceAuthMode } from '@intafaced/contracts';
import { createTaxLedgerReads } from './ledger-reads.js';

/**
 * svc-tax signs its svc-ledger calls with its own key once S2S is on, and the ledger judges the caller from that key.
 * The receiver here is the contracts verifier svc-ledger uses, fed the request exactly as it went on the wire.
 */
const SECRET = 'test-internal-service-secret-32-chars';
const USER = '11111111-1111-4111-8111-111111111111';
const realFetch = globalThis.fetch;

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const keyring: Keyring = [{ kid: 'svc-tax.a', svc: 'svc-tax', use: 's2s', x }];
  const signer = createServiceSigner({ service: 'svc-tax', kid: 'svc-tax.a', privateKey: pkcs8, keyring });
  return {
    signer,
    s2s: (mode: ServiceAuthMode) => ({ signer, mode }),
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
    const body = /\/trpc\/(balances|history)$/.test(String(input))
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

describe('svc-tax -> svc-ledger with its own key', () => {
  it('without a signing key the call is signed with the shared secret as before', async () => {
    const sent = capture();
    await createTaxLedgerReads('http://ledger.test', SECRET).balances('user', USER);
    const k = keys();
    expect(Object.keys(sent[0]!.headers).some((h) => h.startsWith('x-intafaced-s2s-'))).toBe(false);
    expect(judged(sent[0]!, k.verifier())).toMatchObject({ service: 'svc-tax', scheme: 'shared' });
  });

  it('dual: the ledger names the caller from the key, and the shared secret rides along', async () => {
    const sent = capture();
    const k = keys();
    await createTaxLedgerReads('http://ledger.test', SECRET, k.s2s('dual')).balances('user', USER);
    expect(sent[0]!.headers['x-intafaced-service']).toBe('svc-tax');
    expect(judged(sent[0]!, k.verifier())).toEqual({ service: 'svc-tax', scheme: 'keypair', rejected: null });
  });

  it('keypair: only the key signature is sent, and a keypair-only ledger accepts it', async () => {
    const sent = capture();
    const k = keys();
    await createTaxLedgerReads('http://ledger.test', SECRET, k.s2s('keypair')).balances('user', USER);
    expect(sent[0]!.headers['x-intafaced-service']).toBeUndefined();
    expect(sent[0]!.headers['x-intafaced-signature']).toBeUndefined();
    expect(judged(sent[0]!, k.verifier(), 'keypair')).toMatchObject({ service: 'svc-tax', scheme: 'keypair' });
  });

  it('every ledger call is signed for svc-ledger and for its own path, body and content type', async () => {
    const sent = capture();
    const k = keys();
    const client = createTaxLedgerReads('http://ledger.test', SECRET, k.s2s('keypair'));
    await client.balances('user', USER);
    await client.balances('user', USER);
    const verifier = k.verifier();
    expect(sent.map((s) => s.url.pathname)).toEqual(['/trpc/balances', '/trpc/balances']);
    for (const s of sent) expect(judged(s, verifier, 'keypair').service).toBe('svc-tax');
    // Moving a signed balance call to another path is refused.
    const moved = { ...sent[0]!, url: new URL('http://ledger.test/trpc/history') };
    expect(judged(moved, k.verifier(), 'keypair')).toMatchObject({ service: null });
  });

  it('the history read is signed with the key too, for its own path and body', async () => {
    const sent = capture();
    const k = keys();
    const range = { from: new Date('2026-01-01T00:00:00.000Z'), to: new Date('2026-02-01T00:00:00.000Z') };
    await createTaxLedgerReads('http://ledger.test', SECRET, k.s2s('keypair')).history(
      { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'available' },
      range,
    );
    expect(sent.map((s) => s.url.pathname)).toEqual(['/trpc/history']);
    expect(judged(sent[0]!, k.verifier(), 'keypair')).toMatchObject({ service: 'svc-tax', scheme: 'keypair' });
    expect(sent[0]!.headers['x-intafaced-service']).toBeUndefined();
  });
});
