/**
 * A liquidation loss stays on the liquidated book.
 *
 * It may debit that position's collateral and the insurance fund. It may not
 * debit a sibling sub-account, and it may not draw the shortfall out of house
 * fees. House fees are the realised-loss sink (money arrives there), not a
 * second insurance fund. An uncovered shortfall is parked by the insurance bound.
 */
import type { PostRequest } from '@intafaced/ledger-client';

export const SIBLING_SUB_ACCOUNT_LOSS = 'trade.sub_account_loss_isolated' as const;
export const HOUSE_FEES_NOT_INSURANCE = 'trade.house_fees_not_insurance' as const;

export function gateLiquidationRecipe(
  row: { readonly userId: string; readonly subAccountId?: string | null },
  recipe: PostRequest,
): { readonly ok: true } | { readonly ok: false; readonly code: string; readonly reason: string } {
  for (const entry of recipe.entries) {
    const account = entry.account;
    if (account.ownerType === 'subaccount') {
      const owner = row.subAccountId ?? '';
      if (owner === '' || account.ownerId !== owner) {
        return {
          ok: false,
          code: SIBLING_SUB_ACCOUNT_LOSS,
          reason: 'a liquidation loss cannot debit a sibling sub-account — the shortfall stays on this book',
        };
      }
    }
    if (entry.direction === 'credit' && account.ownerType === 'house' && account.ownerId.startsWith('fees:')) {
      return {
        ok: false,
        code: HOUSE_FEES_NOT_INSURANCE,
        reason: 'house fees are not a substitute insurance fund — an uncovered shortfall is parked, not drawn from fees',
      };
    }
  }
  return { ok: true };
}
