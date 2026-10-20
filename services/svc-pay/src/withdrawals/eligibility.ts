import { userAvailable, type LedgerClient } from '@intafaced/ledger-client';

/**
 * Can this customer start a withdrawal right now, and if not, why (W-withdraw-06)? One check per reason the platform
 * can name. A check answers `clear`, `blocked` or `unwired`. `unwired` means the service that knows is not connected
 * here yet: it is shown as such and it blocks, because "not checked" is never "fine". The submit path still decides
 * under its own locks; this read only tells the customer before they try.
 */
export const ELIGIBILITY_REASONS = [
  'hold_after_password_change',
  'open_orders',
  'margin_in_use',
  'negative_balance',
  'frozen_credit',
  'wallet_removed',
] as const;
export type EligibilityReason = (typeof ELIGIBILITY_REASONS)[number];

export type EligibilityState = 'clear' | 'blocked' | 'unwired';

export interface EligibilityCheck {
  readonly reason: EligibilityReason;
  readonly state: EligibilityState;
  /** Why it is unwired, or when a hold ends, in words; never a figure we made up. */
  readonly detail: string | null;
}

export interface EligibilityView {
  /** True only when every check is clear. */
  readonly eligible: boolean;
  readonly checks: EligibilityCheck[];
}

/** What one check returns. `blocked` may carry a plain-words detail such as the time the hold ends. */
export type CheckAnswer = { state: 'clear' } | { state: 'blocked'; detail?: string };

export type EligibilitySource = (userId: string, assetId: string) => Promise<CheckAnswer>;

/** A source per reason that has an owner. A reason with no source reads `unwired` with the service named. */
export type EligibilitySources = Partial<Record<EligibilityReason, EligibilitySource>>;

const UNWIRED_BY: Record<EligibilityReason, string> = {
  hold_after_password_change: 'svc-identity does not publish the post-password-change hold here yet',
  open_orders: 'svc-trade does not publish open orders for withdrawal checks here yet',
  margin_in_use: 'svc-trade does not publish margin in use for withdrawal checks here yet',
  negative_balance: 'the ledger is not connected here',
  frozen_credit: 'svc-identity does not publish frozen credit here yet',
  wallet_removed: 'the custody wallet record is not connected here yet',
};

/** The one check this service can answer itself: a negative available balance, read from the LEDGER. */
export function ledgerNegativeBalanceSource(ledger: Pick<LedgerClient, 'balance'>): EligibilitySource {
  return async (userId, assetId) => {
    const { amount } = await ledger.balance(userAvailable(userId, assetId));
    return amount < 0n ? { state: 'blocked' } : { state: 'clear' };
  };
}

export function createWithdrawalEligibility(sources: EligibilitySources) {
  return {
    async read(userId: string, assetId: string): Promise<EligibilityView> {
      const checks = await Promise.all(
        ELIGIBILITY_REASONS.map(async (reason): Promise<EligibilityCheck> => {
          const source = sources[reason];
          if (!source) return { reason, state: 'unwired', detail: UNWIRED_BY[reason] };
          try {
            const answer = await source(userId, assetId);
            return { reason, state: answer.state, detail: answer.state === 'blocked' ? (answer.detail ?? null) : null };
          } catch {
            // A source that cannot answer is not a clear.
            return { reason, state: 'unwired', detail: 'the check could not be answered; try again' };
          }
        }),
      );
      return { eligible: checks.every((c) => c.state === 'clear'), checks };
    },
  };
}
export type WithdrawalEligibility = ReturnType<typeof createWithdrawalEligibility>;
