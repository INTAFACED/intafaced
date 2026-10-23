import { MiningError } from './errors.js';
import { OVERVIEW_TEXT_MAX, OVERVIEW_VERSION_MAX, publishedText, type Published } from './env.js';

/** Wholly unpublished overview. A single blank section is null, not this code. */
export const OVERVIEW_UNSET = 'mining.overview_unset';

export type PoolOverview = {
  readonly version: string;
  readonly what: string | null;
  readonly coin: string | null;
  readonly hardware: string | null;
  readonly revenueSplit: string | null;
  readonly notSupported: string | null;
};

function section(raw: string | undefined): Published {
  return publishedText(raw, OVERVIEW_TEXT_MAX, true);
}

/**
 * Owner-published overview. Fee and window size are not copied here.
 * Every section blank, a blank version, or an unusable value refuses. A blank
 * section among published ones is null, so the screen can say it is not set
 * without inventing a coin or hardware sentence.
 */
export function readPoolOverview(env: NodeJS.ProcessEnv = process.env): PoolOverview {
  const version = publishedText(env.MINING_OVERVIEW_VERSION, OVERVIEW_VERSION_MAX, false);
  const what = section(env.MINING_OVERVIEW_WHAT);
  const coin = section(env.MINING_OVERVIEW_COIN);
  const hardware = section(env.MINING_OVERVIEW_HARDWARE);
  const revenueSplit = section(env.MINING_OVERVIEW_REVENUE_SPLIT);
  const notSupported = section(env.MINING_OVERVIEW_NOT_SUPPORTED);
  const texts = [what, coin, hardware, revenueSplit, notSupported];
  if (version === null || version === 'invalid' || texts.some((part) => part === 'invalid') || texts.every((part) => part === null)) {
    throw new MiningError('Pool overview is not published', OVERVIEW_UNSET);
  }
  return {
    version,
    what: what === 'invalid' ? null : what,
    coin: coin === 'invalid' ? null : coin,
    hardware: hardware === 'invalid' ? null : hardware,
    revenueSplit: revenueSplit === 'invalid' ? null : revenueSplit,
    notSupported: notSupported === 'invalid' ? null : notSupported,
  };
}
