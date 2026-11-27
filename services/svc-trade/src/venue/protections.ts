import { randomUUID } from 'node:crypto';
import { keccak256, toHex, type TypedDataDefinition } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { add, compare, formatAmount, max, min, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import { AuthError, type Principal } from '@intafaced/auth';
import { JurisdictionError } from '@intafaced/contracts/trpc';
import type { AccountFreezeRead } from '../quant/live-run/ports.js';
import { assertPlaceEligible } from '../spot/place-eligibility.js';
import {
  VenueRefusalError,
  type PlaceUserOrderIntent,
  type UserVenueAccount,
  type UserVenueMarket,
  type UserVenueOrder,
  type VenueSubmitOutcome,
  openingFeesOf,
  venueClientOrderId,
} from '@intafaced/venue-contracts';
import { feeAdjustedBreakeven } from './breakeven.js';
import { closeTolerancePrice, requireCloseSlippageBps } from './close-slippage.js';
import type { EngineProtection, EngineProtectionStore } from './protection-store.js';
import { venueBoundPrice } from './venue-price.js';
import {
  assertTradingLevel,
  type PreparedAnswer,
  type UserVenueDoor,
  UserVenueDoorError,
  type VenueOrderByKey,
} from './user-venue-door.js';
import { agentSignerOf, orderSigner } from './request-signer.js';

/**
 * A POSITION'S PROTECTIONS ON THE PERSON'S OWN VENUE ACCOUNT (J-derivatives-03; D-orders-04, D-orders-05).
 *
 * Money (J-derivatives-03 "Money"): no value moves through INTAFACED and the ledger posts nothing. A protection rests on
 * the venue as its trigger order (a take profit, a stop loss, a stop market, a stop limit, on a price the venue judges
 * triggers on), signed by the person's own wallet; the venue fires it once and closes the position there. A kind the
 * venue lacks (a trailing stop, or a stop judged on the venue's index price) runs on our engine under the person's agent
 * permission: the person's wallet approves, on the venue, an agent key INTAFACED derives for their protections, and that
 * key signs one reduce-only market order, and nothing else, when the trigger is crossed. A stop never opens or enlarges a
 * position: every order here is reduce-only, and the venue refuses one that would.
 *
 * Crash points (whose funds are stranded?): none. Before the wallet signs, nothing exists on the venue. An engine stop is
 * claimed (`armed` → `firing`) by exactly one worker; its order is stored under `protection:fire:<owner>:<clientOrderId>` before it is sent,
 * the venue's client order id derives from that key, and a worker that crashes after the claim sends the same order again
 * on its next pass, which the venue takes once. The funds only ever sit on the person's own venue account.
 */

export type ProtectionKind = 'take_profit' | 'stop_loss' | 'stop_market' | 'stop_limit' | 'trailing_stop';
export type ProtectionSource = 'mark' | 'last' | 'index';

export type ProtectionErrorCode =
  | 'trade.protection_request_invalid'
  | 'trade.conditional_field_unsupported'
  | 'trade.conditional_would_increase'
  | 'trade.protection_above_position'
  | 'trade.protection_wrong_side'
  | 'trade.trigger_source_unset'
  | 'trade.protection_agent_unapproved'
  | 'trade.protection_agent_key_unset'
  | 'trade.protection_unknown'
  | 'trade.protection_final'
  | 'trade.breakeven_no_position'
  | 'trade.breakeven_fees_unknown'
  | 'trade.breakeven_history_short'
  | 'trade.breakeven_foreign_stop'
  | 'trade.trigger_move_not_offered'
  | 'trade.trigger_not_resting';

export class ProtectionError extends Error {
  constructor(
    readonly code: ProtectionErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ProtectionError';
  }
}

/** What each kind takes, beside its size: any other price field is refused `trade.conditional_field_unsupported`. */
const FIELDS: Readonly<Record<ProtectionKind, readonly ('triggerPrice' | 'limitPrice' | 'trailingDistance')[]>> = {
  take_profit: ['triggerPrice'],
  stop_loss: ['triggerPrice'],
  stop_market: ['triggerPrice'],
  stop_limit: ['triggerPrice', 'limitPrice'],
  trailing_stop: ['trailingDistance'],
};
const PRICE_FIELDS = ['triggerPrice', 'limitPrice', 'trailingDistance'] as const;

export const VENUE_LABEL = 'Rests on the venue as its trigger order';
export const ENGINE_LABEL = 'Runs on our engine under your agent permission';
/** The agent name the person's wallet sees when it approves the protection key on the venue. */
export const PROTECTION_AGENT_NAME = 'protections';

export interface ProtectionRequest {
  readonly owner?: unknown;
  readonly symbol?: unknown;
  readonly kind?: unknown;
  readonly side?: unknown;
  readonly quantity?: unknown;
  readonly triggerPrice?: unknown;
  readonly limitPrice?: unknown;
  readonly trailingDistance?: unknown;
  readonly triggerSource?: unknown;
  readonly clientOrderId?: unknown;
  /** The entry order's own client order key (`clientOrderKey`), for a protection attached to it. */
  readonly attachTo?: unknown;
  /**
   * Who signs a trigger order that rests on the venue: the owner's wallet (the default), or the person's trading session
   * key on a venue whose trades only a session key signs (status `tradesSignedBy: session_key`: Hyperliquid's orders name
   * chain 1337, which a wallet refuses). The door checks an agent is this sign-in's live session key.
   */
  readonly signer?: unknown;
}

export interface ProtectionView {
  readonly id: string;
  readonly kind: ProtectionKind;
  readonly role: 'take_profit' | 'stop_loss';
  readonly restsOn: 'venue' | 'engine';
  readonly label: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly quantity: string;
  readonly triggerSource: ProtectionSource;
  readonly triggerPrice: string | null;
  readonly limitPrice: string | null;
  readonly trailingDistance: string | null;
  /** A trailing stop's trigger now: its best price less (or plus) the distance. */
  readonly currentTrigger: string | null;
  readonly status: 'armed' | 'triggered' | 'filled' | 'failed' | 'cancelled';
  readonly failure: string | null;
  readonly cancelReason: string | null;
  readonly venueOrderId: string | null;
  readonly venueClientOrderId: string | null;
  readonly parentClientOrderId: string | null;
  readonly agentPermission: { readonly agentAddress: string } | null;
  readonly clientOrderId: string;
  readonly actionKey: string | null;
}

export type ProtectionCreated =
  | { readonly restsOn: 'venue'; readonly actionKey: string; readonly prepared: PreparedAnswer['prepared']; readonly reused: boolean }
  | { readonly restsOn: 'engine'; readonly protection: ProtectionView };

/** One press of "move my stop to breakeven": the position's own figures, and the stop to rest there. */
export interface BreakevenRequest {
  readonly owner?: unknown;
  readonly symbol?: unknown;
  /** The new stop's own id (one per press): its business key is `protection:<owner>:stop_market:<clientOrderId>`. */
  readonly clientOrderId?: unknown;
  /** Who signs: as `ProtectionRequest.signer`. */
  readonly signer?: unknown;
}

/** What the person signs, in order, to leave exactly one reduce-only stop at the breakeven price. */
export interface BreakevenAnswer {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly quantity: string;
  readonly entryPrice: string;
  /** The fees the opening fills paid, the venue's and our builder fee, from the venue's fill records. */
  readonly openingFees: string;
  /** What the close pays on its notional: the venue's taker rate for the account plus our builder fee, in bps. */
  readonly closeFeeBps: string;
  /** The exact breakeven before the venue's price rule. */
  readonly exactPrice: string;
  /** The stop's trigger: on the venue's price rule (5 significant figures, the tick), never netting below zero. */
  readonly triggerPrice: string;
  /**
   * Each action to sign and submit, in this order. While another stop loss rests on this market, the cancels of every
   * one of them (each must be one our door placed); once none rests, the new stop for the whole position. Empty: the
   * stop already rests at the price alone.
   */
  readonly steps: readonly {
    readonly does: 'place_stop' | 'cancel_stop';
    readonly actionKey: string;
    readonly prepared: PreparedAnswer['prepared'];
    readonly reused: boolean;
  }[];
  /** The venue client ids of the stops the cancels remove. */
  readonly replaces: readonly string[];
  /**
   * `call_again`: once the cancels are sent, call again (same request) for the new stop; the position rests without a
   * stop between the two. `done`: once these steps are sent, exactly one stop rests at `triggerPrice`.
   */
  readonly next: 'call_again' | 'done';
}

/** One drag of a resting stop or target to a new trigger price (J-derivatives-32 #3, #4, #7). */
export interface TriggerMoveRequest {
  readonly owner?: unknown;
  readonly symbol?: unknown;
  /** The venue's own client id of the resting stop or take profit to move. */
  readonly venueClientOrderId?: unknown;
  readonly triggerPrice?: unknown;
  /** Who signs: as `ProtectionRequest.signer`. */
  readonly signer?: unknown;
}

/** The one action that moves the order in place, for the person to sign and send through `/api/v1/venue/submit`. */
export interface TriggerMoveAnswer {
  readonly symbol: string;
  readonly venueClientOrderId: string;
  readonly role: 'take_profit' | 'stop_loss';
  /** The trigger the venue holds now, and the one asked for. */
  readonly from: string;
  readonly triggerPrice: string;
  /** The order's new worst price (a market exit, at the owner's close tolerance) or limit price (moved with its trigger). */
  readonly price: string;
  readonly actionKey: string;
  readonly prepared: PreparedAnswer['prepared'];
  readonly reused: boolean;
}

/** How far back the opening fills are read: a position opened before it refuses `trade.breakeven_history_short`. */
const BREAKEVEN_FILLS_DAYS = 90;

export interface ProtectionsDeps {
  readonly door: UserVenueDoor;
  readonly store: EngineProtectionStore;
  /** `TRADE_AGENT_KEY_SEED`: the owner's secret the protection key derives from. Blank refuses every engine stop. */
  readonly keySeed: string;
  /**
   * `TRADE_CLOSE_SLIPPAGE_BPS`: how far a stop's market exit may cross from its trigger (close-slippage.ts). Blank refuses
   * every stop placed as a market exit `trade.close_slippage_unset`, and an engine stop fires nothing.
   */
  readonly closeSlippageBps: number | null;
  /**
   * The person's verification level as identity holds it now (signals/live-tier.ts), read before each order our engine
   * sends, so a stop never trades on a level the person no longer has. Null, or a read that fails, sends nothing.
   */
  readonly liveTier: ((userId: string) => Promise<Principal['tier']>) | null;
  /**
   * The person's own account freeze (J-wallet-13), svc-identity's read every service that acts for the person uses
   * (quant/live-run/ports.ts), read before each order our engine sends. Null, or a read that fails, sends nothing.
   */
  readonly freeze: AccountFreezeRead | null;
  readonly now: () => Date;
}

const DECIMAL_RE = /^\d+(\.\d+)?$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KINDS: ReadonlySet<string> = new Set(Object.keys(FIELDS));
const SOURCES: ReadonlySet<string> = new Set(['mark', 'last', 'index']);

function bad(message: string): never {
  throw new ProtectionError('trade.protection_request_invalid', message, 400);
}

function positive(v: unknown, field: string): Amount {
  if (typeof v !== 'string' || !DECIMAL_RE.test(v)) bad(`${field} must be a decimal string`);
  const amount = parseAmount(v);
  if (compare(amount, ZERO) <= 0) bad(`${field} must be above zero`);
  return amount;
}

const sourceWords = (s: ProtectionSource) => (s === 'mark' ? 'mark price' : s === 'last' ? 'last traded price' : 'index price');

/**
 * A principal for the engine acting on one person's own venue account: their user id, trading scopes only, and their
 * level exactly as identity answered it for this order, never one made up here. A read by key takes `none`.
 */
export function engineActor(userId: string, tier: Principal['tier']): Principal {
  return {
    sub: userId,
    userId,
    scopes: ['trade:read', 'trade:write'],
    tier,
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as unknown as Principal;
}

export class VenueProtections {
  constructor(private readonly deps: ProtectionsDeps) {}

  /**
   * A fired market exit's worst price, from its trigger: the owner's close tolerance past it (TRADE_CLOSE_SLIPPAGE_BPS,
   * close-slippage.ts), the one the desk's Close uses too, a sell's below and a buy's above, on the market's tick. Blank
   * refuses `trade.close_slippage_unset`.
   */
  private worstPrice(side: 'buy' | 'sell', from: Amount, tick: Amount): Amount {
    // On the venue's price rule, toward the market and still beyond `from` (`venueBoundPrice`).
    return venueBoundPrice(side, { moved: closeTolerancePrice(side, from, this.deps.closeSlippageBps), reference: from, tick });
  }

  /** The venue agent key INTAFACED holds for one person's protections on one venue account. Derived, never stored. */
  protectionKey(userId: string, owner: string): PrivateKeyAccount {
    if (this.deps.keySeed.trim() === '') {
      throw new ProtectionError(
        'trade.protection_agent_key_unset',
        'no key seed is set for protection agent keys (owner value blank), so no protection runs on our engine',
        503,
      );
    }
    return privateKeyToAccount(
      keccak256(toHex(`intafaced protection key\u0000${this.deps.keySeed}\u0000${userId}\u0000${owner.toLowerCase()}`)),
    );
  }

  /** Whether the person's venue account has approved the protection key, as the venue lists its agents now. */
  async agent(principal: Principal, owner: string) {
    const account = await this.deps.door.account(owner);
    const address = this.protectionKey(principal.userId, account.owner).address.toLowerCase();
    const venue = await this.deps.door.venue();
    const listed = (await venue.agents(account)).value.find((a) => a.address.toLowerCase() === address) ?? null;
    const live = listed !== null && (listed.validUntil === null || listed.validUntil.getTime() > this.deps.now().getTime());
    return { agentAddress: address, agentName: PROTECTION_AGENT_NAME, approved: live, validUntil: listed?.validUntil ?? null };
  }

  /** The person's wallet approves the protection key on their venue account: the agent permission an engine stop needs. */
  async prepareAgent(principal: Principal, owner: string): Promise<PreparedAnswer> {
    const account = await this.deps.door.account(owner);
    const address = this.protectionKey(principal.userId, account.owner).address.toLowerCase();
    // A try the venue refused is tried again under a new key; an accepted one is never sent twice.
    const actionKey = await this.deps.door.fixedAgentApprovalKey(principal, address, `protection-agent:${account.owner}:${address}`);
    return this.deps.door.prepare(principal, {
      owner: account.owner,
      signer: { role: 'owner', address: account.owner },
      intent: { kind: 'approve_agent', agentAddress: address, agentName: PROTECTION_AGENT_NAME, validUntil: null },
      actionKey,
    });
  }

  async create(principal: Principal, req: ProtectionRequest, region = ''): Promise<ProtectionCreated> {
    if (typeof req.kind !== 'string' || !KINDS.has(req.kind))
      bad('kind must be take_profit, stop_loss, stop_market, stop_limit or trailing_stop');
    const kind = req.kind as ProtectionKind;
    // Each kind takes its own fields and no other: refused before anything is read.
    for (const field of PRICE_FIELDS) {
      const given = req[field] !== undefined && req[field] !== null && req[field] !== '';
      if (given && !FIELDS[kind].includes(field)) {
        throw new ProtectionError('trade.conditional_field_unsupported', `a ${kind.replace('_', ' ')} does not take ${field}`, 400);
      }
      if (!given && FIELDS[kind].includes(field)) bad(`a ${kind.replace('_', ' ')} needs ${field}`);
    }
    if (req.side !== 'buy' && req.side !== 'sell') bad('side must be buy or sell');
    const side = req.side;
    // Every kind but a stop limit closes as a market exit at the owner's close tolerance: blank refuses here, nothing stored.
    if (kind !== 'stop_limit') requireCloseSlippageBps(this.deps.closeSlippageBps);
    if (typeof req.symbol !== 'string' || req.symbol.trim() === '') bad('symbol is required');
    const symbol = req.symbol;
    const source = (req.triggerSource ?? 'mark') as ProtectionSource;
    if (!SOURCES.has(source)) bad('triggerSource must be mark, last or index');
    if (typeof req.clientOrderId !== 'string' || !CLIENT_ID_RE.test(req.clientOrderId))
      bad('clientOrderId must be 1 to 64 letters, digits, - or _');
    const clientOrderId = req.clientOrderId;
    const quantity = positive(req.quantity, 'quantity');
    const triggerPrice = FIELDS[kind].includes('triggerPrice') ? positive(req.triggerPrice, 'triggerPrice') : null;
    const limitPrice = FIELDS[kind].includes('limitPrice') ? positive(req.limitPrice, 'limitPrice') : null;
    const trailingDistance = FIELDS[kind].includes('trailingDistance') ? positive(req.trailingDistance, 'trailingDistance') : null;
    const attachTo = typeof req.attachTo === 'string' && req.attachTo !== '' ? req.attachTo : null;
    if (attachTo && kind !== 'take_profit' && kind !== 'stop_loss') bad('only a take profit or a stop loss is attached to an entry order');
    const agentSigner = agentSignerOf(req.signer, bad);

    const account = await this.deps.door.account(typeof req.owner === 'string' ? req.owner : '');
    const venue = await this.deps.door.venue();
    const market = (await venue.markets(account)).value.find((m) => m.symbol === symbol);
    if (!market || market.kind !== 'perpetual') bad(`${symbol} is not a perpetual on ${venue.venue.displayName}`);

    // A protection closes: on the other side of the position it protects, and never more than it holds.
    if (!attachTo) {
      const position = (await venue.positions(account)).value.find((p) => p.symbol === symbol && p.size !== ZERO);
      if (!position || (position.side === 'long') === (side === 'buy')) {
        throw new ProtectionError(
          'trade.conditional_would_increase',
          `a ${side} here would open or enlarge a position on ${symbol}, and a protection only closes one`,
          400,
        );
      }
      if (compare(quantity, position.size) > 0) {
        throw new ProtectionError(
          'trade.protection_above_position',
          `${formatAmount(quantity)} is more than the position holds (${formatAmount(position.size)})`,
          400,
        );
      }
    }

    const venueTakes = kind !== 'trailing_stop' && (market.triggerSources ?? []).includes(source as 'mark' | 'last');
    const engineTakes = (kind === 'stop_market' || kind === 'trailing_stop') && (source === 'mark' || source === 'index');
    if (!venueTakes && !engineTakes) {
      throw new ProtectionError(
        'trade.trigger_source_unset',
        `${venue.venue.displayName} judges no ${kind.replace('_', ' ')} on the ${sourceWords(source)} for ${symbol}, and our engine reads only the venue's mark and index`,
        400,
      );
    }
    const price = this.priceOf(market, source);
    if (!venueTakes && price === null) {
      throw new ProtectionError(
        'trade.trigger_source_unset',
        `${venue.venue.displayName} publishes no ${sourceWords(source)} for ${symbol}`,
        400,
      );
    }
    // A trigger already crossed would fire at once: refused in words, nothing stored.
    if (triggerPrice !== null && price !== null) {
      const tp = kind === 'take_profit';
      const above = (tp && side === 'sell') || (!tp && side === 'buy');
      if (above ? compare(triggerPrice, price) <= 0 : compare(triggerPrice, price) >= 0) {
        throw new ProtectionError(
          'trade.protection_wrong_side',
          `That price is on the wrong side of the ${sourceWords(source)} (now ${formatAmount(price)}): it must be ${above ? 'above' : 'below'} it. Nothing was saved.`,
          400,
        );
      }
    }

    if (venueTakes) {
      const intent: PlaceUserOrderIntent = {
        kind: 'place_order',
        symbol,
        side,
        type: kind === 'stop_limit' ? 'limit' : 'market',
        amount: quantity,
        price: kind === 'stop_limit' ? (limitPrice as Amount) : this.worstPrice(side, triggerPrice as Amount, market.tickSize),
        timeInForce: kind === 'stop_limit' ? 'GTC' : 'IOC',
        reduceOnly: true,
        trigger: {
          price: triggerPrice as Amount,
          source: source as 'mark' | 'last',
          role: kind === 'take_profit' ? 'take_profit' : 'stop_loss',
        },
        parentClientOrderKey: attachTo,
        clientOrderKey: `protection:${account.owner}:${kind}:${clientOrderId}`,
        builderFee: null,
      };
      const answer = await this.deps.door.prepare(principal, {
        owner: account.owner,
        signer: orderSigner(agentSigner, account.owner),
        intent,
      });
      return { restsOn: 'venue', actionKey: answer.actionKey, prepared: answer.prepared, reused: answer.reused };
    }

    // The order our engine sends later is a new order: the person's level is checked here as the door checks it.
    assertTradingLevel(principal, 'place_order');
    const agent = await this.agent(principal, account.owner);
    if (!agent.approved) {
      throw new ProtectionError(
        'trade.protection_agent_unapproved',
        `a ${kind.replace('_', ' ')} on the ${sourceWords(source)} runs on our engine, which needs your agent permission on ${venue.venue.displayName}: approve it in your wallet first`,
        409,
      );
    }
    const now = this.deps.now();
    const stored = await this.deps.store.createOnce({
      id: randomUUID(),
      userId: principal.userId,
      venueId: account.venueId,
      owner: account.owner,
      clientKey: clientOrderId,
      symbol,
      kind: kind as 'stop_market' | 'trailing_stop',
      side,
      quantity,
      triggerSource: source as 'mark' | 'index',
      triggerPrice,
      trailingDistance,
      bestPrice: kind === 'trailing_stop' ? price : null,
      agentAddress: agent.agentAddress,
      region,
      status: 'armed',
      failure: null,
      cancelReason: null,
      firedAt: null,
      createdAt: now,
    });
    return { restsOn: 'engine', protection: engineView(stored, null) };
  }

  /**
   * A fee-adjusted breakeven stop on an open perp position: the price at which closing the whole position nets
   * zero after the venue's fees and our builder fee (`breakeven.ts`), and the actions that leave exactly one reduce-only
   * stop loss resting there on the venue, signed by the person (their wallet, or their trading session key). Nothing is
   * sent here: each step goes through `/api/v1/venue/submit` once signed.
   *
   * One press is two calls when a stop already rests: the venue holds one stop for the whole position at a time, and
   * Hyperliquid's one-action modify carries no builder fee (the adapter refuses rather than drop it), so the old stop is
   * cancelled first and the new one placed on the next call. Between the two the position has no stop: the client sends
   * the second call at once, and the answer says so (`next`).
   *
   * Crash points: none strands funds (no value moves through INTAFACED). A press that stops after the cancels leaves the
   * position without a stop until the call is made again, which places it; a press repeated after it landed prepares
   * nothing. Breakeven on the wrong side of the mark is refused before any stop is cancelled.
   */
  async breakeven(principal: Principal, req: BreakevenRequest): Promise<BreakevenAnswer> {
    if (typeof req.symbol !== 'string' || req.symbol.trim() === '') bad('symbol is required');
    const symbol = req.symbol;
    if (typeof req.clientOrderId !== 'string' || !CLIENT_ID_RE.test(req.clientOrderId))
      bad('clientOrderId must be 1 to 64 letters, digits, - or _');
    const clientOrderId = req.clientOrderId;
    const signer = agentSignerOf(req.signer, bad);

    const account = await this.deps.door.account(typeof req.owner === 'string' ? req.owner : '');
    const venue = await this.deps.door.venue();
    const market = (await venue.markets(account)).value.find((m) => m.symbol === symbol);
    if (!market || market.kind !== 'perpetual') bad(`${symbol} is not a perpetual on ${venue.venue.displayName}`);
    if (!(market.triggerSources ?? []).includes('mark')) {
      throw new ProtectionError(
        'trade.trigger_source_unset',
        `${venue.venue.displayName} rests no stop on the mark price for ${symbol}, so no breakeven stop can rest there`,
        400,
      );
    }
    const position = (await venue.positions(account)).value.find((p) => p.symbol === symbol && p.size !== ZERO);
    if (!position) throw new ProtectionError('trade.breakeven_no_position', `there is no open position on ${symbol} to protect`, 404);
    const side: 'buy' | 'sell' = position.side === 'long' ? 'sell' : 'buy';

    // The close's rate: the venue's taker rate for this account (a stop fires as a market order), and our builder fee on it.
    if (!market.takerFeeBps.known) {
      throw new ProtectionError(
        'trade.breakeven_fees_unknown',
        `${venue.venue.displayName} does not report this account's taker fee on ${symbol}, so no breakeven is computed`,
        503,
      );
    }
    const ours = await this.deps.door.builderFeeFor(symbol, side, 'perpetual');
    if (ours === null) {
      throw new ProtectionError(
        'trade.breakeven_fees_unknown',
        'our builder fee is not published (owner value blank), so no breakeven is computed',
        503,
      );
    }
    const closeFeeBps = add(market.takerFeeBps.value, ours.carries ? ours.feeBps : ZERO);
    const since = new Date(this.deps.now().getTime() - BREAKEVEN_FILLS_DAYS * 86_400_000);
    const fills = (await venue.fills(account, since)).value.filter((f) => f.symbol === symbol);
    const openingFees = openingFeesOf(position, fills);
    if (openingFees === null) {
      throw new ProtectionError(
        'trade.breakeven_history_short',
        `the fills ${venue.venue.displayName} reports for the last ${BREAKEVEN_FILLS_DAYS} days do not add up to the position on ${symbol}, so its opening fees are not known and no breakeven is computed`,
        409,
      );
    }
    const be = feeAdjustedBreakeven({
      side: position.side,
      size: position.size,
      entryPrice: position.entryPrice,
      openingFees,
      closeFeeBps,
      tick: market.tickSize,
    });

    // The stops resting on this market now, as the venue lists them; each must be one our door placed, so it can be
    // cancelled by its key. One already at the price for the whole position is kept.
    const ourKeys = new Map<string, string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const read = await this.deps.door.orders(principal, account.owner, cursor, undefined);
      // An order's own key derives its client id; a cancel's action carries the id of the order it cancels, never its own.
      for (const o of read.orders) {
        const cloid = o.venueClientOrderId?.toLowerCase();
        if (cloid && clientIdOf(account.venueId, o.actionKey) === cloid) ourKeys.set(cloid, o.actionKey);
      }
      if (!read.nextCursor) break;
      cursor = read.nextCursor;
    }
    // Each stop loss resting on this market with the key our door placed it under (null: placed outside INTAFACED).
    const resting = (await venue.openOrders(account)).value
      .filter((o) => o.symbol === symbol && o.trigger?.role === 'stop_loss' && o.trigger.state === 'waiting')
      .map((o) => {
        const cloid = o.venueClientOrderId?.toLowerCase() ?? null;
        return { order: o, cloid, key: cloid === null ? null : (ourKeys.get(cloid) ?? null) };
      });
    const foreign = resting.filter((r) => r.key === null);
    if (foreign.length > 0) {
      throw new ProtectionError(
        'trade.breakeven_foreign_stop',
        `${foreign.length === 1 ? 'a stop' : `${foreign.length} stops`} on ${symbol} placed outside INTAFACED rest on ${venue.venue.displayName}; cancel ${foreign.length === 1 ? 'it' : 'them'} there first, so exactly one stop is left. Nothing was prepared`,
        409,
      );
    }
    const keep = resting.find(
      ({ order: o }) => o.side === side && o.reduceOnly && o.trigger?.price === be.price && o.remaining === position.size,
    );

    // A stop already crossed would close at once: refused before anything, the old stop included, is touched.
    if (!market.mark.known || (side === 'sell' ? compare(be.price, market.mark.value) >= 0 : compare(be.price, market.mark.value) <= 0)) {
      throw new ProtectionError(
        'trade.protection_wrong_side',
        `Breakeven (${formatAmount(be.price)}) is on the wrong side of the mark price${market.mark.known ? ` (now ${formatAmount(market.mark.value)})` : ', which the venue does not report'}: it must be ${side === 'sell' ? 'below' : 'above'} it. Nothing was prepared.`,
        400,
      );
    }

    const steps: BreakevenAnswer['steps'][number][] = [];
    const replaces: string[] = [];
    for (const { cloid, key } of resting) {
      if (cloid === keep?.cloid || cloid === null || key === null) continue;
      const answer = await this.deps.door.prepare(principal, {
        owner: account.owner,
        signer: orderSigner(signer, account.owner),
        intent: { kind: 'cancel_order', symbol, clientOrderKey: key },
        actionKey: `breakeven:cancel:${account.owner}:${clientOrderId}:${cloid}`,
      });
      steps.push({ does: 'cancel_stop', actionKey: answer.actionKey, prepared: answer.prepared, reused: answer.reused });
      replaces.push(cloid);
    }
    // The venue holds one whole stop at a time (the door's `trade.venue_whole_close_taken`): the new one is prepared once
    // no other rests, on the next call.
    if (!keep && steps.length === 0) {
      const created = await this.create(principal, {
        owner: account.owner,
        symbol,
        kind: 'stop_market',
        side,
        quantity: formatAmount(position.size),
        triggerPrice: formatAmount(be.price),
        triggerSource: 'mark',
        clientOrderId,
        signer: signer ?? undefined,
      });
      if (created.restsOn !== 'venue') throw new Error('a breakeven stop rests on the venue');
      steps.push({ does: 'place_stop', actionKey: created.actionKey, prepared: created.prepared, reused: created.reused });
    }
    return {
      symbol,
      side,
      quantity: formatAmount(position.size),
      entryPrice: formatAmount(position.entryPrice),
      openingFees: formatAmount(openingFees),
      closeFeeBps: formatAmount(closeFeeBps),
      exactPrice: formatAmount(be.exact),
      triggerPrice: formatAmount(be.price),
      steps,
      replaces,
      next: !keep && replaces.length > 0 ? 'call_again' : 'done',
    };
  }

  /**
   * A resting stop or take profit moved to a new trigger in place, on a venue that moves trigger orders in place
   * (`movesTriggersInPlace`): the same order and client id, so the position never holds two of one role or none, and a
   * venue that refuses leaves it as it rested. Its worst price follows the new trigger at the owner's close tolerance (a
   * market exit), or a stop limit's limit moves by as much as its trigger. Nothing is sent here: the person signs the one
   * action and sends it through `/api/v1/venue/submit`, under `trigger-move:<owner>:<client id>:<trigger price>`, so the
   * same move sent again is the same action. A trigger already crossed is refused before anything is prepared.
   *
   * Crash points: none strands funds (no value moves through INTAFACED). Before the signature nothing changes on the
   * venue; a move whose answer was lost is read back by the order's own client id.
   */
  async move(principal: Principal, req: TriggerMoveRequest): Promise<TriggerMoveAnswer> {
    if (typeof req.symbol !== 'string' || req.symbol.trim() === '') bad('symbol is required');
    const symbol = req.symbol;
    if (typeof req.venueClientOrderId !== 'string' || !/^\S{1,128}$/.test(req.venueClientOrderId))
      bad("venueClientOrderId must be the venue's client id of the stop or take profit to move");
    const cloid = req.venueClientOrderId.toLowerCase();
    const triggerPrice = positive(req.triggerPrice, 'triggerPrice');
    const signer = agentSignerOf(req.signer, bad);

    const account = await this.deps.door.account(typeof req.owner === 'string' ? req.owner : '');
    const venue = await this.deps.door.venue();
    if (venue.venue.movesTriggersInPlace !== true) {
      throw new ProtectionError(
        'trade.trigger_move_not_offered',
        `${venue.venue.displayName} does not move a resting stop or target in place, so nothing was sent: change it from the position's exit orders`,
        409,
      );
    }
    const market = (await venue.markets(account)).value.find((m) => m.symbol === symbol);
    if (!market || market.kind !== 'perpetual') bad(`${symbol} is not a perpetual on ${venue.venue.displayName}`);
    const order = (await venue.openOrders(account)).value.find(
      (o) => o.symbol === symbol && o.venueClientOrderId?.toLowerCase() === cloid && o.trigger?.state === 'waiting',
    );
    if (!order?.trigger || !order.reduceOnly) {
      throw new ProtectionError(
        'trade.trigger_not_resting',
        `no stop or take profit ${cloid} waits on ${symbol} on ${venue.venue.displayName}: nothing was moved`,
        409,
      );
    }
    const role = order.trigger.role;
    if (compare(triggerPrice, ZERO) <= 0 || triggerPrice % market.tickSize !== ZERO)
      bad(`the trigger price must be on ${symbol}'s tick (${formatAmount(market.tickSize)})`);
    const now = this.priceOf(market, order.trigger.source);
    if (now !== null) {
      const above = (role === 'take_profit') === (order.side === 'sell');
      if (above ? compare(triggerPrice, now) <= 0 : compare(triggerPrice, now) >= 0) {
        throw new ProtectionError(
          'trade.protection_wrong_side',
          `That price is on the wrong side of the ${sourceWords(order.trigger.source)} (now ${formatAmount(now)}): it must be ${above ? 'above' : 'below'} it. Nothing was moved.`,
          400,
        );
      }
    }
    const price =
      order.type === 'limit'
        ? add(order.price, sub(triggerPrice, order.trigger.price))
        : this.worstPrice(order.side, triggerPrice, market.tickSize);
    if (compare(price, ZERO) <= 0) bad('the stop limit would move its limit price to zero or below');
    const answer = await this.deps.door.prepare(principal, {
      owner: account.owner,
      signer: orderSigner(signer, account.owner),
      intent: { kind: 'move_trigger', symbol, venueClientOrderId: order.venueClientOrderId!, triggerPrice, price },
      actionKey: `trigger-move:${account.owner}:${cloid}:${formatAmount(triggerPrice)}`,
    });
    return {
      symbol,
      venueClientOrderId: order.venueClientOrderId!,
      role,
      from: formatAmount(order.trigger.price),
      triggerPrice: formatAmount(triggerPrice),
      price: formatAmount(price),
      actionKey: answer.actionKey,
      prepared: answer.prepared,
      reused: answer.reused,
    };
  }

  /** Every protection on the person's venue account: the venue's trigger orders our door sent, and the engine's stops. */
  async list(principal: Principal, owner: string): Promise<readonly ProtectionView[]> {
    const account = await this.deps.door.account(owner);
    const out: ProtectionView[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const read = await this.deps.door.orders(principal, account.owner, cursor, undefined);
      for (const o of read.orders) {
        const v = venueView(o);
        if (v) out.push(v);
      }
      if (!read.nextCursor) break;
      cursor = read.nextCursor;
    }
    for (const row of await this.deps.store.listForOwner(principal.userId, account.owner)) {
      const fired =
        row.status === 'fired' || row.status === 'failed'
          ? await this.deps.door.orderByKey(engineActor(row.userId, 'none'), fireKey(row)).catch(noOrderYet)
          : null;
      out.push(engineView(row, fired?.order ?? null));
    }
    return out;
  }

  /** Cancels an engine stop that has not fired. A venue trigger order is cancelled by the person's own signed cancel. */
  async cancel(principal: Principal, id: string): Promise<ProtectionView> {
    const row = await this.deps.store.get(principal.userId, id);
    if (!row) throw new ProtectionError('trade.protection_unknown', 'no engine protection with that id on your account', 404);
    if (!(await this.deps.store.move(row.id, 'armed', 'cancelled', this.deps.now()))) {
      const now = await this.deps.store.get(principal.userId, id);
      if (now?.status === 'cancelled') return engineView(now, null);
      throw new ProtectionError('trade.protection_final', `that protection is already ${now?.status ?? 'gone'}`, 409);
    }
    return engineView((await this.deps.store.get(principal.userId, id))!, null);
  }

  private priceOf(market: UserVenueMarket, source: ProtectionSource): Amount | null {
    if (source === 'mark') return market.mark.known ? market.mark.value : null;
    if (source === 'index') return market.index?.known ? market.index.value : null;
    return null;
  }

  /**
   * One pass of our engine: every armed stop is judged on the venue's price now; a trailing stop's best price follows
   * it; a crossed one is claimed by this worker alone and its one reduce-only order sent. A stop left `firing` by a
   * worker that stopped is sent again under the same key, which the venue takes once.
   */
  async tick(): Promise<{ readonly fired: number }> {
    let fired = 0;
    const markets = new Map<string, Map<string, UserVenueMarket>>();
    for (const row of await this.deps.store.live()) {
      try {
        if (row.status === 'firing') {
          await this.send(row);
          continue;
        }
        const account: UserVenueAccount = { venueId: row.venueId, owner: row.owner, subAccount: null };
        const venue = await this.deps.door.venue();
        let byVenue = markets.get(row.venueId);
        if (!byVenue) {
          byVenue = new Map((await venue.markets(account)).value.map((m) => [m.symbol, m]));
          markets.set(row.venueId, byVenue);
        }
        const market = byVenue.get(row.symbol);
        const price = market ? this.priceOf(market, row.triggerSource) : null;
        if (price === null) continue;
        let trigger = row.triggerPrice;
        if (row.kind === 'trailing_stop') {
          const best = row.side === 'sell' ? max(row.bestPrice ?? price, price) : min(row.bestPrice ?? price, price);
          if (best !== row.bestPrice) await this.deps.store.setBest(row.id, best, this.deps.now());
          trigger = row.side === 'sell' ? sub(best, row.trailingDistance as Amount) : add(best, row.trailingDistance as Amount);
        }
        const crossed = row.side === 'sell' ? compare(price, trigger as Amount) <= 0 : compare(price, trigger as Amount) >= 0;
        if (!crossed) continue;
        // Of two workers that see it crossed, one claims it.
        if (!(await this.deps.store.move(row.id, 'armed', 'firing', this.deps.now()))) continue;
        fired += 1;
        await this.send({ ...row, status: 'firing' }, market);
      } catch (err) {
        process.stderr.write(
          `${JSON.stringify({ level: 'warn', msg: 'trade.protection_engine.pass_failed', protection: row.id, message: err instanceof Error ? err.message : String(err) })}\n`,
        );
      }
    }
    return { fired };
  }

  /** The one reduce-only market order of a claimed stop, signed by the protection key, stored before it is sent. */
  private async send(row: EngineProtection, known?: UserVenueMarket): Promise<void> {
    const now = this.deps.now();
    const key = fireKey(row);
    const read = await this.deps.door.orderByKey(engineActor(row.userId, 'none'), key).catch(() => null);
    if (read && read.state === 'accepted' && read.order) return this.settle(row, read.order, null);
    if (read && read.state === 'refused') return this.settle(row, null, read.refusal?.detail ?? 'the venue refused the order');
    const account: UserVenueAccount = { venueId: row.venueId, owner: row.owner, subAccount: null };
    const venue = await this.deps.door.venue();
    const market = known ?? (await venue.markets(account)).value.find((m) => m.symbol === row.symbol);
    const position = (await venue.positions(account)).value.find((p) => p.symbol === row.symbol && p.size !== ZERO);
    if (!market || !market.mark.known || !position || (position.side === 'long') !== (row.side === 'sell')) {
      await this.deps.store.move(row.id, 'firing', 'cancelled', now, { cancelReason: 'position_closed' });
      return;
    }
    const intent: PlaceUserOrderIntent = {
      kind: 'place_order',
      symbol: row.symbol,
      side: row.side,
      type: 'market',
      amount: min(row.quantity, position.size),
      price: this.worstPrice(row.side, market.mark.value, market.tickSize),
      timeInForce: 'IOC',
      reduceOnly: true,
      clientOrderKey: key,
      builderFee: null,
    };
    // The person's level now, from identity: a read that fails sends nothing and leaves the stop claimed, sent on a later
    // pass under the same key; a level below trading is refused by the door, and the stop fails in its words.
    if (!this.deps.liveTier) throw new Error('the verification level cannot be read here, so our engine sends no order');
    if (!this.deps.freeze) throw new Error('the account freeze cannot be read here, so our engine sends no order');
    const tier = await this.deps.liveTier(row.userId);
    // The person's own freeze, read now: a frozen account gets no order from our engine, and the stop fails saying so.
    if (await this.deps.freeze.frozen(row.userId))
      return this.settle(row, null, 'your account is frozen, so our engine sent no order and nothing was closed');
    // Trading from the region it was armed in, judged again on the level identity holds now, as a signed-in order is.
    try {
      assertPlaceEligible({ tier, region: row.region });
    } catch (err) {
      if (err instanceof AuthError) return this.settle(row, null, `your verification level no longer allows an order (${err.message})`);
      if (err instanceof JurisdictionError)
        return this.settle(row, null, `trading is no longer allowed for this account (${err.message}), so nothing was sent`);
      throw err;
    }
    const actor = engineActor(row.userId, tier);
    const signer = this.protectionKey(row.userId, row.owner);
    let answer: PreparedAnswer;
    try {
      answer = await this.deps.door.prepare(actor, {
        owner: row.owner,
        signer: { role: 'agent', address: signer.address.toLowerCase() },
        intent,
      });
    } catch (err) {
      if (err instanceof AuthError) return this.settle(row, null, `your verification level no longer allows an order (${err.message})`);
      throw err;
    }
    const signature = await signer.signTypedData(answer.prepared.typedData as TypedDataDefinition);
    let outcome: VenueSubmitOutcome;
    try {
      outcome = (
        await this.deps.door.submit(actor, answer.actionKey, {
          digest: answer.prepared.digest,
          signature,
          signedBy: signer.address.toLowerCase(),
        })
      ).outcome;
    } catch (err) {
      if (err instanceof VenueRefusalError) return this.settle(row, null, err.refusal.detail);
      throw err;
    }
    if (!outcome.definite) return; // read back by its key on the next pass
    if (!outcome.accepted) return this.settle(row, null, outcome.refusal.detail);
    return this.settle(row, outcome.order, null);
  }

  private async settle(row: EngineProtection, order: UserVenueOrder | null, refusal: string | null): Promise<void> {
    const at = this.deps.now();
    if (order && order.filled !== ZERO) {
      await this.deps.store.move(row.id, 'firing', 'fired', at, { firedAt: at });
      return;
    }
    const failure = refusal ?? `the venue filled nothing of the order our engine sent (${order?.status ?? 'no answer'})`;
    await this.deps.store.move(row.id, 'firing', 'failed', at, { firedAt: at, failure });
  }
}

/** The venue client id a key derives, lowercased; null for a key that is not an order's (it never derives one). */
const clientIdOf = (venueId: string, key: string): string | null => {
  try {
    return venueClientOrderId(venueId, key).toLowerCase();
  } catch {
    return null;
  }
};

/** The business key of the one order a stop sends: the person's venue account and their own client order id. */
const fireKey = (row: EngineProtection) => `protection:fire:${row.owner}:${row.clientKey}`;

/** A stop that failed before its order was prepared (a frozen account, a tier or region refusal) has no order: null. Any other error throws. */
const noOrderYet = (err: unknown): null => {
  if (err instanceof UserVenueDoorError && err.code === 'trade.venue_action_unknown') return null;
  throw err;
};

function engineView(row: EngineProtection, order: UserVenueOrder | null): ProtectionView {
  const trailing = row.kind === 'trailing_stop' && row.bestPrice !== null && row.trailingDistance !== null;
  const current = trailing
    ? row.side === 'sell'
      ? sub(row.bestPrice!, row.trailingDistance!)
      : add(row.bestPrice!, row.trailingDistance!)
    : null;
  const status: ProtectionView['status'] =
    row.status === 'armed'
      ? 'armed'
      : row.status === 'firing'
        ? 'triggered'
        : row.status === 'fired'
          ? 'filled'
          : row.status === 'failed'
            ? 'failed'
            : 'cancelled';
  return {
    id: row.id,
    kind: row.kind,
    role: 'stop_loss',
    restsOn: 'engine',
    label: ENGINE_LABEL,
    symbol: row.symbol,
    side: row.side,
    quantity: formatAmount(row.quantity),
    triggerSource: row.triggerSource,
    triggerPrice: row.triggerPrice === null ? null : formatAmount(row.triggerPrice),
    limitPrice: null,
    trailingDistance: row.trailingDistance === null ? null : formatAmount(row.trailingDistance),
    currentTrigger: current === null ? null : formatAmount(current),
    status,
    failure: row.failure,
    cancelReason: row.cancelReason,
    venueOrderId: order?.venueOrderId ?? null,
    venueClientOrderId: order?.venueClientOrderId ?? null,
    parentClientOrderId: null,
    agentPermission: { agentAddress: row.agentAddress },
    clientOrderId: row.clientKey,
    actionKey: null,
  };
}

/** A venue trigger order our door sent for the person, as the venue reports it now; `null` for any other order. */
function venueView(o: VenueOrderByKey): ProtectionView | null {
  const m = /^protection:0x[0-9a-f]{40}:(take_profit|stop_loss|stop_market|stop_limit):(.+)$/.exec(o.actionKey);
  if (!m || !o.order?.trigger) return null;
  const order = o.order;
  const trigger = order.trigger!;
  const kind = m[1] as ProtectionKind;
  const status: ProtectionView['status'] =
    trigger.state === 'failed'
      ? 'failed'
      : order.status === 'filled'
        ? 'filled'
        : order.status === 'canceled' || order.status === 'rejected' || order.status === 'expired'
          ? order.filled !== ZERO
            ? 'filled'
            : 'cancelled'
          : trigger.state === 'triggered'
            ? 'triggered'
            : 'armed';
  return {
    id: o.actionKey,
    kind,
    role: trigger.role,
    restsOn: 'venue',
    label: VENUE_LABEL,
    symbol: order.symbol,
    side: order.side,
    quantity: formatAmount(order.amount),
    triggerSource: trigger.source,
    triggerPrice: formatAmount(trigger.price),
    limitPrice: kind === 'stop_limit' ? formatAmount(order.price) : null,
    trailingDistance: null,
    currentTrigger: null,
    status,
    failure: trigger.failure,
    cancelReason: order.cancelReason ?? null,
    venueOrderId: order.venueOrderId,
    venueClientOrderId: order.venueClientOrderId,
    parentClientOrderId: order.parentClientOrderId ?? null,
    agentPermission: null,
    clientOrderId: m[2]!,
    actionKey: o.actionKey,
  };
}
