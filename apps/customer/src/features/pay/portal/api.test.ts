import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../../shared/api';
import { createPortalApi } from './api';
import { isNotLive, refusalText } from './refusal';

type Call = { url: string; method: string; body: unknown };
function harness(reply: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const { status = 200, body } = reply(call);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  const api = createApiClient({ fetch: fetcher });
  return { calls, portal: createPortalApi(api, 'user-1') };
}
const ok = (data: unknown) => ({ body: { result: { data } } });
const refused = (status: number, code: string) => ({ status, body: { error: { message: code, data: { cause: { code } } } } });
const procedure = (url: string) => decodeURIComponent(url.split('/trpc/')[1]!.split('?')[0]!);
const input = (url: string) => JSON.parse(decodeURIComponent(url.split('?input=')[1] ?? 'null'));

describe('portal api', () => {
  it('never sends a merchant id on the operations pages: the server derives it from the session', async () => {
    const { calls, portal } = harness(() => ok({ items: [], nextCursor: null }));
    await portal.disputes(undefined, '');
    await portal.customers(undefined, 'acme');
    await portal.teamList(undefined, '');
    await portal.exportsList(undefined, '', '');
    await portal.notifications(undefined, false, '');
    expect(calls.map((c) => procedure(c.url))).toEqual([
      'merchantOps.disputes.list',
      'merchantOps.customers.list',
      'merchantOps.team.list',
      'merchantOps.exports.list',
      'merchantOps.notifications.list',
    ]);
    for (const call of calls) expect(JSON.stringify(input(call.url))).not.toMatch(/merchantId/i);
  });

  it('asks for a limited page and hands the opaque cursor back untouched', async () => {
    const { calls, portal } = harness(() => ok({ items: [], nextCursor: null }));
    await portal.disputes('opaque-cursor==', 'open');
    expect(input(calls[0]!.url)).toEqual({ limit: 25, cursor: 'opaque-cursor==', status: 'open' });
  });

  it('reads metrics for the named merchant over whole UTC days', async () => {
    const { calls, portal } = harness(() => ok({}));
    await portal.snapshot('m-1', 'rolling_7d');
    await portal.series('m-1', '2026-09-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z');
    expect(procedure(calls[0]!.url)).toBe('merchantMetrics.snapshot');
    expect(input(calls[0]!.url)).toEqual({ merchantId: 'm-1', window: { kind: 'preset', preset: 'rolling_7d' } });
    expect(input(calls[1]!.url)).toEqual({
      merchantId: 'm-1',
      from: '2026-09-16T00:00:00.000Z',
      to: '2026-10-16T00:00:00.000Z',
      bucket: 'day',
    });
  });

  it('refuses a snapshot whose amounts are not exact decimal strings', async () => {
    const bad = {
      merchantId: 'm',
      freshness: { asOf: null, lagSeconds: null },
      balances: [{ assetCode: 'USDT', clearing: 1.5, available: '2' }],
      paymentCount: 0,
      statusMix: [],
      captured: [],
      refunded: [],
      net: [],
      settlements: [],
      averagePayment: [],
      largestPayment: [],
      linkUsage: { linksUsed: 0, paymentsViaLinks: 0 },
      feeRevenue: [],
      conversionVolume: null,
    };
    const { portal } = harness(() => ok(bad));
    const result = await portal.snapshot('m', 'today');
    expect(result.ok).toBe(false);
  });

  it('refuses without a session before any request leaves', async () => {
    const calls: unknown[] = [];
    const api = createApiClient({ fetch: (async (...a: unknown[]) => (calls.push(a), new Response('{}'))) as unknown as typeof fetch });
    const result = await createPortalApi(api, null).disputes(undefined, '');
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
    if (!result.ok) expect(refusalText(result)).toMatch(/sign in/i);
  });

  it('hands a refused change back in plain words for the review dialog to print', async () => {
    const { portal } = harness(() => refused(403, 'pay.team_interactive_only'));
    const result = await portal.invite({ userId: 'u', role: 'viewer' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/two-step sign-in/i);
      expect(result.message).not.toMatch(/pay\./);
      expect(refusalText(result)).toBe(result.message);
    }
  });

  it('sends the idempotency id with a decision and with an export request', async () => {
    const { calls, portal } = harness(() => ({ status: 400, body: { error: { message: 'x' } } }));
    await portal.respond({ requestId: 'r-1', disputeId: 'd-1', action: 'contest' });
    await portal.createExport({ requestId: 'r-2', kind: 'payments', filters: {} });
    expect((calls[0]!.body as { requestId: string }).requestId).toBe('r-1');
    expect((calls[1]!.body as { requestId: string }).requestId).toBe('r-2');
  });
});

