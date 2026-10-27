import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('@/lib/founder-session', () => ({
  authorizeAdminRequest: auth.authorize,
  adminSessionErrorResponse: () => Response.json({ error: 'session' }, { status: 401 }),
}));

import { vipReviewPayloadHash, vipTrialGrantPayloadHash } from '@/lib/trade-ops/vip-review-hash';
import { POST } from './route';

const ME = '00000000-0000-4000-8000-000000000001';
const APP = '55555555-5555-4555-8555-555555555555';
const REASON = 'TEST statement checked against the venue';
const TRIAL = { tierId: 'test-vip-1', days: 30 };
const fetchMock = vi.fn();

const application = (status: string) => ({
  id: APP,
  userId: '00000000-0000-4000-8000-000000000009',
  status,
  proof: { fileName: 'statement.pdf', contentType: 'application/pdf', byteLength: 1200, sha256: 'ab'.repeat(32) },
  note: null,
  createdAt: '2026-10-25T00:00:00.000Z',
  events: [
    {
      status: 'pending',
      actorId: '00000000-0000-4000-8000-000000000009',
      actorRole: 'applicant',
      approverId: null,
      reason: null,
      at: '2026-10-25T00:00:00.000Z',
    },
  ],
  trial: null,
});
const list = (status: string, trialRules: typeof TRIAL | null = TRIAL) => ({
  applications: [application(status)],
  trialRules,
  proofKeyed: true,
});
const APPROVE_HASH = 'sha256:f340afb02be7d0797824dd75c7678d2cffa9ac246cb1c43de5d37fad25a66916';
const approval = (status: string, actionType = 'trade.vip_application_review', payloadHash = APPROVE_HASH) => ({
  approvalId: 'ap-1',
  actionType,
  targetService: 'svc-trade',
  targetId: APP,
  expectedVersion: 'pending',
  payloadHash,
  requesterId: ME,
  approverId: status === 'PENDING' ? null : '00000000-0000-4000-8000-000000000002',
  policyVersion: 'trade-vip-review-v1',
  createdAt: '2026-10-25T00:00:00.000Z',
  expiresAt: '2026-10-25T01:00:00.000Z',
  status,
  operationId: 'op-minted-by-identity',
});
/** The list as svc-trade answers it for the status the call asks for. */
const listed = (url: URL, status: string, trialRules: typeof TRIAL | null = TRIAL) => {
  const wanted = /"status":"(\w+)"/.exec(decodeURIComponent(String(url)))?.[1];
  const all = list(status, trialRules);
  return data(wanted && wanted !== status ? { ...all, applications: [] } : all);
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const data = (body: unknown) => json({ result: { data: { json: body } } });
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));
const sentTo = (path: string) => {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes(path));
  return call ? (JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>) : undefined;
};

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
  POST(new Request('https://admin.example/api/trade-ops/vip-applications', { method: 'POST', body: JSON.stringify(body) }));

