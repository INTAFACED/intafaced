import { z } from 'zod';
import { marketSchema } from '@intafaced/exchange-contract/schemas';
import { defineCopy } from '../../shared/i18n';
import { decimalSchema, parseAmount } from '../../shared/money';

/**
 * A market as `/markets` lists it. Its own module because the shell's search and Home read the list at first paint,
 * and the rest of Trade's client (and its copy) need not load with it.
 */
const copy = defineCopy(
  'trade.listing',
  { expectedAPositiveExactDecimalString: 'Expected a positive exact decimal string' },
  {
    es: { expectedAPositiveExactDecimalString: 'Se esperaba una cadena decimal exacta positiva' },
    fr: { expectedAPositiveExactDecimalString: 'Une chaîne décimale exacte positive était attendue' },
  },
);
const positive = decimalSchema.refine((value) => parseAmount(value) > 0n, { error: () => copy.t('expectedAPositiveExactDecimalString') });

export const listingSchema = marketSchema.extend({
  orderable: z.boolean(),
  precision: z.object({ price: positive, amount: positive }),
  taker: decimalSchema,
  maker: decimalSchema,
});
export type Listing = z.infer<typeof listingSchema>;
