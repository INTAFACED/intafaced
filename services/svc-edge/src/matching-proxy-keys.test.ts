import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createServiceSigner,
  createServiceVerifier,
  verifyServiceRequest,
  type Keyring,
  type ServiceAuthMode,
  type ServiceName,
} from '@intafaced/contracts';
import { httpMatchingControl } from './matching-proxy.js';
import type { EdgeS2s } from './s2s.js';

/**
 * The operator door onto svc-matching: svc-edge signs its svc-matching calls with its own key once S2S is on.
 * The receiver here is the contracts verifier svc-matching uses, fed the request exactly as it went on the wire.
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
    verifier: (self: ServiceName = 'svc-matching') => createServiceVerifier({ self, keyring, bootSecond: 0 }),
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

const halt = { operatorId: 'op-1', confirmOperatorId: 'op-2', approvalId: 'ap-1', operationId: 'oid-1' };

async function call(req: Parameters<ReturnType<typeof httpMatchingControl>>[0], s2s?: EdgeS2s): Promise<Sent> {
  const { sent, fetchStub } = recorder(() => new Response('{}', { status: 200 }));
  await httpMatchingControl('http://matching.test/', SECRET, 1000, fetchStub, s2s)(req);
  expect(sent).toHaveLength(1);
  return sent[0]!;
}
const run = (s2s?: EdgeS2s) => call({ method: 'POST', path: '/markets/BTC-USDT/halt', body: halt }, s2s);

describe('svc-edge -> svc-matching control write', () => {
  it('without a signing key the call is signed with the shared secret as before', async () => {
    const k = keys();
    const sent = await run();
    expect(sent.url.pathname).toBe('/markets/BTC-USDT/halt');
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

  it('is signed for svc-matching only, and a signed call moved to another path, method or body is refused', async () => {
    const k = keys();
    const sent = await run(k.s2s('keypair'));
    expect(judged(sent, k.verifier('svc-ledger'), 'keypair')).toMatchObject({ service: null, rejected: 'wrong-audience' });
    const moved = { ...sent, url: new URL('http://x.test/internal/other') };
    expect(judged(moved, k.verifier(), 'keypair')).toMatchObject({ service: null, rejected: 'bad-signature' });
    expect(judged({ ...sent, method: 'GET' }, k.verifier(), 'keypair')).toMatchObject({ service: null, rejected: 'bad-signature' });
    expect(judged({ ...sent, body: sent.body + ' ' }, k.verifier(), 'keypair')).toMatchObject({ service: null });
    expect(judged(sent, k.verifier(), 'keypair')).toMatchObject({ service: 'svc-edge' });
  });

  it('the surveillance read is signed over its query, so the page size cannot be changed in flight', async () => {
    const k = keys();
    const sent = await call({ method: 'GET', path: '/surveillance/cases?limit=5' }, k.s2s('keypair'));
    expect(sent.url.search).toBe('?limit=5');
    expect(sent.headers['content-type']).toBeUndefined();
    expect(judged(sent, k.verifier(), 'keypair')).toMatchObject({ service: 'svc-edge', scheme: 'keypair' });
    const wider = { ...sent, url: new URL('http://matching.test/surveillance/cases?limit=500') };
    expect(judged(wider, k.verifier(), 'keypair')).toMatchObject({ service: null, rejected: 'bad-signature' });
  });

  it('unset, the health read is the shared-secret form as before', async () => {
    const k = keys();
    const sent = await call({ method: 'GET', path: '/health' });
    expect(noS2sHeaders(sent)).toBe(true);
    expect(judged(sent, k.verifier())).toMatchObject({ service: 'svc-edge', scheme: 'shared' });
  });
});
