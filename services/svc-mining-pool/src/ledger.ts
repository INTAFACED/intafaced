import { parseAmount, rewardPay, type LedgerClient, type PostRequest } from '@intafaced/ledger-client';
import { planPplns, type PplnsInput } from './pplns.js';
import { EMISSION_UNPUBLISHED, EPOCH_UNSET } from './window-store.js';

/** The reward id the payout job puts on `rewardPay`. Reads look the credit up by this id. */
export function miningPayoutRewardId(windowId: string, minerId: string): string {
  return `mining:pplns:${windowId}:${minerId}`;
}

/** `rewardPay` prefixes the reward id. The mining table does not store the ledger transaction id. */
export function miningPayoutIdempotencyKey(windowId: string, minerId: string): string {
  return `reward:${miningPayoutRewardId(windowId, minerId)}`;
}

/** Builds ledger-client recipes only; the service never owns or computes balances. */
export function buildPayoutRecipes(input: PplnsInput): PostRequest[] {
  const plan = planPplns(input);
  return plan.payouts.map((payout) =>
    rewardPay({
      rewardId: miningPayoutRewardId(plan.windowId, payout.minerId),
      userId: payout.minerId,
      assetId: plan.assetId,
      amount: parseAmount(payout.amount),
      reason: 'mining.pplns.payout',
    }),
  );
}

/**
 * JobHost+PG is the only payout door. It still must not mint: §4.3 token is
 * the only minter, and emission magnitudes are unpublished (PKT-C9). Caller
 * `reward` is not owner law — refuse both emission mint and reward payout posts.
 */
export async function postPayouts(ledger: Pick<LedgerClient, 'post'>, input: PplnsInput): Promise<void> {
  const epoch = input.epoch;
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 0) throw new Error(EPOCH_UNSET);
  parseAmount(input.reward);
  buildPayoutRecipes(input);
  void ledger;
  throw new Error(EMISSION_UNPUBLISHED);
}
