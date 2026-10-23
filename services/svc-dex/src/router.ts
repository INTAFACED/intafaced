import { z } from 'zod';
import { publicJurisdictionProcedure, publicProcedure, router, TRPCError } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { presentRoute, route, type VenueQuote } from './router-quote.js';
import type { QuoteVenue } from './quote/venue.js';
import { dexDoorHonestySchema, dexHealthHonesty } from './quote/door-honesty.js';
import { QuoteRefusedError, sourceQuote } from './quote/quote-service.js';
import { InternalBookFeeUnconfiguredError } from './quote/venue-set.js';
import {
  assertMarketListed,
  HideListRefusedError,
  MARKET_HIDDEN,
  POOL_HIDDEN,
  HIDE_LIST_UNSET,
  withoutHiddenPools,
  type HideListReader,
} from './quote/hide-list.js';
import { withRouteSpan } from './tracing.js';
import { limitOrderProcedure } from './order/limit-order.js';

/**
 * svc-dex — the Protocol Plane's front door (§17.5).
 *
 * `quote` and `routePreview` are permissionless. No login, no KYC tier, no account
 * gate beyond a wallet. That is not a relaxation, it is §503:
 *
 *   "No-KYC exists on the Protocol Plane because there is nothing to KYC — the
 *    platform never holds user assets there."
 *
 * `publicJurisdictionProcedure('dex', 'protocol')` still runs the jurisdiction
 * matrix, because a sanctioned region is a legal constraint rather than a
 * custody one. `checkAccess` short-circuits a `custodial: false` module on the
 * protocol plane to `allowed.permissionless` before any tier is read — so the
 * gate that remains is the one that must, and the one that must not is gone.
 *
 * Contrast svc-trade, the custodial venue: `scopedProcedure('trade:write')`
 * with `minTier: 'basic'`, because that service holds the user's balance. Same
 * platform, two planes, and the difference is visible in one line of each
 * router.
 *
 * `limitOrder` is the exception. svc-identity issues the wallet session; Edge
 * forwards that principal. A missing principal refuses
 * `dex.order.principal_required`. This procedure does not issue a nonce, call
 * svc-identity, or store a session. A blank price, size, or window refuses.
 * A complete order still refuses `dex.order.not_placed`: this service holds
 * no vault and calls no one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `quote` USED TO BE A CALCULATOR. IT IS NOW A QUOTE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It previously took `quotes: []` over the wire and routed whatever the CALLER
 * supplied. The arithmetic was real and tested; the prices came from nowhere.
 * Anything rendering that result showed a user a number no venue had ever
 * offered — and a user who acts on such a number has been misled by us.
 *
 * So `quote` now sources its own prices from live venues, enforces
 * `QUOTE_MAX_AGE_MS` on them, and REFUSES when it cannot. The old behaviour
 * survives under a name that cannot be mistaken for a price — `routePreview` —
 * because the arithmetic is genuinely useful for showing how routing works, and
 * because leaving it called `quote` was the actual defect.
 */

const quoteInput = z.object({
  venue: z.string().min(1),
  kind: z.enum(['book', 'pool']),
  fillableQty: z.string(),
  quoteAmount: z.string(),
  feeBps: z.number().int().min(0).max(9_999),
  settlementCost: z.string(),
});

/** Decimal string. The same rule the rest of the platform states. */
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

