import { recipes, type Amount, type LedgerClient } from '@intafaced/ledger-client';

/**
 * Production posts for chargeback money. Every call is a ledger-client recipe.
 * No fee and no penalty is added here: pay pricing has no dispute-fee field,
 * so a blank fee posts nothing (`DISPUTE_FEE_NOTE`).
 *
 * `lost` / `accepted` / `expired` are not recipes. The debit is `chargebackOpen`
 * (and `chargebackShortfall` when the merchant pots cannot cover). Those
 * terminal outcomes leave that debit in place.
 */

/** No dispute fee is configured. Callers post none. */
export const DISPUTE_FEE_NOTE = 'No dispute fee is configured on pay pricing. No fee is posted.';

export interface ChargebackPostInput {
  disputeId: string;
  paymentId: string;
  merchantId: string;
  merchantUserId: string;
  assetId: string;
  rail: string;
  fromClearing: Amount;
  fromMerchantBalance: Amount;
  /**
   * Omitted means proceeds. `user` is the pot of a payment whose own
   * settlement post debited `userAvailable`. Open, a stored-plan replay,
   * and any later won or lost post must pass the same value: the key does
   * not contain it, so a different pot is a different body.
   */
  settledPot?: 'proceeds' | 'user';
}

export interface ChargebackShortfallPostInput {
  disputeId: string;
  paymentId: string;
  merchantId: string;
  assetId: string;
  rail: string;
  amount: Amount;
}

export async function postDisputeOpening(ledger: LedgerClient, input: ChargebackPostInput): Promise<{ txId: string }> {
  const tx = await ledger.post(recipes.chargebackOpen(input));
  return { txId: tx.id };
}

/** The idempotency key the opening posts under, read off the recipe so it can never drift from what `postDisputeOpening` posts. */
export function disputeOpeningKey(input: ChargebackPostInput): string {
  return recipes.chargebackOpen(input).idempotencyKey;
}

/** House covers the part the merchant pots could not. Fails when the fund cannot. */
export async function postDisputeShortfall(ledger: LedgerClient, input: ChargebackShortfallPostInput): Promise<{ txId: string }> {
  const tx = await ledger.post(recipes.chargebackShortfall(input));
  return { txId: tx.id };
}

export function disputeShortfallKey(input: ChargebackShortfallPostInput): string {
  return recipes.chargebackShortfall(input).idempotencyKey;
}

/** Representment won: the rail returns the merchant legs in the same proportions. */
export async function postDisputeWon(ledger: LedgerClient, input: ChargebackPostInput): Promise<{ txId: string }> {
  const tx = await ledger.post(recipes.chargebackWon(input));
  return { txId: tx.id };
}

export function disputeWonKey(input: ChargebackPostInput): string {
  return recipes.chargebackWon(input).idempotencyKey;
}

/** Insurance is repaid before the merchant sees a won recovery. Its own key. */
export async function postDisputeShortfallRecovered(ledger: LedgerClient, input: ChargebackShortfallPostInput): Promise<{ txId: string }> {
  const tx = await ledger.post(recipes.chargebackShortfallRecovered(input));
  return { txId: tx.id };
}

export function disputeShortfallRecoveredKey(input: ChargebackShortfallPostInput): string {
  return recipes.chargebackShortfallRecovered(input).idempotencyKey;
}

/** Lookup keys. A unit test pins these to the recipe so a drift fails closed. */
export function chargebackKeys(disputeId: string): {
  open: string;
  shortfall: string;
  won: string;
  recovered: string;
} {
  return {
    open: `pay.chargeback.open:${disputeId}`,
    shortfall: `pay.chargeback.shortfall:${disputeId}`,
    won: `pay.chargeback.won:${disputeId}`,
    recovered: `pay.chargeback.shortfall.recovered:${disputeId}`,
  };
}
