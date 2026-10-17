import type { ReactElement } from 'react';
import { MerchantAccessContext, type MerchantAccessValue } from './MerchantAccess';
import { moneyReason, type MoneyKind } from './money-step';

/**
 * For tests: draws a page as a session that does (`held`) or does not carry the refund and payout scopes, without the
 * reads the real provider makes. Only the parts the money controls read are filled in.
 */
export function withMoneyScopes(page: ReactElement, held: boolean): ReactElement {
  const sessionScopes = new Set(held ? ['pay:read', 'pay:write', 'pay:refund', 'pay:payout'] : ['pay:read', 'pay:write']);
  const value = { sessionScopes, moneyReason: (kind: MoneyKind) => moneyReason(kind, sessionScopes) } as unknown as MerchantAccessValue;
  return <MerchantAccessContext.Provider value={value}>{page}</MerchantAccessContext.Provider>;
}
