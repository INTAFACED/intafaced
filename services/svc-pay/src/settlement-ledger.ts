import { recipes, type Amount, type PostRequest } from '@intafaced/ledger-client';

export type SettlementDestinationKind = 'bank' | 'crypto';

export interface SettlementLedgerInput {
  settlementId: string;
  payoutAttempt: number;
  merchantId: string;
  assetId: string;
  amount: Amount;
  railId: string;
  destinationKind: string;
}

export interface SettlementLedgerPlan {
  withdrawalId: string;
  destinationKind: SettlementDestinationKind;
  hold: PostRequest;
  settle: PostRequest;
  reverse: PostRequest;
}

/**
 * Builds the ledger side of a bank-or-crypto settlement payout.
 *
 * Both destinations have the same balance movement: merchant proceeds → a
 * purpose-keyed hold on that same owner → the selected rail boundary, or back
 * to proceeds if the rail refuses. The rail adapter owns the bank/chain
 * difference. This function composes the proceeds payout trio, not the
 * personal `withdrawHold` recipes (those debit `userAvailable`).
 */
export function settlementLedgerPlan(input: SettlementLedgerInput): SettlementLedgerPlan {
  if (input.destinationKind !== 'bank' && input.destinationKind !== 'crypto') {
    throw new Error(`Settlement destination kind '${input.destinationKind}' is unsupported — expected bank or crypto`);
  }

  const withdrawalId = `${input.settlementId}:${input.payoutAttempt}`;
  const payout = {
    merchantId: input.merchantId,
    assetId: input.assetId,
    amount: input.amount,
    rail: input.railId,
    withdrawalId,
  };

  return {
    withdrawalId,
    destinationKind: input.destinationKind,
    hold: recipes.merchantProceedsPayoutHold(payout),
    settle: recipes.merchantProceedsPayoutSettle(payout),
    reverse: recipes.merchantProceedsPayoutReverse(payout),
  };
}
