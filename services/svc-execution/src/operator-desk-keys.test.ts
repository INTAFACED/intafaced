import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createServiceSigner,
  createServiceVerifier,
  verifyServiceRequest,
  type Keyring,
  type ServiceAuthMode,
  type ServiceName,
} from '@intafaced/contracts';
import { createExecutionApprovalClient } from './operator-desk.js';

/**
 * svc-execution signs its approval consume call to svc-identity with its own key once S2S is on.
 * The receiver here is the contracts verifier svc-identity uses, fed the request exactly as it went on the wire.
 */
const SECRET = randomBytes(24).toString('hex');
const realFetch = globalThis.fetch;
const INPUT = {
  approvalId: '11111111-1111-4111-8111-111111111111',
  operationId: 'op-1',
  actionType: 'execution.halt',
  targetHash: 'sha256:abc',
  requesterId: '22222222-2222-4222-8222-222222222222',
} as never;

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const keyring: Keyring = [{ kid: 'svc-execution.a', svc: 'svc-execution', use: 's2s', x }];
  const signer = createServiceSigner({ service: 'svc-execution', kid: 'svc-execution.a', privateKey: pkcs8, keyring });
  return {
    s2s: (mode: ServiceAuthMode) => ({ signer, mode }),
    verifier: (self: ServiceName) => createServiceVerifier({ self, keyring, bootSecond: 0 }),
  };
}
type KeyedS2s = ReturnType<ReturnType<typeof keys>['s2s']>;

type Sent = { url: URL; method: string; headers: Record<string, string>; body: string };

const judged = (s: Sent, verifier: ReturnType<typeof createServiceVerifier>, mode?: ServiceAuthMode) =>
  verifyServiceRequest(
    { method: s.method, url: s.url.pathname + s.url.search, headers: s.headers, body: s.body },
    { verifier, legacySecret: SECRET, mode },
  );

const hasKeyHeaders = (s: Sent) => Object.keys(s.headers).some((h) => h.startsWith('x-intafaced-s2s-'));

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The answer fails the approval schema after the call; the wire request is what these tests read. */
async function consume(s2s?: KeyedS2s): Promise<Sent[]> {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? '' : String(init.body),
    });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  await createExecutionApprovalClient('http://identity.test', SECRET, s2s)
    .consume(INPUT)
    .catch(() => undefined);
  return sent;
}

describe('svc-execution approval consume -> svc-identity with its own key', () => {
  it('without a signing key the call is signed with the shared secret as before', async () => {
    const sent = await consume();
    expect(sent).toHaveLength(1);
    expect(hasKeyHeaders(sent[0]!)).toBe(false);
    expect(judged(sent[0]!, keys().verifier('svc-identity'))).toMatchObject({ service: 'svc-execution', scheme: 'shared' });
  });

  it('dual: identity names the caller from the key, and the shared secret rides along', async () => {
    const k = keys();
    const sent = await consume(k.s2s('dual'));
    expect(sent[0]!.url.pathname).toBe('/trpc/actionApproval.consume');
    expect(sent[0]!.headers['x-intafaced-service']).toBe('svc-execution');
    expect(judged(sent[0]!, k.verifier('svc-identity'))).toEqual({ service: 'svc-execution', scheme: 'keypair', rejected: null });
  });

  it('keypair: only the key signature is sent, and a keypair-only identity accepts it', async () => {
    const k = keys();
    const sent = await consume(k.s2s('keypair'));
    expect(sent[0]!.headers['x-intafaced-service']).toBeUndefined();
    expect(sent[0]!.headers['x-intafaced-signature']).toBeUndefined();
    expect(judged(sent[0]!, k.verifier('svc-identity'), 'keypair')).toMatchObject({ service: 'svc-execution', scheme: 'keypair' });
  });

  it('the signature is for svc-identity, its path, its body and its method only', async () => {
    const k = keys();
    const [s] = await consume(k.s2s('keypair'));
    const identity = () => k.verifier('svc-identity');
    expect(judged(s!, k.verifier('svc-ledger'), 'keypair')).toMatchObject({ service: null });
    expect(judged({ ...s!, url: new URL('http://identity.test/trpc/actionApproval.get') }, identity(), 'keypair')).toMatchObject({
      service: null,
    });
    expect(judged({ ...s!, body: s!.body.replace('op-1', 'op-2') }, identity(), 'keypair')).toMatchObject({ service: null });
    expect(judged({ ...s!, method: 'GET' }, identity(), 'keypair')).toMatchObject({ service: null });
  });
});
