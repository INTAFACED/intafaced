import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createServiceSigner,
  createServiceVerifier,
  verifyServiceRequest,
  type Keyring,
  type ServiceAuthMode,
  type ServiceSigner,
} from '@intafaced/contracts';
import { createMatchingClient } from './matching-client.js';

/**
 * svc-trade signs every svc-matching engine call with its own key once S2S is on.
 * The receiver here is the contracts verifier the callee uses, fed the request exactly as it went on the wire.
 */
const SECRET = 'test-internal-service-secret-32-chars';
const USER = '11111111-1111-4111-8111-111111111111';
const realFetch = globalThis.fetch;

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const keyring: Keyring = [{ kid: 'svc-trade.a', svc: 'svc-trade', use: 's2s', x }];
  const signer = createServiceSigner({ service: 'svc-trade', kid: 'svc-trade.a', privateKey: pkcs8, keyring });
  return {
    s2s: (mode: ServiceAuthMode): { signer: ServiceSigner; mode: ServiceAuthMode } => ({ signer, mode }),
    verifier: (self: 'svc-identity' | 'svc-token' | 'svc-fix' | 'svc-matching' | 'svc-ledger' = 'svc-matching') =>
      createServiceVerifier({ self, keyring, bootSecond: 0 }),
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
      body: init?.body === undefined ? '' : String(init.body),
    });
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return sent;
}

const judged = (s: Sent, verifier: ReturnType<typeof createServiceVerifier>, mode?: ServiceAuthMode) =>
  verifyServiceRequest(
    { method: s.method, url: s.url.pathname + s.url.search, headers: s.headers, body: s.body },
    { verifier, legacySecret: SECRET, mode },
  );

/** Every call this client makes, so each one is checked on the wire. */
const calls: Array<(s2s?: { signer: ServiceSigner; mode: ServiceAuthMode }) => Promise<unknown>> = [
  (s2s) => createMatchingClient('http://matching.test', SECRET, s2s).submit('m-1', { orderId: 'o-1' } as never),
  (s2s) => createMatchingClient('http://matching.test', SECRET, s2s).cancel('m-1', 'o-1'),
  (s2s) => createMatchingClient('http://matching.test', SECRET, s2s).massCancel('m-1', { accountId: USER } as never),
  (s2s) => createMatchingClient('http://matching.test', SECRET, s2s).amend('m-1', 'o-1', { qty: '1' } as never),
  (s2s) => createMatchingClient('http://matching.test', SECRET, s2s).depth('m-1', 10),
  (s2s) => createMatchingClient('http://matching.test', SECRET, s2s).listOrders('m-1'),
  (s2s) => createMatchingClient('http://matching.test', SECRET, s2s).listMarkets(),
  (s2s) => createMatchingClient('http://matching.test', SECRET, s2s).reconcile([]),
];

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('svc-trade -> svc-matching engine calls with its own key', () => {
  it('without a signing key the calls are signed with the shared secret as before', async () => {
    const sent = capture();
    for (const call of calls) await call().catch(() => undefined);
    expect(sent).toHaveLength(calls.length);
    for (const s of sent) {
      expect(Object.keys(s.headers).some((h) => h.startsWith('x-intafaced-s2s-'))).toBe(false);
      expect(s.headers['x-intafaced-service']).toBe('svc-trade');
      expect(judged(s, keys().verifier())).toMatchObject({ service: 'svc-trade', scheme: 'shared' });
    }
  });

  it('dual: the callee names the caller from the key, and the shared secret rides along', async () => {
    const sent = capture();
    const k = keys();
    for (const call of calls) await call(k.s2s('dual')).catch(() => undefined);
    expect(sent).toHaveLength(calls.length);
    for (const s of sent) {
      expect(s.headers['x-intafaced-service']).toBe('svc-trade');
      expect(judged(s, k.verifier())).toEqual({ service: 'svc-trade', scheme: 'keypair', rejected: null });
    }
  });

  it('keypair: only the key signature is sent, and a keypair-only callee accepts it', async () => {
    const sent = capture();
    const k = keys();
    for (const call of calls) await call(k.s2s('keypair')).catch(() => undefined);
    expect(sent).toHaveLength(calls.length);
    for (const s of sent) {
      expect(s.headers['x-intafaced-service']).toBeUndefined();
      expect(s.headers['x-intafaced-signature']).toBeUndefined();
      expect(judged(s, k.verifier(), 'keypair')).toMatchObject({ service: 'svc-trade', scheme: 'keypair' });
    }
  });

  it('each call is signed for svc-matching and for its own method, path, body and content type', async () => {
    const sent = capture();
    const k = keys();
    for (const call of calls) await call(k.s2s('keypair')).catch(() => undefined);
    expect(sent.map((s) => `${s.method} ${s.url.pathname}`)).toEqual([
      'POST /markets/m-1/orders',
      'DELETE /markets/m-1/orders/o-1',
      'POST /markets/m-1/orders/mass-cancel',
      'PATCH /markets/m-1/orders/o-1',
      'GET /markets/m-1/depth',
      'GET /markets/m-1/orders',
      'GET /markets',
      'POST /reconcile',
    ]);
    for (const s of sent) {
      // Moved to another path, another method, or another body: refused.
      expect(judged({ ...s, url: new URL('http://callee.test/elsewhere') }, k.verifier(), 'keypair')).toMatchObject({ service: null });
      expect(judged({ ...s, method: s.method === 'GET' ? 'POST' : 'GET' }, k.verifier(), 'keypair')).toMatchObject({ service: null });
      expect(judged({ ...s, body: s.body + ' ' }, k.verifier(), 'keypair')).toMatchObject({ service: null });
      // Presented to a service it was not signed for: refused.
      expect(judged(s, k.verifier('svc-ledger'), 'keypair')).toMatchObject({ service: null });
    }
  });
});