describe('plain-English refusals', () => {
  const failed = async (status: number, code: string) => {
    const { portal } = harness(() => refused(status, code));
    const result = await portal.teamMe();
    if (result.ok) throw new Error('expected a refusal');
    return result;
  };
  it('turns a service code into words with a next step and never shows the code', async () => {
    const result = await failed(403, 'pay.team_interactive_only');
    expect(refusalText(result)).toMatch(/two-step sign-in/i);
    expect(refusalText(result)).not.toMatch(/pay\./);
  });
  it('answers a missing dispute and a foreign dispute with the same words (M1)', async () => {
    const a = await failed(404, 'pay.dispute_not_found');
    const b = await failed(404, 'pay.dispute_not_found');
    expect(refusalText(a)).toBe(refusalText(b));
    expect(isNotLive(a)).toBe(false);
  });
  it('treats a not-built or unmounted procedure as arriving soon, not as an error', async () => {
    expect(isNotLive(await failed(501, 'pay.not_built'))).toBe(true);
    const { portal } = harness(() => ({ status: 404, body: { error: { message: 'No "query"-procedure on path "merchantOps.team.me"' } } }));
    const gone = await portal.teamMe();
    expect(!gone.ok && isNotLive(gone)).toBe(true);
  });
  it('hides an unknown code behind a generic message', async () => {
    const result = await failed(400, 'pay.something_new_and_internal');
    expect(refusalText(result)).not.toMatch(/something_new|pay\./);
    expect(refusalText(result).length).toBeGreaterThan(10);
  });
  it('covers every code the operations service can answer with', async () => {
    const codes = [
      'merchant_ops_unavailable',
      'merchant_ops_not_merchant',
      'team_role_forbidden',
      'team_interactive_only',
      'team_member_unavailable',
      'team_self_change_forbidden',
      'team_member_not_found',
      'team_owner_cannot_leave',
      'team_invitation_not_found',
      'team_invite_target_invalid',
      'team_email_invalid',
      'team_user_id_reserved',
      'team_email_invite_unconfigured',
      'team_email_invite_rate_limited',
      'dispute_not_found',
      'dispute_closed',
      'dispute_invalid_transition',
      'dispute_evidence_required',
      'request_id_reused',
      'customer_not_found',
      'export_filter_invalid',
      'export_not_found',
      'export_not_ready',
      'export_expired',
      'notification_not_found',
      'notification_threshold_unsupported',
      'cursor_invalid',
      'merchant_not_found',
      'metrics_window_invalid',
      'metrics_balance_unavailable',
      'invalid_destination_ref',
      'destination_kind_mismatch',
    ];
    const generic = refusalText(await failed(400, 'pay.unmapped_code_for_comparison'));
    for (const code of codes) {
      const text = refusalText(await failed(400, `pay.${code}`));
      expect(text, code).not.toBe(generic);
      expect(text, code).not.toMatch(/pay\./);
    }
  });

  it('creates the account with the merchant names beside the pricing, and never sends an owner', async () => {
    const { calls, portal } = harness(() =>
      ok({ id: '22222222-2222-4222-8222-222222222222', userId: '33333333-3333-4333-8333-333333333333', mode: 'gateway', feeBps: 150 }),
    );
    await portal.createMerchant(150, { legalName: 'Acme Ltd', country: 'GB' }, { legalName: 'Acme Ltd', displayName: 'Acme Shop' });
    await portal.createMerchant(150, { legalName: 'Acme Ltd' }, { legalName: 'Acme Ltd' });
    expect(calls.map((c) => procedure(c.url))).toEqual(['merchant.create', 'merchant.create']);
    expect(calls[0]!.body).toEqual({
      mode: 'gateway',
      pricing: { feeBps: 150 },
      settlementPrefs: { businessDetails: { legalName: 'Acme Ltd', country: 'GB' } },
      legalName: 'Acme Ltd',
      displayName: 'Acme Shop',
    });
    expect(calls[1]!.body).not.toHaveProperty('displayName');
    for (const call of calls) expect(JSON.stringify(call.body)).not.toMatch(/userId|merchantId/);
  });
});
