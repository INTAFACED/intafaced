import { z } from 'zod';
import { baseEnvSchema, edgeEnvSchema, httpEnvSchema, loadEnv, otelEnvSchema } from '@intafaced/config';
import { externalVenueConfigSchema } from './quote/external-venue.js';
import {
  dexOrderDomainField,
  dexOrderKeeperIntervalField,
  dexOrderMinSizeField,
  dexOrderOracleMaxAgeField,
  dexOrderRestrictedTokensField,
  dexOrderSlippageField,
  dexOrderWarnTokensField,
} from './order/trigger-settings.js';

/**
 * svc-dex environment.
 *
 * **No `DATABASE_URL` and no `INTERNAL_SERVICE_SECRET`, deliberately.**
 *
 * The Protocol Plane holds no balances of ours: state lives on chain and is
 * projected into read models by svc-indexer. A database here would eventually
 * hold a position, and a position we hold is custody (Doctrine §16.10).
 *
 * The internal service secret is what lets a service call `ledger.post`.
 * Withholding it means a bug in this service cannot become a ledger write even
 * if someone imports the wrong module — `custody-scan` catches the import, and
 * the missing secret catches anything that slips past it.
 */
const schema = baseEnvSchema
  .merge(httpEnvSchema)
  .merge(otelEnvSchema)
  .merge(edgeEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-dex'),
      HTTP_PORT: z.coerce.number().int().default(4010),

      /** Read models. Quotes are served from projections, never from a chain call. */
      // 4013 = svc-indexer (4012 is svc-protocol). Matching listens on 4005.
      INDEXER_URL: z.string().url().default('http://localhost:4013'),
      /**
       * svc-ops, read-only: `protocolListing.hidden` is the list of markets INTAFACED does not list. Blank / unset →
       * quote refuses `dex.quote.hide_list_unset`. No default: a guessed host would read a list that is not ours.
       */
      OPS_URL: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().url().optional()),
      /** The internal CLOB, quoted as one venue among several. */
      MATCHING_URL: z.string().url().default('http://localhost:4005'),

      /**
       * Quote staleness ceiling. A router that acts on an old quote routes to a
       * price that no longer exists — which looks to the user like the venue
       * lied to them.
       *
       * Enforced in `quote/quote-service.ts` against `VenueBook.observedAt` —
       * the moment THIS process finished reading a venue, not a timestamp the
       * venue supplied. It doubles as the per-venue fetch timeout: waiting
       * longer than the answer can be valid for only converts a fast refusal
       * into a slow one.
       *
       * Blank / unset → unpublished; quote refuses `dex.quote.max_age_unset`.
       * Never git-default 2000 — that publishes freshness the owner did not set.
       * Owner-explicit 2000 is allowed. Malformed / out of range → fail boot.
       */
      QUOTE_MAX_AGE_MS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(100).max(30_000).optional()),

      /**
       * Book levels pulled from each venue when pricing a size.
       * Blank / unset → unpublished; quote refuses `dex.quote.depth_unset`.
       * Never git-default 50 — that looks like a live book size. Owner-explicit
       * 50 is allowed. Malformed / out of range → fail boot.
       */
      DEX_QUOTE_DEPTH: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(200).optional()),

      /**
       * Quote the Fiat Plane internal book alongside the on-chain one (§8.6).
       *
       * ON by default, because §8.6 is explicit — "internal book vs. pool quote
       * → best execution" — and hiding a venue that genuinely has the better
       * price costs the user money.
       *
       * What it does not do is hide the consequence: every venue in a
       * `dex.quote` response carries `plane` and `custodial`, so a caller who
       * wants only sovereign liquidity can see which legs are which. An operator
       * who wants this front door to quote nothing custodial sets it to `false`,
       * and the quote path is then Protocol Plane end to end.
       */
      DEX_INTERNAL_BOOK_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(true)
        .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'off', 'no'].includes(v.toLowerCase()))),

      /**
       * ── Venue cost parameters (S-I3 / `socket.dex-fee-source`) ────────────
       *
       * CLOB knobs have NO default. A default of 0 / '0' understates the user's
       * cost. Set both from the venue (SovereignVenue.takerFeeBps and
       * settlementCostQuote) or omit both — omitted means intachain-clob is not
       * quoted. One-sided config fails boot.
       *
       * Internal-book bps have NO default. Blank / unset refuses
       * `dex.internal_book_fee_unset` when the venue is enabled — never invent 20.
       * Settlement there is a ledger post (custodial), so there is no gas knob.
       */

      /** Taker fee on the on-chain CLOB, in bps. Unset = do not quote that venue. */
      DEX_CLOB_FEE_BPS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(0).max(9_999).optional()),

      /**
       * Quote-asset settlement surcharge for an on-chain fill, decimal string.
       * SovereignVenue.settlementCostQuote is 0 (gas is the user's tx). Unset
       * with the fee bps = do not quote intachain-clob.
       */
      DEX_CLOB_SETTLEMENT_COST: z.preprocess(
        (v) => (v === undefined || v === null || v === '' ? undefined : v),
        z
          .string()
          .regex(/^\d+(\.\d{1,18})?$/, 'settlement cost is a decimal string with at most 18 decimal places')
          .optional(),
      ),

      /**
       * Taker fee on the internal book, in bps. NO DEFAULT.
       *
       * Blank / unset → undefined; quoting the enabled internal book refuses
       * `dex.internal_book_fee_unset`. Never invent 20.
       *
       * Settlement there is a ledger post (custodial), so there is no gas leg
       * and therefore no settlement-cost knob beside it — a fabricated one
       * would be worse than none.
       */
      DEX_INTERNAL_BOOK_FEE_BPS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(0).max(9_999).optional()),

      /**
       * EXTERNAL VENUES — the §27 multi-venue fabric, as configuration.
       *
       * A JSON array of `externalVenueConfigSchema` rows. No venue is named in
       * shipped code: adding one is config (Doctrine §0.4 — adapters, not
       * integrations; Doctrine §0.7 — no vendor names in the repo), and an
       * operator can add, reweight or drop a venue without a deploy.
       *
       * **Empty by default, deliberately.** A service that had no outbound
       * network egress yesterday does not silently acquire it because a package
       * was upgraded. Every venue is an explicit operator decision.
       *
       * Public depth needs no credentials on any tier-one venue, so quotes work
       * the moment a row is added. Execution does need keys, and there is no
       * execution path here at all — every adapter refuses `submit` (§28 owns
       * that, and it is not built).
       *
       * Example (one venue, tokens substituted per `renderDepthUrl`):
       *   [{"id":"venue-a","depthUrl":"https://…/depth?symbol={symbolCompact}&limit={limit}","feeBps":10}]
       */
      DEX_EXTERNAL_VENUES: z
        .string()
        .default('[]')
        .transform((raw, ctx) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (err) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `DEX_EXTERNAL_VENUES is not valid JSON: ${(err as Error).message}` });
            return z.NEVER;
          }
          const result = z.array(externalVenueConfigSchema).safeParse(parsed);
          if (!result.success) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `DEX_EXTERNAL_VENUES is malformed: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
            });
            return z.NEVER;
          }
          return result.data;
        }),

      /**
       * Minimum amountIn for a price-trigger order, as a decimal string.
       * NO DEFAULT. Blank refuses `dex.order.min_size_unset`.
       */
      DEX_ORDER_MIN_SIZE: dexOrderMinSizeField.optional(),
      /**
       * Restricted token addresses as a JSON array.
       * NO DEFAULT. Blank refuses `dex.order.restricted_list_unset`. An explicit empty array restricts nothing.
       */
      DEX_ORDER_RESTRICTED_TOKENS: dexOrderRestrictedTokensField.optional(),
      /**
       * Warn-tier token addresses as a JSON array.
       * NO DEFAULT. Blank refuses `dex.order.warn_list_unset`. An explicit empty array warns on nothing.
       */
      DEX_ORDER_WARN_TOKENS: dexOrderWarnTokensField.optional(),
      /**
       * Default slippage for a price-trigger order, in basis points.
       * NO DEFAULT. Blank refuses `dex.order.slippage_unset`.
       */
      DEX_ORDER_SLIPPAGE_BPS: dexOrderSlippageField.optional(),
      /**
       * Maximum age of a trigger price, in milliseconds.
       * NO DEFAULT. Blank refuses `dex.order.oracle_max_age_unset` on a fill.
       */
      DEX_ORDER_ORACLE_MAX_AGE_MS: dexOrderOracleMaxAgeField.optional(),
      /**
       * How often the price-trigger keeper wakes, in milliseconds.
       * NO DEFAULT. Blank does not start the keeper.
       */
      DEX_ORDER_KEEPER_INTERVAL_MS: dexOrderKeeperIntervalField.optional(),
      /**
       * EIP-712 domain for a price-trigger order: JSON name, version, chainId, verifyingContract.
       * NO DEFAULT. Blank refuses `dex.order.domain_unset`. An unchecked signature is not stored.
       */
      DEX_ORDER_DOMAIN: dexOrderDomainField.optional(),
      /**
       * Directory for dex.orders and dex.order_attempts. Not a balance.
       * Blank uses the system temp directory intafaced-svc-dex-orders so a restart can read the same rows.
       */
      DEX_ORDER_STORE_DIR: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(1).optional()),
    }),
  )
  .superRefine((parsed, ctx) => {
    const feeBlank = parsed.DEX_CLOB_FEE_BPS === undefined;
    const costSet = parsed.DEX_CLOB_SETTLEMENT_COST !== undefined && parsed.DEX_CLOB_SETTLEMENT_COST !== '';
    if (feeBlank && costSet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DEX_CLOB_FEE_BPS'],
        message: 'DEX_CLOB_FEE_BPS is blank while DEX_CLOB_SETTLEMENT_COST is set. Refusing to publish a 0 bps schedule.',
      });
    }
  });

export const env = loadEnv(schema);
export type DexEnv = typeof env;
