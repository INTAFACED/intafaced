import type { MerchantRecord, StarterFee } from '../schemas';
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

/**
 * The fee a new account would start with, in the same sentence, from exactly what the service published. The TEST mark
 * is the service's own (`source`); nothing here decides it, and a missing starter fee gives no sentence at all.
 */
export const starterFeeStory = (starterFee: StarterFee | null): string | null =>
  starterFee ? feeStory({ feeBps: starterFee.bps, starterFee }) : null;

/** True when the account has a fee rate to talk about. */
export const hasAccountFee = (merchant: Pick<MerchantRecord, 'feeBps'> | null | undefined): boolean =>
  merchant?.feeBps !== null && merchant?.feeBps !== undefined;
