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
import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { startBasketParent } from './oms-basket-start.js';
import { killBasketMatchingChildren, postBasketChildrenToMatching } from './oms-basket-matching.js';

/**
 * svc-execution signs its basket POST and DELETE calls to svc-matching with its own key once S2S is on.
 * The receiver here is the contracts verifier svc-matching uses, fed the request exactly as it went on the wire.
 */
const OP = '33333333-3333-4333-8333-333333333333';
const BTC_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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

function proofFor(marketId: string) {
  const observedAt = '2026-09-01T12:00:00.000Z';
  return createMarketLifecycleAdmissionProof(
    {
      marketId,
      ruleVersion: 'test.rules.v1',
      instrumentId: marketId,
      instrumentVersion: 'test.instrument.v1',
      state: 'OPEN',
      reasonCategory: 'NORMAL',
      reasonCode: 'trade.lifecycle.ready',
      effectiveAt: observedAt,
      observedAt,
      lastGoodState: 'OPEN',
      allowedActions: ['PLACE', 'PLACE_POST_ONLY'],
      transitionId: 'test.transition',
      evidenceRefs: ['test.evidence'],
    },
    'PLACE',
  );
}

function post(fetchFn: typeof fetch, s2s?: KeyedS2s, secret: string | undefined = SECRET) {
  const parent = startBasketParent({
    parentClientOrderId: 'p-basket',
    kind: 'basket',
    approved: true,
    legs: [{ name: 'BTC', qty: '0.5' }],
    partialFailurePolicy: 'refuse_all',
    credit: '100',
    remaining: '1.25',
    operatorId: OP,
    jobs: { enabled: true },
    matchingVenueHalt: { venueHalted: false },
    now: new Date('2026-09-01T12:00:00.000Z'),
  });
  if (!parent.ok) throw new Error(parent.reason);
  return postBasketChildrenToMatching({
    parent,
    legs: [
      {
        name: 'BTC',
        qty: '0.5',
        marketId: 'BTC-USDT',
        orderId: BTC_ID,
        side: 'buy',
        type: 'limit',
        tif: 'GTC',
        price: '100.25',
        accountId: 'acct-desk',
        lifecycleProof: proofFor('BTC-USDT'),
      },
    ],
    matchingUrl: 'http://matching.test',
    fetch: fetchFn,
    internalServiceSecret: secret,
    s2s,
  });
}

const kill = (fetchFn: typeof fetch, s2s?: KeyedS2s, secret: string | undefined = SECRET) =>
  killBasketMatchingChildren({
    children: [{ marketId: 'BTC-USDT', orderId: BTC_ID }],
    matchingUrl: 'http://matching.test',
    fetch: fetchFn,
    internalServiceSecret: secret,
    s2s,
  });

const ack = () => ({ accepted: true, sequence: 3 });

describe('svc-execution basket calls -> svc-matching with its own key', () => {
  it('without a signing key both calls are signed with the shared secret as before', async () => {
    const c = capture(ack);
    await post(c.fetch);
    await kill(c.fetch);
    expect(c.sent.map((s) => s.method)).toEqual(['POST', 'DELETE']);
    for (const s of c.sent) {
      expect(hasKeyHeaders(s)).toBe(false);
      expect(judged(s, keys().verifier('svc-matching'))).toMatchObject({ service: 'svc-execution', scheme: 'shared' });
    }
  });

  it('dual: matching names the caller from the key for the POST and the DELETE, and the shared secret rides along', async () => {
    const c = capture(ack);
    const k = keys();
    await post(c.fetch, k.s2s('dual'));
    await kill(c.fetch, k.s2s('dual'));
    expect(c.sent.map((s) => s.method)).toEqual(['POST', 'DELETE']);
    for (const s of c.sent) {
      expect(s.headers['x-intafaced-service']).toBe('svc-execution');
      expect(judged(s, k.verifier('svc-matching'))).toEqual({ service: 'svc-execution', scheme: 'keypair', rejected: null });
    }
  });

  it('keypair: only the key signature is sent, a blank shared secret is not a refusal, and matching accepts it', async () => {
    const c = capture(ack);
    const k = keys();
    expect(await post(c.fetch, k.s2s('keypair'), undefined)).toMatchObject({ ok: true });
    expect(await kill(c.fetch, k.s2s('keypair'), undefined)).toMatchObject({ ok: true, killed: true });
    expect(c.sent).toHaveLength(2);
    for (const s of c.sent) {
      expect(s.headers['x-intafaced-service']).toBeUndefined();
      expect(s.headers['x-intafaced-signature']).toBeUndefined();
      expect(judged(s, k.verifier('svc-matching'), 'keypair')).toMatchObject({ service: 'svc-execution', scheme: 'keypair' });
    }
  });

  it('a blank shared secret still refuses before any call while the service is not keypair-only', async () => {
    const c = capture(ack);
    const k = keys();
    expect(await post(c.fetch, undefined, '')).toMatchObject({ ok: false, reason: 'matching_service_auth_unconfigured' });
    expect(await kill(c.fetch, k.s2s('dual'), '')).toMatchObject({ ok: false, reason: 'matching_service_auth_unconfigured' });
    expect(c.sent).toHaveLength(0);
  });

  it('the POST body and path are bound: a changed body, path or method is refused', async () => {
    const c = capture(ack);
    const k = keys();
    await post(c.fetch, k.s2s('keypair'));
    await kill(c.fetch, k.s2s('keypair'));
    const [posted, deleted] = c.sent as [Sent, Sent];
    const matching = () => k.verifier('svc-matching');
    expect(judged(posted, matching(), 'keypair')).toMatchObject({ service: 'svc-execution' });
    expect(judged(deleted, matching(), 'keypair')).toMatchObject({ service: 'svc-execution' });
    expect(judged(posted, k.verifier('svc-ledger'), 'keypair')).toMatchObject({ service: null });
    expect(judged({ ...posted, body: posted.body.replace('0.5', '5') }, matching(), 'keypair')).toMatchObject({ service: null });
    expect(judged({ ...posted, url: new URL('http://matching.test/markets/ETH-USDT/orders') }, matching(), 'keypair')).toMatchObject({
      service: null,
    });
    expect(judged({ ...deleted, method: 'POST' }, matching(), 'keypair')).toMatchObject({ service: null });
  });
});
