import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../../shared/api';
import { createPortalApi } from './api';
import { isComingSoon, refusalText } from './refusal';

type Call = { url: string; method: string; body: unknown };
function harness(reply: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const { status = 200, body } = reply(call);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, portal: createPortalApi(createApiClient({ fetch: fetcher }), 'user-1') };
}
const ok = (data: unknown) => ({ body: { result: { data } } });
const refused = (status: number, code: string) => ({ status, body: { error: { message: code, data: { cause: { code } } } } });
const procedure = (url: string) => decodeURIComponent(url.split('/trpc/')[1]!.split('?')[0]!);
const input = (url: string) => JSON.parse(decodeURIComponent(url.split('?input=')[1] ?? 'null'));

const M = '11111111-1111-4111-8111-111111111111';
const PAYMENT = {
  id: 'aa000001-0000-4000-8000-000000000001',
  merchantId: M,
  profileId: null,
  amount: '10.5',
  assetId: 'USDT',
  method: 'm',
  railAdapter: 'r',
  railRef: null,
  status: 'captured',
  capturedAmount: '10.5',
  refundedAmount: '0',
  createdAt: '2026-10-15T00:00:00.000Z',
};
const APPROVAL = {
  approvalId: 'cc000001-0000-4000-8000-000000000001',
  merchantId: M,
  settlementId: 'bb000001-0000-4000-8000-000000000001',
  amount: '985',
  assetCode: 'USDT',
  payloadHash: `sha256:${'a'.repeat(64)}`,
  status: 'pending',
  makerUserId: 'u1',
  checkerUserId: null,
  createdAt: '2026-10-15T00:00:00.000Z',
  decidedAt: null,
  expiresAt: '2026-10-16T00:00:00.000Z',
};

describe('portal api (W3b reads)', () => {
  it('asks the list reads for a status and a page size, never a cursor, and names the account only because those reads require it', async () => {
    const { calls, portal } = harness(() => ok([]));
    await portal.payments(M, 'failed', 50);
    await portal.payments(M, '', 25);
    await portal.settlements(M, 'posted', 200);
    expect(calls.map((c) => procedure(c.url))).toEqual(['payment.list', 'payment.list', 'settlement.list']);
    expect(input(calls[0]!.url)).toEqual({ merchantId: M, limit: 50, status: 'failed' });
    expect(input(calls[1]!.url)).toEqual({ merchantId: M, limit: 25 });
    expect(input(calls[2]!.url)).toEqual({ merchantId: M, limit: 200, status: 'posted' });
  });
  it('reads one payment, its history and one settlement by id only', async () => {
    const { calls, portal } = harness(() => ok({}));
    await portal.payment(PAYMENT.id);
    await portal.paymentHistory(PAYMENT.id);
    await portal.settlement('bb000001-0000-4000-8000-000000000001');
    expect(calls.map((c) => procedure(c.url))).toEqual(['payment.get', 'payment.history', 'settlement.get']);
    expect(input(calls[0]!.url)).toEqual({ paymentId: PAYMENT.id });
    expect(input(calls[1]!.url)).toEqual({ paymentId: PAYMENT.id, limit: 200 });
  });
  it('refuses a payment whose amounts are not exact decimal strings', async () => {
    const { portal } = harness(() => ok([{ ...PAYMENT, amount: 10.5 }]));
    const result = await portal.payments(M, '', 25);
    expect(result.ok).toBe(false);
  });
  it('accepts a well-formed payment list', async () => {
    const { portal } = harness(() => ok({ items: [PAYMENT], nextCursor: null }));
    const result = await portal.payments(M, '', 25);
    expect(result.ok && result.data[0]?.amount).toBe('10.5');
  });
  it('reads the control room and the pause state for the named account', async () => {
    const { calls, portal } = harness(() => ok({}));
    await portal.control(M);
    await portal.usage(M);
    await portal.haltStatus(M);
    expect(calls.map((c) => procedure(c.url))).toEqual(['merchantControl.get', 'merchantControl.usage', 'payHalts.status']);
    for (const call of calls) expect(input(call.url)).toEqual({ merchantId: M });
  });
  it('refuses a usage row whose figures are not exact decimals, so a page never has to guess', async () => {
    const row = { kind: 'daily_intake', assetCode: 'USDT', limit: '20000', used: 'lots', remaining: '1', resetsAt: null };
    const { portal } = harness(() => ok({ merchantId: M, tierId: null, asOf: '2026-10-15T00:00:00.000Z', rows: [row] }));
    expect((await portal.usage(M)).ok).toBe(false);
  });
  it('lists approvals at the largest page the service allows', async () => {
    const { calls, portal } = harness(() => ok([APPROVAL]));
    const result = await portal.approvals(M, '');
    expect(input(calls[0]!.url)).toEqual({ merchantId: M, limit: 200 });
    expect(result.ok && result.data[0]?.status).toBe('pending');
  });
  it('refuses an approval with a malformed fingerprint rather than showing it', async () => {
    const { portal } = harness(() => ok([{ ...APPROVAL, payloadHash: 'not-a-hash' }]));
    expect((await portal.approvals(M, '')).ok).toBe(false);
  });
  it('sends a monthly volume and the conversion flag only when asked for', async () => {
    const quote = {
      ruleId: 'dd000001-0000-4000-8000-000000000001',
      appliedLayer: 'tier',
      monthlyVolumeBefore: '0',
      bandFrom: '0',
      feeBps: 150,
      flatFee: null,
      spreadBps: null,
      roundingBeneficiary: 'platform',
      roundingMode: 'ceil',
      bpsFee: '1.5',
      feeBeforeClamp: '1.5',
      fee: '1.5',
      spread: null,
      net: '98.5',
    };
    const { calls, portal } = harness(() => ok(quote));
    await portal.pricingPreview({ merchantId: M, assetCode: 'USDT', amount: '100' });
    await portal.pricingPreview({ merchantId: M, assetCode: 'USDT', amount: '100', monthlyVolume: '5', conversion: true });
    expect(input(calls[0]!.url)).toEqual({ merchantId: M, assetCode: 'USDT', amount: '100' });
    expect(input(calls[1]!.url)).toEqual({ merchantId: M, assetCode: 'USDT', amount: '100', monthlyVolume: '5', conversion: true });
  });
});

