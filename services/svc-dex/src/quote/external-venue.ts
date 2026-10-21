import { z } from 'zod';
import { parseAmount, type Amount } from '@intafaced/ledger-client/money';
import { MarketDataSource, type MarketDataSourceOptions } from './market-data-source.js';
import type { PoolRef, TimestampedBook, VenueKind } from './venue.js';
import { VenueUnavailableError } from './venue.js';
import { getJson, parseLevels, type HttpVenueOptions } from './wire.js';

/**
 * EXTERNAL VENUES — the §27 `MarketDataAdapter`, ours, credential-free.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO `ccxt` IMPORT IN THIS FILE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * §27, INTAFACED CONNECT: _"Our own CCXT-class layer, built past it: typed,
 * streaming-first, latency-graded… **No third-party connectivity library in the
 * money path** — Doctrine 5 applies (own tech, narrow interfaces, Rust-portable
 * hot paths)."_
 *
 * So the `ccxt` package is not a dependency of this workspace, and that is a
 * decision rather than an oversight. Two reasons, and the second is the one that
 * would actually cost a user money:
 *
 *   1. **Doctrine 5 / §27.** The connectivity layer is ours. `packages/
 *      exchange-contract` already serves a CCXT-SHAPED API outward so every bot
 *      and terminal can trade on us; `packages/venue-adapter` is the inward
 *      half. Neither needs their code to keep their shape.
 *   2. **CCXT's unified `fetchOrderBook` returns JavaScript numbers.** Every
 *      venue below publishes its book as decimal STRINGS; CCXT parses them into
 *      floats before a caller ever sees them. Routing through it would put a
 *      float in front of every price in the platform — the one thing Doctrine
 *      forbids without exception, and unrecoverable once it has happened.
 *      Reading the venue's own strings costs one adapter and keeps the
 *      eighteenth decimal place.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CONFIGURED, NOT HARDCODED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No venue is named in this file. A venue is a row of configuration
 * (`DEX_EXTERNAL_VENUES`), which buys three things:
 *
 *   · Doctrine §0.4 — adapters, not integrations. Adding a venue is config, and
 *     the platform never depends on any of them to function.
 *   · Doctrine §0.7 — no partner or vendor name in shipped code or user-facing copy.
 *   · An operator can add, reweight or drop a venue without a deploy, which is
 *     what a latency-graded fabric needs to be able to do.
 *
 * **The default set is empty.** A service that had no outbound network egress
 * yesterday does not silently acquire it. An operator opts in per venue.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CREDENTIALS: NOT NEEDED HERE, AND REFUSED NEXT DOOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Public depth needs no key on any tier-one venue, so the quote path works today
 * with nothing issued. Execution is the opposite: it needs trade-scoped Venue
 * Vault credentials (§27) and an OMS (§28, `svc-execution`), and neither exists.
 * `MarketDataSource.submit()` therefore throws `VenueExecutionRefused` rather
 * than returning a plausible rejection — see the argument there.
 *
 * ── What is NOT built, named rather than implied ────────────────────────────
 *
 * · **No rate-limit governor.** §27 asks for one per venue. This adapter fetches
 *   on every quote, so a busy market will hit a public endpoint hard enough to
 *   be throttled or banned. A venue that starts answering 429 degrades to
 *   `unreachable` and is dropped from routing rather than serving a bad price —
 *   correct, but it is a degradation, not a governor.
 * · **No WS streaming, no sequenced/gap-detected books.** §27 asks for
 *   WS-first. This is REST polling. `packages/market-data` already has the
 *   sequence machinery (`applyDelta` refuses a gap); wiring it needs a stream.
 * · **No cross-venue latency weighting.** `health()` records round-trip per
 *   venue, so the input exists; nothing consumes it as a routing weight yet.
 */

/**
 * Operator configuration for one external venue, validated at boot.
 *
 * Validated rather than cast: a typo in `DEX_EXTERNAL_VENUES` should stop the
 * service starting, not surface as a venue that mysteriously never quotes.
 */
