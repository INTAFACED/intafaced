import {
  recipes,
  type AcademyPurchaseInput,
  type AcademyPurchaseRefundInput,
  type LedgerClient,
  type LedgerTx,
} from '@intafaced/ledger-client';

/**
 * svc-academy's one door to the ledger for a paid course (J-academy-07): the purchase once the buyer's payment is
 * confirmed on chain, and the staff refund. Both legs are INTAFACED's own (academy revenue and an own-funds place).
 * svc-ledger grants exactly these two recipes to svc-academy (`services/svc-ledger/src/caller-allowlist.ts`).
 */
export function postPurchase(ledger: Pick<LedgerClient, 'post'>, input: AcademyPurchaseInput): Promise<LedgerTx> {
  return ledger.post(recipes.academyPurchase(input));
}

export function postRefund(ledger: Pick<LedgerClient, 'post'>, input: AcademyPurchaseRefundInput): Promise<LedgerTx> {
  return ledger.post(recipes.academyPurchaseRefund(input));
}