describe('VIP applications route', () => {
  it('refuses an unknown status, a bad application id and a short reason before any call', async () => {
    expect(await (await post({ action: 'read', status: 'maybe' })).json()).toMatchObject({ code: 'trade_ops.vip_bad_status' });
    expect(await (await post({ action: 'proof', applicationId: 'app-1', reason: REASON })).json()).toMatchObject({
      code: 'trade_ops.vip_bad_application',
    });
    expect(await (await post({ action: 'proof', applicationId: APP, reason: 'short' })).json()).toMatchObject({ code: 'reason_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the applications with the trial published now, and refuses a body of another shape', async () => {
    fetchMock.mockImplementation(async (url: URL) => listed(url, 'pending'));
    expect(await (await post({ action: 'read', status: 'pending' })).json()).toMatchObject({
      kind: 'ok',
      data: { trialRules: TRIAL, proofKeyed: true, applications: [{ id: APP, status: 'pending' }] },
    });
    expect(urls()[0]).toContain('/api/trade/trpc/admin.vipApplications.list');
    fetchMock.mockImplementation(async () => data({ applications: [{ id: APP }], trialRules: null, proofKeyed: true }));
    expect(await (await post({ action: 'read' })).json()).toMatchObject({ kind: 'refused', code: 'trade_ops.unexpected_shape' });
  });

  it('opens a proof with the stated reason', async () => {
    fetchMock.mockImplementation(async () =>
      data({ fileName: 'statement.pdf', contentType: 'application/pdf', sha256: 'ab'.repeat(32), bytesBase64: 'JVBERi0=' }),
    );
    expect(await (await post({ action: 'proof', applicationId: APP, reason: REASON })).json()).toMatchObject({
      kind: 'ok',
      data: { fileName: 'statement.pdf' },
    });
    expect(sentTo('admin.vipApplications.proof')).toEqual({ applicationId: APP, reason: REASON });
  });

  it('files a decision bound to the status and the trial read just now, with the hash svc-trade recomputes', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes('actionApproval.propose') ? data(approval('PENDING')) : listed(url, 'pending'),
    );
    const res = await post({ action: 'propose', kind: 'review', applicationId: APP, decision: 'approve', reason: REASON });
    expect(await res.json()).toMatchObject({ kind: 'ok', data: { approval: { approvalId: 'ap-1' }, trial: TRIAL } });
    const sent = sentTo('actionApproval.propose');
    expect(sent).toMatchObject({
      actionType: 'trade.vip_application_review',
      targetService: 'svc-trade',
      targetId: APP,
      expectedVersion: 'pending',
      policyVersion: 'trade-vip-review-v1',
    });
    expect(sent!.payloadHash).toBe(vipReviewPayloadHash({ applicationId: APP, decision: 'approve', reason: REASON, trial: TRIAL }));
    // The pinned vector svc-trade's own test carries (services/svc-trade/src/admin/vip-review.test.ts).
    expect(sent!.payloadHash).toBe('sha256:f340afb02be7d0797824dd75c7678d2cffa9ac246cb1c43de5d37fad25a66916');
  });

  it('files nothing for an application already decided, or a trial grant while no trial is published', async () => {
    fetchMock.mockImplementation(async (url: URL) => listed(url, 'approved'));
    const decided = await post({ action: 'propose', kind: 'review', applicationId: APP, decision: 'reject', reason: REASON });
    expect(decided.status).toBe(409);
    expect(await decided.json()).toMatchObject({ code: 'vip.application_decided' });
    expect(await (await post({ action: 'propose', kind: 'grant', applicationId: APP, reason: REASON })).json()).toMatchObject({
      code: 'vip.trial_not_owed',
    });
    fetchMock.mockImplementation(async (url: URL) => listed(url, 'approved_no_trial', null));
    expect(await (await post({ action: 'propose', kind: 'grant', applicationId: APP, reason: REASON })).json()).toMatchObject({
      code: 'vip.trial_unset',
    });
    expect(urls().every((u) => u.includes('admin.vipApplications.list'))).toBe(true);
  });

  it('files a trial grant over the approved-without-trial status, with its hash', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes('actionApproval.propose')
        ? data(approval('PENDING', 'trade.vip_trial_grant'))
        : listed(url, 'approved_no_trial'),
    );
    expect(await (await post({ action: 'propose', kind: 'grant', applicationId: APP, reason: REASON })).json()).toMatchObject({
      kind: 'ok',
    });
    const sent = sentTo('actionApproval.propose');
    expect(sent).toMatchObject({ actionType: 'trade.vip_trial_grant', expectedVersion: 'approved_no_trial' });
    expect(sent!.payloadHash).toBe(vipTrialGrantPayloadHash({ applicationId: APP, reason: REASON, trial: TRIAL }));
  });

  it('works out the hash a request for exactly this decision carries, so the approver can check it, and files nothing', async () => {
    fetchMock.mockImplementation(async (url: URL) => listed(url, 'pending'));
    const approve = await (await post({ action: 'hash', kind: 'review', applicationId: APP, decision: 'approve', reason: REASON })).json();
    expect(approve).toMatchObject({
      kind: 'ok',
      data: { payloadHash: 'sha256:f340afb02be7d0797824dd75c7678d2cffa9ac246cb1c43de5d37fad25a66916', trial: TRIAL },
    });
    const reject = await (await post({ action: 'hash', kind: 'review', applicationId: APP, decision: 'reject', reason: REASON })).json();
    expect(reject).toMatchObject({
      data: { payloadHash: 'sha256:31253482667c472e5415384d9aa70430e776047c578bcd4ad06f0b1177050ab9', trial: null },
    });
    expect(urls().every((u) => u.includes('admin.vipApplications.list'))).toBe(true);
  });

  it('decides nothing while the request still waits for a second founder', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes('actionApproval.get') ? data(approval('PENDING')) : listed(url, 'pending'),
    );
    const res = await post({
      action: 'apply',
      kind: 'review',
      applicationId: APP,
      decision: 'approve',
      reason: REASON,
      approvalId: 'ap-1',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'action_approval.pending' });
    expect(urls().some((u) => u.includes('admin.vipApplications.review'))).toBe(false);
  });

  it('says in words when the approval is for another decision or reason, and sends no decision', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes('actionApproval.get')
        ? data(approval('APPROVED', 'trade.vip_application_review', 'sha256:' + '0'.repeat(64)))
        : listed(url, 'pending'),
    );
    const res = await post({
      action: 'apply',
      kind: 'review',
      applicationId: APP,
      decision: 'approve',
      reason: REASON,
      approvalId: 'ap-1',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'approval_mismatch' });
    expect(urls().some((u) => u.includes('admin.vipApplications.review'))).toBe(false);
  });

  it('a used approval goes to svc-trade as it is, so a retry after a lost reply answers what was decided', async () => {
    const decided = { application: { ...application('approved'), trial: null }, trialRefusal: null };
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes('admin.vipApplications.review')
        ? data(decided)
        : String(url).includes('actionApproval.get')
          ? data(approval('CONSUMED'))
          : listed(url, 'approved'),
    );
    const res = await post({
      action: 'apply',
      kind: 'review',
      applicationId: APP,
      decision: 'approve',
      reason: REASON,
      approvalId: 'ap-1',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: 'ok', data: { application: { status: 'approved' } } });
    expect(sentTo('admin.vipApplications.review')).toMatchObject({ approvalId: 'ap-1', operationId: 'op-minted-by-identity' });
  });

  it('applies with the approval id and its own operation id, and passes the service refusal through', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes('admin.vipApplications.review')
        ? json(
            { error: { json: { message: 'approval was already consumed', data: { code: 'BAD_REQUEST', appCode: 'approval_reused' } } } },
            400,
          )
        : String(url).includes('actionApproval.get')
          ? data(approval('APPROVED'))
          : listed(url, 'pending'),
    );
    const res = await post({
      action: 'apply',
      kind: 'review',
      applicationId: APP,
      decision: 'approve',
      reason: REASON,
      approvalId: 'ap-1',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ kind: 'refused', code: 'approval_reused' });
    expect(sentTo('admin.vipApplications.review')).toEqual({
      applicationId: APP,
      decision: 'approve',
      reason: REASON,
      approvalId: 'ap-1',
      operationId: 'op-minted-by-identity',
    });
  });
});
