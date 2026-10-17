import type { DepthHub } from '../depth/hub.js';
import type { MarketDirectory } from './sources.js';

/**
 * MARKET NAMES ON THE MULTIPLEXED DOOR.
 *
 * A client may say a market id (`BTC-USDT`, or the uuid the listing serves) or
 * the unified symbol (`BTC/USDT`). Everything downstream — hubs, caches, frames
 * — speaks the canonical id, so a symbol is resolved ONCE, here, and the ack
 * tells the client which id its frames will carry.
 *
 * The id path is the same listing check the legacy door uses
 * (`DepthHub.ensureKnownMarket`), so an id nobody lists is refused before any
 * depth call is made for it. A symbol only resolves through the listing's own
 * `id`/`symbol` pairs.
 */
export interface ResolvedMarket {
  readonly id: string;
  /** Unified symbol when the listing carries one. */
  readonly symbol: string | null;
}

export interface MarketResolver {
  /** `null` = nobody lists it. Throws only when the listing could not be read at all. */
  resolve(input: string): Promise<ResolvedMarket | null>;
}

export class HubMarketResolver implements MarketResolver {
  readonly #hub: Pick<DepthHub, 'ensureKnownMarket'>;
  readonly #directory: MarketDirectory;

  constructor(hub: Pick<DepthHub, 'ensureKnownMarket'>, directory: MarketDirectory) {
    this.#hub = hub;
    this.#directory = directory;
  }

  async resolve(input: string): Promise<ResolvedMarket | null> {
    // A symbol has a slash; no market id does. Skip the id check for it so a
    // symbol never costs a listing refresh it cannot satisfy.
    if (!input.includes('/')) {
      if (await this.#hub.ensureKnownMarket(input)) {
        await this.#directory.refresh();
        return { id: input, symbol: this.#directory.symbolFor(input) };
      }
    }
    await this.#directory.refresh();
    const id = this.#directory.idForSymbol(input);
    if (id === null) return null;
    if (!(await this.#hub.ensureKnownMarket(id))) return null;
    return { id, symbol: input };
  }
}
