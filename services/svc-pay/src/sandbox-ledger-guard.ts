import { recipes, type AccountRef, type PostRequest } from '@intafaced/ledger-client';
import { isSandboxRailId } from './sandbox-key-routing.js';

/**
 * Sandbox is a rail posture, not a second ledger. The key's sandbox flag is
 * immutable on the payment. A flagged request may post only to a sandbox rail
 * boundary. Every other account the pay recipes name (clearing, proceeds,
 * the owner's balance, house fees, the insurance fund, a live rail) is live,
 * and a sandbox flag refuses it before `ledger.post`.
 */
export const SANDBOX_LIVE_ACCOUNT_CODE = 'pay.sandbox_live_account_refused' as const;

export function isLiveLedgerAccount(account: AccountRef): boolean {
  if (account.ownerType === 'treasury' && account.ownerId.startsWith('rail:')) {
    return !isSandboxRailId(account.ownerId.slice('rail:'.length));
  }
  return true;
}

/** Accounts in this recipe a sandbox flag must not touch. Empty means the post may proceed. */
export function liveAccountsIn(request: PostRequest): AccountRef[] {
  return request.entries.filter((entry) => isLiveLedgerAccount(entry.account)).map((entry) => entry.account);
}

type ChargebackProbe = Parameters<typeof recipes.chargebackOpen>[0];

/** Names the opening's live pots. Callers refuse this; they do not post it. */
export function sandboxChargebackOpeningProbe(input: ChargebackProbe): PostRequest {
  return recipes.chargebackOpen(input);
}

/** Names the won recipe's live pots. Callers refuse this; they do not post it. */
export function sandboxChargebackWonProbe(input: ChargebackProbe): PostRequest {
  return recipes.chargebackWon(input);
}
