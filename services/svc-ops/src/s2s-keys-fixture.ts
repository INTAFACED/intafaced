import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createServiceSigner,
  createServiceVerifier,
  verifyServiceRequest,
  type Keyring,
  type ServiceAuthMode,
  type ServiceName,
  type ServiceSigner,
} from '@intafaced/contracts';

/**
 * Shared by the `*-keys.test.ts` files: svc-ops's outgoing calls signed with its own key, judged by the contracts
 * verifier fed the request exactly as it went on the wire. Keys are generated at runtime; none is stored.
 */
export const SECRET = randomBytes(24).toString('hex');

export type S2s = { signer: ServiceSigner; mode: ServiceAuthMode };
export type Sent = { url: URL; method: string; headers: Record<string, string>; body: string };

export function makeKeys(audience: ServiceName) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const keyring: Keyring = [{ kid: 'svc-ops.a', svc: 'svc-ops', use: 's2s', x }];
  const signer = createServiceSigner({ service: 'svc-ops', kid: 'svc-ops.a', privateKey: pkcs8, keyring });
  return {
    s2s: (mode: ServiceAuthMode): S2s => ({ signer, mode }),
    verifier: () => createServiceVerifier({ self: audience, keyring, bootSecond: 0 }),
  };
}

/** A fetch that records the request and answers 200 with an empty JSON object. */
export function recorder(): { fetchImpl: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: init?.body === undefined ? '' : String(init.body),
    });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, sent };
}

export function judged(s: Sent, verifier: ReturnType<typeof createServiceVerifier>, mode?: ServiceAuthMode) {
  return verifyServiceRequest(
    { method: s.method, url: s.url.pathname + s.url.search, headers: s.headers, body: s.body },
    { verifier, legacySecret: SECRET, mode },
  );
}

/** The four cases every outgoing client must pass. `call` makes one request through the client under test. */
export function keyCases(label: string, audience: ServiceName, call: (fetchImpl: typeof fetch, s2s?: S2s) => Promise<void>): void {
  describe(`${label} with its own key`, () => {
    it('without a signing key the call is signed with the shared secret as before', async () => {
      const { fetchImpl, sent } = recorder();
      await call(fetchImpl);
      expect(Object.keys(sent[0]!.headers).some((h) => h.startsWith('x-intafaced-s2s-'))).toBe(false);
      expect(judged(sent[0]!, makeKeys(audience).verifier())).toMatchObject({ service: 'svc-ops', scheme: 'shared' });
    });

    it('dual: the callee names the caller from the key, and the shared secret rides along', async () => {
      const { fetchImpl, sent } = recorder();
      const k = makeKeys(audience);
      await call(fetchImpl, k.s2s('dual'));
      expect(sent[0]!.headers['x-intafaced-service']).toBe('svc-ops');
      expect(judged(sent[0]!, k.verifier())).toEqual({ service: 'svc-ops', scheme: 'keypair', rejected: null });
    });

    it('keypair: only the key signature is sent, and a keypair-only callee accepts it', async () => {
      const { fetchImpl, sent } = recorder();
      const k = makeKeys(audience);
      await call(fetchImpl, k.s2s('keypair'));
      expect(sent[0]!.headers['x-intafaced-service']).toBeUndefined();
      expect(sent[0]!.headers['x-intafaced-signature']).toBeUndefined();
      expect(judged(sent[0]!, k.verifier(), 'keypair')).toMatchObject({ service: 'svc-ops', scheme: 'keypair' });
    });

    it('a signed call moved to another path or method is refused', async () => {
      const { fetchImpl, sent } = recorder();
      const k = makeKeys(audience);
      await call(fetchImpl, k.s2s('keypair'));
      const path = { ...sent[0]!, url: new URL(`${sent[0]!.url.origin}/internal/elsewhere`) };
      expect(judged(path, k.verifier(), 'keypair')).toMatchObject({ service: null });
      const method = { ...sent[0]!, method: sent[0]!.method === 'GET' ? 'POST' : 'GET' };
      expect(judged(method, k.verifier(), 'keypair')).toMatchObject({ service: null });
    });
  });
}
