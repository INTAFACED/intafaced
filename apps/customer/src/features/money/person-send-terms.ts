import type { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { formatAmount, parseAmount } from '../../shared/money';
import { amount } from './components';
import { bankReads, type personSendQuoteSchema } from './contracts';
import { transferDepthCopy } from './transfer-depth-copy';

export type PersonSendQuote = z.infer<typeof personSendQuoteSchema>;

/** What the review of a send to a person shows under the facts, and why Confirm is off (null when it is on). */
export type ReviewTerms = { rows: [string, string][]; blocked: string | null };

/**
 * Reads the bank's own answer for one send to a person (J-bank-04 #3): the fee line and its total as the exact strings the
 * service published, what leaves the account, and what is left of today. Checked in the order the service refuses a send:
 * nothing published, then the fee, then the single-transfer limit, then today's. A quote for another amount is never shown.
 */
export function personSendReview(answer: ApiResult<PersonSendQuote>, sent: string, assetId: string): ReviewTerms {
  const { t } = transferDepthCopy;
  if (!answer.ok)
    return {
      rows: [],
      blocked: answer.code === 'bank.personal_transfer_terms_unset' ? t('reviewTermsUnset', { asset: assetId }) : t('reviewUnreadable'),
    };
  const quote = answer.data;
  if (quote.assetId !== assetId || parseAmount(quote.amount) !== parseAmount(sent)) return { rows: [], blocked: t('reviewUnreadable') };
  const fee = parseAmount(quote.fee);
  // One fee line today; the total is the sum of the lines, so a second line can never make the two disagree.
  const lines: [string, bigint][] = [[t('reviewFee'), fee]];
  const total = lines.reduce((sum, [, value]) => sum + value, 0n);
  const left = parseAmount(quote.dailyLimit) - parseAmount(quote.spentToday);
  const leftNow = left > 0n ? left : 0n;
  const after = leftNow - parseAmount(sent);
  const rows: [string, string][] = [
    ...lines.map(([label, value]): [string, string] => [label, amount(formatAmount(value), assetId)]),
    [t('reviewFeeTotal'), amount(formatAmount(total), assetId)],
    [t('reviewTaken'), amount(formatAmount(parseAmount(sent) + total), assetId)],
    [t('reviewLeftToday'), amount(formatAmount(after > 0n ? after : 0n), assetId)],
  ];
  if (quote.feeBlocker !== null) return { rows, blocked: t('reviewFeeUnwired', { fee: formatAmount(fee), asset: assetId }) };
  if (!quote.withinPerTransfer)
    return { rows, blocked: t('reviewOverPayment', { limit: formatAmount(parseAmount(quote.perTransferLimit)), asset: assetId }) };
  if (!quote.withinDaily) return { rows, blocked: t('reviewOverDaily', { left: formatAmount(leftNow), asset: assetId }) };
  return { rows, blocked: null };
}

/** Asks the bank for the fee and limits of this send, for the review. */
export async function readPersonSendTerms(api: ApiClient, assetId: string, sent: string, signal?: AbortSignal): Promise<ReviewTerms> {
  const answer = await api.query('bank', 'transfers.quote', { assetId, amount: sent }, bankReads['transfers.quote'], { signal });
  return personSendReview(answer, sent, assetId);
}
