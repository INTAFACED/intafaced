import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActionApprovalConsumeError,
  createIdentityApprovalClient,
  disputeResolvePayloadHash,
  p2pActionPayloadHash,
  readApprovalIds,
  stubApprovalConsumer,
  unwiredApprovalConsumer,
} from './action-approval-consume.js';

const CONSUME_INPUT = {
  approvalId: 'appr-1',
  operationId: 'op-1',
  payloadHash: 'sha256:abc',
  targetService: 'svc-p2p',
  targetId: 'p2p.method_register',
  expectedVersion: '1',
} as const;

const CONSUMED = {
  ...CONSUME_INPUT,
  actionType: 'p2p.method_register',
  requesterId: 'requester',
  approverId: 'approver',
  policyVersion: 'v1',
  createdAt: '2026-09-09T12:00:00.000Z',
  expiresAt: '2026-09-09T12:10:00.000Z',
  status: 'CONSUMED' as const,
};

describe('p2p action-approval consume', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('payload hash is stable for the same method register', () => {
    expect(p2pActionPayloadHash('p2p.method_register', { methodId: 'bank_transfer', country: 'DE', label: 'SEPA' })).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(p2pActionPayloadHash('p2p.method_register', { methodId: 'a', country: 'DE', label: 'x' })).not.toBe(
      p2pActionPayloadHash('p2p.method_register', { methodId: 'b', country: 'DE', label: 'x' }),
    );
  });

  it('stub consumes and echoes the approver', async () => {
    await expect(stubApprovalConsumer('approver').consume(CONSUME_INPUT)).resolves.toMatchObject({
      approvalId: 'appr-1',
      operationId: 'op-1',
      targetService: 'svc-p2p',
      approverId: 'approver',
      status: 'CONSUMED',
    });
  });

  it('blank IDENTITY_URL consumer refuses instead of inventing a second person', async () => {
    await expect(unwiredApprovalConsumer().consume(CONSUME_INPUT)).rejects.toMatchObject({
      code: 'action_approval.identity_unwired',
    });
  });

  it('typed-in names without approval ids refuse', () => {
    expect(() => readApprovalIds({ approvalId: null, operationId: null })).toThrow(ActionApprovalConsumeError);
    expect(() => readApprovalIds({ approvalId: '  ', operationId: 'op-1' })).toThrow(/typed-in second name/);
    expect(readApprovalIds({ approvalId: 'appr-1', operationId: 'op-1' })).toEqual({
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
  });

  it('hashes a dispute ruling as actionType, dispute id, winner and note', () => {
    expect(
      disputeResolvePayloadHash({
        disputeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        winner: 'buyer',
        note: 'paid',
      }),
    ).toBe('sha256:ff6776150a35b57a81d161a01de981927c88070e944b99bbf2da6a709323b65a');
    expect(
      disputeResolvePayloadHash({
        disputeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        winner: 'seller',
        note: 'paid',
      }),
    ).not.toBe(
      disputeResolvePayloadHash({
        disputeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        winner: 'buyer',
        note: 'paid',
      }),
    );
  });

  it('unwraps tRPC result.data.json from identity consume', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ result: { data: { json: CONSUMED } } }), { status: 200 })),
    );
    const client = createIdentityApprovalClient('http://identity.example', 'p2p-internal-secret-at-least-32-chars');
    await expect(client.consume(CONSUME_INPUT)).resolves.toMatchObject({
      approvalId: 'appr-1',
      status: 'CONSUMED',
      approverId: 'approver',
    });
  });

  it('refuses a reply that is not the approval asked for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ result: { data: { ...CONSUMED, approvalId: 'appr-OTHER' } } }), { status: 200 })),
    );
    const client = createIdentityApprovalClient('http://identity.example', 'p2p-internal-secret-at-least-32-chars');
    await expect(client.consume(CONSUME_INPUT)).rejects.toMatchObject({ code: 'action_approval.consume_failed' });
  });
});
