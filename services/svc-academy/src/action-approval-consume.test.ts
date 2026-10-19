import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActionApprovalConsumeError,
  academyActionPayloadHash,
  createIdentityApprovalClient,
  readApprovalIds,
  unwiredApprovalConsumer,
} from './action-approval-consume.js';

describe('academy action-approval consume', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('payload hash is stable for the same appoint fields', () => {
    expect(academyActionPayloadHash('academy.ambassador.appoint', { userId: 'u-1' })).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(academyActionPayloadHash('academy.ambassador.appoint', { userId: 'a' })).not.toBe(
      academyActionPayloadHash('academy.ambassador.appoint', { userId: 'b' }),
    );
  });

  it('blank IDENTITY_URL consumer refuses instead of inventing a second person', async () => {
    await expect(
      unwiredApprovalConsumer().consume({
        approvalId: 'appr-1',
        operationId: 'op-1',
        payloadHash: 'sha256:abc',
        targetService: 'svc-academy',
        targetId: 'academy.ambassador.appoint',
        expectedVersion: '1',
      }),
    ).rejects.toMatchObject({ code: 'action_approval.identity_unwired' });
  });

  it('typed-in names without approval ids refuse', () => {
    expect(() => readApprovalIds({ approvalId: null, operationId: null })).toThrow(ActionApprovalConsumeError);
    expect(() => readApprovalIds({ approvalId: 'appr-1', operationId: '   ' })).toThrow(/typed-in second name|approvalId/);
  });

  it('unwraps tRPC JSON envelopes from identity', async () => {
    const row = {
      approvalId: 'appr-1',
      actionType: 'academy.ambassador.appoint',
      targetService: 'svc-academy',
      targetId: 'academy.ambassador.appoint',
      expectedVersion: '1',
      payloadHash: 'sha256:abc',
      requesterId: 'requester',
      approverId: 'approver',
      policyVersion: 'v1',
      createdAt: '2026-09-09T12:00:00.000Z',
      expiresAt: '2026-09-09T12:10:00.000Z',
      status: 'CONSUMED' as const,
      operationId: 'op-1',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ result: { data: { json: row } } }),
      })),
    );
    const client = createIdentityApprovalClient('http://identity.test', 'x'.repeat(32));
    await expect(
      client.consume({
        approvalId: 'appr-1',
        operationId: 'op-1',
        payloadHash: 'sha256:abc',
        targetService: 'svc-academy',
        targetId: 'academy.ambassador.appoint',
        expectedVersion: '1',
      }),
    ).resolves.toMatchObject({ approvalId: 'appr-1', approverId: 'approver', status: 'CONSUMED' });
  });
  it('refuses a reply that is not the approval asked for', async () => {
    const row = {
      approvalId: 'appr-OTHER',
      actionType: 'academy.ambassador.appoint',
      targetService: 'svc-academy',
      targetId: 'academy.ambassador.appoint',
      expectedVersion: '1',
      payloadHash: 'sha256:abc',
      requesterId: 'requester',
      approverId: 'approver',
      policyVersion: 'v1',
      createdAt: '2026-09-09T12:00:00.000Z',
      expiresAt: '2026-09-09T12:10:00.000Z',
      status: 'CONSUMED' as const,
      operationId: 'op-1',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ result: { data: row } }) })),
    );
    const client = createIdentityApprovalClient('http://identity.test', 'x'.repeat(32));
    await expect(
      client.consume({
        approvalId: 'appr-1',
        operationId: 'op-1',
        payloadHash: 'sha256:abc',
        targetService: 'svc-academy',
        targetId: 'academy.ambassador.appoint',
        expectedVersion: '1',
      }),
    ).rejects.toMatchObject({ code: 'action_approval.consume_failed' });
  });
});
