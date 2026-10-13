import { recipes, type Amount, type LedgerClient } from '@intafaced/ledger-client';

/**
 * Sole production post for chargeback money: ledger-client `chargebackOpen`.
 * Legs are the recipe's two caller-supplied pots — no invented shortfall.
 */
export async function postDisputeOpening(
  ledger: LedgerClient,
  input: {
    disputeId: string;
    paymentId: string;
    merchantId: string;
    merchantUserId: string;
    assetId: string;
    rail: string;
    fromClearing: Amount;
    fromMerchantBalance: Amount;
  },
): Promise<{ txId: string }> {
  const tx = await ledger.post(recipes.chargebackOpen(input));
  return { txId: tx.id };
}

/** The idempotency key the opening posts under, read off the recipe so it can never drift from what `postDisputeOpening` posts. */
export function disputeOpeningKey(input: Parameters<typeof postDisputeOpening>[1]): string {
  return recipes.chargebackOpen(input).idempotencyKey;
}