export const externalVenueConfigSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.enum(['external-cex', 'external-dex', 'amm', 'otc']).optional(),
    depthUrl: z.string().url(),
    feeBps: z.number().int().min(0).max(9_999),
    settlementCost: z
      .string()
      .regex(/^\d+(\.\d{1,18})?$/, 'settlement cost is a decimal string with at most 18 decimal places')
      .optional(),
    bookPath: z.string().optional(),
    bidsField: z.string().optional(),
    asksField: z.string().optional(),
    sequencePath: z.string().optional(),
    /** The pool this venue quotes. Needed for a hidden pool to be dropped from routing. */
    pool: z
      .object({ chainId: z.number().int().positive(), address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) })
      .strict()
      .optional(),
  })
  .superRefine((row, ctx) => {
    const kind = row.kind ?? 'external-cex';
    const protocol = kind === 'external-dex' || kind === 'amm';
    // Unset gas on a protocol venue is not zero — a silent 0 understates cost.
    if (protocol && (row.settlementCost === undefined || row.settlementCost === '')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${row.id}: protocol venue settlementCost must be set from the venue — unset gas is not zero`,
      });
    }
  });

/** Where in a response the book sits, and how this venue spells a symbol. */
export interface ExternalVenueConfig {
  /** Venue id as it appears in every quote response. Operator-chosen. */
  readonly id: string;
  /**
   * Which kind of venue, which decides the settlement plane a caller is shown.
   *
   * Defaults to `external-cex`, the conservative reading: somebody else holds
   * the asset and the user needs an account there.
   */
  readonly kind?: VenueKind;
  /**
   * Public depth URL, with substitution tokens.
   *
   *   `{symbol}`           the unified symbol, as given
   *   `{symbolCompact}`    delimiters stripped, upper — `BTC/USDT` → `BTCUSDT`
   *   `{symbolLower}`      as compact, lower
   *   `{symbolUnderscore}` delimiter → `_`
   *   `{symbolDash}`       delimiter → `-`
   *   `{limit}`            requested depth
   */
  readonly depthUrl: string;
  /** Taker fee in bps. Configured and disclosed — see `env.ts`. */
  readonly feeBps: number;
  /** Settlement cost in the quote asset, decimal string. Usually `'0'` on a CEX. */
  readonly settlementCost?: string;
  /** Dotted path to the object carrying `bids`/`asks`. Empty = the response root. */
  readonly bookPath?: string;
  /** Field names, where a venue does not use `bids`/`asks`. */
  readonly bidsField?: string;
  readonly asksField?: string;
  /** Dotted path to the venue's own update sequence, if it publishes one. */
  readonly sequencePath?: string;
  /** The pool this venue quotes (chain and address). A hide of that pool drops the venue from routing. */
  readonly pool?: PoolRef;
}

const DELIMITERS = /[-/_:]/g;

/** Substitute the symbol and limit tokens. Every value is URL-encoded. */
export function renderDepthUrl(template: string, symbol: string, limit: number): string {
  const compact = symbol.replace(DELIMITERS, '').toUpperCase();
  const tokens: Record<string, string> = {
    '{symbol}': symbol,
    '{symbolCompact}': compact,
    '{symbolLower}': compact.toLowerCase(),
    '{symbolUnderscore}': symbol.replace(DELIMITERS, '_').toUpperCase(),
    '{symbolDash}': symbol.replace(DELIMITERS, '-').toUpperCase(),
    '{limit}': String(limit),
  };

  let url = template;
  for (const [token, value] of Object.entries(tokens)) {
    url = url.split(token).join(encodeURIComponent(value));
  }
  return url;
}

/** Walk a dotted path. Numeric segments index arrays. */
function at(root: unknown, path: string | undefined): unknown {
  if (!path) return root;
  let node: unknown = root;
  for (const segment of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = Array.isArray(node) ? node[Number(segment)] : (node as Record<string, unknown>)[segment];
  }
  return node;
}

export interface ExternalVenueOptions extends HttpVenueOptions, MarketDataSourceOptions {
  readonly config: ExternalVenueConfig;
}

export class ExternalQuoteVenue extends MarketDataSource {
  readonly id: string;
  readonly kind: VenueKind;
  readonly feeBps: number;
  readonly settlementCost: Amount;
  readonly pool?: PoolRef;

  readonly #config: ExternalVenueConfig;
  readonly #http: HttpVenueOptions;

  constructor(options: ExternalVenueOptions) {
    super(options);
    const config = options.config;
    this.#config = config;
    this.#http = options;
    this.id = config.id;
    this.kind = config.kind ?? 'external-cex';
    this.feeBps = config.feeBps;
    if (config.pool) this.pool = config.pool;
    // CEX/OTC: no chain gas. Protocol kinds are refused by the schema above
    // rather than defaulting settlement to '0'.
    this.settlementCost = parseAmount(config.settlementCost ?? '0');
  }

  protected async fetchDepth(symbol: string, limit: number): Promise<TimestampedBook> {
    const url = renderDepthUrl(this.#config.depthUrl, symbol, limit);
    const body = await getJson(this.id, url, this.#http);
    const observedAt = new Date();

    const book = at(body, this.#config.bookPath);
    if (book === null || typeof book !== 'object') {
      throw new VenueUnavailableError(this.id, 'malformed', `${this.id}: no book object at path "${this.#config.bookPath ?? '<root>'}"`);
    }

    const container = book as Record<string, unknown>;
    const bids = container[this.#config.bidsField ?? 'bids'];
    const asks = container[this.#config.asksField ?? 'asks'];

    // `parseLevels` refuses JSON numbers outright. That is the whole reason this
    // adapter exists instead of a CCXT client: a venue that publishes floats
    // cannot be quoted honestly, and finding out here beats finding out in a fill.
    const sequence = at(body, this.#config.sequencePath);

    const protocol = this.kind === 'external-dex' || this.kind === 'amm';
    return {
      venueId: this.id,
      symbol,
      bids: parseLevels(bids, 'bids', this.id),
      asks: parseLevels(asks, 'asks', this.id),
      observedAt,
      sequence: typeof sequence === 'number' && Number.isInteger(sequence) && sequence >= 0 ? sequence : 0,
      // An external REST book is not chain-finality evidence. Protocol-plane
      // quotes from it stay unknown until a finalized source exists.
      ...(protocol ? { chainFinality: 'unknown' as const } : {}),
    };
  }
}
