import { z } from 'zod';
import { defineProcedure, NO_INPUT, type Refusals, type RefusalStatus } from './procedure.js';
import {
  dexAuthChallengeInputSchema,
  dexAuthChallengeOutputSchema,
  dexAuthLogoutInputSchema,
  dexAuthLogoutOutputSchema,
  dexAuthRefreshInputSchema,
  dexAuthSessionOutputSchema,
  dexAuthVerifyInputSchema,
  dexOrdersCountInputSchema,
  dexOrdersCountOutputSchema,
} from './protocol-dex-orders.js';

/**
 * svc-dex's calls, one record per call: its health, the live quote, the wallet-signed order session (`auth.*`) and the
 * wallet's order count. Every call is the Protocol plane's front door: no account, no KYC tier, and nothing here holds a
 * balance or posts to the ledger. svc-dex mounts each from here (`mountRecord`), so its path, guard, input, output and
 * named refusals are this file, not its router; the customer app and svc-protocol call each by its record.
 *
 * Failures that are not named refusals are not listed: an unknown error, sent as INTERNAL_SERVER_ERROR.
 */

const JURISDICTION = { caller: 'jurisdiction', module: 'dex', plane: 'protocol' } as const;
const base = { service: 'svc-dex', module: 'dex', transport: 'trpc' } as const;

/** Each refusal by its code, with the status svc-dex sends it with (`router.ts` `toTrpcError`, `auth/router.ts`). */
const STATUS = {
  'dex.quote.no_venue_configured': 'SERVICE_UNAVAILABLE',
  'dex.quote.no_venue_available': 'SERVICE_UNAVAILABLE',
  'dex.quote.stale': 'SERVICE_UNAVAILABLE',
  'dex.quote.no_liquidity': 'NOT_FOUND',
  'dex.quote.depth_unset': 'PRECONDITION_FAILED',
  'dex.quote.max_age_unset': 'PRECONDITION_FAILED',
  'dex.quote.missing_finality': 'SERVICE_UNAVAILABLE',
  'dex.quote.reorg_unconfirmed': 'SERVICE_UNAVAILABLE',
  'dex.quote.unknown': 'SERVICE_UNAVAILABLE',
  'dex.quote.hide_list_unset': 'PRECONDITION_FAILED',
  'dex.quote.hide_list_unavailable': 'SERVICE_UNAVAILABLE',
  'dex.quote.market_hidden': 'NOT_FOUND',
  'dex.quote.pool_hidden': 'NOT_FOUND',
  'dex.internal_book_fee_unset': 'SERVICE_UNAVAILABLE',
  /** The session secret is blank (owner setting): no order session can be written. */
  'dex.auth.session_unset': 'PRECONDITION_FAILED',
  /** The access or refresh lifetime is blank (owner setting). */
  'dex.auth.lifetime_unset': 'PRECONDITION_FAILED',
  /** The order cap schedule is blank (owner setting): no session is written, so no order can be placed. */
  'dex.order.cap_unset': 'PRECONDITION_FAILED',
  /** The challenge was not written by this service, is for another chain or wallet, or has expired. */
  'dex.auth.challenge_invalid': 'BAD_REQUEST',
  /** The challenge was already spent: a signature is good for one session only. */
  'dex.auth.challenge_replayed': 'CONFLICT',
  /** The signature does not recover to the wallet the challenge was written for. */
  'dex.auth.signature_not_owner': 'UNAUTHORIZED',
  /** The access or refresh token is missing, altered, expired or revoked: sign a new order session. */
  'dex.auth.unauthenticated': 'UNAUTHORIZED',
} as const satisfies Record<string, RefusalStatus>;
type Code = keyof typeof STATUS;
const refuse = (...codes: Code[]): Refusals => Object.freeze(Object.fromEntries(codes.map((c) => [c, STATUS[c]])));

/** No order session is written while an owner value is blank (`auth/order-session.ts` `ready`). */
const SESSION_UNSET = ['dex.auth.session_unset', 'dex.auth.lifetime_unset', 'dex.order.cap_unset'] as const;

// ── Health ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The internal book is ledger-settled: when it is on, its quotes are custodial and on the fiat plane, and it is never an
 * AMM (`quote/door-honesty.ts`).
 */
const dexInternalBookHonestySchema = z.discriminatedUnion('enabled', [
  z.object({
    enabled: z.literal(true),
    priced: z.boolean().optional(),
    custodial: z.literal(true),
    plane: z.literal('fiat'),
    venueKind: z.literal('internal'),
    amm: z.literal(false),
  }),
  z.object({ enabled: z.literal(false), amm: z.literal(false) }),
]);

