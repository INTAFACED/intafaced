import type { MerchantRecord } from '../schemas';
import { uiCopy } from './copy';

/** A rate in basis points as the percent a person says: 250 is "2.50%". Whole numbers only; nothing is rounded. */
export const percentOfBps = (bps: number): string => `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}%`;

/**
 * The fee on the account, in one sentence, for every place that talks about it. It reads the account's own rate
 * (`merchant.me`) and the server's mark that the rate is a local TEST value; it never invents either. The fee is taken
 * when a payment settles, which is when the service works it out (`settleWindow`), so no page says it was "recorded" earlier.
 */
export function feeStory(merchant: Pick<MerchantRecord, 'feeBps' | 'starterFee'> | null | undefined): string {
  if (!merchant || merchant.feeBps === null || merchant.feeBps === undefined) return uiCopy.t('feeStoryNone');
  const pct = percentOfBps(merchant.feeBps);
  const test = merchant.starterFee?.source === 'local_test' && merchant.starterFee.bps === merchant.feeBps;
  return uiCopy.t(test ? 'feeStoryTest' : 'feeStory', { pct });
}

/** True when the account has a fee rate to talk about. */
export const hasAccountFee = (merchant: Pick<MerchantRecord, 'feeBps'> | null | undefined): boolean =>
  merchant?.feeBps !== null && merchant?.feeBps !== undefined;
