import { useOptionalMerchantAccess } from './MerchantAccess';
import { moneyReason, type MoneyKind, type PayoutAct } from './money-step';

/** The reason for a money control that is not a button (a sentence above a list, a callout), or null. */
export function useMoneyReason(kind: MoneyKind, act?: PayoutAct): string | null {
  const access = useOptionalMerchantAccess();
  return access ? access.moneyReason(kind, act) : moneyReason(kind, null);
}
