// hand-declared-ok: the accountClosure answers are declared in svc-identity, not in packages/contracts yet
import { z } from 'zod';

export const closureBlocker = z.object({ code: z.string(), count: z.number().int() });
export const closureBalance = z.object({ assetId: z.string(), amount: z.string() });
export const closureCheck = z.object({ blockers: z.array(closureBlocker), balances: z.array(closureBalance) });
export type ClosureCheck = z.infer<typeof closureCheck>;

export const closureView = z.object({
  id: z.string().guid(),
  status: z.enum(['requested', 'cancelled', 'blocked', 'closed']),
  requestedAt: z.string(),
  effectiveAt: z.string(),
  finalizedAt: z.string().nullable(),
  clientRequestId: z.string(),
  blockers: z.array(closureBlocker),
});
export type ClosureView = z.infer<typeof closureView>;
export const closureStatus = z.object({ closure: closureView.nullable() });

export const CLOSE_SCOPE = 'identity.step_up.close_account';

/** The body of `stepUp.begin` for closing or cancelling: the three fields the service re-hashes, the request id as target. */
export function closeStepUp(intent: 'request' | 'cancel', clientRequestId: string) {
  return { scope: CLOSE_SCOPE, purpose: 'account.close', target: clientRequestId, fields: { intent, clientRequestId } };
}

/** Blocker codes the money services return, with the key of the sentence that names each. Anything else is shown by its count only. */
export const BLOCKER_KEYS: Readonly<Record<string, string>> = {
  balance_remaining: 'blockBalance',
  open_loan: 'blockLoan',
  earn_position: 'blockEarn',
  active_card: 'blockCard',
  active_schedule: 'blockSchedule',
  pending_ramp: 'blockRamp',
  open_order: 'blockOrder',
  open_position: 'blockPosition',
  open_offer: 'blockOffer',
  open_trade: 'blockTrade',
  open_dispute: 'blockDispute',
};

/** Typed refusals the card words itself; any other code falls through to the shared failure view. */
export const CLOSE_REFUSAL_KEYS: Readonly<Record<string, string>> = {
  'identity.close_disabled': 'refusedUnavailable',
  'identity.close_cooling_off_unset': 'refusedUnavailable',
  'identity.close_check_unavailable': 'refusedCheck',
  'identity.close_blocked': 'refusedBlocked',
  'identity.close_restricted': 'refusedRestricted',
  'identity.close_account_not_active': 'refusedNotActive',
  'identity.close_founder_forbidden': 'refusedFounder',
  'identity.close_delegated': 'refusedDelegated',
  'identity.close_nothing_open': 'refusedNothingOpen',
};

export const isSixDigits = (value: string): boolean => /^\d{6}$/.test(value.trim());

/** Whole days left until the end date, rounded up; 0 once it has passed. Display only: the service closes at the date. */
export function daysLeft(effectiveAt: string, now: number): number {
  const ms = Date.parse(effectiveAt) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 86_400_000) : 0;
}
