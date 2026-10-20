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
import { createGuestIngressContext } from './context.js';

/**
 * The guest ingress door names the producer from its own service key once S2S is on. Keys here are generated per run.
 */
const EDGE_SECRET = 'a-notify-guest-edge-secret-long-enough-x';
const OPS_SECRET = 'a-notify-ops-pairwise-secret-long-enough';
const PATH = '/trpc/guests.erase';
const BODY = '{"requestId":"r1"}';

function keyFor(service: ServiceName) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  return { pkcs8, entry: { kid: `${service}.a`, svc: service, use: 's2s' as const, x } };
}

function fleet() {
  const ops = keyFor('svc-ops');
  const trade = keyFor('svc-trade');
  const keyring: Keyring = [ops.entry, trade.entry];
  const signer = (service: ServiceName, k: ReturnType<typeof keyFor>) =>
    createServiceSigner({ service, kid: k.entry.kid, privateKey: k.pkcs8, keyring });
  return {
    ops: signer('svc-ops', ops),
    trade: signer('svc-trade', trade),
    verifier: () => createServiceVerifier({ self: 'svc-notify', keyring, bootSecond: 0 }),
  };
}

const keyed = (signer: ReturnType<typeof fleet>['ops'], audience: 'svc-notify' | 'svc-ledger' = 'svc-notify') => ({
  'content-type': 'application/json',
  ...signer.headers({
    audience,
    method: 'POST',
    url: new URL(`http://notify.test${PATH}`),
    body: BODY,
    context: { contentType: 'application/json' },
  }),
});
const pairwise = () => ({ 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-ops', OPS_SECRET, BODY) });
const call = (
  mode: ServiceAuthMode | undefined,
  verifier: ReturnType<ReturnType<typeof fleet>['verifier']> | undefined,
  headers: Record<string, string>,
) => {
  const ctx = createGuestIngressContext({
    edgeSecret: EDGE_SECRET,
    opsSecret: OPS_SECRET,
    ...(verifier && mode ? { s2s: { verifier, mode } } : {}),
  });
  return ctx({ headers, id: 'r1', body: BODY, method: 'POST', url: PATH }).service;
};

describe('guest ingress door with service keys', () => {
  it('without S2S configured, a key-signed call names no one and the pairwise secret works as before', () => {
    const f = fleet();
    expect(call(undefined, undefined, keyed(f.ops))).toBeNull();
    expect(call(undefined, undefined, pairwise())).toBe('svc-ops');
  });

  it('dual: names the producer from its key and still accepts the pairwise secret', () => {
    const f = fleet();
    expect(call('dual', f.verifier(), keyed(f.ops))).toBe('svc-ops');
    expect(call('dual', f.verifier(), pairwise())).toBe('svc-ops');
  });

  it('keypair: names the producer from its key and refuses the pairwise secret', () => {
    const f = fleet();
    expect(call('keypair', f.verifier(), keyed(f.ops))).toBe('svc-ops');
    expect(call('keypair', f.verifier(), pairwise())).toBeNull();
  });

  it('another service key is named as itself, so the producer check refuses it', () => {
    const f = fleet();
    expect(call('keypair', f.verifier(), keyed(f.trade))).toBe('svc-trade');
  });

  it('refuses a call meant for another service, and a replayed one', () => {
    const f = fleet();
    const verifier = f.verifier();
    expect(call('keypair', verifier, keyed(f.ops, 'svc-ledger'))).toBeNull();
    const once = keyed(f.ops);
    expect(call('keypair', verifier, once)).toBe('svc-ops');
    expect(call('keypair', verifier, once)).toBeNull();
  });
});