/** venue-adapter's `refuseBestExClaim` on the wire: ranking is not a certified best-execution claim. */
const dexBestExHonestySchema = z.union([
  z.object({ ok: z.literal(true), claimed: z.literal(false) }),
  z.object({ ok: z.literal(true), claimed: z.literal(true), ownerBestExLaw: z.string().min(1) }),
  z.object({
    ok: z.literal(false),
    reason: z.literal('best_ex_unset'),
    code: z.literal('venue.best_ex_claim_unset'),
    detail: z.string(),
  }),
]);

/** What the front door says about itself on every answer that describes it: it holds no balance, and which venues are wired. */
export const dexDoorHonestySchema = z.object({
  serviceHoldsBalances: z.literal(false),
  internalBook: dexInternalBookHonestySchema,
  ammVenueWired: z.boolean(),
  /** Operator `DEX_EXTERNAL_VENUES`. Default empty — not a shipped live venue. */
  externalVenueWired: z.boolean(),
  bestEx: dexBestExHonestySchema,
});
export type DexDoorHonesty = z.infer<typeof dexDoorHonestySchema>;

export const DEX_HEALTH = defineProcedure({
  ...base,
  name: 'dex.health',
  kind: 'query',
  path: 'health',
  access: { caller: 'public' },
  refusals: refuse(),
  input: NO_INPUT,
  output: z.object({ ok: z.literal(true), service: z.literal('svc-dex'), ...dexDoorHonestySchema.shape }),
  samples: [{ verdict: 'accept' }],
});
export type DexHealth = z.output<typeof DEX_HEALTH.output>;

// ── Quote ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Decimal string with at most 18 places: a JSON number would round the 18th decimal away. */
const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are decimal strings with at most 18 decimal places');

const unavailableReasonSchema = z.enum([
  'unreachable',
  'malformed',
  'not_ready',
  'stale',
  'clock_skew',
  'no_depth',
  'unknown',
  'missing_finality',
  'reorg_unconfirmed',
]);

/** A routing plan. A plan is never a fill, and preview arithmetic is never a live quote. */
export const dexRouteSchema = z.object({
  kind: z.enum(['quote', 'preview']),
  executable: z.boolean(),
  legs: z.array(
    z.object({
      venue: z.string(),
      kind: z.enum(['book', 'pool']),
      qty: z.string(),
      quoteAmount: z.string(),
      effectivePrice: z.string(),
    }),
  ),
  filledQty: z.string(),
  unfilledQty: z.string(),
  totalQuoteAmount: z.string(),
});

/** A live quote: every price was read from a venue inside the owner's freshness ceiling. */
const dexQuoteOutputSchema = z.object({
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  route: dexRouteSchema,
  venues: z.array(
    z.object({
      venueId: z.string(),
      venueKind: z.string(),
      kind: z.enum(['book', 'pool']),
      plane: z.enum(['protocol', 'fiat', 'external']),
      custodial: z.boolean(),
      feeBps: z.number().int(),
      settlementCost: z.string(),
      fillableQty: z.string(),
      quoteAmount: z.string(),
      observedAt: z.string(),
      ageMs: z.number().int(),
      latencyMs: z.number().int(),
    }),
  ),
  unavailable: z.array(
    z.object({
      venueId: z.string(),
      plane: z.enum(['protocol', 'fiat', 'external']),
      reason: unavailableReasonSchema,
      detail: z.string(),
    }),
  ),
  /**
   * Ranking denominator, not a certified best-execution claim (see `bestEx`). `degraded` and `singleVenue` exist so a
   * client cannot present the only venue that answered as the best of several.
   */
  venuesConfigured: z.number().int(),
  degraded: z.boolean(),
  singleVenue: z.boolean(),
  asOf: z.string(),
  ageMs: z.number().int(),
  maxAgeMs: z.number().int(),
  custodialLegs: z.boolean(),
  executable: z.boolean(),
  comparableSettlement: z.boolean(),
  nonExecutableReason: z.enum(['custodial_settlement', 'incomparable_settlement', 'degraded', 'not_final']).nullable(),
  ...dexDoorHonestySchema.shape,
});

