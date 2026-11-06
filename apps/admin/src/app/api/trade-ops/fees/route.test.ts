import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('@/lib/founder-session', () => ({
  authorizeAdminRequest: auth.authorize,
  adminSessionErrorResponse: () => Response.json({ error: 'session' }, { status: 401 }),
}));

import { feeScheduleSetPayloadHash } from '@/lib/trade-ops/fees-hash';
import { buildProposal, draftFrom, type FeeVersionRow } from '@/lib/trade-ops/fees-versions-model';
import { POST } from './route';

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const NOTICE = 'a1b2c3d4-0000-4000-8000-000000000009';
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const data = (value: unknown) => json({ result: { data: value } });
const calls = () => fetchMock.mock.calls.map((c) => ({ url: String(c[0]), body: c[1]?.body ? JSON.parse(String(c[1].body)) : null }));
const REASON = 'TEST maker change for IFC/USDT';
const LATER = new Date(Date.now() + 3_600_000).toISOString().slice(0, 19) + 'Z';
const FAR = new Date(Date.now() + 7_200_000).toISOString();

const BASE: FeeVersionRow = {
  version: '3',
  effectiveAt: new Date(Date.now() - 60_000).toISOString(),
  schedule: {
    defaultPairGroup: 'all-others',
    pairGroups: { 'IFC/USDT': 'test-fee-change' },
    rows: [
      { pairGroup: 'all-others', tierId: 'regular', zeroFee: false, makerBps: '8', takerBps: '10', minFee: null },
      { pairGroup: 'test-fee-change', tierId: 'regular', zeroFee: false, makerBps: '4', takerBps: '10', minFee: null },
    ],
  },
  operatorId: OTHER,
  approverId: ME,
  reason: 'TEST base version',
  createdAt: new Date(Date.now() - 120_000).toISOString(),
};
const SCHEDULED: FeeVersionRow = { ...BASE, version: '4', effectiveAt: FAR };
const draft = (maker = '2', taker = '10') => {
  const d = draftFrom(BASE);
  return {
    ...d,
    effectiveAt: LATER,
    rates: d.rates.map((r) => (r.pairGroup === 'test-fee-change' ? { ...r, makerBps: maker, takerBps: taker } : r)),
  };
};
const written = () => {
  const check = buildProposal(BASE, draft(), REASON, new Date());
  if (!check.ok) throw new Error(check.message);
  return { schedule: check.schedule, effectiveAt: check.effectiveAt, expectedVersion: '3', reason: REASON };
};
const approval = (over: Record<string, unknown> = {}) => ({
  approvalId: 'ap-1',
  operationId: 'op-1',
  actionType: 'trade.fee_schedule_set',
  targetService: 'svc-trade',
  targetId: 'spot-fee-schedule',
  expectedVersion: '3',
  payloadHash: feeScheduleSetPayloadHash(written()),
  policyVersion: 'trade-fee-schedule-set-v1',
  status: 'APPROVED',
  requesterId: ME,
  approverId: OTHER,
  createdAt: new Date().toISOString(),
  decidedAt: new Date().toISOString(),
  expiresAt: FAR,
  ...over,
});

/** The services as the route reaches them: fee history, identity's approvals, svc-trade's write, svc-notify's board. */
function services({ history = [BASE], approve = approval() }: { history?: FeeVersionRow[]; approve?: Record<string, unknown> } = {}) {
  fetchMock.mockImplementation(async (url: URL) => {
    const u = String(url);
    if (u.includes('admin.fees.get')) return data({ version: history[history.length - 1]?.version ?? '0', history });
    if (u.includes('actionApproval.propose')) return data({ ...approval(), status: 'PENDING', approverId: null, decidedAt: null });
    if (u.includes('actionApproval.get')) return data(approve);
    if (u.includes('admin.fees.set')) return data({ ...SCHEDULED, version: '4', effectiveAt: written().effectiveAt });
    if (u.includes('notify.draftNotice')) return data({ id: NOTICE, kind: 'fee_change', status: 'draft', version: 1, startsAt: FAR });
    if (u.includes('notify.noticeProposal'))
      return data({
        actionType: 'notify.notice.publish',
        targetService: 'svc-notify',
        targetId: NOTICE,
        expectedVersion: '1',
        payloadHash: 'sha256:n',
      });
    if (u.includes('notify.publishNotice')) return data({ id: NOTICE, kind: 'fee_change', status: 'published', version: 2, startsAt: FAR });
    return json({ error: { message: `unexpected ${u}` } }, 500);
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
  POST(new Request('https://admin.example/api/trade-ops/fees', { method: 'POST', body: JSON.stringify(body) }));

describe('fees route: a proposal', () => {
  it('refuses a blank taker fee with the typed code, and asks identity for nothing', async () => {
    services();
    const res = await post({ action: 'propose', basisVersion: '3', draft: draft('2', ''), reason: REASON });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ kind: 'refused', code: 'trade.fee_schedule_blank' });
    expect(calls().some((c) => c.url.includes('actionApproval'))).toBe(false);
  });

  it('refuses a form built on an older version as stale', async () => {
    services({ history: [BASE, SCHEDULED] });
    const res = await post({ action: 'propose', basisVersion: '3', draft: draft(), reason: REASON });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ kind: 'refused', code: 'fee_schedule_stale' });
    expect(calls().some((c) => c.url.includes('actionApproval'))).toBe(false);
  });

  it('refuses when no version is stored to start from', async () => {
    services({ history: [] });
    expect(await (await post({ action: 'propose', basisVersion: '0', draft: draft(), reason: REASON })).json()).toMatchObject({
      code: 'trade_ops.fee_no_base_version',
    });
  });

  it('files the request bound to the hash of exactly the version that will be written', async () => {
    services();
    const res = await post({ action: 'propose', basisVersion: '3', draft: draft(), reason: REASON });
    expect(res.status).toBe(200);
    const hash = feeScheduleSetPayloadHash(written());
    expect(await res.json()).toMatchObject({ kind: 'ok', data: { payloadHash: hash, approval: { approvalId: 'ap-1' } } });
    const proposed = calls().find((c) => c.url.includes('actionApproval.propose'))!;
    expect(proposed.body).toEqual({
      actionType: 'trade.fee_schedule_set',
      targetService: 'svc-trade',
      targetId: 'spot-fee-schedule',
      expectedVersion: '3',
      payloadHash: hash,
      policyVersion: 'trade-fee-schedule-set-v1',
    });
  });
});

