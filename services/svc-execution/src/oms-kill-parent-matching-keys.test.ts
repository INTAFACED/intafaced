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
import { cancelKillParentMatching } from './oms-kill-parent-matching.js';

/**
 * svc-execution signs its DELETE cancels to svc-matching with its own key once S2S is on.
 * The receiver here is the contracts verifier svc-matching uses, fed the request exactly as it went on the wire.
 */
const CHILD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECRET = randomBytes(24).toString('hex');

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

function capture(respond: () => unknown): { sent: Sent[]; fetch: typeof fetch } {
  const sent: Sent[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? '' : String(init.body),
    });
    return new Response(JSON.stringify(respond()), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { sent, fetch: fetchFn };
}

const judged = (s: Sent, verifier: ReturnType<typeof createServiceVerifier>, mode?: ServiceAuthMode) =>
  verifyServiceRequest(
    { method: s.method, url: s.url.pathname + s.url.search, headers: s.headers, body: s.body },
    { verifier, legacySecret: SECRET, mode },
  );

const hasKeyHeaders = (s: Sent) => Object.keys(s.headers).some((h) => h.startsWith('x-intafaced-s2s-'));
const ack = () => ({ cancelled: true, sequence: 7 });

const cancel = (fetchFn: typeof fetch, s2s?: KeyedS2s, secret: string | undefined = SECRET) =>
  cancelKillParentMatching({
    children: [{ marketId: 'BTC-USDT', orderId: CHILD }],
    matchingUrl: 'http://matching.test',
    fetch: fetchFn,
    internalServiceSecret: secret,
    s2s,
  });

describe('svc-execution kill-parent cancel -> svc-matching with its own key', () => {
  it('without a signing key the cancel is signed with the shared secret as before', async () => {
    const c = capture(ack);
    const result = await cancel(c.fetch);
    expect(result).toMatchObject({ ok: true, killed: true });
    expect(hasKeyHeaders(c.sent[0]!)).toBe(false);
    expect(judged(c.sent[0]!, keys().verifier('svc-matching'))).toMatchObject({ service: 'svc-execution', scheme: 'shared' });
  });

  it('dual: matching names the caller from the key, and the shared secret rides along', async () => {
    const c = capture(ack);
    const k = keys();
    await cancel(c.fetch, k.s2s('dual'));
    expect(c.sent[0]!.method).toBe('DELETE');
    expect(c.sent[0]!.headers['x-intafaced-service']).toBe('svc-execution');
    expect(judged(c.sent[0]!, k.verifier('svc-matching'))).toEqual({ service: 'svc-execution', scheme: 'keypair', rejected: null });
  });

  it('keypair: only the key signature is sent, a blank shared secret is not a refusal, and matching accepts it', async () => {
    const c = capture(ack);
    const k = keys();
    const result = await cancel(c.fetch, k.s2s('keypair'), undefined);
    expect(result).toMatchObject({ ok: true, killed: true });
    expect(c.sent[0]!.headers['x-intafaced-service']).toBeUndefined();
    expect(c.sent[0]!.headers['x-intafaced-signature']).toBeUndefined();
    expect(judged(c.sent[0]!, k.verifier('svc-matching'), 'keypair')).toMatchObject({ service: 'svc-execution', scheme: 'keypair' });
  });

  it('a blank shared secret still refuses before any call while the service is not keypair-only', async () => {
    const c = capture(ack);
    const k = keys();
    expect(await cancel(c.fetch, undefined, '')).toMatchObject({ ok: false, reason: 'matching_service_auth_unconfigured' });
    expect(await cancel(c.fetch, k.s2s('dual'), '')).toMatchObject({ ok: false, reason: 'matching_service_auth_unconfigured' });
    expect(c.sent).toHaveLength(0);
  });

  it('the signature is for svc-matching only, and a signed cancel moved to another path or method is refused', async () => {
    const c = capture(ack);
    const k = keys();
    await cancel(c.fetch, k.s2s('keypair'));
    const sent = c.sent[0]!;
    expect(judged(sent, k.verifier('svc-ledger'), 'keypair')).toMatchObject({ service: null });
    const movedPath = { ...sent, url: new URL(`http://matching.test/markets/BTC-USDT/orders/${OTHER}`) };
    expect(judged(movedPath, k.verifier('svc-matching'), 'keypair')).toMatchObject({ service: null });
    const movedMethod = { ...sent, method: 'POST' };
    expect(judged(movedMethod, k.verifier('svc-matching'), 'keypair')).toMatchObject({ service: null });
  });
});