/** A read-only quote. It moves nothing, and refuses by its `dex.quote.*` code when no venue can be read fresh. */
export const DEX_QUOTE = defineProcedure({
  ...base,
  name: 'dex.quote',
  kind: 'query',
  path: 'quote',
  access: JURISDICTION,
  refusals: refuse(
    'dex.quote.no_venue_configured',
    'dex.quote.no_venue_available',
    'dex.quote.stale',
    'dex.quote.no_liquidity',
    'dex.quote.depth_unset',
    'dex.quote.max_age_unset',
    'dex.quote.missing_finality',
    'dex.quote.reorg_unconfirmed',
    'dex.quote.unknown',
    'dex.quote.hide_list_unset',
    'dex.quote.hide_list_unavailable',
    'dex.quote.market_hidden',
    'dex.quote.pool_hidden',
    'dex.internal_book_fee_unset',
  ),
  input: z.object({ symbol: z.string().min(1).max(64), side: z.enum(['buy', 'sell']), qty: decimal }),
  output: dexQuoteOutputSchema,
  samples: [
    { verdict: 'accept', input: { symbol: 'ETH-USDC', side: 'buy', qty: '1.5' } },
    { verdict: 'refuse', input: { symbol: 'ETH-USDC', side: 'buy', qty: '1.0000000000000000001' } },
    { verdict: 'refuse', input: { symbol: '', side: 'sell', qty: '1' } },
  ],
});
export type DexQuote = z.output<typeof DEX_QUOTE.output>;

// ── The order session and the wallet's orders (D-limit-dca-01 to -04) ─────────────────────────────────────────────
// Every call is a mutation, so a token travels in a body and never in a URL an access log keeps.

const WALLET = '0x' + 'a'.repeat(40);

export const DEX_AUTH_CHALLENGE = defineProcedure({
  ...base,
  name: 'dex.auth.challenge',
  kind: 'mutation',
  path: 'auth.challenge',
  access: JURISDICTION,
  refusals: refuse(...SESSION_UNSET),
  input: dexAuthChallengeInputSchema,
  output: dexAuthChallengeOutputSchema,
  samples: [
    { verdict: 'accept', input: { address: WALLET, chainId: 84532 } },
    { verdict: 'refuse', input: { address: 'not-a-wallet', chainId: 84532 } },
    { verdict: 'refuse', input: { address: WALLET, chainId: 0 } },
  ],
});

export const DEX_AUTH_VERIFY = defineProcedure({
  ...base,
  name: 'dex.auth.verify',
  kind: 'mutation',
  path: 'auth.verify',
  access: JURISDICTION,
  refusals: refuse(...SESSION_UNSET, 'dex.auth.challenge_invalid', 'dex.auth.challenge_replayed', 'dex.auth.signature_not_owner'),
  input: dexAuthVerifyInputSchema,
  output: dexAuthSessionOutputSchema,
  samples: [
    { verdict: 'accept', input: { challenge: 'sealed', signature: '0x' + 'ab'.repeat(65) } },
    { verdict: 'refuse', input: { challenge: 'sealed', signature: 'unsigned' } },
  ],
});

export const DEX_AUTH_REFRESH = defineProcedure({
  ...base,
  name: 'dex.auth.refresh',
  kind: 'mutation',
  path: 'auth.refresh',
  access: JURISDICTION,
  refusals: refuse(...SESSION_UNSET, 'dex.auth.unauthenticated'),
  input: dexAuthRefreshInputSchema,
  output: dexAuthSessionOutputSchema,
  samples: [
    { verdict: 'accept', input: { refreshToken: 'sealed' } },
    { verdict: 'refuse', input: { refreshToken: '' } },
  ],
});

export const DEX_AUTH_LOGOUT = defineProcedure({
  ...base,
  name: 'dex.auth.logout',
  kind: 'mutation',
  path: 'auth.logout',
  access: JURISDICTION,
  refusals: refuse(...SESSION_UNSET, 'dex.auth.unauthenticated'),
  input: dexAuthLogoutInputSchema,
  output: dexAuthLogoutOutputSchema,
  samples: [
    { verdict: 'accept', input: { accessToken: 'sealed' } },
    { verdict: 'refuse', input: { accessToken: '' } },
  ],
});

/** Ends every order session the wallet holds, not only this one. */
export const DEX_AUTH_LOGOUT_ALL = defineProcedure({
  ...base,
  name: 'dex.auth.logoutAll',
  kind: 'mutation',
  path: 'auth.logoutAll',
  access: JURISDICTION,
  refusals: refuse(...SESSION_UNSET, 'dex.auth.unauthenticated'),
  input: dexAuthLogoutInputSchema,
  output: dexAuthLogoutOutputSchema,
  samples: [
    { verdict: 'accept', input: { accessToken: 'sealed' } },
    { verdict: 'refuse', input: { accessToken: '' } },
  ],
});

/** How many orders a wallet has, in any state: a count only, public, so a page can say "no orders yet" before a session. */
export const DEX_ORDERS_COUNT = defineProcedure({
  ...base,
  name: 'dex.orders.count',
  kind: 'mutation',
  path: 'orders.count',
  access: JURISDICTION,
  refusals: refuse(),
  input: dexOrdersCountInputSchema,
  output: dexOrdersCountOutputSchema,
  samples: [
    { verdict: 'accept', input: { wallet: WALLET } },
    { verdict: 'refuse', input: { wallet: '0x1' } },
  ],
});
