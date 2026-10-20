import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPS_APPROVAL_UNWIRED, OpsError } from './codes.js';
import { consumeFounderApproval, createOpsApprovalClient } from './operator-desks.js';

const REQUEST = {
  approvalId: 'appr-1',
  operationId: 'op-1',
  payloadHash: 'sha256:abc',
  targetService: 'svc-ops',
  targetId: 'restore',
  expectedVersion: '1',
};

function consumed(overrides: Record<string, string> = {}) {
  return {
    ...REQUEST,
    actionType: 'ops.restore.record',
    requesterId: 'requester',
    approverId: 'approver',
    policyVersion: 'v1',
    createdAt: '2026-10-17T00:00:00.000Z',
    expiresAt: '2026-10-17T00:10:00.000Z',
    status: 'CONSUMED',
    ...overrides,
  };
}

function stubOk(body: unknown) {
  const spy = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, json: async () => body }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('ops identity approval client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const client = () => createOpsApprovalClient('http://identity.test/', 'x'.repeat(32));

  it('bounds the call to identity with a timeout signal so a hung identity cannot hang the restore brake', async () => {
    const spy = stubOk({ result: { data: consumed() } });
    await client().consume(REQUEST);
    expect(spy.mock.calls[0]![0]).toBe('http://identity.test/trpc/actionApproval.consume');
    expect(spy.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it('fails closed when identity times out: a typed refusal, no approval', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }),
    );
    await expect(
      consumeFounderApproval(client(), {
        approvalId: 'appr-1',
        operationId: 'op-1',
        actionType: 'ops.restore.record',
        targetService: 'svc-ops',
        targetId: 'restore',
        fields: {},
        requesterId: 'requester',
      }),
    ).rejects.toMatchObject({ code: OPS_APPROVAL_UNWIRED });
  });

  it('refuses a malformed reply shape with the ops error class', async () => {
    stubOk({ result: { data: { status: 'CONSUMED' } } });
    const err = await client()
      .consume(REQUEST)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpsError);
    expect((err as OpsError).code).toBe(OPS_APPROVAL_UNWIRED);
  });

  it('refuses a reply that is not CONSUMED or does not echo the request', async () => {
    stubOk({ result: { data: consumed({ status: 'PENDING' }) } });
    await expect(client().consume(REQUEST)).rejects.toBeInstanceOf(OpsError);
    stubOk({ result: { data: consumed({ operationId: 'other' }) } });
    await expect(client().consume(REQUEST)).rejects.toBeInstanceOf(OpsError);
  });

  it('refuses when identity answers non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, text: async () => 'down' })),
    );
    await expect(client().consume(REQUEST)).rejects.toMatchObject({ code: OPS_APPROVAL_UNWIRED });
  });

  it('accepts a superjson-wrapped consumed reply', async () => {
    stubOk({ result: { data: { json: consumed() } } });
    await expect(client().consume(REQUEST)).resolves.toMatchObject({ status: 'CONSUMED' });
  });
});
