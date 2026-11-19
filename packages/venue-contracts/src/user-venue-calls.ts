import type { UserVenue, UserVenueSubAccountReads } from './user-venue.js';

/**
 * Every `UserVenue` call that moves nothing, as it travels to a venue reached over HTTP: its path, and the names its
 * arguments travel under, in the method's own order. svc-trade's client (`http-user-venue.ts`) builds one method per
 * entry, and the TEST simulator's server routes each path (`packages/venue-sim/src/http-server.ts`, whose test checks
 * every path here answers).
 *
 * A new read is one method on `UserVenue` and one line here; the `satisfies` below refuses to compile until both are
 * there, with one argument name per parameter. `submit` is not here: a lost answer to it means something else
 * (http-user-venue.ts), so it keeps its own method.
 */
type Calls = UserVenue & UserVenueSubAccountReads;
type Fn = (...args: never[]) => unknown;

/** The name of every call the HTTP client reads with: each method of `UserVenue` and its sub-account reads, less `submit`. */
export type UserVenueReadName = Exclude<{ [K in keyof Calls]-?: NonNullable<Calls[K]> extends Fn ? K : never }[keyof Calls], 'submit'>;

/** One argument name for each of the method's parameters. */
type ArgNames<F> = F extends (...args: infer P) => unknown ? { readonly [I in keyof P]: string } : never;

export interface UserVenueReadSpec<F> {
  readonly path: `/${string}`;
  readonly args: ArgNames<F>;
}

export const USER_VENUE_READS = {
  markets: { path: '/markets', args: ['account'] },
  book: { path: '/book', args: ['symbol', 'depth'] },
  preview: { path: '/preview', args: ['account', 'intent'] },
  bestPrices: { path: '/best-prices', args: ['symbol'] },
  fundingHistory: { path: '/funding-history', args: ['symbol', 'since'] },
  priceHistory: { path: '/price-history', args: ['symbol', 'kind', 'since'] },
  trades: { path: '/trades', args: ['symbol', 'limit'] },
  candles: { path: '/candles', args: ['symbol', 'interval', 'limit'] },
  // A lost prepare sends nothing to sign, so it is `venue_down` and safe to ask again.
  prepare: { path: '/prepare', args: ['account', 'signer', 'intent'] },
  balances: { path: '/balances', args: ['account'] },
  openOrders: { path: '/open-orders', args: ['account'] },
  orderByClientId: { path: '/order-by-client-id', args: ['account', 'venueClientOrderId'] },
  orderHistory: { path: '/order-history', args: ['account'] },
  fills: { path: '/fills', args: ['account', 'since'] },
  positions: { path: '/positions', args: ['account'] },
  withdrawal: { path: '/withdrawal', args: ['account', 'nonce'] },
  withdrawalTerms: { path: '/withdrawal-terms', args: ['asset'] },
  deposits: { path: '/deposits', args: ['account'] },
  arrivals: { path: '/arrivals', args: ['account'] },
  builderFeeApproval: { path: '/builder-fee-approval', args: ['account', 'builder'] },
  feeStatus: { path: '/fee-status', args: ['account'] },
  builderTotals: { path: '/builder-totals', args: ['builder'] },
  builderClaims: { path: '/builder-claims', args: ['builder'] },
  agents: { path: '/agents', args: ['account'] },
  leverage: { path: '/leverage', args: ['account', 'symbol'] },
  leverageChange: { path: '/leverage-change', args: ['account', 'symbol', 'leverageBps', 'marginMode'] },
  isolatedMargin: { path: '/isolated-margin', args: ['account', 'symbol'] },
  accountSummary: { path: '/account-summary', args: ['account'] },
  liquidationStatus: { path: '/liquidation-status', args: ['account', 'symbol'] },
  liquidations: { path: '/liquidations', args: ['account', 'since'] },
  insuranceFund: { path: '/insurance-fund', args: [] },
  adlRules: { path: '/adl-rules', args: [] },
  deleverages: { path: '/deleverages', args: ['account', 'since'] },
  liquidationAlerts: { path: '/liquidation-alerts', args: ['symbol', 'limit'] },
  marketMargin: { path: '/market-margin', args: ['account', 'symbol'] },
  scheduledCancel: { path: '/scheduled-cancel', args: ['account'] },
  settlements: { path: '/settlements', args: ['account', 'since'] },
  fundingPayments: { path: '/funding-payments', args: ['account', 'since'] },
  subAccounts: { path: '/sub-accounts', args: ['account'] },
  transfer: { path: '/transfer', args: ['account', 'nonce'] },
} as const satisfies { readonly [K in UserVenueReadName]: UserVenueReadSpec<NonNullable<Calls[K]>> };

/** Each read as a required method: what a client built from `USER_VENUE_READS` offers. */
export type UserVenueReads = { readonly [K in UserVenueReadName]-?: NonNullable<Calls[K]> };

/**
 * Every read, built from the table on one transport: `call` sends a read's body (each argument under its name) to its
 * path and answers what the venue answered. svc-trade's HTTP client is this over its POST.
 */
export function userVenueReads(call: (path: `/${string}`, body: Record<string, unknown>) => Promise<unknown>): UserVenueReads {
  const reads: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const [name, spec] of Object.entries(USER_VENUE_READS)) {
    const names: readonly string[] = spec.args;
    reads[name] = (...args) => call(spec.path, Object.fromEntries(names.map((n, i) => [n, args[i]])));
  }
  // The one assertion: the `satisfies` on USER_VENUE_READS holds each read's path and argument names to UserVenue, and
  // the answer's type is the venue's own (the transport decodes it, as each hand-written method did).
  return reads as UserVenueReads;
}
