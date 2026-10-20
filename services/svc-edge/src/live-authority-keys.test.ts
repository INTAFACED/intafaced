import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it, afterEach } from 'vitest';
import {
  createServiceSigner,
  createServiceVerifier,
  verifyServiceRequest,
  type Keyring,
  type ServiceAuthMode,
  type ServiceName,
} from '@intafaced/contracts';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { readEdgeAuthority, resetEdgeAuthorityState } from './live-authority.js';
import type { EdgeS2s } from './s2s.js';

/**
 * The current-authority read: svc-edge signs its svc-identity call with its own key once S2S is on.
 * The receiver here is the contracts verifier svc-identity uses, fed the request exactly as it went on the wire.
 * Keys are generated per run.
 */
const tokens = { secret: randomBytes(24).toString('hex'), issuer: 'intafaced', audience: 'intafaced.api', accessTtlSeconds: 900 };
const userId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';

const SECRET = randomBytes(24).toString('hex');

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const keyring: Keyring = [{ kid: 'svc-edge.a', svc: 'svc-edge', use: 's2s', x }];
  const signer = createServiceSigner({ service: 'svc-edge', kid: 'svc-edge.a', privateKey: pkcs8, keyring });
  return {
    s2s: (mode: ServiceAuthMode): EdgeS2s => ({ signer, mode }),
    verifier: (self: ServiceName = 'svc-identity') => createServiceVerifier({ self, keyring, bootSecond: 0 }),
  };
}

type Sent = { url: URL; method: string; headers: Record<string, string>; body: string };

function recorder(answer: () => Response = () => new Response('{}', { status: 500 })) {
  const sent: Sent[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: init?.body === undefined ? '' : String(init.body),
    });
    return answer();
  }) as typeof fetch;
  return { sent, fetchStub };
}

const judged = (s: Sent, verifier: ReturnType<ReturnType<typeof keys>['verifier']>, mode?: ServiceAuthMode) =>
  verifyServiceRequest(
    { method: s.method, url: s.url.pathname + s.url.search, headers: s.headers, body: s.body },
    { verifier, legacySecret: SECRET, mode },
  );

const noS2sHeaders = (s: Sent) => !Object.keys(s.headers).some((h) => h.startsWith('x-intafaced-s2s-'));

afterEach(() => resetEdgeAuthorityState());

async function run(s2s?: EdgeS2s): Promise<Sent> {
  const { token } = await issueAccessToken({ userId, sessionId, scopes: ['identity:read'], mfa: true, tier: 'full' }, tokens);
  const principal = await verifyAccessToken(token, tokens);
  const { sent, fetchStub } = recorder();
  await readEdgeAuthority(principal, { identityUrl: 'http://identity.test', identityOwnershipSecret: SECRET, s2s, fetch: fetchStub });
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

describe('svc-edge -> svc-identity current-authority read', () => {
  it('without a signing key the call is signed with the shared secret as before', async () => {
    const k = keys();
    const sent = await run();
    expect(sent.url.pathname).toBe('/trpc/accountControls.currentAuthority');
    expect(sent.method).toBe('POST');
    expect(noS2sHeaders(sent)).toBe(true);
    expect(judged(sent, k.verifier())).toMatchObject({ service: 'svc-edge', scheme: 'shared' });
  });

  it('dual: the receiver names the caller from the key, and the shared secret rides along', async () => {
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

  it('is signed for svc-identity only, and a signed call moved to another path, method or body is refused', async () => {
    const k = keys();
    const sent = await run(k.s2s('keypair'));
    expect(judged(sent, k.verifier('svc-ledger'), 'keypair')).toMatchObject({ service: null, rejected: 'wrong-audience' });
    const moved = { ...sent, url: new URL('http://x.test/internal/other') };
    expect(judged(moved, k.verifier(), 'keypair')).toMatchObject({ service: null, rejected: 'bad-signature' });
    expect(judged({ ...sent, method: 'GET' }, k.verifier(), 'keypair')).toMatchObject({ service: null, rejected: 'bad-signature' });
    expect(judged({ ...sent, body: sent.body + ' ' }, k.verifier(), 'keypair')).toMatchObject({ service: null });
    expect(judged(sent, k.verifier(), 'keypair')).toMatchObject({ service: 'svc-edge' });
  });
});
