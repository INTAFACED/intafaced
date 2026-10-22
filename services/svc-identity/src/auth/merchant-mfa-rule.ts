/**
 * The merchant owner's team-wide require-MFA rule, enforced at sign-in (M-plat-org-06, org-access-019).
 *
 * svc-pay holds the rule (`merchantOps.security`) and knows who is on which
 * team; it answers `POST /internal/merchant-mfa-rule` with one of
 * `required | not_required | unset | none` for a user. This file is the
 * client and the decision. The decision only matters for a session that did
 * NOT pass a second factor: a session that did already meets the rule, and
 * pay is not asked.
 *
 *   required, no factor enrolled   → `enrol_required`: the session is issued
 *       with enrolment scopes only (identity:read, identity:write), so the
 *       person can enrol a factor but reach nothing else, the merchant portal
 *       included, until they sign in again with that factor.
 *   required, factor enrolled      → `second_step_required`: the same
 *       restricted session (a password-only sign-in on a passkey-only account).
 *   unset                          → the owner has not chosen. Sign-in is NOT
 *       restricted, and the session carries `rule_unset` so the portal can ask
 *       the owner to choose. Restricting every merchant before its owner chose
 *       would lock teams out on the day this ships.
 *   not_required, none             → no signal; an ordinary session.
 *   pay unreachable or a bad reply → sign-in refuses
 *       `auth.merchant_mfa_rule_unavailable` (fail closed). Only sessions
 *       without a second factor ask, so a person with MFA still signs in.
 *
 * The restriction is stored on the session row (`sessions.merchant_mfa`) so a
 * refresh keeps it; it ends only with a new sign-in.
 */

import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import type { Scope } from '@intafaced/auth';

export const MERCHANT_MFA_RULES = ['required', 'not_required', 'unset', 'none'] as const;
export type MerchantMfaRule = (typeof MERCHANT_MFA_RULES)[number];

/** Stored on the session row: the session may only enrol. */
export type MerchantMfaRestriction = 'enrol_required' | 'second_step_required';
/** On the sign-in reply. */
export type MerchantMfaSignal = MerchantMfaRestriction | 'rule_unset';

export type MerchantMfaRuleRead = (userId: string) => Promise<MerchantMfaRule>;

/** The only scopes a restricted session carries: enough to enrol a factor and to sign out. */
export const MERCHANT_MFA_ENROL_SCOPES: readonly Scope[] = ['identity:read', 'identity:write'];

export function merchantMfaSignal(rule: MerchantMfaRule, hasFactor: boolean): MerchantMfaSignal | null {
  if (rule === 'required') return hasFactor ? 'second_step_required' : 'enrol_required';
  if (rule === 'unset') return 'rule_unset';
  return null;
}

export function isRestriction(signal: MerchantMfaSignal | string | null | undefined): signal is MerchantMfaRestriction {
  return signal === 'enrol_required' || signal === 'second_step_required';
}

/** A restricted session keeps only the enrolment scopes it already holds. */
export function restrictScopes(scopes: readonly Scope[], restriction: string | null | undefined): Scope[] {
  if (!isRestriction(restriction)) return [...scopes];
  return scopes.filter((s) => MERCHANT_MFA_ENROL_SCOPES.includes(s));
}

export async function fetchMerchantMfaRule(input: {
  payUrl: string;
  secret: string;
  userId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
}): Promise<MerchantMfaRule> {
  const body = JSON.stringify({ userId: input.userId });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), input.timeoutMs ?? 2_000);
  try {
    const target = new URL('/internal/merchant-mfa-rule', input.payUrl);
    const sign = serviceCallSigner({ service: 'svc-identity', audience: 'svc-pay', legacySecret: input.secret, s2s: input.s2s });
    const res = await (input.fetchImpl ?? fetch)(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...sign(body, { method: 'POST', url: target, contentType: 'application/json' }) },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`merchant MFA rule lookup returned HTTP ${res.status}`);
    const json = (await res.json()) as { rule?: unknown };
    const rule = json?.rule;
    if (typeof rule !== 'string' || !(MERCHANT_MFA_RULES as readonly string[]).includes(rule)) {
      throw new Error('merchant MFA rule lookup returned no rule');
    }
    return rule as MerchantMfaRule;
  } finally {
    clearTimeout(timer);
  }
}
