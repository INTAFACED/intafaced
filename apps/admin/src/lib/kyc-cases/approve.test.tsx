import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { identityActionPayloadHash } from '../../../../../services/svc-identity/src/auth/privileged-dual-control';
import { KycApprove, kycApproveHold } from '@/components/kyc-approve';
import { confirmPhrase, payloadHashFor, proposeInputFor, readDeskRequest, requestReason } from '@/lib/desk';
import type { Row } from '@/lib/ops-desk';
import { kycApproveExecute, readKycRecord } from './approve';

const RECORD = '6f4a5b6c-7d8e-4f90-81a2-b3c4d5e6f708';
const USER = '4d2e3f4a-5b6c-4d7e-8f80-91a2b3c4d5e6';
const IDS = { approvalId: 'appr-1', operationId: 'op-1' };
const answer = (over: Record<string, unknown> = {}) => ({
  id: RECORD,
  userId: USER,
  tier: 'full',
  jurisdiction: 'DE',
  status: 'approved',
  reviewedAt: '2026-11-23T10:00:00.000Z',
  expiresAt: null,
  createdAt: '2026-11-23T09:00:00.000Z',
  ...over,
});

const ctx = {
  session: {
    userId: '11111111-1111-4111-8111-111111111111',
    accessToken: 'founder-access-token',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};

afterEach(() => vi.unstubAllGlobals());

describe('the verification approval request', () => {
  const request = { kind: 'identity.kyc.approve' as const, recordId: RECORD };

  it('is bound to the record exactly as identity consumes it', () => {
    expect(payloadHashFor(request)).toBe(identityActionPayloadHash('kyc.approve', { recordId: RECORD }));
    expect(proposeInputFor(request)).toMatchObject({
      actionType: 'kyc.approve',
      targetService: 'svc-identity',
      targetId: 'kyc.approve',
      expectedVersion: '1',
    });
    expect(confirmPhrase(request)).toBe('APPROVE VERIFICATION 6f4a5b6c');
    expect(requestReason(request)).toBeNull();
  });

  it('reads only the exact shape', () => {
    expect(readDeskRequest(request)).toEqual(request);
    expect(readDeskRequest({ ...request, tier: 'institutional' })).toBeNull();
    expect(readDeskRequest({ ...request, recordId: 'not-a-uuid' })).toBeNull();
  });
});

describe('the verification case row', () => {
  it('holds the form unless the case waits and names a verification', () => {
    expect(kycApproveHold(RECORD, 'submitted')).toBeNull();
    expect(kycApproveHold(RECORD, 'approved')).toContain('This one is approved');
    expect(kycApproveHold(null, 'submitted')).toContain('names no verification id');
  });
  it('draws the desk with its consequence', () => {
    const row: Row = {
      id: 'case-1',
      cells: [
        { key: 'recordId', label: 'Verification id', kind: 'text', detail: true, value: RECORD },
        { key: 'state', label: 'State', kind: 'text', detail: false, value: 'submitted' },
        { key: 'tier', label: 'Level', kind: 'text', detail: false, value: 'full' },
      ],
    };
    const html = renderToStaticMarkup(<KycApprove row={row} userId={ctx.session.userId} onChanged={() => {}} />);
    expect(html).toContain('data-testid="kyc-approve"');
    expect(html).toContain('at level full');
  });
});

describe('identity answer', () => {
  it('reads only a well-formed record', () => {
    expect(readKycRecord(answer())).toEqual(answer());
    expect(readKycRecord(answer({ status: 'granted' }))).toBeNull();
    expect(readKycRecord([answer()])).toBeNull();
  });
});

describe('running an approved verification', () => {
  const request = { kind: 'identity.kyc.approve' as const, recordId: RECORD };
  it('sends the record and the approval to identity and reports what it recorded', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => Response.json({ result: { data: answer() } }));
    vi.stubGlobal('fetch', fn);
    const out = await kycApproveExecute(ctx)(request, IDS);
    expect(fn.mock.calls[0]![0]).toBe('http://edge:4000/api/identity/trpc/kyc.approve');
    expect(JSON.parse(String(fn.mock.calls[0]![1]!.body))).toEqual({ recordId: RECORD, ...IDS });
    expect(out).toEqual({ ok: true, detail: `Identity approved verification ${RECORD} at level full at 2026-11-23T10:00:00.000Z.` });
  });
  it('refuses an answer for another record or not approved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ result: { data: answer({ status: 'pending' }) } })),
    );
    expect(await kycApproveExecute(ctx)(request, IDS)).toMatchObject({ ok: false, refusal: { code: 'admin.ops_invalid_response' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ result: { data: answer({ id: '7a5b6c7d-8e9f-4a01-92b3-c4d5e6f70819' }) } })),
    );
    expect(await kycApproveExecute(ctx)(request, IDS)).toMatchObject({ ok: false, refusal: { code: 'admin.ops_invalid_response' } });
  });
});
