import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeExecutionHalt,
  createExecutionApprovalClient,
  executionHaltHash,
  EXECUTION_APPROVAL_UNWIRED,
  OperatorDeskError,
} from './operator-desk.js';

/**
 * The halt's identity consumer is the shared contracts client: it is bounded by a timeout, refuses a reply
 * it cannot read as a consumed approval for this request, and nothing is approved on those paths.
 */
const SECRET = randomBytes(24).toString('hex');
const TARGET = 'halt:acct-1';
const REQUEST = {
  approvalId: 'ap-1',
  operationId: 'op-1',
  payloadHash: executionHaltHash(TARGET),
  targetService: 'svc-execution',
  targetId: TARGET,
  expectedVersion: '1',
};
const approval = (over: Record<string, unknown> = {}) => ({
  ...REQUEST,
  actionType: 'execution.halt',
  requesterId: 'requester',
  approverId: 'approver',
  policyVersion: 'v1',
  createdAt: '2026-09-09T12:00:00.000Z',
  expiresAt: '2026-09-09T12:10:00.000Z',
  status: 'CONSUMED',
  ...over,
});
const client = (timeoutMs?: number) => createExecutionApprovalClient('http://identity.test/', SECRET, undefined, timeoutMs);

afterEach(() => vi.unstubAllGlobals());

describe('svc-execution halt approval client', () => {
  it('carries an abort signal on the call to identity', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ result: { data: approval() } })));
    vi.stubGlobal('fetch', fetchSpy);
    const consumed = await client().consume(REQUEST);
    expect(consumed.status).toBe('CONSUMED');
    expect(fetchSpy.mock.calls[0]![0]).toBe('http://identity.test/trpc/actionApproval.consume');
    expect(fetchSpy.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it('a hung identity fails closed with the execution error and approves nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
      ),
    );
    const err = await consumeExecutionHalt(client(20), {
      approvalId: 'ap-1',
      operationId: 'op-1',
      targetId: TARGET,
      requesterId: 'requester',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OperatorDeskError);
    expect((err as OperatorDeskError).code).toBe(EXECUTION_APPROVAL_UNWIRED);
  });

  it('refuses an ok reply that is not an action approval with the execution error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ result: { data: { nope: true } } }))),
    );
    const err = await client()
      .consume(REQUEST)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OperatorDeskError);
    expect((err as OperatorDeskError).code).toBe(EXECUTION_APPROVAL_UNWIRED);
  });

  it('refuses a reply that is not JSON, a refused status, and an echo for another request', async () => {
    for (const res of [
      () => new Response('<html>', { status: 200 }),
      () => new Response('no', { status: 403 }),
      () => new Response(JSON.stringify({ result: { data: approval({ targetId: 'halt:other' }) } })),
      () => new Response(JSON.stringify({ result: { data: approval({ status: 'PENDING' }) } })),
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => res()),
      );
      await expect(client().consume(REQUEST)).rejects.toBeInstanceOf(OperatorDeskError);
    }
  });
});
