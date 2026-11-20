import type { Amount } from '@intafaced/ledger-client/money';
import { MarketDataSource, type MarketDataSourceOptions } from './market-data-source.js';
import type { TimestampedBook, VenueKind } from './venue.js';
import { VenueUnavailableError } from './venue.js';
import { trpcRecordReply, trpcRecordRequest } from '@intafaced/contracts/procedure-trpc';
import { INDEXER_BOOK, INDEXER_STATUS } from '@intafaced/contracts/indexer-procedures';
import { getJson, parseLevels, trimBaseUrl, type HttpVenueOptions } from './wire.js';

/**
 * THE ON-CHAIN BOOK, VIA svc-indexer (§17.5).
 *
 * `kind: 'external-dex'` — an on-chain venue where the user's own key holds the
 * asset. This is the sovereign leg, and the only one in the set that a
 * permissionless caller can both be quoted AND execute.
 *
 * The Protocol Plane keeps its state on chain. Nothing can query a chain fast
 * enough to price an order, so svc-indexer follows chain state and projects it
 * into read models — and `env.ts` has said from the beginning what that means
 * for this service:
 *
 *   "Read models. Quotes are served from projections, never from a chain call."
 *
 * This is the adapter that finally reads them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS RETURNS TODAY, STATED PLAINLY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **A refusal.** svc-indexer boots on `NullChainSource` — SOCKET §13
 * (`socket.evm-rpc`). There is no EVM RPC in this stack and no deployed CLOB
 * contract to read, so nothing has ever been projected, `book.asOfHeight` is
 * `null`, and this adapter refuses with `not_ready`.
 *
 * That is the correct behaviour and it is the whole point. The alternative — an
 * adapter that returns something anyway — is the failure this file exists to
 * prevent. **The DEX cannot quote the sovereign plane until a chain exists to
 * quote**, and a refusal code is the honest form of that sentence. The moment
 * `socket.evm-rpc` closes and svc-indexer projects a real book, this adapter
 * starts answering without a line of it changing.
 *
 * ── Two refusals that are not the same thing ────────────────────────────────
 *
 * · `halted` — the projection hit a reorg deeper than its retained history. It
 *   knows its book is wrong and cannot repair it. svc-indexer already leaves its
 *   own readiness rotation for this; a quote path that read the book anyway
 *   would be reading the one state that service explicitly declares untrustworthy.
 * · `asOfHeight === null` — nothing has been indexed at all. An empty book from
 *   an empty index is not "no liquidity", it is "no data", and pricing against
 *   it would report a market with no bids as a market with no buyers.
 *
 * ── The freshness this adapter can and cannot enforce ───────────────────────
 *
 * It enforces observation age: `observedAt` is stamped when the read returns and
 * `quote-service.ts` refuses anything past `QUOTE_MAX_AGE_MS`.
 *
 * It does NOT measure how far behind the chain the projection is. That needs the
 * head block's own timestamp, and `indexer.status` publishes `indexedHeight` and
 * `halted` but no block time. A projection that is up, unhalted and twenty
 * blocks behind therefore looks fresh here. Closing that gap is one extra field
 * on svc-indexer's status output — a change to another service, so it is
 * recorded here rather than smuggled in.
 */

export interface IndexerVenueOptions extends HttpVenueOptions, MarketDataSourceOptions {
  readonly feeBps: number;
  readonly settlementCost: Amount;
  /** Forwarded so a screened region stays screened at the upstream too. */
  readonly region?: string;
}

/** A reply read by its record, or the refusal that says it is not the shape svc-indexer publishes. */
function readReply<T>(venueId: string, reply: T | null, what: string): T {
  if (reply === null)
    throw new VenueUnavailableError(venueId, 'malformed', `svc-indexer ${what} reply is not the shape its record publishes`);
  return reply;
}

export class IndexerQuoteVenue extends MarketDataSource {
  readonly id = 'intachain-clob';
  readonly kind: VenueKind = 'external-dex';
  readonly feeBps: number;
  readonly settlementCost: Amount;

  readonly #baseUrl: string;
  readonly #http: HttpVenueOptions;
  readonly #headers: Record<string, string>;

  constructor(options: IndexerVenueOptions) {
    super(options);
    this.#baseUrl = trimBaseUrl(options.baseUrl);
    this.#http = options;
    this.feeBps = options.feeBps;
    this.settlementCost = options.settlementCost;
    this.#headers = options.region ? { 'x-intafaced-region': options.region } : {};
  }

  protected async fetchDepth(symbol: string, limit: number): Promise<TimestampedBook> {
    // Both in flight together. Sequential calls would make the book older than
    // the status that vouched for it by a whole round trip, against a ceiling
    // that is 2000ms by default.
    const [statusBody, bookBody] = await Promise.all([
      getJson(this.id, trpcRecordRequest(INDEXER_STATUS, this.#baseUrl, undefined).url, this.#http, this.#headers),
      getJson(this.id, trpcRecordRequest(INDEXER_BOOK, this.#baseUrl, { market: symbol, depth: limit }).url, this.#http, this.#headers),
    ]);

    // Stamped after both reads land, so it describes the older of the two.
    const observedAt = new Date();

    const status = readReply(this.id, trpcRecordReply(INDEXER_STATUS, statusBody), 'status');
    if (status.halted !== null) {
      throw new VenueUnavailableError(
        this.id,
        'not_ready',
        `svc-indexer is halted (${status.halted.reason}) — its projection knows it is wrong`,
      );
    }

    const view = readReply(this.id, trpcRecordReply(INDEXER_BOOK, bookBody), 'book');
    if (view.asOfHeight === null) {
      throw new VenueUnavailableError(
        this.id,
        'not_ready',
        'svc-indexer has projected no chain state — there is no on-chain book to quote (SOCKET §13 socket.evm-rpc)',
      );
    }

    // Inclusion is not finality (PTX-M22-R05). A book without a finalized
    // height, or sitting above it, is still reorg/MEV-reversible. Quoting it as
    // an executable route would report a fill that the chain has not committed.
    // We do not invent a confirmation count here — we consume the indexer's
    // published finalizedHeight or refuse.
    const finalizedHeight = status.finalizedHeight;
    if (finalizedHeight === null) {
      throw new VenueUnavailableError(
        this.id,
        'missing_finality',
        'svc-indexer published no finalizedHeight — inclusion is not settlement and this book cannot be an executable route',
      );
    }
    if (finalizedHeight < 0) {
      throw new VenueUnavailableError(this.id, 'malformed', 'svc-indexer status carried a negative finalizedHeight');
    }
    if (view.asOfHeight > finalizedHeight) {
      throw new VenueUnavailableError(
        this.id,
        'reorg_unconfirmed',
        `book asOfHeight ${view.asOfHeight} is above finalizedHeight ${finalizedHeight} — MEV/reorg can still revert this observation`,
      );
    }

    return {
      venueId: this.id,
      symbol,
      bids: parseLevels(view.bids, 'bids', this.id),
      asks: parseLevels(view.asks, 'asks', this.id),
      observedAt,
      // Block height is this venue's sequence: it is monotonic on the canonical
      // chain and it is what `asOfHash` pins the book to.
      sequence: view.asOfHeight,
      chainFinality: 'finalized',
    };
  }
}