const routeSchema = z.object({
  /** A plan is never a fill. Preview arithmetic is never a live quote. */
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

const sourcedQuoteSchema = z.object({
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  route: routeSchema,
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
   * Ranking denominator. Not a certified best-execution claim — see `bestEx`.
   *
   * `degraded` and `singleVenue` exist so a client cannot accidentally present
   * the only venue that answered as the best of several. That is the quiet
   * failure mode of every cross-venue router.
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

export interface DexRouterDeps {
  /**
   * The venues to quote, built per request from the caller's screened region.
   *
   * A factory rather than a fixed list so the region that passed this service's
   * own jurisdiction check travels upstream with the read. Screening at the
   * front door and then calling an upstream as an unknown region would leave the
   * two disagreeing about who is being served.
   */
  readonly venues: (region: string) => readonly QuoteVenue[];
  /** Unset → `dex.quote.max_age_unset`. Never invent 2000. */
  readonly maxAgeMs?: number;
  /** Unset → `dex.quote.depth_unset`. Never invent 50. */
  readonly depth?: number;
  /**
   * Where the hide list is read (svc-ops `protocolListing.hidden`). Unset → `dex.quote.hide_list_unset`: with no list to
   * read, a delisted market cannot be told from a listed one, so nothing is quoted.
   */
  readonly hideList?: HideListReader;
  /** Injected in tests. */
  readonly now?: () => Date;
  /**
   * Whether the internal book is in the venue set. Health/ready must not claim
   * non-custodial while this is on. Default false only in tests that omit it.
   */
  readonly internalBookEnabled?: boolean;
  /** True only if an operator attached `kind: 'amm'`. Shipped default is false. */
  readonly ammVenueWired?: boolean;
  /** True only if `DEX_EXTERNAL_VENUES` has a row. Shipped default is false. */
  readonly externalVenueWired?: boolean;
}

/**
 * Map a refusal onto the wire.
 *
 * The `dex.quote.*` code leads the message because it is the part a client
 * branches on, and prose is not a protocol. The HTTP status matters too: an
 * unreachable venue is a 503 someone should be paged about, while an empty book
 * is a 404-shaped fact about the market that no amount of paging fixes.
 */
function toTrpcError(err: QuoteRefusedError): TRPCError {
  const code =
    err.code === 'dex.quote.no_liquidity'
      ? 'NOT_FOUND'
      : err.code === 'dex.quote.depth_unset' || err.code === 'dex.quote.max_age_unset'
        ? 'PRECONDITION_FAILED'
        : 'SERVICE_UNAVAILABLE';
  return new TRPCError({ code, message: `${err.code} — ${err.message}`, cause: err });
}

export function createDexRouter(deps: DexRouterDeps) {
  return router({
    health: publicProcedure
      .output(
        z.object({
          ok: z.literal(true),
          service: z.literal('svc-dex'),
          ...dexDoorHonestySchema.shape,
        }),
      )
      .query(() =>
        dexHealthHonesty({
          internalBookEnabled: deps.internalBookEnabled ?? false,
          ammVenueWired: deps.ammVenueWired ?? false,
          externalVenueWired: deps.externalVenueWired ?? false,
        }),
      ),

    /**
     * A LIVE quote: ranked observed books across the venues we can actually read.
     * Ranking is not a certified best-execution claim — `bestEx` is idle until
     * owner law is set (`refuseBestExClaim`).
     *
     * Every price in the response was fetched from a venue inside
     * `QUOTE_MAX_AGE_MS`. There is no cache and no fallback — see
     * `quote/quote-service.ts`. When no venue can be read fresh this throws
     * rather than answering, because a refusal costs a retry and an invented
     * price costs a trade.
     *
     * Amounts cross the wire as decimal strings and are parsed to scaled bigint
     * here. A JSON number would round the 18th decimal away, and the 18th
     * decimal is where a split route stops adding up.
     */
    quote: publicJurisdictionProcedure('dex', 'protocol')
      .input(z.object({ symbol: z.string().min(1).max(64), side: z.enum(['buy', 'sell']), qty: decimal }))
      .output(sourcedQuoteSchema)
      .query(async ({ input, ctx }) => {
        try {
          // After the owner settings (which refuse first when blank), before any venue is read.
          const hidden =
            deps.maxAgeMs !== undefined && deps.depth !== undefined ? await assertMarketListed(deps.hideList, input.symbol) : undefined;
          // A pool INTAFACED has hidden leaves routing; so does nothing else. Without a read list (owner settings refuse below) nothing is dropped.
          const built = deps.venues(ctx.region);
          const venues = hidden ? withoutHiddenPools(built, hidden) : built;
          // Every venue was a hidden pool: that is a listing decision, not an unwired service.
          if (built.length > 0 && venues.length === 0) {
            throw new HideListRefusedError(POOL_HIDDEN, 'every pool that quotes this market is hidden by INTAFACED; no quote is given');
          }
          return await withRouteSpan('dex.quote', { side: input.side, venues: venues.length }, async () => {
            const quoted = await sourceQuote(
              { venues, maxAgeMs: deps.maxAgeMs, depth: deps.depth, ...(deps.now ? { now: deps.now } : {}) },
              { symbol: input.symbol, side: input.side, qty: parseAmount(input.qty) },
            );
            // Copied out of their readonly containers for the wire schema. The
            // service keeps them readonly because nothing downstream of a priced
            // route has any business editing what a venue said.
            return { ...quoted, venues: [...quoted.venues], unavailable: [...quoted.unavailable] };
          });
        } catch (err) {
          if (err instanceof QuoteRefusedError) throw toTrpcError(err);
          if (err instanceof HideListRefusedError) {
            throw new TRPCError({
              code:
                err.code === MARKET_HIDDEN || err.code === POOL_HIDDEN
                  ? 'NOT_FOUND'
                  : err.code === HIDE_LIST_UNSET
                    ? 'PRECONDITION_FAILED'
                    : 'SERVICE_UNAVAILABLE',
              message: `${err.code} — ${err.message}`,
              cause: err,
            });
          }
          if (err instanceof InternalBookFeeUnconfiguredError) {
            throw new TRPCError({
              code: 'SERVICE_UNAVAILABLE',
              message: `${err.code} — ${err.message}`,
              cause: err,
            });
          }
          throw err;
        }
      }),

    /**
     * The routing arithmetic, over quotes the CALLER supplies.
     *
     * **This is not a price and must never be rendered as one.** It answers
     * "given these venue quotes, where would the order go?" — useful for a
     * routing explainer, a simulation or a test, and useless as a quote, because
     * the inputs came from whoever called it.
     *
     * The name now carries that. It was called `quote`, which is precisely how a
     * caller ends up displaying invented numbers in good faith.
     */
    routePreview: publicJurisdictionProcedure('dex', 'protocol')
      .input(z.object({ side: z.enum(['buy', 'sell']), qty: z.string(), quotes: z.array(quoteInput) }))
      .output(routeSchema)
      .query(({ input }) => {
        const quotes: VenueQuote[] = input.quotes.map((q) => ({
          venue: q.venue,
          kind: q.kind,
          fillableQty: parseAmount(q.fillableQty),
          quoteAmount: parseAmount(q.quoteAmount),
          feeBps: q.feeBps,
          settlementCost: parseAmount(q.settlementCost),
        }));

        return presentRoute(route({ side: input.side, qty: parseAmount(input.qty) }, quotes), {
          kind: 'preview',
          executable: false,
        });
      }),

    /**
     * A limit order for the signed-in wallet. The principal is the session
     * Edge forwarded. See `order/limit-order.ts` — this does not place it.
     */
    limitOrder: limitOrderProcedure(deps.now ? { now: deps.now } : {}),
  });
}

export type DexRouter = ReturnType<typeof createDexRouter>;
