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
import { requireInternalJobHmac } from './internal-job-hmac.js';

/**
 * svc-bank's internal job doors name the caller from its own service key once S2S is on. Keys are generated here;
 * the verifier is the contracts verifier svc-bank boots with.
 */
const SECRET = 'bank-internal-job-test-secret-0123456789abcdef';
const PATH = '/internal/jobs/run-risk-sweep';
const BODY = '{"limit":10}';

function fleet() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const keyring: Keyring = [{ kid: 'svc-ops.a', svc: 'svc-ops', use: 's2s', x }];
  return {
    signer: createServiceSigner({ service: 'svc-ops', kid: 'svc-ops.a', privateKey: pkcs8, keyring }),
    verifier: () => createServiceVerifier({ self: 'svc-bank', keyring, bootSecond: 0 }),
  };
}

const request = (headers: Record<string, string>) => ({ method: 'POST', url: PATH, headers, body: BODY });
const keyedHeaders = (f: ReturnType<typeof fleet>, audience: ServiceName = 'svc-bank') => ({
  'content-type': 'application/json',
  ...f.signer.headers({
    audience,
    method: 'POST',
    url: new URL(`http://bank.test${PATH}`),
    body: BODY,
    context: { contentType: 'application/json' },
  }),
});
const sharedHeaders = () => ({ 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-ops', SECRET, BODY) });
const raw = { retained: true as const, bytes: Buffer.from(BODY) };

function call(headers: Record<string, string>, f: ReturnType<typeof fleet>, mode?: ServiceAuthMode) {
  const req = request(headers);
  return requireInternalJobHmac(req.headers, SECRET, raw, mode ? { req, verifier: f.verifier(), mode } : undefined);
}

describe('svc-bank job doors with service keys', () => {
  it('without S2S configured the shared secret works and a key-signed call is not a service call', () => {
    const f = fleet();
    expect(call(sharedHeaders(), f)).toBe(true);
    expect(call(keyedHeaders(f), f)).toBe(false);
  });

  it('dual: accepts the key and still accepts the shared secret', () => {
    const f = fleet();
    expect(call(keyedHeaders(f), f, 'dual')).toBe(true);
    expect(call(sharedHeaders(), f, 'dual')).toBe(true);
  });

  it('keypair: accepts the key, refuses the shared secret, a wrong audience and a replay', () => {
    const f = fleet();
    expect(call(sharedHeaders(), f, 'keypair')).toBe(false);
    expect(call(keyedHeaders(f, 'svc-ledger'), f, 'keypair')).toBe(false);
    const once = keyedHeaders(f);
    const verifier = f.verifier();
    const req = request(once);
    expect(requireInternalJobHmac(req.headers, SECRET, raw, { req, verifier, mode: 'keypair' })).toBe(true);
    const again = request(once);
    expect(requireInternalJobHmac(again.headers, SECRET, raw, { req: again, verifier, mode: 'keypair' })).toBe(false);
  });

  it('a key-signed call with a tampered body is refused', () => {
    const f = fleet();
    const req = { ...request(keyedHeaders(f)), body: '{"limit":99}' };
    expect(requireInternalJobHmac(req.headers, SECRET, raw, { req, verifier: f.verifier(), mode: 'keypair' })).toBe(false);
  });
});
