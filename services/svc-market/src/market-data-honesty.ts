import { MoneyError, parseAmount } from '@intafaced/ledger-client';
import { z } from 'zod';
import { MarketError } from './vendor-service.js';

/**
 * PTX-M06-R06 / R09 — this process is a vendor shop, not a venue book.
 *
 * Ceiling is L1/L2/index. L3, queue position, and "executable L3" are refused
 * by name. Implied/synthetic/indicative cannot be native executable liquidity.
 * Index and mark are never a bid/ask.
 */

export const MARKET_L3_UNAVAILABLE = 'market.l3_unavailable' as const;
export const MARKET_NOT_NATIVE_EXECUTABLE = 'market.not_native_executable' as const;
export const MARKET_REFERENCE_NOT_BOOK = 'market.reference_not_book' as const;
export const MARKET_QUOTE_PRICE_INVALID = 'market.quote_price_invalid' as const;

export const MARKET_DATA_CEILING = ['L1', 'L2', 'index'] as const;

export type BookProduct = 'L1' | 'L2' | 'L3' | 'queue' | 'executable_l3';
export type QuoteKind = 'native_executable' | 'implied' | 'synthetic' | 'indicative' | 'index' | 'mark';

const NON_NATIVE_KINDS: ReadonlySet<QuoteKind> = new Set(['implied', 'synthetic', 'indicative']);
const REFERENCE_KINDS: ReadonlySet<QuoteKind> = new Set(['index', 'mark']);

export type MarketDataHonesty = ReturnType<typeof describeMarketDataHonesty>;

export function describeMarketDataHonesty() {
  return {
    servedCeiling: MARKET_DATA_CEILING,
    servesL3: false as const,
    servesQueue: false as const,
    inventsL3: false as const,
    indexIsBidAsk: false as const,
    markIsBidAsk: false as const,
    impliedIsNativeExecutable: false as const,
    syntheticIsNativeExecutable: false as const,
    indicativeIsNativeExecutable: false as const,
    l3RefuseCode: MARKET_L3_UNAVAILABLE,
    notNativeExecutableCode: MARKET_NOT_NATIVE_EXECUTABLE,
    referenceNotBookCode: MARKET_REFERENCE_NOT_BOOK,
  };
}

export type BookView = {
  readonly marketId: string;
  readonly product: 'L1' | 'L2';
  readonly kind: 'unserved';
  readonly executableNative: false;
  readonly bids: null;
  readonly asks: null;
  readonly orders: null;
  readonly queue: null;
};

export function requestBook(input: { marketId: string; product: BookProduct }): BookView {
  if (input.product === 'L3' || input.product === 'queue' || input.product === 'executable_l3') {
    throw new MarketError('svc-market has no L3/queue — refusing rather than inventing a book', MARKET_L3_UNAVAILABLE, {
      product: input.product,
      marketId: input.marketId,
      ceiling: MARKET_DATA_CEILING,
    });
  }
  // Null sides, not []: an empty array reads as a measured quiet book.
  return {
    marketId: input.marketId,
    product: input.product,
    kind: 'unserved',
    executableNative: false,
    bids: null,
    asks: null,
    orders: null,
    queue: null,
  };
}

export type QuoteView = {
  readonly kind: QuoteKind;
  readonly executableNative: false;
  readonly price: string;
  readonly bid: null;
  readonly ask: null;
  readonly index: string | null;
  readonly mark: string | null;
};

/**
 * Positive decimal string, same parser as listing price (`parseAmount`).
 * Blank, whitespace, non-decimal, zero, and negative refuse. Not a JS number.
 * The caller's spelling is kept — no new magnitude.
 */
export function requirePositiveQuotePrice(price: string): string {
  if (price.length === 0 || /\s/u.test(price)) {
    throw new MarketError('Quote price must be a positive decimal string', MARKET_QUOTE_PRICE_INVALID);
  }
  let amount: bigint;
  try {
    amount = parseAmount(price);
  } catch (err) {
    if (err instanceof MoneyError) {
      throw new MarketError('Quote price must be a positive decimal string', MARKET_QUOTE_PRICE_INVALID);
    }
    throw err;
  }
  if (amount <= 0n) {
    throw new MarketError('Quote price must be a positive decimal string', MARKET_QUOTE_PRICE_INVALID);
  }
  return price;
}

/** Public `marketData.quote` price. Same refuse as `requirePositiveQuotePrice`. */
export const quotePriceSchema = z
  .string()
  .max(64)
  .superRefine((price, ctx) => {
    try {
      requirePositiveQuotePrice(price);
    } catch (err) {
      if (err instanceof MarketError && err.code === MARKET_QUOTE_PRICE_INVALID) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: MARKET_QUOTE_PRICE_INVALID });
        return;
      }
      throw err;
    }
  });

export function presentQuote(input: { kind: QuoteKind; price: string; asNativeExecutable?: boolean; asBidAsk?: boolean }): QuoteView {
  const price = requirePositiveQuotePrice(input.price);
  if (input.kind === 'native_executable' || input.asNativeExecutable === true) {
    throw new MarketError(
      'implied/synthetic/indicative (and this service) are not native executable liquidity',
      MARKET_NOT_NATIVE_EXECUTABLE,
      { kind: input.kind },
    );
  }
  if (REFERENCE_KINDS.has(input.kind) && input.asBidAsk === true) {
    throw new MarketError('index and mark are not a bid/ask', MARKET_REFERENCE_NOT_BOOK, { kind: input.kind });
  }
  if (NON_NATIVE_KINDS.has(input.kind) && input.asBidAsk === true) {
    throw new MarketError('implied/synthetic/indicative prices are not native executable liquidity', MARKET_NOT_NATIVE_EXECUTABLE, {
      kind: input.kind,
    });
  }
  return {
    kind: input.kind,
    executableNative: false,
    price,
    bid: null,
    ask: null,
    index: input.kind === 'index' ? price : null,
    mark: input.kind === 'mark' ? price : null,
  };
}
