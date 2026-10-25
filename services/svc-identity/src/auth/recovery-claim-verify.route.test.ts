import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { retainRawBody, serviceAuthHeaders, serviceAuthHeadersForBody } from '@intafaced/contracts';
import {
  RECOVERY_CLAIM_VERIFY_PATH,
  recoveryClaimVerdictSchema,
  recoveryEstatesPath,
  recoveryEstatesSchema,
  type RecoveryEstate,
  type RecoveryClaimVerdict,
  type RecoveryClaimVerifyRequest,
} from '@intafaced/contracts/identity-recovery';
import { registerRecoveryClaimVerifyRoute } from './recovery-claim-verify.js';

const SECRET = 'r'.repeat(32);
const USER = '11111111-1111-4111-8111-111111111111';
const HEIR = '22222222-2222-4222-8222-222222222222';
const CLAIM = '33333333-3333-4333-8333-333333333333';
const NOTICE = '44444444-4444-4444-8444-444444444444';
const KEY = '55555555-5555-4555-8555-555555555555';
const OK: RecoveryClaimVerdict = { ok: true, noticeId: NOTICE, threshold: 1, signerKeyIds: [KEY] };

function body(over: Partial<RecoveryClaimVerifyRequest> = {}): RecoveryClaimVerifyRequest {
  return {
    userId: USER,
    heirUserId: HEIR,
    claimId: CLAIM,
    signatures: [{ publicKey: { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) }, signature: 'C'.repeat(86) }],
    ...over,
  };
}

const ESTATE: RecoveryEstate = { userId: USER, handle: 'TESTowner', noticeId: NOTICE, threshold: 2, liveKeys: 2 };

async function app(
  verify: (input: RecoveryClaimVerifyRequest) => Promise<RecoveryClaimVerdict>,
  secret: string | null = SECRET,
  estates: (heirUserId: string) => Promise<RecoveryEstate[]> = async () => [ESTATE],
) {
  const server = Fastify({ logger: false });
  retainRawBody(server);
  registerRecoveryClaimVerifyRoute(server, { verify, estates, internalSecret: secret ?? undefined });
  await server.ready();
  return server;
}

function post(payload: unknown, service = 'svc-bank') {
  const raw = JSON.stringify(payload);
  return {
    method: 'POST' as const,
    url: RECOVERY_CLAIM_VERIFY_PATH,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, raw) },
    payload: raw,
  };
}

describe('POST /internal/recovery-claims/verify', () => {
  it('needs service credentials, and only svc-bank may ask', async () => {
    const asked: RecoveryClaimVerifyRequest[] = [];
    const server = await app(async (input) => {
      asked.push(input);
      return OK;
    });
    expect((await server.inject({ method: 'POST', url: RECOVERY_CLAIM_VERIFY_PATH, payload: body() })).statusCode).toBe(401);
    for (const service of ['svc-trade', 'svc-ops', 'svc-edge']) {
      const other = await server.inject(post(body(), service));
      expect(other.statusCode).toBe(403);
      expect(other.json().code).toBe('identity.recovery_verifier_refused');
    }
    expect(asked).toHaveLength(0);

    const ok = await server.inject(post(body()));
    expect(ok.statusCode).toBe(200);
    expect(recoveryClaimVerdictSchema.parse(ok.json())).toEqual(OK);
    expect(asked).toEqual([body()]);
  });

  it('answers a refusal as a verdict, for the caller to refuse the claim with', async () => {
    const server = await app(async () => ({ ok: false, code: 'identity.recovery_signatures_short' }));
    const res = await server.inject(post(body()));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, code: 'identity.recovery_signatures_short' });
  });

  it('refuses a malformed claim before anything is read', async () => {
    let calls = 0;
    const server = await app(async () => {
      calls += 1;
      return OK;
    });
    const sig = body().signatures[0]!;
    for (const bad of [
      { ...body(), userId: 'not-a-user' },
      { ...body(), signatures: [] },
      { ...body(), signatures: Array.from({ length: 33 }, () => sig) },
      { ...body(), signatures: [{ ...sig, signature: 'short' }] },
      { ...body(), signatures: [{ ...sig, publicKey: { ...sig.publicKey, d: 'D'.repeat(43) } }] },
      { ...body(), extra: true },
    ]) {
      const res = await server.inject(post(bad));
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('identity.recovery_claim_invalid');
    }
    expect(calls).toBe(0);
  });

  it('refuses everything when no service secret is configured', async () => {
    const server = await app(async () => OK, null);
    expect((await server.inject(post(body()))).statusCode).toBe(401);
  });
});

describe('GET /internal/recovery-claims/estates/:heirUserId', () => {
  const get = (url: string, service = 'svc-bank') => ({ method: 'GET' as const, url, headers: serviceAuthHeaders(service, SECRET) });

  it('needs service credentials, only svc-bank may ask, and the id must be an id', async () => {
    const asked: string[] = [];
    const server = await app(
      async () => OK,
      SECRET,
      async (heir) => {
        asked.push(heir);
        return [ESTATE];
      },
    );
    expect((await server.inject({ method: 'GET', url: recoveryEstatesPath(HEIR) })).statusCode).toBe(401);
    const other = await server.inject(get(recoveryEstatesPath(HEIR), 'svc-trade'));
    expect(other.statusCode).toBe(403);
    expect((await server.inject(get(recoveryEstatesPath('not-an-id')))).statusCode).toBe(400);
    expect(asked).toHaveLength(0);
    const ok = await server.inject(get(recoveryEstatesPath(HEIR)));
    expect(ok.statusCode).toBe(200);
    expect(recoveryEstatesSchema.parse(ok.json())).toEqual({ estates: [ESTATE] });
    expect(asked).toEqual([HEIR]);
  });
});
