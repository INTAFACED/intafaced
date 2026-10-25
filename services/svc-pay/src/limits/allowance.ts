import { compare, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import type { WithdrawalLimit } from './config.js';
import type { LimitOverride } from './identity-override.js';

/**
 * What a customer has used of a withdrawal limit (D-148), and what is left.
 *
 * ONE definition, used by the guard that refuses and the read that tells the
 * customer how much they may still send, so the two cannot disagree.
 *
 * The rolling sum counts every withdrawal of the same asset updated in the last
 * 24 hours EXCEPT the ones that can no longer move value (`failed`, `canceled`).
 * It is a deny-list on purpose: a state added later (`pending_review`, `held`,
 * `broadcast`, ...) counts toward the limit until someone decides it should not,
 * which fails closed. The window runs on `updated_at`, not `created_at`: reopening
 * a failed claim resets it, so an old reference retried today counts as today.
 */
export const WITHDRAWAL_STATES_NOT_COUNTED = ['failed', 'canceled'] as const;

export interface Allowance {
  readonly perTx: Amount;
  readonly rolling24h: Amount;
  readonly used24h: Amount;
  /** What is left of the rolling figure. Never negative. */
  readonly left24h: Amount;
  /** The most one withdrawal may be right now: the smaller of the per-transaction figure and what is left. */
  readonly maxNow: Amount;
}

/**
 * `windowSeconds` lets the custody policy guard (W-custody-ops-07) share this one definition for its own
 * cumulative windows; the D-148 callers pass nothing and keep the 24-hour window.
 */
export async function usedInWindow(
  q: Sql,
  query: { userId: string; assetId: string; exceptClientRef?: string; windowSeconds?: number },
): Promise<Amount> {
  const rows = await q<Array<{ used: string }>>`
    SELECT COALESCE(SUM(amount), 0)::text AS used
      FROM pay.withdrawals
     WHERE user_id = ${query.userId} AND asset_id = ${query.assetId}
       AND status::text NOT IN ${q([...WITHDRAWAL_STATES_NOT_COUNTED])}
       AND updated_at > now() - make_interval(secs => ${query.windowSeconds ?? 86_400})
       AND client_ref <> ${query.exceptClientRef ?? ''}
  `;
  return parseAmount(rows[0]?.used ?? '0');
}

export function allowanceOf(limit: WithdrawalLimit, used: Amount): Allowance {
  const left24h = limit.rolling24h > used ? limit.rolling24h - used : 0n;
  return {
    perTx: limit.perTx,
    rolling24h: limit.rolling24h,
    used24h: used,
    left24h,
    maxNow: compare(limit.perTx, left24h) < 0 ? limit.perTx : left24h,
  };
}

/**
 * The figures in force: a founder's override (J-ops-console-04 #12) replaces the base figure it names and keeps the other,
 * until its stored end time, after which identity answers `null` and the base applies again. An override may be higher or
 * lower than the base; identity already required the other founder for one above the owner ceiling.
 */
export function inForce(base: WithdrawalLimit, override: LimitOverride | null): WithdrawalLimit {
  if (!override) return base;
  return { perTx: override.perTx ?? base.perTx, rolling24h: override.rolling24h ?? base.rolling24h };
}
