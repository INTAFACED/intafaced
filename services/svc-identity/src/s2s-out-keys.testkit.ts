import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  createServiceSigner,
  createServiceVerifier,
  verifyServiceRequest,
  type Keyring,
  type ServiceAuthMode,
  type ServiceName,
} from '@intafaced/contracts';

/**
 * Runtime keys for the outgoing-call tests: svc-identity signs, the named callee verifies with the contracts verifier
 * it uses on its doors, fed the request exactly as it went on the wire. Nothing here is a real key or secret.
 */
export const SHARED = randomBytes(24).toString('hex');

export function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const keyring: Keyring = [{ kid: 'svc-identity.a', svc: 'svc-identity', use: 's2s', x }];
  const signer = createServiceSigner({ service: 'svc-identity', kid: 'svc-identity.a', privateKey: pkcs8, keyring });
  return {
    s2s: (mode: ServiceAuthMode) => ({ signer, mode }),
    // bootSecond 0: a call signed in the second the verifier booted is not refused as stale.
    verifier: (self: ServiceName) => createServiceVerifier({ self, keyring, bootSecond: 0 }),
  };
}

export type Wire = { url: URL; method: string; headers: Record<string, string>; body: string };

export function wire(input: string | URL, init: { headers?: unknown; body?: unknown; method?: string }): Wire {
  return {
    url: new URL(String(input)),
    method: init.method ?? 'GET',
    headers: init.headers as Record<string, string>,
    body: String(init.body),
  };
}

export const judged = (w: Wire, verifier: ReturnType<typeof createServiceVerifier>, mode?: ServiceAuthMode) =>
  verifyServiceRequest(
    { method: w.method, url: w.url.pathname + w.url.search, headers: w.headers, body: w.body },
    { verifier, legacySecret: SHARED, mode },
  );
