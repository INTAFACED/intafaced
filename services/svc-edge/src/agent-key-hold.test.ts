import { describe, expect, it } from 'vitest';
import { agentHeldAction, holdAgentKeyAttempt, requestBodyHash } from './agent-key-hold.js';

const USER = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';
const APPROVAL = {
  id: '33333333-3333-4333-8333-333333333333',
  keyId: KEY,
  keyName: 'agent-reader',
  action: 'pay.payout',
  method: 'POST',
  path: '/api/pay/trpc/settlement.payout',
  status: 'waiting',
  createdAt: '2026-11-09T13:00:00.000Z',
};

describe('agentHeldAction (J-developer-15 #6)', () => {
  it('holds a payout and a refund, alone or inside a tRPC batch, encoded or not', () => {
    expect(agentHeldAction('POST', '/api/pay/trpc/settlement.payout')).toBe('pay.payout');
    expect(agentHeldAction('post', '/api/pay/trpc/payment.refund')).toBe('pay.refund');
    expect(agentHeldAction('POST', '/api/pay/trpc/payment.get,settlement.payout')).toBe('pay.payout');
    expect(agentHeldAction('POST', '/api/pay/trpc/payment.get%2Csettlement.payout')).toBe('pay.payout');
  });

  it('holds nothing else: reads, other procedures, other services', () => {
    expect(agentHeldAction('GET', '/api/pay/trpc/settlement.payout')).toBeUndefined();
    expect(agentHeldAction('POST', '/api/pay/trpc/settlement.payoutPreview')).toBeUndefined();
    expect(agentHeldAction('POST', '/api/pay/trpc/settlement.run')).toBeUndefined();
    expect(agentHeldAction('GET', '/api/v1/account/balance')).toBeUndefined();
    expect(agentHeldAction('POST', '/api/trade/trpc/settlement.payout')).toBeUndefined();
  });

  it('holds a path it cannot decode', () => {
    expect(agentHeldAction('POST', '/api/pay/trpc/%E0%A4%A')).toBe('pay.payout');
  });
});

function reply(status: number, json: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
}

const base = {
  identityUrl: 'http://identity.test/',
  identityOwnershipSecret: 'edge-test-identity-authority-secret-32',
  userId: USER,
  keyId: KEY,
  action: 'pay.payout' as const,
  method: 'post',
  path: '/api/pay/trpc/settlement.payout?batch=1',
  body: Buffer.from('{"settlementId":"x"}'),
};

describe('holdAgentKeyAttempt', () => {
  it('asks identity with the action and the body hash, never the body', async () => {
    let sent: { url: string; body: Record<string, unknown> } | undefined;
    const fetchFn: typeof fetch = async (input, init) => {
      sent = { url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
      return new Response(JSON.stringify({ result: { data: { held: true, approval: APPROVAL } } }), { status: 200 });
    };
    const outcome = await holdAgentKeyAttempt({ ...base, fetch: fetchFn });
    expect(outcome).toEqual({ kind: 'held', approval: APPROVAL });
    expect(sent?.url).toBe('http://identity.test/trpc/developerKeys.holdAgentAction');
    expect(sent?.body).toEqual({
      userId: USER,
      keyId: KEY,
      action: 'pay.payout',
      method: 'POST',
      path: '/api/pay/trpc/settlement.payout',
      bodyHash: requestBodyHash(base.body),
    });
    expect(JSON.stringify(sent?.body)).not.toContain('settlementId');
  });

  it('a key that is not an agent key is not held', async () => {
    expect(await holdAgentKeyAttempt({ ...base, fetch: reply(200, { result: { data: { json: { held: false } } } }) })).toEqual({
      kind: 'not_held',
    });
  });

  it('identity refusing the key refuses; identity down or unreadable is unavailable, never not held', async () => {
    expect(await holdAgentKeyAttempt({ ...base, fetch: reply(404, { error: {} }) })).toEqual({ kind: 'refused' });
    expect(await holdAgentKeyAttempt({ ...base, fetch: reply(503, {}) })).toEqual({ kind: 'unavailable' });
    expect(await holdAgentKeyAttempt({ ...base, fetch: reply(200, { result: { data: { held: 'yes' } } }) })).toEqual({
      kind: 'unavailable',
    });
    const down: typeof fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    expect(await holdAgentKeyAttempt({ ...base, fetch: down })).toEqual({ kind: 'unavailable' });
  });
});
