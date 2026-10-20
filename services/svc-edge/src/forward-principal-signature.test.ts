import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueAccessToken, verifyAccessToken, type Principal, type TokenConfig } from '@intafaced/auth';
import { EDGE_PRINCIPAL_HEADER, EDGE_SIGNATURE_HEADER, generateEdgePrincipalKeyPair, verifyForwardedPrincipal } from '@intafaced/contracts';
import { createHttpEdgeApprovalConsumer } from './action-approval-consume.js';
import { httpMatchingOperator } from './matching-operator-door.js';

const EDGE_SECRET = 'edge-principal-secret-at-least-32-characters';
const OPERATOR = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const limits = { maxLifetimeSeconds: 60, clockSkewSeconds: 5 };
// Generated per run and never written down: only the test process ever holds this private key.
const pair = generateEdgePrincipalKeyPair();
const signing = { privateKey: pair.privateKey, maxLifetimeSeconds: 60 };

const tokens: TokenConfig = {
  secret: 'test-only-signing-secret-at-least-32-characters-long',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

async function founder(): Promise<Principal> {
  const { token } = await issueAccessToken(
    { userId: OPERATOR, sessionId: SESSION, scopes: ['admin:read', 'admin:write'], tier: 'institutional', mfa: true },
    tokens,
  );
  return verifyAccessToken(token, tokens);
}

const consumeInput = {
  approvalId: 'appr-1',
  operationId: 'op-1',
  payloadHash: 'sha256:abc',
  targetService: 'svc-edge',
  targetId: 'edge.kill_switch',
  expectedVersion: '1',
};

function captureFetch(reply: () => Response) {
  const calls: Array<Record<string, string>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init.headers as Record<string, string>);
      return reply();
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('every door that forwards a principal signs with the edge key when one is configured', () => {
  it('the matching operator door', async () => {
    const operator = await founder();
    const calls = captureFetch(() => new Response('{}', { status: 200 }));
    await httpMatchingOperator('http://matching.test', 1000, EDGE_SECRET, signing)('/operator/halt', 'POST', operator, {}, 'GB');
    const headers = calls[0]!;
    expect(headers[EDGE_SIGNATURE_HEADER]).toMatch(/^ed25519:/);
    const verified = verifyForwardedPrincipal(
      headers[EDGE_PRINCIPAL_HEADER],
      headers[EDGE_SIGNATURE_HEADER],
      { publicKey: pair.publicKey, limits },
      new Date(),
      'GB',
    );
    expect(verified.rejected).toBeNull();
    expect(verified.principal?.userId).toBe(OPERATOR);
    // The shared secret does not accept it.
    expect(
      verifyForwardedPrincipal(headers[EDGE_PRINCIPAL_HEADER], headers[EDGE_SIGNATURE_HEADER], EDGE_SECRET, new Date(), 'GB').principal,
    ).toBeNull();
  });

  it('the matching operator door still signs with the shared secret when no key is set', async () => {
    const operator = await founder();
    const calls = captureFetch(() => new Response('{}', { status: 200 }));
    await httpMatchingOperator('http://matching.test', 1000, EDGE_SECRET)('/operator/halt', 'POST', operator, {}, 'GB');
    const headers = calls[0]!;
    expect(headers[EDGE_SIGNATURE_HEADER]).not.toMatch(/^ed25519:/);
    expect(
      verifyForwardedPrincipal(headers[EDGE_PRINCIPAL_HEADER], headers[EDGE_SIGNATURE_HEADER], EDGE_SECRET, new Date(), 'GB').principal
        ?.userId,
    ).toBe(OPERATOR);
  });

  it('the approval consume call to identity', async () => {
    const operator = await founder();
    const calls = captureFetch(() => new Response('{}', { status: 500 }));
    const consumer = createHttpEdgeApprovalConsumer({
      identityUrl: 'http://identity.test',
      edgeSecret: EDGE_SECRET,
      region: 'GB',
      ed25519: signing,
    });
    await expect(consumer.consume(consumeInput, operator)).rejects.toMatchObject({ code: 'action_approval.consume_failed' });
    const headers = calls[0]!;
    expect(headers[EDGE_SIGNATURE_HEADER]).toMatch(/^ed25519:/);
    const verified = verifyForwardedPrincipal(
      headers[EDGE_PRINCIPAL_HEADER],
      headers[EDGE_SIGNATURE_HEADER],
      { publicKey: pair.publicKey, limits },
      new Date(),
      'GB',
    );
    expect(verified.principal?.userId).toBe(OPERATOR);
  });

  it('bounds the consume call with a timeout signal, and a timeout rejects instead of approving', async () => {
    const operator = await founder();
    const signals: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      signals.push(init.signal);
      throw new DOMException('The operation timed out', 'TimeoutError');
    });
    const consumer = createHttpEdgeApprovalConsumer({ identityUrl: 'http://identity.test', edgeSecret: EDGE_SECRET, region: 'GB' });
    await expect(consumer.consume(consumeInput, operator)).rejects.toBeTruthy();
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['a reply that is not an approval', () => new Response(JSON.stringify({ result: { data: { ok: true } } }), { status: 200 })],
    ['an empty reply', () => new Response('{}', { status: 200 })],
  ])('refuses %s with a typed error', async (_name, reply) => {
    const operator = await founder();
    captureFetch(reply);
    const consumer = createHttpEdgeApprovalConsumer({ identityUrl: 'http://identity.test', edgeSecret: EDGE_SECRET, region: 'GB' });
    await expect(consumer.consume(consumeInput, operator)).rejects.toMatchObject({
      name: 'ActionApprovalConsumeError',
      code: 'action_approval.consume_failed',
    });
  });
});
