import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createServiceSigner, createServiceVerifier, verifyServiceRequest, type Keyring, type ServiceAuthMode } from '@intafaced/contracts';
import { assertIdentitySessionLive } from './session-revoked.js';
import type { EdgeS2s } from './s2s.js';

/**
 * Identity session ownership read: svc-edge signs it with its own key once S2S is on.
 * The receiver here is the contracts verifier svc-identity uses, fed the request exactly as it went on the wire.
 * Keys are generated per run.
 */
const SECRET = randomBytes(24).toString('hex');

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const keyring: Keyring = [{ kid: 'svc-edge.a', svc: 'svc-edge', use: 's2s', x }];
  const signer = createServiceSigner({ service: 'svc-edge', kid: 'svc-edge.a', privateKey: pkcs8, keyring });
  return {
    s2s: (mode: ServiceAuthMode): EdgeS2s => ({ signer, mode }),
    verifier: (self: 'svc-identity' | 'svc-ledger' = 'svc-identity') => createServiceVerifier({ self, keyring, bootSecond: 0 }),
  };
}

type Sent = { url: URL; method: string; headers: Record<string, string>; body: string };

async function run(s2s?: EdgeS2s): Promise<Sent> {
  const sent: Sent[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: init?.body === undefined ? '' : String(init.body),
    });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  await assertIdentitySessionLive({
    identityUrl: 'http://identity.test',
    sessionId: 'session-1',
    userId: 'user-1',
    identityOwnershipSecret: SECRET,
    s2s,
    fetch: fetchStub,
  }).catch(() => undefined);
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

const judged = (s: Sent, verifier: ReturnType<ReturnType<typeof keys>['verifier']>, mode?: ServiceAuthMode) =>
  verifyServiceRequest(
    { method: s.method, url: s.url.pathname + s.url.search, headers: s.headers, body: s.body },
    { verifier, legacySecret: SECRET, mode },
  );

describe('svc-edge -> svc-identity session ownership read', () => {
  it('without a signing key the call is signed with the shared secret as before', async () => {
    const k = keys();
    const sent = await run();
    expect(sent.url.pathname).toBe('/internal/sessions/session-1');
    expect(sent.method).toBe('GET');
    expect(Object.keys(sent.headers).some((h) => h.startsWith('x-intafaced-s2s-'))).toBe(false);
    expect(judged(sent, k.verifier())).toMatchObject({ service: 'svc-edge', scheme: 'shared' });
  });

  it('dual: svc-identity names the caller from the key, and the shared secret rides along', async () => {
    const k = keys();
    const sent = await run(k.s2s('dual'));
    expect(sent.headers['x-intafaced-service']).toBe('svc-edge');
    expect(judged(sent, k.verifier())).toEqual({ service: 'svc-edge', scheme: 'keypair', rejected: null });
  });

  it('keypair: only the key signature is sent, and a keypair-only receiver accepts it', async () => {
    const k = keys();
    const sent = await run(k.s2s('keypair'));
    expect(sent.headers['x-intafaced-service']).toBeUndefined();
    expect(sent.headers['x-intafaced-signature']).toBeUndefined();
    expect(judged(sent, k.verifier(), 'keypair')).toMatchObject({ service: 'svc-edge', scheme: 'keypair' });
  });

  it('is signed for svc-identity only, and a signed call moved to another path or method is refused', async () => {
    const k = keys();
    const sent = await run(k.s2s('keypair'));
    expect(judged(sent, k.verifier('svc-ledger'), 'keypair')).toMatchObject({ service: null, rejected: 'wrong-audience' });
    const moved = { ...sent, url: new URL('http://identity.test/internal/other') };
    expect(judged(moved, k.verifier(), 'keypair')).toMatchObject({ service: null, rejected: 'bad-signature' });
    expect(judged({ ...sent, method: 'POST' }, k.verifier(), 'keypair')).toMatchObject({ service: null, rejected: 'bad-signature' });
    expect(judged(sent, k.verifier(), 'keypair')).toMatchObject({ service: 'svc-edge' });
  });
});