describe('fees route: writing an approved version', () => {
  it('writes under the approval’s own operation id, exactly what was approved', async () => {
    services();
    const res = await post({ action: 'apply', basisVersion: '3', draft: draft(), reason: REASON, approvalId: 'ap-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: 'ok', data: { version: '4' } });
    const set = calls().find((c) => c.url.includes('admin.fees.set'))!;
    expect(set.body).toEqual({ ...written(), approvalId: 'ap-1', operationId: 'op-1' });
  });

  it('refuses before svc-trade is called when the request is still pending, or approved for other rates', async () => {
    services({ approve: approval({ status: 'PENDING' }) });
    expect(
      await (await post({ action: 'apply', basisVersion: '3', draft: draft(), reason: REASON, approvalId: 'ap-1' })).json(),
    ).toMatchObject({
      code: 'action_approval.pending',
    });
    fetchMock.mockReset();
    services();
    const other = await post({ action: 'apply', basisVersion: '3', draft: draft('1'), reason: REASON, approvalId: 'ap-1' });
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ code: 'trade_ops.fee_approval_mismatch' });
    fetchMock.mockReset();
    services({ approve: approval({ actionType: 'trade.risk_set' }) });
    expect(
      await (await post({ action: 'apply', basisVersion: '3', draft: draft(), reason: REASON, approvalId: 'ap-1' })).json(),
    ).toMatchObject({
      code: 'trade_ops.fee_approval_mismatch',
    });
    expect(calls().some((c) => c.url.includes('admin.fees.set'))).toBe(false);
  });

  it('refuses an approval id that is not one', async () => {
    services();
    expect(await (await post({ action: 'apply', basisVersion: '3', draft: draft(), reason: REASON, approvalId: '' })).json()).toMatchObject(
      {
        code: 'trade_ops.approval_id_invalid',
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fees route: the fee-change notice', () => {
  it('drafts a notice for a scheduled version with its effective time, and refuses one for a version in force', async () => {
    services({ history: [BASE, SCHEDULED] });
    const res = await post({ action: 'notice-draft', version: '4', title: 'TEST fee change', body: 'TEST: maker 0.02%.' });
    expect(await res.json()).toMatchObject({ kind: 'ok', data: { id: NOTICE, kind: 'fee_change' } });
    const drafted = calls().find((c) => c.url.includes('notify.draftNotice'))!;
    expect(drafted.body).toMatchObject({ kind: 'fee_change', title: 'TEST fee change', body: 'TEST: maker 0.02%.', startsAt: FAR });
    expect(drafted.body.clientRequestId).toMatch(/^fee-notice:[0-9a-f]{48}$/);
    expect(drafted.body).not.toHaveProperty('endsAt');

    fetchMock.mockReset();
    services({ history: [BASE, SCHEDULED] });
    const inForce = await post({ action: 'notice-draft', version: '3', title: 'TEST fee change', body: 'TEST: maker 0.04%.' });
    expect(inForce.status).toBe(409);
    expect(await inForce.json()).toMatchObject({ code: 'notify.notice_effective_invalid' });
    expect(calls().some((c) => c.url.includes('notify.draftNotice'))).toBe(false);
  });

  it('asks for the approval svc-notify names, and publishes once approved, never for another notice', async () => {
    services();
    expect(await (await post({ action: 'notice-request', noticeId: NOTICE })).json()).toMatchObject({
      kind: 'ok',
      data: { payloadHash: 'sha256:n' },
    });
    const proposed = calls().find((c) => c.url.includes('actionApproval.propose'))!;
    expect(proposed.body).toMatchObject({
      actionType: 'notify.notice.publish',
      targetService: 'svc-notify',
      targetId: NOTICE,
      payloadHash: 'sha256:n',
    });

    fetchMock.mockReset();
    services({ approve: approval({ targetId: NOTICE, actionType: 'notify.notice.publish' }) });
    expect(await (await post({ action: 'notice-publish', noticeId: NOTICE, approvalId: 'ap-1' })).json()).toMatchObject({
      kind: 'ok',
      data: { status: 'published' },
    });
    expect(calls().find((c) => c.url.includes('notify.publishNotice'))!.body).toMatchObject({
      id: NOTICE,
      approvalId: 'ap-1',
      operationId: 'op-1',
    });

    fetchMock.mockReset();
    services({ approve: approval({ targetId: 'a1b2c3d4-0000-4000-8000-00000000000a' }) });
    expect(await (await post({ action: 'notice-publish', noticeId: NOTICE, approvalId: 'ap-1' })).json()).toMatchObject({
      code: 'trade_ops.notice_approval_mismatch',
    });
    expect(calls().some((c) => c.url.includes('notify.publishNotice'))).toBe(false);
  });
});
