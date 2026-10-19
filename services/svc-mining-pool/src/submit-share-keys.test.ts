import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createServiceSigner,
  createServiceVerifier,
  serviceAuthHeadersForBody,
  type Keyring,
  type ServiceAuthMode,
  type ServiceName,
} from '@intafaced/contracts';
import { authorizeSubmitShare, type SubmitShareS2s } from './submit-share.js';

/**
 * The share-ingest door names the caller from its own service key once S2S is on. Keys here are generated per run.
 */
const SECRET = 'mining-submit-share-keys-test-secret-32';
const PATH = '/submitShare';
const BODY = '{"shares":[]}';
const RAW = Buffer.from(BODY);

function keyFor(service: ServiceName) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  return { pkcs8, entry: { kid: `${service}.a`, svc: service, use: 's2s' as const, x } };
}

function fleet() {
  const edge = keyFor('svc-edge');
  const keyring: Keyring = [edge.entry];
  return {
    edge: createServiceSigner({ service: 'svc-edge', kid: edge.entry.kid, privateKey: edge.pkcs8, keyring }),
    verifier: () => createServiceVerifier({ self: 'svc-mining-pool', keyring }),
  };
}

const keyed = (signer: ReturnType<typeof fleet>['edge'], audience: 'svc-mining-pool' | 'svc-ledger' = 'svc-mining-pool') =>
  signer.headers({
    audience,
    method: 'POST',
    url: new URL(`http://mining.test${PATH}`),
    body: BODY,
    context: { contentType: 'application/json' },
  });
const withType = (h: Record<string, string>) => ({ 'content-type': 'application/json', ...h });
const shared = () => withType(serviceAuthHeadersForBody('svc-edge', SECRET, BODY));
const s2sOf = (mode: ServiceAuthMode, verifier: ReturnType<ReturnType<typeof fleet>['verifier']>): SubmitShareS2s => ({
  verifier,
  mode,
  method: 'POST',
  url: PATH,
});

describe('svc-mining-pool share ingest with service keys', () => {
  it('without S2S configured, a key-signed call is refused and the shared secret works as before', () => {
    const f = fleet();
    expect(authorizeSubmitShare(withType(keyed(f.edge)), SECRET, RAW).ok).toBe(false);
    expect(authorizeSubmitShare(shared(), SECRET, RAW)).toEqual({ ok: true, service: 'svc-edge' });
  });

  it('dual: accepts the key, naming the caller from it, and still accepts the shared secret', () => {
    const f = fleet();
    const s2s = s2sOf('dual', f.verifier());
    expect(authorizeSubmitShare(withType(keyed(f.edge)), SECRET, RAW, s2s)).toEqual({ ok: true, service: 'svc-edge' });
    expect(authorizeSubmitShare(shared(), SECRET, RAW, s2s).ok).toBe(true);
  });

  it('keypair: accepts the key and refuses the shared secret', () => {
    const f = fleet();
    const s2s = s2sOf('keypair', f.verifier());
    expect(authorizeSubmitShare(withType(keyed(f.edge)), SECRET, RAW, s2s).ok).toBe(true);
    expect(authorizeSubmitShare(shared(), SECRET, RAW, s2s).ok).toBe(false);
  });

  it('refuses a tampered body, a call meant for another service, and a replay', () => {
    const f = fleet();
    const s2s = s2sOf('keypair', f.verifier());
    expect(authorizeSubmitShare(withType(keyed(f.edge)), SECRET, Buffer.from('{"shares":[1]}'), s2s).ok).toBe(false);
    expect(authorizeSubmitShare(withType(keyed(f.edge, 'svc-ledger')), SECRET, RAW, s2s).ok).toBe(false);
    const once = withType(keyed(f.edge));
    expect(authorizeSubmitShare(once, SECRET, RAW, s2s).ok).toBe(true);
    expect(authorizeSubmitShare(once, SECRET, RAW, s2s).ok).toBe(false);
  });
});
