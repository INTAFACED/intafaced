/**
 * The prices Home and Assets value a person's holdings with (J-home-ia-01 #1 #3, J-wallet-01): svc-ops' public
 * `valuation.prices` read.
 *
 * At launch INTAFACED holds no customer money (OWNER 226): what a person holds sits in their own wallet, their venue
 * account and their partner account, each read from that source. Valuing those holdings in a display unit needs a
 * price for each asset, and which price source to publish is the owner's decision. Until the owner names one the read
 * answers `published: false` with `valuation.prices_unset`: every asset is "No price published", nothing is valued and
 * no total is invented. On a TEST stack a labelled TEST price list may stand in (`test: true`); it never runs outside
 * APP_ENV dev or test.
 *
 * Every price is a decimal string in USD per one unit of the asset, with the time the source stated it.
 */
import { z } from 'zod';
import { decimalString } from './instruments.js';

export const VALUATION_PRICES_PROCEDURE = 'valuation.prices' as const;
/** No price source is published: nothing is valued. */
export const VALUATION_PRICES_UNSET = 'valuation.prices_unset' as const;

const assetId = z.string().regex(/^[A-Z0-9]{2,16}$/);

export const valuationPriceSchema = z.object({
  asset: assetId,
  /** USD for one unit of `asset`, as the source states it. Never zero: an asset with no price is left out. */
  usd: decimalString.refine((value) => /[1-9]/.test(value), 'a published price is greater than zero'),
});
export type ValuationPrice = z.infer<typeof valuationPriceSchema>;

export const valuationPricesOutputSchema = z.discriminatedUnion('published', [
  z.object({ published: z.literal(false), code: z.literal(VALUATION_PRICES_UNSET) }),
  z.object({
    published: z.literal(true),
    /** True for the TEST stand-in: every value made from it is labelled TEST. */
    test: z.boolean(),
    /** Whose prices these are, as a person reads it. */
    source: z.string().min(1).max(80),
    /** When the source stated these prices. */
    asOf: z.string().datetime({ offset: true }),
    prices: z
      .array(valuationPriceSchema)
      .max(500)
      .refine((rows) => new Set(rows.map((row) => row.asset)).size === rows.length, 'one price per asset'),
  }),
]);
export type ValuationPrices = z.infer<typeof valuationPricesOutputSchema>;
