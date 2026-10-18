import type { ReactElement } from 'react';
import { MerchantAccessContext, type MerchantAccessValue } from './MerchantAccess';
import { ownerOnlyReason, type MoneyKind } from './money-step';

/**
 * For tests: draws a page as a person who may (`allowed`) or may not begin a refund or a payout (an owner of an active
 * account, or anyone else), without the reads the real provider makes. Only the parts the money controls read are filled in.
 */
export function withMoneyAccess(page: ReactElement, allowed: boolean): ReactElement {
  const sessionScopes = new Set(['pay:read', 'pay:write']);
  const value = {
    sessionScopes,
    moneyReason: (kind: MoneyKind) => (allowed ? null : ownerOnlyReason(kind)),
  } as unknown as MerchantAccessValue;
  return <MerchantAccessContext.Provider value={value}>{page}</MerchantAccessContext.Provider>;
}
