/**
 * `valuation.prices` (contract: `@intafaced/contracts` `valuation-prices.ts`): the prices Home and Assets value a
 * person's holdings with. Which price source to publish is the owner's decision and none is named yet, so the read
 * answers `valuation.prices_unset` and nothing is valued.
 *
 * `OPS_VALUATION_TEST_PRICES` (`ASSET=usd,ASSET=usd`, e.g. `USDC=1,USDT=1`) is a labelled TEST stand-in for the test
 * stack only: set outside APP_ENV exactly dev or test, or with NODE_ENV=production, svc-ops refuses to start. Its
 * as-of is the time this process read the list, and every value made from it is labelled TEST. A malformed list
 * refuses at boot, so a misspelt asset never reaches a customer as a different total.
 */
import { isExplicitDevOrTest } from '@intafaced/config';
import {
  publicProcedure,
  router,
  VALUATION_PRICES_UNSET,
  valuationPriceSchema,
  valuationPricesOutputSchema,
  type ValuationPrices,
} from '@intafaced/contracts';

export const VALUATION_TEST_PRICES_OUTSIDE_TEST = 'ops.valuation_test_prices_outside_test' as const;
export const VALUATION_TEST_SOURCE = 'TEST price list';

export function valuationPricesFromEnv(
  raw: string | undefined,
  env: { readonly APP_ENV?: string; readonly NODE_ENV?: string },
  now: () => Date = () => new Date(),
): ValuationPrices {
  const text = raw?.trim() ?? '';
  if (text === '') return { published: false, code: VALUATION_PRICES_UNSET };
  if (!isExplicitDevOrTest(env.APP_ENV) || env.NODE_ENV === 'production') {
    throw new Error(
      `${VALUATION_TEST_PRICES_OUTSIDE_TEST}: OPS_VALUATION_TEST_PRICES is a TEST price list and runs only with APP_ENV exactly dev or test`,
    );
  }
  const prices = text.split(',').map((entry) => {
    const [asset, usd, extra] = entry.split('=').map((part) => part.trim());
    const parsed = valuationPriceSchema.safeParse({ asset, usd });
    if (extra !== undefined || !parsed.success) {
      throw new Error(`OPS_VALUATION_TEST_PRICES is not a valid TEST price list: "${entry.trim()}" is not ASSET=usd`);
    }
    return parsed.data;
  });
  return valuationPricesOutputSchema.parse({
    published: true,
    test: true,
    source: VALUATION_TEST_SOURCE,
    asOf: now().toISOString(),
    prices,
  });
}

/** `valuation.prices`: public and read only. Prices are not personal, and the answer is the same for everyone. */
export function createValuationPricesRouter(prices: ValuationPrices) {
  return router({
    prices: publicProcedure.output(valuationPricesOutputSchema).query(() => prices),
  });
}
