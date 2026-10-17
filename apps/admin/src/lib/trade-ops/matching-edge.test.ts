import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TradeCtx } from './edge';
import { readMatchingHealth, readSurveillanceCases, runMatchingControl } from './matching-edge';
import { matchingActionSpec } from './matching-controls';

const fetchMock = vi.fn();
const ctx = {
  session: { userId: 'op-a', accessToken: 'founder-session-token' },
  config: { origin: 'https://admin.example', edgeUrl: 'http://isolated-edge:4000' },
} as unknown as TradeCtx;

beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

const reply = (status: number, body: unknown) => Response.json(body, { status });

describe('matching health (svc-edge /admin/trade-ops/matching/health)', () => {
  it('renders the live read: the three fields unchanged, with the edge read time', async () => {
    fetchMock.mockResolvedValue(
      reply(200, { venueHalted: true, restingOrders: 7, journalRecords: 41, asOf: '2026-10-18T01:00:00.000Z', ageMs: 12 }),
    );
    const out = await readMatchingHealth(ctx);
    expect(out).toMatchObject({ kind: 'ok', data: { venueHalted: true, restingOrders: 7, journalRecords: 41, ageMs: 12 } });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('http://isolated-edge:4000/admin/trade-ops/matching/health');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer founder-session-token');
  });
  it('shows the typed refusal when matching is not configured, never zeros', async () => {
    fetchMock.mockResolvedValue(
      reply(503, { outcome: 'refused', error: 'MATCHING_URL is unpublished.', code: 'matching_unconfigured', key: 'MATCHING_URL' }),
    );
    expect(await readMatchingHealth(ctx)).toMatchObject({
      kind: 'refused',
      code: 'matching_unconfigured',
      status: 503,
      message: 'MATCHING_URL is unpublished.',
    });
  });
  it('shows the typed 502 when matching is down', async () => {
    fetchMock.mockResolvedValue(
      reply(502, { outcome: 'upstream_error', code: 'matching_upstream_unavailable', error: 'svc-matching did not answer: refused' }),
    );
    expect(await readMatchingHealth(ctx)).toMatchObject({ kind: 'refused', code: 'matching_upstream_unavailable', status: 502 });
  });
  it('shows a body without the three fields as unexpected, not as a halted or running venue', async () => {
    fetchMock.mockResolvedValue(reply(200, { restingOrders: 1 }));
    expect(await readMatchingHealth(ctx)).toMatchObject({ kind: 'refused', code: 'trade_ops.unexpected_shape' });
  });
});

describe('surveillance cases (svc-edge /admin/trade-ops/surveillance/cases)', () => {
  it('renders live cases with the page size sent as limit', async () => {
    const row = { accountId: 'a-1', marketId: 'm-1', reason: 'layering: 5 levels cancelled', status: 'open' };
    fetchMock.mockResolvedValue(reply(200, { cases: [row], limit: 100, upstream: { cases: [row] } }));
    const out = await readSurveillanceCases(ctx);
    expect(out).toMatchObject({ kind: 'ok', data: { cases: [row], limit: 100 } });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://isolated-edge:4000/admin/trade-ops/surveillance/cases?limit=100');
  });
  it('an empty answer is an ok read with no cases', async () => {
    fetchMock.mockResolvedValue(reply(200, { cases: [], limit: 100, upstream: {} }));
    expect(await readSurveillanceCases(ctx)).toMatchObject({ kind: 'ok', data: { cases: [] } });
  });
  it('reads the detector state: both detectors off with the service gap code', async () => {
    const off = (reason: string) => ({ enabled: false, gap: 'detector_gap', reason, threshold: null });
    fetchMock.mockResolvedValue(
      reply(200, {
        cases: [],
        limit: 100,
        upstream: { cases: [], detectors: { spoofing: off('spoofing'), layering: off('layering') } },
      }),
    );
    const out = await readSurveillanceCases(ctx);
    expect(out).toMatchObject({
      kind: 'ok',
      data: {
        detectors: { spoofing: { enabled: false, gap: 'detector_gap' }, layering: { enabled: false, gap: 'detector_gap' } },
      },
    });
  });
  it('a reply without detectors is still an ok read, with the detector state unknown', async () => {
    fetchMock.mockResolvedValue(reply(200, { cases: [], limit: 100, upstream: { cases: [] } }));
    const out = await readSurveillanceCases(ctx);
    expect(out).toMatchObject({ kind: 'ok', data: { cases: [], detectors: null } });
  });
  it('shows the typed refusal instead of rows', async () => {
    fetchMock.mockResolvedValue(
      reply(502, { outcome: 'upstream_error', code: 'matching_upstream_error', error: 'svc-matching refused (403)' }),
    );
    expect(await readSurveillanceCases(ctx)).toMatchObject({ kind: 'refused', code: 'matching_upstream_error' });
  });
  it('refuses rows that are not the shape svc-matching presents', async () => {
    fetchMock.mockResolvedValue(reply(200, { cases: [{ id: 'x' }], limit: 100, upstream: {} }));
    expect(await readSurveillanceCases(ctx)).toMatchObject({ kind: 'refused', code: 'trade_ops.unexpected_shape' });
  });
});

