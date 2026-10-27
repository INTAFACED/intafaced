import type { AccountLimitOverride, AccountLimitPolicy, AccountLimitResult } from '@intafaced/contracts/account-controls';
import type { WithdrawalAllowance } from '@intafaced/contracts';
import { compareDecimal } from '@/lib/merchants/money';

/**
 * A customer's limit overrides as the console shows them (OPS-accounts-desk-03, J-ops-console-04 #12). Identity keeps the
 * overrides and decides; the base limits stay with the service that enforces them. Pure and browser-safe: the figures'
 * comparison with the owner ceiling (which decides whether the other founder must approve) and the words for identity's
 * answers.
 */

/** Whether either figure goes above the ceiling, so the override needs the other founder's approval. */
export function aboveCeiling(figures: { perTx: string | null; rolling24h: string | null }, ceiling: string): boolean {
  return [figures.perTx, figures.rolling24h].some((figure) => figure !== null && compareDecimal(figure, ceiling) > 0);
}

export function ceilingFor(policy: AccountLimitPolicy, rail: string, assetId: string): string | null {
  if (!policy.configured) return null;
  return policy.ceilings.find((row) => row.rail === rail && row.assetId === assetId)?.ceiling ?? null;
}

export function overrideFigures(row: Pick<AccountLimitOverride, 'perTx' | 'rolling24h'>): string {
  return `per transaction ${row.perTx ?? 'base'} · over 24 hours ${row.rolling24h ?? 'base'}`;
}

const REFUSAL_WORDS: Readonly<Record<Extract<AccountLimitResult, { outcome: 'refused' }>['code'], string>> = {
  'operator.denied': 'Identity accepts this only from a live founder. Nothing was changed.',
  'mfa.required': 'Identity needs a session with a second factor. Sign in again. Nothing was changed.',
  'target.not_found': 'Identity has no customer with this id. Nothing was changed.',
  'request.conflict': 'This change was already asked for on this reading in other words. Read the account again. Nothing was changed.',
  'identity.limit_ceiling_unset':
    'The owner has not set the limit override policy for this rail and asset (IDENTITY_LIMIT_OVERRIDE_POLICY), so identity sets no override (identity.limit_ceiling_unset). Nothing was changed.',
  'identity.limit_expiry_past': 'That end time has already passed (identity.limit_expiry_past). Nothing was changed.',
  'identity.limit_lifetime_exceeded':
    'That end time is beyond the longest lifetime the owner allows (identity.limit_lifetime_exceeded). Nothing was changed.',
  'identity.limit_unchanged': 'That override is already in force with the same figures and end time. Nothing was changed.',
  'identity.limit_self_forbidden':
    'A founder does not change the limits of their own account (identity.limit_self_forbidden). Nothing was changed.',
  'identity.limit_account_closed':
    'The account is closed, so identity sets no override (identity.limit_account_closed). Nothing was changed.',
  'identity.account_archived':
    'The customer record is archived, so identity keeps it read-only (identity.account_archived). Nothing was changed.',
  'identity.limit_requires_approver':
    'This override goes above the owner’s ceiling, so the other founder must approve it first (identity.limit_requires_approver). Nothing was changed.',
  'identity.limit_approval_mismatch':
    'The approval does not match this override, or was not given by the other founder (identity.limit_approval_mismatch). Nothing was changed.',
  'identity.limit_approval_consumed': 'That approval was already used (identity.limit_approval_consumed). Nothing more was changed.',
  'identity.limit_override_not_found': 'No override of this rail and asset is in force; the base limit applies. Nothing was changed.',
  'identity.limit_override_expired':
    'That override already ended at its stored time; the base limit applies again (identity.limit_override_expired). Nothing was changed.',
};

/** What identity answered, in words. Only `changed` changed anything. */
export function limitsReply(result: AccountLimitResult): { readonly ok: boolean; readonly text: string } {
  switch (result.outcome) {
    case 'changed':
      return {
        ok: true,
        text:
          result.action === 'clear'
            ? `Ended: the ${result.rail} override for ${result.assetId} is cleared and the base limit applies (override version ${result.after.version}).`
            : `Saved: ${overrideFigures(result.after)} ${result.assetId} until ${new Date(result.after.expiresAt).toLocaleString()} (override version ${result.after.version})${result.approverUserId ? `, approved by ${result.approverUserId.slice(0, 8)}` : ''}.`,
      };
    case 'conflict':
      return {
        ok: false,
        text: 'The override changed since you read it (restriction.version_conflict). Read the account again. Nothing was changed.',
      };
    case 'refused':
      return { ok: false, text: REFUSAL_WORDS[result.code] };
  }
}

/** Why svc-pay could not give a customer's withdrawal allowance, in words, by its own code. Unknown codes are named as they are. */
const ALLOWANCE_REFUSALS: Readonly<Record<string, string>> = {
  'pay.guard_withdrawal_limit_unset':
    'The owner has not set a withdrawal limit for this customer’s verification level and asset, so svc-pay refuses every withdrawal of it (pay.guard_withdrawal_limit_unset).',
  'pay.guard_withdrawal_limits_off':
    'svc-pay does not enforce withdrawal limits in this deployment (PAY_WITHDRAWAL_LIMITS is off), so there is no allowance to show (pay.guard_withdrawal_limits_off).',
  'pay.guard_withdrawal_tier_unwired':
    'svc-pay has no identity connection for the verification level, so it refuses every withdrawal (pay.guard_withdrawal_tier_unwired).',
  'pay.guard_withdrawal_override_unwired':
    'svc-pay has no identity connection for limit overrides, so it refuses every withdrawal (pay.guard_withdrawal_override_unwired).',
  'pay.guard_withdrawal_limits_unwired': 'svc-pay has no withdrawal limit read wired (pay.guard_withdrawal_limits_unwired).',
  'pay.guard_unavailable':
    'svc-pay could not read identity for this customer, so it refuses withdrawals until it can (pay.guard_unavailable).',
};

export function allowanceRefusal(code: string | null): string {
  if (code && ALLOWANCE_REFUSALS[code]) return ALLOWANCE_REFUSALS[code];
  return `svc-pay did not answer with this customer’s withdrawal allowance${code ? ` (${code})` : ''}.`;
}

/** One asset's row on the console: what svc-pay applies, or svc-pay's code for why it could not say. */
export type AllowanceRow =
  { readonly assetId: string; readonly allowance: WithdrawalAllowance } | { readonly assetId: string; readonly refused: string };

/** The assets svc-pay has a base withdrawal limit set for, from `founderAdmin.limits.list`, or null for an answer off that shape. */
export function allowanceAssets(listed: unknown): string[] | null {
  if (!Array.isArray(listed)) return null;
  const assets = new Set<string>();
  for (const row of listed) {
    if (!row || typeof row !== 'object') return null;
    const { assetId, limit } = row as { assetId?: unknown; limit?: unknown };
    if (typeof assetId !== 'string' || assetId === '' || assetId.length > 16) return null;
    if (limit !== null) assets.add(assetId);
  }
  return [...assets].sort();
}
