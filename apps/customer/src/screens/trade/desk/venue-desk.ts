import { formatAmount, parseAmount } from '../../../shared/money';
import {
  canonicalDecimal,
  draftId,
  keys,
  onStep,
  type OrderIntent,
  type VenueBestPrices,
  type VenueMarket,
} from '../../../features/trade/venue-api';
import { transferCalldata } from '../../../features/protocol/wallet/transfer';
import { toTokenUnits } from '../../../features/protocol/venue-wallet/venue-account-api';

// The venue spot desk's own rules (J-cex-spot-01 #4, #6–#10, #12), apart from the screen so each is tested on its own.
// Every figure is a decimal string or a scaled bigint, never a number.

export type VenueSide = 'buy' | 'sell';
export type VenueOrderType = 'limit' | 'market';

/** A wallet address as the desk names it: its first six and last four characters ("0x1234…abcd"). */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * How far a market order's worst price may sit from the venue's best price, in basis points: the person's own choice
 * on the ticket, one of these, 100 bps (1%) unless they pick another.
 */
export const SLIPPAGE_CHOICES_BPS = [
  { bps: '50', percent: '0.5' },
  { bps: '100', percent: '1' },
  { bps: '200', percent: '2' },
] as const;
export type SlippageBps = (typeof SLIPPAGE_CHOICES_BPS)[number]['bps'];
export const DEFAULT_SLIPPAGE_BPS: SlippageBps = '100';

/**
 * A market order's worst price (its slippage limit), from the venue's own best prices: a buy pays at most the best ask
 * plus `bps`, rounded up to the tick; a sell takes at least the best bid less `bps`, rounded down. Null when the venue's
 * book has no price on the side the order meets, so no market order is offered then.
 */
export function slippageLimit(side: VenueSide, best: VenueBestPrices | null, bps: string, tick: string): string | null {
  const reference = side === 'buy' ? best?.ask : best?.bid;
  if (!reference) return null;
  const price = parseAmount(reference);
  const step = parseAmount(tick);
  const ratio = parseAmount(bps);
  const one = parseAmount('10000');
  if (price <= 0n || step <= 0n || ratio < 0n) return null;
  // Scaled bigint times a scaled ratio: divide by the scale of `one` to stay in the same units.
  const moved = side === 'buy' ? (price * (one + ratio)) / one : (price * (one - ratio)) / one;
  const ticks = side === 'buy' ? (moved + step - 1n) / step : moved / step;
  const limit = ticks * step;
  return limit > 0n ? formatAmount(limit) : null;
}

/** What the ticket holds for one side. */
export interface TicketFields {
  side: VenueSide;
  type: VenueOrderType;
  price: string;
  amount: string;
}

/** Why the ticket is not an order yet, or null when it is one the venue can be asked about. */
export type TicketProblem = 'amount' | 'price' | 'amount_step' | 'price_step' | 'no_book';

export function ticketProblem(fields: TicketFields, market: VenueMarket, worst: string | null): TicketProblem | null {
  if (!fields.amount.trim() || !isDecimal(fields.amount)) return 'amount';
  if (!onStep(fields.amount, market.lotSize)) return 'amount_step';
  if (fields.type === 'market') return worst === null ? 'no_book' : null;
  if (!fields.price.trim() || !isDecimal(fields.price)) return 'price';
  if (!onStep(fields.price, market.tickSize)) return 'price_step';
  return null;
}

function isDecimal(value: string): boolean {
  try {
    parseAmount(value.trim());
    return true;
  } catch {
    return false;
  }
}

/** The ticket as the venue's order intent: a limit good till cancelled at its price, a market IOC at its worst price. */
export function intentOf(fields: TicketFields, market: VenueMarket, worst: string | null, clientOrderKey: string): OrderIntent | null {
  if (ticketProblem(fields, market, worst) !== null) return null;
  const limit = fields.type === 'limit';
  return {
    kind: 'place_order',
    symbol: market.symbol,
    side: fields.side,
    type: fields.type,
    amount: canonicalDecimal(fields.amount),
    price: canonicalDecimal(limit ? fields.price : worst!),
    timeInForce: limit ? 'GTC' : 'IOC',
    reduceOnly: false,
    clientOrderKey,
    builderFee: null,
  };
}

/** The part of a ticket that names one order: the same order reviewed again keeps its client id. */
export function draftSignature(fields: TicketFields): string {
  const tidy = (v: string) => (isDecimal(v) ? canonicalDecimal(v) : v.trim());
  return [fields.side, fields.type, fields.type === 'limit' ? tidy(fields.price) : '', tidy(fields.amount)].join('|');
}

/**
 * The client order key held for retry: minted once for a ticket's order and kept while that order is unchanged and has
 * no definite answer, so a closed and reopened review, a double press or a lost answer names the same venue order. A
 * changed order, or one the venue answered definitely, gets a new key.
 */
export class HeldDraft {
  private held: { signature: string; key: string } | null = null;
  private counter = 0;

  constructor(
    private readonly owner: string,
    private readonly symbol: string,
    private readonly now: () => number = Date.now,
  ) {}

  keyFor(fields: TicketFields): string {
    const signature = draftSignature(fields);
    if (this.held?.signature !== signature) {
      this.held = { signature, key: keys.order(this.owner, this.symbol, draftId(this.now(), this.counter++)) };
    }
    return this.held.key;
  }

  /** The venue answered this order definitely: the next order is a new one. */
  settle(key: string) {
    if (this.held?.key === key) this.held = null;
  }
}

/** The deposit route `/venue/status` names (B2's chain-transfer watcher). */
export interface DepositRoute {
  chainId: number;
  token: string;
  tokenDecimals: number;
  address: string;
  asset: string;
}

/**
 * The person's own token transfer that funds the venue account: an ERC-20 `transfer` from their wallet to the venue's
 * deposit address, on the route's token. Null when the amount is not a positive amount within the token's decimals.
 * INTAFACED sends nothing; the ledger posts nothing.
 */
export function depositTransfer(route: DepositRoute, amount: string): { to: string; data: string; units: bigint } | null {
  const units = toTokenUnits(amount, route.tokenDecimals);
  if (units === null) return null;
  return { to: route.token, data: transferCalldata(route.address, units), units };
}

/** What the withdraw dialog does when its button is pressed: ask for the step-up first, and the wallet only after it. */
export type WithdrawStep = { step: 'refuse'; why: 'amount' } | { step: 'step_up' } | { step: 'sign'; stepUpApprovalId: string | null };

export function withdrawStep(amount: string, approval: { id: string | null } | null): WithdrawStep {
  if (toTokenUnits(amount, 18) === null) return { step: 'refuse', why: 'amount' };
  if (approval === null) return { step: 'step_up' };
  return { step: 'sign', stepUpApprovalId: approval.id };
}
