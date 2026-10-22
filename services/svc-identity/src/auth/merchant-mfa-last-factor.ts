/**
 * Removing the last second factor while a merchant this person is on requires MFA is refused
 * `auth.merchant_mfa_last_factor` (M-plat-org-06, Failures row). Removing one of several factors,
 * or any factor when the rule is `not_required`, `unset` or `none`, is allowed. Pay unreachable
 * refuses `auth.merchant_mfa_rule_unavailable` (fail closed). With no rule source wired (no
 * PAY_URL), removal is not checked against the rule.
 *
 * Read outside the removal transaction (the rule is in svc-pay; no pay round trip inside a lock).
 */
import type { Sql } from 'postgres';
import { AuthError } from './auth-service.js';
import type { MerchantMfaRuleRead } from './merchant-mfa-rule.js';

export type FactorRemoval = { readonly kind: 'totp' } | { readonly kind: 'passkey'; readonly credentialId: string };

export async function assertMayDropFactor(
  sql: Sql,
  read: MerchantMfaRuleRead | null | undefined,
  userId: string,
  removal: FactorRemoval,
): Promise<void> {
  if (!read) return;
  const rows = await sql<Array<{ totp_secret: string | null; webauthn_creds: unknown }>>`
    SELECT totp_secret, webauthn_creds FROM users WHERE id = ${userId}`;
  const row = rows[0];
  if (!row) return;
  const creds = Array.isArray(row.webauthn_creds) ? (row.webauthn_creds as Array<{ credentialId?: unknown }>) : [];
  const leftAfter =
    removal.kind === 'totp'
      ? creds.length > 0
      : Boolean(row.totp_secret) || creds.filter((c) => c?.credentialId !== removal.credentialId).length > 0;
  // Nothing would be removed (unknown passkey, TOTP already off): the removal path answers that itself.
  const removesSomething = removal.kind === 'totp' ? Boolean(row.totp_secret) : creds.some((c) => c?.credentialId === removal.credentialId);
  if (leftAfter || !removesSomething) return;
  let rule;
  try {
    rule = await read(userId);
  } catch {
    throw new AuthError('Sign-in is unavailable right now. Try again shortly.', 'auth.merchant_mfa_rule_unavailable');
  }
  if (rule === 'required') {
    throw new AuthError('Your business requires two-step sign-in; add another method first', 'auth.merchant_mfa_last_factor');
  }
}
