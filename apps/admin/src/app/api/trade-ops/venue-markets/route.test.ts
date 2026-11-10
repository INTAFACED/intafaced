import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('@/lib/founder-session', () => ({
  authorizeAdminRequest: auth.authorize,
  adminSessionErrorResponse: () => Response.json({ error: 'session' }, { status: 401 }),
}));

import { venueLimitsPayloadHash, venueListingPayloadHash, venueRoutingPayloadHash } from '@/lib/trade-ops/venue-markets-hash';
import { wireView } from '@/lib/trade-ops/venue-markets-fixtures.test-util';
import { POST } from './route';

const ME = '00000000-0000-4000-8000-000000000001';
const APPROVER = '00000000-0000-4000-8000-000000000002';
const REASON = 'TEST stop routing to this market';
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const trpc = (data: unknown) => json({ result: { data: { json: data } } });
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));
const sentBody = (needle: string) => {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes(needle));
  return call ? (JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>) : undefined;
};
const base = { venueId: 'test-venue-sim', symbol: 'T16AB-USDC', reason: REASON };

const approval = (over: Record<string, unknown> = {}) => ({
  approvalId: 'ap-venue-1',
  actionType: 'trade.venue_routing_set',
  targetService: 'svc-trade',
  targetId: 'venue-listing:test-venue-sim:T16AB-USDC',
  expectedVersion: '2',
  payloadHash: venueRoutingPayloadHash({ ...base, routing: 'show', expectedVersion: '2' }),
  requesterId: ME,
  approverId: APPROVER,
  policyVersion: 'trade-venue-markets-v1',
  createdAt: '2026-11-09T00:00:00.000Z',
  expiresAt: '2026-11-09T01:00:00.000Z',
  status: 'APPROVED',
  operationId: 'op-minted-by-identity',
  ...over,
});

/** The edge as the route reaches it: the desk read, identity's approvals and svc-trade's write doors. */
function edge(answers: { approval?: unknown; write?: Response } = {}) {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url.includes('admin.venueMarkets.list')) return trpc(wireView());
    if (url.includes('actionApproval.propose')) return trpc(approval({ status: 'PENDING', approverId: null }));
    if (url.includes('actionApproval.get')) return trpc(answers.approval ?? approval());
    if (url.includes('admin.venueMarkets.')) return answers.write ?? json({ error: 'unexpected' }, 500);
    return json({ error: `no route ${url}` }, 404);
  });
}