describe('portal api (payout decisions)', () => {
  it('sends the fingerprint the checker reviewed, and the reason, with a decision', async () => {
    const { calls, portal } = harness(() => ok(APPROVAL));
    await portal.decideApproval({
      approvalId: APPROVAL.approvalId,
      decision: 'approve',
      expectedPayloadHash: APPROVAL.payloadHash,
      reason: 'Checked',
    });
    expect(procedure(calls[0]!.url)).toBe('merchantControl.approvals.decide');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({
      approvalId: APPROVAL.approvalId,
      decision: 'approve',
      expectedPayloadHash: APPROVAL.payloadHash,
      reason: 'Checked',
    });
  });
  it('sends no merchant or user id with a decision or a cancel: the service reads them from the session', async () => {
    const { calls, portal } = harness(() => ok(APPROVAL));
    await portal.decideApproval({
      approvalId: APPROVAL.approvalId,
      decision: 'reject',
      expectedPayloadHash: APPROVAL.payloadHash,
      reason: 'No' + 'pe',
    });
    await portal.cancelApproval({ approvalId: APPROVAL.approvalId, reason: 'Changed my mind' });
    for (const call of calls) expect(JSON.stringify(call.body)).not.toMatch(/merchantId|userId|makerUserId|checkerUserId/);
    expect(procedure(calls[1]!.url)).toBe('merchantControl.approvals.cancel');
  });
  it('turns every approval refusal into plain words that say what to do next', async () => {
    const codes = [
      'approval_not_found',
      'approval_forbidden',
      'approval_self_approval',
      'approval_not_pending',
      'approval_expired',
      'approval_payload_mismatch',
      'approval_mfa_required',
      'approval_state_invalid',
    ];
    const generic = refusalText(
      await (async () => {
        const { portal } = harness(() => refused(400, 'pay.unmapped_code_for_comparison'));
        const r = await portal.decideApproval({
          approvalId: 'a',
          decision: 'approve',
          expectedPayloadHash: APPROVAL.payloadHash,
          reason: 'abc',
        });
        if (r.ok) throw new Error('expected refusal');
        return r;
      })(),
    );
    for (const code of codes) {
      const { portal } = harness(() => refused(409, `pay.${code}`));
      const r = await portal.decideApproval({
        approvalId: 'a',
        decision: 'approve',
        expectedPayloadHash: APPROVAL.payloadHash,
        reason: 'abc',
      });
      if (r.ok) throw new Error('expected refusal');
      expect(r.message, code).not.toMatch(/pay\./);
      expect(r.message, code).not.toBe(generic);
      expect(r.message, code).toBe(refusalText(r));
    }
  });
  it('words the self-approval and fingerprint refusals so the checker knows what happened', async () => {
    const own = harness(() => refused(403, 'pay.approval_self_approval'));
    const a = await own.portal.decideApproval({
      approvalId: 'a',
      decision: 'approve',
      expectedPayloadHash: APPROVAL.payloadHash,
      reason: 'abc',
    });
    expect(!a.ok && a.message).toMatch(/asked for this payout.*someone else/i);
    const changed = harness(() => refused(409, 'pay.approval_payload_mismatch'));
    const b = await changed.portal.decideApproval({
      approvalId: 'a',
      decision: 'approve',
      expectedPayloadHash: APPROVAL.payloadHash,
      reason: 'abc',
    });
    expect(!b.ok && b.message).toMatch(/changed.*not recorded/i);
  });
  it('words the pricing, payment and settlement refusals, and treats a missing control room as arriving soon', async () => {
    const check = async (code: string) => {
      const { portal } = harness(() => refused(404, code));
      const r = await portal.payment(PAYMENT.id);
      if (r.ok) throw new Error('expected refusal');
      return r;
    };
    expect(refusalText(await check('pay.payment_not_found'))).toBe('We could not find that payment.');
    expect(refusalText(await check('pay.settlement_not_found'))).toBe('We could not find that settlement.');
    expect(refusalText(await check('pay.pricing_unconfigured'))).toMatch(/No price is set/);
    expect(refusalText(await check('pay.merchant_forbidden'))).toMatch(/does not have access/);
    const missing = await check('pay.not_built');
    expect(isComingSoon(missing)).toBe(true);
  });
  it('refuses without a session before any request leaves', async () => {
    const calls: unknown[] = [];
    const api = createApiClient({ fetch: (async (...a: unknown[]) => (calls.push(a), new Response('{}'))) as unknown as typeof fetch });
    const portal = createPortalApi(api, null);
    expect((await portal.payments(M, '', 25)).ok).toBe(false);
    expect(
      (await portal.decideApproval({ approvalId: 'a', decision: 'approve', expectedPayloadHash: APPROVAL.payloadHash, reason: 'abc' })).ok,
    ).toBe(false);
    expect(calls).toEqual([]);
  });
});
