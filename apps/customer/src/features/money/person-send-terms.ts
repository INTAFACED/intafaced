import type { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { displayAmount, formatAmount, parseAmount } from '../../shared/money';
import type { transferQuoteSchema } from '../pay/schemas';
import { termsVerdict } from '../../screens/pay/send-terms';
import { amount } from './components';
import { bankReads } from './contracts';
import { transferDepthCopy } from './transfer-depth-copy';

export type PersonSendQuote = z.infer<typeof transferQuoteSchema>;

/** What the review of a send to a person shows under the facts, and why Confirm is off (null when it is on). */
export type ReviewTerms = { rows: [string, string][]; blocked: string | null };

/**
 * Reads the bank's own answer for one send to a person (J-bank-04 #3): the fee line and the fee total as the exact strings
 * the service published, what leaves the account, and what is left of today. Whether Confirm is on is Pay's own verdict on
 * the same quote (nothing published, then the fee, then the single-transfer limit, then today's), so the two screens
 * never disagree. A quote for another amount or asset is never shown.
 */
export function personSendReview(answer: ApiResult<PersonSendQuote>, sent: string, assetId: string): ReviewTerms {
  const { t } = transferDepthCopy;
  if (!answer.ok) {
    if (answer.code === 'bank.personal_transfer_terms_unset') return { rows: [], blocked: t('reviewTermsUnset', { asset: assetId }) };
    // Any other refusal is the service's own: name its code rather than asking for a retry that cannot help.
    return { rows: [], blocked: answer.code ? t('reviewRefused', { code: answer.code }) : t('reviewUnreadable') };
  }
  const quote = answer.data;
  if (quote.assetId !== assetId || parseAmount(quote.amount) !== parseAmount(sent)) return { rows: [], blocked: t('reviewUnreadable') };
  const fee = parseAmount(quote.fee);
  // The journey asks for fee lines that add up to the fee total. There is one line today, so the total is that line.
  const feeRows: [string, string][] = [
    [t('reviewFee'), amount(formatAmount(fee), assetId)],
    [t('reviewFeeTotal'), amount(formatAmount(fee), assetId)],
  ];
  const verdict = termsVerdict({ kind: 'ready', quote }, sent);
  switch (verdict.kind) {
    case 'ok':
      return {
        rows: [
          ...feeRows,
          [t('reviewTaken'), amount(formatAmount(parseAmount(sent) + fee), assetId)],
          [t('reviewLeftToday'), amount(verdict.leftAfter, assetId)],
        ],
        blocked: null,
      };
    // A fee this transfer cannot charge: nothing would leave, so no "taken" figure is shown beside the refusal.
    case 'feeUnwired':
      return { rows: feeRows, blocked: t('reviewFeeUnwired', { fee: displayAmount(formatAmount(fee)), asset: assetId }) };
    case 'overPayment':
      return { rows: feeRows, blocked: t('reviewOverPayment', { limit: displayAmount(verdict.limit), asset: assetId }) };
    case 'overDaily':
      return { rows: feeRows, blocked: t('reviewOverDaily', { left: displayAmount(verdict.left), asset: assetId }) };
    default:
      return { rows: [], blocked: t('reviewUnreadable') };
  }
}

/** Asks the bank for the fee and limits of this send, for the review. */
export async function readPersonSendTerms(api: ApiClient, assetId: string, sent: string, signal?: AbortSignal): Promise<ReviewTerms> {
  const value = sent.trim();
  const answer = await api.query('bank', 'transfers.quote', { assetId, amount: value }, bankReads['transfers.quote'], { signal });
  return personSendReview(answer, value, assetId);
}
