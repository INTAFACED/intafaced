import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../shared/api';
import { createApprovalReads, requestedApproval } from './withdrawal-approval-reads';

const owner = '11111111-1111-4111-8111-111111111111';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const request = {
  id,
  userId: owner,
  assetId: 'USDT',
  amount: '60',
  rail: 'card-sandbox',
  destination: { kind: 'bank', ref: 'private' },
  clientRef: 'w-1',
  teamAccountId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  requiredApprovals: 2,
  approvalCount: 1,
  approvedByMe: false,
  holdAtSubmit: true,
  status: 'pending',
  failureCode: null,
  expiresAt: '2026-10-21T09:20:00Z',
  createdAt: '2026-10-20T09:20:00Z',
  decidedAt: null,
};
const wire = (data: unknown) => new Response(JSON.stringify({ result: { data } }));

describe('withdrawal approval reads', () => {
  it('admits only one UUID requestId, lower-casing a canonical one', () => {
    expect(requestedApproval('')).toEqual({ ok: true, id: null });
    expect(requestedApproval('?requestId=' + id.toUpperCase())).toEqual({ ok: true, id });
    for (const search of ['?requestId=', '?requestId=1', `?requestId=${id}&requestId=${id}`])
      expect(requestedApproval(search)).toEqual({ ok: false });
  });

  it('lists with an explicit bounded GET on the published procedure', async () => {
    const urls: string[] = [];
    const api = createApiClient({
      fetch: async (url) => {
        urls.push(String(url));
        return wire([request]);
      },
    });
    const result = await createApprovalReads(api, owner, () => true).mine(50);
    expect(result.ok).toBe(true);
    expect(urls[0]).toContain('/api/pay/trpc/withdrawalApproval.list');
    expect(JSON.parse(new URL(urls[0]!, 'http://x').searchParams.get('input')!)).toEqual({ limit: 50 });
  });

  it('refuses a list that names another initiator, and a limit outside the window', async () => {
    const api = createApiClient({ fetch: async () => wire([{ ...request, userId: other }]) });
    const reads = createApprovalReads(api, owner, () => true);
    const mixed = await reads.mine(50);
    expect(mixed.ok).toBe(false);
    expect((await reads.mine(0)).ok).toBe(false);
  });

  it('refuses a detail whose id is not the one asked for', async () => {
    const api = createApiClient({ fetch: async () => wire({ ...request, id: other }) });
    expect((await createApprovalReads(api, owner, () => true).get(id)).ok).toBe(false);
  });

  it('cancels by POST with only the request id, and reads the new status back', async () => {
    const seen: { url: string; body: unknown }[] = [];
    const api = createApiClient({
      fetch: async (url, opts) => {
        seen.push({ url: String(url), body: JSON.parse(String(opts?.body)) });
        return wire({ ...request, status: 'canceled' });
      },
    });
    const result = await createApprovalReads(api, owner, () => true).cancel(id);
    expect(result.ok && result.data.status).toBe('canceled');
    expect(seen).toEqual([{ url: '/api/pay/trpc/withdrawalApproval.cancel', body: { requestId: id } }]);
  });

  it('sends nothing when signed out', async () => {
    let calls = 0;
    const api = createApiClient({
      fetch: async () => {
        calls += 1;
        return wire([]);
      },
    });
    const reads = createApprovalReads(api, null, () => true);
    expect((await reads.mine(50)).ok).toBe(false);
    expect((await reads.cancel(id)).ok).toBe(false);
    expect(calls).toBe(0);
  });
});
