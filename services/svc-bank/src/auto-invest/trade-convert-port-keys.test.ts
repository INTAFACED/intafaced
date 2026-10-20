import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServiceSigner, createServiceVerifier, verifyServiceRequest, type Keyring, type ServiceAuthMode } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { tradeConvertPort } from './trade-convert-port.js';

/**
 * svc-bank signs its convert quote and execute calls with its own key once S2S is on.
 * The receiver is the contracts verifier the callee (svc-trade) uses, fed the request exactly as it went on the wire.
 * Keys are generated per run.
 */
const SECRET = 'test-internal-service-secret-32-chars';

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const keyring: Keyring = [{ kid: 'svc-bank.a', svc: 'svc-bank', use: 's2s', x }];
  const signer = createServiceSigner({ service: 'svc-bank', kid: 'svc-bank.a', privateKey: pkcs8, keyring });
  return {
    s2s: (mode: ServiceAuthMode) => ({ signer, mode }),
    verifier: () => createServiceVerifier({ self: 'svc-trade', keyring, bootSecond: 0 }),
  };
}

type Sent = { url: URL; method: string; headers: Record<string, string>; body: string };

function record(sent: Sent[], input: string | URL | Request, init?: RequestInit): void {
  sent.push({
    url: new URL(String(input)),
    method: init?.method ?? 'GET',
    headers: init?.headers as Record<string, string>,
    body: init?.body === undefined ? '' : String(init.body),
  });
}

const judged = (s: Sent, verifier: ReturnType<typeof createServiceVerifier>, mode?: ServiceAuthMode) =>
  verifyServiceRequest(
    { method: s.method, url: s.url.pathname + s.url.search, headers: s.headers, body: s.body },
    { verifier, legacySecret: SECRET, mode },
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const QUOTE = {
  quoteId: 'q-1',
  symbol: 'BTC/USDT',
  side: 'buy',
  requestedQty: '0.002',
  filledQty: '0.002',
  userNotional: '100',
  avgPrice: '50000',
  fullyFilled: true,
};
const EXECUTE = { quoteId: 'q-1', fillId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', inAmount: '100', outAmount: '0.002' };
const BUY = {
  userId: 'u-1',
  instructionId: 'i-1',
  fromAsset: 'USDT',
  toAsset: 'BTC',
  fromAmount: parseAmount('100'),
  clientConvertId: 'dca-keys-1',
};

describe('svc-bank -> svc-trade convert with its own key', () => {
  it('without a signing key the call is signed with the shared secret as before', async () => {
    const sent: Sent[] = [];
    const k = keys();
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/v1/markets')) {
        return json([{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true, limits: { amount: { min: '0.001' } } }]);
      }
      record(sent, input, init);
      if (url.includes('/trpc/standing.quote')) return json({ result: { data: QUOTE } });
      return json({ result: { data: EXECUTE } });
    }) as typeof fetch;
    await tradeConvertPort({
      baseUrl: 'http://trade.test',
      serviceSecret: SECRET,
      marketsLimit: 50,
      fetchImpl: fetchFn,
      s2s: undefined,
    }).convert(BUY);
    expect(sent.length).toBeGreaterThan(0);
    expect(Object.keys(sent[0]!.headers).some((h) => h.startsWith('x-intafaced-s2s-'))).toBe(false);
    expect(judged(sent[0]!, k.verifier())).toMatchObject({ service: 'svc-bank', scheme: 'shared' });
  });

  it('dual: the callee names the caller from the key, and the shared secret rides along', async () => {
    const sent: Sent[] = [];
    const k = keys();
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/v1/markets')) {
        return json([{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true, limits: { amount: { min: '0.001' } } }]);
      }
      record(sent, input, init);
      if (url.includes('/trpc/standing.quote')) return json({ result: { data: QUOTE } });
      return json({ result: { data: EXECUTE } });
    }) as typeof fetch;
    await tradeConvertPort({
      baseUrl: 'http://trade.test',
      serviceSecret: SECRET,
      marketsLimit: 50,
      fetchImpl: fetchFn,
      s2s: k.s2s('dual'),
    }).convert(BUY);
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) {
      expect(s.headers['x-intafaced-service']).toBe('svc-bank');
      expect(judged(s, k.verifier())).toEqual({ service: 'svc-bank', scheme: 'keypair', rejected: null });
    }
  });

  it('keypair: only the key signature is sent, and a keypair-only callee accepts it', async () => {
    const sent: Sent[] = [];
    const k = keys();
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/v1/markets')) {
        return json([{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true, limits: { amount: { min: '0.001' } } }]);
      }
      record(sent, input, init);
      if (url.includes('/trpc/standing.quote')) return json({ result: { data: QUOTE } });
      return json({ result: { data: EXECUTE } });
    }) as typeof fetch;
    await tradeConvertPort({
      baseUrl: 'http://trade.test',
      serviceSecret: SECRET,
      marketsLimit: 50,
      fetchImpl: fetchFn,
      s2s: k.s2s('keypair'),
    }).convert(BUY);
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) {
      expect(s.headers['x-intafaced-service']).toBeUndefined();
      expect(s.headers['x-intafaced-signature']).toBeUndefined();
      expect(judged(s, k.verifier(), 'keypair')).toMatchObject({ service: 'svc-bank', scheme: 'keypair' });
    }
  });

  it('a signed call moved to another path or method is refused', async () => {
    const sent: Sent[] = [];
    const k = keys();
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/v1/markets')) {
        return json([{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true, limits: { amount: { min: '0.001' } } }]);
      }
      record(sent, input, init);
      if (url.includes('/trpc/standing.quote')) return json({ result: { data: QUOTE } });
      return json({ result: { data: EXECUTE } });
    }) as typeof fetch;
    await tradeConvertPort({
      baseUrl: 'http://trade.test',
      serviceSecret: SECRET,
      marketsLimit: 50,
      fetchImpl: fetchFn,
      s2s: k.s2s('keypair'),
    }).convert(BUY);
    const first = sent[0]!;
    expect(judged(first, k.verifier(), 'keypair').service).toBe('svc-bank');
    const otherPath = { ...first, url: new URL('http://callee.test/elsewhere') };
    expect(judged(otherPath, k.verifier(), 'keypair')).toMatchObject({ service: null });
    const otherMethod = { ...first, method: first.method === 'POST' ? 'GET' : 'POST' };
    expect(judged(otherMethod, k.verifier(), 'keypair')).toMatchObject({ service: null });
  });
});
