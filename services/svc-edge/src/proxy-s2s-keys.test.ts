import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createServiceSigner,
  createServiceVerifier,
  router,
  serviceProcedure,
  serviceProcedureFor,
  verifyServiceRequest,
  type Context,
  type Keyring,
  type ServiceAuthMode,
  type ServiceName,
} from '@intafaced/contracts';
import { stripReserved } from './principal-exchange.js';
import { prepareUpstreamRequestHeaders } from './refresh-cookie-proxy.js';
import { REQUEST_ID_HEADER } from './reply-envelope.js';
import { identityCallHeaders, type EdgeS2s } from './s2s.js';

const INDEX = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
/** The proxy's upstream headers, exactly as `index.ts` builds them (the first test holds the two together). */
const FORWARD_EXPRESSION =
  'const upstreamHeaders = { ...prepareUpstreamRequestHeaders(url.pathname, exchanged.headers), [REQUEST_ID_HEADER]: String(req.id) };';
const proxyForwardHeaders = (pathname: string, headers: Record<string, string>, requestId: string) => ({
  ...prepareUpstreamRequestHeaders(pathname, headers),
  [REQUEST_ID_HEADER]: requestId,
});

/**
 * The proxy forward carries no service identity, whatever the edge's S2S mode. The edge's own service calls are still
 * signed with its key. The receiver here is the contracts verifier and real tRPC service doors, fed the request as it
 * would go on the wire. Keys are generated per run.
 */
function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const keyring: Keyring = [{ kid: 'svc-edge.a', svc: 'svc-edge', use: 's2s', x }];
  const signer = createServiceSigner({ service: 'svc-edge', kid: 'svc-edge.a', privateKey: pkcs8, keyring });
  return {
    s2s: (mode: ServiceAuthMode): EdgeS2s => ({ signer, mode }),
    verifier: (self: ServiceName) => createServiceVerifier({ self, keyring, bootSecond: 0 }),
  };
}

const AWARD_XP = 'http://identity.test/trpc/rank.awardXp';
const BODY = '{"userId":"u-victim","xp":"1000000"}';

/** What a caller sends to the edge, including headers that try to pass as a service. */
const callerHeaders = {
  'content-type': 'application/json',
  'x-intafaced-s2s-kid': 'svc-edge.a',
  'X-Intafaced-S2S-Signature': 'sig',
  'x-intafaced-service': 'svc-edge',
  'x-intafaced-signature': 'sig',
  cookie: 'if_refresh=abc',
  accept: 'application/json',
};

const doors = router({
  anyService: serviceProcedure.mutation(() => ({ ok: true })),
  edgeOnly: serviceProcedureFor(['svc-edge']).mutation(() => ({ ok: true })),
});

const ctxFor = (service: string | null): Context => ({ principal: null, service, region: 'DE', requestId: 'r1' }) as Context;

function judged(k: ReturnType<typeof keys>, headers: Record<string, string>, url = AWARD_XP, body = BODY) {
  const u = new URL(url);
  return verifyServiceRequest(
    { method: 'POST', url: u.pathname + u.search, headers, body },
    { verifier: k.verifier('svc-identity'), mode: 'keypair' },
  );
}

describe('the proxy forward carries no service identity', () => {
  it('index.ts builds the forward from the caller headers and the request id, and signs nothing itself', () => {
    expect(INDEX).toContain(FORWARD_EXPRESSION);
    expect(INDEX.match(/const upstreamHeaders\b/g)).toHaveLength(1);
    for (const signing of ['.signer.headers(', 's2sRequestHeaders(', 'serviceCallSigner(', 's2sFetch(', 'signProxyHeaders']) {
      expect(INDEX).not.toContain(signing);
    }
  });

  it('sends the caller headers as prepared, the request id, and no service header of any kind', () => {
    const headers = proxyForwardHeaders('/api/identity/trpc/rank.awardXp', stripReserved(callerHeaders), 'req-1');
    expect(headers).toEqual({ 'content-type': 'application/json', accept: 'application/json', 'x-request-id': 'req-1' });
    expect(Object.keys(headers).filter((h) => h.toLowerCase().startsWith('x-intafaced-'))).toEqual([]);
  });

  it('keeps the edge-signed principal and region it was handed', () => {
    const exchanged = {
      'x-intafaced-principal': 'eyJ1c2VyIjoiYSJ9',
      'x-intafaced-principal-sig': 'ed25519:c2ln',
      'x-intafaced-region': 'DE',
    };
    expect(proxyForwardHeaders('/api/trade/trpc/orders.create', exchanged, 'req-2')).toEqual({ ...exchanged, 'x-request-id': 'req-2' });
  });

  it('an anonymous forward reaches a service door as no service, and both kinds of service door refuse it', async () => {
    const k = keys();
    const headers = proxyForwardHeaders('/api/identity/trpc/rank.awardXp', stripReserved(callerHeaders), 'req-3');
    const verdict = judged(k, headers);
    expect(verdict.service).toBeNull();
    const caller = doors.createCaller(ctxFor(verdict.service));
    await expect(caller.anyService()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.edgeOnly()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it("the edge's own call is still signed as svc-edge and passes the door that names it", async () => {
    const k = keys();
    for (const mode of ['dual', 'keypair'] as const) {
      const headers = identityCallHeaders('s'.repeat(32), k.s2s(mode), {
        method: 'POST',
        target: AWARD_XP,
        body: BODY,
        contentType: 'application/json',
      });
      // The caller sends the content type it signed alongside (`agent-key-hold.ts`).
      const verdict = judged(k, { ...headers, 'content-type': 'application/json' });
      expect(verdict).toMatchObject({ service: 'svc-edge', scheme: 'keypair', rejected: null });
      await expect(doors.createCaller(ctxFor(verdict.service)).edgeOnly()).resolves.toEqual({ ok: true });
    }
  });

  it('a browser cannot bring its own service signature: every x-intafaced-* header is stripped', () => {
    const stripped = stripReserved({
      'x-intafaced-s2s-kid': 'svc-trade.a',
      'X-Intafaced-S2S-Signature': 'sig',
      'x-intafaced-service': 'svc-ledger',
      'x-intafaced-signature': 'sig',
      accept: 'application/json',
    });
    expect(stripped).toEqual({ accept: 'application/json' });
  });
});
