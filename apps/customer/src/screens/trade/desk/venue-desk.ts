import { formatAmount, parseAmount } from '../../../shared/money';
import {
  canonicalDecimal,
  draftId,
  keys,
  onStep,
  type KeptSignature,
  type OrderIntent,
  type VenueBalance,
  type VenueBestPrices,
  type VenueMarket,
  type VenuePreview,
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
 * A market order's worst price from the venue's best prices and the owner's protection `bps` (never a default): a buy
 * pays at most the best ask plus `bps`, up to the tick; a sell at least the best bid less `bps`, down. Null with no price.
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
export type TicketProblem = 'amount' | 'price' | 'amount_step' | 'price_step' | 'no_book' | 'no_cap';

/** `capSet` false: the owner's protection is blank, so a market order is refused (`trade.slippage_cap_unset`). */
export function ticketProblem(fields: TicketFields, market: VenueMarket, worst: string | null, capSet = true): TicketProblem | null {
  if (!fields.amount.trim() || !isDecimal(fields.amount)) return 'amount';
  if (!onStep(fields.amount, market.lotSize)) return 'amount_step';
  if (fields.type === 'market') return !capSet ? 'no_cap' : worst === null ? 'no_book' : null;
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

/** The ticket as the venue's intent: a limit GTC at its price, a market IOC at its worst price (none if `capSet` is false). */
export function intentOf(
  fields: TicketFields,
  market: VenueMarket,
  worst: string | null,
  clientOrderKey: string,
  capSet: boolean,
): OrderIntent | null {
  if (ticketProblem(fields, market, worst, capSet) !== null) return null;
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

/** The order key (and a market order's worst price) held until the order changes or gets a definite answer. */
export class HeldDraft {
  private held: { signature: string; key: string; worst: string | null } | null = null;
  private counter = 0;

  constructor(
    private readonly owner: string,
    private readonly symbol: string,
    private readonly now: () => number = Date.now,
  ) {}

  keyFor(fields: TicketFields): string {
    return this.hold(fields, null).key;
  }

  /** The key for this order and the worst price held with it (a limit's is unused). */
  hold(fields: TicketFields, worst: string | null): { key: string; worst: string | null } {
    const signature = draftSignature(fields);
    if (this.held?.signature !== signature) {
      this.held = { signature, key: keys.order(this.owner, this.symbol, draftId(this.now(), this.counter++)), worst };
    } else if (this.held.worst === null && worst !== null) {
      // Nothing was built under the key without a worst price (no intent with no book), so the first one is held.
      this.held = { ...this.held, worst };
    }
    return { key: this.held.key, worst: this.held.worst };
  }

  /** The venue answered this order definitely, or the door refused it before preparing anything: the next order is a new one. */
  settle(key: string) {
    if (this.held?.key === key) this.held = null;
  }
}

/** The door refused the held worst price as past the protection before preparing anything: the next try mints a new key. */
export function refusedAtHeldWorst(result: { kind: string; code?: string | undefined }): boolean {
  return result.kind === 'refused' && result.code === 'trade.venue.price_outside_protection';
}

/** The deposit route `/venue/status` names (B2's chain-transfer watcher). */
export interface DepositRoute {
  chainId: number;
  token: string;
  tokenDecimals: number;
  address: string;
  asset: string;
}

/** The person's ERC-20 `transfer` to the venue's deposit address; null unless the amount is positive within the token's decimals. */
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

/**
 * Whether the venue's preview of one order moved between Review and Confirm (J-cex-spot-02 #7): any figure the review
 * showed (the lock, the role, either fee, what fills now). A moved preview is shown and asked again; nothing is sent.
 */
export function previewMoved(reviewed: VenuePreview, now: VenuePreview): boolean {
  return JSON.stringify(reviewed) !== JSON.stringify(now);
}

/**
 * What an order locks that the venue account does not have free (J-cex-spot-02 #6), from the venue's own figures: the
 * preview's lock against the free balance of the asset it locks. Null when it is covered.
 */
export function lockShortfall(
  preview: Pick<VenuePreview, 'lock'>,
  balances: readonly Pick<VenueBalance, 'asset' | 'free'>[],
): { asset: string; lock: string; free: string } | null {
  const free = balances.find((b) => b.asset === preview.lock.asset)?.free ?? '0';
  return parseAmount(preview.lock.amount) > parseAmount(free) ? { asset: preview.lock.asset, lock: preview.lock.amount, free } : null;
}

/** An order the venue gave no definite answer to: its client id, its business key and the intent sent under it. */
export interface PendingOrder {
  clientOrderId: string;
  key: string;
  intent: OrderIntent;
  /**
   * The signed bytes sent under the key, when this tab signed it: "Send the same order again" re-sends them, so a lost
   * answer never asks the wallet a second time, even after a reload. A signed order, never a key.
   */
  signature?: KeptSignature;
}

/**
 * This browser tab's orders with no definite answer yet, per owner (sessionStorage, so a reload keeps them; J-cex-spot-02
 * #4): while one is listed, the desk sends no new order. Storage may be blocked; the page then keeps them in memory.
 */
export function pendingOrders(owner: string) {
  const name = `if.venue.pending.${owner}`;
  let memory: PendingOrder[] = [];
  const read = (): PendingOrder[] => {
    try {
      const raw = sessionStorage.getItem(name);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? (parsed as PendingOrder[]) : [];
    } catch {
      return memory;
    }
  };
  const write = (next: PendingOrder[]) => {
    memory = next;
    try {
      sessionStorage.setItem(name, JSON.stringify(next));
    } catch {
      /* blocked storage: the page keeps them */
    }
  };
  return {
    list: read,
    add(order: PendingOrder) {
      write([...read().filter((p) => p.clientOrderId !== order.clientOrderId), order]);
    },
    remove(clientOrderId: string) {
      write(read().filter((p) => p.clientOrderId !== clientOrderId));
    },
  };
}
