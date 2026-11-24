import { isExplicitDevOrTest, isProductionPosture } from '@intafaced/config';
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import type { ReferencePriceSource } from './pricing.js';

/**
 * A labelled TEST reference price feed for floating ads, on test stacks only (J-p2p-01 #2).
 *
 * No market feed is wired in this build (README, "Consumes"), so outside a test stack a floating ad stays refused at post
 * and an already-listed one says it needs a market feed. On a test stack, `LOCAL_TEST_P2P_REFERENCE_PRICES` may name a
 * fixed TEST price per pair, as JSON `{"USDT/EUR": "0.92"}` (fiat per one coin), so a floating ad can be posted and then
 * seen without its feed once the stack restarts without the setting.
 *
 * Unset returns undefined: no source, the same as production. A set value outside an explicit dev/test process, or one
 * that is not a map of positive decimal strings, throws and the process refuses to start; it never falls back to no feed.
 * `LOCAL_TEST_P2P_REFERENCE_PRICES` is read only here and is not a field of `env.ts`.
 */
const LOCAL_TEST_REFERENCE_ENV = 'LOCAL_TEST_P2P_REFERENCE_PRICES';

type Env = Record<string, string | undefined>;

export class LocalTestReferenceRefusedError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`${LOCAL_TEST_REFERENCE_ENV} refused: ${reasons.join('; ')}`);
    this.name = 'LocalTestReferenceRefusedError';
  }
}

const PAIR = /^([A-Z0-9]{2,12})\/([A-Z]{3})$/;

export function createLocalTestReferencePrices(env: Env = process.env): ReferencePriceSource | undefined {
  const raw = env[LOCAL_TEST_REFERENCE_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;

  const reasons: string[] = [];
  if (!isExplicitDevOrTest(env.APP_ENV)) reasons.push('APP_ENV must be exactly dev or test');
  if (env.NODE_ENV === 'production') reasons.push('NODE_ENV is production');
  if (isProductionPosture(env)) reasons.push('process is in production posture');

  const prices = new Map<string, Amount>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    reasons.push('it is not JSON');
  }
  if (parsed !== undefined) {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) reasons.push('it is not a map of pair to price');
    else {
      for (const [pair, value] of Object.entries(parsed)) {
        if (!PAIR.test(pair)) {
          reasons.push(`"${pair}" is not COIN/FIAT`);
          continue;
        }
        let amount: Amount | null = null;
        try {
          amount = typeof value === 'string' ? parseAmount(value) : null;
        } catch {
          amount = null;
        }
        if (amount === null || amount <= 0n) reasons.push(`the price for ${pair} is not a positive decimal string`);
        else prices.set(pair, amount);
      }
      if (prices.size === 0 && reasons.length === 0) reasons.push('it names no pair');
    }
  }
  if (reasons.length > 0) throw new LocalTestReferenceRefusedError(reasons);

  return {
    price: async (asset, fiatCurrency) => prices.get(`${asset}/${fiatCurrency}`) ?? null,
  };
}