beforeEach(() => {
  auth.authorize.mockResolvedValue({
    session: { userId: ME, accessToken: 'founder-session-token' },
    config: { origin: 'https://admin.example', edgeUrl: 'http://isolated-edge:4000' },
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  auth.authorize.mockReset();
});

const post = (body: unknown) =>
  POST(new Request('https://admin.example/api/trade-ops/venue-markets', { method: 'POST', body: JSON.stringify(body) }));

describe('venue markets route (J-cex-spot-16)', () => {
  it('reads the desk from svc-trade', async () => {
    edge();
    const res = await post({ action: 'read' });
    expect(await res.json()).toMatchObject({ kind: 'ok', data: { venueId: 'test-venue-sim', test: true } });
    expect(urls().some((u) => u.includes('/api/trade/trpc/admin.venueMarkets.list'))).toBe(true);
  });

  it('files a routing proposal bound to the listing line, the version read and the hash svc-trade checks', async () => {
    edge();
    const res = await post({ action: 'propose', change: 'routing', symbol: 'T16AB-USDC', routing: 'show', reason: REASON });
    const out = await res.json();
    expect(out).toMatchObject({ kind: 'ok', data: { expectedVersion: '2' } });
    expect(out.data.payloadHash).toBe(venueRoutingPayloadHash({ ...base, routing: 'show', expectedVersion: '2' }));
    expect(sentBody('actionApproval.propose')).toEqual({
      actionType: 'trade.venue_routing_set',
      targetService: 'svc-trade',
      targetId: 'venue-listing:test-venue-sim:T16AB-USDC',
      expectedVersion: '2',
      payloadHash: out.data.payloadHash,
      policyVersion: 'trade-venue-markets-v1',
    });
  });

  it('refuses a blank limit, one above the venue own and a blank opening window by svc-trade code, filing nothing', async () => {
    edge();
    const limits = (maxOrderQty: string, maxOrderNotional: string) =>
      post({ action: 'propose', change: 'limits', symbol: 'T16AB-USDC', maxOrderQty, maxOrderNotional, reason: REASON });
    expect(await (await limits('', '100')).json()).toMatchObject({ kind: 'refused', code: 'trade.venue_limit_blank' });
    expect(await (await limits('11', '100')).json()).toMatchObject({ kind: 'refused', code: 'trade.venue_limit_above_venue' });
    const opening = await post({ action: 'propose', change: 'listing', symbol: 'ETH-USDC', opensAt: ' ', reason: REASON });
    expect(await opening.json()).toMatchObject({ code: 'trade.venue_listing_opening_window_blank' });
    // ETH-USDC has no listing of ours: a routing state needs one first.
    const unknown = await post({ action: 'propose', change: 'routing', symbol: 'ETH-USDC', routing: 'stop', reason: REASON });
    expect(await unknown.json()).toMatchObject({ code: 'trade.venue_listing_missing' });
    expect(urls().some((u) => u.includes('actionApproval.propose'))).toBe(false);
  });

  it('files a limits proposal on the limits line at its own version', async () => {
    edge();
    const res = await post({
      action: 'propose',
      change: 'limits',
      symbol: 'T16AB-USDC',
      maxOrderQty: '5.0',
      maxOrderNotional: '500',
      reason: REASON,
    });
    const out = await res.json();
    expect(out).toMatchObject({ kind: 'ok', data: { expectedVersion: '1' } });
    expect(sentBody('actionApproval.propose')).toMatchObject({
      actionType: 'trade.venue_limits_set',
      targetId: 'venue-limits:test-venue-sim:T16AB-USDC',
      payloadHash: venueLimitsPayloadHash({ ...base, maxOrderQty: '5', maxOrderNotional: '500', expectedVersion: '1' }),
    });
  });

  it('writes an approved change under the approval own version and operation id', async () => {
    edge({
      write: trpc({ venueId: 'test-venue-sim', symbol: 'T16AB-USDC', listing: { version: 3, proposerId: ME, approverId: APPROVER } }),
    });
    const res = await post({
      action: 'apply',
      change: 'routing',
      symbol: 'T16AB-USDC',
      routing: 'show',
      reason: REASON,
      approvalId: 'ap-venue-1',
    });
    expect(await res.json()).toMatchObject({ kind: 'ok', data: { symbol: 'T16AB-USDC', version: 3, approverId: APPROVER } });
    expect(sentBody('admin.venueMarkets.routingSet')).toEqual({
      symbol: 'T16AB-USDC',
      routing: 'show',
      expectedVersion: '2',
      reason: REASON,
      approvalId: 'ap-venue-1',
      operationId: 'op-minted-by-identity',
    });
  });

  it('writes nothing for a pending approval, or one for another change or other values', async () => {
    const body = { action: 'apply', change: 'routing', symbol: 'T16AB-USDC', routing: 'show', reason: REASON, approvalId: 'ap-venue-1' };
    edge({ approval: approval({ status: 'PENDING', approverId: null }) });
    expect(await (await post(body)).json()).toMatchObject({ code: 'action_approval.pending' });
    fetchMock.mockReset();
    edge({
      approval: approval({ payloadHash: venueListingPayloadHash({ ...base, opensAt: '2026-11-09T00:00:00Z', expectedVersion: '2' }) }),
    });
    expect(await (await post(body)).json()).toMatchObject({ code: 'trade_ops.approval_mismatch' });
    fetchMock.mockReset();
    edge({ approval: approval({ targetId: 'venue-listing:test-venue-sim:ETH-USDC' }) });
    expect(await (await post(body)).json()).toMatchObject({ code: 'trade_ops.approval_mismatch' });
    expect(urls().some((u) => u.includes('admin.venueMarkets.routingSet'))).toBe(false);
  });
});
