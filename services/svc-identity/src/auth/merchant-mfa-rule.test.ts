import { describe, expect, it } from 'vitest';
import { fetchMerchantMfaRule, isRestriction, merchantMfaSignal, MERCHANT_MFA_ENROL_SCOPES, restrictScopes } from './merchant-mfa-rule.js';

const USER = '22222222-2222-4222-8222-222222222222';
const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('merchant require-MFA decision (M-plat-org-06)', () => {
  it('maps each rule and enrolment to a signal', () => {
    expect(merchantMfaSignal('required', false)).toBe('enrol_required');
    expect(merchantMfaSignal('required', true)).toBe('second_step_required');
    expect(merchantMfaSignal('unset', false)).toBe('rule_unset');
    expect(merchantMfaSignal('unset', true)).toBe('rule_unset');
    expect(merchantMfaSignal('not_required', false)).toBeNull();
    expect(merchantMfaSignal('none', false)).toBeNull();
  });

  it('restricts only for enrol_required and second_step_required', () => {
    const all = ['identity:read', 'identity:write', 'trade:read'] as const;
    expect(restrictScopes([...all], 'enrol_required')).toEqual([...MERCHANT_MFA_ENROL_SCOPES]);
    expect(restrictScopes([...all], 'second_step_required')).toEqual([...MERCHANT_MFA_ENROL_SCOPES]);
    expect(restrictScopes([...all], null)).toEqual([...all]);
    expect(isRestriction('rule_unset')).toBe(false);
  });
});

describe('fetchMerchantMfaRule', () => {
  it('signs a POST to /internal/merchant-mfa-rule and returns the rule', async () => {
    let seen: { url: string; body: string; signed: boolean } | null = null;
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      seen = { url: String(url), body: String(init.body), signed: Object.keys(init.headers as object).length > 1 };
      return new Response(JSON.stringify({ rule: 'required' }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchMerchantMfaRule({ payUrl: 'http://pay.test', secret: 's'.repeat(32), userId: USER, fetchImpl })).toBe('required');
    expect(seen).toEqual({ url: 'http://pay.test/internal/merchant-mfa-rule', body: JSON.stringify({ userId: USER }), signed: true });
  });

  it('throws on a non-2xx, and on a reply that is not a known rule', async () => {
    const base = { payUrl: 'http://pay.test', secret: 's'.repeat(32), userId: USER };
    await expect(fetchMerchantMfaRule({ ...base, fetchImpl: reply(503, {}) })).rejects.toThrow('HTTP 503');
    await expect(fetchMerchantMfaRule({ ...base, fetchImpl: reply(200, { rule: 'maybe' }) })).rejects.toThrow('no rule');
    await expect(fetchMerchantMfaRule({ ...base, fetchImpl: reply(200, {}) })).rejects.toThrow('no rule');
  });
});
