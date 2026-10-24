/**
 * Ports the keeper uses. The shipped ports are unwired on purpose.
 *
 * ADR 3.2: this process calls no service and holds no key. A price feed and a
 * chain node are owner environment, not something this file invents. Blank stays
 * unwired (`feed.market`, `rail.crypto`). A test supplies a port that records
 * sends; production does not broadcast.
 */

export interface PriceReadInput {
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly at: Date;
}

export type PriceRead =
  | { readonly status: 'unwired' }
  | { readonly status: 'stale' }
  | { readonly status: 'disagree' }
  | { readonly status: 'ok'; readonly price: bigint; readonly observedAt: string };

export interface PricePort {
  read(input: PriceReadInput): Promise<PriceRead>;
}

export interface FillQuoteInput {
  readonly orderHash: string;
  readonly maker: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  /** Sum of executing takes on this pair. The quote must not spend them twice. */
  readonly reserved: bigint;
}

export type FillQuote =
  | { readonly status: 'unwired' }
  | { readonly status: 'insufficient_liquidity' }
  | { readonly status: 'reverted' }
  | { readonly status: 'ok'; readonly take: bigint; readonly out: bigint };

export interface FillSendInput {
  readonly key: string;
  readonly orderHash: string;
  readonly maker: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly take: bigint;
  readonly minOut: bigint;
  /**
   * Persist the tx hash before this promise settles. A throw after `noteTx`
   * still leaves the hash on the intent.
   */
  readonly noteTx: (txHash: string) => void;
}

export type FillSend =
  | { readonly status: 'unwired' }
  | { readonly status: 'unknown'; readonly txHash?: string }
  | { readonly status: 'rejected'; readonly reason: 'insufficient_liquidity' | 'reverted' }
  | { readonly status: 'sent'; readonly txHash: string };

export type FillReceipt = 'pending' | 'success' | 'reverted' | 'unwired';

export interface FillPort {
  quote(input: FillQuoteInput): Promise<FillQuote>;
  /**
   * At most one broadcast per `key` (`dex.order.fill:<orderHash>:<round>`).
   * Record the key before any broadcast. A repeat returns the same hash and does not broadcast again.
   * Call `noteTx` with the hash before resolving, rejecting, or returning `unknown`, when a hash exists.
   * `unknown` means the broadcast may have happened. The caller keeps the order `executing`.
   * `sent` with a blank hash is the same: the caller marks the row uncertain and does not clear it.
   * A throw, `rejected`, or `unwired` with no stored hash, while the row is not yet uncertain, was not a broadcast:
   * the caller clears the row and does not start the next round.
   * Once the row is uncertain, a later throw, `rejected`, or `unwired` does not clear it.
   * A repeat of `send` may run only to recover the hash for that key.
   * A stored hash is finished only by `read`.
   */
  send(input: FillSendInput): Promise<FillSend>;
  read(txHash: string): Promise<FillReceipt>;
}

export const unwiredPricePort: PricePort = {
  async read() {
    return { status: 'unwired' };
  },
};

export const unwiredFillPort: FillPort = {
  async quote() {
    return { status: 'unwired' };
  },
  async send() {
    return { status: 'unwired' };
  },
  async read() {
    return 'unwired';
  },
};

export const FEED_UNWIRED_MESSAGE = 'Checking the trigger against a price needs a price feed. It is switched off in this build.';
export const RAIL_UNWIRED_MESSAGE = 'Filling through the pool needs a chain node. It is switched off in this build.';
