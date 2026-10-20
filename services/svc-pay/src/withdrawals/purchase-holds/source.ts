import { formatAmount, userAvailable, type LedgerClient } from '@intafaced/ledger-client';
import type { EligibilitySource } from '../eligibility.js';
import type { PurchaseHoldGuard } from './service.js';

/**
 * The `purchase_hold` eligibility check (W-withdraw-13): blocked only when the customer has funds held after a card,
 * ACH or PayPal purchase and nothing else of that asset is free to withdraw. Funds above the held amount stay
 * withdrawable, so a customer with more than the hold is clear. The balance is read from the LEDGER.
 */
export function purchaseHoldSource(guard: PurchaseHoldGuard, ledger: Pick<LedgerClient, 'balance'>): EligibilitySource {
  return async (userId, assetId) => {
    const held = await guard.held(userId, assetId);
    if (held.heldAmount === 0n) return { state: 'clear' };
    const available = (await ledger.balance(userAvailable(userId, assetId))).amount;
    if (available > held.heldAmount) return { state: 'clear' };
    const until = held.earliestReleaseAt ? `until ${held.earliestReleaseAt}` : 'and the release period has not been set yet';
    return { state: 'blocked', detail: `${formatAmount(held.heldAmount)} ${assetId} bought by card, ACH or PayPal is held ${until}` };
  };
}
