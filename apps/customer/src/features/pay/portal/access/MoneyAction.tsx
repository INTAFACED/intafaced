import type { ReactElement } from 'react';
import { useOptionalMerchantAccess } from './MerchantAccess';
import { moneyReason, type MoneyKind } from './money-step';
import { DisabledAction } from './NoBusiness';

/**
 * A control that sends money out (Refund, Pay out, Send this payout). It is drawn as given when the signed-in session
 * carries the scope, and otherwise as the same button switched off with the reason beside it (`money-step.ts`).
 * Anywhere the session cannot be read, it is off: nothing here guesses that money may move.
 */
export function MoneyAction({ kind, children }: { kind: MoneyKind; children: ReactElement }) {
  const access = useOptionalMerchantAccess();
  const reason = access ? access.moneyReason(kind) : moneyReason(kind, null);
  return reason ? <DisabledAction action={children} reason={reason} /> : children;
}

/** The reason for a money control that is not a button (a sentence above a list, a callout), or null. */
export function useMoneyReason(kind: MoneyKind): string | null {
  const access = useOptionalMerchantAccess();
  return access ? access.moneyReason(kind) : moneyReason(kind, null);
}