describe('market controls', () => {
  const approval = (over: Record<string, unknown>) => ({
    approvalId: 'approval-12345',
    actionType: 'matching.halt',
    targetService: 'svc-matching',
    targetId: 'halt:m-1',
    expectedVersion: '1',
    payloadHash: 'sha256:' + 'b'.repeat(64),
    requesterId: 'op-a',
    approverId: 'op-b',
    policyVersion: 'matching-control-v1',
    createdAt: '2026-10-18T00:00:00.000Z',
    expiresAt: '2026-10-18T01:00:00.000Z',
    status: 'APPROVED',
    operationId: 'op-77',
    ...over,
  });
  it('sends a per-market halt to the market path with a stable client request id', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { result: { data: { json: approval({}) } } })).mockResolvedValueOnce(
      reply(200, {
        outcome: 'accepted',
        audit: {
          at: '2026-10-18T01:00:00.000Z',
          action: 'matching.halt',
          marketId: 'm-1',
          requesterId: 'op-a',
          approverId: 'op-b',
          idempotencyKey: 'k',
        },
        upstream: { accepted: true },
      }),
    );
    const out = await runMatchingControl(ctx, matchingActionSpec('halt')!, 'm-1', 'approval-12345');
    expect(out).toMatchObject({ kind: 'ok', data: { audit: { requesterId: 'op-a', approverId: 'op-b' } } });
    const [url, init] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(String(url)).toBe('http://isolated-edge:4000/admin/trade-ops/matching/markets/m-1/halt');
    expect(JSON.parse(String(init.body))).toEqual({
      idempotencyKey: 'desk-halt-m-1-approval-12345',
      approvalId: 'approval-12345',
      operationId: 'op-77',
    });
  });
  it('a missing approval is the service refusal, shown as-is, and nothing is sent to the door', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(404, { error: { json: { message: 'No approval [action_approval.not_found]', data: { code: 'NOT_FOUND' } } } }),
    );
    const out = await runMatchingControl(ctx, matchingActionSpec('halt')!, 'm-1', 'nope-12345');
    expect(out).toMatchObject({ kind: 'refused', code: 'action_approval.not_found' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('a consumed approval is refused by svc-edge as reused and shown as-is', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { result: { data: { json: approval({}) } } })).mockResolvedValueOnce(
      reply(409, {
        outcome: 'refused',
        code: 'action_approval.reused',
        key: 'approvalId',
        error: 'This approval was already used for a matching control.',
      }),
    );
    expect(await runMatchingControl(ctx, matchingActionSpec('halt')!, 'm-1', 'approval-12345')).toMatchObject({
      kind: 'refused',
      code: 'action_approval.reused',
      message: 'This approval was already used for a matching control.',
    });
  });
  it('a pending approval is reported pending and never sent', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { result: { data: { json: approval({ status: 'PENDING', approverId: null }) } } }));
    expect(await runMatchingControl(ctx, matchingActionSpec('halt')!, 'm-1', 'approval-12345')).toMatchObject({
      kind: 'refused',
      code: 'action_approval.pending',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('approvals list (identity actionApproval.list)', () => {
  it('renders the live pending list, and a refusal is shown as the service said it', async () => {
    const { listApprovals } = await import('./approvals-calls');
    fetchMock.mockResolvedValueOnce(reply(200, { result: { data: { json: { approvals: [], pageFull: false } } } }));
    expect(await listApprovals(ctx, 'pending', 50)).toMatchObject({ kind: 'ok', data: { approvals: [], pageFull: false } });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/identity/trpc/actionApproval.list?input=');
    fetchMock.mockResolvedValueOnce(
      reply(403, { error: { json: { message: 'pending approvals are an operator or founder read [action_approval.operator_only]' } } }),
    );
    expect(await listApprovals(ctx, 'pending', 50)).toMatchObject({ kind: 'refused', code: 'action_approval.operator_only' });
  });
});
